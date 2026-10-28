// data/scope.js — THE THREE SCOPES, IN ONE PLACE.
//
//   SCOPES              the ordered vocabulary: portfolio, watchlist, universe
//   isScope(v)          is this a scope id?
//   scopeLabel(v)       'Portfolio' | 'Watchlist' | 'Universe'
//   scopeTickers(scope, holdings)   the Set a feed filters by, or null for "everything"
//   scopeBook(scope)    { count, uncovered, noun } — the denominator a scoped view must print
//
// THE ORDER IS THE PRIORITY THE READER ASKED FOR: what you own, then what you are watching, then
// everything. Portfolio is the default because the first question on opening a dashboard about
// your own money is what your own money did.
//
// WHY THE FILTER IS A SET OF TICKERS AND NOT A PREDICATE
//   Every `forScope()` in `js/data/` was written as "if not portfolio, return everything", which
//   made a third scope a change in eight modules with eight chances to get it subtly different.
//   They now all ask this one function for the set and filter on it, so a fourth scope is a change
//   here. `null` means unfiltered, which is NOT the same as an empty Set: an empty Set is a real,
//   correct answer (nothing is watched yet) and must narrow the feed to nothing, while `null` is
//   "this scope does not narrow". Collapsing the two would make an empty watchlist show the whole
//   universe — a scope silently meaning its own opposite.

import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import { filingTicker } from './announcement-identity.js';
import { holdingCategory } from '../core/holding-filter.js';
import { holdingCategoryLabel } from './holding-categories.js';
import { portfolioNewsEntities } from './company-news-identity.js';

export const PORTFOLIO = 'portfolio';
export const WATCHLIST = 'watchlist';
export const UNIVERSE = 'universe';

export const SCOPES = [PORTFOLIO, WATCHLIST, UNIVERSE];

export const isScope = (v) => SCOPES.includes(v);

const LABELS = { [PORTFOLIO]: 'Portfolio', [WATCHLIST]: 'Watchlist', [UNIVERSE]: 'Universe' };
export const scopeLabel = (scope) => LABELS[scope] || LABELS[UNIVERSE];

/**
 * THE HOLDING FILTER NARROWS EVERY SCOPE, HERE, ONCE (GLOW-OWNED).
 *
 * The header's Holding choice (core/holding-filter.js) keeps only the companies the family holds
 * under that category, read from the CURRENT book on every call — the book can arrive or change
 * while a tab is open, exactly as AI Alerts' own matcher always read it. `null` while the choice is
 * All, so every function below is unchanged on the default path.
 *
 * Under Portfolio and Universe the answer is the category's companies (less any Universe
 * exclusion); under Watchlist it is the watched companies the family also holds that way. A
 * category the equity research list does not cover yet — Mutual Fund, AIF, Bond today — is an
 * empty Set, never null: narrowing to nothing is a real answer and must not widen to everything.
 */
let membershipMemo = null;
export function holdingMembership() {
  const category = holdingCategory();
  if (category === 'all') return null;
  const book = coverage.holdings();
  if (membershipMemo?.book === book && membershipMemo.category === category) return membershipMemo.value;
  const holdings = book.filter((h) => h.holdingCategories?.includes(category));
  const isins = new Set(holdings.map((h) => upperIsin(h.isin)).filter(Boolean));
  const tickers = new Set(holdings.map((h) => h.ticker).filter(Boolean).map(filingTicker));
  // Name-searched news carries a stable entity id instead of a symbol for BSE-only and private
  // companies; an entity belongs to the category when any of its book lines does.
  const entities = portfolioNewsEntities(book)
    .filter((entity) => (entity.portfolioIsins || []).some((isin) => isins.has(upperIsin(isin))));
  const entityIds = new Set(entities.map((entity) => entity.entityId));
  const value = {
    category,
    label: holdingCategoryLabel(category),
    // Which companies the category covers, as one comparable string: a book change that moves a
    // company in or out changes it even though the chosen category did not.
    signature: JSON.stringify([category, [...tickers].sort(), [...isins].sort()]),
    holdings,
    tickers,
    isins,
    entities,
    entityIds,
    has(ticker, company = null) {
      const t = ticker ? filingTicker(ticker) : '';
      return (!!t && tickers.has(t)) || (!!company?.isin && isins.has(upperIsin(company.isin))) ||
        (!!company?.entityId && entityIds.has(company.entityId));
    },
  };
  membershipMemo = { book, category, value };
  return value;
}
const upperIsin = (value) => String(value || '').trim().toUpperCase();

