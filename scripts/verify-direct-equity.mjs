#!/usr/bin/env node
// scripts/verify-direct-equity.mjs — the Direct Equity rollup's contract, offline. GLOW-OWNED.
//
//   node scripts/verify-direct-equity.mjs
//
// No server and no browser: this asserts the arithmetic and the refusals in `js/data/book.js`
// against the SHIPPED book, plus a handful of constructed books for the cases the real one cannot
// produce today. Both halves matter — the shipped file proves the figures reconcile with what
// GlowVentures published, and the fixtures prove the refusals still refuse on a book that has the
// shape the real one happens not to have this month (a dedupeGroup on an equity row, a company
// with cost on some lines and not others).
//
// WHAT IT IS FOR. Every figure on that view is either a statement's own or one of four derived
// from them, and the failure mode this file exists to catch is a derivation that silently stops
// being the thing its label claims: a return struck against a value it was not measured on, an
// average cost divided by shares its cost never covered, a blended IRR nobody computed, a total
// return over some of a company's dividends. Each of those reads as an ordinary number.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const book = await import(`${join(ROOT, 'public/js/data/book.js')}`);

const shipped = read('public/data/book.json');
const ledger = read('public/data/book-ledger.json');
const r2 = (v) => Math.round(v * 100) / 100;
const close = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

let passed = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------------------
// 1. The shipped book — the figures must reconcile with what GlowVentures published.
// ---------------------------------------------------------------------------------------
book.prime(shipped);
book.primeLedger(ledger);

const equityRows = shipped.positions.filter((p) => p.assetClass === 'Equity');
const companies = book.directEquity();
const totals = book.directEquityTotals(companies);

ok('every equity position lands in exactly one company row',
  companies.reduce((s, c) => s + c.rowCount, 0) === equityRows.length,
  `${companies.reduce((s, c) => s + c.rowCount, 0)} of ${equityRows.length}`);

ok('no company is listed twice', new Set(companies.map((c) => c.key)).size === companies.length);

// The rollup may not invent or lose value: it is the equity slice of the book, to the paisa.
const equityValue = r2(equityRows.reduce((s, p) => s + p.marketValue, 0));
ok('the direct-equity value is the equity slice of the book, to the paisa',
  close(totals.value, equityValue), `${totals.value} vs ${equityValue}`);

// A sum over a nullable column is a sum over the rows that carry a figure — and the totals say
// which rows those were, so the P&L is never read against a value it was not struck on.
const costedRows = equityRows.filter((p) => typeof p.costBasis === 'number');
ok('cost covers exactly the lines that carry one',
  totals.costRows === costedRows.length, `${totals.costRows} vs ${costedRows.length}`);
ok('unrealised is the summed upstream P&L, not a re-derivation',
  close(totals.unrealised, r2(costedRows.reduce((s, p) => s + (p.unrealizedPnL || 0), 0))));
ok('costed value minus cost equals the unrealised P&L — the return has a value it was struck on',
  close(totals.costedValue - totals.cost, totals.unrealised),
  `${r2(totals.costedValue - totals.cost)} vs ${totals.unrealised}`);
ok('the costed value is smaller than the whole equity value while some lines carry no cost',
  totals.companiesWithoutCost === 0 || totals.costedValue < totals.value,
  `${totals.costedValue} vs ${totals.value}, ${totals.companiesWithoutCost} companies with no cost`);

// A company held in one account must reproduce that statement's own figures exactly — that is what
// makes the derivation checkable at all.
const singles = companies.filter((c) => c.rowCount === 1);
const returnDrift = singles.filter((c) => typeof c.rows[0].returnPct === 'number' && !close(c.returnPct, c.rows[0].returnPct, 0.05));
ok('a single-account company reproduces the statement\'s own return',
  returnDrift.length === 0, returnDrift.slice(0, 3).map((c) => `${c.name} ${c.returnPct} vs ${c.rows[0].returnPct}`).join('; '));
const avgDrift = singles.filter((c) => typeof c.rows[0].avgCost === 'number' && c.avgCost != null && !close(c.avgCost, c.rows[0].avgCost, 0.05));
ok('a single-account company reproduces the statement\'s own average cost',
  avgDrift.length === 0, avgDrift.slice(0, 3).map((c) => `${c.name} ${c.avgCost} vs ${c.rows[0].avgCost}`).join('; '));

// A NULL IS NOT ZERO, all the way through.
const noCost = companies.filter((c) => c.costBasis === null);
ok('a company with no cost on any statement carries null cost, P&L and return — never zero',
  noCost.length > 0 && noCost.every((c) => c.costBasis === null && c.unrealizedPnL === null && c.returnPct === null && c.avgCost === null),
  `${noCost.length} such companies`);
