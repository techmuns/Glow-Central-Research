// data/fpi-activity.js — FPI ACTIVITY, read side. GLOW-OWNED.
//
//   load() / isLoaded() / index() / meta()      the committed capture
//   activityTable()                             the template table: rows × period columns
//   fmtCrore() / toneOf()                       the shared cell formatting
//
// WHERE IT COMES FROM. `public/data/fpi-activity.json` is written by
// `scripts/scrape-fpi-activity.mjs` from NSDL's FPI Monitor — the depository that publishes
// India's foreign-portfolio-investment statistics — and refreshed by
// `.github/workflows/fpi-activity-refresh.yml`. Read that scraper's header before changing
// anything here; the rules it captures under are the rules this file renders under.
//
// TWO KINDS OF FIGURE SHARE THIS TABLE AND THEY ARE NOT THE SAME MEASUREMENT:
//
//   EQUITY is NSDL's own NET INVESTMENT, published for the day, the month, the financial year and
//   the calendar year. Nothing here adds it up; every equity cell is a number NSDL printed.
//
//   DEBT is the CHANGE IN OUTSTANDING INVESTMENT — NSDL publish what FPIs hold in central
//   government securities, state development loans and corporate bonds on each reporting date, and
//   a window's figure is the difference between its closing and opening level. A maturity moves
//   that too, so it is close to net buying but is not the same statement, and every surface that
//   shows one says which it is.
//
// THREE THINGS THIS MODULE REFUSES TO DO, each of which is a rule this codebase already runs on:
//
//   1. **A WINDOW WHOSE OPENING LEVEL IS NOT HELD HAS NO FIGURE.** It is an em dash naming the
//      missing reporting date — never a difference taken against whatever older level happens to
//      be nearest, which would silently span sessions and read as one day's trading. Same failure
//      `dayMove` in `scripts/lib/yahoo.mjs` exists to prevent.
//   2. **A TOTAL WITH A MISSING PART IS NOT A TOTAL.** `Debt + Equity` is null unless every row
//      above it answered for that window. A sum over three of four rows is a smaller number that
//      looks like a complete one.
//   3. **EQUITY HAS NO OUTSTANDING FIGURE.** This report does not publish one, so that cell is an
//      em dash saying so — not a zero, and not a figure borrowed from a different report that
//      would then be differenced against nothing.

import { revalidatedJson } from '../core/store.js';

const FILE = 'data/fpi-activity.json';
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let capture = null;
let loading = null;
let origin = null;

/**
 * Fetch the capture once. NEVER REJECTS: a file that cannot be read leaves `index()` null and the
 * view renders a named failure rather than an empty table, exactly as the series store does.
 */
