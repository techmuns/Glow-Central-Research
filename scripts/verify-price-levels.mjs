#!/usr/bin/env node
// The family's price levels, tested where each part is decided: the pure contract, the durable
// store, the minute check against a recorded Upstox answer, the route another site calls, the alert
// row All Alerts shows and how AI Alerts ranks it.
//
// Run with `node scripts/verify-price-levels.mjs`. Needs no server and no egress — the store runs on
// node:sqlite exactly as the shared watchlist's does, the Upstox call is a stub that records what it
// was asked, and the clock is set, so every branch is exercised directly rather than waited for.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  PRICE_LEVEL, PRICE_LEVEL_NAMES, PRICE_LEVELS_INTENT_BATCH, PRICE_LEVELS_HIT_LIMIT, PRICE_LEVELS_OBJECT,
  priceLevelIntent, priceLevelIntents, levelReached, levelHit, hitId,
} from '../public/js/data/price-levels-shared.js';
import { PriceLevelStore } from '../worker/price-levels-store.mjs';
import {
  PriceLevelSchedule, PRICE_LEVEL_TIMER, PRICE_LEVEL_INTERVAL, PRICE_LEVEL_IDLE_INTERVAL, levelQuotes, fetchLevelQuotes,
} from '../worker/price-levels-schedule.mjs';
import { handlePriceLevels } from '../worker/price-levels.mjs';

let failures = 0;
let count = 0;
async function test(name, fn) {
  count++;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function storage() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  let alarm = null;
  const value = {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) {
      db.exec('BEGIN');
      try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get: async (k) => structuredClone(kv.get(k)),
    put: async (k, v) => { kv.set(k, structuredClone(v)); },
    getAlarm: async () => alarm,
    setAlarm: async (v) => { alarm = v; },
    deleteAlarm: async () => { alarm = null; },
  };
  value.transaction = async (fn) => fn(value);
  return value;
}

// A trading Wednesday. 11:00 IST is 05:30 UTC; the session opened at 09:15 IST.
const DAY = '2026-09-23';
const OPEN = Date.parse(`${DAY}T09:15:00+05:30`);
const AT = Date.parse(`${DAY}T11:00:00+05:30`);
const EVENING = Date.parse(`${DAY}T20:00:00+05:30`);
const SUNDAY = Date.parse('2026-09-27T11:00:00+05:30');
let clock = AT;
const now = () => clock;
const makeStore = () => new PriceLevelStore(storage(), { now });

const levels = (over = {}) => ({ buyAt: null, sellAt: null, stopLoss: null, target: null, alertAbove: null, ...over });
const set = (ticker, over, extra = {}) => ({ op: 'set', ticker, isin: 'INE000000001', name: `${ticker} Ltd`, levels: levels(over), ...extra });
const quote = (price, extra = {}) => ({ price, high: price, low: price, sessionDate: DAY, quoteAt: new Date(AT - 30000).toISOString(), ...extra });

console.log('\n— the contract —');

await test('five levels, each firing the way an investor means it', () => {
  assert.deepEqual(PRICE_LEVEL_NAMES, ['buyAt', 'sellAt', 'stopLoss', 'target', 'alertAbove']);
  assert.deepEqual(PRICE_LEVEL_NAMES.map((n) => PRICE_LEVEL[n].direction), ['down', 'up', 'down', 'up', 'up']);
  // The same words Glow Ventures prints, so the family reads one sentence in both places.
  assert.equal(PRICE_LEVEL.stopLoss.reached, 'Stop loss hit');
  assert.equal(PRICE_LEVEL.target.reached, 'Target reached');
  assert.equal(PRICE_LEVEL.buyAt.reached, 'Buy level reached');
});

await test('reached is inclusive, and nothing that is not a price reaches anything', () => {
  assert.equal(levelReached('up', 100, 100), true);
  assert.equal(levelReached('down', 100, 100), true);
  assert.equal(levelReached('up', 100, 99.99), false);
  assert.equal(levelReached('down', 100, 100.01), false);
  for (const bad of [null, undefined, NaN, 0, -5]) assert.equal(levelReached('down', 100, bad), false, String(bad));
});

