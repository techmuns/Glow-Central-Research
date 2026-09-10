#!/usr/bin/env node
// scripts/scrape-fpi-activity.mjs — THE FPI ACTIVITY CAPTURE. GLOW-OWNED.
//
//   node scripts/scrape-fpi-activity.mjs
//
// Writes public/data/fpi-activity.json, behind the FPI Activity view on Macro Research: what
// foreign portfolio investors bought and sold in Indian government securities, state development
// loans, corporate bonds and equities — for the last three reporting days, the last three months,
// the current and previous financial and calendar years, and the outstanding debt they hold now.
//
// EVERY FIGURE IS NSDL'S. This script reads four of their reports and writes down what they say;
// it computes exactly one thing, and says so on every surface that shows it (see below).
//
// ── WHY IT ONLY EVER FETCHES A DOZEN PAGES ──────────────────────────────────────────────────────
//
// The debt side is published as a LEVEL — "FPIs hold ₹70,464 crore of central government
// securities today" — one page per reporting date, archived back to 2011. A flow over any window
// is the difference of two levels, so a table of eleven columns needs about a dozen levels, not
// one per trading day: the three newest reporting dates and their predecessors, the last
// reporting date of each recent month, and the last reporting date on or before each financial
// and calendar year boundary. `wantedLevelDates` is that list and nothing else is asked for.
//
// Each page is about a megabyte, so this matters. It also means a cold start is complete on its
// first run rather than needing months of accumulation — and every level, once captured, is
// retained for ever, because a past reporting date's published holding does not change.
//
// ── WHAT IS DERIVED, AND WHAT IS NOT ────────────────────────────────────────────────────────────
//
//   DEBT     derived. The change in NSDL's published outstanding investment between two reporting
//            dates. It is not the same measurement as net purchases — a maturity moves it too —
//            and the view says so in those words wherever a debt figure appears.
//   EQUITY   published. NSDL's own net investment, daily from the Daily Trends report and by
//            month, financial year and calendar year from the year-wise reports. Nothing summed.
//
// The two are never described in the same words, and the equity row carries no outstanding figure
// at all, because this report does not publish one. An em dash there is the honest answer.
//
// ── THREE GUARDS ────────────────────────────────────────────────────────────────────────────────
//
// 1. **THE DAILY FLOWS RECONCILE TO THE PUBLISHED MONTH, OR THE MONTH IS NOT MARKED COMPLETE.**
//    NSDL publish both, so summing our captured days and comparing is a check on every day above
//    it — a dropped or double-counted date moves the sum. Measured on August 2026: all six
//    categories agree to the crore. This is the same rule `import-mf-weekly.mjs` runs on, and the
//    same reason: the figure that ships is always the published one, and the recomputation is the
//    parse check.
// 2. **A BAD READ KEEPS THE RETAINED FILE.** Levels and flows are merged into what is already
//    committed; nothing captured is ever retracted by a run that read less. A run that cannot
//    reach the newest reporting date exits 2 — a refusal is not a broken scraper — and a run that
//    parses a page into a shape it cannot align exits 1, because that is a human's problem.
// 3. **AN ABSENT LEVEL IS ABSENT.** A window whose opening level was not captured has no figure,
//    and the view renders an em dash naming the missing date. It is never differenced against
//    whatever older level happens to be nearest, which would span sessions and read as one day's
//    trading — the failure `dayMove` in `scripts/lib/yahoo.mjs` exists to prevent, one feed over.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEBT_UTILISATION_URL, DAILY_TRENDS_URL, DAILY_TRENDS_ARCHIVE_URL, CALENDAR_YEAR_URL, FINANCIAL_YEAR_URL,
  fetchReport, hiddenFields, formBody, archivePostBody, calendarYearPostBody,
  parseArchiveDates, parseDebtOutstanding, parseDailyTrends, parseCalendarYear, parseFinancialYears,
} from './lib/nsdl-fpi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '../public/data/fpi-activity.json');

const LEVEL_LIMIT = Number(process.env.FPI_LEVEL_LIMIT ?? 16); // archived debt pages per run
const MONTH_COLUMNS = Number(process.env.FPI_MONTHS ?? 3);
const RECENT_DAYS = Number(process.env.FPI_RECENT ?? 5);
// The browser needs the reporting CALENDAR to know which date precedes which; two years of it is
// a few kilobytes and covers every window the table draws.
const CALENDAR_FROM = process.env.FPI_CALENDAR_FROM || `${new Date().getUTCFullYear() - 2}-01-01`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const lastOnOrBefore = (dates, boundary) => dates.filter((d) => d <= boundary).at(-1) ?? null;

