// data/coverage.js — WHAT THE FAMILY ACTUALLY OWNS, and what the Portfolio toggle means.
//
//   prime(payload)     seeded from portfolio-companies.json at bootstrap
//   holdings()         every book line, in the shape every forScope() expects
//   tracked()          only the lines that carry an NSE ticker — what a feed can match
//   uncovered()        the lines no NSE-keyed feed can ever carry, each with its reason
//   meta()             counts, as-of date and provenance for the "N of 142" notes
//
// THIS IS NOT THE LEDGER. `portfolio.json` holds twelve positions with quantities and costs, and
// it drives Portfolio Analytics — the FIFO replay reconciles against it, so it cannot be widened
// without breaking an identity the suite asserts numerically. This file is the other thing: the
// list of companies the family holds, used to answer "is this one of mine?" in the research tabs.
// Two different questions, two different files, deliberately.
//
// EVERY LINE IS KEPT, INCLUDING THE ONES NO FEED COVERS.
//   Nineteen of the 142 have no NSE symbol: unlisted private holdings, warrant lines, the Vedanta
//   demerger entities, four BSE-only companies and three whose symbol could not be found at all.
//   They are still owned. Dropping them would make "Portfolio" quietly mean "the 123 we happen to
//   have a feed for", and nothing on screen would say so. They travel with a `reason` instead, and
//   the tabs surface them as held-but-not-covered.

let raw = null;

export function prime(payload) {
  if (payload && Array.isArray(payload.holdings)) raw = payload;
  return isLoaded();
}

export const isLoaded = () => !!raw;

/**
 * The whole book, in the shape `forScope()` implementations already read: `{ ticker, name,
 * sector }`. Lines with no NSE symbol carry `ticker: null` — every filter here keys on ticker and
 * skips a null one, which is correct: they cannot match a feed. `uncovered()` is how they are
 * shown rather than lost.
 */
export const holdings = () => (raw ? raw.holdings : []);

/** The subset a feed can actually match. */
export const tracked = () => holdings().filter((h) => h.ticker);

/** The subset no NSE-keyed feed can carry, each with the reason it cannot. */
export const uncovered = () => holdings().filter((h) => !h.ticker);

/** Is this ticker one of ours? */
export function has(ticker) {
  if (!ticker) return false;
  const t = String(ticker).toUpperCase();
  return tracked().some((h) => h.ticker.toUpperCase() === t);
}

export function meta() {
  return {
    asOf: raw?.asOf || null,
    source: raw?.source || null,
    count: raw?.count ?? holdings().length,
    tracked: tracked().length,
    uncovered: uncovered().length,
    unlisted: raw?.unlisted ?? 0,
    bseOnly: raw?.bseOnly ?? 0,
    unresolved: raw?.unresolved ?? 0,
  };
}

/**
 * One line for the tabs to print under a scoped table.
 *
 * The point of saying it everywhere is that a reader looking at a Portfolio-scoped view should
 * never have to wonder whether the count in front of them is the whole book. It never is: no feed
 * covers every holding, and the gap is named here rather than left to be discovered.
 */
export function coverageNote(shown, noun = 'holdings') {
  const m = meta();
  if (!m.count) return '';
  const parts = [`${shown} of ${m.count} book ${noun} on this feed`];
  if (m.uncovered) parts.push(`${m.uncovered} carry no NSE symbol and cannot appear on any feed here`);
  return parts.join(' · ');
}
