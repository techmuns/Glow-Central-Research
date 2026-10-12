#!/usr/bin/env node
// The Portfolio and Watchlist sheets, tested where they are decided — no server, no egress.
//
//   node scripts/verify-research-sheet.mjs
//
// The contract (data/research-sheet-shared.js), the durable store on node:sqlite exactly as the
// shared watchlist's test runs it, the arithmetic behind every derived column (data/sheet-math.js),
// the two Worker routes behind a stubbed env, and the history capture's choice of holdings. The
// browser half — the row model, the editor and the tab order — is scripts/verify-research-sheet-ui.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  SHEET_COMPANY_LIMIT, SHEET_INTENT_BATCH, SHEET_ROW_LIMIT, FIELDS, editedLabel, fieldValue, isNewerSheet,
  isinKey, keyTicker, sameValue, sheetIntent, sheetIntents, sheetKey,
} from '../public/js/data/research-sheet-shared.js';
import { ResearchSheetStore, RESEARCH_SHEET_OBJECT } from '../worker/research-sheet-store.mjs';
import { handleResearchSheet } from '../worker/research-sheet.mjs';
import { handleBenchmarkQuote, readBenchmark } from '../worker/benchmark-quote.mjs';
import {
  closeOnOrBefore, daysBetween, dividendsReceived, formatSheetDate, istToday, monthBefore, parseDateInput,
  parseNumberInput, pctChange, splitFactorAfter, xirr,
} from '../public/js/data/sheet-math.js';
import { publicDirectTickers, yahooSymbol } from './scrape-sheet-history.mjs';

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
let clock = Date.parse('2026-10-12T05:00:00.000Z');
const makeStore = () => new ResearchSheetStore(storage(), { now: () => (clock += 1000) });

console.log('\n— the contract —');

await test('a company is its symbol or a prefixed ISIN, never a bare ISIN or a row key', () => {
  assert.equal(sheetKey('sbin'), 'SBIN');
  assert.equal(sheetKey('20MICRONS'), '20MICRONS');
  assert.equal(sheetKey('500325'), '500325');
  assert.equal(sheetKey('M&M'), 'M&M');
  assert.equal(sheetKey('isin:ine00gk01023'), 'ISIN:INE00GK01023');
  assert.equal(sheetKey('INE00GK01023'), null, 'a bare ISIN would read as a symbol');
  assert.equal(sheetKey('RELIANCE|2026-08-12'), null);
  assert.equal(sheetKey(''), null);
  assert.equal(isinKey('INE00GK01023'), 'ISIN:INE00GK01023');
  assert.equal(isinKey('not-an-isin'), null);
  assert.equal(keyTicker('ISIN:INE00GK01023'), null);
  assert.equal(keyTicker('SBIN'), 'SBIN');
});

await test('every field the tabs edit is in the contract, and nothing the market supplies is', () => {
  for (const field of ['name', 'sector', 'source', 'dateBought', 'quantity', 'buyPrice', 'amountInvested', 'targetAmount',
    'targetWeight', 'pendingAmount', 'intrinsicValue', 'entryPrice', 'methodology', 'reference']) assert.ok(FIELDS[field], field);
  for (const live of ['cmp', 'marketCap', 'day', 'month', 'tsr', 'alpha', 'currentValue', 'xirr', 'weight', 'upside', 'expectedIrr']) {
    assert.equal(FIELDS[live], undefined, `${live} is derived live and must never be typed`);
  }
});

await test('values are validated per kind — numbers in range, real dates, trimmed text', () => {
  assert.equal(fieldValue('buyPrice', 512.4), 512.4);
  assert.throws(() => fieldValue('buyPrice', 0), /Invalid/);
  assert.throws(() => fieldValue('quantity', -5), /Invalid/);
  assert.throws(() => fieldValue('buyPrice', '512'), /Invalid/, 'the wire carries numbers, not strings');
  assert.throws(() => fieldValue('targetWeight', 101), /Invalid/);
  assert.equal(fieldValue('pendingAmount', -0.75), -0.75, 'over target is a negative pending amount');
  assert.equal(fieldValue('amountInvested', 0), 0);
  assert.equal(fieldValue('dateBought', '2024-02-29'), '2024-02-29');
  assert.throws(() => fieldValue('dateBought', '2025-02-29'), /Invalid/, 'not a leap year');
  assert.throws(() => fieldValue('dateBought', '12-03-2024'), /Invalid/, 'the wire carries ISO dates');
  assert.equal(fieldValue('methodology', '  DCF\u0007  +  EV/EBITDA '), 'DCF + EV/EBITDA');
  assert.throws(() => fieldValue('methodology', '   '), /Invalid/);
  assert.equal(fieldValue('source', 'x'.repeat(500)).length, FIELDS.source.max);
  assert.throws(() => fieldValue('cmp', 100), /Invalid research field/);
});

