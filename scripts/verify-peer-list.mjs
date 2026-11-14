#!/usr/bin/env node
// The shared peer / competitor map (#312), tested where it is decided: the pure contract and the
// durable store. Run with `node scripts/verify-peer-list.mjs`. Needs no server and no egress — the
// store runs against node:sqlite exactly as the shared watchlist's does, so the conflict, capacity
// and tombstone branches are exercised directly rather than waited for in a browser.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  PEER_PER_COMPANY_LIMIT, PEER_COMPANY_LIMIT, PEER_INTENT_BATCH, PEER_TOMBSTONE_LIMIT,
  companyName, isNewerPeerList, isSymbolShaped, peerEntry, peerIntent, peerIntents, peerLinkKey,
} from '../public/js/data/peer-list-shared.js';
import { SharedPeerListStore } from '../worker/peer-list-store.mjs';

let failures = 0;
let count = 0;
function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function storage() {
  const db = new DatabaseSync(':memory:');
  return {
    // Eager, exactly as the Workers runtime is: a lazy shim would never run a CREATE TABLE,
    // because nothing calls toArray() on one.
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

let clock = Date.parse('2026-11-14T09:00:00.000Z');
const makeStore = () => new SharedPeerListStore(storage(), { now: () => (clock += 1000) });
const peersOf = (snapshot, company) => snapshot.links.filter((l) => l.company === company).map((l) => l.peer);

console.log('\n— the contract —');

test('an edit validates both companies as symbols and keeps the name as typed', () => {
  const add = peerIntent({ op: 'add', company: 'tataelxsi', peer: 'kpittech', name: 'KPIT Technologies Ltd.' });
  assert.deepEqual(add, { op: 'add', company: 'TATAELXSI', peer: 'KPITTECH', name: 'KPIT Technologies Ltd.' });
  assert.ok(isSymbolShaped('20MICRONS') && isSymbolShaped('500325'));
});

test('a company is never its own peer', () => {
  assert.throws(() => peerIntent({ op: 'add', company: 'INFY', peer: 'infy' }), /its own peer/);
});

test('a row key is not a company, and an unknown op is refused', () => {
  assert.throws(() => peerIntent({ op: 'add', company: 'RELIANCE|2026-08-12|3', peer: 'INFY' }), /company/);
  assert.throws(() => peerIntent({ op: 'add', company: 'INFY', peer: 'A B' }), /peer/);
  assert.throws(() => peerIntent({ op: 'replace', company: 'INFY', peer: 'WIPRO' }), /operation/);
});

test('a company name is never invented from the ticker', () => {
  assert.equal(companyName(''), null);
  assert.equal(companyName(null), null);
  assert.equal(peerEntry({ peer: 'wipro' }).name, null);
});

test('two edits to one link in one batch are refused rather than ordered by arrival', () => {
  assert.throws(() => peerIntents([
    { op: 'add', company: 'INFY', peer: 'WIPRO' },
    { op: 'remove', company: 'INFY', peer: 'wipro' },
  ]), /Duplicate/);
  // Two edits to the SAME company but DIFFERENT peers are fine — they do not collide.
  assert.equal(peerIntents([
    { op: 'add', company: 'INFY', peer: 'WIPRO' },
    { op: 'add', company: 'INFY', peer: 'TCS' },
  ]).length, 2);
});

test('an empty or oversized batch is refused', () => {
  assert.throws(() => peerIntents([]), /batch/);
  assert.throws(() => peerIntents(Array.from({ length: PEER_INTENT_BATCH + 1 }, (_, i) => ({ op: 'add', company: 'INFY', peer: `P${i}` }))), /batch/);
});

test('an unnumbered snapshot cannot be ordered and is taken as given', () => {
  assert.equal(isNewerPeerList({ revision: 4 }, { revision: 3 }), true);
  assert.equal(isNewerPeerList({ revision: 2 }, { revision: 3 }), false);
  assert.equal(isNewerPeerList({}, { revision: 3 }), true);
});

console.log('\n— the shared store —');

test('an add is readable by everyone, stamped by the server', () => {
  const store = makeStore();
  const { outcomes, snapshot } = store.peerListApply([{ op: 'add', company: 'tataelxsi', peer: 'kpittech', name: 'KPIT Technologies Ltd.' }]);
  assert.equal(outcomes[0].outcome, 'added');
  assert.equal(snapshot.links.length, 1);
  assert.deepEqual(
    { company: snapshot.links[0].company, peer: snapshot.links[0].peer, name: snapshot.links[0].name },
    { company: 'TATAELXSI', peer: 'KPITTECH', name: 'KPIT Technologies Ltd.' },
  );
  assert.ok(snapshot.links[0].addedAt, 'the server stamps when it accepted the edit');
  assert.equal(snapshot.perCompanyLimit, PEER_PER_COMPANY_LIMIT);
});

test('re-adding an active peer is unchanged, but a late name still lands', () => {
  const store = makeStore();
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  const again = store.peerListApply([{ op: 'add', company: 'INFY', peer: 'wipro', name: 'Wipro Ltd.' }]);
  assert.equal(again.outcomes[0].outcome, 'unchanged');
  assert.equal(again.snapshot.links[0].name, 'Wipro Ltd.', 'a name arriving for a link that had none is kept');
});

test('a removal is a record, so the link leaves and the revision moves', () => {
  const store = makeStore();
  const first = store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  const second = store.peerListApply([{ op: 'remove', company: 'INFY', peer: 'WIPRO' }]);
  assert.equal(second.outcomes[0].outcome, 'removed');
  assert.equal(second.snapshot.links.length, 0);
  assert.ok(second.snapshot.revision > first.snapshot.revision);
});

test('removing a link that is not there is unchanged and does not move the revision', () => {
  const store = makeStore();
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  const before = store.peerListSnapshot().revision;
  const { outcomes } = store.peerListApply([{ op: 'remove', company: 'INFY', peer: 'TCS' }]);
  assert.equal(outcomes[0].outcome, 'unchanged');
  assert.equal(store.peerListSnapshot().revision, before);
});

test('remove then add reactivates the same link', () => {
  const store = makeStore();
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO', name: 'Wipro Ltd.' }]);
  store.peerListApply([{ op: 'remove', company: 'INFY', peer: 'WIPRO' }]);
  const { outcomes, snapshot } = store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  assert.equal(outcomes[0].outcome, 'added');
  assert.deepEqual(peersOf(snapshot, 'INFY'), ['WIPRO']);
});

test('one device removing a peer does not lose one another device just added', () => {
  const store = makeStore();
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  store.peerListApply([{ op: 'remove', company: 'INFY', peer: 'WIPRO' }]);
  const { snapshot } = store.peerListApply([{ op: 'add', company: 'INFY', peer: 'TCS', name: 'TCS Ltd.' }]);
  assert.deepEqual(peersOf(snapshot, 'INFY'), ['TCS'], 'the intent applies to the list as it now stands');
});

test('the newest peer of a company reads first', () => {
  const store = makeStore();
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'WIPRO' }]);
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'TCS' }]);
  assert.deepEqual(peersOf(store.peerListSnapshot(), 'INFY'), ['TCS', 'WIPRO']);
});

