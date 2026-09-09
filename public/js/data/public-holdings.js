import { revalidatedJson, readEntry, writeEntry } from '../core/store.js';
export const LIVE_ID = 'public-holdings';
let data = null, loading = null, error = null, readAt = 0;
const listeners = new Set(), arrivals = [];
export const report = () => data;
export const lastError = () => error;
export const newArrivals = () => arrivals;
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const forPerson = (id, kind = 'investor') => (data?.holdings || []).filter((h) => h.personId === id && h.kind === kind);
const CACHE_KEY = 'holdings:public';
function validate(next) {
  if (next?.version !== 1 || !['holdings', 'issues', 'sources', 'profiles', 'candidates'].every((key) => Array.isArray(next[key])) ||
    !['indexed', 'parsed', 'pending', 'partial', 'companies', 'profiles'].every((key) => Number.isSafeInteger(next.coverage?.[key]) && next.coverage[key] >= 0) ||
    !Number.isFinite(Date.parse(next.checkedAt)) || !Number.isFinite(Date.parse(next.captureCheckedAt)) ||
    next.holdings.some((h) => !h.id || !h.personId || !h.company || !h.legalHolder || !/^IN[A-Z0-9]{10}$/.test(h.isin) || !Number.isFinite(Date.parse(h.asOf)) ||
      !Number.isSafeInteger(h.shares) || h.shares < 0 || !Number.isFinite(h.stakePct) || h.stakePct < 0 || h.stakePct > 100 || !h.sources?.length ||
      h.sources.some((s) => !/^https:\/\/(?:www\.bseindia\.com|(?:nsearchives|archives)\.nseindia\.com)\//.test(s.url) || !Number.isFinite(Date.parse(s.checkedAt))))) throw new Error('Unreadable public holdings capture');
  return next;
}
export async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    if (!data) {
      try { const saved = await readEntry(CACHE_KEY); if (saved?.value) data = validate(saved.value); } catch { /* The network can recover an absent or unreadable public cache. */ }
    }
    try {
      const next = await revalidatedJson('data/public-holdings.json');
      validate(next);
      if (data && Date.parse(next.checkedAt) < Date.parse(data.checkedAt)) throw new Error('Older public holdings capture; current records retained');
      const before = new Set((data?.issues || []).map((r) => r.id));
      if (data) {
        const revision = (r) => `${r.id}|${r.shares}|${r.stakePct}|${r.state}`;
        const priorHoldings = new Set(data.holdings.map(revision));
        arrivals.push(...next.holdings.filter((r) => !priorHoldings.has(revision(r)) && r.state === 'latest-disclosure' && r.shares > 0)
          .map((r) => ({ id: `disclosure:${revision(r)}`, company: r.company, type: 'public-disclosure', detectedAt: next.checkedAt,
            message: `${r.person}: ${r.legalHolder} disclosed ${r.stakePct}% as of ${r.asOf}.` })));
        arrivals.push(...next.issues.filter((r) => !before.has(r.id) && ['stake-difference', 'source-conflict'].includes(r.type)).map((r) => ({ ...r, detectedAt: next.checkedAt })));
        if (arrivals.length > 1000) arrivals.splice(0, arrivals.length - 1000);
      }
      if (data?.checkedAt !== next.checkedAt) writeEntry(CACHE_KEY, { value: next, tag: next.checkedAt });
      data = next; error = null; readAt = Date.now();
    } catch (e) { error = e.message; }
    for (const fn of listeners) fn();
    return data;
  })().finally(() => { loading = null; });
  return loading;
}
export const load = () => data && Date.now() - readAt < 300000 ? Promise.resolve(data) : refresh();
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, { intervalMs: 300000, fetcher: refresh }); live.start(LIVE_ID);
  return () => live.stop(LIVE_ID);
}
