// The names-only contract is validated on scheduled, server and browser reads.
export const MAX_CHECK_AGE_MS = 90000;
const CLOCK_SKEW_MS = 5000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function assertRecentCheck(value, now = Date.now()) {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || now - at > MAX_CHECK_AGE_MS || at - now > CLOCK_SKEW_MS) {
    throw new Error('The holdings check is stale or has an invalid clock');
  }
}
export function validateFamilyBook(body) {
  if (body?.ok !== true || body.schemaVersion !== 1 || !Array.isArray(body.lines) ||
      !body.lines.length || body.lines.length > 5000 || body.count !== body.lines.length ||
      !/^[a-f0-9]{64}$/.test(body.revision || '') ||
      !['shared', 'built-in'].includes(body.storage) ||
      !validDate(body.asOf) ||
      !Number.isFinite(Date.parse(body.checkedAt))) throw new Error('Invalid active holdings response');
  const seen = new Set();
  const lines = body.lines.map(l => {
    if (!/^INE[A-Z0-9]{9}$/.test(l?.isin || '') || typeof l.name !== 'string' ||
        !l.name.trim() || l.name.length > 200 || seen.has(l.isin)) throw new Error('Invalid or duplicate holding identity');
    seen.add(l.isin);
    return { isin: l.isin, name: l.name.trim(), sector: typeof l.sector === 'string' ? l.sector.slice(0, 100) : 'Unclassified' };
  });
  const w = body.sourceWorkbook;
  if (!w || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(w.fileKey || '') || typeof w.label !== 'string') {
    throw new Error('Active workbook provenance is missing');
  }
  if (body.storage === 'shared' && !Number.isFinite(Date.parse(w.uploadedAt))) {
    throw new Error('The shared workbook has no upload timestamp');
  }
  const excluded = {};
  for (const key of ['etf', 'liquid', 'other']) {
    const n = body.excluded?.[key];
    if (!Number.isInteger(n) || n < 0) throw new Error('Invalid excluded holding count');
    excluded[key] = n;
  }
  if (!Number.isInteger(body.positions) || body.positions < lines.length) throw new Error('Invalid position count');
  // Explicit projection: a future upstream field cannot accidentally publish money.
  return {
    schemaVersion: 1, source: 'Sattva Family Office active holdings', storage: body.storage,
    sourceWorkbook: { fileKey: w.fileKey, label: w.label.slice(0, 200), uploadedAt: typeof w.uploadedAt === 'string' && Number.isFinite(Date.parse(w.uploadedAt)) ? w.uploadedAt : null },
    asOf: body.asOf, checkedAt: body.checkedAt, revision: body.revision,
    positions: body.positions, count: lines.length, excluded, lines,
  };
}

export function assertBookChange(next, previous) {
  const lines = next?.lines ?? next?.holdings ?? [];
  const oldCount = previous?.lines?.length ?? previous?.holdings?.length ?? 0;
  if (oldCount && lines.length < Math.ceil(oldCount * 0.8)) {
    throw new Error('Active holdings fell by more than 20%; reconciliation is required before replacing the saved book');
  }
  // KV is eventually consistent. A later request can see an older upload. Do
  // not erase a newer known book simply because that older read was successful.
  if (previous?.storage === 'shared') {
    if (next.storage !== 'shared' || next.asOf < previous.asOf ||
        (next.asOf === previous.asOf && Date.parse(next.sourceWorkbook?.uploadedAt) < Date.parse(previous.sourceWorkbook?.uploadedAt))) {
      throw new Error('Family Office returned an older workbook; reconciliation is required');
    }
  }
}

export function validateResolvedPortfolio(p, { fresh = true, now = Date.now() } = {}) {
  if (p?.ok !== true || p.syncStatus !== 'live' || p.storage !== 'shared' ||
      !/^[a-f0-9]{64}$/.test(p.sourceRevision || '') || !validDate(p.asOf) ||
      !Number.isFinite(Date.parse(p.syncedAt)) || !Array.isArray(p.holdings) ||
      !p.holdings.length || p.holdings.length > 5000 || p.count !== p.holdings.length ||
      !/^[a-z0-9][a-z0-9-]{0,80}$/.test(p.sourceWorkbook?.fileKey || '') ||
      typeof p.sourceWorkbook?.label !== 'string' || !p.sourceWorkbook.label.trim() ||
      !Number.isFinite(Date.parse(p.sourceWorkbook?.uploadedAt))) throw new Error('Invalid resolved holdings response');
  if (fresh) assertRecentCheck(p.syncedAt, now);
  const isins = new Set(), tickers = new Set();
  for (const h of p.holdings) {
    if (!/^INE[A-Z0-9]{9}$/.test(h?.isin || '') || isins.has(h.isin) ||
        typeof h.name !== 'string' || !h.name.trim() || h.name.length > 200 ||
        (h.ticker !== null && (typeof h.ticker !== 'string' || !/^[A-Z0-9&.\-]{1,50}$/.test(h.ticker))) ||
        (h.ticker && tickers.has(h.ticker)) ||
        (!h.ticker && (typeof h.reason !== 'string' || !h.reason.trim()))) throw new Error('Invalid or ambiguous holding identity');
    isins.add(h.isin);
    if (h.ticker) tickers.add(h.ticker);
  }
  if (p.resolved !== tickers.size) throw new Error('Resolved holding count does not reconcile');
  return p;
}

export async function boundedJson(response, maxBytes = 1024 * 1024) {
  if (!response.ok) throw new Error(`Holdings service returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Holdings response was empty');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Holdings response exceeded its size limit');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
