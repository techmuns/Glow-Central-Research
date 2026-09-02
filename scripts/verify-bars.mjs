#!/usr/bin/env node
// Focused checks for the price-bar rules behind the technicals scrape and the ±5% price alert.
// Dependency-free by repository contract. Run: node scripts/verify-bars.mjs

import assert from 'node:assert/strict';
import { completedBars, dayMove, istDay, MAX_DAY_MOVE_GAP_DAYS } from './lib/yahoo.mjs';
import { parseMarketData, moveFromBars, verifyMoves, saveChecks, loadChecks } from './lib/muns-market-data.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log('PASS  ' + label);
};

const bar = (date, close) => ({ date, open: close, high: close, low: close, close, volume: 1000 });
// 2 Sept 2026, 11:36 IST — the minute the late scheduled run actually fetched Yahoo.
const MID_SESSION = new Date('2026-09-02T06:06:32Z');
const AFTER_CLOSE = new Date('2026-09-02T12:00:00Z'); // 17:30 IST
const NEXT_MORNING = new Date('2026-09-03T01:30:00Z'); // 07:00 IST, the scheduled slot

ok('the IST calendar day is read from the IST clock, not the UTC one', () => {
  assert.equal(istDay(new Date('2026-09-02T19:00:00Z')), '2026-09-03');
  assert.equal(istDay(MID_SESSION), '2026-09-02');
});

ok("a bar dated today is dropped while today's session is still open, and kept once it has settled", () => {
  const series = [bar('2026-08-31', 1989.3), bar('2026-09-01', 1911.3), bar('2026-09-02', 1876.8)];
  series.meta = { regularMarketPrice: 1876.8 };
  const during = completedBars(series, MID_SESSION);
  assert.deepEqual(during.map((b) => b.date), ['2026-08-31', '2026-09-01']);
  assert.equal(during.meta.regularMarketPrice, 1876.8, 'meta travels with the trimmed series');
  assert.equal(completedBars(series, AFTER_CLOSE).length, 3);
  assert.equal(completedBars(series, NEXT_MORNING).length, 3, "yesterday's bar is a finished session");
  assert.equal(completedBars([], MID_SESSION).length, 0);
});

ok('the day move carries both dates and is the change between the last two completed closes', () => {
  const move = dayMove([bar('2026-08-31', 1989.3), bar('2026-09-01', 1911.3), bar('2026-09-02', 1883.6)]);
  assert.equal(move.date, '2026-09-02');
  assert.equal(move.prevDate, '2026-09-01');
  assert.equal(move.gapDays, 1);
  assert.equal(Math.round(move.pct * 100) / 100, -1.45);
  // The mid-session file: the same series cut at 11:36 IST is a 1 September move, dated 1 September.
  const cut = dayMove(completedBars([bar('2026-08-31', 1989.3), bar('2026-09-01', 1911.3), bar('2026-09-02', 1876.8)], MID_SESSION));
  assert.equal(cut.date, '2026-09-01');
  assert.equal(Math.round(cut.pct * 100) / 100, -3.92);
});

ok('a move across a skipped session is refused rather than reported as a day move', () => {
  const weekend = dayMove([bar('2026-08-28', 100), bar('2026-08-31', 105)]);
  assert.equal(weekend.gapDays, 3);
  assert.equal(weekend.pct, 5);
  const longWeekend = dayMove([bar('2026-08-27', 100), bar('2026-08-31', 105)]);
  assert.equal(longWeekend.gapDays, MAX_DAY_MOVE_GAP_DAYS);
  assert.equal(longWeekend.pct, 5);
  const skipped = dayMove([bar('2026-08-26', 100), bar('2026-08-31', 105)]);
  assert.equal(skipped.pct, null);
  assert.equal(skipped.date, '2026-08-31');
  assert.deepEqual(dayMove([bar('2026-08-31', 100)]), { pct: null, date: '2026-08-31', prevDate: null, gapDays: null });
});

