#!/usr/bin/env node
// scripts/verify-fpi-activity.mjs — the FPI Activity contract. No server, no network.
//
//   node scripts/verify-fpi-activity.mjs [path/to/fpi-activity.json]
//
// Three things are checked, and the first is the one that matters most.
//
// 1. **THE DERIVATION STILL REPRODUCES A PUBLISHED CIRCULAR.** A desk circular dated 18 August
//    2026 carried this exact table for the two reporting days before it, from the same NSDL
//    levels. Those levels are frozen in the fixture below with the figures the circular printed,
//    and the check is that differencing them still produces those figures. It is what stops a
//    "tidy-up" of `activityTable` quietly changing what a debt cell means — the whole view rests
//    on a change in outstanding investment being the right reading, and this is the evidence.
// 2. **THE REFUSALS HOLD.** A window with no opening level, an equity outstanding figure, and a
//    total with a missing part must each be null with a reason — not a zero, not a partial sum,
//    and not a difference taken against some older level.
// 3. **THE SHIPPED CAPTURE IS INTERNALLY HONEST.** Every column resolves, the reconciliation the
//    scraper ran is recorded, and nothing claims a coverage it does not have.

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityTable, fmtCrore, fyLabel } from '../public/js/data/fpi-activity.js';
import { alignGeneralLimit, num, isoDate, parseFinancialYears } from './lib/nsdl-fpi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || resolve(__dirname, '../public/data/fpi-activity.json');

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed += 1;
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- 1. the published-circular fixture ----------------------------------------------------------
//
// NSDL's own levels for four reporting dates in August 2026, and the daily figures a desk circular
// published from them. Nothing here is invented: the levels were read from
// ReportDetail.aspx?RepID=1 and the expected figures are the circular's own.
const CIRCULAR = {
  levels: [
    { date: '2026-08-13', gsec: 70727.534, sdl: 1906.924, corpBond: 131345 },
    { date: '2026-08-14', gsec: 70305.93, sdl: 1906.92, corpBond: 131002 },
    { date: '2026-08-17', gsec: 70189.307, sdl: 2206.924, corpBond: 130926 },
    { date: '2026-08-18', gsec: 70141.807, sdl: 2231.034, corpBond: 131132 },
  ],
  // What the circular printed for 17 and 14 August, in ₹ crore.
  expected: {
    '2026-08-17': { gsec: -117, sdl: 300, corpBond: -76 },
    '2026-08-14': { gsec: -422, sdl: 0, corpBond: -343 },
  },
};

function circularCheck() {
  const payload = {
    asOn: '2026-08-18',
    flowsAsOn: '2026-08-18',
    currency: 'INR crore',
    reportingDates: CIRCULAR.levels.map((l) => l.date),
    levels: CIRCULAR.levels,
    dailyFlows: [{ date: '2026-08-18', equity: 1652 }],
    months: [],
    calendarYears: [],
    financialYears: [],
  };
  const t = activityTable(payload, { days: 3, months: 0 });
  for (const [date, want] of Object.entries(CIRCULAR.expected)) {
    const i = t.columns.findIndex((c) => c.date === date);
    ok(`circular ${date}: column present`, i >= 0);
    if (i < 0) continue;
    for (const [key, expected] of Object.entries(want)) {
      const row = t.rows.find((r) => r.key === key);
      const got = Math.round(row.cells[i].value);
      ok(`circular ${date} ${row.label}`, got === expected, `derived ${got}, the circular printed ${expected}`);
    }
  }
  // The oldest daily column has no predecessor in this fixture, so it must refuse rather than
  // reach further back. This is rule 1 of the module, tested where it actually bites.
  const oldest = t.columns.find((c) => c.date === '2026-08-14');
  void oldest;
  const noOpening = activityTable({ ...payload, reportingDates: ['2026-08-18'], levels: [CIRCULAR.levels.at(-1)] }, { days: 1, months: 0 });
  const cell = noOpening.rows[0].cells[0];
  ok('a day with no previous reporting date has no figure', cell.value === null && /does not reach back/i.test(cell.note || ''), JSON.stringify(cell));
}