export function load() {
  if (capture) return Promise.resolve(capture);
  if (!loading) {
    loading = revalidatedJson(FILE)
      .then((payload) => {
        if (payload && Array.isArray(payload.levels)) {
          capture = payload;
          origin = 'snapshot';
        }
        return capture;
      })
      .catch(() => null)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export const isLoaded = () => !!capture;
export const index = () => capture;

export function meta() {
  return {
    capturedAt: capture?.capturedAt ?? null,
    asOn: capture?.asOn ?? null,
    flowsAsOn: capture?.flowsAsOn ?? null,
    currency: capture?.currency ?? 'INR crore',
    source: capture?.source ?? null,
    reports: capture?.reports ?? {},
    levels: capture?.levels?.length ?? 0,
    archive: capture?.archive ?? null,
    failed: capture?.failed ?? [],
    origin,
  };
}

// ---- formatting --------------------------------------------------------------------------------

/**
 * Whole crore, Indian grouping, a negative in parentheses — the convention every desk circular
 * carrying this table uses, and the one the reader asked for. `null` is an em dash and NEVER a
 * zero: this dashboard has been bitten by that collapse in four other feeds.
 */
export function fmtCrore(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = Math.round(v);
  if (n === 0) return '0';
  const grouped = Math.abs(n).toLocaleString('en-IN');
  return n < 0 ? `(${grouped})` : grouped;
}

export const toneOf = (v) => (v == null || !Number.isFinite(v) || v === 0 ? 'text-slate-500' : v < 0 ? 'text-rose-700' : 'text-slate-900');

/**
 * What a row's figures ARE, in one phrase — for the CSV's own column and the workbook's. Both
 * exports read it from here rather than each spelling it out, because a workbook leaves the page
 * without its chrome and the two must not be able to describe the same row differently.
 */
export const basisLabel = (basis) =>
  ({
    debt: 'change in outstanding investment (derived)',
    debtTotal: 'the three debt lines added (derived)',
    equity: 'net investment (NSDL, published)',
    total: 'the debt lines and equity added',
  })[basis] || basis || '';

const shortDate = (iso) => (iso ? `${iso.slice(8)}-${MONTH_ABBR[Number(iso.slice(5, 7)) - 1]}-${iso.slice(2, 4)}` : '—');
const shortMonth = (period) => `${MONTH_ABBR[Number(period.slice(5, 7)) - 1]}-${period.slice(2, 4)}`;

/** `2026-27` → `FY2027`, the way an Indian desk names it. */
export const fyLabel = (period) => `FY${period.slice(0, 2)}${period.slice(-2)}`;

// ---- the table ----------------------------------------------------------------------------------

// The instrument lines, in the order the reference template prints them. G-Sec is ONE line: the
// central government securities held on the general investment route. The long-term investor
// category, the coupon re-investment limit and the FAR route are separate limits with their own
// utilisation and are deliberately not folded in — adding two limits together would make a
// reallocation between them read as a purchase. `note` is what the footnote says about each.
export const DEBT_ROWS = [
  { id: 'gsec', key: 'gsec', label: 'G Sec', sub: 'Central government · general route' },
  { id: 'sdl', key: 'sdl', label: 'SDLs', sub: 'State development loans' },
  { id: 'corpBond', key: 'corpBond', label: 'Corp Bonds', sub: 'General route' },
];

const lastOnOrBefore = (dates, boundary) => {
  let out = null;
  for (const d of dates) if (d <= boundary) out = d; else break;
  return out;
};

const previousReportingDate = (dates, date) => {
  const at = dates.indexOf(date);
  return at > 0 ? dates[at - 1] : null;
};

/**
 * The columns the template carries, oldest window last, mirroring the reference layout: the three
 * newest reporting days, the three newest months, the current and previous financial year, the
 * current and previous calendar year, and the outstanding holding now.
 *
 * `start` and `end` are the reporting dates a DEBT figure is differenced across; `period` is the
 * key an EQUITY figure is looked up under. A column carries both because the two rows answer the
 * same window from different reports.
 */
function buildColumns(payload, { days = 3, months = 3 } = {}) {
  const dates = payload.reportingDates || [];
  const newest = payload.asOn;
  const cols = [];

  for (const date of dates.slice(-days).reverse()) {
    cols.push({ id: `d:${date}`, group: 'daily', label: shortDate(date), date, start: previousReportingDate(dates, date), end: date });
  }

  const monthsHeld = [...new Set(dates.map((d) => d.slice(0, 7)))].sort().slice(-months).reverse();
  for (const period of monthsHeld) {
    const inMonth = dates.filter((d) => d.startsWith(period));
    cols.push({
      id: `m:${period}`,
      group: 'month',
      label: shortMonth(period),
      period,
      // The opening level of a month is the last reporting date BEFORE it, reached by asking for
      // day zero — a boundary no real date can equal, so it can never pick a date inside the very
      // month it is opening.
      start: lastOnOrBefore(dates, `${period}-00`),
      end: inMonth.at(-1) ?? null,
    });
  }

  const fys = (payload.financialYears || []).filter((f) => f.period).slice(-2).reverse();
  for (const fy of fys) {
    const startYear = Number(fy.period.slice(0, 4));
    cols.push({
      id: `fy:${fy.period}`,
      group: 'fy',
      label: fyLabel(fy.period),
      period: fy.period,
      partial: !!fy.partial,
      start: lastOnOrBefore(dates, `${startYear}-03-31`),
      end: fy.partial ? newest : lastOnOrBefore(dates, `${startYear + 1}-03-31`),
    });
  }

  const cys = (payload.calendarYears || []).filter((c) => c.period).slice(-2).reverse();
  for (const cy of cys) {
    const year = Number(cy.period);
    cols.push({
      id: `cy:${cy.period}`,
      group: 'cy',
      label: `CY ${cy.period}`,
      period: cy.period,
      partial: !!cy.partial,
      start: lastOnOrBefore(dates, `${year - 1}-12-31`),
      end: cy.partial ? newest : lastOnOrBefore(dates, `${year}-12-31`),
    });
  }

  cols.push({ id: 'outstanding', group: 'outstanding', label: 'Outstanding Investment', end: newest });
  return cols;
}

const cell = (value, note) => ({ value, note: note ?? null });

/**
 * The whole table: `{ columns, rows, groups, asOn, flowsAsOn }`, or null when the capture did not
 * load. Pure over the payload, so `scripts/verify-fpi-activity.mjs` asserts the windows and the
 * refusals directly rather than through a browser.
 */
export function activityTable(payload = capture, options = {}) {
  if (!payload || !Array.isArray(payload.levels) || !payload.levels.length) return null;
  const columns = buildColumns(payload, options);
  const levelAt = new Map(payload.levels.map((l) => [l.date, l]));
  const dailyAt = new Map((payload.dailyFlows || []).map((f) => [f.date, f]));
  const monthAt = new Map((payload.months || []).map((m) => [m.period, m]));
  const fyAt = new Map((payload.financialYears || []).map((f) => [f.period, f]));
  const cyAt = new Map((payload.calendarYears || []).map((c) => [c.period, c]));

  // ---- a debt row: the change in the published outstanding investment across the window --------
  const debtCell = (col, key) => {
    if (col.group === 'outstanding') {
      const level = levelAt.get(col.end);
      return level && level[key] != null
        ? cell(level[key], `NSDL's published outstanding investment on ${col.end}.`)
        : cell(null, `No level captured for ${col.end || 'the newest reporting date'}.`);
    }
    const open = col.start ? levelAt.get(col.start) : null;
    const close = col.end ? levelAt.get(col.end) : null;
    if (!col.start) return cell(null, 'The reporting calendar in this capture does not reach back to the start of this window.');
    if (!open || open[key] == null) return cell(null, `The opening level for ${col.start} has not been captured, so this window cannot be measured. It is not differenced against an earlier date.`);
    if (!close || close[key] == null) return cell(null, `The closing level for ${col.end} has not been captured.`);
    return cell(close[key] - open[key], `Change in outstanding investment, ${col.start} → ${col.end}. NSDL publish the two levels; the difference is derived and is not the same measurement as net purchases.`);
  };

  // ---- the equity row: NSDL's own published net investment, never summed here ------------------
  const equityCell = (col) => {
    if (col.group === 'outstanding') return cell(null, 'NSDL do not publish an outstanding equity holding on these reports, so there is no figure to show. This is not a zero.');
    const from = { daily: dailyAt.get(col.date), month: monthAt.get(col.period), fy: fyAt.get(col.period), cy: cyAt.get(col.period) }[col.group];
    if (!from || from.equity == null) return cell(null, `NSDL's net investment for this window is not in the capture.`);
    const where = { daily: 'the Daily Trends report', month: 'the calendar-year report', fy: 'the financial-year report', cy: 'the calendar-year report' }[col.group];
    return cell(from.equity, `NSDL's published net investment in equity for this window, from ${where}${col.partial ? ' — the period has not closed' : ''}.`);
  };

  const debtRows = DEBT_ROWS.map((r) => ({
    ...r,
    basis: 'debt',
    cells: columns.map((c) => debtCell(c, r.key)),
  }));
  const equityRow = { id: 'equity', label: 'Equity', sub: 'Net investment (NSDL)', basis: 'equity', cells: columns.map(equityCell) };

  /**
   * Add named rows for one column. **THE SOURCE ROWS ARE PASSED IN, NEVER TAKEN AS "EVERY ROW SO
   * FAR"** — with a subtotal on the table, a total built from whatever precedes it would add the
   * three debt lines and then add their own subtotal again, doubling the debt half of the headline.
   * Nothing would throw and every figure would look plausible, which is this codebase's whole
   * catalogue of quiet arithmetic failures in one line.
   */
  const addUp = (source, i, note, whenMissing) => {
    const parts = source.map((r) => r.cells[i].value);
    if (parts.some((v) => v == null)) return cell(null, whenMissing);
    return cell(parts.reduce((n, v) => n + v, 0), note);
  };

  // ---- Total Debt — the one total here that DOES carry an outstanding figure ---------------------
  //
  // Every part of it is a published level, so summing them across the outstanding column is a sum
  // of three figures NSDL printed. That is why this row's holding is a number where the headline's
  // is an em dash: the difference is not the arithmetic, it is that equity has no level to add.
  const totalDebtRow = {
    id: 'totalDebt',
    label: 'Total Debt',
    sub: 'The three lines above, added',
    basis: 'debtTotal',
    subtotal: true,
    cells: columns.map((c, i) =>
      addUp(
        debtRows,
        i,
        c.group === 'outstanding'
          ? "NSDL's published outstanding investment in the three instruments above, added. It is the general investment route only — the long-term investor category, the coupon re-investment limit, VRR and FAR are separate limits and are not in it."
          : 'The three debt lines added. Each is a change in outstanding investment across this window, which a maturity or redemption also moves, so this is not the same measurement as net purchases.',
        'One of the three debt lines has no figure for this window, so there is no total. A sum over part of them would look like a complete one.',
      ),
    ),
  };

  // ---- the headline: null wherever any part of it is --------------------------------------------
  const grandTotalRow = {
    id: 'total',
    label: 'Debt + Equity',
    sub: 'Total Debt and Equity, added',
    // The template's headline line. It is the only row on the page that mixes a derived debt
    // figure with a published equity one, which is why its own note says so rather than letting
    // the reader assume both halves were measured the same way.
    basis: 'total',
    total: true,
    cells: columns.map((c, i) => {
      if (c.group === 'outstanding') return cell(null, 'Equity has no outstanding figure on these reports, so it cannot be added to the debt holding above. The debt half alone is on the Total Debt row.');
      return addUp(
        [...debtRows, equityRow],
        i,
        'The three debt lines and the equity line added. The debt half is a change in outstanding investment and the equity half is a published net investment; they are added here as the reference template does, and they are not the same measurement.',
        'One of the rows above has no figure for this window, so there is no total. A sum over part of the table would look like a complete one.',
      );
    }),
  };

  const rows = [...debtRows, totalDebtRow, equityRow, grandTotalRow];

  return {
    columns,
    rows,
    asOn: payload.asOn,
    flowsAsOn: payload.flowsAsOn,
    currency: payload.currency || 'INR crore',
    // A window this capture could not open, named — so the coverage line can say so rather than
    // leaving the reader to wonder why a column is empty.
    unmeasured: columns.filter((c) => c.group !== 'outstanding' && (!c.start || !levelAt.has(c.start))).map((c) => ({ column: c.label, missing: c.start || 'the start of the window' })),
  };
}
