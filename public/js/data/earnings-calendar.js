// data/earnings-calendar.js — the LIVE results calendar: who is scheduled to report, and when.
//
//   await loadDate('2026-08-13');   // strip + that date's companies
//   strip()                         // [{ date, displayDate, count }], newest date first
//   forDate(iso)                    // { rows, scheduledCount, capped, degraded, ... } or null
//   stripHas(iso) / scheduledCountFor(iso)
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
// WHAT THIS MODULE IS *NOT* ASKED FOR ANY MORE
//   A date that has already happened is answered by the results feed instead — every company that
//   filed, with its figures, already in memory. So the Earnings Hub asks this module for the
//   company list only for dates still to come, and for a past date takes nothing but the strip.
//   That is what `list: 'none'` is for; see `loadDate`. The forward-looking half is unchanged.
//
// THE SNAPSHOT FALLBACK IS THE WORKER'S, NOT THIS MODULE'S
//   There is a committed capture (public/data/earnings-calendar.json) and the Worker serves from it
//   when Akamai blocks the live page — but it arrives stamped, with `listSource: 'snapshot'` and
//   `listCapturedAt`, and the pill says *Captured* rather than *Live*. The original objection still
//   holds — a stale schedule looks exactly like a fresh one — and the answer to it is the stamp,
//   not the absence of a fallback. Nothing in this module invents a schedule of its own.

import { KEYS, conditionalJson } from '../core/store.js';

const ENDPOINT = 'api/earnings-calendar';

// Keyed by date AND by which representation was asked for: a strip-only answer must never be
// handed to a caller that wanted the company list, or the empty `rows` would read as "nobody
// reports that day" — the exact confusion this file's header is about.
const cacheKey = (iso, list = 'full') => `${iso}|${list}`;

let stripCache = []; // [{ date, displayDate, count }]
const byDate = new Map(); // "iso|list" -> payload
const inflight = new Map(); // "iso|list" -> promise, so a double-click is one fetch
// Per-date, NOT global. The caller repaints when a load settles, and a repaint asks for the date
// again — so without remembering which date failed, a failure becomes an infinite fetch loop.
// Per-date also means one bad date does not stop the reader trying another.
const failures = new Map(); // iso -> message
let lastError = null;

export function strip() {
  return stripCache;
}
export function forDate(iso, list = 'full') {
  return byDate.get(cacheKey(iso, list)) || null;
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
/**
 * Is the date strip already carrying this date?
 *
 * A date that has already reported is rendered from the results feed, so the only thing the
 * calendar route can add for it is the strip — and the strip covers a window, not one date. Asking
 * again for a date the window already contains would spend a request to be told what is on screen.
 */
export function stripHas(iso) {
  return stripCache.some((d) => d.date === iso);
}

/** The number Moneycontrol's calendar gives for one date, or null if the strip has not got it. */
export function scheduledCountFor(iso) {
  const hit = stripCache.find((d) => d.date === iso);
  return hit && hit.count > 0 ? hit.count : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.from] / [opts.to]  the strip window to ask for
 * @param {'full'|'none'} [opts.list]  whether the per-date COMPANY LIST is wanted. `none` is for a
 *   date already answered by the results feed: it saves the Worker a bot-walled page fetch and up
 *   to 25 identity look-ups, and it is a genuinely different representation — hence its own store
 *   key and its own `listRequested: false` in the payload, so nothing can read the empty `rows` as
 *   "no companies".
 */
export function loadDate(iso, { from, to, list = 'full' } = {}) {
  const ck = cacheKey(iso, list);
  if (byDate.has(ck)) return Promise.resolve(byDate.get(ck));
  if (inflight.has(ck)) return inflight.get(ck);

  const qs = new URLSearchParams({ date: iso });
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (list !== 'full') qs.set('list', list);

  // Conditional, and persisted per date: a schedule changes on the order of hours, so revisiting a
  // date already seen on this device costs a 304 rather than the whole day's list again.
  const p = conditionalJson(`${ENDPOINT}?${qs}`, { key: KEYS.calendar(iso, list) })
    .then((out) => {
      const payload = out.value;
      if (!payload?.ok) throw new Error(payload?.degraded || 'calendar feed returned no data');
      // The strip covers a window around whichever date was asked for, so later loads widen it
      // rather than replacing it — clicking around the strip must not make dates disappear.
      mergeStrip(payload.days || []);
      byDate.set(ck, payload);
      failures.delete(iso);
      lastError = null;
      return payload;
    })
    .catch((err) => {
      lastError = String(err.message || err);
      failures.set(iso, lastError);
      throw err;
    })
    .finally(() => inflight.delete(ck));

  inflight.set(ck, p);
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