await test('an intent says what it does, and a batch cannot contradict itself', () => {
  assert.deepEqual(sheetIntent({ op: 'set', key: 'sbin', field: 'intrinsicValue', value: 1200, by: ' Ravi ' }),
    { op: 'set', key: 'SBIN', field: 'intrinsicValue', value: 1200, by: 'Ravi' });
  assert.deepEqual(sheetIntent({ op: 'clear', key: 'SBIN', field: 'sector' }), { op: 'clear', key: 'SBIN', field: 'sector', by: null });
  assert.deepEqual(sheetIntent({ op: 'add-row', key: 'INFY', name: 'Infosys' }), { op: 'add-row', key: 'INFY', name: 'Infosys', by: null });
  assert.throws(() => sheetIntent({ op: 'add-row', key: 'INFY' }), /name/);
  assert.throws(() => sheetIntent({ op: 'drop', key: 'INFY' }), /operation/);
  assert.throws(() => sheetIntent({ op: 'set', key: 'INFY', field: 'weight', value: 2 }), /field/);
  assert.throws(() => sheetIntents([]), /batch/);
  assert.throws(() => sheetIntents(Array.from({ length: SHEET_INTENT_BATCH + 1 }, (_, i) => ({ op: 'clear', key: `C${i}`, field: 'sector' }))), /batch/);
  assert.throws(() => sheetIntents([
    { op: 'set', key: 'SBIN', field: 'buyPrice', value: 500 },
    { op: 'set', key: 'SBIN', field: 'buyPrice', value: 510 },
  ]), /Duplicate/);
  assert.equal(sheetIntents([
    { op: 'set', key: 'SBIN', field: 'buyPrice', value: 500 },
    { op: 'set', key: 'SBIN', field: 'quantity', value: 10 },
    { op: 'add-row', key: 'SBIN', name: 'SBI' },
  ]).length, 3, 'different cells of one company travel together');
});

await test('revisions order snapshots without a clock; labels never invent a name', () => {
  assert.equal(isNewerSheet({ revision: 4 }, { revision: 3 }), true);
  assert.equal(isNewerSheet({ revision: 2 }, { revision: 3 }), false);
  assert.equal(isNewerSheet({}, { revision: 3 }), true);
  assert.ok(sameValue(0.1 + 0.2, 0.3));
  assert.match(editedLabel({ by: 'Ravi', at: '2026-10-12T05:00:00Z' }), /^Edited by Ravi · 12 Oct 2026/);
  assert.equal(editedLabel({ by: null, at: null }), 'Edited — name not recorded');
  assert.match(editedLabel({ by: null, pending: true }), /not yet saved/);
});

console.log('\n— the durable store —');

