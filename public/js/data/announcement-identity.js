// Announcement identities are independent of quote-provider symbols and book-date listing labels.
import { runSteps } from '../core/slices.js';
// These three Yahoo SME aliases are verified against NSE filings (see DATA-CONTRACTS.md).
const SME = { 'ALPEXSOLAR-SM': 'ALPEXSOLAR', 'JAYBEE-SM': 'JAYBEE', 'SAHANA-SM': 'SAHANA' };
// Reviewed warrant-to-issuer relationships resolve against the current exchange directories.
// Only company announcements use this relationship; the holdings themselves remain untouched.
// BUILDPRO subdivision effective 2026-10-08: NSE/CML/76711.
// https://nsearchives.nseindia.com/content/circulars/CML76711.pdf
// The dated Glow holding is retained; only the filing issuer identity advances.
const ISSUER_EQUITY = { INE24OJ01011: 'INE24OJ01029', INE564S13022: 'INE564S01019', INE0R4713012: 'INE0R4701017', INE666D13019: 'INE666D01022' };
export const announcementIssuerIsin = value => ISSUER_EQUITY[upper(value)] || upper(value);
const upper = value => String(value || '').trim().toUpperCase();
// RENAMED SYMBOLS, REVIEWED ONE BY ONE: old NSE symbol -> the symbol NSE lists the same ISIN under
// today. The book follows the exchange, but Moneycontrol, Screener, StockScans and the BSE capture
// (which takes its NSE symbol from Moneycontrol) went on filing these companies under the old one,
// so a Portfolio view asking for the new symbol dropped the history and even that day's filings.
// Every entry must agree with NSE's own equity directory, which lists the old symbol among the
// ISIN's aliases; scripts/verify-renamed-symbols.mjs fails the moment one does not.
//   HEG -> HEGAM  HEG Ltd became HEG Advanced Materials Ltd (INE545A01024), September 2026.
export const RENAMED_SYMBOLS = Object.freeze({ HEG: 'HEGAM' });
/** The current symbol when `value` is a reviewed old symbol, else null. */
export const renamedTo = value => RENAMED_SYMBOLS[upper(value)] || null;
/** The symbol a company trades under today: a reviewed old symbol becomes its current one. */
export const currentSymbol = value => renamedTo(value) || upper(value);
export const filingTicker = value => SME[upper(value)] || renamedTo(value) || upper(value);
// Exchange ISINs join the directories. Keep old exchange/provider symbols as exact aliases.
export function mergeExchangeIdentities(...lists) {
  return runSteps(mergeExchangeIdentitySteps(...lists));
}
export function* mergeExchangeIdentitySteps(...lists) {
  const entries = new Map();
  for (const sourceEntry of lists.flat()) {
    const entry = { ...sourceEntry, isin: announcementIssuerIsin(sourceEntry.isin) };
    const previous = entries.get(entry.isin);
    entries.set(entry.isin, { ...previous, ...entry,
      aliases: [...new Set([...(previous?.aliases || []), previous?.ticker, ...(entry.aliases || [])].filter(Boolean))] });
    yield;
  }
  return [...entries.values()];
}
const nameKey = value => upper(value).replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\b(LIMITED|LTD)\b/g, '').replace(/\s+/g, ' ').trim();

export function createAnnouncementIdentity(entries = []) {
  const isins = new Map(), codes = new Map(), symbols = new Map(), names = new Map();
  const unique = (map, key, entry) => {
    if (!key) return;
    if (map.has(key) && map.get(key)?.isin !== entry.isin) map.set(key, null);
    else if (!map.has(key)) map.set(key, entry);
  };
  for (const entry of entries) {
    unique(isins, upper(entry.isin), entry);
    for (const code of [entry.bseCode, ...(entry.bseCodes || [])]) unique(codes, String(code || ''), entry);
    for (const symbol of [entry.ticker, entry.bseSymbol, ...(entry.aliases || [])]) unique(symbols, filingTicker(symbol), entry);
    unique(names, nameKey(entry.name), entry);
  }
  function find(company) {
    // An explicit ISIN/code must never fall through to a different issuer's similar name/symbol.
    if (company.isin) return isins.get(announcementIssuerIsin(company.isin)) || null;
    if (company.scripCode || company.bseCode) return codes.get(String(company.scripCode || company.bseCode)) || null;
    const ticker = filingTicker(company.ticker || company.bseSymbol);
    // An explicit BSE watchlist entry stores its company code in the ticker field.
    if (/^\d{6}$/.test(ticker)) return codes.get(ticker) || null;
    if (ticker && symbols.has(ticker)) return symbols.get(ticker);
    // Exact exchange names only, and only for source records without a symbol.
    return !ticker ? names.get(nameKey(company.company || company.name)) || null : null;
  }
  const key = company => {
    const hit = find(company);
    if (hit) return `isin:${hit.isin}`;
    const ticker = filingTicker(company.ticker || company.bseSymbol);
    return ticker ? `ticker:${ticker}` : company.isin ? `isin:${upper(company.isin)}` : null;
  };
  const row = value => {
    const hit = find(value);
    const observedCode = String(value.scripCode || value.bseCode || '');
    const ticker = hit?.ticker || hit?.bseSymbol || filingTicker(value.ticker) || null;
    // A row the source filed under a renamed company's old symbol keeps that symbol as provenance.
    const filed = renamedTo(value.ticker) && upper(value.ticker) !== ticker ? { filedTicker: upper(value.ticker) } : {};
    return { ...value, ticker, ...filed,
      ...(hit ? { isin: hit.isin, scripCode: /^\d{6}$/.test(observedCode) ? observedCode : hit.bseCode } : {}) };
  };
  return { find, key, row };
}
