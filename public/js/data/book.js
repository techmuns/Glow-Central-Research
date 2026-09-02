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

/** Mirrors `PRIVATE_CLASSES` in GlowVentures — a property of the HOLDING, never of the mandate. */
const PRIVATE = new Set(['AIF', 'Unlisted', 'Structured Product']);

let raw = null;
let loading = null;
let derived = null;

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

export function load() {
  if (raw) return Promise.resolve(raw);
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