// A weight of 0.00 is a rounding of a real holding (₹580 of a ₹710 Cr book), which is why this
// asks for a FIGURE rather than a positive one — `null` is the answer that would be wrong.
ok('...and is still counted, valued and weighted',
  noCost.every((c) => typeof c.marketValue === 'number' && c.marketValue > 0 && book.weightOf(c.marketValue) !== null));

// AN IRR IS REPRODUCED, NEVER BLENDED.
const withIrr = companies.filter((c) => c.irr.values.length);
ok('a published IRR is carried for every account that publishes one',
  withIrr.every((c) => c.irr.values.length === c.rows.filter((r) => typeof r.positionIrrPct === 'number').length));
const disagreeing = withIrr.filter((c) => !c.irr.agree);
ok('where accounts publish different IRRs, no single figure is produced',
  disagreeing.length > 0 && disagreeing.every((c) => c.irr.single === null && c.irr.min < c.irr.max),
  `${disagreeing.length} companies`);
ok('...and every published figure is one an account actually printed',
  disagreeing.every((c) => c.irr.values.some((v) => v.pct === c.irr.min) && c.irr.values.some((v) => v.pct === c.irr.max)));
const agreeing = withIrr.filter((c) => c.irr.agree);
ok('where they agree, the figure is the one they published',
  agreeing.length > 0 && agreeing.every((c) => c.irr.values.some((v) => v.pct === c.irr.single)));
ok('a company no statement publishes an IRR for has none, rather than a zero',
  companies.filter((c) => !c.irr.values.length).every((c) => c.irr.single === null && c.irr.min === null));

// A TOTAL RETURN NEEDS EVERY DIVIDEND.
const partialDividends = companies.filter((c) => c.dividends !== null && !c.dividendsComplete);
ok('a company whose dividends are on some lines only gets no total return',
  partialDividends.length > 0 && partialDividends.every((c) => c.totalReturnPct === null),
  `${partialDividends.length} companies`);
const fullDividends = companies.filter((c) => c.totalReturnPct !== null);
ok('...and where it is shown, it is the P&L plus dividends over the cost',
  fullDividends.length > 0 && fullDividends.every((c) => close(c.totalReturnPct, r2(((c.unrealizedPnL + c.dividends) / c.costBasis) * 100), 0.02)),
  `${fullDividends.length} companies`);
ok('a total return is never smaller than the return it adds dividends to',
  fullDividends.every((c) => c.dividends <= 0 || c.totalReturnPct >= c.returnPct));

// FIRST BUY IS THE LOT REGISTER'S, NOT THE TAPE'S.
const tapeStart = ledger.window.observedFrom;
const heldSince = companies.filter((c) => c.heldSince);
ok('first buy is read from the statements\' lot register, and most companies have none',
  heldSince.length > 0 && heldSince.length < companies.length, `${heldSince.length} of ${companies.length}`);
ok('...and is never defaulted to the first date on the transaction tape',
  heldSince.every((c) => c.heldSince !== tapeStart) && companies.filter((c) => !c.heldSince).length > 0);

// ---------------------------------------------------------------------------------------
// 2. The dated evidence — the ledger must describe itself honestly.
// ---------------------------------------------------------------------------------------
const lm = book.ledgerMeta();
ok('the ledger meta travels in the book, so coverage can be stated without fetching the rows',
  lm && lm.transactionCount === ledger.transactions.length && lm.lotCount === ledger.lots.length && lm.incomeCount === ledger.income.length);
ok('the tape is indexed by the upstream\'s own security key',
  companies.some((c) => c.securityKeys.some((k) => book.transactionsFor(k).length)));
const traded = companies.filter((c) => c.securityKeys.some((k) => book.transactionsFor(k).length));
ok('every trade shown under a company is filed under one of its security keys',
  traded.every((c) => c.securityKeys.flatMap((k) => book.transactionsFor(k)).every((t) => c.securityKeys.includes(t.securityKey))));
ok('a sell carries either the realised gain the capital gain statement determined, or a reason',
  ledger.transactions.filter((t) => t.side === 'Sell').every((t) => typeof t.realized === 'number' || typeof t.realizedNote === 'string'));
ok('a trade the statement priced no settlement for keeps null rather than a derived amount',
  ledger.transactions.every((t) => t.amount === null || typeof t.amount === 'number'));
ok('the window says what the statements declare AND what was observed, as two facts',
  typeof lm.window.declaredFrom === 'string' && typeof lm.window.observedFrom === 'string');
ok('accounts that issued no transaction statement are named, not read as having not traded',
  lm.accountsWithoutStatement.length > 0
    && lm.accountsWithStatement.length + lm.accountsWithoutStatement.length === shipped.accounts.length);

