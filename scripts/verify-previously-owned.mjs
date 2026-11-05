// The Watchlist scope's PREVIOUSLY OWNED list (GLOW-OWNED). Offline; no server.
//
//   1. The derivation (scripts/lib/previously-owned.mjs) on constructed books: a company sold to
//      zero is listed with its last-held date; a zero no statement confirms is left out by name; a
//      liquidated mandate's tape confirms its own zero; a nil-balance AIF is a fund, not a company;
//      a company still held — or bought back — is never on it; fund, debt and warrant lines are not
//      companies; a truncated custodian name folds into the company it cuts.
//   2. The browser half (coverage.previouslyOwned + data/scope.js): the Watchlist scope narrows to the
//      chosen list, the Holding choice reads the way each company WAS held, the labels and the
//      denominator say which list is shown, and a re-bought company leaves the list at read time.
//   3. The shipped portfolio-companies.json: nothing on its list is held now.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

const { derivePreviouslyOwned, fundName, isRedeemedToNil } = await import('./lib/previously-owned.mjs');

// ---- 1. The derivation ----------------------------------------------------------------------
const accounts = [
  { accountId: 'pms-1', provider: 'Alpha PMS', accountNo: '1', engagement: 'PMS', asOf: '2026-09-30' },
  { accountId: 'demat-1', provider: 'Family demat', accountNo: '2', engagement: 'Direct', asOf: '2026-10-31' },
  { accountId: 'stale-1', provider: 'Stale PMS', accountNo: '3', engagement: 'PMS', asOf: '2026-07-27' },
  { accountId: 'closed-1', provider: 'Closed PMS', accountNo: '4', engagement: 'PMS', asOf: '2026-09-09',
    noPositionsReason: 'include no holding statement, so nothing here states what this account holds' },
  { accountId: 'partial-1', provider: 'Partial PMS', accountNo: '5', engagement: 'PMS', asOf: '2026-09-09',
    noPositionsReason: 'include no holding statement' },
  { accountId: 'aif-1', provider: 'Gamma AIF', accountNo: '6', engagement: 'AIF', asOf: '2026-07-31' },
  { accountId: 'mf-1', provider: 'Some MF', accountNo: '7', engagement: 'Direct', asOf: '2026-10-01' },
];
const positions = [
  { securityKey: 'held-co', security: 'HELD CO LTD', symbol: 'HELDCO', isin: 'INE000H01011', accountId: 'pms-1', assetClass: 'Equity', quantity: 100, marketValue: 1000 },
  { securityKey: 'cash', security: 'Balance with Banks', accountId: 'demat-1', assetClass: 'Cash', quantity: 1, marketValue: 1 },
  { securityKey: 'stale-other', security: 'OTHER LTD', symbol: 'OTHER', accountId: 'stale-1', assetClass: 'Equity', quantity: 5, marketValue: 50 },
  { securityKey: 'gamma-fund-class-a', security: 'Gamma Opportunities Fund - Class A', accountId: 'aif-1', assetClass: 'AIF', quantity: 0, marketValue: 0, currentPrice: 12.5 },
  { securityKey: 'gamma-fund-class-b', security: 'Gamma Opportunities Fund - Class B', accountId: 'aif-1', assetClass: 'AIF', quantity: 0, marketValue: 0, currentPrice: null },
  { securityKey: 'liquid-fund', security: 'Some Liquid Fund - Direct Growth', accountId: 'mf-1', assetClass: 'Mutual Fund', quantity: 0, marketValue: 0, currentPrice: 3000 },
];
const directory = new Map([
  ['SOLDCO', { isin: 'INE000S01011', name: 'Sold Company Limited' }],
  ['HELDCO', { isin: 'INE000H01011', name: 'Held Co Limited' }],
  ['STALECO', { isin: 'INE000T01011', name: 'Stale Co Limited' }],
  ['LIQCO', { isin: 'INE000L01011', name: 'Liquidated Co Limited' }],
  ['PARTCO', { isin: 'INE000P01011', name: 'Partial Co Limited' }],
  ['ADANIPORTS', { isin: 'INE742F01042', name: 'Adani Ports and Special Economic Zone Limited' }],
  ['REBOUGHT', { isin: 'INE000R01011', name: 'Rebought Limited' }],
]);
const trade = (securityKey, security, accountId, date, side, quantity, isin = null) =>
  ({ securityKey, security, accountId, date, side, quantity, isin, assetClass: 'Equity', bookAssetClass: null });
