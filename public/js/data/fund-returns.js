// data/fund-returns.js — the AmfiBeas "Returns & Ranking" feed: per-scheme point-to-point returns
// and same-cohort peer rank for every tracked mutual fund / ETF. Loaded once, cached, called DIRECT
// from the browser.
//
//   load()        fetch, resolve, cache — every failure is a NAMED state, never a thrown error
//   reload()      forget the cache and fetch again (the "Try again" control)
//   all()         every scheme, alphabetical by name
//   meta()        asOfDate, periods, counts, provenance, and a named `reason` on failure
//   periods()     the periods the payload carries
//
// WHY IT IS CALLED DIRECT, NOT PROXIED. The AmfiBeas API is CORS-open (Access-Control-Allow-Origin:
// *) and read-only — the same shape as the SentimentDash chatter feed — so the browser reads it
// straight and revalidates against its ETag through `conditionalJson`. There is no credential to
// hold, so nothing to proxy for. See js/data/chatter-live.js for the same pattern and the platform
// rule (Cloudflare error 1042) that makes a Worker proxy impossible for a same-account upstream.
//
// THE RETURNS AND RANKS ARE THEIRS. `returns[period].return` is a percentage already (3.4852 →
// +3.49%): a simple return for 1M/3M/6M/1Y, a CAGR for 3Y/5Y/10Y. `rank`/`peerCount` is the scheme's
// rank WITHIN ITS COHORT. Nothing here re-bands, re-ranks or recomputes — the same rule the con-call
// and chatter feeds follow. A null `return` is "no return for that period", never a zero; a null
// `rank` is "the cohort was too small to rank" and may sit beside a non-null return.

import { conditionalJson, KEYS, isPersistent } from '../core/store.js';

export const PERIODS = ['1M', '3M', '6M', '1Y', '3Y', '5Y', '10Y'];
// The label each period wears in the table — " CAGR" is appended for the multi-year ones, which is
// how the source labels them (3Y is a CAGR, 1M is a simple return).
export const PERIOD_LABEL = { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1Y', '3Y': '3Y CAGR', '5Y': '5Y CAGR', '10Y': '10Y CAGR' };

const STORE_KEY = KEYS.fundReturns;
// AmfiBeas has no committed host yet, so the default is empty — set window.AMFIBEAS_API_BASE in
// index.html once the API is deployed. An empty base surfaces as the `no-url` state, which the view
// turns into "configure the host" rather than a broken table.
const DEFAULT_BASE = '';

/** `localStorage` first so a verification run (or a screenshot) can point the whole feed at a stub. */
function baseUrl() {
  try {
    const override = localStorage.getItem('sattva:amfibeas-base');
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage disabled — fall through */
  }
  const configured = typeof window !== 'undefined' ? window.AMFIBEAS_API_BASE : null;
  return String(configured || DEFAULT_BASE).replace(/\/+$/, '');
}

let cache = null;
let loadPromise = null;

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // a thrown (not named) failure may retry on a later mount
    throw err;
  });
  return loadPromise;
}

/** Forget everything and fetch again — the retry control behind the "Try again" button. */
export function reload() {
  cache = null;
  loadPromise = null;
  return load();
}

async function build() {
  ingest(await fetchFeed());
  return cache;
}

/**
 * One read of the feed, with every failure NAMED rather than thrown. Returns `{ ok: true, body }`,
 * or `{ ok: false, reason, url? }`. `no-url` (host not configured) and `not-found` (the API branch
 * is not deployed) are things an operator fixes; `unreachable` / `upstream` are things to wait for;
 * `shape` means the contract moved. The requested URL travels with every failure, so it can be
 * diagnosed from its own artefact.
 */
async function fetchFeed() {
  const base = baseUrl();
  if (!/^https?:\/\//i.test(base)) return { ok: false, reason: 'no-url' };
  // `fields=compact` → only { return, rank, peerCount } per period, which is all the table needs, so
  // the ~3,400-scheme payload stays small. All seven periods come by default.
  const url = `${base}/api/returns-ranking?fields=compact`;
  let out;
  try {
    out = await conditionalJson(url, { key: STORE_KEY, optional: true });
  } catch {
    return { ok: false, reason: 'unreachable', url };
  }
  if (!out.value) {
    if (out.status === 0) return { ok: false, reason: 'unreachable', url };
    if (out.status === 404) return { ok: false, reason: 'not-found', status: 404, url };
    return { ok: false, reason: 'upstream', status: out.status, url };
  }
  if (!out.value || !Array.isArray(out.value.funds)) return { ok: false, reason: 'shape', url };
  return { ok: true, body: out.value, checkedAt: out.checkedAt, fromStore: out.status === 304, url };
}

function baseMeta(extra) {
  return { reason: null, url: null, status: null, asOfDate: null, generatedAt: null, source: null, periods: PERIODS, total: 0, count: 0, checkedAt: null, origin: null, persisted: isPersistent(), ...extra };
}

function ingest(res) {
  // A FAILED READ IS NEVER AN EMPTY RESULT: `funds: []` only ever travels with a `reason` beside it,
  // so the view can say "could not be read" rather than "no funds".
  if (!res.ok) {
    cache = { funds: [], meta: baseMeta({ reason: res.reason, url: res.url || null, status: res.status || null }) };
    return;
  }
  const b = res.body;
  const periods = Array.isArray(b.periods) && b.periods.length ? b.periods.filter((p) => PERIODS.includes(p)) : PERIODS;
  const funds = b.funds
    .filter((f) => f && f.schemecode != null)
    .map((f) => ({
      schemecode: String(f.schemecode),
      fundName: f.fundName || '(unnamed scheme)',
      classification: f.classification || null,
      plan: f.plan || 'unknown',
      option: f.option || 'unknown',
      cohortKey: f.cohortKey || null,
      returns: f.returns && typeof f.returns === 'object' ? f.returns : {},
    }))
    .sort((a, c) => a.fundName.localeCompare(c.fundName)); // alphabetical, exactly as the source lists them
  cache = {
    funds,
    meta: baseMeta({
      url: res.url,
      asOfDate: b.asOfDate || null,
      generatedAt: b.generatedAt || null,
      source: b.source || 'AmfiBeas daily NAV snapshot (AMFI)',
      periods,
      total: Number.isFinite(b.total) ? b.total : funds.length,
      count: funds.length,
      checkedAt: res.checkedAt || Date.now(),
      origin: res.fromStore ? 'store' : 'live',
    }),
  };
}

export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.funds : []);
export const meta = () => (cache ? cache.meta : null);
export const periods = () => (cache ? cache.meta.periods : PERIODS);
