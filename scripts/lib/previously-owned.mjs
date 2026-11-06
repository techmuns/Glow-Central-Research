// scripts/lib/previously-owned.mjs — THE PREVIOUSLY OWNED BOOK, from the family office's own
// statements. GLOW-OWNED. Pure: payloads in, one plain object out — no fs, no fetch, no npm.
//
// THE QUESTION IT ANSWERS: which companies did the family hold — in its own demat, through a PMS
// mandate or through an AIF — that it now holds none of, and when did it last hold each one?
// The Watchlist scope's "Previously owned" list is this answer; js/data/coverage.js reads it and
// js/data/scope.js narrows every scoped tab by it.
//
// TWO SOURCES, BOTH THE STATEMENTS' OWN, AND NOTHING ELSE:
//
//   • THE DATED TRADES — book-ledger.json's tape and capital-gain lots, read from GlowVentures'
//     statement archive by scripts/lib/glow-archive.mjs. A company that appears on the tape and in
//     no current position is a candidate.
//   • THE NIL-BALANCE FUNDS — positions GlowVentures' generated book itself carries at zero units
//     (its `isRedeemedToNil`: a fund vehicle with no units and a NAV or a measured zero value). Those
//     are fund units, not companies; an AIF publishes no portfolio, so they are listed as FUNDS that
//     no company feed can carry — named, never matched to a company.
//
// "NOT IN THE CURRENT BOOK" IS NOT "NOW AT ZERO", and the difference is the whole of this module.
// GlowVentures' book is one row per holding as each account's NEWEST statement marks it, so a
// company is missing from it for two very different reasons: the family sold it, or the account
// that holds it has issued no holdings statement since it was bought. Listing the second as
// "previously owned" would tell the desk it sold a company it still holds. So every account that
// ever traded a company must CONFIRM the zero, in one of three ways, and a company any account
// cannot confirm is left out — counted under `unconfirmed`, by name, with the reason:
//
//   1. STATEMENT — the account's newest holdings statement is dated on or after its last trade in
//      the company and does not list it. (An account whose statement values no holding, or prints
//      a nil portfolio, has a measured holdings statement too; one with no holdings statement at
//      all does not.)
//   2. TAPE — the account has no holdings statement, but its whole tape ends on sells that take
//      every security it traded to zero or below: the mandate was liquidated, and the tape says so.
//   3. NIL BALANCE — the book itself carries the company in that account at zero units.
//
// A RE-BOUGHT COMPANY MOVES BACK BY CONSTRUCTION: anything any current position, the research
// book, the ring-fenced holding or the private-company list carries is excluded here, and the
// browser excludes the current book again at read time (js/data/coverage.js), so a company bought
// back after this file was built leaves Previously owned the moment the book shows it.
//
// IDENTITY IS RESOLVED, NEVER GUESSED. A fully exited company has no current position and so no
// symbol on the tape (scripts/build-book.mjs attaches symbols from positions). Its identity comes,
// in this order, from an EQUITY ISIN any statement printed for it (security type 01 — a warrant,
// a preference share or an NCD is not the company's equity), the exchange's own symbol directory
// for that ISIN, the hand-checked CONFIRMED table, then the collision-guarded company index. A name
// that still resolves nowhere stays in the list with `ticker: null` and the reason, exactly as an
// unresolved line does in the current book.
//
// NO QUANTITY, COST OR VALUE IS WRITTEN — names, routes and dates only, like the rest of
// portfolio-companies.json.

import { tokenise } from './company-index.mjs';

const EQUITY_ISIN = /^INE[A-Z0-9]{4}01[A-Z0-9]{3}$/;
const ANY_ISIN = /^IN[A-Z0-9]{10}$/;
// Lines on an equity tape that are not a company's shares: cash sweeps, liquid and index funds,
// debt, accruals and a bare "BANK" heading some statements print as a row.
const NOT_A_COMPANY = /\b(fund|funds|liquid|etf|bees|mutual|scheme|plan|growth option|ncd|ncb|debenture|bond|bonds|receivable|payable|tds|tax deducted|balance with banks|cash|warrants?|pref|preference|partly paid)\b|^bank$/i;
// A partly-paid line ("Bharti Airtel Ltd PP") is a separate security on the exchange; the
// company's fully-paid line carries the company.
const PARTLY_PAID = /\bPP\b|partly\s*paid/i;
const FUND_VEHICLE = new Set(['AIF', 'Mutual Fund']);
const NIL_STATEMENT = /nil portfolio|balance is nil|has been redeemed|holds nothing/i;
const TAPE_TOLERANCE = 0.5;