const transactions = [
  // Bought in the demat and through a PMS, sold out of both; both statements postdate the sale.
  trade('sold-co', 'SOLD COMPANY LTD-EQ', 'demat-1', '2025-02-03', 'Buy', 10, 'INE000S01011'),
  trade('sold-co', 'SOLD COMPANY LTD-EQ', 'demat-1', '2026-09-23', 'Sell', 10, 'INE000S01011'),
  trade('sold-co', 'SOLD COMPANY LTD', 'pms-1', '2026-03-01', 'Sell', 4),
  // Traded and still held: never previously owned.
  trade('held-co', 'HELD CO LTD', 'pms-1', '2026-08-01', 'Sell', 10),
  // Sold AFTER the account's newest holdings statement: nothing confirms the zero yet.
  trade('stale-co', 'STALE CO LTD', 'stale-1', '2026-09-10', 'Buy', 3, 'INE000T01011'),
  // A mandate with no holdings statement whose whole tape ends on sells to zero: liquidated.
  trade('liq-co', 'LIQUIDATED CO LTD', 'closed-1', '2024-01-01', 'Buy', 50, 'INE000L01011'),
  trade('liq-co', 'LIQUIDATED CO LTD', 'closed-1', '2025-07-23', 'Sell', 50, 'INE000L01011'),
  // A mandate with no holdings statement whose tape leaves units behind: unconfirmed.
  trade('part-co', 'PARTIAL CO LTD', 'partial-1', '2024-01-01', 'Buy', 50, 'INE000P01011'),
  trade('part-co', 'PARTIAL CO LTD', 'partial-1', '2025-07-23', 'Sell', 20, 'INE000P01011'),
  // A custodian cut the name in one statement; both are one company.
  trade('adani-ports-and-special-economic', 'ADANI PORTS & SPECIAL ECONOMIC', 'pms-1', '2024-07-30', 'Sell', 5),
  trade('adani-ports-and-special-economic-zone', 'ADANI PORTS & SPECIAL ECONOMIC ZONE LTD', 'pms-1', '2024-07-29', 'Sell', 5, 'INE742F01042'),
  // Lines on an equity tape that are not a company's shares.
  trade('axis-liquid', 'Axis Liquid Fund - Direct Plan - Growth Option', 'pms-1', '2026-09-01', 'Sell', 5),
  trade('brit-ncd', '8%Britannia Industries Ltd NCD', 'pms-1', '2026-02-01', 'Sell', 5),
  trade('boro-warrant', 'BOROSIL RENEWABLES LIMITED - WARRANTS 13AG26', 'demat-1', '2026-02-01', 'Sell', 5, 'INE666D13019'),
  // Bought back: the current research book carries it, so it is held again.
  trade('rebought', 'REBOUGHT LTD', 'pms-1', '2026-01-10', 'Sell', 5, 'INE000R01011'),
];
const lots = [{ securityKey: 'sold-co', security: 'SOLD COMPANY LTD', accountId: 'pms-1', saleDate: '2026-03-01', isin: 'INE000S01011' }];
const derived = derivePreviouslyOwned({
  positions, accounts, transactions, lots,
  current: [{ isin: 'INE000R01011', ticker: 'REBOUGHT', name: 'Rebought Ltd' }],
  directory,
  redemptions: [{ securityKey: 'gamma-fund-class-a', date: '2026-07-31' }],
  earlierBalances: [{ securityKey: 'gamma-fund-class-b', asOf: '2026-03-31', quantity: 10 }],
  resolveName: () => ({ ticker: null, reason: 'no confident symbol match' }),
  sectorOf: (t) => (t === 'SOLDCO' ? 'Financials' : null),
});
const by = (id) => derived.entries.find((e) => e.id === id);

