// data/earnings.js — the earnings feed: load once, score once, cache, re-score on live tick.
//
// Mirrors data/technicals.js so both scoring models sit behind the same accessors:
//
//   await load();            // idempotent
//   all()                    // scored rows, best score first
//   forScope(scope, holds)   // narrowed to portfolio holdings, keeping "no result data" rows
//   byTicker('TITAN')        // one scored row
//   meta()                   // generated_at, seed, counts, provenance
//   calendar()               // upcoming results events
//
// PROVENANCE: the financials behind these scores are SYNTHETIC (see
// scripts/gen-mock-earnings.mjs). `meta().isMock` is true and every surface that displays a
// number off this feed is required to say so. When the real filings feed is wired, the file
// swaps and `isMock` goes false — nothing else here changes.

import { scoreCompany } from '../scoring/earnings-scoring.js';
import { scopeTickers, filterByScope } from './scope.js';

const EARNINGS_PATH = 'data/mock/earnings.json';
const CALENDAR_PATH = 'data/mock/earnings-calendar.json';

export const LIVE_ID = 'earnings-feed';

let loadPromise = null;
let cache = null; // { meta, scored, byTicker, calendar }
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

// Committed static files, so `no-cache` and not `no-store`: revalidate on each load, and reuse the
// bytes already on disk when the server says they have not changed. `no-store` forbids reuse
// outright, which meant a 2MB corpus was re-downloaded in full on every single visit.
async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return res.json();
}

// Turn a raw payload into the cached, scored shape. Shared by the initial load and by every
// live tick, so a tick and a cold load can never diverge.
function ingest(payload, calendarPayload) {
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];
  const scored = rows.map((c) => scoreCompany(c)).sort(bestFirst);
  const byTicker = new Map();
  for (const s of scored) if (s.company?.ticker) byTicker.set(s.company.ticker.toUpperCase(), s);

  return {
    meta: {
      generated_at: payload?.generated_at ?? null,
      source: payload?.source ?? 'Mock data',
      generator: payload?.generator ?? null,
      seed: payload?.seed ?? null,
      quarter: payload?.quarter ?? null,
      season_start: payload?.season_start ?? null,
      season_end: payload?.season_end ?? null,
      company_count: payload?.company_count ?? rows.length,
      provenance: payload?._provenance ?? null,
      // The whole tab keys its honesty markers off this flag.
      isMock: String(payload?.source ?? '').toLowerCase().includes('mock'),
    },
    scored,
    byTicker,
    calendar: calendarPayload
      ? { ...calendarPayload, events: Array.isArray(calendarPayload.events) ? calendarPayload.events : [] }
      : { events: [] },
  };
}

async function build() {
  const [payload, calendarPayload] = await Promise.all([
    fetchJson(EARNINGS_PATH),
    fetchJson(CALENDAR_PATH).catch(() => null), // calendar is optional
  ]);
  cache = ingest(payload, calendarPayload);
  return cache;
}

/**
 * Seed the cache from an already-fetched payload. app.js loads earnings.json during bootstrap
 * (the Earnings Hub is the default tab, so it is needed on first paint anyway); priming means
 * this module never fetches the same ~240KB a second time.
 */
export function prime(payload, calendarPayload) {
  cache = ingest(payload, calendarPayload);
  return cache;
}

/**
 * Flatten the rich payload into the one-row-per-company summary that predates this shape.
 * Breakouts → Earnings Surprise reads `ctx.data.earnings` in that older form; rather than
 * rewrite that view, app.js hands it this adapter's output. Same idea as data/universe.js.
 */
export function adaptLegacySummary(payload) {
  const rows = Array.isArray(payload?.companies) ? payload.companies : [];
  return rows
    .map((c) => {
      const qs = Array.isArray(c.quarters) ? c.quarters : [];
      const q = qs.at(-1);
      const prev = qs.length >= 2 ? qs.at(-2) : null;
      const yr = qs.length >= 5 ? qs.at(-5) : null;
      if (!q) return null;
      const pctChange = (a, b) => (a == null || b == null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100);
      const est = c.consensus?.eps;
      const surprisePct = est ? ((q.eps - est) / Math.abs(est)) * 100 : null;
      const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
      return {
        ticker: c.ticker,
        name: c.name,
        sector: c.sector,
        quarter: c.quarter,
        reportDate: c.reportedOn,
        revenueCr: q.revenue,
        revenueYoyPct: r2(pctChange(q.revenue, yr?.revenue)),
        revenueQoqPct: r2(pctChange(q.revenue, prev?.revenue)),
        netProfitCr: q.netProfit,
        netProfitYoyPct: r2(pctChange(q.netProfit, yr?.netProfit)),
        epsActual: q.eps,
        epsEstimate: est ?? null,
        surprisePct: r2(surprisePct),
        resultTag: surprisePct == null ? 'n/a' : surprisePct > 1 ? 'Beat' : surprisePct < -1 ? 'Miss' : 'In-line',
      };
    })
    .filter(Boolean);
}