await test('a set is stored with the server\'s time and the editor\'s name; re-typing it changes nothing', () => {
  const store = makeStore();
  let out = store.apply([{ op: 'set', key: 'SBIN', field: 'intrinsicValue', value: 1200, by: 'Ravi' }]);
  assert.equal(out.outcomes[0].outcome, 'set');
  assert.equal(out.snapshot.revision, 1);
  const cell = out.snapshot.values.SBIN.intrinsicValue;
  assert.deepEqual([cell.value, cell.by], [1200, 'Ravi']);
  assert.ok(Date.parse(cell.at) > Date.parse('2026-10-12T05:00:00Z'));
  out = store.apply([{ op: 'set', key: 'SBIN', field: 'intrinsicValue', value: 1200, by: 'Priya' }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged');
  assert.equal(out.snapshot.revision, 1, 'an unchanged write does not move the revision (so the poll stays a 304)');
  assert.equal(out.snapshot.values.SBIN.intrinsicValue.by, 'Ravi', 'whoever set it set it');
  out = store.apply([{ op: 'set', key: 'SBIN', field: 'intrinsicValue', value: 1250, by: 'Priya' }]);
  assert.deepEqual([out.snapshot.revision, out.snapshot.values.SBIN.intrinsicValue.by], [2, 'Priya']);
});

await test('two people editing two cells of one company both keep their edit', () => {
  const store = makeStore();
  store.apply([{ op: 'set', key: 'SBIN', field: 'intrinsicValue', value: 1200, by: 'Ravi' }]);
  const out = store.apply([{ op: 'set', key: 'SBIN', field: 'methodology', value: 'DCF', by: 'Priya' }]);
  assert.deepEqual(Object.keys(out.snapshot.values.SBIN).sort(), ['intrinsicValue', 'methodology']);
});

await test('a cleared cell is gone, so it shows its default again; clearing nothing is not an error', () => {
  const store = makeStore();
  store.apply([{ op: 'set', key: 'SBIN', field: 'sector', value: 'Banks' }]);
  let out = store.apply([{ op: 'clear', key: 'SBIN', field: 'sector' }]);
  assert.equal(out.outcomes[0].outcome, 'cleared');
  assert.equal(out.snapshot.values.SBIN, undefined);
  out = store.apply([{ op: 'clear', key: 'SBIN', field: 'sector' }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged');
});

await test('a sheet at its company limit refuses a NEW company by name, never silently', () => {
  const store = makeStore();
  for (let start = 0; start < SHEET_COMPANY_LIMIT; start += SHEET_INTENT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + SHEET_INTENT_BATCH, SHEET_COMPANY_LIMIT); i++) batch.push({ op: 'set', key: `CO${i}`, field: 'sector', value: 'X' });
    store.apply(batch);
  }
  const out = store.apply([
    { op: 'set', key: 'NEWCO', field: 'sector', value: 'X' },
    { op: 'set', key: 'CO1', field: 'methodology', value: 'DCF' },
  ]);
  assert.deepEqual(out.outcomes.map((o) => o.outcome), ['full', 'set'], 'a company already on the sheet can still be edited');
  store.apply([{ op: 'clear', key: 'CO2', field: 'sector' }]);
  assert.equal(store.apply([{ op: 'set', key: 'NEWCO', field: 'sector', value: 'X' }]).outcomes[0].outcome, 'set', 'clearing a company frees its place');
});

await test('hand-added holdings: add, keep the first name, remove, re-add, and a row limit', () => {
  const store = makeStore();
  let out = store.apply([{ op: 'add-row', key: 'INFY', name: 'Infosys', by: 'Ravi' }]);
  assert.deepEqual(out.snapshot.rows.map((r) => [r.key, r.name, r.addedBy]), [['INFY', 'Infosys', 'Ravi']]);
  out = store.apply([{ op: 'add-row', key: 'INFY', name: 'Infosys Ltd' }]);
  assert.equal(out.outcomes[0].outcome, 'unchanged');
  assert.equal(out.snapshot.rows[0].name, 'Infosys');
  out = store.apply([{ op: 'remove-row', key: 'INFY' }]);
  assert.deepEqual([out.outcomes[0].outcome, out.snapshot.rows.length], ['removed', 0]);
  assert.equal(store.apply([{ op: 'remove-row', key: 'INFY' }]).outcomes[0].outcome, 'unchanged');
  assert.equal(store.apply([{ op: 'add-row', key: 'INFY', name: 'Infosys' }]).outcomes[0].outcome, 'added', 'a deliberate re-add is allowed');
  for (let start = 1; start < SHEET_ROW_LIMIT; start += SHEET_INTENT_BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + SHEET_INTENT_BATCH, SHEET_ROW_LIMIT); i++) batch.push({ op: 'add-row', key: `R${i}`, name: `Row ${i}` });
    store.apply(batch);
  }
  assert.equal(store.apply([{ op: 'add-row', key: 'ONEMORE', name: 'One more' }]).outcomes[0].outcome, 'full');
});

await test('a removed holding keeps its typed values — they belong to the company, not the row', () => {
  const store = makeStore();
  store.apply([{ op: 'add-row', key: 'INFY', name: 'Infosys' }, { op: 'set', key: 'INFY', field: 'intrinsicValue', value: 1900 }]);
  const out = store.apply([{ op: 'remove-row', key: 'INFY' }]);
  assert.equal(out.snapshot.values.INFY.intrinsicValue.value, 1900);
});

