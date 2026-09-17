#!/usr/bin/env node
// scripts/check-book.mjs — refuse a book.json that does not reconcile. GLOW-OWNED.
//
//   node scripts/check-book.mjs            # checks public/data/book.json
//   node scripts/check-book.mjs path.json
//
// Run by the daily GlowVentures copy after `build-book.mjs`, and by anyone about to commit the
// file by hand. It exits non-zero — and the workflow commits nothing — when:
//   • the consolidated sum of the positions, each dedupeGroup counted once, is not the upstream
//     headline `summary.totalValue` to the paisa (a duplicate the exporter dropped, or one it
//     double-counted, is exactly what this catches);
//   • the listed/private split does not reconcile the same way;
//   • a ring-fenced holding is also inside `positions` (it would then be in every total);
//   • a dedupeGroup has ONE member — a broken dedupe, not an absent duplicate;
//   • any position carries a market value that is not a finite number (a null there is an
//     unvalued line the upstream would have refused; a string is a parse that went wrong);
//   • the dated evidence in book-ledger.json contradicts the book it was built beside — a stale
//     copy, a count the book overstates, a trade against an account the book does not carry, or a
//     day's sale whose realised gain has been attributed to more than one row.
// It never rewrites the file. A residual is printed, not absorbed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, 'public/data/book.json');
const COMPANIES = process.env.BOOK_COMPANIES_OUT || join(ROOT, 'public/data/portfolio-companies.json');
const LEDGER = process.env.BOOK_LEDGER_OUT || join(ROOT, 'public/data/book-ledger.json');
const PRIVATE = new Set(['AIF', 'Unlisted', 'Structured Product']);
const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const problems = [];
let ledgerSummary = null;
const positions = Array.isArray(book.positions) ? book.positions : (problems.push('positions is not an array'), []);
const summary = book.summary || {};

const seen = new Set();
const groupSize = new Map();
let total = 0;
let listed = 0;
let priv = 0;
for (const p of positions) {
  if (!isNum(p.marketValue)) problems.push(`${p.security} in ${p.accountId}: marketValue is ${JSON.stringify(p.marketValue)}, not a number`);
  if (p.dedupeGroup) {
    groupSize.set(p.dedupeGroup, (groupSize.get(p.dedupeGroup) || 0) + 1);
    if (seen.has(p.dedupeGroup)) continue;
    seen.add(p.dedupeGroup);
  }
  const mv = isNum(p.marketValue) ? p.marketValue : 0;
  total += mv;
  if (PRIVATE.has(p.assetClass)) priv += mv; else listed += mv;
}
for (const [g, n] of groupSize) if (n < 2) problems.push(`dedupeGroup ${g} has ${n} member — a broken dedupe, not an absent duplicate`);

const residual = r2(r2(total) - (summary.totalValue ?? NaN));
if (!isNum(summary.totalValue)) problems.push('summary.totalValue is missing');
else if (residual !== 0) problems.push(`consolidated sum ${r2(total)} ≠ summary.totalValue ${summary.totalValue} (residual ${residual})`);
if (isNum(summary.listedValue) && r2(listed) !== summary.listedValue) problems.push(`listed sum ${r2(listed)} ≠ summary.listedValue ${summary.listedValue}`);
if (isNum(summary.privateValue) && r2(priv) !== summary.privateValue) problems.push(`private sum ${r2(priv)} ≠ summary.privateValue ${summary.privateValue}`);
if (isNum(summary.positionsCount) && summary.positionsCount !== positions.length) problems.push(`positionsCount ${summary.positionsCount} ≠ ${positions.length} rows`);

const inBook = new Set(positions.map((p) => p.securityKey));
for (const p of book.ringFenced || []) if (inBook.has(p.securityKey)) problems.push(`ring-fenced ${p.securityKey} is also inside positions`);