/** The categories this dashboard files a route under — js/data/holding-categories.js' vocabulary. */
const ROUTE = { PMS: 'pms', Direct: 'direct-equity', Execution: 'direct-equity', AIF: 'aif', Distribution: 'aif', Advisory: 'aif' };
const CATEGORY_ORDER = ['direct-equity', 'pms', 'aif'];
const CONFIRMATIONS = ['statement', 'nil-balance', 'tape'];

const upper = (v) => String(v || '').trim().toUpperCase();
const maxDate = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);
const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The custodian's wording, minus the suffixes brokers append (as scripts/build-book.mjs does). */
export const bareName = (security) =>
  String(security || '')
    .replace(/\s*-\s*EQ\b.*$/i, '')
    .replace(/\s*-\s*EQ1\/?$/i, '')
    .replace(/\bEQ\s+NEW\b.*$/i, '')
    .replace(/#.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const titleCase = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bLtd\b\.?/g, 'Ltd');

function displayName(names) {
  const cleaned = [...names].map(bareName).filter(Boolean);
  const mixed = cleaned.filter((n) => /[a-z]/.test(n));
  const pool = mixed.length ? mixed : cleaned.map(titleCase);
  return pool.sort((a, b) => b.length - a.length)[0] || '';
}

/** The fund a unit class belongs to: "3P India Equity Fund 1 - Class B3" → "3P India Equity Fund 1". */
export const fundName = (security) =>
  String(security || '').replace(/\s*[-–—]\s*(class|series|plan)\b.*$/i, '').replace(/\s+/g, ' ').trim();

/** GlowVentures' `isRedeemedToNil`, reproduced: a fund vehicle with no units and a NAV or a measured zero. */
export const isRedeemedToNil = (p) =>
  FUND_VEHICLE.has(p?.assetClass) && p.quantity === 0 && (p.currentPrice != null || p.marketValue === 0);

/** Is this position a holding the family has now (anything but a measured zero)? */
const heldNow = (p) => !(p?.quantity === 0 && (p.marketValue === 0 || p.marketValue == null || p.currentPrice != null));

/**
 * @param {object} input
 * @param {object[]} input.positions        BOOK_POSITIONS, as generated
 * @param {object[]} input.accounts         BOOK_ACCOUNTS
 * @param {object[]} [input.ringFenced]     BOOK_POLYCAB — held, outside every total, still held
 * @param {object[]} input.transactions     book-ledger.json's tape (scripts/build-book.mjs)
 * @param {object[]} input.lots             book-ledger.json's capital-gain lots
 * @param {object[]} [input.earlierBalances] BOOK_EARLIER_BALANCES and archived holdings rows — an older statement's balance
 * @param {object[]} [input.redemptions]    archived fund cash flows of kind `withdrawal` — { securityKey, date }
 * @param {object[]} [input.current]        the research book's lines (portfolio-companies holdings)
 * @param {object[]} [input.privateCompanies] the family's current private companies
 * @param {Map<string,Set<string>>} [input.knownIsins] securityKey → ISINs any statement printed for it
 * @param {Map<string,{isin,name}>} [input.directory] the exchange's symbol directory, by ticker
 * @param {(name:string)=>{ticker,resolvedBy,reason}} [input.resolveName] collision-guarded name resolver
 * @param {(ticker:string)=>string|null} [input.sectorOf]
 */
export function derivePreviouslyOwned({
  positions = [], accounts = [], ringFenced = [], transactions = [], lots = [], earlierBalances = [], redemptions = [],
  current = [], privateCompanies = [], knownIsins = new Map(), directory = new Map(),
  resolveName = () => ({ ticker: null, reason: 'no name resolver' }), sectorOf = () => null,
} = {}) {
  const accountById = new Map(accounts.map((a) => [a.accountId, a]));
  const byIsin = new Map();
  for (const [ticker, entry] of directory) if (entry?.isin && !byIsin.has(entry.isin)) byIsin.set(entry.isin, { ticker, ...entry });

  // ---- What the family holds now, by every identity a row can carry --------------------------
  const heldKeys = new Set(), heldIsins = new Set(), heldTickers = new Set(), heldNames = new Set();
  const heldByAccount = new Map(); // accountId -> Set(securityKey)
  const nilByAccount = new Map(); // accountId -> Set(securityKey) at a measured zero
  const positionsByAccount = new Map();
  for (const p of [...positions, ...ringFenced]) {
    positionsByAccount.set(p.accountId, (positionsByAccount.get(p.accountId) || 0) + 1);
    if (!heldNow(p)) {
      if (!nilByAccount.has(p.accountId)) nilByAccount.set(p.accountId, new Set());
      nilByAccount.get(p.accountId).add(p.securityKey);
      continue;
    }
    if (p.securityKey) heldKeys.add(p.securityKey);
    if (ANY_ISIN.test(p.isin || '')) heldIsins.add(p.isin);
    if (p.symbol) heldTickers.add(upper(p.symbol));
    if (p.security) heldNames.add(bareName(p.security).toLowerCase());
    if (!heldByAccount.has(p.accountId)) heldByAccount.set(p.accountId, new Set());
    heldByAccount.get(p.accountId).add(p.securityKey);
  }
  for (const h of current) {
    if (ANY_ISIN.test(h.isin || '')) heldIsins.add(h.isin);
    if (h.ticker) heldTickers.add(upper(h.ticker));
    if (h.bookName) heldNames.add(bareName(h.bookName).toLowerCase());
  }
  for (const c of privateCompanies) {
    for (const k of c.securityKeys || []) heldKeys.add(k);
    for (const i of c.isins || []) heldIsins.add(i);
  }

  // ---- Each account's own evidence of what it holds ------------------------------------------
  /** The date this account's holdings were last MEASURED (a holdings statement), or null. */
  const measuredAt = (accountId) => {
    const a = accountById.get(accountId);
    if (!a || !validDate(a.asOf)) return null;
    if ((positionsByAccount.get(accountId) || 0) > 0) return a.asOf;
    if (NIL_STATEMENT.test(a.noPositionsReason || '')) return a.asOf;
    return null;
  };
  // Tape liquidation: every security the account traded ends at or below zero on its own tape,
  // each on a sell. Only consulted for an account with no holdings statement.
  const tapeByAccount = new Map(); // accountId -> Map(securityKey -> { net, last, lastSide })
  for (const t of transactions) {
    if (!t.accountId || !t.securityKey || !validDate(t.date)) continue;
    if (!tapeByAccount.has(t.accountId)) tapeByAccount.set(t.accountId, new Map());
    const m = tapeByAccount.get(t.accountId);
    const e = m.get(t.securityKey) || { net: 0, last: null, lastSide: null };
    const q = Number(t.quantity) || 0;
    e.net += t.side === 'Sell' ? -q : q;
    if (!e.last || t.date > e.last || (t.date === e.last && t.side === 'Sell')) { e.last = t.date; e.lastSide = t.side; }
    m.set(t.securityKey, e);
  }
  const liquidatedOn = new Map();
  for (const [accountId, m] of tapeByAccount) {
    const rows = [...m.values()];
    if (rows.length && rows.every((e) => e.net <= TAPE_TOLERANCE && e.lastSide === 'Sell')) {
      liquidatedOn.set(accountId, rows.reduce((d, e) => maxDate(d, e.last), null));
    }
  }

  // ---- Every dated row that says a company was held --------------------------------------------
  const excluded = {};
  const skip = (why) => { excluded[why] = (excluded[why] || 0) + 1; };
  const evidence = new Map(); // securityKey -> { names, isins, symbols, rows: [{accountId, date, kind}] }
  const add = (row, date, kind) => {
    if (!row.securityKey || !validDate(date)) return;
    const cls = row.assetClass ?? null;
    const bookCls = row.bookAssetClass ?? null;
    if (cls && cls !== 'Equity') return skip(`${cls} units`);
    if (bookCls && bookCls !== 'Equity') return skip(`${bookCls} lines`);
    const name = String(row.security || '');
    if (NOT_A_COMPANY.test(name) || PARTLY_PAID.test(name)) return skip('not a company’s equity (fund, cash, debt, warrant, preference or partly-paid line)');
    if (row.isin && ANY_ISIN.test(row.isin) && !EQUITY_ISIN.test(row.isin)) return skip('not a company’s equity (fund, cash, debt, warrant, preference or partly-paid line)');
    const e = evidence.get(row.securityKey) || { names: new Set(), isins: new Set(), symbols: new Set(), rows: [] };
    if (name) e.names.add(name);
    if (EQUITY_ISIN.test(row.isin || '')) e.isins.add(row.isin);
    if (row.symbol) e.symbols.add(upper(row.symbol));
    e.rows.push({ accountId: row.accountId || null, date, kind });
    evidence.set(row.securityKey, e);
  };
  for (const t of transactions) add(t, t.date, t.side === 'Sell' ? 'sale' : 'trade');
  for (const l of lots) add(l, l.saleDate, 'sale');

  // ---- Identity, per security key, then grouped into companies ---------------------------------
  const companies = new Map();
  for (const [securityKey, e] of evidence) {
    for (const i of knownIsins.get(securityKey) || []) if (EQUITY_ISIN.test(i)) e.isins.add(i);
    const isin = [...e.isins].sort()[0] || null;
    const name = bareName(displayName(e.names));
    let ticker = (isin && byIsin.get(isin)?.ticker) || [...e.symbols][0] || null;
    let matchedBy = isin && byIsin.get(isin) ? 'exchange directory (ISIN)' : ticker ? 'statement symbol' : null;
    let reason = null;
    if (!ticker) {
      const r = resolveName(bareName([...e.names][0] || name));
      if (r?.ticker) { ticker = upper(r.ticker); matchedBy = /^exchange|^checked/.test(r.resolvedBy || '') ? r.resolvedBy : `company index (${r.resolvedBy || 'name'})`; }
      else reason = `unresolved — ${r?.reason || 'no ISIN on the statements and no confident symbol match'}`;
    }
    const isinFinal = isin || (ticker && directory.get(ticker)?.isin) || null;
    const id = isinFinal ? `isin:${isinFinal}` : ticker ? `nse:${ticker}` : `key:${securityKey}`;
    const c = companies.get(id) || { id, isin: isinFinal, ticker, names: new Set(), securityKeys: new Set(), rows: [], matchedBy, reason, directoryName: null };
    for (const n of e.names) c.names.add(n);
    c.securityKeys.add(securityKey);
    c.rows.push(...e.rows.map((r) => ({ ...r, securityKey })));
    if (!c.ticker && ticker) c.ticker = ticker;
    if (!c.matchedBy && matchedBy) c.matchedBy = matchedBy;
    if (c.ticker) c.reason = null;
    const dir = c.ticker ? directory.get(c.ticker) : null;
    if (dir?.name) c.directoryName = dir.name;
    companies.set(id, c);
  }

  const out = [];
  const unconfirmed = [];
  let stillHeld = 0;
  for (const c of companies.values()) {
    const held = (c.isin && heldIsins.has(c.isin)) || (c.ticker && heldTickers.has(c.ticker)) ||
      [...c.securityKeys].some((k) => heldKeys.has(k)) ||
      (!c.isin && !c.ticker && [...c.names].some((n) => heldNames.has(bareName(n).toLowerCase())));
    if (held) { stillHeld++; continue; }
    const name = c.directoryName || displayName(c.names);
    // Every account that ever traded it must confirm the zero.
    const perAccount = new Map();
    for (const r of c.rows) {
      const k = r.accountId || '(no account)';
      const prior = perAccount.get(k) || { last: null, lastKind: null };
      if (!prior.last || r.date > prior.last || (r.date === prior.last && r.kind === 'sale')) { prior.last = r.date; prior.lastKind = r.kind; }
      perAccount.set(k, prior);
    }
    const confirmedBy = new Set();
    let zeroAsOf = null, why = null;
    const categories = new Set();
    for (const [accountId, { last }] of perAccount) {
      const account = accountById.get(accountId);
      if (!account) { why = 'a statement that traded it belongs to an account the book does not carry'; break; }
      const route = ROUTE[account.engagement];
      if (route) categories.add(route);
      const measured = measuredAt(accountId);
      const nil = [...c.securityKeys].some((k) => nilByAccount.get(accountId)?.has(k));
      if (measured && measured >= last) { confirmedBy.add('statement'); zeroAsOf = maxDate(zeroAsOf, measured); }
      else if (nil) { confirmedBy.add('nil-balance'); zeroAsOf = maxDate(zeroAsOf, account.asOf); }
      else if (!measured && liquidatedOn.has(accountId)) { confirmedBy.add('tape'); zeroAsOf = maxDate(zeroAsOf, liquidatedOn.get(accountId)); }
      else {
        why = measured
          ? `${account.provider}'s newest holdings statement for account ${account.accountNo} (${measured}) predates its last trade in it (${last}), so nothing yet says the holding is nil`
          : `${account.provider} has issued no holdings statement for account ${account.accountNo}, and its tape does not take the holding to zero`;
        break;
      }
    }
    if (why) { unconfirmed.push({ name, ticker: c.ticker || null, isin: c.isin || null, reason: why }); continue; }
    let lastHeld = null, lastHeldBasis = null;
    for (const r of c.rows) if (!lastHeld || r.date > lastHeld || (r.date === lastHeld && r.kind === 'sale')) { lastHeld = r.date; lastHeldBasis = r.kind; }
    out.push({
      id: c.id,
      kind: 'company',
      name,
      ticker: c.ticker || null,
      isin: c.isin || null,
      sector: (c.ticker && sectorOf(c.ticker)) || 'Unclassified',
      holdingCategories: CATEGORY_ORDER.filter((k) => categories.has(k)),
      lastHeld,
      lastHeldBasis,
      zeroConfirmedBy: CONFIRMATIONS.filter((k) => confirmedBy.has(k)),
      zeroAsOf,
      accounts: perAccount.size,
      bookNames: [...c.names].sort().slice(0, 3),
      securityKeys: [...c.securityKeys].sort(),
      matchedBy: c.matchedBy || null,
      ...(c.ticker ? {} : { reason: c.reason || 'unresolved — no NSE symbol for this name' }),
    });
  }

  // ---- The nil-balance funds ----------------------------------------------------------------
  const balanceDates = new Map(); // securityKey -> newest date an older statement printed units
  for (const b of earlierBalances) {
    if (!b?.securityKey || !validDate(b.asOf) || !(Number(b.quantity) > 0)) continue;
    balanceDates.set(b.securityKey, maxDate(balanceDates.get(b.securityKey), b.asOf));
  }
  const tapeDates = new Map();
  for (const t of transactions) if (t.securityKey && validDate(t.date)) tapeDates.set(t.securityKey, maxDate(tapeDates.get(t.securityKey), t.date));
  // A fund's own statement dates the money it paid back: the newest withdrawal is when the
  // family's units last left it.
  const redemptionDates = new Map();
  for (const r of redemptions) if (r?.securityKey && validDate(r.date)) redemptionDates.set(r.securityKey, maxDate(redemptionDates.get(r.securityKey), r.date));
  const heldFunds = new Set(positions.filter((p) => heldNow(p) && FUND_VEHICLE.has(p.assetClass)).map((p) => fundName(p.security).toLowerCase()));
  const funds = new Map();
  for (const p of positions) {
    if (!isRedeemedToNil(p)) continue;
    if (p.assetClass !== 'AIF') { skip(`${p.assetClass} schemes redeemed to nil`); continue; }
    const name = fundName(p.security);
    if (!name || heldFunds.has(name.toLowerCase())) { skip('AIF classes redeemed while another class of the same fund is held'); continue; }
    const id = `fund:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const account = accountById.get(p.accountId) || {};
    const f = funds.get(id) || { id, name, securityKeys: new Set(), bookNames: new Set(), categories: new Set(), accounts: new Set(), lastHeld: null, lastHeldBasis: null, zeroAsOf: null };
    f.securityKeys.add(p.securityKey);
    f.bookNames.add(p.security);
    f.accounts.add(p.accountId);
    f.categories.add(ROUTE[account.engagement] || 'aif');
    const trade = tapeDates.get(p.securityKey), redeemed = redemptionDates.get(p.securityKey), balance = balanceDates.get(p.securityKey);
    if (trade && (!f.lastHeld || trade >= f.lastHeld)) { f.lastHeld = trade; f.lastHeldBasis = 'sale'; }
    if (redeemed && (!f.lastHeld || redeemed >= f.lastHeld)) { f.lastHeld = redeemed; f.lastHeldBasis = 'redemption'; }
    if (balance && (!f.lastHeld || balance > f.lastHeld)) { f.lastHeld = balance; f.lastHeldBasis = 'statement'; }
    f.zeroAsOf = maxDate(f.zeroAsOf, account.asOf || null);
    funds.set(id, f);
  }
  for (const f of funds.values()) {
    out.push({
      id: f.id,
      kind: 'fund',
      name: f.name,
      ticker: null,
      isin: null,
      sector: 'Unclassified',
      holdingCategories: CATEGORY_ORDER.filter((k) => f.categories.has(k)),
      lastHeld: f.lastHeld,
      lastHeldBasis: f.lastHeldBasis,
      zeroConfirmedBy: ['nil-balance'],
      zeroAsOf: f.zeroAsOf,
      accounts: f.accounts.size,
      bookNames: [...f.bookNames].sort().slice(0, 4),
      securityKeys: [...f.securityKeys].sort(),
      matchedBy: null,
      reason: 'AIF units redeemed to nil — the fund publishes no portfolio, so no company feed here can carry it',
    });
  }

  // A custodian's width cuts a name ("Adani Ports & Special Economic"); where the cut name is the
  // unique prefix of a resolved company's name it IS that company, and it is folded in rather than
  // listed twice. Anything less certain stays a line of its own, unresolved and saying so.
  const squash = (name) => tokenise(name).join('');
  for (const e of [...out]) {
    if (e.kind !== 'company' || e.ticker) continue;
    const keys = e.bookNames.map(squash).filter((k) => k.length >= 12);
    const hosts = out.filter((o) => o !== e && o.kind === 'company' && o.ticker &&
      [o.name, ...o.bookNames].some((n) => keys.some((k) => squash(n).startsWith(k))));
    if (hosts.length !== 1) continue;
    const host = hosts[0];
    host.bookNames = [...new Set([...host.bookNames, ...e.bookNames])].sort().slice(0, 4);
    host.securityKeys = [...new Set([...host.securityKeys, ...e.securityKeys])].sort();
    host.holdingCategories = CATEGORY_ORDER.filter((k) => host.holdingCategories.includes(k) || e.holdingCategories.includes(k));
    host.zeroConfirmedBy = CONFIRMATIONS.filter((k) => host.zeroConfirmedBy.includes(k) || e.zeroConfirmedBy.includes(k));
    if (e.lastHeld && (!host.lastHeld || e.lastHeld > host.lastHeld)) { host.lastHeld = e.lastHeld; host.lastHeldBasis = e.lastHeldBasis; }
    host.zeroAsOf = maxDate(host.zeroAsOf, e.zeroAsOf);
    host.accounts = Math.max(host.accounts, e.accounts);
    out.splice(out.indexOf(e), 1);
  }

  out.sort((a, b) => String(b.lastHeld || '').localeCompare(String(a.lastHeld || '')) || a.name.localeCompare(b.name));
  unconfirmed.sort((a, b) => a.name.localeCompare(b.name));
  // A ticker resolved twice would file one company's alerts under another; refuse the file.
  const seen = new Map();
  for (const e of out) {
    if (!e.ticker) continue;
    if (seen.has(e.ticker)) throw new Error(`Previously owned: ${e.name} and ${seen.get(e.ticker)} resolve to one symbol ${e.ticker}`);
    seen.set(e.ticker, e.name);
  }
  return {
    count: out.length,
    companies: out.filter((e) => e.kind === 'company').length,
    resolved: out.filter((e) => e.ticker).length,
    unresolved: out.filter((e) => e.kind === 'company' && !e.ticker).length,
    funds: out.filter((e) => e.kind === 'fund').length,
    stillHeld,
    excluded,
    unconfirmed,
    entries: out,
  };
}
