// The names-only contract is validated on both scheduled and live reads.
export function validateFamilyBook(body) {
  if (body?.ok !== true || body.schemaVersion !== 1 || !Array.isArray(body.lines) ||
      !body.lines.length || body.lines.length > 5000 || body.count !== body.lines.length ||
      !/^[a-f0-9]{64}$/.test(body.revision || '') ||
      !['shared', 'built-in'].includes(body.storage) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.asOf || '') ||
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
  const oldCount = previous?.lines?.length ?? previous?.holdings?.length ?? 0;
  if (oldCount && next.lines.length < Math.floor(oldCount * 0.8)) {
    throw new Error('Active holdings fell by more than 20%; reconciliation is required before replacing the saved book');
  }
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