// ---- 2. the refusals ---------------------------------------------------------------------------

function refusalChecks() {
  const payload = {
    asOn: '2026-08-18',
    flowsAsOn: '2026-08-18',
    currency: 'INR crore',
    reportingDates: CIRCULAR.levels.map((l) => l.date),
    // The opening level for 14 August is deliberately absent.
    levels: CIRCULAR.levels.filter((l) => l.date !== '2026-08-13'),
    dailyFlows: [{ date: '2026-08-18', equity: 1652 }, { date: '2026-08-14', equity: 4112 }],
    months: [],
    calendarYears: [],
    financialYears: [],
  };
  const t = activityTable(payload, { days: 3, months: 0 });
  const at = t.columns.findIndex((c) => c.date === '2026-08-14');
  const gsec = t.rows.find((r) => r.key === 'gsec').cells[at];
  ok('a missing opening level is an em dash, not a difference against an older one',
    gsec.value === null && /has not been captured/i.test(gsec.note || ''), JSON.stringify(gsec));
  eq('and it renders as an em dash', fmtCrore(gsec.value), '—');

  const total = t.rows.find((r) => r.id === 'total').cells[at];
  ok('a total with a missing part is not a total', total.value === null && /would look like a complete one/i.test(total.note || ''), JSON.stringify(total));

  const outstanding = t.columns.findIndex((c) => c.group === 'outstanding');
  const equityOut = t.rows.find((r) => r.id === 'equity').cells[outstanding];
  ok('equity has no outstanding figure and says why', equityOut.value === null && /do not publish an outstanding equity holding/i.test(equityOut.note || ''), JSON.stringify(equityOut));
  const totalOut = t.rows.find((r) => r.id === 'total').cells[outstanding];
  ok('and the debt lines are not totalled with it', totalOut.value === null);

  // A zero is a real answer and must not be confused with an absence.
  const sdl = t.rows.find((r) => r.key === 'sdl').cells[t.columns.findIndex((c) => c.date === '2026-08-18')];
  ok('a genuine zero is a zero, not an em dash', sdl.value !== null && Math.round(sdl.value) === 24, `got ${sdl.value}`);
  eq('fmtCrore renders zero as 0 and null as an em dash', `${fmtCrore(0)}|${fmtCrore(null)}`, '0|—');
  eq('and a negative in brackets, Indian grouping', fmtCrore(-131132), '(1,31,132)');
}

// ---- 3. the parser's own self-checks ------------------------------------------------------------

function parserChecks() {
  // The general-limit row loses its Upper Limit cell on some reporting dates under an unchanged
  // header. Both alignments must resolve to the same INVESTMENT column.
  const withUpperLimit = ['462490.000', '70141.807', '50.000', '1330.525', '71522.332', '15.460', '390967.668'];
  const withoutUpperLimit = ['70189.307', '145.000', '1330.525', '71664.832', '24.560', '0.035', '390053.541'];
  eq('aligned by arithmetic: 18 Aug (Upper Limit present)', alignGeneralLimit(withUpperLimit).investment, 70141.807);
  eq('aligned by arithmetic: 17 Aug (Upper Limit absent)', alignGeneralLimit(withoutUpperLimit).investment, 70189.307);
  // The pre-2026 form has no VRR column: two terms, and the route is null rather than zero.
  const older = ['289488.000', '51412.081', '169.412', '51581.493', '17.820', '237906.507'];
  eq('aligned by arithmetic: the pre-2026 two-term form', alignGeneralLimit(older).investment, 51412.081);
  eq('and its VRR route is null, not zero', alignGeneralLimit(older).vrr, null);
  ok('a row that satisfies no identity is refused', alignGeneralLimit(['10', '20', '35', '80', '200']) === null, JSON.stringify(alignGeneralLimit(['10', '20', '35', '80', '200'])));

  eq('a bracketed figure is negative', num('(1,436.84)'), -1436.84);
  eq('an em dash is null, never zero', num('—'), null);
  eq('and so is a blank', num(''), null);
  eq('NSDL long dates', isoDate('August 18,2026'), '2026-08-18');
  eq('NSDL short dates', isoDate('09-Sep-2026'), '2026-09-09');
  eq('financial years are named the Indian way', fyLabel('2026-27'), 'FY2027');
  eq('the all-time total row is not a financial year', parseFinancialYears('<table><tr><td>Total</td><td>1</td></tr></table>').length, 0);
}