const sold = by('isin:INE000S01011');
assert.ok(sold, 'a company sold to zero in every account is previously owned');
assert.equal(sold.ticker, 'SOLDCO', 'the identity comes from the statement ISIN through the exchange directory');
assert.equal(sold.name, 'Sold Company Limited');
assert.equal(sold.lastHeld, '2026-09-23', 'the last-held date is the final sale');
assert.equal(sold.lastHeldBasis, 'sale');
assert.deepEqual(sold.holdingCategories, ['direct-equity', 'pms'], 'every route it was held through is kept');
assert.deepEqual(sold.zeroConfirmedBy, ['statement']);
assert.equal(sold.zeroAsOf, '2026-10-31');
assert.equal(sold.sector, 'Financials');
for (const k of ['quantity', 'marketValue', 'costBasis']) assert.equal(k in sold, false, `no ${k} is written`);

assert.equal(derived.entries.some((e) => e.ticker === 'HELDCO'), false, 'a company the book still holds is never previously owned');
assert.equal(derived.entries.some((e) => e.ticker === 'REBOUGHT'), false, 'a company the research book carries again has moved back');

assert.equal(derived.entries.some((e) => e.isin === 'INE000T01011'), false, 'a zero no statement confirms is not listed');
const stale = derived.unconfirmed.find((u) => u.isin === 'INE000T01011');
assert.ok(stale && /predates its last trade/.test(stale.reason), 'and it is named, with why');

const liq = by('isin:INE000L01011');
assert.ok(liq, 'a liquidated mandate confirms its own zero on its tape');
assert.deepEqual(liq.zeroConfirmedBy, ['tape']);
assert.equal(liq.lastHeld, '2025-07-23');

assert.equal(derived.entries.some((e) => e.isin === 'INE000P01011'), false, 'a tape that leaves units behind confirms nothing');
assert.ok(derived.unconfirmed.some((u) => u.isin === 'INE000P01011' && /no holdings statement/.test(u.reason)));

const adani = derived.entries.filter((e) => /adani/i.test(e.name));
assert.equal(adani.length, 1, 'a truncated custodian name folds into the company it cuts');
assert.equal(adani[0].ticker, 'ADANIPORTS');
assert.equal(adani[0].lastHeld, '2024-07-30');

assert.equal(derived.entries.some((e) => /\b(liquid|ncd|warrants?)\b/i.test(e.name)), false, 'fund, debt and warrant lines are not companies');

const fund = by('fund:gamma-opportunities-fund');
assert.ok(fund, 'a nil-balance AIF is listed');
assert.equal(fund.kind, 'fund');
assert.equal(fund.ticker, null);
assert.equal(fund.lastHeld, '2026-07-31', "the fund's own dated redemption dates its last units");
assert.equal(fund.lastHeldBasis, 'redemption');
assert.deepEqual(fund.holdingCategories, ['aif']);
assert.match(fund.reason, /no company feed/);
assert.equal(derived.entries.some((e) => /liquid fund/i.test(e.name)), false, 'a mutual fund redeemed to nil is not a company and not an AIF');
assert.equal(derived.excluded['Mutual Fund schemes redeemed to nil'], 1, 'and it is counted, not silently dropped');
assert.equal(derived.count, derived.entries.length);
assert.equal(derived.companies + derived.funds, derived.count);
assert.equal(fundName('3P India Equity Fund 1 - Class B3'), '3P India Equity Fund 1');
assert.equal(isRedeemedToNil({ assetClass: 'Cash', quantity: 0, marketValue: 0 }), false, 'a nil cash balance is not a redemption');
// Two different companies that resolve to one symbol would file one's alerts under the other: refused.
assert.throws(() => derivePreviouslyOwned({
  accounts, positions: [{ securityKey: 'x', accountId: 'pms-1', assetClass: 'Equity', quantity: 1, marketValue: 1 }],
  transactions: [trade('a', 'ALPHA ONE LTD', 'pms-1', '2026-01-01', 'Sell', 1, 'INE000A01011'), trade('b', 'ALPHA TWO LTD', 'pms-1', '2026-01-01', 'Sell', 1, 'INE000B01011')],
  resolveName: () => ({ ticker: 'SAME', resolvedBy: 'name' }),
}), /resolve to one symbol SAME/, 'a symbol collision stops the build');

