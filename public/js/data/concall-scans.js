// data/concall-scans.js — the LIVE con-call scan, from StockScans.
//
//   await load();                 // snapshot first paint, then one live fetch
//   all()                         // calls, newest first
//   upcoming() / today()          // the schedule
//   meta()                        // quarter, freshness, provenance, degraded reason
//   forScope(scope, holdings)
//   startLive(live) / stopLive(live)
//   onChange(fn)                  // fires only on ticks that actually changed something
//   newArrivals()                 // rows that appeared or acquired their analysis since load
//
// HOW "LIVE" WORKS HERE
//   First paint reads the committed snapshot (data/concall-scans.json) so the table is populated
//   instantly and works with no Worker. Then the tab polls /api/concalls every 30s, which
//   re-reads StockScans' newest page behind a 30s edge cache. A call analysed at 14:32 is on
//   screen by about 14:33.
//
// THE INTERESTING CHANGE IS NOT A NEW ROW
//   A concall appears on the feed when it is HELD, and acquires its score, sentiment and bullets
//   twenty-odd minutes later when StockScans has processed it. So the change worth repainting for
//   is usually an existing row gaining `resultScore` — not the row count moving. That is why the
//   fingerprint covers the analysis fields and why `newArrivals` counts "newly analysed" as an
//   arrival, not just "newly listed".
//
// THE SCORES ARE STOCKSCANS', NOT OURS
//   `resultScore`, `sentimentTier` and the `tags` bullets are their analysis, rendered unchanged
//   and attributed. We add no scoring of our own here — deliberately. See worker/stockscans.mjs.

import { resultTierOf, sentimentTierOf, docUrl, fingerprint, mergeScans } from './stockscans-shared.js';

const SNAPSHOT_PATH = 'data/concall-scans.json';
const LIVE_ENDPOINT = 'api/concalls';

export const LIVE_ID = 'concall-scans';
export const POLL_MS = 30000;

let loadPromise = null;
let cache = null; // { rows, byTicker, upcoming, today, meta }
let seenKeys = null; // key -> hadAnalysis, so "analysis landed" counts as an arrival
let arrivals = [];
const listeners = new Set();

const keyOf = (r) => `${r.companyKey}|${r.when}`;

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // let a later mount retry rather than wedging the tab
    throw err;
  });
  return loadPromise;
}

async function fetchJson(path, { optional = false } = {}) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} (${res.status})`);
    return await res.json();
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

async function build() {
  const snapshot = await fetchJson(SNAPSHOT_PATH);
  ingest(snapshot, { live: false });

  // Try the live route once during load so the first paint is live where possible. Deliberately
  // optional: a missing Worker (plain `python3 -m http.server`) must not stop the tab rendering.
  const fresh = await fetchJson(LIVE_ENDPOINT, { optional: true });
  if (fresh?.rows?.length) ingest(fresh, { live: true });
  return cache;
}

function ingest(payload, { live }) {
  const rows = (payload?.rows || []).map(decorate).sort(byNewest);

  const isFirst = seenKeys === null;
  if (isFirst) {
    seenKeys = new Map(rows.map((r) => [keyOf(r), r.resultScore != null]));
  } else {
    for (const r of rows) {
      const k = keyOf(r);
      const hadAnalysis = seenKeys.get(k);
      const isNew = !seenKeys.has(k);
      const justAnalysed = hadAnalysis === false && r.resultScore != null;
      if (isNew || justAnalysed) {
        arrivals.unshift({ ...r, seenAt: Date.now(), reason: isNew ? 'listed' : 'analysed' });
      }
      if (isNew || justAnalysed) seenKeys.set(k, r.resultScore != null);
    }
    arrivals = arrivals.slice(0, 40); // a "just in" strip, not an audit log
  }

  const byTicker = new Map();
  for (const r of rows) if (r.ticker && !byTicker.has(r.ticker)) byTicker.set(r.ticker, r);

  cache = {
    rows,
    byTicker,
    upcoming: (payload?.upcoming || []).slice().sort((a, b) => String(a.when || '').localeCompare(String(b.when || ''))),
    today: payload?.today || { day: null, rows: [] },
    meta: {
      ...(payload?.meta || {}),
      count: rows.length,
      analysed: rows.filter((r) => r.resultScore != null).length,
      isLive: live && !payload?.degraded,
      degraded: payload?.degraded || null,
      receivedAt: Date.now(),
    },
  };
  return cache;
}

/**
 * Attach StockScans' own tier labels and the deep link. No arithmetic of ours touches the score —
 * `resultTierOf` applies their published bands, so the label we show is the label they show.
 */
function decorate(r) {
  return {
    ...r,
    resultTier: resultTierOf(r.resultScore),
    sentiment: sentimentTierOf(r.sentimentTier),
    transcriptUrl: docUrl({ companyId: r.companyId, ssUrl: r.ssUrl, type: 'concall' }),
    pptUrl: docUrl({ companyId: r.companyId, ssUrl: r.pptSsUrl, type: 'ppt' }),
  };
}

function byNewest(a, b) {
  return String(b.when || '').localeCompare(String(a.when || ''));
}

// ---------------------------------------------------------------------------------------
// Live polling
// ---------------------------------------------------------------------------------------

export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const payload = await fetchJson(LIVE_ENDPOINT, { optional: true });
      if (!payload?.rows?.length) return null;
      // Always refresh the cache; only NOTIFY on a real change, so a repaint never throws away
      // the reader's sort and search for a tick that carried nothing new.
      const changed = hasChanged(payload);
      ingest(payload, { live: true });
      return changed ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[concall-scans] listener failed', err);
      }
    }
  });
  live.start(LIVE_ID);
  return () => {
    off();
    live.stop(LIVE_ID);
  };
}

export function stopLive(live) {
  live?.stop?.(LIVE_ID);
}

function hasChanged(payload) {
  if (!cache) return true;
  if ((payload.rows?.length ?? 0) !== cache.meta.count) return true;
  if (!!payload.degraded !== !!cache.meta.degraded) return true;
  return fingerprint(payload.rows) !== fingerprint(cache.rows);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export const all = () => (cache ? cache.rows : []);
export const upcoming = () => (cache ? cache.upcoming : []);
export const today = () => (cache ? cache.today : { day: null, rows: [] });
export const meta = () => (cache ? cache.meta : null);
export const isLoaded = () => !!cache;
export const newArrivals = () => arrivals;
export const byTicker = (t) => (cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null);

export function forScope(scope, holdings = [], rows = all()) {
  if (scope !== 'portfolio') return rows;
  const held = new Set(holdings.map((h) => String(h.ticker).toUpperCase()));
  return rows.filter((r) => r.ticker && held.has(r.ticker.toUpperCase()));
}

export { mergeScans };
