import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalisePortfolio, deriveMoves, summarise, comparisonPeriods, quarterOrder } from '../public/js/data/finology-shared.js';
import { assessCoverage, withVerifiedEntities } from '../public/js/data/holdings-integrity.js';
import { matchedDeals } from '../public/js/data/investor-changes.js';
import { validateBook, assembleSnapshot, retainHistory } from './lib/investor-snapshot.mjs';

const today = '2026-09-09', fetchedAt = `${today}T00:00:00Z`;
const raw = { ok: true, slug: 'example', fetchedAt, quarters: ['Mar 2026', 'Aug 2026', 'Jun 2026'], holdings: [
  { company: 'Increasing', companySlug: 'increasing', quarterlyHoldings: { 'Aug 2026': 'Filing Due', 'Jun 2026': 4, 'Mar 2026': 3 }, valueCr: 0 },
  { company: 'Missing', quarterlyHoldings: { 'Jun 2026': null, 'Mar 2026': 2 } },
  { company: 'Explicit absence', quarterlyHoldings: { 'Jun 2026': '-', 'Mar 2026': 2 } },
  { company: 'Awaited', quarterlyHoldings: { 'Jun 2026': 'Filing Awaited', 'Mar 2026': 2 } },
  { company: 'Off-cycle', quarterlyHoldings: { 'Aug 2026': 1 }, valueCr: 100 },
] };
const book = normalisePortfolio(raw, raw.slug);
assert.equal('fetchedAt' in normalisePortfolio({ ...raw, fetchedAt: null }, raw.slug), false, 'raw normalization must not overwrite the Worker response capture time with null');
assert.equal(book.holdings[0].quarterlyStatus['Aug 2026'], 'filing_due');
assert.equal(normalisePortfolio(book, book.slug).holdings[0].quarterlyStatus['Aug 2026'], 'filing_due', 'normalization must preserve source status through caches');
const changes = deriveMoves(book, today);
assert.equal(changes.latest, 'Jun 2026'); assert.equal(changes.prior, 'Mar 2026');
assert.equal(changes.moves.find((m) => m.company === 'Increasing').deltaPp, 1);
assert.equal(changes.moves.find((m) => m.company === 'Missing').action, 'unknown');
assert.equal(changes.moves.find((m) => m.company === 'Explicit absence').action, 'exited');
assert.equal(changes.moves.find((m) => m.company === 'Awaited').action, 'awaiting');
assert.equal(changes.moves.find((m) => m.company === 'Off-cycle'), undefined);
assert.equal(summarise(book, today).disclosedCount, 1);
assert.equal(summarise(book, today).valueCr, null, 'positive holding plus zero source valuation is unavailable');
assert.equal(summarise(book, today).offCycleCount, 1);
assert.equal(comparisonPeriods({ quarters: ['Sep 2026', 'Jun 2026', 'Dec 2025'] }, today).comparable, false, 'open and non-adjacent quarters cannot be compared');
assert.equal(quarterOrder('2026-13'), null);
assert.throws(() => validateBook({ ...raw, stale: true }, raw.slug));
assert.throws(() => validateBook({ ...raw, holdings: [] }, raw.slug, raw));
assert.throws(() => validateBook({ ...raw, slug: 'someone-else' }, raw.slug));
assert.throws(() => validateBook({ ...raw, fetchedAt: '2026-01-01' }, raw.slug, raw));

const list = { investors: [{ slug: 'example', name: 'Example investor' }, { slug: 'unavailable', name: 'Unavailable investor' }] };
const previous = { books: { example: raw } }, failed = { example: { message: 'outage' }, unavailable: { message: 'outage' } };
const retained = assembleSnapshot({ list, books: {}, failed, previous, capturedAt: '2026-09-10T00:00:00Z' });
assert.equal(retained.books.example.fetchedAt, fetchedAt);
assert.equal(retained.failedCount, 2); assert.equal(retained.refreshed, 0); assert.equal(retained.covered, 1);
assert.deepEqual(retained.retained, ['example']);
const historical = retainHistory({ ...raw, quarters: ['Sep 2026', 'Jun 2026'], holdings: [raw.holdings[0]] }, raw);
assert(historical.quarters.includes('Mar 2026'));
assert.equal(historical.holdings[0].quarterlyHoldings['Mar 2026'], 3);

