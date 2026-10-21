import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { positionCategory, withHoldingCategories, holdingCategoryMatcher, normalizeHoldingCategory } from '../public/js/data/holding-categories.js';
import { glowPortfolio, glowPositionReply } from '../public/js/data/glow-book-contract.js';
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const book = read('book'), companies = read('portfolio-companies');
const portfolio = await glowPortfolio(companies, book);
assert.deepEqual(portfolio.holdings, companies.holdings, 'the saved names-only book and checked API classify identically');
assert.deepEqual(glowPositionReply(portfolio, book).holdings.map(h => h.holdingCategories), portfolio.holdings.map(h => h.holdingCategories), 'size refreshes retain categories');
assert(portfolio.holdings.some(h => h.holdingCategories.includes('pms')));
assert(portfolio.holdings.some(h => h.holdingCategories.includes('direct-equity')));
assert(portfolio.holdings.some(h => h.holdingCategories.length > 1), 'companies may be held both directly and through PMS');
assert(!/quantity|marketValue|accountId|ownerId/.test(JSON.stringify(portfolio)), 'category projection does not publish positions');
for (const engagement of ['Direct', 'Execution']) assert.equal(positionCategory({ assetClass: 'Equity', engagement }), 'direct-equity');
for (const engagement of [null, 'unknown', 'Advisory', 'Distribution']) assert.equal(positionCategory({ assetClass: 'Equity', engagement }), null);
assert.equal(positionCategory({ assetClass: 'Equity', engagement: 'Direct' }, { engagement: 'PMS' }), 'pms', 'account engagement takes precedence');
assert.equal(positionCategory({ assetClass: 'Cash', engagement: 'PMS' }), 'pms');
assert.equal(positionCategory({ assetClass: 'AIF', valuedAtCost: true }), 'private-investment');
for (const [assetClass, category] of [['Mutual Fund', 'mutual-fund'], ['AIF', 'aif'], ['Bond', 'bond'], ['Unlisted', 'unlisted']]) assert.equal(positionCategory({ assetClass }), category);
const holdings = [{ isin: 'INE000000001', ticker: 'DUAL', bookName: 'Dual', name: 'Dual' }, { isin: 'INE000000002', ticker: null, bookName: 'Private', name: 'Private' }];
const fixture = { accounts: [{ accountId: 'direct', engagement: 'Direct' }, { accountId: 'pms', engagement: 'PMS' }], positions: [
  { isin: holdings[0].isin, symbol: 'DUAL', accountId: 'direct', assetClass: 'Equity' },
  { symbol: 'DUAL', accountId: 'pms', assetClass: 'Equity' },
  { isin: holdings[1].isin, assetClass: 'Unlisted' },
  { isin: 'INE000000003', symbol: 'DUAL', assetClass: 'AIF' },
] };
const classified = withHoldingCategories(holdings, fixture);
assert.deepEqual(classified[0].holdingCategories, ['direct-equity', 'pms'], 'conflicting ISIN cannot borrow a category from a shared symbol');
assert.deepEqual(classified[1].holdingCategories, ['unlisted']);
assert(holdingCategoryMatcher(classified, 'pms')({ ticker: 'DUAL' }));
assert(holdingCategoryMatcher(classified, 'unlisted')({ entityId: 'isin:INE000000002' }), 'tickerless company alerts match stable identities');
assert(!holdingCategoryMatcher(classified, 'pms')({ ticker: 'OUTSIDE' }));
assert(holdingCategoryMatcher(classified, 'all')({ ticker: 'OUTSIDE' }), 'All preserves out-of-book scope members');
assert.equal(normalizeHoldingCategory('obsolete'), 'all');
assert(!Object.hasOwn(holdings[0], 'holdingCategories'), 'classification does not mutate source identities');
console.log('PASS holding categories: real Glow book, account rules, overlapping memberships, tickerless identity, metadata-only changes and size transport.');
