// The Private Market funding table's period: quick picks and a From–To range on the deal's own
// funding date. Offline; no server.
import assert from 'node:assert/strict';
import { PERIOD_PICKS, istToday, monthsBefore, fundingDay, parseRange, rangeValue, normalizePeriod,
  periodBounds, periodMatcher, rangeLabel, isIsoDay, latestWeekEnd } from '../public/js/data/funding-period.js';

assert.deepEqual(PERIOD_PICKS.map(p => p.value), ['latest', '1m', '3m', '6m', '12m', 'all']);
// IST, not UTC: 20:00 UTC on 11 Nov is already 12 Nov in India.
assert.equal(istToday(Date.parse('2026-11-11T20:00:00Z')), '2026-11-12');
assert.equal(monthsBefore('2026-11-12', 1), '2026-10-12');
assert.equal(monthsBefore('2026-11-12', 12), '2025-11-12');
assert.equal(monthsBefore('2026-03-31', 1), '2026-02-28', 'A short month clamps rather than overflowing into March');
assert.equal(monthsBefore('2024-03-31', 1), '2024-02-29');
assert.equal(monthsBefore('2026-01-15', 3), '2025-10-15');
assert(!isIsoDay('2026-02-30') && isIsoDay('2026-02-28'));

// The deal's own date first; the roundup's IST publication day only where the source printed none.
assert.equal(fundingDay({ dateISO: '2026-10-16', publishedAt: '2026-10-17T09:00:00+05:30' }), '2026-10-16');
assert.equal(fundingDay({ dateISO: null, publishedAt: '2026-10-17T00:30:00+05:30' }), '2026-10-17');
assert.equal(fundingDay({}), '');

assert.equal(rangeValue('2026-09-01', '2026-10-01'), 'range:2026-09-01:2026-10-01');
assert.equal(rangeValue('2026-10-01', '2026-09-01'), 'range:2026-09-01:2026-10-01', 'Reversed ends swap');
assert.equal(rangeValue('', ''), 'all');
assert.equal(rangeValue('2026-09-01', ''), 'range:2026-09-01:');
assert.equal(rangeValue('garbage', '2026-09-01'), 'range::2026-09-01');
assert.equal(parseRange('range::'), null);
assert.equal(parseRange('range:2026-13-01:'), null);
assert.equal(normalizePeriod('2025'), 'range:2025-01-01:2025-12-31', 'A saved roundup-year reading becomes that calendar year');
assert.equal(normalizePeriod('3m'), '3m');
assert.equal(normalizePeriod('month'), '1m', 'A saved Last 30 days reading becomes Last 1 month');
assert.deepEqual(periodBounds('3m', '2026-11-12'), { from: '2026-08-12', to: '2026-11-12' });
assert.equal(periodBounds('all', '2026-11-12'), null);
assert.match(rangeLabel('range:2026-09-01:2026-10-01'), /^1 Sept? 2026 – 1 Oct 2026$/);
assert.match(rangeLabel('range:2026-09-01:'), /^From /);
assert.match(rangeLabel('range::2026-09-01'), /^Up to /);

const rows = [
  { id: 'a', dateISO: '2026-11-10', sourceUrl: 'L' },
  { id: 'b', dateISO: '2026-10-12', sourceUrl: 'X' },
  { id: 'c', dateISO: '2026-08-11', sourceUrl: 'X' },
  { id: 'd', dateISO: '2025-11-12', sourceUrl: 'X' },
  { id: 'e', dateISO: '2020-01-01', sourceUrl: 'X' },
  { id: 'f', dateISO: null, publishedAt: null, sourceUrl: 'X' },
];
assert.equal(latestWeekEnd([...rows, { dateISO: '2026-12-01' }], '2026-11-12'), '2026-11-10', 'A future-dated deal never moves the latest week');
assert.equal(latestWeekEnd([], '2026-11-12'), '2026-11-12');
assert.deepEqual(periodBounds('latest', '2026-11-12', '2026-11-10'), { from: '2026-11-04', to: '2026-11-10' });
const match = periodMatcher({ today: '2026-11-12', weekEnd: '2026-11-10' });
const pick = v => rows.filter(r => match(r, v)).map(r => r.id).join('');
assert.equal(pick('all'), 'abcdef', 'All keeps an undated row');
assert.equal(pick('latest'), 'a', 'Latest week is the seven days ending on the newest deal date');
assert.equal(pick('1m'), 'ab', 'Both ends are inclusive');
assert.equal(pick('3m'), 'ab', '11 Aug is outside three months of 12 Nov');
assert.equal(pick('6m'), 'abc');
assert.equal(pick('12m'), 'abcd');
assert.equal(pick('range:2026-08-11:2026-10-12'), 'bc');
assert.equal(pick('range::2021-01-01'), 'e');
assert.equal(pick('range:2026-11-01:'), 'a');
console.log('PASS funding period: IST today, month arithmetic, deal date before roundup date, inclusive ranges, quick picks and legacy year readings.');