/**
 * The financial year an ISO date falls in, Indian convention: 1 April to 31 March, named by both
 * years — `2026-27` for April 2026 to March 2027.
 */
export const financialYearOf = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

/**
 * Which reporting dates this capture needs a debt level for, newest first. Pure, so
 * `verify-fpi-activity.mjs` can assert the window boundaries without a network.
 *
 * `asc` is every reporting date NSDL still serves, ascending.
 */
export function wantedLevelDates(asc, { months = MONTH_COLUMNS, recent = RECENT_DAYS } = {}) {
  if (!asc.length) return [];
  const newest = asc.at(-1);
  const want = new Set(asc.slice(-Math.max(recent + 1, 2)));

  // The last reporting date of each recent month, plus the one before the earliest of them, so the
  // oldest month column has an opening level too.
  const monthOf = (d) => d.slice(0, 7);
  const monthsSeen = [...new Set(asc.map(monthOf))].sort();
  for (const period of monthsSeen.slice(-(months + 1))) {
    const inMonth = asc.filter((d) => monthOf(d) === period);
    if (inMonth.length) want.add(inMonth.at(-1));
  }

  // Financial and calendar year boundaries: the CLOSING level of a finished year is the last
  // reporting date on or before its end, and it doubles as the OPENING level of the next.
  const year = Number(newest.slice(0, 4));
  const fyStart = Number(financialYearOf(newest).slice(0, 4));
  for (const boundary of [
    `${year - 2}-12-31`, `${year - 1}-12-31`,          // calendar years: previous and the one before
    `${fyStart - 1}-03-31`, `${fyStart}-03-31`,        // financial years: current and previous opening
  ]) {
    const anchor = lastOnOrBefore(asc, boundary);
    if (anchor) want.add(anchor);
  }
  return [...want].sort().reverse();
}

const readRetained = () => {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
};

