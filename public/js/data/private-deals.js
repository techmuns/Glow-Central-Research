// GLOW-OWNED. The browser half of Private Market deal sourcing: the multi-publisher capture
// (data/private-deals.json, written on the runner by scripts/collect-private-deals.mjs) read lazily,
// and folded together with Inc42's Funding Galore table into one row per deal.
//
// KEEPING IT CURRENT. The runner collects hourly, but GitHub sheds scheduled runs. So while the tab is
// open: the file is re-read every five minutes; a capture older than STALE_MS starts one collection
// through the Worker (which holds a cooldown and declines a second run while one is going), and the
// file is then re-read every minute until the new capture lands. Nothing here fetches a publisher; a
// failed read keeps the copy already held and says so.
import { revalidatedJson } from '../core/store.js';
import { authHeaders } from '../core/host-context.js';
import { consolidateDeals, fromInc42Row } from './private-deals-shared.js';

export const STALE_MS = 75 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000, WATCH_MS = 60 * 1000, WATCH_FOR_MS = 20 * 60 * 1000;
let capture = null, pending = null, readError = null, checkedAt = null;
let lastDispatch = 0, refreshing = null, watchTimer = null;
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const observations = () => capture?.observations || [];
export const meta = () => ({ generatedAt: capture?.generatedAt || null, feeds: capture?.feeds || [], count: observations().length, readError, checkedAt, refreshing });
const emit = () => listeners.forEach(fn => { try { fn(); } catch (error) { console.warn('[private-deals] repaint failed', error); } });

function valid(value) {
  return value?.version === 1 && Array.isArray(value.observations) && Array.isArray(value.feeds) &&
    value.observations.every(o => o && /^[a-f0-9]{24}$/.test(o.id) && typeof o.company === 'string' && ['funding', 'acquisition', 'merger'].includes(o.kind) && /^https:\/\//.test(o.url || ''));
}
export function isStale(value = meta(), now = Date.now()) {
  const at = Date.parse(value.generatedAt || '');
  return !Number.isFinite(at) || now - at > STALE_MS;
}
export function load() {
  if (pending) return pending;
  pending = (async () => {
    const before = capture?.generatedAt, beforeError = readError;
    try {
      const next = await revalidatedJson('data/private-deals.json', { fresh: true });
      if (!valid(next)) throw Error('Invalid deal capture');
      // Never regress to an older publication than the one already painted.
      if (!capture || Date.parse(next.generatedAt || '') >= Date.parse(capture.generatedAt || '')) capture = next;
      readError = null; checkedAt = new Date().toISOString();
    } catch (error) { readError = error?.message || 'Deal capture unavailable'; }
    if (before !== capture?.generatedAt || beforeError !== readError) {
      if (before !== capture?.generatedAt && refreshing) { refreshing = null; stopWatching(); }
      emit();
    }
    void ensureFresh();
  })().finally(() => { pending = null; });
  return pending;
}

function stopWatching() { if (watchTimer) clearInterval(watchTimer); watchTimer = null; }
/** A stale capture starts one collection; a static origin (no Worker) is simply left alone. */
export async function ensureFresh({ now = Date.now(), force = false } = {}) {
  if (!capture || !(force || isStale(meta(), now)) || refreshing || now - lastDispatch < RETRY_MS) return null;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
  lastDispatch = now;
  const route = `api/private-deals/refresh?source=${force ? 'button' : 'auto'}`;
  let out;
  try {
    const response = await fetch(route, { method: 'POST', headers: { accept: 'application/json', ...authHeaders(route) }, signal: AbortSignal.timeout(12000) });
    const type = response.headers.get('content-type') || '';
    out = [404, 405, 501].includes(response.status) || !/json/i.test(type) ? { ok: false, reason: 'no-worker' } : await response.json();
  } catch { out = { ok: false, reason: 'unreachable' }; }
  if (out?.ok === false) return out;
  refreshing = { since: new Date(now).toISOString(), reason: out?.reason || 'dispatched' };
  emit();
  const started = Date.now();
  stopWatching();
  watchTimer = setInterval(() => {
    if (Date.now() - started > WATCH_FOR_MS) { refreshing = null; stopWatching(); emit(); return; }
    void load();
  }, WATCH_MS);
  return out;
}
/** The header Refresh button: re-read, and start a collection if the capture is more than a few minutes old. */
export async function refresh() {
  await load();
  const at = Date.parse(capture?.generatedAt || '');
  if (!Number.isFinite(at) || Date.now() - at > 10 * 60 * 1000) await ensureFresh({ force: true });
}

// One fold per pair of inputs: the Inc42 rows array and the news capture.
let memo = { inc42: null, news: null, rows: [] };
export function consolidated(inc42Rows = []) {
  const news = capture?.observations || [];
  if (memo.inc42 === inc42Rows && memo.news === news) return memo.rows;
  const rows = consolidateDeals([...inc42Rows.map(fromInc42Row), ...news]);
  memo = { inc42: inc42Rows, news, rows };
  return rows;
}