// THE DATED EVIDENCE — public/data/book-ledger.json beside the book.
//
// The trades, capital-gain lots and income rows behind the Direct Equity view. They are a second
// FILE and must not become a second TRUTH: the two are built from one archive in one run, so this
// refuses them whenever they could disagree with the book or with the meta that describes them.
// The size split is the reason they can drift at all (see `equityLedgerMeta` in build-book.mjs),
// which is exactly why it is checked rather than assumed.
const ledgerMeta = book.equityLedger;
if (!ledgerMeta) problems.push('book.json carries no equityLedger — the Direct Equity view has no coverage to state');
else {
  let ledger = null;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  } catch (err) {
    problems.push(`book-ledger.json could not be read: ${err.message}`);
  }
  if (ledger) {
    // In step with the book it belongs to: same source commit, same statement date. A ledger from
    // yesterday's build under today's book would date a trade to a book that never saw it.
    if (ledger.asOf !== book.asOf) problems.push(`book-ledger.json: asOf ${ledger.asOf} ≠ book.json asOf ${book.asOf}`);
    if (ledger.builtFrom !== book.builtFrom) problems.push(`book-ledger.json: builtFrom ${ledger.builtFrom} ≠ book.json builtFrom ${book.builtFrom}`);
    const txns = Array.isArray(ledger.transactions) ? ledger.transactions : (problems.push('book-ledger.json: transactions is not an array'), []);
    const lots = Array.isArray(ledger.lots) ? ledger.lots : (problems.push('book-ledger.json: lots is not an array'), []);
    const income = Array.isArray(ledger.income) ? ledger.income : (problems.push('book-ledger.json: income is not an array'), []);
    // The counts in the book describe the file. A surface states coverage from the meta without
    // fetching a row, so a meta that overstates the file is a coverage claim nobody can check.
    if (ledgerMeta.transactionCount !== txns.length) problems.push(`equityLedger.transactionCount ${ledgerMeta.transactionCount} ≠ ${txns.length} rows in book-ledger.json`);
    if (ledgerMeta.lotCount !== lots.length) problems.push(`equityLedger.lotCount ${ledgerMeta.lotCount} ≠ ${lots.length} lots`);
    if (ledgerMeta.incomeCount !== income.length) problems.push(`equityLedger.incomeCount ${ledgerMeta.incomeCount} ≠ ${income.length} income rows`);

    const accountIds = new Set((book.accounts || []).map((a) => a.accountId));
    const symbolOf = new Map();
    for (const p of positions) if (p.symbol && !symbolOf.has(p.securityKey)) symbolOf.set(p.securityKey, p.symbol);
    const numericOrNull = (v) => v === null || isNum(v);
    const sales = new Map();
    for (const t of txns) {
      if (!t.date) problems.push(`book-ledger.json: a ${t.security || '?'} trade carries no date`);
      if (t.side !== 'Buy' && t.side !== 'Sell') problems.push(`book-ledger.json: ${t.security || '?'} on ${t.date} has side ${JSON.stringify(t.side)}`);
      // A null is a figure the statement did not print. A STRING is a parse that went wrong, and
      // would be summed or sorted as something else entirely.
      for (const f of ['quantity', 'price', 'amount', 'charges', 'realized']) {
        if (!numericOrNull(t[f])) problems.push(`book-ledger.json: ${t.security || '?'} on ${t.date} has ${f} = ${JSON.stringify(t[f])}, not a number or null`);
      }
      if (t.accountId && !accountIds.has(t.accountId)) problems.push(`book-ledger.json: ${t.security || '?'} on ${t.date} names account ${t.accountId}, which is not in book.json`);
      // The symbol on a row is the book's own for that security — never a second identity.
      const known = symbolOf.get(t.securityKey);
      if (t.symbol && known && t.symbol !== known) problems.push(`book-ledger.json: ${t.securityKey} is ${t.symbol} on a trade and ${known} in positions`);
      // A DAY'S SALE IS ATTRIBUTED ONCE. Two rows of one sale both carrying the realised figure is
      // the double-count GlowVentures measured (Syngene's −₹1.4 Cr counted twice).
      if (t.side === 'Sell' && t.realized != null) {
        const k = `${t.accountNo}|${t.securityKey}@${t.date}`;
        if (sales.has(k)) problems.push(`book-ledger.json: the ${t.security} sale in ${t.accountNo} on ${t.date} carries a realised gain on more than one row`);
        sales.set(k, true);
      }
    }
    for (const l of lots) {
      for (const f of ['quantity', 'saleRate', 'saleAmount', 'purchaseRate', 'purchaseAmount', 'shortTerm', 'longTerm']) {
        if (!numericOrNull(l[f])) problems.push(`book-ledger.json: a ${l.security || '?'} lot has ${f} = ${JSON.stringify(l[f])}, not a number or null`);
      }
    }
    for (const i of income) {
      for (const f of ['quantity', 'ratePerUnit', 'receivable', 'received', 'tds', 'netAmount']) {
        if (!numericOrNull(i[f])) problems.push(`book-ledger.json: a ${i.security || '?'} income row has ${f} = ${JSON.stringify(i[f])}, not a number or null`);
      }
    }
    // THE TAPE MAY NOT CLAIM MORE THAN THE STATEMENTS DETERMINED. It legitimately claims LESS —
    // a lot whose sale the transaction statements do not print has nowhere to be shown — and that
    // gap is reported on the meta rather than being closed by spreading the figure.
    const r = ledgerMeta.realised || {};
    const onTape = r2(txns.reduce((s, t) => s + (t.realized || 0), 0));
    const inLots = r2(lots.reduce((s, l) => s + (l.shortTerm || 0) + (l.longTerm || 0), 0));
    if (isNum(r.onTape) && r2(r.onTape) !== onTape) problems.push(`equityLedger.realised.onTape ${r2(r.onTape)} ≠ ${onTape} summed from the rows`);
    if (isNum(r.inLots) && r2(r.inLots) !== inLots) problems.push(`equityLedger.realised.inLots ${r2(r.inLots)} ≠ ${inLots} summed from the lots`);
    if (Math.abs(onTape) - Math.abs(inLots) > 1) problems.push(`book-ledger.json: the tape attributes ₹${onTape} of realised gain against ₹${inLots} the capital gain statements determined — a sale has been counted twice`);
    // The coverage lists must be the rows' own, or a surface states a reach the file does not have.
    const listMatches = (name, list, from) => {
      const actual = [...new Set(from.map((x) => x.securityKey).filter(Boolean))].sort();
      if (JSON.stringify(list || []) !== JSON.stringify(actual)) problems.push(`equityLedger.${name} does not match the ${actual.length} securities in book-ledger.json`);
    };
    listMatches('securitiesTraded', ledgerMeta.securitiesTraded, txns);
    listMatches('securitiesWithIncome', ledgerMeta.securitiesWithIncome, income);
    listMatches('securitiesWithLots', ledgerMeta.securitiesWithLots, lots);
    ledgerSummary = `book-ledger.json reconciles: ${txns.length} dated trades, ${lots.length} capital-gain lots, ${income.length} income rows · `
      + `${ledgerMeta.accountsWithStatement?.length || 0} account(s) issued a transaction statement, ${ledgerMeta.accountsWithoutStatement?.length || 0} did not · `
      + `statements declare ${ledgerMeta.window?.declaredFrom || '?'}..${ledgerMeta.window?.declaredTo || '?'} — NOT a holding period`;
  }
}