await test('a malformed level is refused, never read as unset', () => {
  for (const bad of ['abc', '120', 0, -1, NaN, Infinity, 1e8, {}, []]) {
    assert.throws(() => priceLevelIntent(set('ABC', { target: bad })), /Invalid price level/, String(bad));
  }
  assert.throws(() => priceLevelIntent({ ...set('ABC', { target: 10 }), levels: { target: 10, targetPrice: 12 } }), /name/);
  assert.throws(() => priceLevelIntent(set('ABC', {})), /none set/, 'a set with nothing in it is a clear spelt wrongly');
});

await test('a company is a ticker, and an ISIN must look like one', () => {
  assert.throws(() => priceLevelIntent(set('A B', { target: 10 })), /company/);
  assert.throws(() => priceLevelIntent(set('RELIANCE|2026', { target: 10 })), /company/);
  assert.throws(() => priceLevelIntent(set('ABC', { target: 10 }, { isin: 'US0378331005' })), /ISIN/);
  assert.equal(priceLevelIntent(set('abc', { target: 10 }, { isin: ' ine000000001 ' })).isin, 'INE000000001');
  assert.equal(priceLevelIntent(set('ABC', { target: 10 }, { isin: null })).isin, null);
  assert.deepEqual(priceLevelIntent({ op: 'clear', ticker: 'abc', levels: 'ignored' }), { op: 'clear', ticker: 'ABC' });
});

await test('a batch is bounded and cannot name a company twice', () => {
  assert.throws(() => priceLevelIntents([]), /batch/);
  assert.throws(() => priceLevelIntents(Array.from({ length: PRICE_LEVELS_INTENT_BATCH + 1 }, (_, i) => set(`C${i}X`, { target: 1 }))), /batch/);
  assert.throws(() => priceLevelIntents([set('ABC', { target: 1 }), { op: 'clear', ticker: 'ABC' }]), /Duplicate/);
});

await test('the day\'s range counts only for a level that existed before the session opened', () => {
  const q = quote(95, { high: 112, low: 90 });
  const before = new Date(OPEN - 3600000).toISOString();
  const after = new Date(OPEN + 3600000).toISOString();
  assert.deepEqual(levelHit({ direction: 'up', value: 110, setAt: before }, q), { price: 112, basis: 'day-high' });
  assert.equal(levelHit({ direction: 'up', value: 110, setAt: after }, q), null,
    'a level set at 10:15 must not fire on a high the market made before it existed');
  assert.deepEqual(levelHit({ direction: 'down', value: 91, setAt: before }, q), { price: 90, basis: 'day-low' });
  assert.deepEqual(levelHit({ direction: 'down', value: 96, setAt: after }, q), { price: 95, basis: 'last-price' },
    'the last traded price always counts');
  assert.equal(levelHit({ direction: 'up', value: 110, setAt: before }, { ...q, high: null }), null, 'an absent high is not a high');
});

console.log('\n— the shared store —');

await test('a set is kept, stamped by the Worker, and readable as a list', () => {
  const store = makeStore();
  const { outcomes, snapshot } = store.apply([set('ABC', { target: 120, stopLoss: 80 })]);
  assert.deepEqual(outcomes, [{ ticker: 'ABC', op: 'set', outcome: 'set' }]);
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.pending, 2);
  const c = snapshot.companies[0];
  assert.deepEqual({ ticker: c.ticker, isin: c.isin, name: c.name }, { ticker: 'ABC', isin: 'INE000000001', name: 'ABC Ltd' });
  assert.equal(c.levels.target.value, 120);
  assert.equal(c.levels.target.setAt, new Date(AT).toISOString(), 'the Worker\'s clock, never a device\'s');
  assert.equal(c.levels.target.reached, null);
  assert.equal(c.levels.buyAt, null, 'a level nobody set is null, never zero');
});

