// data/earnings-live.js — the LIVE quarterly results feed.
//
//   await load();            // snapshot first paint, then one live fetch
//   all()                    // joined rows, newest result first
//   meta()                   // quarter, freshness, provenance, degraded reason
//   forScope(scope, holds)   // portfolio holdings vs the whole universe
//   startLive(live) / stopLive(live)
//   onChange(fn)             // fires on every tick that actually changed something
//   newArrivals()            // companies that appeared since this page loaded
//
// HOW "LIVE" ACTUALLY WORKS HERE
//   First paint reads the committed snapshot (data/earnings-live.json) so the table is populated
//   instantly and works with no network. Then the tab polls /api/earnings, which proxies
//   Moneycontrol behind a 30s edge cache. A company that files at 14:32 is on screen by ~14:33.
//
//   The poller only repaints when something CHANGED — a new company, a revised figure, a moved
//   price. Repainting a 1,300-row table every 30s regardless would fight the user's scroll
//   position and sort for no reason.
//
// THREE JOINS, ALL OF WHICH CAN LEGITIMATELY MISS
//   1. scId -> NSE ticker, via the committed map. Moneycontrol truncates company names to 15
//      characters, so the name is a label and never a key. No ticker => no ticker shown.
//   2. ticker -> market cap + industry, from universe.json (the NSE-500 export). A company
//      outside the NSE 500 has neither, and shows "—".
//   3. (ticker, resultDate) -> the close on the result day, from result-returns.json. Combined
//      with the live price this gives Return since result. No base price => "—".
//   Every miss renders as an em dash. None of them renders as zero, because "we could not join
//   this" and "this is zero" are different claims.

import { adaptUniverse } from './universe.js';

const SNAPSHOT_PATH = 'data/earnings-live.json';
const TICKER_MAP_PATH = 'data/mc-ticker-map.json';
const RETURNS_PATH = 'data/result-returns.json';
const LIVE_ENDPOINT = 'api/earnings';

export const LIVE_ID = 'earnings-live';
export const POLL_MS = 30000;

let loadPromise = null;
let cache = null; // { rows, meta, byTicker }
let tickerMap = null;
let returnsBase = null;
let universeIndex = null;
let seenScIds = null; // populated on first successful load; anything new after that is an arrival
let arrivals = [];
const listeners = new Set();

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
  // The three join tables are optional: without them the feed still renders, just with fewer
  // columns filled. Only the results payload itself is required.
  const [snapshot, map, returns, universeRaw] = await Promise.all([
    fetchJson(SNAPSHOT_PATH),
    fetchJson(TICKER_MAP_PATH, { optional: true }),
    fetchJson(RETURNS_PATH, { optional: true }),
    fetchJson('data/universe.json', { optional: true }),
  ]);

  tickerMap = map?.map || {};
  returnsBase = returns?.base || {};
  universeIndex = buildUniverseIndex(universeRaw);

  ingest(snapshot, { live: false });

  // Try the live endpoint once during load so the very first paint is live where possible. It is
  // deliberately not awaited hard: a missing Worker (plain `python3 -m http.server`) must not stop
  // the tab from rendering the snapshot.
  const fresh = await fetchJson(LIVE_ENDPOINT, { optional: true });
  if (fresh?.rows?.length) ingest(fresh, { live: true });

  return cache;
}

function buildUniverseIndex(raw) {
  if (!Array.isArray(raw)) return new Map();
  const idx = new Map();
  for (const c of adaptUniverse(raw)) {
    if (c.ticker) idx.set(String(c.ticker).toUpperCase(), c);
  }
  return idx;
}

/**
 * Fold a payload into the cache. Shared by the snapshot and every live tick so the two can never
 * diverge in shape — the same join, the same derivations, one code path.
 */
function ingest(payload, { live }) {
  const rows = (payload?.rows || []).map(joinRow).sort(byNewestResult);

  const isFirst = seenScIds === null;
  if (isFirst) {
    seenScIds = new Set(rows.map((r) => r.scId));
  } else {
    const fresh = rows.filter((r) => !seenScIds.has(r.scId));
    for (const r of fresh) {
      seenScIds.add(r.scId);
      // Newest first, and capped: this drives a "just reported" strip, not an audit log.
      arrivals.unshift({ ...r, seenAt: Date.now() });
    }
    arrivals = arrivals.slice(0, 40);
  }

  const byTicker = new Map();
  for (const r of rows) if (r.ticker) byTicker.set(r.ticker, r);

  cache = {
    rows,
    byTicker,
    meta: {
      ...(payload?.meta || {}),
      latestResultDate: payload?.latestResultDate ?? null,
      count: rows.length,
      isLive: live && !payload?.degraded,
      degraded: payload?.degraded || null,
      // What each optional join actually managed, so the UI can be specific about gaps rather
      // than showing dashes with no explanation.
      mappedTickers: rows.filter((r) => r.ticker).length,
      withMarketCap: rows.filter((r) => r.marketCap != null).length,
      withReturn: rows.filter((r) => r.returnSinceResult != null).length,
      receivedAt: Date.now(),
    },
  };
  return cache;
}