test("a peer refused for a company's capacity is reported full, never as added", () => {
  const store = makeStore();
  for (let i = 0; i < PEER_PER_COMPANY_LIMIT; i++) store.peerListApply([{ op: 'add', company: 'INFY', peer: `P${i}` }]);
  const { outcomes, snapshot } = store.peerListApply([{ op: 'add', company: 'INFY', peer: 'OVERFLOW' }]);
  assert.equal(outcomes[0].outcome, 'full');
  assert.equal(peersOf(snapshot, 'INFY').length, PEER_PER_COMPANY_LIMIT);
  assert.ok(!peersOf(snapshot, 'INFY').includes('OVERFLOW'));
});

test("the per-company cap frees up when a peer is removed", () => {
  const store = makeStore();
  for (let i = 0; i < PEER_PER_COMPANY_LIMIT; i++) store.peerListApply([{ op: 'add', company: 'INFY', peer: `P${i}` }]);
  store.peerListApply([{ op: 'remove', company: 'INFY', peer: 'P0' }]);
  assert.equal(store.peerListApply([{ op: 'add', company: 'INFY', peer: 'ROOM' }]).outcomes[0].outcome, 'added');
});

test('the company ceiling bites a NEW company, never an existing one gaining another peer', () => {
  const store = makeStore();
  // Fill every company slot with one peer each, in batches to stay inside PEER_INTENT_BATCH.
  for (let i = 0; i < PEER_COMPANY_LIMIT; i += PEER_INTENT_BATCH) {
    const batch = [];
    for (let j = i; j < Math.min(i + PEER_INTENT_BATCH, PEER_COMPANY_LIMIT); j++) {
      batch.push({ op: 'add', company: `C${j}`, peer: 'RIVAL' });
    }
    store.peerListApply(batch);
  }
  // A brand-new company cannot enrol.
  assert.equal(store.peerListApply([{ op: 'add', company: 'NEWONE', peer: 'RIVAL' }]).outcomes[0].outcome, 'full');
  // A company already on the map gains a second peer regardless of the company ceiling.
  assert.equal(store.peerListApply([{ op: 'add', company: 'C0', peer: 'SECOND' }]).outcomes[0].outcome, 'added');
});

test('tombstones are bounded and bounding them does not disturb the live map', () => {
  const store = makeStore();
  for (let i = 0; i < PEER_TOMBSTONE_LIMIT + 10; i++) {
    store.peerListApply([{ op: 'add', company: 'INFY', peer: `X${i}` }]);
    store.peerListApply([{ op: 'remove', company: 'INFY', peer: `X${i}` }]);
  }
  store.peerListApply([{ op: 'add', company: 'INFY', peer: 'LIVE' }]);
  assert.deepEqual(peersOf(store.peerListSnapshot(), 'INFY'), ['LIVE']);
});

test('an invalid batch writes nothing', () => {
  const store = makeStore();
  assert.throws(() => store.peerListApply([{ op: 'add', company: 'INFY', peer: 'INFY' }]), /its own peer/);
  assert.equal(store.peerListSnapshot().count, 0);
});

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${count - failures}/${count} checks\n`);
process.exit(failures ? 1 : 0);