await test('an unchanged resend changes nothing — not the set time, not the revision', () => {
  const store = makeStore();
  const first = store.apply([set('ABC', { target: 120 })]).snapshot;
  clock += 60000;
  const again = store.apply([set('ABC', { target: 120 })]);
  assert.equal(again.outcomes[0].outcome, 'unchanged');
  assert.equal(again.snapshot.revision, first.revision);
  assert.equal(again.snapshot.companies[0].levels.target.setAt, first.companies[0].levels.target.setAt);
});

await test('a new value is a new level: new set time, and it may fire again', () => {
  const store = makeStore();
  clock = AT;
  store.apply([set('ABC', { target: 120 })]);
  store.recordCheck(AT, new Map([['ABC', quote(121)]]));
  assert.ok(store.snapshot().companies[0].levels.target.reached, 'reached at 121');
  clock = AT + 120000;
  store.apply([set('ABC', { target: 130 })]);
  const target = store.snapshot().companies[0].levels.target;
  assert.equal(target.value, 130);
  assert.equal(target.reached, null);
  assert.equal(target.setAt, new Date(AT + 120000).toISOString());
  assert.equal(store.snapshot().hits.length, 1, 'the level that already fired stays in the history');
  clock = AT;
});

await test('a seed adds only what the shared list has never heard of', () => {
  const store = makeStore();
  store.apply([set('ABC', { target: 120 })]);
  store.apply([{ op: 'clear', ticker: 'ABC' }]);
  store.apply([set('DEF', { target: 50 })]);
  const { outcomes, snapshot } = store.apply([
    { ...set('ABC', { target: 99 }), op: 'seed' },
    { ...set('DEF', { target: 60 }), op: 'seed' },
    { ...set('GHI', { buyAt: 10 }), op: 'seed' },
  ]);
  assert.deepEqual(outcomes.map((o) => o.outcome), ['unchanged', 'unchanged', 'seeded']);
  assert.equal(snapshot.companies.find((c) => c.ticker === 'ABC'), undefined, 'a cleared company is not brought back by a stale device');
  assert.equal(snapshot.companies.find((c) => c.ticker === 'DEF').levels.target.value, 50, 'yesterday\'s set is not overwritten by a seed');
  assert.equal(snapshot.companies.find((c) => c.ticker === 'GHI').levels.buyAt.value, 10);
});

await test('a clear removes every level and is kept as a record; a later set brings the company back', () => {
  const store = makeStore();
  store.apply([set('ABC', { target: 120, buyAt: 90 })]);
  assert.equal(store.apply([{ op: 'clear', ticker: 'ABC' }]).outcomes[0].outcome, 'cleared');
  assert.equal(store.snapshot().count, 0);
  assert.equal(store.activeTargets().length, 0, 'nothing cleared is checked');
  assert.equal(store.apply([{ op: 'clear', ticker: 'ABC' }]).outcomes[0].outcome, 'unchanged', 'clearing twice is a race, not an error');
  assert.equal(store.apply([set('ABC', { sellAt: 150 })]).outcomes[0].outcome, 'set');
  const back = store.snapshot().companies[0];
  assert.equal(back.levels.sellAt.value, 150);
  assert.equal(back.levels.target, null, 'a cleared level does not come back with its company');
});

await test('an ISIN once known is kept when a later save carries none', () => {
  const store = makeStore();
  store.apply([set('ABC', { target: 120 })]);
  store.apply([set('ABC', { target: 125 }, { isin: null })]);
  assert.equal(store.snapshot().companies[0].isin, 'INE000000001');
});

await test('a reached level is recorded once, with the evidence, and stops being checked', () => {
  const store = makeStore();
  store.apply([set('ABC', { target: 120, stopLoss: 80 })]);
  const first = store.recordCheck(AT, new Map([['ABC', quote(121)]]));
  assert.equal(first.reached.length, 1);
  assert.equal(first.reached[0].level, 'target');
  store.recordCheck(AT + 60000, new Map([['ABC', quote(125)]]));
  const snap = store.snapshot();
  assert.equal(snap.hits.length, 1, 'a level fires once');
  assert.equal(snap.hits[0].id, hitId(snap.hits[0]));
  assert.deepEqual({ level: snap.hits[0].level, value: snap.hits[0].value, price: snap.hits[0].price, basis: snap.hits[0].basis, session: snap.hits[0].session },
    { level: 'target', value: 120, price: 121, basis: 'last-price', session: DAY });
  assert.equal(snap.hits[0].reachedAt, new Date(AT).toISOString());
  assert.deepEqual(store.activeTargets().map((t) => t.levels.map((l) => l.level)), [['stopLoss']]);
});