// ---- 2. The browser half --------------------------------------------------------------------
const coverage = await import('../public/js/data/coverage.js');
const choice = await import('../public/js/core/watch-list-choice.js');
const filter = await import('../public/js/core/holding-filter.js');
const watchlist = await import('../public/js/core/watchlist.js');
const scope = await import('../public/js/data/scope.js');

const book = [
  { isin: 'INE000H01011', ticker: 'HELDCO', name: 'Held Co', holdingCategories: ['pms'] },
  { isin: 'INE000D01011', ticker: 'DIRECTCO', name: 'Direct Co', holdingCategories: ['direct-equity'] },
];
const previouslyOwned = {
  window: { from: '2019-07-26', to: '2026-11-02' },
  entries: [
    { id: 'isin:INE000S01011', kind: 'company', name: 'Sold Company Limited', ticker: 'SOLDCO', isin: 'INE000S01011', holdingCategories: ['direct-equity', 'pms'], lastHeld: '2026-09-23', zeroConfirmedBy: ['statement'] },
    { id: 'isin:INE000L01011', kind: 'company', name: 'Liquidated Co Limited', ticker: 'LIQCO', isin: 'INE000L01011', holdingCategories: ['pms'], lastHeld: '2025-07-23', zeroConfirmedBy: ['tape'] },
    { id: 'fund:gamma', kind: 'fund', name: 'Gamma Opportunities Fund', ticker: null, isin: null, holdingCategories: ['aif'], lastHeld: '2026-07-31', zeroConfirmedBy: ['nil-balance'], reason: 'AIF units' },
    { id: 'isin:INE000D01011', kind: 'company', name: 'Direct Co', ticker: 'DIRECTCO', isin: 'INE000D01011', holdingCategories: ['direct-equity'], lastHeld: '2026-01-01', zeroConfirmedBy: ['statement'] },
  ],
  unconfirmed: [{ name: 'Stale Co Limited', reason: 'predates its last trade' }],
};
coverage.prime({ holdings: book, privateCompanies: [], previouslyOwned });

// The current book wins at read time: DIRECTCO is on the published list and held again.
assert.deepEqual(coverage.previouslyOwned().map((e) => e.id), ['isin:INE000S01011', 'isin:INE000L01011', 'fund:gamma'], 'a re-bought company leaves the list as soon as the book holds it');
assert.equal(coverage.previouslyOwnedMeta().rebought, 1);
assert.equal(coverage.previouslyOwnedMeta().unconfirmed.length, 1);

// Bookmarked is the default and changes nothing.
assert.equal(choice.watchList(), 'bookmarked');
assert.equal(scope.scopeLabel('portfolio'), 'Current portfolio', 'the Portfolio scope is named Current portfolio');
assert.equal(scope.scopeToggleLabel('watchlist'), 'Watchlist');
assert.equal(scope.scopeLabel('watchlist'), 'Watchlist');
watchlist.add('BOOKED', 'Booked Ltd', 'Test');
assert.deepEqual([...scope.scopeTickers('watchlist')], ['BOOKED']);
assert.equal(scope.holdingSignature(), 'all', 'the defaults leave the signature as it was');
const rows = [{ ticker: 'SOLDCO' }, { ticker: 'LIQCO' }, { ticker: 'HELDCO' }, { ticker: 'BOOKED' }, { ticker: null, isin: 'X' }];

