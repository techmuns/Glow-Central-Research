// verify-framework.mjs — the Framework scoring feature, offline. GLOW-OWNED.
//
// Covers the shared contract (data/framework-shared.js), the durable store on node:sqlite exactly as
// the Worker runs it (worker/framework-store.mjs), the rows + ranking math (data/framework-rows.js),
// and the built data file (public/data/framework.json). No server, no browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  frameworkKey, isField, fieldValue, frameworkIntent, frameworkIntents, isNewerFramework,
} from '../public/js/data/framework-shared.js';
import { FrameworkStore } from '../worker/framework-store.mjs';
import { frameworkRows, rankRows, maxScore } from '../public/js/data/framework-rows.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  PASS', msg); pass++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); console.log('  PASS', msg); pass++; };

// ---- contract ----------------------------------------------------------------------------------
console.log('— contract —');
eq(frameworkKey('TIPSMUSIC'), 'TIPSMUSIC', 'a ticker is its own key');
eq(frameworkKey('name:waaree-renewab'), 'name:waaree-renewab', 'a name:slug key is kept');
eq(frameworkKey('not a ticker!!'), null, 'a bad key is refused');
ok(isField('score:business-quality') && isField('why:growth-runway') && isField('gate') && isField('industry'), 'valid field ids pass');
ok(!isField('bogus:x') && !isField('score:') && !isField('score:Bad Caps'), 'invalid field ids are refused');
eq(fieldValue('score:x', 2), 2, 'a score of 2 is accepted');
assert.throws(() => fieldValue('score:x', 3), 'a score of 3 is refused'); console.log('  PASS a score of 3 is refused'); pass++;
assert.throws(() => fieldValue('score:x', 1.5), 'a non-integer score is refused'); console.log('  PASS a non-integer score is refused'); pass++;
eq(fieldValue('gate', 'Pass'), 'pass', 'the gate normalises to pass/fail');
assert.throws(() => fieldValue('gate', 'maybe'), 'an invalid gate is refused'); console.log('  PASS an invalid gate is refused'); pass++;
eq(frameworkIntent({ op: 'set', key: 'ABC', field: 'score:q', value: 1, by: 'Ravi' }), { op: 'set', key: 'ABC', field: 'score:q', value: 1, by: 'Ravi' }, 'a set intent parses');
eq(frameworkIntent({ op: 'clear', key: 'ABC', field: 'gate' }).by, null, 'an unattributed clear is allowed');
assert.throws(() => frameworkIntents([{ op: 'set', key: 'X', field: 'gate', value: 'pass' }, { op: 'set', key: 'X', field: 'gate', value: 'fail' }]), 'a self-contradictory batch is refused'); console.log('  PASS a self-contradictory batch is refused'); pass++;
ok(isNewerFramework({ revision: 3 }, { revision: 2 }) && !isNewerFramework({ revision: 1 }, { revision: 2 }), 'revision ordering works');

// ---- store (node:sqlite, as the Worker runs it) ------------------------------------------------
console.log('— store —');
const storage = () => {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
};
let clock = 0;
const store = new FrameworkStore(storage(), { now: () => (clock += 1000) });
eq(store.snapshot().values, {}, 'a fresh store is empty (not an error)');
let r = store.apply([{ op: 'set', key: 'TIPSMUSIC', field: 'score:business-quality', value: 2, by: 'Ravi' }]);
eq(r.outcomes[0].outcome, 'set', 'a first score is set');
eq(r.snapshot.values.TIPSMUSIC['score:business-quality'].value, 2, 'the score is stored');
eq(r.snapshot.values.TIPSMUSIC['score:business-quality'].by, 'Ravi', 'the author is stored');
ok(r.snapshot.revision === 1 && r.snapshot.updatedAt, 'the revision and timestamp move on a change');
const rev1 = r.snapshot.revision;
r = store.apply([{ op: 'set', key: 'TIPSMUSIC', field: 'score:business-quality', value: 2, by: 'Ravi' }]);
ok(r.outcomes[0].outcome === 'unchanged' && r.snapshot.revision === rev1, 're-typing the same score changes nothing');
r = store.apply([{ op: 'set', key: 'TIPSMUSIC', field: 'gate', value: 'fail', by: 'Asha' }]);
eq(r.snapshot.values.TIPSMUSIC.gate.value, 'fail', 'a different field on the same company is added');
r = store.apply([{ op: 'clear', key: 'TIPSMUSIC', field: 'score:business-quality' }]);
ok(r.outcomes[0].outcome === 'cleared' && !r.snapshot.values.TIPSMUSIC['score:business-quality'], 'a cleared cell is removed');
r = store.apply([{ op: 'clear', key: 'TIPSMUSIC', field: 'score:business-quality' }]);
eq(r.outcomes[0].outcome, 'unchanged', 'clearing an absent cell is not a change');
// a failed transaction leaves the held snapshot intact (never a copy of what it undid)
const backing = storage();
const good = new FrameworkStore(backing, { now: () => (clock += 1000) });
good.apply([{ op: 'set', key: 'AAA', field: 'gate', value: 'pass' }]);
const before = good.snapshot();
const flaky = new FrameworkStore({ ...backing, transactionSync: (fn) => backing.transactionSync(() => { fn(); throw new Error('commit failed'); }) }, { now: () => (clock += 1000) });
assert.throws(() => flaky.apply([{ op: 'set', key: 'BBB', field: 'gate', value: 'fail' }]));
eq(new FrameworkStore(backing).snapshot().values, before.values, 'a rolled-back edit leaves the record as it was');

