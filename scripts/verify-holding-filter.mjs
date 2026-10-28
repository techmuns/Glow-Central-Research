// The header's Holding filter (GLOW-OWNED): one choice, applied once in data/scope.js, narrows every
// scope and every scoped feed — and changes nothing at all while it is All. Offline; no server.
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };

const coverage = await import('../public/js/data/coverage.js');
const scopeLists = await import('../public/js/core/scope-lists.js');
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
const privateCompanies = [{ id: 'private:acmelabs', name: 'Acme Labs', aliases: [], categories: ['private-investment'] }];
coverage.prime({ holdings: book, privateCompanies });
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
assert.equal(scope.holdingSignature(), 'all');
assert.equal(scope.holdingScopeEmpty('portfolio'), false);
assert.equal(scope.holdingEntityIds('universe'), null, 'no entity narrowing on All');
assert.equal(scope.effectiveHoldingCategory(), 'all');
// Only categories some company carries are offered: the book's lines and the family's private companies.
assert.deepEqual(scope.offeredHoldingOptions().map(([id]) => id), ['all', 'direct-equity', 'pms', 'private-investment']);
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
const ctx = name => ({ scope: name, wanted: scope.scopeMatcher(name), heldEntities: scope.holdingEntityIds(name) });
assert.equal(matchesAlertScope({ ticker: 'MANAGED' }, ctx('portfolio')), true);
assert.equal(matchesAlertScope({ ticker: 'DIRECT' }, ctx('portfolio')), false);
assert.equal(matchesAlertScope({ ticker: 'MANAGED', portfolioOnly: true }, ctx('universe')), false);
filter.setHoldingCategory('direct-equity');
const de = scope.holdingMembership();
const privateEntity = [...de.entityIds].find(id => id.includes('INE000000004'));
const directEntity = [...de.entityIds].find(id => id.includes('INE000000001'));
assert(privateEntity && directEntity, 'category holdings have stable entity ids');
assert.equal(matchesAlertScope({ entityId: privateEntity }, ctx('universe')), true);
assert.equal(matchesAlertScope({ entityId: privateEntity }, ctx('watchlist')), false);
// A company the reader removed from Universe stays out of Universe for entity-only alerts too.
scopeLists.remove('universe', { ticker: 'DIRECT', isin: 'INE000000001', name: 'Direct Industries' }, book);
assert.equal(matchesAlertScope({ entityId: directEntity }, ctx('universe')), false, 'Universe exclusion holds for entity alerts');
assert.equal(matchesAlertScope({ ticker: 'DIRECT', entityId: directEntity }, ctx('universe')), false);
assert.equal(matchesAlertScope({ entityId: directEntity }, ctx('portfolio')), true, 'the exclusion is Universe\'s, not the book\'s');
scopeLists.reset('universe');
assert.equal(matchesAlertScope({ entityId: directEntity }, ctx('universe')), true);

// A remembered category no company carries reads as All — it is not offered, so it cannot narrow
// the view behind a control that does not list it.
filter.setHoldingCategory('mutual-fund');
assert.equal(scope.holdingMembership(), null);
assert.equal(scope.effectiveHoldingCategory(), 'all');
assert.equal(scope.scopeTickers('universe'), null);
assert.equal(scope.filterByScope(rows, 'universe').length, rows.length);
assert.equal(scope.holdingScopeEmpty('portfolio'), false);

// A category only a family private company carries: no listed company, but its alerts stay in view
// under Portfolio and Universe (never Watchlist), by the company's own id.
filter.setHoldingCategory('private-investment');
assert.equal(scope.effectiveHoldingCategory(), 'private-investment');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), [], 'no listed company is held this way');
assert.equal(scope.holdingScopeEmpty('portfolio'), false, 'the private company keeps the scope mountable');
const privateEvent = { entityId: 'private:acmelabs', familyPrivate: true, holdingCategories: ['private-investment'] };
assert.equal(matchesAlertScope(privateEvent, ctx('portfolio')), true);
assert.equal(matchesAlertScope(privateEvent, ctx('universe')), true);
assert.equal(matchesAlertScope(privateEvent, ctx('watchlist')), false);
filter.setHoldingCategory('pms');
assert.equal(matchesAlertScope(privateEvent, ctx('portfolio')), false, 'a private company is not a PMS holding');

// A category whose only holding has no NSE ticker is NOT empty: identity-aware feeds can show it.
coverage.useFamilyBook([...book, { isin: 'INE000000005', ticker: null, name: 'Private Unlisted', holdingCategories: ['unlisted'] }], '2026-10-28');
filter.setHoldingCategory('unlisted');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), [], 'no symbol to filter by');
assert.equal(scope.holdingScopeEmpty('portfolio'), false, 'a tickerless holding keeps the scope mountable');
assert.equal(scope.holdingScopeEmpty('universe'), false);
assert.equal(scope.holdingScopeEmpty('watchlist'), true, 'the watchlist holds symbols only');
coverage.useFamilyBook(null);

// The book is read afresh: a holding re-filed under another category moves with it.
filter.setHoldingCategory('pms');
const before = scope.holdingSignature();
coverage.useFamilyBook(book.map(h => h.ticker === 'DIRECT' ? { ...h, holdingCategories: ['pms'] } : h), '2026-10-28');
assert.deepEqual(sorted(scope.scopeTickers('portfolio')), ['BOTH', 'DIRECT', 'MANAGED']);
assert.notEqual(scope.holdingSignature(), before, 'a reclassified book changes the membership signature with the category unchanged');
coverage.useFamilyBook(null);
assert.equal(scope.holdingSignature(), before);

assert.equal(filter.setHoldingCategory('obsolete-value'), true, 'an unknown value normalises to All');
assert.equal(filter.holdingCategory(), 'all');
assert.equal(scope.holdingMembership(), null);
off();
console.log('PASS holding filter: All unchanged, every scope narrowed by category, tickerless ISIN/entity rows, Universe exclusions on entity alerts, watchlist intersection, portfolio-only feeds, empty and tickerless-only categories, and a changing book.');
