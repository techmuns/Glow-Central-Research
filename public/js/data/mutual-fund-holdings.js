// Public market observations only. Glow's own book supplies the scope; no private
// Sattva portfolio, session, scanner access or collection credential is shared.
// Comparisons/history are already computed and retained by the shared collector.
import { conditionalJson, readEntry, writeEntry } from '../core/store.js';
import { readableOwnership } from './mutual-funds-ownership.js';
import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import { filterByScope } from './scope.js';
import { filingTicker } from './announcement-identity.js';

export const SOURCE = 'https://sattva-central-research.tech-441.workers.dev';
const prefix = `glow:public-mf:v1:${SOURCE}:`;
const snapshots = new Map(), pending = new Map(), details = new Map(), detailPending = new Map();
const listeners = new Set();
let activeKey = null;
const validIsin = id => /^IN[A-Z0-9]{10}$/.test(id || '');
export const onUpdate = fn => { listeners.add(fn); return () => listeners.delete(fn); };
function notify() { for (const fn of listeners) { try { fn(); } catch (error) { console.error('Holdings repaint failed', error); } } }
export const meta = () => ({ ...snapshots.get(activeKey)?.meta, revalidating: pending.has(activeKey) });
export const all = () => (snapshots.get(activeKey)?.rows || []).map(r => readableOwnership(r));

export function scopedRows(scope = 'portfolio', holdings = coverage.holdings()) {
  const rows = all();
  if (scope === 'portfolio') {
    const byIsin = new Map(rows.map(r => [r.isin, r]));
    return holdings.map(h => ({ ...byIsin.get(h.isin), ...h, missing: !byIsin.has(h.isin) }));
  }
  const scoped = filterByScope(rows, scope, holdings);
  if (scope !== 'watchlist') return scoped;
  const byTicker = new Map(scoped.map(r => [filingTicker(r.ticker), r]));
  return watchlist.all().map(h => byTicker.get(filingTicker(h.ticker)) || { ...h, name: h.name || h.ticker, missing: true });
}

function validatePage(value, wanted) {
  if (!value?.meta || !Array.isArray(value.rows) || value.rows.some(r => !validIsin(r?.isin) || typeof r.name !== 'string' || (wanted && !wanted.has(r.isin))))
    throw Error('Invalid public holdings response');
  if (value.nextCursor != null && typeof value.nextCursor !== 'string') throw Error('Invalid holdings cursor');
}

export function load(scope = 'portfolio', { holdings = coverage.holdings() } = {}) {
  const ids = scope === 'portfolio' ? [...new Set(holdings.map(h => h.isin).filter(validIsin))].sort() : null;
  const key = ids ? ids.join(',') : 'universe';
  activeKey = key;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    if (!snapshots.has(key)) {
      const saved = await readEntry(prefix + key);
      try {
        validatePage(saved?.value, ids && new Set(ids));
        snapshots.set(key, { ...saved.value, meta: { ...saved.value.meta, origin: 'store' } });
        notify(); // Saved rows paint before any network response.
      } catch { /* A cold or invalid cache is a miss, never an empty successful read. */ }
    }
    try {
      const rows = [], seen = new Set();
      let sourceMeta = null, revision = null;
      const batches = ids ? Array.from({ length: Math.ceil(ids.length / 250) }, (_, n) => ids.slice(n * 250, (n + 1) * 250)) : [null];
      for (const batch of batches) {
        const wanted = batch && new Set(batch), cursors = new Set();
        let cursor = '';
        do {
          if (cursors.has(cursor)) throw Error('Repeated holdings cursor');
          cursors.add(cursor);
          const params = new URLSearchParams({ ...(batch ? { isins: batch.join(',') } : {}), ...(cursor ? { cursor } : {}) });
          const result = await conditionalJson(`${SOURCE}/api/mutual-funds?${params}`, {
            key: prefix + 'page:' + params, signal: AbortSignal.timeout(15000),
            validate: value => validatePage(value, wanted),
          });
          // Never publish an apparently complete table assembled across two captures.
          const nextRevision = result.value.meta.run || result.value.meta.sourceRevision || null;
          if (sourceMeta && revision !== nextRevision) throw Error('Holdings changed during pagination');
          sourceMeta = result.value.meta; revision = nextRevision;
          for (const row of result.value.rows) if (!seen.has(row.isin)) { seen.add(row.isin); rows.push(row); }
          cursor = result.value.nextCursor || '';
        } while (cursor);
      }
      const payload = { rows, meta: { ...sourceMeta, origin: 'live', readFailed: false } };
      snapshots.set(key, payload);
      writeEntry(prefix + key, { value: payload });
      return payload;
    } catch {
      // Retain the entire last successful scope. A failed page must not truncate it.
      const saved = snapshots.get(key) || { rows: [], meta: {} };
      const payload = { ...saved, meta: { ...saved.meta, readFailed: true, origin: 'store' } };
      snapshots.set(key, payload);
      return payload;
    }
  })().finally(() => { pending.delete(key); notify(); });
  pending.set(key, request);
  return request;
}

function validateDetail(value, isin, month) {
  const c = value?.company;
  if (!c || c.isin !== isin || (month && c.month !== month) || !Array.isArray(c.funds) || !Array.isArray(c.months))
    throw Error('Invalid company disclosure');
}

export async function detail(isin, month = null, { onUpdate } = {}) {
  if (!validIsin(isin)) throw Error('No confirmed equity identity');
  const key = prefix + `detail:${isin}:${month || 'latest'}`;
  if (!details.has(key)) {
    const saved = await readEntry(key);
    try { validateDetail(saved?.value, isin, month); details.set(key, saved.value); } catch { /* Cache miss. */ }
  }
  if (!detailPending.has(key)) {
    const request = (async () => {
      try {
        const params = new URLSearchParams({ isin, ...(month ? { month } : {}) });
        const out = await conditionalJson(`${SOURCE}/api/mutual-funds/company?${params}`, {
          key, signal: AbortSignal.timeout(15000), validate: value => validateDetail(value, isin, month),
        });
        details.set(key, out.value);
        // Only a few drilldowns need to stay in memory; the durable cache keeps history.
        if (details.size > 12) details.delete(details.keys().next().value);
        return out.value;
      } catch (error) {
        const saved = details.get(key);
        if (!saved) throw error;
        return { ...saved, meta: { ...saved.meta, readFailed: true } };
      }
    })().finally(() => detailPending.delete(key));
    detailPending.set(key, request);
  }
  const readable = value => ({ ...value, company: readableOwnership(value.company) });
  const request = detailPending.get(key);
  if (details.has(key)) {
    request.then(value => onUpdate?.(readable(value)), () => {});
    const saved = details.get(key);
    return readable({ ...saved, meta: { ...saved.meta, revalidating: true } });
  }
  return readable(await request);
}

export function health(m = meta(), now = Date.now()) {
  if (m.readFailed) return 'Read failed · showing saved disclosures';
  if (m.revalidating) return 'Saved disclosures · checking for updates';
  if (!m.checkedAt) return 'Source checks pending';
  const age = now - Date.parse(m.checkedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 45 * 60000) return 'Source checks overdue';
  const date = new Date(now); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - 1);
  const target = date.toISOString().slice(0, 7), total = m.amcs?.length || 0;
  const current = m.amcs?.filter(a => a.status === 'ok' && a.month === target).length || 0;
  return m.state !== 'complete' || !total || current < total ? `Partial coverage · ${current}/${total} AMCs reported` : 'Latest reported disclosures';
}