const PREVIEW = `File created: /shared/csv/HEROMOTOCONS.csv

Title:
HEROMOTOCO Market Data

Notes:
Data fetched successfully for India between 2026-08-26 and 2026-09-02

Sample Data Preview:
--------------------------------------------------
Date, Open, High, Low, Close, Volume, Dividends, Stock Splits
2026-08-26 00:00:00+05:30 | 5630.5 | 5720.0 | 5595.0 | 5595.0 | 451708 | 0.0 | 0.0
2026-08-27 00:00:00+05:30 | 5594.5 | 5610.0 | 5511.5 | 5550.0 | 533073 | 0.0 | 0.0
...
2026-08-31 00:00:00+05:30 | 5614.0 | 5614.0 | 5450.0 | 5450.0 | 485204 | 0.0 | 0.0
2026-09-01 00:00:00+05:30 | 5610.0 | 5659.0 | 5495.5 | 5555.0 | 1231011 | 0.0 | 0.0
--------------------------------------------------
Total Rows: 5
File Path: /shared/csv/HEROMOTOCONS.csv`;

ok("the endpoint's text preview parses by its own header, elision and all", () => {
  const parsed = parseMarketData(PREVIEW);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.bars.map((b) => [b.date, b.close]), [['2026-08-26', 5595], ['2026-08-27', 5550], ['2026-08-31', 5450], ['2026-09-01', 5555]]);
  const move = moveFromBars(parsed.bars, '2026-09-01');
  assert.equal(Math.round(move.pct * 100) / 100, 1.93);
  assert.equal(move.prevDate, '2026-08-31');
  assert.equal(moveFromBars(parsed.bars, '2026-09-02'), null, 'a day the endpoint does not carry cannot be verified');
});

ok('a 200 whose body is a refusal is a refusal, and a JSON body is read by shape', () => {
  assert.deepEqual(parseMarketData('Error: Too Many Requests. Rate limited. Try after a while.'), { ok: false, reason: 'rate-limited' });
  assert.equal(parseMarketData('').ok, false);
  assert.equal(parseMarketData('Title:\nnothing here').ok, false);
  const json = JSON.stringify({ data: [{ Date: '2026-09-01T00:00:00+05:30', Close: 5555, Open: 5610 }, { Date: '2026-08-31', Close: 5450 }] });
  assert.deepEqual(parseMarketData(json).bars.map((b) => b.date), ['2026-08-31', '2026-09-01']);
});