await test('a company with no quote this minute is not decided — an absent quote is not a price', () => {
  const store = makeStore();
  store.apply([set('ABC', { stopLoss: 80 })]);
  store.recordCheck(AT, new Map());
  store.recordCheck(AT, new Map([['OTHER', quote(1)]]));
  assert.equal(store.snapshot().hits.length, 0);
});

await test('a reached level outlives its clear, because the fall happened', () => {
  const store = makeStore();
  store.apply([set('ABC', { stopLoss: 80 })]);
  store.recordCheck(AT, new Map([['ABC', quote(79)]]));
  store.apply([{ op: 'clear', ticker: 'ABC' }]);
  assert.equal(store.snapshot().hits.length, 1);
});

await test(`the history is bounded at ${PRICE_LEVELS_HIT_LIMIT}, oldest out first`, () => {
  const store = makeStore();
  const total = PRICE_LEVELS_HIT_LIMIT + 3;
  for (let i = 0; i < total; i += 40) {
    store.apply(Array.from({ length: Math.min(40, total - i) }, (_, j) => set(`C${i + j}X`, { target: 10 })));
  }
  for (let i = 0; i < total; i++) store.recordCheck(AT + i * 1000, new Map([[`C${i}X`, quote(11)]]));
  const rows = store.rows('SELECT ticker FROM price_level_hits ORDER BY reached_at');
  assert.equal(rows.length, PRICE_LEVELS_HIT_LIMIT);
  assert.equal(rows[0].ticker, 'C3X', 'the three oldest went');
});

console.log('\n— the minute check —');

const upstoxRow = (ticker, isin, price, extra = {}) => ({
  instrument_token: `NSE_EQ|${isin}`, symbol: ticker, last_price: price,
  last_trade_time: String(AT - 30000), ohlc: { open: price, high: price + 2, low: price - 2, close: price }, ...extra,
});
const payload = (...rows) => ({ status: 'success', data: Object.fromEntries(rows.map((r) => [`NSE_EQ:${r.symbol}`, r])) });

await test('a quote counts only if it proves the company — the key AND the symbol', () => {
  const targets = [{ ticker: 'ABC', isin: 'INE000000001' }, { ticker: 'DEF', isin: 'INE000000002' }];
  const quotes = levelQuotes(payload(
    upstoxRow('ABC', 'INE000000001', 100),
    upstoxRow('WRONG', 'INE000000002', 55),
  ), targets, AT);
  assert.deepEqual([...quotes.keys()], ['ABC']);
  assert.deepEqual(quotes.get('ABC'), { price: 100, high: 102, low: 98, sessionDate: DAY, quoteAt: new Date(AT - 30000).toISOString() });
});

await test('yesterday\'s price is not today\'s, and an absent range stays absent', () => {
  const targets = [{ ticker: 'ABC', isin: 'INE000000001' }, { ticker: 'DEF', isin: 'INE000000002' }];
  const quotes = levelQuotes(payload(
    upstoxRow('ABC', 'INE000000001', 100, { last_trade_time: String(Date.parse('2026-09-22T15:29:00+05:30')) }),
    upstoxRow('DEF', 'INE000000002', 50, { ohlc: {} }),
  ), targets, AT);
  assert.equal(quotes.has('ABC'), false);
  assert.deepEqual([quotes.get('DEF').high, quotes.get('DEF').low], [null, null]);
  assert.throws(() => levelQuotes({ status: 'error' }, targets, AT), /unavailable/);
});