// Previously owned.
let heard = 0;
const off = choice.onWatchListChange(() => { heard += 1; });
assert.equal(choice.setWatchList('previous'), true);
assert.equal(choice.setWatchList('previous'), false, 'an unchanged choice is not a change');
assert.equal(heard, 1);
assert.equal(storage.get('glow:watch-list:v1'), 'previous', 'the choice is remembered on this device');
assert.equal(scope.isPreviousScope('watchlist'), true);
assert.equal(scope.isPreviousScope('portfolio'), false);
assert.deepEqual([...scope.scopeTickers('watchlist')].sort(), ['LIQCO', 'SOLDCO']);
assert.deepEqual(scope.filterByScope(rows, 'watchlist').map((r) => r.ticker), ['SOLDCO', 'LIQCO'], 'every scoped feed narrows to the list');
assert.equal(scope.scopeAllowsTicker('watchlist', 'HELDCO'), false, 'a company held now is Current portfolio, not Previously owned');
assert.deepEqual([...scope.scopeTickers('portfolio')].sort(), ['DIRECTCO', 'HELDCO'], 'Current portfolio is untouched');
assert.equal(scope.scopeLabel('watchlist'), 'Previously owned');
assert.equal(scope.scopeDisplayLabel('watchlist'), 'Previously owned');
assert.equal(scope.scopePossessive('watchlist'), 'your previously owned companies');
assert.deepEqual(scope.scopeBook('watchlist'), { count: 3, uncovered: 1, noun: 'previously owned companies', label: 'Previously owned', previous: true },
  'the denominator counts every line, and the fund no feed can carry is the uncovered one');
assert.equal(scope.watchScopeSize(), 3);
assert.equal(scope.watchScopeCompanies().length, 3);
assert.notEqual(scope.holdingSignature(), 'all', 'a report narrowed to Bookmarked is not reused for Previously owned');
const ledger = scope.ownLedgerMatcher('watchlist');
assert.equal(ledger('SOLDCO'), true);
assert.equal(ledger('BOOKED'), false);

// The Holding choice reads the way each previously owned company WAS held.
filter.setHoldingCategory('direct-equity');
assert.deepEqual([...scope.scopeTickers('watchlist')], ['SOLDCO']);
assert.deepEqual(scope.filterByScope(rows, 'watchlist').map((r) => r.ticker), ['SOLDCO']);
assert.equal(scope.scopePossessive('watchlist'), 'your previously owned companies held as Direct Equity');
assert.equal(scope.holdingScopeEmpty('watchlist'), false);
filter.setHoldingCategory('pms');
assert.deepEqual([...scope.scopeTickers('watchlist')].sort(), ['LIQCO', 'SOLDCO']);
filter.setHoldingCategory('all');

// Back to Bookmarked: the shared watchlist again.
choice.setWatchList('bookmarked');
assert.deepEqual([...scope.scopeTickers('watchlist')], ['BOOKED']);
assert.equal(scope.scopeLabel('watchlist'), 'Watchlist');
off();
assert.equal(choice.normalizeWatchList('nonsense'), 'bookmarked', 'an unknown stored value reads as Bookmarked');

// ---- 3. The shipped file --------------------------------------------------------------------
const shipped = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url), 'utf8'));
const po = shipped.previouslyOwned;
assert.ok(po && Array.isArray(po.entries) && po.entries.length > 0, 'the published book carries the Previously owned list');
const heldTickers = new Set(shipped.holdings.map((h) => h.ticker).filter(Boolean));
const heldIsins = new Set(shipped.holdings.map((h) => h.isin).filter(Boolean));
for (const e of po.entries) {
  assert.ok(e.name, 'every line is named');
  assert.ok(!e.ticker || !heldTickers.has(e.ticker), `${e.name} is held now`);
  assert.ok(!e.isin || !heldIsins.has(e.isin), `${e.name} is held now`);
  assert.ok(e.ticker || e.reason, `${e.name} has no symbol and no reason`);
  assert.ok(e.lastHeld == null || /^\d{4}-\d{2}-\d{2}$/.test(e.lastHeld));
  assert.ok(Array.isArray(e.zeroConfirmedBy) && e.zeroConfirmedBy.length, `${e.name} carries no confirmation of a nil balance`);
  assert.ok(e.holdingCategories.every((c) => ['direct-equity', 'pms', 'aif'].includes(c)));
}
assert.equal(new Set(po.entries.map((e) => e.ticker).filter(Boolean)).size, po.entries.filter((e) => e.ticker).length, 'no symbol twice');
assert.equal(po.count, po.entries.length);

console.log(`PASS previously owned: derivation (sold, unconfirmed, tape-liquidated, nil-balance AIF, re-bought, non-company lines, truncated names), the Watchlist scope's two lists with the Holding choice, Current portfolio naming, and ${po.entries.length} shipped entries none of which is held now.`);