await test('a bad batch changes nothing at all', () => {
  const store = makeStore();
  assert.throws(() => store.apply([{ op: 'set', key: 'SBIN', field: 'buyPrice', value: -1 }]), /Invalid/);
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(store.snapshot().values, {});
});

console.log('\n— the arithmetic —');

await test('dates are read day first, and a date that does not exist is refused', () => {
  const now = Date.parse('2026-10-12T06:00:00Z');
  for (const [text, iso] of [['12-Mar-24', '2024-03-12'], ['12 Mar 2024', '2024-03-12'], ['12/03/2024', '2024-03-12'],
    ['2024-03-12', '2024-03-12'], ['5-Sept-2023', '2023-09-05'], ['01.01.95', '1995-01-01'], ['1/1/27', '2027-01-01']]) {
    assert.equal(parseDateInput(text, now), iso, text);
  }
  for (const text of ['31-Apr-24', '29/02/2025', 'March', '', '12-Foo-24']) assert.equal(parseDateInput(text, now), null, text);
  assert.equal(formatSheetDate('2024-03-12'), '12-Mar-24');
  assert.equal(formatSheetDate(null), '—');
  assert.equal(istToday(Date.parse('2026-10-11T19:00:00Z')), '2026-10-12', 'the market\'s calendar, not UTC');
});

await test('numbers are read as written on paper, and anything else is refused', () => {
  assert.equal(parseNumberInput('1,23,456.50'), 123456.5);
  assert.equal(parseNumberInput('₹ 512.40'), 512.4);
  assert.equal(parseNumberInput('Rs. 1200'), 1200);
  assert.equal(parseNumberInput('2.5 Cr'), 2.5);
  assert.equal(parseNumberInput('4.5%'), 4.5);
  assert.equal(parseNumberInput('-0.75'), -0.75);
  for (const text of ['abc', '', '1.2.3', '12 34x']) assert.equal(parseNumberInput(text), null, text);
});

await test('the one-month base is the close on or before the same day last month', () => {
  assert.equal(monthBefore('2026-03-31'), '2026-02-28');
  assert.equal(monthBefore('2024-03-30'), '2024-02-29');
  assert.equal(monthBefore('2026-01-15'), '2025-12-15');
  const rows = [['2026-09-08', 100], ['2026-09-11', 104], ['2026-09-14', 99]];
  assert.deepEqual(closeOnOrBefore(rows, '2026-09-12'), ['2026-09-11', 104], 'a weekend falls back to Friday');
  assert.equal(closeOnOrBefore(rows, '2026-09-01'), null, 'no close before the history starts');
  assert.equal(pctChange(150, 100), 50);
  assert.equal(pctChange(150, 0), null);
});

await test('a split after the statement date moves its quantity onto today\'s share basis', () => {
  const splits = [['2014-11-20', 10, 1], ['2026-06-12', 4, 3]];
  assert.equal(splitFactorAfter(splits, '2026-03-31', '2026-10-12'), 4 / 3);
  assert.equal(splitFactorAfter(splits, '2026-07-31', '2026-10-12'), 1, 'a statement after the split is already on today\'s basis');
  assert.ok(Math.abs(splitFactorAfter(splits, '2010-01-01', '2026-10-12') - 40 / 3) < 1e-9);
  assert.equal(splitFactorAfter(splits, '2026-03-31', '2026-06-01'), 1, 'a split after today has not happened');
});

await test('dividends count from the first ex-date AFTER the purchase, per share × quantity', () => {
  const divs = [['2025-05-16', 15.9], ['2026-05-15', 17.35], ['2026-11-01', 2]];
  const got = dividendsReceived(divs, '2025-05-16', '2026-10-12', 100);
  assert.deepEqual(got, [{ date: '2026-05-15', perShare: 17.35, amount: 1735 }], 'a buyer on the ex-date is not entitled; a future ex-date is not received');
  assert.deepEqual(dividendsReceived(divs, null, '2026-10-12', 100), []);
  assert.deepEqual(dividendsReceived(divs, '2020-01-01', '2026-10-12', 0), []);
});