/** "all", or the active category with the companies it covers now (see holdingMembership). */
export const holdingSignature = () => holdingMembership()?.signature || 'all';

/**
 * Whether the chosen category leaves no company in this scope. Decided on company membership —
 * a private, unlisted or BSE-only holding counts, since identity-aware feeds can show it — and
 * never on the ticker count alone. Always false while the choice is All.
 */
export function holdingScopeEmpty(scope, holdings = null) {
  const held = holdingMembership();
  if (!held) return false;
  if (scope === WATCHLIST) return scopeTickers(WATCHLIST, holdings).size === 0;
  if (scope === PORTFOLIO) return held.holdings.length === 0;
  const universe = baseScopeMatcher(UNIVERSE, holdings);
  return !held.holdings.some((h) => universe.has(h.ticker, h));
}

/**
 * The entity ids of the category's companies inside a scope, for rows that carry a stable entity
 * id and no symbol: all of them under Portfolio, those the reader has not excluded under Universe,
 * none under Watchlist (a list of symbols). `null` while the choice is All. Read per pass, because
 * a Universe exclusion can change without the book changing.
 */
export function holdingEntityIds(scope, holdings = null) {
  const held = holdingMembership();
  if (!held) return null;
  if (scope === WATCHLIST) return new Set();
  if (scope === PORTFOLIO) return held.entityIds;
  const universe = baseScopeMatcher(UNIVERSE, holdings);
  const allowed = new Set(held.holdings.filter((h) => universe.has(h.ticker, h)).map((h) => upperIsin(h.isin)).filter(Boolean));
  return new Set(held.entities.filter((entity) => (entity.portfolioIsins || []).some((isin) => allowed.has(upperIsin(isin))))
    .map((entity) => entity.entityId));
}

/** The given book lines narrowed to the active holding category; the list itself while it is All. */
export function scopeHoldings(holdings = coverage.holdings()) {
  const held = holdingMembership();
  if (!held) return holdings;
  return (holdings || []).filter((h) => held.has(h.ticker, h));
}

/** "Portfolio" or, with a holding category chosen, "Portfolio · PMS". */
export function scopeDisplayLabel(scope) {
  const held = holdingMembership();
  return held ? `${scopeLabel(scope)} · ${held.label}` : scopeLabel(scope);
}

/**
 * The tickers a scope narrows to, or `null` for the whole feed.
 *
 * `holdings` is passed by the callers that already hold the book (they take it as an argument so
 * the data modules stay free of a dependency on which list is "the" book); it defaults to
 * `coverage.holdings()`, which is the same list.
 */
export function scopeTickers(scope, holdings = null) {
  const base = baseScopeTickers(scope, holdings);
  const held = holdingMembership();
  if (!held) return base;
  if (base) return new Set([...base].filter((t) => held.tickers.has(filingTicker(t))));
  // Universe narrowed by a holding category: the category's listed companies, less any company
  // the reader has excluded from Universe.
  const universe = baseScopeMatcher(UNIVERSE, holdings);
  return new Set(held.holdings.filter((h) => h.ticker && universe.has(h.ticker, h)).map((h) => String(h.ticker).toUpperCase()));
}

function baseScopeTickers(scope, holdings = null) {
  if (scope === PORTFOLIO) {
    const book = holdings || coverage.holdings();
    return new Set(book.filter((h) => h.ticker).map((h) => String(h.ticker).toUpperCase()));
  }
  if (scope === WATCHLIST) return watchlist.tickers();
  return null;
}

/**
 * A scope predicate for consumers that need Universe exclusions as well as narrowed-scope sets.
 * `scopeTickers('universe')` deliberately remains null for its long-standing "not narrowed"
 * contract; this predicate is the editable-list-aware form new code should use.
 */
export function scopeAllowsTicker(scope, ticker, holdings = null) {
  return scopeMatcher(scope, holdings).has(ticker);
}

export function scopeMatcher(scope, holdings = null) {
  const base = baseScopeMatcher(scope, holdings);
  const held = holdingMembership();
  if (!held) return base;
  return { has: (ticker, company = null) => held.has(ticker, company) && base.has(ticker, company) };
}