// THE PORTFOLIO BOOK written beside it: every ticker in it is a counted equity position, no two
// lines share a symbol, every line has a symbol or a reason, and the counts add up.
try {
  const c = JSON.parse(readFileSync(COMPANIES, 'utf8'));
  const hs = Array.isArray(c.holdings) ? c.holdings : (problems.push('portfolio-companies.json: holdings is not an array'), []);
  const tickers = hs.map((h) => h.ticker).filter(Boolean);
  if (new Set(tickers).size !== tickers.length) problems.push('portfolio-companies.json: two lines share one NSE symbol');
  for (const h of hs) {
    if (!h.name) problems.push(`portfolio-companies.json: a line has no name (${h.ticker || h.bookName || '?'})`);
    if (!h.ticker && !h.reason) problems.push(`portfolio-companies.json: ${h.name} has no symbol and no reason`);
  }
  const equitySymbols = new Set(positions.filter((p) => p.assetClass === 'Equity' && p.symbol).map((p) => String(p.symbol).toUpperCase()));
  for (const t of tickers) if (!equitySymbols.has(t) && !hs.find((h) => h.ticker === t && /company-index/.test(h.matchedBy || ''))) problems.push(`portfolio-companies.json: ${t} is not an equity symbol in book.json`);
  for (const sym of equitySymbols) if (!tickers.includes(sym)) problems.push(`portfolio-companies.json: equity symbol ${sym} from book.json is missing`);
  if (c.count !== hs.length) problems.push(`portfolio-companies.json: count ${c.count} ≠ ${hs.length} lines`);
  if ((c.resolved || 0) + (c.unlisted || 0) + (c.bseOnly || 0) + (c.unresolved || 0) !== c.count) problems.push('portfolio-companies.json: resolved + unlisted + bseOnly + unresolved ≠ count');
  if (!/GlowVentures/.test(c.source || '')) problems.push(`portfolio-companies.json: source is "${c.source}", not GlowVentures — was scripts/sync-family-book.mjs run here? It reads the SATTVA family's book`);
  if (c.asOf !== book.asOf) problems.push(`portfolio-companies.json: asOf ${c.asOf} ≠ book.json asOf ${book.asOf}`);
} catch (err) {
  problems.push(`portfolio-companies.json could not be read: ${err.message}`);
}

if (problems.length) {
  console.error(`book.json does NOT reconcile — ${problems.length} problem(s):`);
  for (const line of problems) console.error(`  • ${line}`);
  process.exit(1);
}
const countedRows = positions.length - [...groupSize.values()].reduce((s, n) => s + (n - 1), 0);
console.log(
  `book.json reconciles: ${positions.length} rows, ${countedRows} counted once, ` +
    `₹${(total / 1e7).toFixed(2)} Cr = summary.totalValue · listed ₹${(listed / 1e7).toFixed(2)} Cr · private ₹${(priv / 1e7).toFixed(2)} Cr · ` +
    `${(book.ringFenced || []).length} ring-fenced outside · as of ${book.asOf}`
);
{
  const c = JSON.parse(readFileSync(COMPANIES, 'utf8'));
  console.log(`portfolio-companies.json reconciles: ${c.count} lines, ${c.resolved} with an NSE symbol, ${c.unresolved} unresolved, ${c.unlisted} not listed equity · ${c.source} · as of ${c.asOf}`);
}
if (ledgerSummary) console.log(ledgerSummary);