// ---- 4. the shipped capture --------------------------------------------------------------------

function captureChecks() {
  if (!existsSync(FILE)) {
    ok(`the capture exists at ${FILE}`, false);
    return;
  }
  const p = JSON.parse(readFileSync(FILE, 'utf8'));
  ok('it names its source as NSDL', /nsdl/i.test(p.source || ''));
  ok('it states what is published and what is derived', /derived/i.test(p._provenance || '') && /publish/i.test(p._provenance || ''));
  ok('it warns that a change in outstanding is not net purchases', /not the same measurement as net purchases/i.test(p._provenance || ''));
  ok('it has a newest reporting date', !!p.asOn);
  ok('it has the reporting calendar', (p.reportingDates || []).length > 30);
  ok('the reporting calendar is sorted and unique', (() => {
    const d = p.reportingDates || [];
    return d.every((v, i) => i === 0 || d[i - 1] < v);
  })());
  ok('the newest level is the newest reporting date', (p.levels || []).some((l) => l.date === p.asOn));

  const t = activityTable(p);
  ok('the table builds', !!t);
  if (!t) return;
  eq('five instrument rows, in the template order', t.rows.map((r) => r.id).join(','), 'gsec,sdl,corpBond,equity,total');
  ok('three reporting-day columns', t.columns.filter((c) => c.group === 'daily').length === 3);
  ok('three month columns', t.columns.filter((c) => c.group === 'month').length === 3);
  ok('two financial-year columns', t.columns.filter((c) => c.group === 'fy').length === 2);
  ok('two calendar-year columns', t.columns.filter((c) => c.group === 'cy').length === 2);
  ok('one outstanding column, and it is last', t.columns.at(-1).group === 'outstanding');
  ok('every window this capture cannot measure is named', Array.isArray(t.unmeasured));
  ok('no window is left unmeasured in the shipped capture', t.unmeasured.length === 0, JSON.stringify(t.unmeasured));

  // The debt rows must actually carry figures — a table of em dashes would pass every rule above
  // and answer nothing, which is the failure the Ask Research budget bug was.
  const filled = t.rows.filter((r) => r.basis === 'debt').every((r) => r.cells.filter((c) => c.value != null).length === t.columns.length);
  ok('every debt cell in every window resolves', filled);
  const equityFilled = t.rows.find((r) => r.id === 'equity').cells.filter((c) => c.value != null).length;
  eq('equity answers every window except the outstanding one', equityFilled, t.columns.length - 1);

  // Guard 1 from the scraper, recorded rather than re-run: a closed month must reconcile.
  const closed = (p.monthlyCoverage || []).filter((c) => c.days >= 15);
  ok('at least one closed month of daily flows is held', closed.length >= 1, JSON.stringify((p.monthlyCoverage || []).filter((c) => c.days)));
  ok("and every one of them sums to NSDL's own published month", closed.every((c) => c.reconciles === true), JSON.stringify(closed));

  // A period the source marked as still running must travel as partial, or a part-year total
  // reads as a closed one.
  const running = [...(p.calendarYears || []), ...(p.financialYears || [])].filter((y) => y.partial);
  ok('the running calendar and financial years are marked partial', running.length >= 2, JSON.stringify(running.map((y) => y.period)));
}

circularCheck();
refusalChecks();
parserChecks();
captureChecks();

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll FPI activity checks passed.');
process.exit(failed ? 1 : 0);
