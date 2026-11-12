// GLOW-OWNED. The browser half of Private Market deal sourcing: the multi-publisher capture
// (data/private-deals.json, written on the runner by scripts/collect-private-deals.mjs) read lazily,
// and folded together with Inc42's Funding Galore table into one row per deal.
// Nothing here fetches a publisher; a failed read keeps the copy already held and says so.
import { revalidatedJson } from '../core/store.js';
import { consolidateDeals, fromInc42Row } from './private-deals-shared.js';

let capture = null, pending = null, readError = null, checkedAt = null;
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const observations = () => capture?.observations || [];
export const meta = () => ({ generatedAt: capture?.generatedAt || null, feeds: capture?.feeds || [], count: observations().length, readError, checkedAt });

function valid(value) {
  return value?.version === 1 && Array.isArray(value.observations) && Array.isArray(value.feeds) &&
    value.observations.every(o => o && /^[a-f0-9]{24}$/.test(o.id) && typeof o.company === 'string' && ['funding', 'acquisition', 'merger'].includes(o.kind) && /^https:\/\//.test(o.url || ''));
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
    if (before !== capture?.generatedAt || beforeError !== readError) listeners.forEach(fn => fn());
  })().finally(() => { pending = null; });
  return pending;
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
