#!/usr/bin/env node
// Focused checks for the price-bar rules behind the technicals scrape and the ±5% price alert.
// Dependency-free by repository contract. Run: node scripts/verify-bars.mjs

import assert from 'node:assert/strict';
import { completedBars, dayMove, istDay, MAX_DAY_MOVE_GAP_DAYS } from './lib/yahoo.mjs';
import { parseMarketData, moveFromBars, verifyMoves } from './lib/muns-market-data.mjs';

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
  MACPOWER: 'Error: Too Many Requests. Rate limited. Try after a while.',
  NEAR: 'Date, Open, High, Low, Close, Volume\n2026-09-01 00:00:00+05:30 | 1 | 1 | 1 | 100.0 | 1\n2026-09-02 00:00:00+05:30 | 1 | 1 | 1 | 104.2 | 1',
};
const asked = [];
const fetchImpl = async (url) => {
  const ticker = new URL(url).searchParams.get('ticker');
  asked.push(ticker);
  return { ok: true, status: 200, text: async () => bodies[ticker] || '' };
};
const summary = await verifyMoves(rows, { fetchImpl, sleep: async () => {}, log: () => {} });
ok('flagged moves are re-derived from the endpoint, a refusal leaves the figure and says so, calm rows are never asked about', () => {
  assert.deepEqual(asked, ['HEROMOTOCO', 'MACPOWER', 'MACPOWER', 'NEAR'], 'one retry after the rate-limit answer, then the next name');
  assert.equal(rows[0].pct_change_today, -4.59);
  assert.equal(rows[0].move_check, 'corrected');
  assert.equal(rows[0].move_prev_date, '2026-09-01');
  assert.equal(rows[1].pct_change_today, -5.66);
  assert.equal(rows[1].move_check, 'unavailable');
  assert.equal(rows[1].move_check_reason, 'rate-limited');
  assert.equal(rows[2].move_check, undefined);
  assert.equal(rows[3].move_check, 'confirmed');
  assert.deepEqual({ flagged: summary.flagged, checked: summary.checked, corrected: summary.corrected, confirmed: summary.confirmed, unavailable: summary.unavailable }, { flagged: 3, checked: 2, corrected: 1, confirmed: 1, unavailable: 1 });
});

console.log('\n' + checks + ' price-bar checks passed.');