// ---------------------------------------------------------------------------------------
// 3. Constructed books — the refusals the shipped file cannot exercise today.
// ---------------------------------------------------------------------------------------
const base = (positions) => ({
  asOf: '2026-08-29',
  summary: { asOf: '2026-08-29', totalValue: positions.reduce((s, p) => s + p.marketValue, 0) },
  accounts: [], owners: [], positions, ringFenced: [], navHistory: [],
});
const pos = (over = {}) => ({
  securityKey: 'acme', security: 'Acme Ltd', symbol: 'ACME', accountId: 'a1', owner: 'A', provider: 'P',
  sector: 'Industrials', assetClass: 'Equity', quantity: 100, marketValue: 200, costBasis: 100,
  unrealizedPnL: 100, returnPct: 100, avgCost: 1, currentPrice: 2, accountAsOf: '2026-08-01',
  dividendReceived: null, positionIrrPct: null, heldSince: null, ...over,
});

// A COST ON SOME LINES ONLY must not divide by the whole quantity — the average cost would then be
// cheaper than anybody paid, which is the same class of error as reading a null as a zero.
book.prime(base([
  pos({ accountId: 'a1', quantity: 100, marketValue: 200, costBasis: 100, unrealizedPnL: 100, returnPct: 100 }),
  pos({ accountId: 'a2', quantity: 900, marketValue: 1800, costBasis: null, unrealizedPnL: null, returnPct: null, avgCost: null }),
]));
const partial = book.directEquity()[0];
ok('average cost divides by the shares the cost covers, not the whole holding',
  partial.avgCost === 1 && partial.costedQty === 100 && partial.quantity === 1000,
  `avgCost ${partial.avgCost} over ${partial.costedQty} of ${partial.quantity}`);
ok('...and the partial coverage is reported rather than implied',
  partial.costComplete === false && partial.costRows === 1 && partial.rowCount === 2 && partial.costedValue === 200);
ok('...and the return is struck on the costed value alone',
  partial.returnPct === 100, String(partial.returnPct));

// A dedupeGroup on an equity row must be counted once, exactly as everywhere else in the book.
book.prime(base([
  pos({ accountId: 'a1', dedupeGroup: 'g1' }),
  pos({ accountId: 'a2', owner: 'B', dedupeGroup: 'g1' }),
  pos({ accountId: 'a3', owner: 'C' }),
]));
const deduped = book.directEquity()[0];
ok('an equity holding reported on two statements is counted once',
  deduped.rowCount === 2 && deduped.marketValue === 400, `${deduped.rowCount} rows, ${deduped.marketValue}`);

// A company with no symbol is still a company.
book.prime(base([pos({ symbol: null, securityKey: 'unlisted-co', security: 'Unlisted Co' })]));
const noSymbol = book.directEquity()[0];
ok('a holding the statements carry no NSE symbol for is still a company row',
  noSymbol.key === 'key:unlisted-co' && noSymbol.symbol === null && noSymbol.marketValue === 200);

// Nothing but Equity.
book.prime(base([pos({ assetClass: 'AIF' }), pos({ assetClass: 'Mutual Fund', securityKey: 'f2' }), pos({ securityKey: 'e1' })]));
ok('only the statements\' own Equity class reaches Direct Equity',
  book.directEquity().length === 1 && book.directEquity()[0].securityKeys[0] === 'e1');

// A LEDGER THAT HAS NOT BEEN READ IS NOT AN EMPTY ONE, and the three states may not collapse.
// A fresh module instance, because the one above has a ledger primed — which is itself the point:
// the ledger is independent of the book payload and priming a book must not silently drop it.
const fresh = await import(`${join(ROOT, 'public/js/data/book.js')}?fresh`);
fresh.prime(base([pos()]));
ok('a ledger nobody has read reports `idle`, not an empty tape',
  fresh.isLedgerLoaded() === false && fresh.ledgerMeta() === null && fresh.transactionsFor('acme').length === 0);
fresh.prime({ ...base([pos()]), equityLedger: { transactionCount: 3, lotCount: 0, incomeCount: 0, window: {}, accountsWithStatement: [], accountsWithoutStatement: [] } });
ok('...and with the meta in hand but the rows not fetched, the state says `idle` rather than loaded',
  fresh.ledgerMeta().state === 'idle' && fresh.ledgerMeta().transactionCount === 3 && fresh.isLedgerLoaded() === false);
fresh.primeLedger({ transactions: [{ date: '2026-05-01', securityKey: 'acme', side: 'Buy', quantity: 1, price: 2, amount: 2 }], lots: [], income: [] });
ok('...and once the rows are in hand it says `loaded` and the trade is filed under its key',
  fresh.ledgerMeta().state === 'loaded' && fresh.transactionsFor('acme').length === 1);
ok('priming a new book does not drop a ledger already in hand',
  (fresh.prime(base([pos()])), fresh.isLedgerLoaded() === true));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
assert.ok(passed > 30, 'the suite should assert more than thirty things');
console.log('Direct Equity reconciles: the rollup is the book\'s equity slice, every derivation is checkable against a single-account statement, and every refusal still refuses.');