// Rows with data first, then by points desc, then score % as a tiebreak.
function bestFirst(a, b) {
  if (!!a.tickerError !== !!b.tickerError) return a.tickerError ? 1 : -1;
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  return b.scorePct - a.scorePct;
}

// ---- live engine wiring -------------------------------------------------------------------

/**
 * Register the earnings poller with the live engine. Re-reads the file and RE-SCORES on every
 * tick, so pointing `fetcher` at a real endpoint is the only change needed to go live.
 *
 * The engine handles the discipline: polls only while started and the document is visible,
 * pauses on hidden and refetches on return, exponential backoff on error capped at 60s, and
 * errors never reach the UI — subscribers keep the last good scored set.
 */
export function registerPoller(live, { intervalMs = 45000 } = {}) {
  live.register(LIVE_ID, {
    intervalMs,
    // Swap for live.realFetcher('/api/earnings') when the filings feed exists.
    // jitter:0 — jittering reported financials would be a lie, not a liveness cue.
    fetcher: live.mockFetcher(EARNINGS_PATH, { jitter: 0 }),
  });
}

/**
 * Subscribe to re-scored data. The callback fires on every successful tick with the fresh
 * cache. Returns an unsubscribe function — call it from the tab's destroy().
 */
export function subscribe(live, cb) {
  listeners.add(cb);
  const off = live.subscribe(LIVE_ID, (payload) => {
    try {
      // Keep the existing calendar: the poller only re-reads the results file.
      cache = ingest(payload, cache?.calendar || null);
      for (const fn of listeners) fn(cache);
    } catch (err) {
      console.error('[earnings] failed to ingest a live tick', err);
    }
  });
  return () => {
    listeners.delete(cb);
    off();
  };
}

// ---- accessors (synchronous; call load() first) --------------------------------------------

export function all() {
  return cache ? cache.scored : [];
}
export function meta() {
  return cache ? cache.meta : null;
}
export function calendar() {
  return cache ? cache.calendar : { events: [] };
}
export function byTicker(ticker) {
  if (!cache || !ticker) return null;
  return cache.byTicker.get(String(ticker).toUpperCase()) || null;
}
export function isLoaded() {
  return !!cache;
}

/**
 * forScope('universe') → every scored company.
 * forScope('portfolio', holdings) → the portfolio's holdings.
 *
 * A holding with no earnings row is NOT dropped: it comes back as a placeholder scored row
 * carrying `tickerError`, so the table shows "no result data" instead of the company silently
 * vanishing from a portfolio view.
 */
export function forScope(scope, holdings = []) {
  const rows = all();
  const wanted = scopeTickers(scope, holdings);
  if (!wanted) return rows;

  // A WATCHED COMPANY WITH NO ROW IS NOT A PLACEHOLDER, IT IS A FILTER.
  //
  // The book gets placeholders because a holding that vanished from a Portfolio view would be the
  // dashboard quietly redefining what you own. A watchlist is the reader's own list and they can
  // see what is on it; the honest report for a starred company this feed does not carry is the
  // denominator the pill already prints ("12 of 20 watched companies on this feed"), not a row of
  // dashes carrying a name nobody supplied. So watchlist narrows and book fills in.
  if (scope !== 'portfolio') return filterByScope(rows, scope, holdings, (r) => r.company?.ticker);

  const out = [];
  for (const h of holdings) {
    const hit = byTicker(h.ticker);
    if (hit) {
      out.push(hit);
    } else {
      out.push({
        company: { ticker: h.ticker, name: h.name, sector: h.sector, quarters: [], segments: [] },
        breakdown: [],
        deferred: [],
        totalPoints: 0,
        totalMax: 0,
        scorePct: 0,
        hardFails: [],
        naCount: 0,
        tickerError: 'No result data for this holding in the current set',
      });
    }
  }
  return out.sort(bestFirst);
}

/** Rows that actually scored — useful for averages that shouldn't be dragged by empty rows. */
export function scoredOnly(rows = all()) {
  return rows.filter((s) => !s.tickerError);
}
