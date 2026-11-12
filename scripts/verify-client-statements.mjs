#!/usr/bin/env node
// scripts/verify-client-statements.mjs — the client-statement overlay, offline. GLOW-OWNED.
//
//   node scripts/verify-client-statements.mjs
//
// Holds scripts/lib/client-statements.mjs to its rules on constructed books (applied, idempotent,
// superseded by a newer upstream statement, refused on a transcription slip, refused for an unknown
// account), then checks the committed fixture and the committed book and managers files agree.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyToBook, applyToManagers, statementProblems } from './lib/client-statements.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const fixture = read('scripts/fixtures/client-statements.json');
const sky = fixture.statements.find((s) => s.accountId === 'sky-capital-rising-titans-fund-SKY003');

// ---- a constructed upstream: the Sky folio at cost, as GlowVentures carried it on 31 August ----
const upstreamBook = () => ({
  asOf: '2026-11-04',
  summary: { totalValue: 27150000, listedValue: 10000000, privateValue: 17150000, positionsCount: 2 },
  accounts: [
    { accountId: 'sky-capital-rising-titans-fund-SKY003', provider: 'Sky Capital Rising Titans Fund', ownerId: 'o1', owner: 'Owner', engagement: 'AIF', asOf: '2026-08-31' },
    { accountId: 'demat-1', provider: 'Broker', ownerId: 'o1', owner: 'Owner', engagement: 'Direct', asOf: '2026-11-04' },
  ],
  positions: [
    { securityKey: 'listed', security: 'Listed Co', accountId: 'demat-1', assetClass: 'Equity', marketValue: 10000000, marketSide: 'listed', dedupeGroup: null },
    { securityKey: 'sky-capital-rising-titans-fund-i', security: 'Sky Capital Rising Titans Fund I', accountId: 'sky-capital-rising-titans-fund-SKY003', assetClass: 'AIF', sector: 'Unclassified', quantity: 17000, marketValue: 17150000, costBasis: 17150000, marketSide: 'private', valuedAtCost: true, dedupeGroup: null, accountAsOf: '2026-08-31' },
  ],
});
const upstreamManagers = () => ({
  summary: { bookValue: 27150000, managedValue: 17150000, byKind: { pms: { marketValue: 0, positions: 0 }, aif: { marketValue: 17150000, positions: 1 }, mf: { marketValue: 0, positions: 0 } }, direct: { marketValue: 10000000 } },
  managers: [{ id: 'sky', kind: 'aif', name: 'Sky Capital Rising Titans Fund', accounts: [{ accountId: 'sky-capital-rising-titans-fund-SKY003', owner: 'Owner', ownerId: 'o1', provider: 'Sky Capital Rising Titans Fund', asOf: '2026-08-31' }],
    asOf: '2026-08-31', value: { marketValue: 17150000 }, positions: [{ securityKey: 'sky-capital-rising-titans-fund-i', accountId: 'sky-capital-rising-titans-fund-SKY003', marketValue: 17150000, costBasis: 17150000 }],
    returns: [], commitments: [{ accountId: 'sky-capital-rising-titans-fund-SKY003', committed: 17285000, drawn: 17285000, calls: [] }] }],
});

console.log('client statements — the rules');
check('the committed fixture transcribes cleanly (units, NAV × units, drawdowns, performance)', () => assert.deepEqual(fixture.statements.flatMap(statementProblems), []));
check('the fixture carries no personal identifiers', () => {
  const text = JSON.stringify(fixture.statements);
  for (const bad of [/[A-Z]{5}\d{4}[A-Z]/, /IFSC|HDFC0|PAN\b|Client ID|DP ID|@|\+91|\b\d{10,}\b|Nominee|Prabhadevi/i]) assert.ok(!bad.test(text), `fixture matches ${bad}`);
});

check('a newer statement replaces the account rows with one row per unit series, as printed', () => {
  const b = upstreamBook();
  const { report } = applyToBook(b, [sky]);
  assert.equal(report[0].status, 'applied');
  const rows = b.positions.filter((p) => p.accountId === sky.accountId);
  assert.deepEqual(rows.map((p) => [p.security, p.isin, p.quantity, p.marketValue, p.costBasis, p.currentPrice, p.returnPct]), [
    ['Sky Capital Rising Titans Fund – Hudle', 'INF1V9N22019', 17000, 30006348, 17000000, 1765.08, 76.51],
    ['Sky Capital Rising Titans Fund – TED', 'INF1V9N22043', 285, 281886, 285000, 989.07, null],
  ]);
  assert.ok(rows.every((p) => p.accountAsOf === '2026-09-30' && !p.valuedAtCost && p.clientStatement === sky.id));
  assert.equal(rows[0].heldSince, '2025-05-09');
  assert.equal(rows[1].unrealizedPnL, -3114);
});

