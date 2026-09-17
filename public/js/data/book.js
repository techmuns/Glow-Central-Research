// data/book.js — THE FAMILY OFFICE BOOK, read side. GLOW-OWNED.
//
// `public/data/book.json` is written by `scripts/build-book.mjs` from the generated book in
// techmuns/GlowVentures (`src/data/glowData.ts`), which that repository assembles offline from the
// PDF statements the family's wealth platforms issue. It is copied here daily by
// `.github/workflows/series-refresh.yml`. This module reads it once, derives the few views the
// tabs and Ask Research need, and never recomputes a figure the statements already carry.
//
// Four rules, and each is the same rule the rest of this dashboard runs on:
//
//   • A NULL IS NOT ZERO. A depository does not know what shares cost, an AIF unit has no price
//     per unit, and the book says so with `null`. Nothing here defaults a null to 0; a total over a
//     column with nulls is a total over the rows that carry a figure, and `meta()` says how many
//     did not.
//   • COUNT EACH `dedupeGroup` ONCE. The same AIF folio can be reported on two family members'
//     statements with identical figures. Every row is kept — an owner's view shows each statement
//     as printed — but a CONSOLIDATED figure counts the holding once, exactly as GlowVentures'
//     `dedupedPositions` does, or the book overstates itself. `counted()` is that set; use it for
//     anything that spans more than one owner, and never `positions()`.
//   • THE RING-FENCED HOLDING IS OUTSIDE THE BOOK. The promoter stake GlowVentures keeps on its own
//     page (`BOOK_POLYCAB`) is carried under `ringFenced()` and is in no total, no weight and no
//     row set — the two dashboards must agree about what the consolidated value is.
//   • THE SPLIT IS THE UPSTREAM'S. `isPrivate()` mirrors `PRIVATE_CLASSES` in GlowVentures'
//     `scripts/build-book.mjs` exactly; `privateValue` is summed from the positions, never
//     `total − listed`, so an unnamed class cannot silently become private.

import { revalidatedJson } from '../core/store.js';

const PATH = 'data/book.json';
// THE DATED EVIDENCE, IN ITS OWN FILE AND FETCHED ONLY BY THE VIEW THAT READS IT. 630 KB of
// trades, capital-gain lots and income rows against a 420 KB book — see `equityLedgerMeta` in
// scripts/build-book.mjs, and CLAUDE.md on what a sub-view's file costs in front of the first
// pixel. `book.json` carries the counts and the window, so every coverage sentence on the page can
// be said without this ever being fetched.
const LEDGER_PATH = 'data/book-ledger.json';

/** Mirrors `PRIVATE_CLASSES` in GlowVentures — a property of the HOLDING, never of the mandate. */
const PRIVATE = new Set(['AIF', 'Unlisted', 'Structured Product']);

/** The asset class the Direct Equity view means — the upstream's own word, never a guess. */
const EQUITY = 'Equity';

let raw = null;
let loading = null;
let derived = null;
let ledger = null;
let ledgerLoading = null;
let ledgerFailed = null;
let ledgerIndex = null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;

export const isPrivate = (assetClass) => PRIVATE.has(String(assetClass || ''));

/** Seed from a payload already in hand (app.js loads it deferred). Safe to call more than once. */
export function prime(payload) {
  if (!payload || !Array.isArray(payload.positions)) return null;
  raw = payload;
  derived = null;
  return raw;
}

// ---- the dated evidence -----------------------------------------------------------------------

/**
 * Fetch the trades, lots and income rows. Only a view that renders them should call this.
 *
 * A FAILED READ IS NOT AN EMPTY LEDGER. `ledgerFailed` carries the reason and `ledgerMeta().state`
 * reports it, so a company with no trades on the tape and a company whose tape could not be read
 * never render the same — the rule the investor books already run on.
 */
/** Seed the ledger from a payload already in hand — the symmetric twin of `prime()`. */
export function primeLedger(payload) {
  if (!payload || !Array.isArray(payload.transactions)) return null;
  ledger = payload;
  ledgerIndex = null;
  ledgerFailed = null;
  return ledger;
}

export function loadLedger() {
  if (ledger) return Promise.resolve(ledger);
  if (!ledgerLoading) {
    ledgerFailed = null;
    ledgerLoading = revalidatedJson(LEDGER_PATH)
      .then((payload) => {
        if (!payload || !Array.isArray(payload.transactions)) throw new Error('book-ledger.json carries no transactions array');
        ledger = payload;
        ledgerIndex = null;
        return ledger;
      })
      .catch((err) => {
        ledgerFailed = err?.message || 'book-ledger.json could not be read';
        throw err;
      })
      .finally(() => { ledgerLoading = null; });
  }
  return ledgerLoading;
}

