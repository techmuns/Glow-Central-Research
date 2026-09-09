import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERIODS, periodRange, inPeriod, matchedDeals, managerTrades, managerHoldings, investorHoldings, identityIndex, preserveBulkDeals } from '../public/js/data/investor-changes.js';
import { mergeBulkDeals } from './lib/bulk-deals-snapshot.mjs';
import { syncBulkDeals } from './sync-bulk-deals.mjs';

assert.equal(PERIODS.length, 5);
assert.deepEqual(periodRange('month', '2026-09-09'), { from: '2026-09-01', to: '2026-09-09' });
assert.deepEqual(periodRange('quarter', '2026-01-02'), { from: '2026-01-01', to: '2026-01-02' });
assert.equal(periodRange('6m', '2026-08-31').from, '2026-02-28');
assert.equal(periodRange('year', '2024-02-29').from, '2023-02-28');
assert.equal(periodRange('itd', '2026-09-09').from, null);
assert.equal(inPeriod({ date: '2026-09-10' }, periodRange('itd', '2026-09-09')), false);
assert.equal(inPeriod({ date: null }, periodRange('itd')), false);

const people = [{ id: 'one', name: 'Example Asset Management Private Limited' }];
const deal = { ticker: 'EXAMPLE', date: '2026-09-01', url: 'https://www.screener.in/trades/bulk/', cells: {
  'Trade Category': 'Bulk deal', Insider: 'EXAMPLE ASSET MANAGEMENT PVT. LTD.', Transaction: 'Buy', 'Trade Shares': '10,000', Price: '50' } };
const variant = (cells) => ({ ...deal, cells: { ...deal.cells, ...cells } });
assert.equal(matchedDeals([deal], people).length, 1);
assert.equal(matchedDeals([variant({ Insider: 'Example Asset Management Pvt Ltd & Others' })], people).length, 0);
assert.equal(matchedDeals([variant({ 'Trade Category': 'Insider trade' }), variant({ 'Trade Category': 'SAST' })], people).length, 0);
assert.equal(matchedDeals([variant({ Transaction: 'Pledge' })], people).length, 0);
assert.equal(matchedDeals([deal], [...people, { id: 'two', name: people[0].name }]).length, 0);
assert.equal(identityIndex([{ id: 'one', name: 'Example', aliases: ['example'] }]).get('example').id, 'one');
const grouped = matchedDeals([deal, variant({ 'Trade Category': 'Block deal' })], people);
assert.equal(grouped.length, 1);
assert.equal(grouped[0].evidence.length, 2);
assert.equal(grouped[0].source, 'Bulk / block deal');
assert.equal(matchedDeals([deal, variant({ Transaction: 'Sell' })], people).length, 2);
assert.equal(matchedDeals([deal, variant({ 'Trade Shares': '20,000' })], people).length, 2);

const source = { byTicker: { EXAMPLE: [deal] } };
const base = { byTicker: { OLD: [{ ticker: 'OLD', date: '2024-01-01', cells: { Transaction: 'Pledge' } }] }, empty: ['EXAMPLE'] };
const merged = mergeBulkDeals(base, source, { capturedAt: '2026-09-02T00:00:00Z' });
assert.equal(merged.rowCount, 2);
assert.equal(merged.byTicker.OLD.length, 1);
assert.equal(merged.empty.length, 0);
assert.equal(mergeBulkDeals(merged, source).rowCount, 2);
const retained = mergeBulkDeals(merged, null, { error: 'Source unavailable' });
assert.equal(retained.bulkDeals.capturedAt, merged.bulkDeals.capturedAt);
assert.equal(retained.bulkDeals.rows, 1);
assert.equal(retained.bulkDeals.error, 'Source unavailable');
assert.equal(mergeBulkDeals(base, merged).bulkDeals.capturedAt, merged.bulkDeals.capturedAt);
assert.equal(preserveBulkDeals([], [deal]).length, 1, 'an empty insider answer cannot erase bulk history');
assert.equal(preserveBulkDeals([deal], [deal]).length, 1);
assert.equal(preserveBulkDeals([base.byTicker.OLD[0]], [deal]).length, 2);
const temp = mkdtempSync(join(tmpdir(), 'glow-bulk-test-'));
const realFetch = globalThis.fetch;
try {
  const file = join(temp, 'trades.json');
  writeFileSync(file, JSON.stringify(merged));
  globalThis.fetch = async () => { throw new Error('test outage'); };
  assert.equal(await syncBulkDeals(file), false);
  const failed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(failed.bulkDeals.capturedAt, merged.bulkDeals.capturedAt);
  assert.equal(failed.rowCount, merged.rowCount);
  assert.match(failed.bulkDeals.error, /test outage/);
  globalThis.fetch = async () => Response.json({ ...source, capturedAt: '2026-09-01T00:00:00Z', sources: ['bulk', 'block'].map((id) => ({ id, ok: true, capturedAt: '2026-09-01T00:00:00Z' })) });
  assert.equal(await syncBulkDeals(file), false, 'an older upstream capture is refused');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).bulkDeals.capturedAt, merged.bulkDeals.capturedAt);
} finally { globalThis.fetch = realFetch; rmSync(temp, { recursive: true }); }

const books = [{ slug: 'example', quarters: ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025'], holdings: [
  { company: 'Example', companySlug: 'EXAMPLE', quarterlyHoldings: { 'Sep 2026': 8, 'Jun 2026': 3, 'Mar 2026': 2, 'Dec 2025': null } },
  { company: 'Gone', companySlug: 'GONE', quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 1 } },
] }];
const observed = investorHoldings(books, [{ slug: 'example', name: 'Investor' }], '2026-09-09');
assert(observed.every((r) => r.date !== '2026-09-30'));
assert.equal(observed.find((r) => r.company === 'Example' && r.date === '2026-06-30').deltaPp, 1);
assert.equal(observed.find((r) => r.company === 'Gone').action, 'awaiting', 'a missing disclosure without a zero-value confirmation is incomplete evidence, not an exit');
assert.equal(observed.find((r) => r.company === 'Gone').deltaPp, null);
assert.equal(observed.filter((r) => inPeriod(r, periodRange('month', '2026-09-09'))).length, 0);

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
const managers = load('managers'), investors = load('super-investors'), filings = load('insider-trades');
const trades = managerTrades(managers.managers), holdings = managerHoldings(managers.managers);
assert(trades.length > 0 && trades.every((r) => r.date && ['buy', 'sell'].includes(r.action)));
assert(holdings.length > 0 && holdings.every((r) => r.date && r.from && r.source === 'PMS statements'));
assert(trades.some((r) => r.amount != null && r.amount < 1e5));
assert(matchedDeals(Object.values(filings.byTicker).flat(), investors.investors.map((i) => ({ id: i.slug, name: i.name }))).length > 0);
console.log('PASS investor changes: period boundaries, strict identity joins, ambiguous names, duplicate evidence, source failure retention, closed-quarter comparisons and shipped data');
