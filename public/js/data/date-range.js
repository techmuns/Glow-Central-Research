// data/date-range.js — the history window the reader is browsing, in one place.
//
//   parseRange('3m')                  -> { id: '3m', from: '2026-06-04', to: '2026-09-03', days: 91 }
//   parseRange('2026-01-01..2026-03-31')
//   rangeBounds(range)                -> { from, to } as YYYY-MM-DD, or null for "does not narrow"
//   inRange(row.date, bounds)         -> boolean
//   heldSpan(rows)                    -> { first, last, count } — what is ACTUALLY in hand
//   reachOf(range, held)              -> how much of the asked-for window the capture can answer
//
// WHY THIS IS ITS OWN FILE. Three tabs need the same window vocabulary, the feed needs it to build
// its request, and the export banner needs it to say what a workbook covers. Four consumers of one
// definition is the same reasoning behind js/data/scope.js: a second copy of "what does 6 months
// mean" is a second copy that can disagree.
//
// A NULL BOUND MEANS "DOES NOT NARROW", AND AN EMPTY RESULT IS A REAL ANSWER. Same distinction
// `scopeTickers()` draws and for the same reason: collapse the two and "All" and "a window with
// nothing in it" become the same thing, so a range the reader deliberately narrowed to a quiet
// fortnight would silently show them the whole year instead.
//
// DATES ARE COMPARED AS STRINGS, DELIBERATELY. Every row in these feeds carries a `YYYY-MM-DD`
// date, which sorts and compares correctly as text, and the feed already sorts on it that way
// (`rows()` in js/data/filings.js). Parsing to a Date to compare would introduce a timezone where
// there is none: `new Date('2026-09-01')` is midnight UTC, which is the previous evening in IST,
// so a filing on the boundary day would fall out of a window that names it. The scrape writes
// exchange dates and the reader reads exchange dates; nothing in between needs a clock.
//
// A ROW WITH NO DATE IS NOT IN ANY WINDOW EXCEPT "ALL". These feeds carry rows whose date the
// upstream did not supply — `filings-shared.js` leaves them null rather than stamping today — and
// they must not be swept into whatever window happens to be selected. They keep their own count so
// the tab can say how many it set aside rather than dropping them silently.

/**
 * The windows offered, widest-last within the fixed set.
 *
 * `days` is what the LIVE WALK asks the upstream for; the same number narrows the rows already in
 * hand. `all` carries none because it does not narrow, and `custom` carries none because its
 * bounds come from the reader.
 */
export const RANGES = [
  { id: '7d', label: '7 days', short: '7D', days: 7 },
  { id: '1m', label: '1 month', short: '1M', days: 30 },
  { id: '3m', label: '3 months', short: '3M', days: 91 },
  { id: '6m', label: '6 months', short: '6M', days: 182 },
  { id: '1y', label: '1 year', short: '1Y', days: 365 },
  { id: 'all', label: 'Everything held', short: 'All', days: null },
];

/**
 * EVERYTHING HELD, so adding this control changed nothing about what these tabs already showed.
 *
 * A month is the tempting default and it is the wrong one: before ranges existed each tab painted
 * every row its capture held, and defaulting to 30 days would have quietly cut Insider Trades from
 * 3,548 rows to 408 for every reader who never touched the control — a filter nobody set, removing
 * rows nobody asked to hide. A new control has to be additive on the first paint and only narrow
 * when somebody narrows it.
 */
export const DEFAULT_RANGE_ID = 'all';

const BY_ID = new Map(RANGES.map((r) => [r.id, r]));

/** `YYYY-MM-DD` for a timestamp, in the same calendar the rows are written in. */
export const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (n, now = Date.now()) => iso(now - n * 86400000);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Read a range out of the URL (or out of nothing) into the one shape the rest of this uses.
 *
 * ACCEPTS EXACTLY TWO SPELLINGS and falls back rather than throwing: a preset id (`3m`), or an
 * explicit `FROM..TO` pair of ISO dates. Anything else is somebody's typo or a stale link, and a
 * tab that threw on one would be a tab a bad bookmark could break.
 *
 * A REVERSED CUSTOM PAIR IS SWAPPED, NOT REFUSED. `2026-09-01..2026-01-01` is unambiguous about
 * what the reader meant and refusing it would only make them type it again.
 */
export function parseRange(raw, now = Date.now()) {
  const value = String(raw || '').trim().toLowerCase();

  if (value.includes('..')) {
    let [from, to] = value.split('..', 2).map((s) => s.trim());
    if (isIsoDate(from) && isIsoDate(to)) {
      if (from > to) [from, to] = [to, from];
      return { id: 'custom', from, to, days: null, custom: true };
    }
    return preset(DEFAULT_RANGE_ID, now);
  }

  return preset(BY_ID.has(value) ? value : DEFAULT_RANGE_ID, now);
}