/** Merge by date, newest read winning, ascending out. Nothing already held is ever dropped. */
function mergeByDate(retained, fresh) {
  const by = new Map((retained || []).filter((r) => r?.date).map((r) => [r.date, r]));
  for (const row of fresh) if (row?.date) by.set(row.date, { ...by.get(row.date), ...row });
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const mergeByPeriod = (retained, fresh) => {
  const by = new Map((retained || []).filter((r) => r?.period).map((r) => [r.period, r]));
  for (const row of fresh) if (row?.period) by.set(row.period, row);
  return [...by.values()].sort((a, b) => a.period.localeCompare(b.period));
};

async function main() {
  const retained = readRetained();
  const failed = [];
  const note = (what, err) => {
    const reason = err?.reason || 'error';
    failed.push({ what, reason, message: String(err?.message || err).slice(0, 300) });
    console.error(`  ! ${what}: [${reason}] ${err?.message || err}`);
  };

  // ---- 1. the debt utilisation report, its archive calendar, and today's level -----------------
  console.log('NSDL FPI — reading the Debt Utilisation Status');
  const base = await fetchReport(DEBT_UTILISATION_URL);
  const archive = parseArchiveDates(base); // newest first, { id, date }
  if (!archive.length) {
    console.error('The archive dropdown is empty — this is not the Debt Utilisation report. Retained file unchanged.');
    process.exit(1);
  }
  const asc = archive.map((a) => a.date).sort();
  const idFor = new Map(archive.map((a) => [a.date, a.id]));
  const newest = asc.at(-1);
  console.log(`  ${archive.length} reporting dates archived, newest ${newest}`);

  const levels = new Map((retained?.levels || []).filter((r) => r?.date).map((r) => [r.date, r]));
  const current = parseDebtOutstanding(base); // throws on an unalignable shape — see the header
  levels.set(current.date, current);

  const wanted = wantedLevelDates(asc);
  const missing = wanted.filter((d) => !levels.has(d) && idFor.has(d));
  console.log(`  ${wanted.length} level dates wanted, ${missing.length} not yet captured`);
  let fetched = 0;
  for (const date of missing) {
    if (fetched >= LEVEL_LIMIT) {
      // Newest-first, so a run that runs out of budget has the daily columns and is short only on
      // the oldest anchors. The view names any window it cannot open rather than guessing one.
      console.log(`  budget reached (${LEVEL_LIMIT}) — ${missing.length - fetched} anchor(s) left for the next run`);
      break;
    }
    try {
      const html = await fetchReport(DEBT_UTILISATION_URL, { body: archivePostBody(base, idFor.get(date)) });
      const row = parseDebtOutstanding(html);
      if (row.date !== date) throw Object.assign(new Error(`asked for ${date}, was served ${row.date}`), { reason: 'shape' });
      levels.set(row.date, row);
      fetched += 1;
      console.log(`  ${date}  G-Sec ${row.gsec.toFixed(0)}  SDL ${row.sdl.toFixed(0)}  Corp ${row.corpBond.toFixed(0)}`);
    } catch (err) {
      note(`debt level ${date}`, err);
    }
    await pause(700); // NSDL is a public utility, not a CDN
  }

  // ---- 2. daily net investment, the published flow ---------------------------------------------
  console.log('NSDL FPI — reading Daily Trends');
  let dailyFlows = [];
  try {
    dailyFlows = parseDailyTrends(await fetchReport(DAILY_TRENDS_URL));
    console.log(`  ${dailyFlows.length} reporting date(s) this month`);
  } catch (err) {
    note('daily trends (current month)', err);
  }
  // TWO REASONS TO ALSO READ THE PREVIOUS MONTH, both of which the current page cannot serve.
  // On the second of a month it holds one reporting date, which is not three daily columns. And
  // guard 1 has nothing to check until a CLOSED month is held in full — a reconciliation that
  // only ever runs against a part-month is a guard that passes because it never fires.
  const heldDates = new Set([...(retained?.dailyFlows || []).map((r) => r.date), ...dailyFlows.map((r) => r.date)]);
  const thisMonth = (dailyFlows[0]?.date || newest).slice(0, 7);
  const perMonth = new Map();
  for (const d of heldDates) if (d.slice(0, 7) !== thisMonth) perMonth.set(d.slice(0, 7), (perMonth.get(d.slice(0, 7)) || 0) + 1);
  const haveClosedMonth = [...perMonth.values()].some((n) => n >= 15);
  if (heldDates.size < RECENT_DAYS + 1 || !haveClosedMonth) {
    try {
      const page = await fetchReport(DAILY_TRENDS_ARCHIVE_URL);
      const end = new Date(`${thisMonth}-01T00:00:00Z`);
      end.setUTCDate(0); // day zero of this month is the last day of the previous one
      const stamp = end.toISOString().slice(0, 10);
      const body = formBody({
        ...hiddenFields(page),
        __EVENTTARGET: 'btnSubmit1',
        __EVENTARGUMENT: '',
        // The page's own datepicker writes `%d-%b-%Y` into hdnDate and posts only that; the visible
        // field is disabled markup and a browser never sends it. `dd/mm/yyyy` there is refused
        // with a redirect to Error.aspx, which reads exactly like the report being unavailable.
        hdnDate: `${stamp.slice(8)}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(stamp.slice(5, 7)) - 1]}-${stamp.slice(0, 4)}`,
      });
      const older = parseDailyTrends(await fetchReport(DAILY_TRENDS_ARCHIVE_URL, { body }));
      dailyFlows = mergeByDate(older, dailyFlows);
      console.log(`  + ${older.length} reporting date(s) from ${stamp.slice(0, 7)}`);
    } catch (err) {
      note('daily trends (previous month)', err);
    }
  }

  // ---- 3 & 4. the published month, calendar-year and financial-year totals ----------------------
  console.log('NSDL FPI — reading the year-wise net investment');
  let months = [];
  let calendarYears = [];
  let financialYears = [];
  try {
    const page = await fetchReport(CALENDAR_YEAR_URL);
    const thisYear = parseCalendarYear(page);
    months = thisYear.months;
    if (thisYear.total) calendarYears.push(thisYear.total);
    const prior = Number(thisYear.year) - 1;
    const priorPage = await fetchReport(CALENDAR_YEAR_URL, { body: calendarYearPostBody(page, prior) });
    const priorYear = parseCalendarYear(priorPage);
    if (String(priorYear.year) !== String(prior)) throw Object.assign(new Error(`asked for ${prior}, was served ${priorYear.year}`), { reason: 'shape' });
    months = mergeByPeriod(priorYear.months, months);
    if (priorYear.total) calendarYears.push(priorYear.total);
    console.log(`  ${months.length} month(s), calendar years ${calendarYears.map((c) => c.period).join(', ')}`);
  } catch (err) {
    note('calendar-year net investment', err);
  }
  try {
    financialYears = parseFinancialYears(await fetchReport(FINANCIAL_YEAR_URL));
    console.log(`  ${financialYears.length} financial year(s), newest ${financialYears.at(-1)?.period}`);
  } catch (err) {
    note('financial-year net investment', err);
  }

  // ---- merge, reconcile, write ------------------------------------------------------------------
  const mergedFlows = mergeByDate(retained?.dailyFlows, dailyFlows);
  const mergedMonths = mergeByPeriod(retained?.months, months);
  const mergedLevels = [...levels.values()].sort((a, b) => a.date.localeCompare(b.date));

  if (!mergedLevels.some((l) => l.date === newest)) {
    console.error('\nThe newest reporting date has no level. The committed capture is unchanged.');
    process.exit(2);
  }

  // GUARD 1 — our captured days must add up to NSDL's own published month, or that month's daily
  // coverage is not claimed complete. It is a check on the parse, never a substitute for the
  // published figure, which is what every monthly column actually shows.
  const monthlyCoverage = mergedMonths.map((m) => {
    const days = mergedFlows.filter((f) => f.date.startsWith(m.period));
    if (!days.length) return { period: m.period, days: 0, reconciles: null };
    const sum = days.reduce((n, d) => n + (d.equity ?? 0), 0);
    return {
      period: m.period,
      days: days.length,
      // The daily figures are published to two decimals and the monthly ones as whole crore, so a
      // month of rounding is the tolerance — not a fudge factor, an accounting of the source's own
      // precision.
      reconciles: m.equity == null ? null : Math.abs(sum - m.equity) <= Math.max(1, days.length * 0.5),
    };
  });
  const broken = monthlyCoverage.filter((c) => c.reconciles === false && c.days >= 15);
  for (const c of broken) console.error(`  ! ${c.period}: ${c.days} captured days do not sum to NSDL's published month`);

  const payload = {
    _provenance:
      "NSDL's FPI Monitor, the depository that publishes India's foreign-portfolio-investment statistics. " +
      'THE EQUITY FIGURES ARE NSDL\'S OWN NET INVESTMENT, reproduced unchanged — daily from the Daily Trends report, and by month, financial year and calendar year from their year-wise reports. Nothing is summed to produce them. ' +
      'THE DEBT FIGURES ARE DERIVED: NSDL publish the outstanding investment FPIs hold in central government securities, state development loans and corporate bonds on each reporting date, and the figure shown for a window is the CHANGE in that holding across it. ' +
      'A change in outstanding investment is not the same measurement as net purchases — a maturity or a redemption moves it too — and every surface that shows one says so. ' +
      'The debt lines are the general investment route, the route these reports are quoted on; the separate VRR route is carried beside each level and is never folded into the headline. ' +
      'A window whose opening level has not been captured has NO figure: it is an em dash naming the missing date, never a difference taken against some older level. ' +
      'Equity has no outstanding figure because this report does not publish one. Nothing here is scored, ranked or judged.',
    source: 'NSDL FPI Monitor — https://www.fpi.nsdl.co.in/web/Reports/ReportsListing.aspx',
    reports: {
      debtOutstanding: DEBT_UTILISATION_URL,
      dailyNetInvestment: DAILY_TRENDS_URL,
      calendarYear: CALENDAR_YEAR_URL,
      financialYear: FINANCIAL_YEAR_URL,
    },
    generator: 'scripts/scrape-fpi-activity.mjs',
    capturedAt: new Date().toISOString(),
    currency: 'INR crore',
    asOn: newest,
    flowsAsOn: mergedFlows.at(-1)?.date ?? null,
    // The reporting calendar, so the view knows which date PRECEDES which. Without it a missing
    // level is indistinguishable from a day the exchanges were shut.
    reportingDates: asc.filter((d) => d >= CALENDAR_FROM),
    archive: { count: archive.length, oldest: asc[0], newest },
    levels: mergedLevels,
    dailyFlows: mergedFlows,
    months: mergedMonths,
    calendarYears: mergeByPeriod(retained?.calendarYears, calendarYears),
    financialYears: financialYears.length ? financialYears.slice(-12) : retained?.financialYears || [],
    monthlyCoverage,
    // A read that did not happen is recorded, not silently absent — the same rule the filings
    // captures follow. The view reads this to say which windows it cannot open.
    failed,
  };

  writeFileSync(FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `\nWrote ${FILE.replace(/.*\/public\//, 'public/')} — ${mergedLevels.length} debt level(s), ${mergedFlows.length} daily flow(s), ` +
      `${mergedMonths.length} month(s), ${payload.calendarYears.length} calendar year(s), ${payload.financialYears.length} financial year(s).`,
  );
  if (failed.length) {
    console.error(`${failed.length} read(s) failed; every retained record is unchanged.`);
    process.exit(2); // a partial read is not a broken scraper
  }
  if (broken.length) process.exit(1); // a parse that does not reconcile IS
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`\nFPI activity capture failed: ${err?.reason ? `[${err.reason}] ` : ''}${err?.message || err}`);
    // `refused` and `upstream` are somebody else's outage; a shape change is ours to look at.
    process.exit(err?.reason === 'shape' ? 1 : 2);
  });
}