check('the headline, the private side and the position count move by exactly the difference', () => {
  const b = upstreamBook();
  applyToBook(b, [sky]);
  assert.equal(b.summary.totalValue, 10000000 + 30006348 + 281886);
  assert.equal(b.summary.privateValue, 30006348 + 281886);
  assert.equal(b.summary.listedValue, 10000000);
  assert.equal(b.summary.positionsCount, 3);
  assert.equal(b.accounts[0].asOf, '2026-09-30');
  assert.equal(b.accounts[0].upstreamAsOf, '2026-08-31');
  assert.equal(b.asOf, '2026-11-04', 'the book date is the newest statement, and is not moved backwards');
});

check('it is idempotent: a second run changes nothing', () => {
  const b = upstreamBook();
  applyToBook(b, [sky]);
  const once = JSON.stringify(b);
  applyToBook(b, [sky]);
  assert.equal(JSON.stringify(b), once);
});

check('an upstream statement of the same or a later date supersedes it, untouched', () => {
  for (const asOf of ['2026-09-30', '2026-10-31']) {
    const b = upstreamBook();
    b.accounts[0].asOf = asOf;
    const before = JSON.stringify(b.positions);
    const { report } = applyToBook(b, [sky]);
    assert.equal(report[0].status, 'superseded');
    assert.equal(JSON.stringify(b.positions), before);
    assert.equal(b.summary.totalValue, 27150000);
  }
});

check('a transcription slip refuses the run', () => {
  const bad = clone(sky);
  bad.series[0].value = 30060348; // two digits swapped
  assert.throws(() => applyToBook(upstreamBook(), [bad]), /not the printed/);
  const short = clone(sky);
  short.commitment.drawdowns.pop();
  assert.throws(() => applyToBook(upstreamBook(), [short]), /drawdowns add to/);
});

check('a statement for an account the book has never seen is refused', () => {
  const stray = { ...clone(sky), accountId: 'nowhere' };
  assert.throws(() => applyToBook(upstreamBook(), [stray]), /not in book\.json/);
});

check('managers.json moves with the book and still reconciles', () => {
  const b = upstreamBook();
  const { report } = applyToBook(b, [sky]);
  const m = upstreamManagers();
  applyToManagers(m, b, [sky], report);
  const fund = m.managers[0];
  assert.equal(fund.value.marketValue, 30288234);
  assert.equal(fund.value.costBasis, 17285000);
  assert.equal(fund.asOf, '2026-09-30');
  assert.equal(fund.positions.length, 2);
  assert.equal(m.summary.managedValue + m.summary.direct.marketValue, b.summary.totalValue);
  assert.equal(fund.commitments[0].calls.length, 6);
  assert.equal(fund.returns.at(-1).series[0].si, 76.51);
  const once = JSON.stringify(m);
  applyToManagers(m, b, [sky], report);
  assert.equal(JSON.stringify(m), once, 'idempotent');
});

console.log('client statements — the committed files');
const book = read('public/data/book.json');
const managers = read('public/data/managers.json');
check('book.json carries the Sky Capital statement of 30 September 2026', () => {
  const rows = book.positions.filter((p) => p.accountId === sky.accountId);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, p) => s + p.marketValue, 0), 30288234);
  assert.equal(book.accounts.find((a) => a.accountId === sky.accountId).asOf, '2026-09-30');
  assert.equal(book.clientStatements.find((c) => c.id === sky.id)?.status, 'applied');
});
check('managers.json agrees with it', () => {
  const fund = managers.managers.find((m) => m.accounts.some((a) => a.accountId === sky.accountId));
  assert.equal(fund.positions.filter((p) => p.accountId === sky.accountId).reduce((s, p) => s + p.marketValue, 0), 30288234);
  assert.equal(Math.round((managers.summary.managedValue + managers.summary.direct.marketValue) * 100), Math.round(book.summary.totalValue * 100));
  assert.equal(managers.summary.bookValue, book.summary.totalValue);
});

console.log(`\n${passed} checks passed`);