const report = assessCoverage({ snapshot: { ...retained, capturedAt: '2026-10-01' }, now: '2026-10-01T00:00:00Z',
  managers: { syncedAt: '2026-10-01', managers: [{ id: 'pms', name: 'PMS', kind: 'pms', asOf: '2026-07-31', statements: [{}] },
    { id: 'aif', name: 'Fund', kind: 'aif', asOf: '2026-10-01' }] } });
assert.equal(report.total, 4);
assert(report.rows[0].issues.includes('Source check overdue'), 'a fresh file cannot rejuvenate an old source check');
assert(report.rows.find((r) => r.id === 'pms').issues.includes('New manager statement needed'));
assert(report.rows.find((r) => r.id === 'aif').issues.some((s) => s.includes('underlying portfolio feed needed')));
assert.equal(report.complete, false);

const evidence = JSON.parse(readFileSync(new URL('../public/data/holding-evidence.json', import.meta.url)));
const people = withVerifiedEntities([{ id: 'madhusudan-kela', name: 'Madhusudan Kela' }], evidence, 'investor', today);
const deal = { ticker: 'TIL', date: today, cells: { 'Trade Category': 'Bulk deal', Insider: 'Singularity Equity Fund I', Transaction: 'Buy', 'Trade Shares': '100' } };
const match = matchedDeals([deal], people)[0];
assert.equal(match.reportedName, 'Singularity Equity Fund I');
assert.equal(match.personId, 'madhusudan-kela');
assert.equal(matchedDeals([{ ...deal, cells: { ...deal.cells, Insider: 'Singularity Equity Fund II' } }], people).length, 0);
assert.equal(matchedDeals([deal], [...people, { id: 'ambiguous', name: 'Singularity Equity Fund I' }]).length, 0);
const snapshot = JSON.parse(readFileSync(new URL('../public/data/super-investors.json', import.meta.url)));
for (const b of Object.values(snapshot.books)) {
  const comparison = deriveMoves(normalisePortfolio(b, b.slug), today);
  if (comparison.comparable) assert([3, 6, 9, 12].includes(quarterOrder(comparison.latest) % 100));
  assert(comparison.moves.every((m) => m.action !== 'exited' || m.nowStatus === 'not_disclosed'));
}
// Exercise the browser cache entry points: recently cached bytes may have an older source date.
const store = await import('../public/js/core/store.js');
const cacheFeed = await import('../public/js/data/super-investors.js');
const serverList = { ok: true, investors: [list.investors[0]] };
store.writeEntry(store.KEYS.investorList, { value: serverList });
store.writeEntry(store.KEYS.investorBook('example'), { value: { ...raw, fetchedAt: '2026-09-01T00:00:00Z' }, savedAt: Date.now() });
let serverSnapshot = { ...serverList, capturedAt: fetchedAt, books: { example: raw } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (path) => String(path) === 'data/super-investors.json' ? Response.json(serverSnapshot)
  : String(path) === 'api/super-investors' ? Response.json(serverList) : Response.json({ ok: false }, { status: 503 });
try {
  await cacheFeed.load();
  assert.equal(cacheFeed.book('example').fetchedAt, fetchedAt, 'a newer snapshot supersedes an older source read on the device');
  serverSnapshot = { ...serverList, capturedAt: '2026-09-10T00:00:00Z', books: {}, failed: { example: { reason: 'test-outage' } } };
  await cacheFeed.refreshSnapshot();
  assert(cacheFeed.book('example'), 'partial snapshot must not erase a cached portfolio');
  assert.equal(cacheFeed.book('example').fetchedAt, fetchedAt);
  assert.equal(cacheFeed.failureFor('example').reason, 'test-outage');
  await cacheFeed.loadBook('example', { force: true });
  assert(cacheFeed.book('example'), 'a live outage must not erase a cached portfolio');
  assert(cacheFeed.failureFor('example'), 'a failed revalidation of a retained book remains visible');
} finally { globalThis.fetch = realFetch; }
console.log('PASS holdings integrity: partial months, source states, unknown gaps, zero valuations, completed adjacent quarters, retained failures/history, source age, managers and strict legal-entity attribution');