function baseScopeMatcher(scope, holdings = null) {
  // A matcher belongs to one filtering pass. Build membership once, not once per row: the
  // retained alert pool has tens of thousands of rows and a 100+ company portfolio. Re-reading
  // storage or allocating that entire Set for every row stalls the browser during feed updates.
  // A new pass takes a fresh snapshot, so portfolio/watchlist edits still apply immediately.
  const members = baseScopeTickers(scope, holdings);
  // Reviewed SME quote aliases and exchange symbols identify the same company. Match both
  // sides without rewriting holdings or source records, or guessing unknown suffixes.
  const wanted = members && new Set([...members].map(filingTicker));
  const exclusions = wanted ? [] : scopeLists.removed('universe');
  const removed = new Map();
  for (const entry of exclusions) for (const t of [entry.ticker, ...(entry.matchTickers || [])].map(filingTicker)) {
    if (!removed.has(t)) removed.set(t, new Set());
    removed.get(t).add(entry.isin || null);
  }
  const removedIsins = new Set(exclusions.map(entry => entry.isin).filter(Boolean));
  const removedCodes = new Set(exclusions.flatMap(entry => [entry.bseCode, ...(entry.matchTickers || [])]
    .filter(code => /^\d{6}$/.test(String(code || ''))).map(String)));
  return { has: (ticker, company = null) => {
    const t = filingTicker(ticker);
    if (wanted) return !!t && wanted.has(t);
    if (company?.isin) return !removedIsins.has(company.isin) &&
      !removed.get(t)?.has(null) && !removed.get(t)?.has(company.isin);
    const code = String(company?.scripCode || company?.bseCode || '');
    if (/^\d{6}$/.test(code)) return !removedCodes.has(code) && !removed.get(t)?.has(null);
    return !!t && !removed.has(t);
  } };
}

/**
 * Filter any ticker-bearing row set by a scope. The single implementation every `forScope()` uses.
 *
 * A row with no ticker cannot be matched, so it drops out of a narrowed scope — which is right,
 * and is why the two feeds carrying rows that legitimately have no ticker (public chatter's
 * unresolved half, market-wide news) keep those sections whole and SAY they are unscopable rather
 * than filtering them to nothing.
 */
export function filterByScope(rows, scope, holdings = null, tickerOf = (r) => r.ticker) {
  const wanted = scopeMatcher(scope, holdings);
  const held = holdingMembership();
  return rows.filter((r) => {
    const t = tickerOf(r);
    // A tickerless row cannot match a narrowed list, but it remains part of Universe: there is no
    // symbol by which the editor could exclude it, and dropping it would turn an edit feature into
    // a silent data-loss rule for unresolved fund holdings and chatter rows. A holding category
    // keeps one only when its own ISIN or entity id says it is a company held that way.
    return t ? wanted.has(t, r) : scope === UNIVERSE && (!held || wanted.has(null, r));
  });
}

/**
 * "your holdings" / "your watchlist companies" — the phrase an empty-state sentence needs.
 *
 * Returns null for Universe, which has no possessive: nothing there is yours in particular. Every
 * "nothing matched" message on a scoped tab is built from this rather than spelling the two out,
 * because the failure mode is a message that still says "none of your holdings" to a reader who is
 * looking at their watchlist — a sentence that is quietly about a different list.
 */
export function scopePossessive(scope) {
  const held = holdingMembership();
  if (held) return scope === WATCHLIST ? `your watchlist companies held as ${held.label}` : `your ${held.label} holdings`;
  if (scope === PORTFOLIO) return 'your holdings';
  if (scope === WATCHLIST) return 'your watchlist companies';
  return null;
}

/**
 * The denominator a scoped view has to print, per the rule in CLAUDE.md: ninety-six rows look
 * complete until you know the list is a hundred and forty-two.
 *
 * Returns null for Universe, which has no denominator to print — it IS the denominator.
 */
export function scopeBook(scope) {
  const held = holdingMembership();
  if (held && scope === PORTFOLIO) {
    return { count: held.holdings.length, uncovered: held.holdings.filter((h) => !h.ticker).length,
      noun: `${held.label} companies`, label: scopeDisplayLabel(scope) };
  }
  if (held && scope === WATCHLIST) {
    return { count: scopeTickers(WATCHLIST).size, uncovered: 0, noun: 'watched companies', label: scopeDisplayLabel(scope) };
  }
  if (scope === PORTFOLIO) {
    const m = coverage.meta();
    return { count: m.count, uncovered: m.uncovered, noun: 'book companies', label: 'Portfolio' };
  }
  if (scope === WATCHLIST) {
    // A watchlist entry is a ticker the reader starred, so none of them is "uncovered" the way a
    // book line with no NSE symbol is: they came FROM a feed. The gap a watchlist view has to
    // report is the other one — companies watched that THIS feed does not carry — and that is the
    // `count` vs shown difference the pill already prints.
    return { count: watchlist.size(), uncovered: 0, noun: 'watched companies', label: 'Watchlist' };
  }
  return null;
}
