// data/institution-holdings.js — REAL institutional holdings, from TWO different disclosures.
//
//   prime(payload)            // seeded from app.js at bootstrap
//   all()                     // every fund, both kinds
//   byId(investorId)
//   meta()                    // source, when it was read
//   holdingsForScope(scope, holdings, fund)
//
// TWO DISCLOSURES, AND KEEPING THEM APART IS THE WHOLE POINT OF THIS MODULE.
//
//   `disclosure: 'shareholding'` — Trendlyne. Indian companies file their shareholding pattern with
//     the exchanges each quarter, naming every holder above 1% with a share count and a percentage
//     OF THE COMPANY. Those two numbers are the filing itself. Only positions above the naming
//     threshold appear at all. The RUPEE VALUE is Trendlyne's own derivation, holding % × market
//     cap — reproduced unchanged and attributed, never recomputed, for the same reason the con-call
//     scores stay StockScans'.
//
//   `disclosure: 'portfolio'` — an AMC's own monthly portfolio. The percentage is % TO NAV, how
//     much OF THE FUND sits in that company. Every position appears however small, and the rupee
//     value is the AMC's OWN published figure, because a portfolio disclosure does state one.
//
//   So 2.5 under one and 2.5 under the other are not the same measurement, and this module never
//   puts them in the same field under the same name. What it does do is give both a shared
//   VOCABULARY — `periods`, `pctByPeriod`, `pct` — so the view can lay them out with one set of
//   components while labelling each with what it actually means. The shared names describe the
//   SHAPE (a series of percentages over time); `disclosure` is what says what they measure, and
//   every consumer must branch on it before writing a heading.
//
// A MISSING PERCENTAGE IS NEVER A ZERO, in either kind, but it means something different in each.
//   Shareholding: filings trickle in for weeks after a quarter closes, so a holding can carry a
//   share count and a value while its newest percentage is still outstanding — Trendlyne label that
//   "Filing Awaited". Portfolio: a blank month is a month the fund did not hold the line at all.
//   Rendering either as 0% would report something that is not so.

import { filterByScope } from './scope.js';

const PATH = 'data/institution-holdings.json';

let cache = null;
let loadPromise = null;

/** Seed from the bootstrap payload so the module never refetches what app.js already has. */
export function prime(payload) {
  if (payload && !cache) ingest(payload);
  return cache;
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = import('../core/store.js')
    .then((s) => s.revalidatedJson(PATH, { optional: true }))
    .then((p) => {
      loadPromise = null;
      if (p) ingest(p);
      return cache;
    })
    .catch(() => {
      loadPromise = null;
      return null;
    });
  return loadPromise;
}

/**
 * One fund, in the shared vocabulary.
 *
 * The scraper writes `quarters` / `quarterLabels` / `pctByQuarter` and the importer writes
 * `periods` / `periodLabels` / `pctByPeriod`. Aliasing here rather than rewriting either producer
 * keeps scrape-institution-holdings.mjs untouched — it runs on its own schedule against a live
 * upstream and is the last thing that should need editing to add a fund of a different kind.
 */
function normalise(f) {
  const shareholding = (f.disclosure || 'shareholding') === 'shareholding';
  const periods = f.periods || f.quarters || [];
  const periodLabels = f.periodLabels || f.quarterLabels || [];
  const row = (h) => ({
    ...h,
    pctByPeriod: h.pctByPeriod || h.pctByQuarter || {},
    // `pct` is the latest period's percentage. What it MEANS is `disclosure`'s job to say.
    pct: h.pct ?? h.weightPct ?? h.holdingPct ?? null,
  });

  return {
    ...f,
    disclosure: shareholding ? 'shareholding' : 'portfolio',
    periods,
    periodLabels,
    periodNoun: f.periodNoun || 'quarter',
    latestPeriod: f.latestPeriod || f.latestQuarter || periods[0] || null,
    latestPeriodLabel: f.latestPeriodLabel || f.latestQuarterLabel || periodLabels[0] || null,
    // Newest first by position size, which is the order a reader scans for.
    holdings: (f.holdings || []).map(row).sort((a, b) => (b.valueCr ?? 0) - (a.valueCr ?? 0)),
    former: (f.former || []).map(row),
  };
}

function ingest(payload) {
  const institutions = (payload.institutions || []).map(normalise);
  cache = {
    institutions,
    byId: new Map(institutions.map((f) => [f.investorId, f])),
    meta: {
      source: payload.source || null,
      generator: payload.generator || null,
      generatedAt: payload.generated_at || null,
      quarter: payload.quarter || null,
      quarterLabel: payload.quarterLabel || null,
      count: institutions.length,
    },
  };
  return cache;
}

export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.institutions : []);
export const meta = () => (cache ? cache.meta : null);
export const byId = (id) => (cache && id ? cache.byId.get(id) || null : null);

/** Every ticker any tracked institution currently holds — used to answer "who owns this?". */
export function holdersOf(ticker) {
  const t = String(ticker || '').toUpperCase();
  if (!t) return [];
  return all()
    .filter((f) => f.holdings.some((h) => h.ticker.toUpperCase() === t))
    .map((f) => ({ fund: f, holding: f.holdings.find((h) => h.ticker.toUpperCase() === t) }));
}

/**
 * Narrow a fund's holdings to the active scope. Portfolio scope answers a different and more
 * useful question than "what does this fund own" — it answers "where does this fund overlap me".
 */
export function holdingsForScope(scope, portfolioHoldings = [], rows = []) {
  // A row with no ticker cannot be matched against the book or the watchlist, so it drops out of
  // either narrowed scope. That is a limit of the join and not a claim the fund does not hold it —
  // the row is still there under Universe, and it says why it carries no symbol. Tested explicitly
  // rather than left to String(null) happening not to collide with a real symbol.
  return filterByScope(rows, scope, portfolioHoldings);
}
