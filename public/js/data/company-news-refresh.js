// data/company-news-refresh.js — make the company-news capture current when the dashboard opens.
//
// Company News is a committed bulk capture: one search per listed company, performed once by a
// GitHub runner and then served to every reader as one file. A browser-side live walk is the wrong
// freshness mechanism here — it covers only forty companies, consumes the upstream's per-company
// rate limit for every reader, and leaves the rest of the book on yesterday's data.
//
// This module therefore does three bounded things, all in the background:
//   1. read the existing capture;
//   2. if its INDIAN CALENDAR DAY is older than today, ask the dedicated company-news workflow to
//      run (the Worker declines duplicates and holds an edge cooldown);
//   3. watch until that workflow's committed file reaches this browser, then replace the feed.
//
// It runs once per page. The normal morning cadence comes from GitHub; opening the dashboard is the
// safety net that makes freshness follow demand when a best-effort scheduler misses its turn.

import { news } from './filings.js';

const DISPATCH_ROUTE = 'api/company-news/refresh?source=auto';
const RUN_ROUTE = 'api/company-news/run';
const REQUEST_TIMEOUT_MS = 12_000;
const WATCH_EVERY_MS = 10_000;
const WATCH_BUDGET_MS = 20 * 60 * 1000;

let attempted = false;
let watching = null;

/** A stable YYYY-MM-DD in the market's timezone, independent of the reader's own timezone. */
export function istDay(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export const captureIsToday = (capturedAt, now = Date.now()) => {
  const captured = istDay(capturedAt);
  const today = istDay(now);
  return !!captured && !!today && captured === today;
};

async function ask(path, { method = 'GET' } = {}) {
  try {
    const response = await fetch(path, {
      method,
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const type = response.headers.get('content-type') || '';
    if ([404, 405, 501].includes(response.status) || !/json/i.test(type)) {
      return { ok: false, reason: 'no-worker' };
    }
    if (!response.ok) return { ok: false, reason: 'upstream', status: response.status };
    return await response.json();
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function watchForToday(now = Date.now, requestedAt = null) {
  const startedAt = now();
  while (now() - startedAt < WATCH_BUDGET_MS) {
    await wait(WATCH_EVERY_MS);

    // The FILE is the evidence, not a green workflow run. A successful scrape can still keep the
    // previous capture when coverage collapses, and a successful deploy can publish unrelated
    // work. Only a capture stamped today earns "today" on screen.
    const capture = await news.refreshSnapshot();
    if (captureIsToday(capture.capturedAt, now())) return { ok: true, outcome: 'landed', capturedAt: capture.capturedAt };

    const status = await ask(RUN_ROUTE);
    if (status.ok === false) {
      if (['no-worker', 'no-token', 'no-repo', 'unauthorised', 'forbidden'].includes(status.reason)) {
        return { ok: false, outcome: 'failed', reason: status.reason };
      }
      continue;
    }
    // GitHub dispatch is asynchronous. For a few seconds `/run` can still return yesterday's last
    // completed run, so only a run created around this request may end the watch as failed.
    const runAt = Date.parse(status.scrape?.createdAt || '');
    const relevantRun = !requestedAt || (Number.isFinite(runAt) && runAt >= requestedAt - 60_000);
    if (relevantRun && status.scrape?.status === 'completed' && status.scrape?.conclusion && status.scrape.conclusion !== 'success') {
      return { ok: false, outcome: 'failed', reason: status.scrape.conclusion };
    }
  }
  return { ok: false, outcome: 'timed-out' };
}

/**
 * Start the stale-day safety net. It resolves after the dispatch decision; the watch continues in
 * the background so first paint never waits ten minutes for a universe scrape and deploy.
 */
export async function ensureCompanyNewsFresh({ now = Date.now, watch = true } = {}) {
  await news.seed();
  const capturedAt = news.meta().capturedAt;
  if (captureIsToday(capturedAt, now())) return { ok: true, outcome: 'current', capturedAt };
  if (attempted) return { ok: true, outcome: 'already-attempted', capturedAt };
  attempted = true;

  const dispatch = await ask(DISPATCH_ROUTE, { method: 'POST' });
  if (dispatch.ok === false) return { ...dispatch, outcome: 'not-started', capturedAt };

  // Keep one watcher per page even if two callers arrive during the dispatch round trip.
  if (watch && !watching) {
    const requestedAt = Date.parse(dispatch.requestedAt || '');
    watching = watchForToday(now, Number.isFinite(requestedAt) ? requestedAt : null)
      .catch(() => ({ ok: false, outcome: 'failed', reason: 'unreachable' }))
      .finally(() => { watching = null; });
  }
  return { ok: true, outcome: dispatch.dispatched ? 'dispatched' : 'watching', capturedAt };
}

/** Test seam: a reload has the same effect in production. */
export function resetForTest() {
  attempted = false;
  watching = null;
}