const rows = [
  { ticker: 'HEROMOTOCO', bar_date: '2026-09-02', pct_change_today: -6.71 },
  { ticker: 'MACPOWER', bar_date: '2026-09-02', pct_change_today: -5.66 },
  { ticker: 'CALM', bar_date: '2026-09-02', pct_change_today: 0.4 },
  { ticker: 'NEAR', bar_date: '2026-09-02', pct_change_today: 4.2 },
];
const bodies = {
  HEROMOTOCO: 'Date, Open, High, Low, Close, Volume\n2026-09-01 00:00:00+05:30 | 5610 | 5659 | 5495.5 | 5555.0 | 1\n2026-09-02 00:00:00+05:30 | 5477 | 5485 | 5167 | 5300.0 | 1',
  MACPOWER: 'Date, Open, High, Low, Close, Volume\n2026-09-01 00:00:00+05:30 | 1 | 1 | 1 | 1911.3 | 1\n2026-09-02 00:00:00+05:30 | 1 | 1 | 1 | 1883.6 | 1',
  NEAR: 'Date, Open, High, Low, Close, Volume\n2026-09-01 00:00:00+05:30 | 1 | 1 | 1 | 100.0 | 1\n2026-09-02 00:00:00+05:30 | 1 | 1 | 1 | 104.2 | 1',
};
const REFUSAL = 'Error: Too Many Requests. Rate limited. Try after a while.';
// A fake clock and a fake endpoint that refuses the first two MACPOWER calls, so the loop has to
// back off and come back to the same name — which is what the live endpoint made it do.
let clock = 0;
const asked = [];
const waits = [];
let macpowerRefusals = 0;
const fetchImpl = async (url) => {
  const ticker = new URL(url).searchParams.get('ticker');
  asked.push(ticker);
  if (ticker === 'MACPOWER' && macpowerRefusals < 2) {
    macpowerRefusals += 1;
    return { ok: true, status: 200, text: async () => REFUSAL };
  }
  return { ok: true, status: 200, text: async () => bodies[ticker] || '' };
};
const summary = await verifyMoves(rows, { fetchImpl, sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock, log: () => {}, spacingMs: 10, backoffMs: 100, maxBackoffMs: 250 });
ok('alerting names go first, a refusal backs off and retries the SAME name, calm rows are never asked about', () => {
  assert.deepEqual(asked, ['HEROMOTOCO', 'MACPOWER', 'MACPOWER', 'MACPOWER', 'NEAR']);
  assert.deepEqual(waits.filter((ms) => ms >= 100), [100, 200], 'the backoff doubles between refusals');
  assert.equal(rows[0].pct_change_today, -4.59);
  assert.equal(rows[0].move_check, 'corrected');
  assert.equal(rows[0].move_prev_date, '2026-09-01');
  assert.equal(rows[1].pct_change_today, -1.45);
  assert.equal(rows[1].move_check, 'corrected');
  assert.equal(rows[2].move_check, undefined);
  assert.equal(rows[3].move_check, 'confirmed');
  assert.deepEqual(
    { flagged: summary.flagged, checked: summary.checked, corrected: summary.corrected, confirmed: summary.confirmed, unavailable: summary.unavailable, refusals: summary.refusals, requests: summary.requests, exhausted: summary.budget_exhausted },
    { flagged: 3, checked: 3, corrected: 2, confirmed: 1, unavailable: 0, refusals: 2, requests: 5, exhausted: false }
  );
});

const starved = [
  { ticker: 'AAA', bar_date: '2026-09-02', pct_change_today: 7 },
  { ticker: 'BBB', bar_date: '2026-09-02', pct_change_today: -6 },
];
let clock2 = 0;
const alwaysRefuse = async () => ({ ok: true, status: 200, text: async () => REFUSAL });
const starvedSummary = await verifyMoves(starved, { fetchImpl: alwaysRefuse, sleep: async (ms) => { clock2 += ms; }, now: () => clock2, log: () => {}, spacingMs: 10, backoffMs: 100, maxBackoffMs: 400, budgetMs: 1_000 });
ok('an endpoint that never answers exhausts the budget, and every unanswered name says so rather than keeping a silent figure', () => {
  assert.equal(starvedSummary.budget_exhausted, true);
  assert.equal(starvedSummary.checked, 0);
  assert.equal(starvedSummary.unavailable, 2);
  assert.equal(starvedSummary.refusals >= 2, true);
  assert.equal(clock2 <= 1_000 + 400, true, 'the backoff never overruns the budget by more than one wait');
  assert.deepEqual(starved.map((row) => [row.pct_change_today, row.move_check, row.move_check_reason]), [[7, 'unavailable', 'verification budget exhausted'], [-6, 'unavailable', 'verification budget exhausted']]);
});

