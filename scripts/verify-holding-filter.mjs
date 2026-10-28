// The header's Holding filter (GLOW-OWNED): one choice, applied once in data/scope.js, narrows every
// scope and every scoped feed — and changes nothing at all while it is All. Offline; no server.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };

const coverage = await import('../public/js/data/coverage.js');
const watchlist = await import('../public/js/core/watchlist.js');
const filter = await import('../public/js/core/holding-filter.js');
const scope = await import('../public/js/data/scope.js');
const { matchesAlertScope, alertContextKey } = await import('../public/js/data/daily-alerts.js');
const { filterCorporateActionsByScope } = await import('../public/js/data/corporate-actions.js');

const book = [
  { isin: 'INE000000001', ticker: 'DIRECT', name: 'Direct Industries', holdingCategories: ['direct-equity'] },
  { isin: 'INE000000002', ticker: 'MANAGED', name: 'Managed Ltd', holdingCategories: ['pms'] },
  { isin: 'INE000000003', ticker: 'BOTH', name: 'Both Ltd', holdingCategories: ['direct-equity', 'pms'] },
  { isin: 'INE000000004', ticker: null, name: 'Private Direct', holdingCategories: ['direct-equity'] },
];
coverage.prime({ holdings: book });
const rows = [{ ticker: 'DIRECT' }, { ticker: 'MANAGED' }, { ticker: 'BOTH' }, { ticker: 'OUTSIDE' },
  { ticker: null, isin: 'INE000000004' }, { ticker: null, isin: 'INE999999999' }];
const tickers = list => list.map(r => r.ticker || r.isin);
const sorted = set => set && [...set].sort();

// ALL CHANGES NOTHING: the default path is the code path that existed before the filter.
assert.equal(filter.holdingCategory(), 'all');
assert.equal(scope.holdingMembership(), null);
assert.equal(scope.scopeTickers('universe'), null, 'Universe stays "not narrowed" on All');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), ['BOTH', 'DIRECT', 'MANAGED']);
assert.deepEqual(tickers(scope.filterByScope(rows, 'universe')), ['DIRECT', 'MANAGED', 'BOTH', 'OUTSIDE', 'INE000000004', 'INE999999999']);
assert.equal(scope.scopeHoldings(book), book, 'All returns the book itself, not a copy');
assert.equal(scope.scopeDisplayLabel('portfolio'), 'Portfolio');
const allKey = alertContextKey('portfolio', book, '2026-10-28');

// A CATEGORY NARROWS EVERY SCOPE TO THE COMPANIES HELD THAT WAY.
let notified = 0;
const off = filter.onHoldingChange(() => { notified += 1; });
assert.equal(filter.setHoldingCategory('direct-equity'), true);
assert.equal(filter.setHoldingCategory('direct-equity'), false, 'an unchanged choice is not a change');
assert.equal(notified, 1);
assert.equal(storage.get('glow:holding-category:v1'), 'direct-equity', 'the choice is remembered on this device');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), ['BOTH', 'DIRECT']);
assert.deepEqual(sorted(scope.scopeTickers('universe')), ['BOTH', 'DIRECT'], 'Universe narrows to the category');
assert.deepEqual(tickers(scope.filterByScope(rows, 'portfolio')), ['DIRECT', 'BOTH']);
assert.deepEqual(tickers(scope.filterByScope(rows, 'universe')), ['DIRECT', 'BOTH', 'INE000000004'],
  'a tickerless row stays in Universe only when its own ISIN is held that way');
assert.equal(scope.scopeAllowsTicker('universe', 'OUTSIDE'), false);
assert.deepEqual(scope.scopeHoldings(book).map(h => h.isin), ['INE000000001', 'INE000000003', 'INE000000004']);
assert.equal(scope.scopeDisplayLabel('portfolio'), 'Portfolio · Direct Equity');
assert.deepEqual(scope.scopeBook('portfolio'), { count: 3, uncovered: 1, noun: 'Direct Equity companies', label: 'Portfolio · Direct Equity' });
assert.equal(scope.scopePossessive('universe'), 'your Direct Equity holdings');
assert.notEqual(alertContextKey('portfolio', book, '2026-10-28'), allKey, 'saved alert windows are keyed by the choice');
assert.deepEqual(tickers(filterCorporateActionsByScope(rows, 'portfolio', book)), ['DIRECT', 'BOTH', 'INE000000004']);

// Watchlist: the watched companies the family also holds that way.
watchlist.add('MANAGED', 'Managed Ltd', 'Test');
watchlist.add('OUTSIDE', 'Outside Ltd', 'Test');
filter.setHoldingCategory('pms');
assert.deepEqual(sorted(scope.scopeTickers('watchlist')), ['MANAGED']);
assert.deepEqual(tickers(scope.filterByScope(rows, 'watchlist')), ['MANAGED']);
assert.equal(scope.scopeBook('watchlist').count, 1);

// The alert collector keeps private portfolio-only feeds Portfolio's, and entity-only news follows
// the category through its stable entity id.
const held = scope.holdingMembership();
const wanted = scope.scopeMatcher('portfolio');
assert.equal(matchesAlertScope({ ticker: 'MANAGED' }, { scope: 'portfolio', wanted, held }), true);
assert.equal(matchesAlertScope({ ticker: 'DIRECT' }, { scope: 'portfolio', wanted, held }), false);
assert.equal(matchesAlertScope({ ticker: 'MANAGED', portfolioOnly: true }, { scope: 'universe', wanted: scope.scopeMatcher('universe'), held }), false);
filter.setHoldingCategory('direct-equity');
const de = scope.holdingMembership();
const privateEntity = [...de.entityIds].find(id => id.includes('INE000000004'));
assert(privateEntity, 'a tickerless holding has a stable entity id');
assert.equal(matchesAlertScope({ entityId: privateEntity }, { scope: 'universe', wanted: scope.scopeMatcher('universe'), held: de }), true);
assert.equal(matchesAlertScope({ entityId: privateEntity }, { scope: 'watchlist', wanted: scope.scopeMatcher('watchlist'), held: de }), false);

// A category the research list does not cover narrows to nothing — never back to everything.
filter.setHoldingCategory('mutual-fund');
assert.deepEqual(sorted(scope.scopeTickers('universe')), []);
assert.deepEqual(scope.filterByScope(rows, 'universe'), []);

// The book is read afresh: a holding re-filed under another category moves with it.
filter.setHoldingCategory('pms');
coverage.useFamilyBook(book.map(h => h.ticker === 'DIRECT' ? { ...h, holdingCategories: ['pms'] } : h), '2026-10-28');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), ['BOTH', 'DIRECT', 'MANAGED']);
coverage.useFamilyBook(null);

assert.equal(filter.setHoldingCategory('obsolete-value'), true, 'an unknown value normalises to All');
assert.equal(filter.holdingCategory(), 'all');
assert.equal(scope.holdingMembership(), null);
off();
console.log('PASS holding filter: All unchanged, every scope narrowed by category, tickerless ISIN/entity rows, watchlist intersection, portfolio-only feeds, empty categories and a changing book.');
