// data/chatter-live.js — the live retail-chatter feed (SentimentDash), loaded once and cached.
//
//   load()                    fetch, resolve, cache
//   companies() / uncovered() the two sections
//   forScope(scope)           narrow the covered half to the book
//   meta()                    counts, freshness, provenance
//   startLive(live) / stopLive(live) / onChange(fn) / newArrivals()
//
// WHAT THIS FEED IS
//   Companies and topics trending across ValuePickr, TradingQnA and Google News over a rolling 30
//   days, counted and keyword-scored by SentimentDash. THE COUNTS AND THE SENTIMENT ARE THEIRS and
//   are reproduced, never re-banded — the same rule the Con-call tab follows with StockScans'
//   result score. The one thing derived here is the NSE symbol, because their payload has none.
//
// TWO NUMBERS THAT ARE NOT WHAT THEY LOOK LIKE
//   `mentionsChangePct` is a change in MENTION COUNT between scrapes. There is no price anywhere
//   in this API. It is named that way in `sentiment-shared.js` precisely so nothing downstream can
//   render it as a return by reading the field name, and no surface may colour it like a P&L.
//   `sparkline` is a per-RUN series, not per-day — points are scrapes, so nothing may put a time
//   axis under it.
//
// THE SPLIT INTO TWO SECTIONS IS A COVERAGE STATEMENT, NOT A TAXONOMY
//   Entries are discovered bottom-up from forum topics, so the feed mixes companies we cover,
//   companies we do not, foreign names (`cisco`, `spacex`, `ubs`) and bare themes (`fiis`,
//   `income`). We do not attempt to say which is which — that would be a judgement we cannot
//   support. We say only what we can test: whether the slug resolves to a symbol in our own
//   coverage. Measured on a real run: 45 of 219 do.
//
// THE POLL IS HOURLY, AND THAT IS ALREADY GENEROUS
//   The upstream re-scrapes twice a day, at 01:30 and 13:30 UTC. Anything faster asks a question
//   whose answer cannot have changed. The Worker caches 30 minutes on top.

import { conditionalJson, KEYS } from '../core/store.js';
import { buildResolverIndex, resolveAll, fingerprint, SOURCE_LABEL } from './sentiment-shared.js';
import * as coverage from './coverage.js';

export const LIVE_ID = 'chatter-live';
const ENDPOINT = '/api/chatter';
const POLL_MS = 60 * 60 * 1000; // hourly — see the header
const STORE_KEY = KEYS.chatter;

let loadPromise = null;
let cache = null;
let resolverIndex = null;
let seenSlugs = null; // populated on first load; anything new after that is an arrival
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

async function build() {
  await buildIndex();
  const out = await conditionalJson(ENDPOINT, { key: STORE_KEY, optional: true });
  ingest(out.value, { origin: out.status === 304 ? 'store' : 'live', checkedAt: out.checkedAt });
  return cache;
}

/**
 * The slug → NSE symbol lookup.
 *
 * Three sources, widest last. `universe.json` and the book give 603 symbols and resolved 26 of a
 * real 219-entry run; adding `mc-ticker-map.json` — 1,722 Indian listed companies, already in the
 * repo for the Earnings Hub — takes that to 45, and every one of the extra nineteen is a genuine
 * listed company (NRB Bearings, JNK India, Balu Forge, Northern Arc…). All three files are fetched
 * elsewhere in the app, so on a warm cache this costs a revalidation, not a download.
 */