export const isLedgerLoaded = () => !!ledger;

function ledgerBuild() {
  if (ledgerIndex) return ledgerIndex;
  const bucket = (rows, key = 'securityKey') => {
    const m = new Map();
    for (const r of rows || []) {
      const k = r?.[key];
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  ledgerIndex = {
    transactions: bucket(ledger?.transactions),
    lots: bucket(ledger?.lots),
    income: bucket(ledger?.income),
  };
  return ledgerIndex;
}

/** Every dated trade filed under one security key, newest first. `[]` only once the file has loaded. */
export function transactionsFor(securityKey) {
  if (!ledger || !securityKey) return [];
  return ledgerBuild().transactions.get(securityKey) || [];
}

/** The capital-gain lots for one security — the statements' own determination of a realised gain. */
export function lotsFor(securityKey) {
  if (!ledger || !securityKey) return [];
  return ledgerBuild().lots.get(securityKey) || [];
}

/** Dividends, bonuses and spin-offs recorded against one security. */
export function incomeFor(securityKey) {
  if (!ledger || !securityKey) return [];
  return ledgerBuild().income.get(securityKey) || [];
}

/**
 * What the dated evidence covers, WITHOUT fetching it.
 *
 * Every field here is read off `book.json`'s own `equityLedger` block, which is why a coverage
 * sentence costs nothing. `state` separates the three answers a surface must keep apart: the rows
 * are here, they have not been asked for, or they could not be read.
 */
export function ledgerMeta() {
  const m = raw?.equityLedger || null;
  if (!m) return null;
  return {
    state: ledger ? 'loaded' : ledgerFailed ? 'failed' : ledgerLoading ? 'loading' : 'idle',
    error: ledgerFailed,
    window: m.window || null,
    accountsWithStatement: m.accountsWithStatement || [],
    accountsWithoutStatement: m.accountsWithoutStatement || [],
    transactionCount: m.transactionCount ?? null,
    lotCount: m.lotCount ?? null,
    incomeCount: m.incomeCount ?? null,
    realised: m.realised || null,
    securitiesTraded: new Set(m.securitiesTraded || []),
    securitiesWithIncome: new Set(m.securitiesWithIncome || []),
    securitiesWithLots: new Set(m.securitiesWithLots || []),
  };
}

export function load({ force = false } = {}) {
  if (raw && !force) return Promise.resolve(raw);
  if (!loading) {
    loading = revalidatedJson(PATH)
      .then((payload) => prime(payload))
      .finally(() => { loading = null; });
  }
  return loading;
}

export function isLoaded() {
  return !!raw;
}

// ---- derived views, built once per payload --------------------------------------------------

function build() {
  if (derived) return derived;
  const positions = raw?.positions || [];
  const seen = new Set();
  const counted = [];
  let sumAll = 0;
  let sumCounted = 0;
  for (const p of positions) {
    const mv = num(p.marketValue) ?? 0;
    sumAll += mv;
    if (p.dedupeGroup) {
      if (seen.has(p.dedupeGroup)) continue;
      seen.add(p.dedupeGroup);
    }
    counted.push(p);
    sumCounted += mv;
  }
  const total = r2(sumCounted);
  const listed = r2(counted.filter((p) => !isPrivate(p.assetClass)).reduce((s, p) => s + (num(p.marketValue) ?? 0), 0));
  const priv = r2(counted.filter((p) => isPrivate(p.assetClass)).reduce((s, p) => s + (num(p.marketValue) ?? 0), 0));
  const bySymbol = new Map();
  for (const p of counted) {
    if (!p.symbol) continue;
    const key = String(p.symbol).toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(p);
  }
  const summary = raw?.summary || {};
  derived = {
    counted,
    bySymbol,
    total,
    listed,
    private: priv,
    doubleCounted: r2(sumAll - sumCounted),
    // The exporter refuses nothing, so the check lives here too: the shipped file's own summary
    // against the sum this module makes of its rows. A residual is shown, never absorbed.
    residual: num(summary.totalValue) == null ? null : r2(total - summary.totalValue),
    withSymbol: counted.filter((p) => p.symbol).length,
    unpricedCost: counted.filter((p) => num(p.costBasis) == null).length,
  };
  return derived;
}

/** Every row as the statements print it — duplicates INCLUDED. For per-owner views only. */
export function positions() {
  return raw?.positions || [];
}

/** The consolidated row set: each dedupeGroup once. The basis for every book-wide figure. */
export function counted() {
  return raw ? build().counted : [];
}

export function ringFenced() {
  return raw?.ringFenced || [];
}

export function accounts() {
  return raw?.accounts || [];
}

export function owners() {
  return raw?.owners || [];
}

export function navHistory() {
  return raw?.navHistory || [];
}

export function summary() {
  return raw?.summary || null;
}

/** Counted positions filed under an NSE symbol — there can be several, one per account. */
export function bySymbol(symbol) {
  if (!raw || !symbol) return [];
  return build().bySymbol.get(String(symbol).toUpperCase()) || [];
}

export function hasSymbol(symbol) {
  return bySymbol(symbol).length > 0;
}

/**
 * The book is the book under both Portfolio and Universe — there is no wider universe of the
 * family's positions to widen to. Watchlist narrows to the rows whose symbol is starred; pass the
 * tickers in, so this module does not reach into the watchlist itself.
 */
export function forScope(scope, tickers = null) {
  const rows = counted();
  if (scope !== 'watchlist') return rows;
  const wanted = tickers instanceof Set ? tickers : new Set(tickers || []);
  return rows.filter((p) => p.symbol && wanted.has(String(p.symbol).toUpperCase()));
}

/** Consolidated market value of a row set that is ALREADY counted once. */
export function valueOf(rows) {
  return r2(rows.reduce((s, p) => s + (num(p.marketValue) ?? 0), 0));
}

// ---- DIRECT EQUITY: one row per COMPANY, across every owner and account ------------------------
//
// The book files a holding per (security, account), because that is how a statement prints it: SBI
// is five rows because five accounts hold it. A reader asking "how much SBI do we own" wants one.
// So this consolidates by company — and every figure it sums is a figure the statements printed.
//
// FIVE RULES, and each is a rule this file already runs on:
//
//   • THE IDENTITY IS THE NSE SYMBOL where the statements resolve to one, and the upstream's
//     `securityKey` where they do not. Fourteen equity rows carry no symbol; they stay in, keyed by
//     their own key, because a holding without a ticker is still a holding.
//   • A SUM OVER A COLUMN WITH NULLS IS A SUM OVER THE ROWS THAT CARRY A FIGURE, AND IT SAYS SO.
//     Twenty-five companies carry no cost on any statement — a depository does not know what shares
//     cost. `costRows` / `rowCount` is that coverage, and `costedValue` is the market value of just
//     the rows the cost covers, because a P&L is only comparable against the value it was struck on.
//   • WHAT IS SUMMED IS SUMMABLE. Quantity, value, cost, P&L and dividends are rupees and shares.
//     A RETURN, A PRICE AND AN IRR ARE NOT: a return is re-derived from the two summed figures and
//     labelled derived, a price is left per statement (they are marked on different dates), and an
//     IRR is reproduced, never blended — see `irr` below.
//   • THE DEDUPE RULE IS THE BOOK'S. Rows come from `counted()`, so a holding reported on two
//     members' statements is counted once here exactly as it is in every other book-wide figure.
//     No equity row carries a `dedupeGroup` in the current book; routing through `counted()` is
//     what keeps that true if one ever does.
//   • DATED EVIDENCE IS ATTACHED, NEVER INVENTED. `firstBuy` is the statement's own `heldSince` —
//     the oldest unit still held — and it is populated on three rows in this corpus, so almost
//     every company shows an em dash rather than the earliest date on a tape that starts in April.

const displayName = (rows) => {
  const names = [...new Set(rows.map((r) => r.security).filter(Boolean))];
  const mixed = names.filter((n) => /[a-z]/.test(n));
  return (mixed.length ? mixed : names).sort((a, b) => b.length - a.length)[0] || '';
};

const sumOrNull = (rows, field) => {
  const have = rows.filter((r) => num(r[field]) != null);
  return have.length ? r2(have.reduce((s, r) => s + r[field], 0)) : null;
};

/**
 * THE PUBLISHED IRRs BEHIND ONE COMPANY, REPRODUCED AND NEVER BLENDED.
 *
 * Only two providers compute a per-position IRR at all, and where a company sits in several of
 * their accounts each one publishes its own — Blue Jet is 96.01% in one book and 99.52% in
 * another, because the two bought on different days. A value-weighted mean of those is not an
 * IRR: nobody computed it, and the arithmetic that would make it one needs the cash flows rather
 * than the answers. So `values` carries each published figure with the account it came from,
 * `single` is the one figure to print where the accounts agree, and where they do not the caller
 * prints the range and says how many accounts published it. Same rule as the ₹ value beside a
 * Finology holding: reproduce, never recompute.
 */
function irrOf(rows) {
  const values = rows
    .filter((r) => num(r.positionIrrPct) != null)
    .map((r) => ({ pct: r.positionIrrPct, accountId: r.accountId, provider: r.provider, owner: r.owner }));
  if (!values.length) return { values: [], single: null, min: null, max: null, agree: false };
  const pcts = values.map((v) => v.pct);
  const min = Math.min(...pcts);
  const max = Math.max(...pcts);
  const agree = max - min < 0.005;
  return { values, single: agree ? values[0].pct : null, min, max, agree, publishedBy: values.length, of: rows.length };
}

function companyOf(key, rows) {
  const quantity = sumOrNull(rows, 'quantity');
  const marketValue = sumOrNull(rows, 'marketValue');
  const costed = rows.filter((r) => num(r.costBasis) != null);
  const costBasis = sumOrNull(rows, 'costBasis');
  // The market value of just the rows a cost covers. A P&L over ₹114 Cr of cost must be read
  // against the ₹128 Cr those same rows are worth, not against the ₹222 Cr the whole book is.
  const costedValue = costed.length ? r2(costed.reduce((s, r) => s + (num(r.marketValue) ?? 0), 0)) : null;
  const costedQty = costed.length ? r2(costed.reduce((s, r) => s + (num(r.quantity) ?? 0), 0)) : null;
  const unrealizedPnL = sumOrNull(rows, 'unrealizedPnL');
  const dividends = sumOrNull(rows, 'dividendReceived');
  const dividendRows = rows.filter((r) => num(r.dividendReceived) != null).length;
  // Derived from the two summed statement figures, and labelled as derived everywhere it is shown.
  // Over a single row it reproduces the statement's own returnPct.
  const returnPct = costBasis && unrealizedPnL != null ? r2((unrealizedPnL / costBasis) * 100) : null;
  // Cost per share over the shares a cost covers — never over the whole quantity, which would
  // divide a partial cost by a complete holding and print a cheaper average than anybody paid.
  const avgCost = costBasis != null && costedQty ? r2(costBasis / costedQty) : null;
  // TOTAL RETURN NEEDS EVERY DIVIDEND, and this corpus carries them on 71 of 300 rows. A total
  // return over some of a company's accounts' dividends understates it while looking complete, so
  // it is only computed where every row of this company carries both a cost and a dividend figure.
  const dividendsComplete = dividendRows === rows.length && rows.length > 0;
  const costComplete = costed.length === rows.length && rows.length > 0;
  const totalReturnPct = dividendsComplete && costComplete && costBasis
    ? r2(((unrealizedPnL + dividends) / costBasis) * 100)
    : null;
  const statementDates = rows.map((r) => r.accountAsOf).filter(Boolean).sort();
  const heldSince = rows.map((r) => r.heldSince).filter(Boolean).sort()[0] || null;
  const sectors = [...new Set(rows.map((r) => r.sector).filter((s) => s && s !== 'Unclassified'))];
  return {
    key,
    symbol: rows.find((r) => r.symbol)?.symbol || null,
    name: displayName(rows),
    securityKeys: [...new Set(rows.map((r) => r.securityKey).filter(Boolean))],
    isin: rows.find((r) => r.isin)?.isin || null,
    sector: sectors[0] || null,
    providerSector: rows.find((r) => r.providerSector)?.providerSector || null,
    rows,
    rowCount: rows.length,
    owners: [...new Set(rows.map((r) => r.owner).filter(Boolean))].sort(),
    ownerIds: [...new Set(rows.map((r) => r.ownerId).filter(Boolean))].sort(),
    accounts: [...new Set(rows.map((r) => r.accountId).filter(Boolean))],
    providers: [...new Set(rows.map((r) => r.provider).filter(Boolean))].sort(),
    quantity,
    marketValue,
    costBasis,
    costRows: costed.length,
    costedValue,
    costedQty,
    costComplete,
    unrealizedPnL,
    returnPct,
    avgCost,
    dividends,
    dividendRows,
    dividendsComplete,
    totalReturnPct,
    irr: irrOf(rows),
    heldSince,
    statementFrom: statementDates[0] || null,
    statementTo: statementDates.at(-1) || null,
  };
}

/**
 * One row per direct-equity company, across every owner and account, largest first.
 *
 * `assetClass === 'Equity'` is the upstream's own classification — fund units, ETFs, AIF units and
 * cash are not direct equity and are not here. The ring-fenced promoter holding is outside the book
 * on both dashboards and is therefore outside this too, because it comes from `counted()`.
 */
export function directEquity(rows = null) {
  const source = (rows || counted()).filter((p) => p.assetClass === EQUITY);
  const groups = new Map();
  for (const p of source) {
    const key = p.symbol ? String(p.symbol).toUpperCase() : `key:${p.securityKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()]
    .map(([key, group]) => companyOf(key, group))
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
}

/**
 * The totals under a set of company rows — and the coverage each one is honest about.
 *
 * `value` is every company's statement value; `cost`, `unrealised` and `returnPct` describe only
 * the rows that carry a cost, and `costedValue` is what they are worth. Printing a 94% return by
 * dividing the whole value by a partial cost is the failure this shape exists to prevent.
 */
export function directEquityTotals(companies) {
  const rows = companies.flatMap((c) => c.rows);
  const costed = rows.filter((r) => num(r.costBasis) != null);
  const value = r2(rows.reduce((s, r) => s + (num(r.marketValue) ?? 0), 0));
  const cost = costed.length ? r2(costed.reduce((s, r) => s + r.costBasis, 0)) : null;
  const costedValue = costed.length ? r2(costed.reduce((s, r) => s + (num(r.marketValue) ?? 0), 0)) : null;
  const unrealised = costed.length ? r2(costed.reduce((s, r) => s + (num(r.unrealizedPnL) ?? 0), 0)) : null;
  const dividendRows = rows.filter((r) => num(r.dividendReceived) != null);
  return {
    companies: companies.length,
    positions: rows.length,
    accounts: new Set(rows.map((r) => r.accountId).filter(Boolean)).size,
    owners: new Set(rows.map((r) => r.ownerId).filter(Boolean)).size,
    value,
    cost,
    costedValue,
    costRows: costed.length,
    // Companies where NO statement carries a cost — the ones the P&L cannot speak for at all.
    companiesWithoutCost: companies.filter((c) => c.costBasis == null).length,
    unrealised,
    returnPct: cost ? r2((unrealised / cost) * 100) : null,
    dividends: dividendRows.length ? r2(dividendRows.reduce((s, r) => s + r.dividendReceived, 0)) : null,
    dividendRows: dividendRows.length,
    irrPublished: companies.filter((c) => c.irr.values.length).length,
  };
}

/** Share of the consolidated book, in percent — the same denominator `weightPct` uses for a row. */
export function weightOf(marketValue) {
  const d = raw ? build() : null;
  const mv = num(marketValue);
  if (!d || !d.total || mv == null) return null;
  return r2((mv / d.total) * 100);
}

/** Share of the consolidated book, in percent. Null when the book has no total. */
export function weightPct(row) {
  const d = raw ? build() : null;
  const mv = num(row?.marketValue);
  if (!d || !d.total || mv == null) return null;
  return r2((mv / d.total) * 100);
}

export function meta() {
  if (!raw) return null;
  const d = build();
  const s = raw.summary || {};
  return {
    source: raw.source || null,
    builtFrom: raw.builtFrom || null,
    asOf: raw.asOf || s.asOf || null,
    origin: 'snapshot',
    positions: raw.positions.length,
    counted: d.counted.length,
    withSymbol: d.withSymbol,
    accounts: (raw.accounts || []).length,
    accountsWithoutPositions: (raw.accounts || []).filter((a) => a.noPositionsReason).length,
    owners: (raw.owners || []).length,
    totalValue: num(s.totalValue),
    listedValue: num(s.listedValue),
    privateValue: num(s.privateValue),
    // What this module sums from the rows, beside what the file claims — the two must agree.
    countedValue: d.total,
    countedListed: d.listed,
    countedPrivate: d.private,
    doubleCounted: d.doubleCounted,
    residual: d.residual,
    unpricedCost: d.unpricedCost,
    ringFenced: (raw.ringFenced || []).length,
    ringFencedValue: valueOf(raw.ringFenced || []),
  };
}