function joinRow(raw) {
  const mapped = tickerMap?.[raw.scId] || null;
  const ticker = raw.ticker || mapped?.ticker || null;
  const uni = ticker ? universeIndex?.get(ticker) : null;

  // Market cap, computed LIVE rather than stored. The map holds the share count, which barely
  // moves; multiplying it by the price on this very tick gives a market cap that is correct now
  // instead of correct whenever the map was last built. Falls back to universe.json (a curated
  // but hand-refreshed export) and then to the count-times-price captured at build time.
  //   shares × price is in rupees; ÷ 1e7 gives crore.
  const liveCap = mapped?.shares && raw.ltp ? (mapped.shares * raw.ltp) / 1e7 : null;
  const marketCap = liveCap ?? uni?.marketCap ?? mapped?.mktCapAtBuild ?? null;

  // Return since result: base is the close on the result day (immutable, cached); the current
  // price is Moneycontrol's live `ltp`. So this figure moves on every tick, which is the point.
  const baseKey = ticker && raw.resultDate ? `${ticker}@${raw.resultDate}` : null;
  const baseEntry = baseKey ? returnsBase?.[baseKey] : null;
  const base = baseEntry?.close ?? null;
  const returnSinceResult = base != null && base > 0 && raw.ltp != null ? ((raw.ltp - base) / base) * 100 : null;

  return {
    ...raw,
    ticker,
    // Moneycontrol truncates to 15 chars; the price feed carries the full legal name, and
    // universe.json is better still. Prefer the longest thing we actually know.
    company: uni?.name || raw.fullName || mapped?.fullName || raw.name,
    shortName: raw.name,
    marketCap,
    marketCapIsLive: liveCap != null,
    // universe.json's industry is the curated one and wins where it exists; Moneycontrol's
    // subsector fills in the ~69% of reporters that sit outside the NSE-500 export.
    industry: uni?.industry || uni?.sector || mapped?.industry || null,
    inUniverse: !!uni,
    basePrice: base,
    basePricedOn: baseEntry?.pricedOn ?? null,
    returnSinceResult,
  };
}

// Newest result first, then by the size of the move, so the top of the table is "what just
// happened and mattered" rather than alphabetical noise.
function byNewestResult(a, b) {
  if (a.resultDate !== b.resultDate) return String(b.resultDate || '').localeCompare(String(a.resultDate || ''));
  return Math.abs(b.netProfit?.pct ?? 0) - Math.abs(a.netProfit?.pct ?? 0);
}

// ---------------------------------------------------------------------------------------
// Live polling
// ---------------------------------------------------------------------------------------

/**
 * Register + start the poller on the shared live engine. The fetcher returns null when nothing
 * has changed, and `paint` is only called for real changes — see the header.
 */
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const payload = await fetchJson(LIVE_ENDPOINT, { optional: true });
      if (!payload?.rows?.length) return null;
      // ALWAYS refresh the cache, but only NOTIFY on a structural change. Prices move on every
      // tick, and repainting 1,300 rows every 30s would rebuild the table and throw away
      // whatever the user had sorted or searched. So the data stays current underneath, and the
      // screen is rebuilt only when something worth rebuilding for happened: a company filed, or
      // a figure was revised.
      const structural = hasStructuralChange(payload);
      ingest(payload, { live: true });
      return structural ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[earnings-live] listener failed', err);
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

/**
 * Did anything happen that is worth rebuilding the screen for?
 *
 * Deliberately EXCLUDES the traded price. Prices move every tick; results do not. Including the
 * price here would mean a structural repaint every 30 seconds all day, which throws away the
 * user's sort and search for no new information.
 */
function hasStructuralChange(payload) {
  if (!cache) return true;
  if ((payload.rows?.length ?? 0) !== cache.meta.count) return true;
  if ((payload.latestResultDate ?? null) !== (cache.meta.latestResultDate ?? null)) return true;
  if (!!payload.degraded !== !!cache.meta.degraded) return true;
  return fingerprint(payload.rows) !== fingerprint(cache.rows);
}

/**
 * An ORDER-INDEPENDENT checksum over identity and the reported figures.
 *
 * Order-independent matters: the payload arrives in Moneycontrol's sort order while the cache is
 * held in ours, so any order-sensitive hash reports "changed" on every single tick — which is
 * exactly the bug this replaced. Summing the per-row hashes removes order from the result.
 *
 * A hash collision would mean a missed update until the next real change. With the row count in
 * the key and a 32-bit mix over four fields, that is not a risk worth more machinery than this.
 */
function fingerprint(rows = []) {
  let total = 0;
  for (const r of rows) {
    const tok = `${r.scId}|${r.resultDate}|${r.netProfit?.current ?? ''}|${r.revenue?.current ?? ''}`;
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) | 0;
    total = (total + h) | 0; // sum: row order cannot affect this
  }
  return `${rows.length}:${total}`;
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export function all() {
  return cache ? cache.rows : [];
}
export function meta() {
  return cache ? cache.meta : null;
}
export function byTicker(t) {
  return cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null;
}
export function isLoaded() {
  return !!cache;
}
export function newArrivals() {
  return arrivals;
}
export function clearArrivals() {
  arrivals = [];
}

/**
 * forScope('portfolio', holdings) narrows to the tickers actually held; 'universe' is everything
 * that has reported. Filtering the cached list — never a refetch.
 */
export function forScope(scope, holdings = []) {
  const rows = all();
  if (scope !== 'portfolio') return rows;
  const held = new Set(holdings.map((h) => String(h.ticker).toUpperCase()));
  return rows.filter((r) => r.ticker && held.has(r.ticker));
}