const remembered = { checks: { 'AAA@2026-09-02': { pct: 6.25, close: 106.25, prevClose: 100, prevDate: '2026-09-01', checkedAt: '2026-09-02T12:00:00Z' } } };
const cachedRows = [
  { ticker: 'AAA', bar_date: '2026-09-02', pct_change_today: 7, move_check: 'unavailable', move_check_reason: 'rate-limited' },
  { ticker: 'BBB', bar_date: '2026-09-02', pct_change_today: -6 },
];
const cacheAsked = [];
const cacheFetch = async (url) => {
  cacheAsked.push(new URL(url).searchParams.get('ticker'));
  return { ok: true, status: 200, text: async () => 'Date, Open, High, Low, Close, Volume\n2026-09-01 00:00:00+05:30 | 1 | 1 | 1 | 200.0 | 1\n2026-09-02 00:00:00+05:30 | 1 | 1 | 1 | 188.0 | 1' };
};
const cachedSummary = await verifyMoves(cachedRows, { fetchImpl: cacheFetch, checks: remembered, sleep: async () => {}, now: () => 0, log: () => {}, spacingMs: 0 });
ok('a name the checks file already answers is never asked again, and a new answer is remembered for the next pass', () => {
  assert.deepEqual(cacheAsked, ['BBB']);
  assert.equal(cachedRows[0].pct_change_today, 6.25);
  assert.equal(cachedRows[0].move_check, 'corrected');
  assert.equal(cachedRows[0].move_check_reason, undefined);
  assert.equal(cachedRows[1].pct_change_today, -6);
  assert.equal(cachedRows[1].move_check, 'confirmed');
  assert.equal(remembered.checks['BBB@2026-09-02'].prevDate, '2026-09-01');
  assert.deepEqual({ cached: cachedSummary.cached, requests: cachedSummary.requests, checked: cachedSummary.checked }, { cached: 1, requests: 1, checked: 1 });
});

const checksPath = join(mkdtempSync(join(tmpdir(), 'checks-')), 'price-move-checks.json');
ok('the checks file is written only when its answers change, so an empty pass makes no commit', () => {
  const store = { checks: { 'AAA@2026-09-02': { pct: 1, close: 101, prevClose: 100, prevDate: '2026-09-01', checkedAt: 'x' }, 'OLD@2026-08-01': { pct: 0, close: 1, prevClose: 1, prevDate: '2026-07-31', checkedAt: 'x' } } };
  assert.equal(saveChecks(checksPath, store, new Date('2026-09-02T19:00:00Z')), true);
  const written = JSON.parse(readFileSync(checksPath, 'utf8'));
  assert.deepEqual(Object.keys(written.checks), ['AAA@2026-09-02'], 'answers older than the keep window are pruned');
  assert.equal(saveChecks(checksPath, loadChecks(checksPath), new Date('2026-09-02T20:00:00Z')), false);
  assert.equal(JSON.parse(readFileSync(checksPath, 'utf8')).updated_at, written.updated_at, 'an unchanged pass leaves the file byte-for-byte');
  store.checks['BBB@2026-09-02'] = { pct: -2, close: 98, prevClose: 100, prevDate: '2026-09-01', checkedAt: 'y' };
  assert.equal(saveChecks(checksPath, store, new Date('2026-09-02T21:00:00Z')), true);
});

const lateRows = ['A', 'B', 'C', 'D', 'E'].map((ticker) => ({ ticker, bar_date: '2026-09-02', pct_change_today: 6 }));
const lateAsked = [];
const lateFetch = async (url) => {
  lateAsked.push(new URL(url).searchParams.get('ticker'));
  return { ok: true, status: 200, text: async () => 'Date, Open, High, Low, Close, Volume\n2026-08-31 00:00:00+05:30 | 1 | 1 | 1 | 100.0 | 1\n2026-09-01 00:00:00+05:30 | 1 | 1 | 1 | 101.0 | 1' };
};
const lateSummary = await verifyMoves(lateRows, { fetchImpl: lateFetch, sleep: async () => {}, now: () => 0, log: () => {}, spacingMs: 0 });
ok('a session the endpoint has not published yet stops the pass after a few answers, and every row says so', () => {
  assert.deepEqual(lateAsked, ['A', 'B', 'C']);
  assert.equal(lateSummary.date_unpublished, true);
  assert.equal(lateSummary.unavailable, 5);
  assert.equal(lateRows[0].move_check_reason, 'no close for 2026-09-02');
  assert.equal(lateRows[4].move_check_reason, '2026-09-02 not published by the endpoint yet');
  assert.equal(lateRows.every((row) => row.pct_change_today === 6 && row.move_check === 'unavailable'), true);
});

console.log('\n' + checks + ' price-bar checks passed.');
