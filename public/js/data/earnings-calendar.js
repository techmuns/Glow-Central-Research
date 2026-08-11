// data/earnings-calendar.js — the LIVE results calendar: who is scheduled to report, and when.
//
//   await loadDate('2026-08-13');   // strip + that date's companies
//   strip()                         // [{ date, displayDate, count }], newest date first
//   forDate(iso)                    // { rows, scheduledCount, capped, degraded, ... } or null
//   defaultDate()                   // the nearest date that actually has companies on it
//
// TWO UPSTREAMS, ONE HONEST PAYLOAD
//   The per-date COUNT comes from Moneycontrol's calendar JSON API and is complete. The company
//   LIST comes from the calendar page's server props and is the twenty largest by market cap —
//   the page cannot be paged past, and the route its own "load more" uses is blocked to
//   non-browser clients. See the header of worker/mc.mjs.
//
//   So `scheduledCount` and `rows.length` are different numbers on a busy day, and the UI must
//   say both. Rendering twenty rows under a bare "Companies reporting" heading would assert that
//   twenty is all there are, on a day when a hundred and seventy report.
//
// WHY THERE IS NO SNAPSHOT FALLBACK
//   A schedule is a claim about the future. A committed file would keep saying "Tata Motors
//   reports on the 13th" long after the 13th, and there is no way to tell a stale schedule from a
//   live one by looking at it. If the route is unreachable the tab says so.

const ENDPOINT = 'api/earnings-calendar';

let stripCache = []; // [{ date, displayDate, count }]
const byDate = new Map(); // iso -> payload
const inflight = new Map(); // iso -> promise, so a double-click is one fetch
// Per-date, NOT global. The caller repaints when a load settles, and a repaint asks for the date
// again — so without remembering which date failed, a failure becomes an infinite fetch loop.
// Per-date also means one bad date does not stop the reader trying another.
const failures = new Map(); // iso -> message
let lastError = null;

export function strip() {
  return stripCache;
}
export function forDate(iso) {
  return byDate.get(iso) || null;
}
export function error() {
  return lastError;
}
export function errorFor(iso) {
  return failures.get(iso) || null;
}

/**
 * Load one date. Resolves to the payload, or throws — the caller renders the failure rather than
 * an empty calendar, because "nothing is scheduled" and "we could not ask" look identical once
 * you have drawn an empty table.
 */
export function loadDate(iso, { from, to } = {}) {
  if (byDate.has(iso)) return Promise.resolve(byDate.get(iso));
  if (inflight.has(iso)) return inflight.get(iso);

  const qs = new URLSearchParams({ date: iso });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const p = fetch(`${ENDPOINT}?${qs}`, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`calendar feed returned ${res.status}`);
      const payload = await res.json();
      if (!payload?.ok) throw new Error(payload?.degraded || 'calendar feed returned no data');
      // The strip covers a window around whichever date was asked for, so later loads widen it
      // rather than replacing it — clicking around the strip must not make dates disappear.
      mergeStrip(payload.days || []);
      byDate.set(iso, payload);
      failures.delete(iso);
      lastError = null;
      return payload;
    })
    .catch((err) => {
      lastError = String(err.message || err);
      failures.set(iso, lastError);
      throw err;
    })
    .finally(() => inflight.delete(iso));

  inflight.set(iso, p);
  return p;
}

function mergeStrip(days) {
  const seen = new Map(stripCache.map((d) => [d.date, d]));
  for (const d of days) seen.set(d.date, d);
  stripCache = [...seen.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * The date to open on: today if anything reports today, otherwise the nearest date that does.
 * Opening on an empty date because the market happens to be shut is a worse first impression than
 * opening one day either side, and the strip makes the jump visible.
 */
export function defaultDate(today = new Date().toISOString().slice(0, 10)) {
  if (!stripCache.length) return today;
  const onToday = stripCache.find((d) => d.date === today);
  if (onToday && onToday.count > 0) return today;
  const withCount = stripCache.filter((d) => d.count > 0);
  if (!withCount.length) return today;
  // Nearest by absolute day distance; ties go to the earlier (past) date, which is the one that
  // has actually happened.
  const dayGap = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return withCount.reduce((best, d) => (dayGap(d.date, today) < dayGap(best.date, today) ? d : best), withCount[0]).date;
}

/** Drop everything. Used when the tab unmounts so a stale schedule cannot outlive the visit. */
export function reset() {
  stripCache = [];
  byDate.clear();
  inflight.clear();
  failures.clear();
  lastError = null;
}