await test('XIRR agrees with Excel on known cash flows and refuses where no rate exists', () => {
  // Excel: XIRR({-100,110},{2024-01-01,2025-01-01}) = 9.9714% (366 days on a 365-day year).
  assert.ok(Math.abs(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 110 }]) - 0.0997136) < 1e-6);
  // Excel's documented example: 8 cash flows, XIRR = 37.336%.
  const excel = xirr([
    { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 }, { date: '2008-10-30', amount: 4250 },
    { date: '2009-02-15', amount: 3250 }, { date: '2009-04-01', amount: 2750 },
  ]);
  assert.ok(Math.abs(excel - 0.373362535) < 1e-6, String(excel));
  assert.ok(Math.abs(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 50 }]) + 0.50) < 0.01, 'a loss');
  assert.equal(xirr([{ date: '2024-01-01', amount: -100 }]), null);
  assert.equal(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: -10 }]), null, 'every flow one sign');
  assert.equal(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-01-01', amount: 110 }]), null, 'no period');
  assert.equal(daysBetween('2025-03-12', '2026-10-12'), 579);
});

console.log('\n— the Worker routes —');

function sheetEnv({ limited = false, broken = false } = {}) {
  const store = makeStore();
  const env = {
    CAPTURE_REGISTRY: {
      getByName: (name) => {
        assert.equal(name, RESEARCH_SHEET_OBJECT);
        return {
          researchSheetSnapshot: async () => { if (broken) throw new Error('object down'); return store.snapshot(); },
          researchSheetApply: async (intents) => { if (broken) throw new Error('object down'); return store.apply(intents); },
        };
      },
    },
    SHARED_WATCHLIST_LIMITER: { limit: async ({ key }) => { assert.match(key, /^research-sheet:/); return { success: !limited }; } },
  };
  return env;
}
const origin = 'https://glow.example';
const post = (body, headers = {}) => new Request(`${origin}/api/research-sheet`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
});

await test('GET answers the sheet privately with an ETag, and a matching tag is a bodyless 304', async () => {
  const env = sheetEnv();
  const first = await handleResearchSheet(new Request(`${origin}/api/research-sheet`), env);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /private/);
  const body = await first.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.values, {});
  const again = await handleResearchSheet(new Request(`${origin}/api/research-sheet`, { headers: { 'if-none-match': first.headers.get('etag') } }), env);
  assert.equal(again.status, 304);
});