await test('one call, keyed on the ISIN, with the credential and no redirect followed', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload(upstoxRow('ABC', 'INE000000001', 100))), { headers: { 'content-type': 'application/json' } });
  };
  const result = await fetchLevelQuotes([{ ticker: 'ABC', isin: 'INE000000001' }, { ticker: 'DEF', isin: 'INE000000002' }], 'tok', { fetcher, now });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get('instrument_key'), 'NSE_EQ|INE000000001,NSE_EQ|INE000000002');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(result.reason, null);
  assert.deepEqual([...result.quotes.keys()], ['ABC']);
});

await test('a refused credential, a rate limit and a dead feed are three different reasons', async () => {
  const at = (status) => async () => new Response('{}', { status });
  const t = [{ ticker: 'ABC', isin: 'INE000000001' }];
  assert.equal((await fetchLevelQuotes(t, 'tok', { fetcher: at(401), now })).reason, 'authentication');
  assert.equal((await fetchLevelQuotes(t, 'tok', { fetcher: at(429), now })).reason, 'rate-limited');
  assert.equal((await fetchLevelQuotes(t, 'tok', { fetcher: at(502), now })).reason, 'unavailable');
  assert.equal((await fetchLevelQuotes(t, 'tok', { fetcher: async () => { throw new Error('down'); }, now })).reason, 'unavailable');
});

function checker({ token = 'tok', rows = [upstoxRow('ABC', 'INE000000001', 121)] } = {}) {
  const data = storage();
  const store = new PriceLevelStore(data, { now });
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(String(url));
    return new Response(JSON.stringify(payload(...rows)), { headers: { 'content-type': 'application/json' } });
  };
  const schedule = new PriceLevelSchedule(data, { UPSTOX_ACCESS_TOKEN: token }, store, { now, fetcher });
  return { data, store, schedule, fetched };
}

await test('in market hours a wake checks, records the level reached and comes back in a minute', async () => {
  clock = AT;
  const { data, store, schedule, fetched } = checker();
  store.apply([set('ABC', { target: 120, stopLoss: 80 })]);
  await schedule.arm();
  assert.equal(await data.getAlarm(), AT + 1000, 'a save arms the check');
  clock = AT + 1000;
  await schedule.wake();
  assert.equal(fetched.length, 1);
  assert.equal(await data.getAlarm(), AT + 1000 + PRICE_LEVEL_INTERVAL);
  const status = await schedule.status();
  assert.equal(status.state, 'ok');
  assert.equal(status.failed, false);
  assert.equal(status.current, true);
  assert.equal(status.checkedAt, new Date(AT + 1000).toISOString());
  assert.equal(store.snapshot().hits[0].level, 'target');
  clock = AT;
});

await test('an early or repeated wake does not call the feed twice', async () => {
  clock = AT;
  const { store, schedule, fetched } = checker();
  store.apply([set('ABC', { stopLoss: 80 })]);
  await schedule.wake();
  await schedule.wake();
  assert.equal(fetched.length, 1);
});

await test('outside market hours nothing is fetched and the check sleeps a quarter of an hour', async () => {
  clock = EVENING;
  const { data, store, schedule, fetched } = checker();
  store.apply([set('ABC', { stopLoss: 80 })]);
  await schedule.wake();
  assert.equal(fetched.length, 0);
  assert.equal(await data.getAlarm(), EVENING + PRICE_LEVEL_IDLE_INTERVAL);
  assert.equal((await schedule.status()).state, 'closed');
  clock = SUNDAY;
  await schedule.wake();
  assert.equal(fetched.length, 0, 'a Sunday is not a session');
  clock = AT;
});

await test('with no credential the check says so, and does not pretend the levels were checked', async () => {
  clock = AT;
  const { store, schedule, fetched } = checker({ token: '' });
  store.apply([set('ABC', { stopLoss: 80 })]);
  await schedule.wake();
  assert.equal(fetched.length, 0);
  const status = await schedule.status();
  assert.equal(status.state, 'not-configured');
  assert.equal(status.failed, true);
  assert.equal(status.checkedAt, null);
});