// ---- rows + ranking ----------------------------------------------------------------------------
console.log('— rows + ranking —');
const framework = {
  criteria: [
    { key: 'bq', label: 'Business quality' }, { key: 'df', label: 'Differentiation' },
    { key: 'gr', label: 'Growth runway' }, { key: 'ca', label: 'Catalyst' }, { key: 'em', label: 'Earnings' },
  ],
  gate: { key: 'governance', label: 'Governance', type: 'Pass/Fail' },
  companies: [
    { key: 'AAA', name: 'Alpha' }, { key: 'BBB', name: 'Bravo' }, { key: 'CCC', name: 'Charlie' }, { key: 'DDD', name: 'Delta' },
  ],
};
const values = {
  AAA: { 'score:bq': 2, 'score:df': 2, 'score:gr': 2, 'score:ca': 2, 'score:em': 2 }, // 10, untouched gate
  BBB: { 'score:bq': 2, 'score:df': 2, gate: 'fail' }, // 4 but governance FAIL
  CCC: { 'score:bq': 1 }, // 1, one scored
  // DDD: nothing — not started
};
const record = { valueFor: (k, f) => (values[k]?.[f] ?? null) };
eq(maxScore(framework), 10, 'max score is criteria × 2, read from the rubric');
const rows = rankRows(frameworkRows(framework, record));
const byKey = Object.fromEntries(rows.map((r2) => [r2.key, r2]));
eq(byKey.AAA.total, 10, 'a fully-scored company totals its scores');
eq(byKey.CCC.total, 1, 'a partly-scored company totals only what was entered');
eq(byKey.CCC.scoredCount, 1, 'the scored-count reflects entered criteria only');
eq(byKey.DDD.total, 0, 'an unscored company totals zero but is not ranked');
eq(byKey.DDD.rank, null, 'an untouched company gets no rank');
eq(byKey.AAA.rank, 1, 'the top scorer ranks first');
ok(rows[rows.length - 1].key === 'BBB', 'a governance FAIL sorts last whatever its total');
eq(byKey.BBB.rank, null, 'a governance fail is not given a passing rank');

// ---- the built data file -----------------------------------------------------------------------
console.log('— built data file —');
const data = JSON.parse(readFileSync(resolve(here, '../public/data/framework.json'), 'utf8'));
eq(data.criteria.length, 5, 'framework.json carries the five criteria');
ok(data.gate && /pass\/fail/i.test(data.gate.type), 'it carries the Governance Pass/Fail gate');
eq(data.maxScore, 10, 'its max score is 10');
ok(data.companies.length > 300, `it carries the company list (${data.companies.length})`);
ok(data.companies.every((c) => c.key && c.name), 'every company has a stable key and a name');
ok(new Set(data.companies.map((c) => c.key)).size === data.companies.length, 'every company key is unique');
ok(data.companies.some((c) => c.ticker) && data.companies.some((c) => !c.ticker && c.reason), 'some resolve to a ticker; the rest state why not');

console.log(`\n${pass} checks passed`);