function preset(id, now) {
  const def = BY_ID.get(id);
  if (!def || def.days == null) return { id: 'all', from: null, to: null, days: null, custom: false };
  return { id, from: daysAgo(def.days, now), to: iso(now), days: def.days, custom: false };
}

/** How this range is written into the URL. `all` and the default are still written, so a link is literal. */
export const rangeParam = (range) => (range.custom ? `${range.from}..${range.to}` : range.id);

/** The bounds to filter on, or `null` where the range does not narrow at all. */
export function rangeBounds(range) {
  if (!range || (!range.from && !range.to)) return null;
  return { from: range.from || null, to: range.to || null };
}

/** Is this row's date inside the window? A row with no date is in no window but "All". */
export function inRange(date, bounds) {
  if (!bounds) return true;
  const d = typeof date === 'string' ? date.slice(0, 10) : '';
  if (!ISO_DATE.test(d)) return false;
  if (bounds.from && d < bounds.from) return false;
  if (bounds.to && d > bounds.to) return false;
  return true;
}

/**
 * Split a list into the rows inside the window and the rows that could not be placed in it.
 *
 * THE UNDATED ROWS ARE COUNTED, NOT DISCARDED. A feed that quietly dropped forty rows because the
 * publisher omitted a date would report a smaller month than the one it holds, and nothing on
 * screen would say why. Same rule as everywhere else here: a missing value is its own state.
 */
export function applyRange(rows, range) {
  const bounds = rangeBounds(range);
  if (!bounds) return { rows: [...rows], undated: 0, excluded: 0 };
  const kept = [];
  let undated = 0;
  let excluded = 0;
  for (const r of rows) {
    const d = typeof r?.date === 'string' ? r.date.slice(0, 10) : '';
    if (!ISO_DATE.test(d)) { undated++; continue; }
    if (inRange(d, bounds)) kept.push(r);
    else excluded++;
  }
  return { rows: kept, undated, excluded };
}

/**
 * What is ACTUALLY in hand, measured from the rows rather than read off the capture's header.
 *
 * THE DECLARED WINDOW CAN OVERSTATE AND THE OBSERVED SPAN CANNOT. The announcements capture
 * declares `windowDays: 13` and then prunes to `keepDays: 3` for size, so its header names a
 * fortnight it does not hold — measured on the shipped file: declared from 2026-08-22, oldest row
 * actually present 2026-09-01. A reach claim built on the declaration would be wrong by ten days
 * in the one direction that matters, telling the reader a window is covered when it is not.
 */
export function heldSpan(rows) {
  let first = null;
  let last = null;
  let count = 0;
  for (const r of rows) {
    const d = typeof r?.date === 'string' ? r.date.slice(0, 10) : '';
    if (!ISO_DATE.test(d)) continue;
    count++;
    if (first === null || d < first) first = d;
    if (last === null || d > last) last = d;
  }
  return { first, last, count };
}

/**
 * Does the capture reach as far back as the reader just asked?
 *
 * `full`      — the capture starts at or before the window, so an empty stretch is a real absence.
 * `partial`   — the window starts before anything in hand; the earlier part was never captured.
 * `unknown`   — nothing dated in hand at all, so no claim either way can be made.
 *
 * THIS IS THE WHOLE POINT OF THE CONTROL BEING HONEST. A "1 year" selection over a three-day
 * capture shows a short list under a label that says twelve months, and a reader takes that as
 * "almost nothing happened all year" rather than "we hold three days". Naming the gap is the
 * difference between a filter and a false statement — the same rule as "never claim nothing is
 * new" on the Refresh strip, arrived at from the other end.
 */
export function reachOf(range, held) {
  if (!range || !range.from) return { kind: 'full', coveredFrom: held?.first || null };
  if (!held || !held.first) return { kind: 'unknown', coveredFrom: null };
  if (held.first <= range.from) return { kind: 'full', coveredFrom: range.from };
  return { kind: 'partial', coveredFrom: held.first, shortfallDays: dayGap(range.from, held.first) };
}

/** Whole days between two ISO dates. Both are calendar dates, so this is exact arithmetic. */
export function dayGap(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** The range in words, for a heading, a tooltip or row one of an exported sheet. */
export function describeRange(range) {
  if (!range || (!range.from && !range.to)) return 'everything held';
  if (range.custom) return `${range.from} to ${range.to}`;
  const def = BY_ID.get(range.id);
  return def ? `the last ${def.label}` : `${range.from} to ${range.to}`;
}

/** The label the control shows for the current selection. */
export function rangeLabel(range) {
  if (!range) return RANGES[0].label;
  if (range.custom) return `${range.from} → ${range.to}`;
  return BY_ID.get(range.id)?.label || 'Everything held';
}