await test('POST applies same-origin edits and answers with the sheet as it now stands', async () => {
  const env = sheetEnv();
  const res = await handleResearchSheet(post({ intents: [{ op: 'set', key: 'SBIN', field: 'targetAmount', value: 5, by: 'Ravi' }] }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.values.SBIN.targetAmount.value, 5);
  assert.equal(body.outcomes[0].outcome, 'set');
});

await test('a write from another site, a wrong type, a bad batch or a burst is refused by name', async () => {
  const env = sheetEnv();
  assert.equal((await handleResearchSheet(post({ intents: [] }, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await handleResearchSheet(post({ intents: [] }, { 'sec-fetch-site': 'cross-site' }), env)).status, 403);
  assert.equal((await handleResearchSheet(post('x', { 'content-type': 'text/plain' }), env)).status, 415);
  const bad = await handleResearchSheet(post({ intents: [{ op: 'set', key: 'SBIN', field: 'cmp', value: 1 }] }), env);
  assert.deepEqual([bad.status, (await bad.json()).reason], [400, 'invalid-request']);
  assert.equal((await handleResearchSheet(post({ intents: [{ op: 'clear', key: 'SBIN', field: 'sector' }] }), sheetEnv({ limited: true }))).status, 429);
  assert.equal((await handleResearchSheet(new Request(`${origin}/api/research-sheet`, { method: 'DELETE' }), env)).status, 405);
});

await test('a failed object is a named failure, never an empty sheet', async () => {
  const res = await handleResearchSheet(new Request(`${origin}/api/research-sheet`), sheetEnv({ broken: true }));
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.values, undefined, 'no values key at all, so it cannot be painted as nothing typed');
  assert.equal((await handleResearchSheet(new Request(`${origin}/api/research-sheet`), {})).status, 503);
});

const nseBody = JSON.parse(readFileSync(new URL('./fixtures/newsletter/nse-indices-2026-09-23.json', import.meta.url)));
const at = Date.parse('2026-09-23T16:00:00+05:30');
const upstoxBody = (lastTrade) => ({ status: 'success', data: { nifty500: {
  instrument_token: 'NSE_INDEX|Nifty 500', symbol: 'NIFTY 500', last_price: 22940.5, net_change: 146.3, prev_close_price: 22794.2,
  ohlc: { close: 22940.5 }, last_trade_time: String(lastTrade),
} } });

await test('the benchmark reads the newer of Upstox and NSE, and says which', async () => {
  const fetcher = async (url) => (String(url).includes('upstox')
    ? Response.json(upstoxBody(Date.parse('2026-09-23T15:31:00+05:30')))
    : Response.json(nseBody));
  const quote = await readBenchmark({ UPSTOX_ACCESS_TOKEN: 'fixture' }, { fetcher, now: at });
  assert.equal(quote.ok, true);
  assert.equal(quote.origin, 'upstox');
  assert.equal(quote.last, 22940.5);
  assert.equal(quote.sessionDate, '2026-09-23');
  const nseOnly = await readBenchmark({}, { fetcher, now: at });
  assert.deepEqual([nseOnly.origin, nseOnly.last, nseOnly.sources.upstox], ['nse', 22935.1, 'not-configured']);
});

await test('no readable source is a named failure with no level, cached briefly at the edge', async () => {
  const fetcher = async () => new Response('', { status: 403 });
  const quote = await readBenchmark({ UPSTOX_ACCESS_TOKEN: 'fixture' }, { fetcher, now: at });
  assert.equal(quote.ok, false);
  assert.equal(quote.last, undefined);
  assert.deepEqual(quote.sources, { upstox: 'authentication', nse: 'blocked' });
  const cache = new Map();
  const edgeCache = { match: async (k) => cache.get(k.url)?.clone(), put: async (k, r) => { cache.set(k.url, r); } };
  const cacheKey = new Request('https://cache.invalid/glow-central-research/benchmark-quote:nifty500');
  const res = await handleBenchmarkQuote(new Request(`${origin}/api/benchmark-quote`), {}, { fetcher, now: () => at, edgeCache, cacheKey });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=15/);
  assert.equal(cache.size, 1);
  let calls = 0;
  const second = await handleBenchmarkQuote(new Request(`${origin}/api/benchmark-quote`), {}, { fetcher: async () => { calls++; return new Response('', { status: 500 }); }, now: () => at, edgeCache, cacheKey });
  assert.equal(calls, 0, 'one upstream read per edge window');
  assert.equal((await second.json()).ok, false);
});

console.log('\n— the history capture —');

await test('the capture covers exactly the public-direct holdings: Equity, outside PMS, listed', () => {
  const book = JSON.parse(readFileSync(new URL('../public/data/book.json', import.meta.url)));
  const companies = JSON.parse(readFileSync(new URL('../public/data/portfolio-companies.json', import.meta.url)));
  const tickers = publicDirectTickers(book, companies);
  const pms = new Set(book.positions.filter((p) => p.engagement === 'PMS' && p.symbol).map((p) => p.symbol));
  const direct = new Set(book.positions.filter((p) => p.assetClass === 'Equity' && p.engagement !== 'PMS' && p.symbol).map((p) => p.symbol));
  for (const t of direct) assert.ok(tickers.has(t), `${t} is held directly`);
  for (const t of tickers) assert.ok(direct.has(t), `${t} is not a direct holding`);
  assert.ok([...pms].some((t) => !tickers.has(t)), 'PMS-only holdings are not covered');
  assert.equal(yahooSymbol('SBIN'), 'SBIN.NS');
  assert.equal(yahooSymbol('500325'), '500325.BO');
});

await test('the committed capture is well formed: dated benchmark rows, per-company events, failures named', () => {
  const history = JSON.parse(readFileSync(new URL('../public/data/sheet-history.json', import.meta.url)));
  assert.equal(history.version, 1);
  const rows = history.benchmark.rows;
  assert.ok(rows.length > 1000);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][0] > rows[i - 1][0], `benchmark dates ascend at ${rows[i][0]}`);
  assert.ok(rows.every(([d, c]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && c > 0));
  for (const [ticker, entry] of Object.entries(history.companies)) {
    assert.ok(Array.isArray(entry.dividends) && Array.isArray(entry.splits), ticker);
    assert.ok(entry.dividends.every(([d, a]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && a > 0), `${ticker} dividends`);
  }
  for (const f of history.failed) assert.ok(f.ticker && f.reason, 'every failure names its company and reason');
});

console.log(`\n${count - failures} of ${count} passed`);
if (failures) process.exit(1);
