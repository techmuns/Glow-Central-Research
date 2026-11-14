#!/usr/bin/env node
// The shared AI-Insights runs, tested where they are decided — no server, no egress.
//
//   node scripts/verify-ai-runs.mjs
//
// The contract (data/ai-runs-shared.js), the durable store on node:sqlite exactly as the shared
// watchlist and research sheet tests run theirs, and the Worker route behind a stubbed env. The
// browser half (the client's load/write and the tab's hydrate-and-merge) is exercised by the tab in
// the app; here we prove the parts that decide what a shared run is and how one is stored and served.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  AI_RUNS_INTENT_BATCH, AI_RUNS_LIMIT, AI_RUN_BYTES, isNewerRuns, runContent, runIntent, runIntents, runKey,
} from '../public/js/data/ai-runs-shared.js';
import { AiRunsStore, AI_RUNS_OBJECT } from '../worker/ai-runs-store.mjs';
import { handleAiRuns } from '../worker/ai-runs.mjs';

let failures = 0;
let count = 0;
async function test(name, fn) {
  count++;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.stack?.split('\n').slice(0, 3).join('\n        ') || error.message}`);
  }
}

function storage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
let clock = Date.parse('2026-11-14T05:00:00.000Z');
const makeStore = () => new AiRunsStore(storage(), { now: () => (clock += 1000) });
const view = { verdict: 'Watchlist', body: 'The AI view.' };

console.log('\n— the contract —');

await test('a run is keyed by its NSE symbol, never a row key or empty', () => {
  assert.equal(runKey('sbin'), 'SBIN');
  assert.equal(runKey('BAJAJ-AUTO'), 'BAJAJ-AUTO');
  assert.equal(runKey('M&M'), 'M&M');
  assert.equal(runKey('RELIANCE|2026-08-12'), null);
  assert.equal(runKey(''), null);
});

await test('a run must carry a view; name and sector are cleaned; the editor is optional', () => {
  const r = runContent({ ticker: 'sbin', name: '  State Bank  ', sector: 'Banks\u0007', idea: view, rawText: '  text  ', by: ' Ravi ' });
  assert.deepEqual([r.key, r.name, r.sector, r.rawText, r.by], ['SBIN', 'State Bank', 'Banks', 'text', 'Ravi']);
  assert.deepEqual(r.idea, view);
  assert.equal(runContent({ ticker: 'INFY', idea: null, rawText: 'just text' }).idea, null);
  assert.equal(runContent({ ticker: 'INFY', idea: view, rawText: null }).rawText, null);
  assert.throws(() => runContent({ ticker: 'INFY' }), /no view/);
  assert.throws(() => runContent({ ticker: 'INFY', idea: null, rawText: '' }), /no view/);
  assert.throws(() => runContent({ ticker: 'not a ticker', idea: view }), /ticker/);
  assert.throws(() => runContent({ ticker: 'INFY', rawText: 'x'.repeat(AI_RUN_BYTES + 100), idea: view }), /too large/);
});

await test('an intent says what it does, and a batch cannot contradict itself', () => {
  assert.deepEqual(runIntent({ op: 'clear', key: 'sbin' }), { op: 'clear', key: 'SBIN', by: null });
  assert.equal(runIntent({ op: 'set', ticker: 'INFY', idea: view }).op, 'set');
  assert.throws(() => runIntent({ op: 'drop', key: 'INFY' }), /operation/);
  assert.throws(() => runIntent({ op: 'clear', key: 'bad ticker' }), /ticker/);
  assert.throws(() => runIntents([]), /batch/);
  assert.throws(() => runIntents(Array.from({ length: AI_RUNS_INTENT_BATCH + 1 }, (_, i) => ({ op: 'clear', key: `C${i}` }))), /batch/);
  assert.throws(() => runIntents([{ op: 'set', ticker: 'SBIN', idea: view }, { op: 'clear', key: 'SBIN' }]), /Duplicate/);
  assert.equal(runIntents([{ op: 'set', ticker: 'SBIN', idea: view }, { op: 'set', ticker: 'INFY', idea: view }]).length, 2);
});

await test('revisions order snapshots without a clock', () => {
  assert.equal(isNewerRuns({ revision: 4 }, { revision: 3 }), true);
  assert.equal(isNewerRuns({ revision: 2 }, { revision: 3 }), false);
  assert.equal(isNewerRuns({}, { revision: 3 }), true);
});

console.log('\n— the durable store —');

await test('a set stores the view with the server\'s time; an identical retry changes nothing', () => {
  const store = makeStore();
  let out = store.apply([{ op: 'set', key: 'SBIN', name: 'State Bank', sector: 'Banks', idea: view, rawText: 'text', by: 'Ravi' }]);
  assert.equal(out.outcomes[0].outcome, 'set');
  assert.equal(out.snapshot.revision, 1);
  const run = out.snapshot.runs[0];
  assert.deepEqual([run.ticker, run.name, run.sector, run.rawText, run.by], ['SBIN', 'State Bank', 'Banks', 'text', 'Ravi']);
  assert.deepEqual(run.idea, view);
  assert.ok(Date.parse(run.at) > Date.parse('2026-11-14T05:00:00Z'));
  out = store.apply([{ op: 'set', key: 'SBIN', name: 'State Bank', sector: 'Banks', idea: view, rawText: 'text', by: 'Priya' }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged');
  assert.equal(out.snapshot.revision, 1, 'an identical retry does not move the revision (so the poll stays a 304)');
  out = store.apply([{ op: 'set', key: 'SBIN', idea: { verdict: 'Buy', body: 'Re-run.' }, rawText: 'text', by: 'Priya' }]);
  assert.deepEqual([out.snapshot.revision, out.snapshot.runs[0].idea.verdict], [2, 'Buy'], 'a real re-run is a new revision');
});

await test('a cleared run is gone; clearing nothing is not an error', () => {
  const store = makeStore();
  store.apply([{ op: 'set', key: 'SBIN', idea: view }]);
  let out = store.apply([{ op: 'clear', key: 'SBIN' }]);
  assert.equal(out.outcomes[0].outcome, 'cleared');
  assert.equal(out.snapshot.runs.length, 0);
  out = store.apply([{ op: 'clear', key: 'SBIN' }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged');
});

await test('runs come back newest first, and the record is capped at the desk limit', () => {
  const store = makeStore();
  for (let start = 0; start < AI_RUNS_LIMIT + 10; start += AI_RUNS_INTENT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + AI_RUNS_INTENT_BATCH, AI_RUNS_LIMIT + 10); i++) batch.push({ op: 'set', key: `CO${i}`, idea: view });
    store.apply(batch);
  }
  const snap = store.snapshot();
  assert.equal(snap.runs.length, AI_RUNS_LIMIT, 'the oldest fall off beyond the cap');
  assert.equal(snap.runs[0].ticker, `CO${AI_RUNS_LIMIT + 9}`, 'newest first');
  assert.equal(store.rows('SELECT 1 FROM airun_rows WHERE ticker = ?', 'CO0').length, 0, 'the oldest was pruned');
});

await test('an unchanged read costs no SQL, and a rolled-back batch leaves no copy of what it undid', () => {
  const backing = storage();
  let statements = 0;
  const counted = { ...backing, sql: { exec: (...args) => { statements++; return backing.sql.exec(...args); } } };
  const store = new AiRunsStore(counted, { now: () => (clock += 1000) });
  store.apply([{ op: 'set', key: 'SBIN', idea: view }]);
  const first = store.snapshot();
  const before = statements;
  for (let i = 0; i < 50; i++) assert.equal(store.snapshot(), first);
  assert.equal(statements, before, 'fifty polls read nothing');
  assert.throws(() => { first.runs[0].idea.verdict = 'x'; }, TypeError, 'the held copy is frozen');
  const flaky = { ...backing, transactionSync: (fn) => backing.transactionSync(() => { fn(); throw new Error('commit failed'); }) };
  const fragile = new AiRunsStore(flaky, { now: () => (clock += 1000) });
  assert.equal(fragile.snapshot().runs[0].ticker, 'SBIN');
  assert.throws(() => fragile.apply([{ op: 'set', key: 'INFY', idea: view }]), /commit failed/);
  assert.equal(fragile.snapshot().runs.length, 1, 'the rolled-back run is not served');
});

console.log('\n— the Worker route —');

function runsEnv({ limited = false, broken = false } = {}) {
  const store = makeStore();
  return {
    CAPTURE_REGISTRY: {
      getByName: (name) => {
        assert.equal(name, AI_RUNS_OBJECT);
        return {
          aiRunsSnapshot: async () => { if (broken) throw new Error('object down'); return store.snapshot(); },
          aiRunsApply: async (intents) => { if (broken) throw new Error('object down'); return store.apply(intents); },
        };
      },
    },
    SHARED_WATCHLIST_LIMITER: { limit: async ({ key }) => { assert.match(key, /^ai-runs:/); return { success: !limited }; } },
  };
}
const origin = 'https://glow.example';
const post = (body, headers = {}) => new Request(`${origin}/api/ai-runs`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
});

await test('GET answers the runs privately with an ETag, and a matching tag is a bodyless 304', async () => {
  const env = runsEnv();
  const first = await handleAiRuns(new Request(`${origin}/api/ai-runs`), env);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /private/);
  const body = await first.json();
  assert.deepEqual([body.ok, body.runs], [true, []]);
  const again = await handleAiRuns(new Request(`${origin}/api/ai-runs`, { headers: { 'if-none-match': first.headers.get('etag') } }), env);
  assert.equal(again.status, 304);
});

await test('POST applies same-origin runs and answers with the record as it now stands', async () => {
  const env = runsEnv();
  const res = await handleAiRuns(post({ intents: [{ op: 'set', key: 'SBIN', name: 'State Bank', idea: view, by: 'Ravi' }] }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.runs[0].ticker, body.outcomes[0].outcome], ['SBIN', 'set']);
});

await test('a write from another site, a wrong type, a bad batch or a burst is refused by name', async () => {
  const env = runsEnv();
  assert.equal((await handleAiRuns(post({ intents: [{ op: 'clear', key: 'SBIN' }] }, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await handleAiRuns(post({ intents: [{ op: 'clear', key: 'SBIN' }] }, { 'sec-fetch-site': 'cross-site' }), env)).status, 403);
  assert.equal((await handleAiRuns(post('x', { 'content-type': 'text/plain' }), env)).status, 415);
  const bad = await handleAiRuns(post({ intents: [{ op: 'set', key: 'bad ticker', idea: view }] }), env);
  assert.deepEqual([bad.status, (await bad.json()).reason], [400, 'invalid-request']);
  assert.equal((await handleAiRuns(post({ intents: [{ op: 'clear', key: 'SBIN' }] }), runsEnv({ limited: true }))).status, 429);
  assert.equal((await handleAiRuns(new Request(`${origin}/api/ai-runs`, { method: 'DELETE' }), env)).status, 405);
});

await test('a run POSTed by one request is served to the next GET — the desk round-trip', async () => {
  const env = runsEnv();
  await handleAiRuns(post({ intents: [{ op: 'set', key: 'TCS', name: 'TCS', idea: view, rawText: 'text' }] }), env);
  const res = await handleAiRuns(new Request(`${origin}/api/ai-runs`), env);
  const body = await res.json();
  assert.equal(body.runs.length, 1, 'the run one device wrote is the run another device reads');
  assert.deepEqual([body.runs[0].ticker, body.runs[0].idea.verdict, body.runs[0].rawText], ['TCS', 'Watchlist', 'text']);
});

await test('a failed object is a named failure, never an empty record', async () => {
  const res = await handleAiRuns(new Request(`${origin}/api/ai-runs`), runsEnv({ broken: true }));
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual([body.ok, body.runs], [false, undefined], 'no runs key at all, so it cannot be painted as nothing run');
  assert.equal((await handleAiRuns(new Request(`${origin}/api/ai-runs`), {})).status, 503);
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);