await test('a company that arrived with no ISIN is named as unchecked, never guessed', async () => {
  clock = AT;
  const { store, schedule, fetched } = checker();
  store.apply([set('ABC', { stopLoss: 80 }), set('NOID', { target: 10 }, { isin: null })]);
  await schedule.wake();
  const status = await schedule.status();
  assert.equal(new URL(fetched[0]).searchParams.get('instrument_key'), 'NSE_EQ|INE000000001', 'no key is invented for NOID');
  assert.equal(status.state, 'partial');
  assert.deepEqual(status.failures, [{ ticker: 'NOID', reason: 'no-isin' }]);
});

await test('when nothing is left to check, the alarm stops — and the next save starts it again', async () => {
  clock = AT;
  const { data, store, schedule } = checker();
  store.apply([set('ABC', { target: 120 })]);
  await schedule.wake();
  assert.equal(store.activeTargets().length, 0, 'the only level fired');
  clock = AT + PRICE_LEVEL_INTERVAL;
  await schedule.wake();
  assert.equal(await data.getAlarm(), null);
  assert.equal((await schedule.status()).state, 'idle');
  assert.equal((await schedule.status()).current, true, 'nothing waiting is complete by definition');
  store.apply([set('ABC', { target: 140 })]);
  await schedule.arm();
  assert.equal(await data.getAlarm(), clock + 1000);
  assert.equal((await schedule.status()).state, 'waiting');
  clock = AT;
});

await test('a check that stopped running in market hours reads as overdue, and a read heals it', async () => {
  clock = AT;
  const { data, store, schedule } = checker();
  store.apply([set('ABC', { stopLoss: 80 })]);
  await schedule.wake();
  await data.deleteAlarm();
  clock = AT + 10 * 60000;
  assert.equal((await schedule.status()).state, 'overdue');
  assert.equal((await schedule.status()).failed, true);
  const snap = await schedule.snapshot();
  assert.ok(await data.getAlarm(), 'reading the list re-arms a lost alarm');
  assert.equal(snap.check.nextAt, new Date(clock + 1000).toISOString());
  clock = AT;
});

await test('"current" means checked in the latest session that has happened', async () => {
  clock = AT;
  const { store, schedule } = checker();
  store.apply([set('ABC', { stopLoss: 80 })]);
  await schedule.wake();
  clock = Date.parse('2026-09-24T08:00:00+05:30');
  assert.equal((await schedule.status()).current, true, 'before the open, yesterday\'s check is still the latest session');
  clock = Date.parse('2026-09-24T10:00:00+05:30');
  assert.equal((await schedule.status()).current, false, 'after the open, it is not');
  clock = AT;
});

console.log('\n— the route —');

const OWN = 'https://glow-central-research.tech-441.workers.dev';
const GLOW = 'https://glowventures-1xw.pages.dev';
function routeEnv({ limited = false, broken = false } = {}) {
  const data = storage();
  const store = new PriceLevelStore(data, { now });
  const schedule = new PriceLevelSchedule(data, { UPSTOX_ACCESS_TOKEN: 'tok' }, store, { now, fetcher: async () => new Response('{}', { status: 503 }) });
  const object = {
    priceLevelsSnapshot: () => schedule.snapshot(),
    async priceLevelsApply(intents) {
      if (broken) throw new Error('object reset');
      const out = store.apply(intents);
      await schedule.arm();
      return { outcomes: out.outcomes, snapshot: { ...out.snapshot, check: await schedule.status() } };
    },
  };
  const names = [];
  return {
    names,
    env: {
      PRICE_LEVELS: { getByName: (name) => { names.push(name); return object; } },
      SHARED_WATCHLIST_LIMITER: { limit: async ({ key }) => { names.push(key); return { success: !limited }; } },
      PRICE_LEVEL_ORIGINS: GLOW,
    },
  };
}
const post = (body, headers = {}) => new Request(`${OWN}/api/price-levels`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers },
  body: JSON.stringify(body),
});

await test('Glow Ventures may write, and may read the answer', async () => {
  const { env, names } = routeEnv();
  const res = await handlePriceLevels(post({ intents: [set('ABC', { target: 120 })] }, { origin: GLOW, 'sec-fetch-site': 'cross-site' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), GLOW);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.outcomes, [{ ticker: 'ABC', op: 'set', outcome: 'set' }]);
  assert.equal(body.companies[0].levels.target.value, 120);
  assert.ok(body.check, 'the answer says whether the check is running');
  assert.ok(names.includes(PRICE_LEVELS_OBJECT));
  assert.ok(names.includes('price-levels:1.2.3.4'), 'its own counter on the shared limiter');
});