async function buildIndex() {
  if (resolverIndex) return resolverIndex;
  const sources = [];

  for (const h of coverage.holdings()) if (h.ticker) sources.push({ ticker: h.ticker, name: h.name });

  const [uni, mc] = await Promise.all([
    fetch('data/universe.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('data/mc-ticker-map.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);

  for (const row of Array.isArray(uni) ? uni : []) {
    const t = String(row['Screener URL'] || '').match(/\/company\/([^/]+)/)?.[1];
    if (t) sources.push({ ticker: t, name: row.Company });
  }
  for (const v of Object.values(mc?.map || {})) if (v?.ticker) sources.push({ ticker: v.ticker, name: v.fullName });

  resolverIndex = buildResolverIndex(sources);
  return resolverIndex;
}

function ingest(payload, { origin, checkedAt }) {
  const ok = !!payload?.ok;
  const entries = ok ? resolveAll(payload.entries || [], resolverIndex) : [];

  // Arrivals: an entry the feed did not carry last time we looked. The first load seeds the set
  // rather than announcing 219 things that have been sitting there for a fortnight — the same
  // backlog rule the results and con-call watchers follow.
  if (seenSlugs === null) {
    seenSlugs = new Set(entries.map((e) => e.slug));
  } else {
    for (const e of entries) {
      if (seenSlugs.has(e.slug)) continue;
      seenSlugs.add(e.slug);
      arrivals.unshift({ ...e, seenAt: Date.now() });
    }
    arrivals = arrivals.slice(0, 40);
  }

  const companies = entries.filter((e) => e.ticker).sort(byMentions);
  const uncovered = entries.filter((e) => !e.ticker).sort(byMentions);

  cache = {
    ok,
    reason: payload?.reason || null,
    entries,
    companies,
    uncovered,
    byTicker: new Map(companies.map((e) => [e.ticker.toUpperCase(), e])),
    overview: payload?.overview || null,
    meta: {
      ok,
      reason: payload?.reason || null,
      // Their scrape time, and their own view of how stale it is. `ageSeconds` comes from their
      // /health route — the only clock authoritative about their data — rather than a subtraction
      // between their timestamp and ours, which are two different clocks.
      generatedAt: payload?.generatedAt || null,
      ageSeconds: payload?.health?.ageSeconds ?? null,
      window: payload?.window || '30d',
      total: entries.length,
      companies: companies.length,
      uncovered: uncovered.length,
      totalPosts: payload?.overview?.totalPosts ?? null,
      sourceTotals: payload?.overview?.sourceTotals || null,
      origin,
      checkedAt: checkedAt || Date.now(),
    },
  };
}

const byMentions = (a, b) => b.mentions - a.mentions || String(a.name).localeCompare(String(b.name));

// ---------------------------------------------------------------------------------------
// Accessors — synchronous; call load() first.
// ---------------------------------------------------------------------------------------
export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.entries : []);
export const companies = () => (cache ? cache.companies : []);
export const uncovered = () => (cache ? cache.uncovered : []);
export const overview = () => (cache ? cache.overview : null);
export const meta = () => (cache ? cache.meta : null);
export const byTicker = (t) => (cache && t ? cache.byTicker.get(String(t).toUpperCase()) || null : null);
export const newArrivals = () => arrivals;
export const sourceLabel = (k) => SOURCE_LABEL[k] || k;

/**
 * Portfolio scope narrows the COVERED half only.
 *
 * The uncovered half has no ticker by definition, so it cannot be filtered by one — and filtering
 * it to nothing would be a silent claim that the book is not discussed, when the truth is that we
 * could not tell. The tab keeps that section whole in both scopes and says so.
 */
export function forScope(scope, rows = companies()) {
  if (scope !== 'portfolio') return rows;
  const held = new Set(coverage.tracked().map((h) => h.ticker.toUpperCase()));
  return rows.filter((r) => r.ticker && held.has(r.ticker.toUpperCase()));
}

// ---------------------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------------------

export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const out = await conditionalJson(ENDPOINT, { key: STORE_KEY, optional: true });
      if (!out.value) return null;
      if (out.status === 304) {
        if (cache) cache.meta.checkedAt = out.checkedAt || Date.now();
        return null;
      }
      const before = cache ? fingerprint(cache.entries) : null;
      ingest(out.value, { origin: 'live', checkedAt: out.checkedAt });
      // Repaint only on a real change, so a tick that carried nothing new never throws away the
      // reader's sort and search.
      return before !== fingerprint(cache.entries) ? cache : null;
    },
  });
  const off = live.subscribe(LIVE_ID, (payload) => {
    if (!payload) return;
    for (const fn of listeners) {
      try {
        fn(cache);
      } catch (err) {
        console.error('[chatter-live] listener failed', err);
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

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
