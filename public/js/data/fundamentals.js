// data/fundamentals.js — the browser side of the Screener fundamentals capture
// (public/data/fundamentals.json, written by scripts/scrape-screener-fundamentals.mjs).
//
// It reads the committed file once, caches it, and answers by ticker. The figures are Screener's own,
// reproduced; the only derived thing, the fair-value band, comes from js/data/fair-value.js and is
// labelled ours wherever it is shown. A missing file is not an error — the one-pager simply doesn't
// draw the fundamentals section for a company we have no capture for yet.

import { revalidatedJson } from '../core/store.js';
import { currentSymbol } from './announcement-identity.js';
import { fairValue } from './fair-value.js';

const PATH = 'data/fundamentals.json';
let cache = null;        // { meta, companies: Map<SYMBOL, record> }
let loadPromise = null;

function build(raw) {
  const companies = new Map();
  for (const [sym, rec] of Object.entries(raw?.companies || {})) companies.set(sym.toUpperCase(), rec);
  return {
    meta: { fetchedAt: raw?.fetchedAt || null, count: companies.size, failed: raw?.failed || [], source: raw?.source || null },
    companies,
  };
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = revalidatedJson(PATH, { optional: true })
    .then((raw) => { cache = build(raw || {}); return cache; })
    .catch((err) => { loadPromise = null; throw err; });
  return loadPromise;
}

export function isLoaded() { return !!cache; }
export function meta() { return cache?.meta || { count: 0, failed: [], fetchedAt: null }; }
export function all() { return cache ? [...cache.companies.values()] : []; }

/** The captured fundamentals record for a company, or null (not captured, or file not loaded yet). */
export function byTicker(ticker) {
  if (!cache) return null;
  const sym = currentSymbol(ticker) || String(ticker || '').toUpperCase();
  return cache.companies.get(sym) || null;
}

/** The computed fair-value band for a company, or null when we have no fundamentals for it. */
export function fairValueFor(ticker, { cmp = null } = {}) {
  const f = byTicker(ticker);
  return f ? fairValue(f, { cmp }) : null;
}
