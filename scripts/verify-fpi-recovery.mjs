import assert from 'node:assert/strict';
import { flowMonthsToRefresh } from './scrape-fpi-activity.mjs';
const days = period => Array.from({ length: 20 }, (_, i) => ({ date: `${period}-${String(i + 1).padStart(2, '0')}`, equity: i }));
const current = [{ date: '2026-10-01', equity: 1 }];
const retained = { dailyFlows: [...days('2026-08'), ...days('2026-09')],
  months: [{ period: '2026-08', partial: false }, { period: '2026-09', partial: true }],
  monthlyCoverage: [{ period: '2026-08', days: 20, reconciles: true }, { period: '2026-09', days: 20, reconciles: true }] };
assert.deepEqual(flowMonthsToRefresh(retained, current, '2026-10-01'), ['2026-09'],
  'an earlier complete month must not strand the latest month at its pre-close capture');
retained.months[1].partial = false;
assert.deepEqual(flowMonthsToRefresh(retained, current, '2026-10-01'), []);
retained.monthlyCoverage[0].reconciles = false;
assert.deepEqual(flowMonthsToRefresh(retained, current, '2026-10-01'), ['2026-08'], 'an older mismatch remains recoverable');
assert.deepEqual(flowMonthsToRefresh(null, current, '2026-10-01'), ['2026-09']);
assert.deepEqual(flowMonthsToRefresh(null, [{ date: '2027-01-02' }], '2027-01-02'), ['2026-12']);
assert.deepEqual(flowMonthsToRefresh({ ...retained, months: days('2026-07').slice(0, 4).map((_, i) => ({ period: `2026-0${i + 1}`, partial: true })),
  dailyFlows: ['2026-01','2026-02','2026-03','2026-04'].flatMap(days) }, current, '2026-10-01'), ['2026-01','2026-02'], 'repair source work is bounded');
console.log('PASS FPI month rollover, retained-month reconciliation recovery, year boundary and bounded source reads');