await test('this dashboard may write from its own page', async () => {
  const { env } = routeEnv();
  const res = await handlePriceLevels(post({ intents: [set('ABC', { target: 1 })] }, { origin: OWN, 'sec-fetch-site': 'same-origin' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

await test('any other origin — a preview, a stranger, none at all — is refused', async () => {
  const { env } = routeEnv();
  for (const origin of ['https://feature.glowventures-1xw.pages.dev', 'https://evil.example', null]) {
    const res = await handlePriceLevels(post({ intents: [set('ABC', { target: 1 })] }, origin ? { origin } : {}), env);
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'a refused caller is not handed the reason');
  }
  const forged = await handlePriceLevels(post({ intents: [set('ABC', { target: 1 })] }, { origin: OWN, 'sec-fetch-site': 'cross-site' }), env);
  assert.equal(forged.status, 403, 'a cross-site request claiming this origin is refused');
});

await test('a rate limit, a wrong body and a bad level each say which, readable by the caller', async () => {
  const glow = { origin: GLOW };
  let res = await handlePriceLevels(post({ intents: [set('ABC', { target: 1 })] }, glow), routeEnv({ limited: true }).env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '60');
  assert.equal(res.headers.get('access-control-allow-origin'), GLOW);
  res = await handlePriceLevels(post({}, { ...glow, 'content-type': 'text/plain' }), routeEnv().env);
  assert.equal(res.status, 415);
  res = await handlePriceLevels(post({ intents: [set('ABC', { target: 'abc' })] }, glow), routeEnv().env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'invalid-request');
  res = await handlePriceLevels(post({ intents: [set('ABC', { target: 1 })] }, glow), routeEnv({ broken: true }).env);
  assert.equal(res.status, 503, 'a failed object is ours and retryable, not the caller\'s mistake');
});

await test('a read is the list, the history and the check — and a failure is never an empty list', async () => {
  const { env } = routeEnv();
  await handlePriceLevels(post({ intents: [set('ABC', { target: 120 })] }, { origin: GLOW }), env);
  const res = await handlePriceLevels(new Request(`${OWN}/api/price-levels`), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /private/);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.companies.length, 1);
  assert.deepEqual(body.hits, []);
  const etag = res.headers.get('etag');
  const again = await handlePriceLevels(new Request(`${OWN}/api/price-levels`, { headers: { 'if-none-match': etag } }), env);
  assert.equal(again.status, 304, 'an unchanged read is a bodyless 304');
  const none = await handlePriceLevels(new Request(`${OWN}/api/price-levels`), {});
  assert.equal(none.status, 503);
  const failed = await none.json();
  assert.equal(failed.ok, false);
  assert.equal('companies' in failed || 'hits' in failed, false);
});

console.log('\n— the alert row and its rank —');

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { priceLevelRecord, readFeed, signalOf } = await import('../public/js/data/price-levels.js');
const { rankReport } = await import('../public/js/data/ai-alerts.js');

const hitRow = (level, extra = {}) => {
  const row = {
    ticker: 'ABC', isin: 'INE000000001', name: 'ABC Ltd', level, value: 120, setAt: new Date(OPEN - 86400000).toISOString(),
    reachedAt: new Date(AT).toISOString(), price: 121.5, basis: 'last-price', session: DAY, quoteAt: new Date(AT - 30000).toISOString(), ...extra,
  };
  return { ...row, id: hitId(row) };
};

await test('a reached level is a high-importance, AI-eligible row in the family\'s own words', () => {
  const e = priceLevelRecord(hitRow('target'));
  assert.equal(e.id, hitRow('target').id, 'the Worker\'s stable identity, so a reload never makes it new');
  assert.equal(e.headline, 'Target reached — ₹120');
  assert.match(e.detail, /^Target ₹120, set in Glow Ventures on \d{1,2} Sept? 2026\. Reached on the last traded price, ₹121\.5 at 10:59 IST\.$/);
  assert.equal(e.day, DAY);
  assert.equal(e.time, '11:00');
  assert.equal(e.importance, 'high');
  assert.equal(e.aiEligible, true);
  assert.equal(e.entityId, 'isin:INE000000001');
  assert.equal(e.kind, 'price-level');
  assert.equal(e.url, null, 'no document to link — the row opens the company in this dashboard');
});

await test('the signal follows what the level means, and a buy level points nowhere', () => {
  assert.equal(signalOf('target').direction, 'positive');
  assert.equal(signalOf('sellAt').direction, 'positive');
  assert.equal(signalOf('alertAbove').direction, 'positive');
  assert.equal(signalOf('stopLoss').direction, 'negative');
  assert.equal(signalOf('buyAt').direction, 'neutral');
  assert.equal(priceLevelRecord(hitRow('stopLoss')).severity, 'alert');
  assert.match(priceLevelRecord(hitRow('stopLoss', { basis: 'day-low', price: 118 })).detail, /Reached on the day's low, ₹118 in the \d{1,2} Sept? 2026 session\./);
});

await test('a reached target is MUST SEE the day it happens, and stays on the list for the window', () => {
  const holdings = [{ ticker: 'ABC', name: 'ABC Ltd' }];
  const feed = { id: 'price-levels', status: 'ok', reachesToday: true };
  const event = (level, day) => ({ ...priceLevelRecord(hitRow(level)), feed: 'price-levels', feedLabel: 'Price levels', day });
  const today = rankReport({ day: DAY, scope: 'portfolio', feeds: [feed], events: [event('target', DAY)] }, { holdings });
  assert.equal(today.cards.length, 1);
  assert.equal(today.cards[0].score, 82);
  assert.equal(today.cards[0].priority, 'must-see');
  const stop = rankReport({ day: DAY, scope: 'portfolio', feeds: [feed], events: [event('stopLoss', DAY)] }, { holdings });
  assert.equal(stop.cards[0].priority, 'must-see');
  const older = rankReport({ day: DAY, scope: 'portfolio', feeds: [feed], events: [event('buyAt', '2026-09-14')] }, { holdings });
  assert.ok(older.cards[0].score < 64, 'nine days on it no longer ranks on points alone');
  assert.equal(older.cards.length, 1, 'but a level the family asked about stays on the list');
  assert.equal(older.cards[0].priority, 'important');
});

await test('the feed says how many levels wait and whether the check is keeping up', async () => {
  const { load } = await import('../public/js/data/price-levels.js');
  const reply = (check, extra = {}) => new Response(JSON.stringify({ ok: true, revision: 3, updatedAt: new Date(AT).toISOString(), count: 2, pending: 3,
    companies: [], hits: [hitRow('target')], check, ...extra }), { headers: { 'content-type': 'application/json' } });
  let next;
  globalThis.fetch = async () => next;
  next = reply({ state: 'partial', failed: false, current: true, checkedAt: new Date(AT).toISOString(), failures: [{ ticker: 'NOID', reason: 'no-isin' }] });
  await load();
  let out = readFeed();
  assert.equal(out.status, 'ok');
  assert.equal(out.reachesToday, true);
  assert.equal(out.events.length, 1);
  assert.match(out.note, /2 companies carry a level; 3 levels are still waiting/);
  assert.match(out.note, /Not checked: NOID — no exchange identity \(ISIN\)/);
  next = reply({ state: 'authentication', failed: true, current: false, checkedAt: null, failures: [] });
  await load();
  out = readFeed();
  assert.equal(out.status, 'failed');
  assert.equal(out.reachesToday, false);
  assert.match(out.note, /refused this dashboard.s credential/);
  next = new Response(JSON.stringify({ ok: false, reason: 'price-levels-unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  await assert.rejects(load(), /503|unavailable/);
  assert.equal(readFeed().events.length, 1, 'a failed read keeps the last good list — never an empty one');
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);
