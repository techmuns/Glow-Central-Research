// data/filings.js — the feed behind News, Corporate Announcements and Insider Trades.
//
//   const feed = createFeed('announcements');
//   feed.load(tickers)      snapshot first, then a bounded live walk for whatever it is missing
//   feed.rows()             every row that has landed, newest first
//   feed.meta()             what loaded, what failed, where the paint came from, and when
//   feed.onChange(fn)       fires as rows arrive, so the table fills in progressively
//
// ONE MODULE, THREE FEEDS, because everything that differs between them is a URL and a row shape,
// and both of those already live elsewhere — the routes in worker/index.js, the shapes in
// filings-shared.js. What they share is the hard part, and it is worth writing once.
//
// TWO SOURCES OF ROWS, AND THE ORDER MATTERS.
//
//   1. A COMMITTED SNAPSHOT covering the whole universe, written by scripts/scrape-filings.mjs on a
//      schedule. One fetch, 603 companies, instant. This is how "the complete universe" is possible
//      at all: the two per-ticker upstreams are rate limited to 60 requests a minute, so asking for
//      603 companies live would take ten minutes and hammer somebody else's service on every visit.
//
//   2. A LIVE WALK for companies the snapshot does not cover, bounded by LIVE_LIMIT and run
//      CONCURRENCY at a time. This is what makes a brand-new deployment show something before the
//      first scheduled run, and what refreshes one company on demand.
//
// A SNAPSHOT IS NOT STALE DATA PRETENDING TO BE LIVE. `meta().origin` says which of `snapshot`,
// `live` or `mixed` produced what is on screen and `meta().capturedAt` when the snapshot was taken,
// and both reach the Live pill. An announcement is an event with its own date; the risk here is not
// that a row is old, it is that the READER cannot tell how recently we looked.
//
// A FAILED COMPANY IS NOT A COMPANY WITH NO NEWS. Failures are kept per ticker with the reason the
// Worker named, and the pill says how many could not be read. Rendering them as zero rows would
// report an outage as an absence of events.

import { conditionalJson, readEntry, KEYS, isPersistent } from '../core/store.js';

// How many companies a live walk will ask about before it stops and says so. The upstreams allow
// 60 requests a minute; forty keeps a cold start under a minute and well inside that budget.
const LIVE_LIMIT = 40;
const CONCURRENCY = 4;

const SNAPSHOT = {
  news: 'data/news.json',
  announcements: 'data/corp-announcements.json',
  insider: 'data/insider-trades.json',
};

const ROUTE = {
  news: (key, qs) => `api/news?q=${encodeURIComponent(key)}${qs}`,
  announcements: (key, qs) => `api/announcements/${encodeURIComponent(key)}${qs}`,
  insider: (key, qs) => `api/insider-trades/${encodeURIComponent(key)}${qs}`,
};

// Which array each payload carries its rows in, and what a row's company is called.
const ROWS_KEY = { news: 'articles', announcements: 'announcements', insider: 'trades' };

/** How far back each feed asks. An announcement is worth a year; news past a month is not news. */
export const WINDOW_DAYS = { news: 30, announcements: 365, insider: 365 };

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);

export function createFeed(kind) {
  let state = fresh();
  let loading = null;
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());

  function fresh() {
    return {
      loaded: false,
      rows: new Map(), // ticker -> rows[]
      failures: new Map(), // ticker -> { reason, message, requestedUrl }
      asked: new Set(),
      snapshotCount: 0,
      capturedAt: null,
      checkedAt: null,
      origin: null, // 'snapshot' | 'live' | 'mixed'
      reason: null,
      message: null,
      inFlight: 0,
      pending: 0,
      truncated: 0,
      headers: [], // insider trades keeps the upstream's own column headings
    };
  }

  function meta() {
    const covered = state.rows.size;
    return {
      kind,
      ok: covered > 0 || state.failures.size === 0,
      loaded: state.loaded,
      reason: state.reason,
      message: state.message,
      covered,
      failed: state.failures.size,
      pending: state.pending,
      inFlight: state.inFlight,
      truncated: state.truncated,
      rowCount: [...state.rows.values()].reduce((a, r) => a + r.length, 0),
      snapshotCount: state.snapshotCount,
      capturedAt: state.capturedAt,
      checkedAt: state.checkedAt,
      origin: state.origin,
      headers: state.headers,
      persisted: isPersistent(),
      windowDays: WINDOW_DAYS[kind],
    };
  }

  /** Every row that has landed, newest first. Rows with no readable date sort last, never first. */
  function rows() {
    const out = [];
    for (const [ticker, list] of state.rows) for (const r of list) out.push({ ...r, ticker: r.ticker || ticker });
    return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  const forTicker = (t) => state.rows.get(String(t || '').toUpperCase()) || [];
  const failureFor = (t) => state.failures.get(String(t || '').toUpperCase()) || null;

  /**
   * Fill from the committed snapshot, then walk live for what is still missing.
   *
   * Resolves once there is something to paint, not once every company has answered — the same rule
   * the super-investor feed follows. The walk continues in the background and `onChange` fires as
   * rows land.
   */
  function load(tickers = []) {
    if (loading) return loading;
    loading = (async () => {
      await seedFromSnapshot();
      state.loaded = true;
      emit();

      const wanted = [...new Set(tickers.map((t) => String(t || '').toUpperCase()).filter(Boolean))];
      const missing = wanted.filter((t) => !state.rows.has(t) && !state.failures.has(t));
      if (missing.length) {
        state.truncated = Math.max(0, missing.length - LIVE_LIMIT);
        state.pending = Math.min(missing.length, LIVE_LIMIT);
        // Not awaited: the snapshot is already on screen and the walk fills in behind it.
        walk(missing.slice(0, LIVE_LIMIT));
      }
      return state;
    })();
    return loading;
  }

  /** The committed snapshot. A miss is not an error — it means the scheduled run has not run yet. */
  async function seedFromSnapshot() {
    let res;
    try {
      res = await conditionalJson(SNAPSHOT[kind], { key: KEYS.filings(kind), optional: true });
    } catch {
      res = null;
    }
    const body = res?.value;
    state.checkedAt = res?.checkedAt || Date.now();
    if (!body || typeof body !== 'object') return false;

    state.capturedAt = body.capturedAt || body.generated_at || null;
    state.headers = Array.isArray(body.headers) ? body.headers : [];
    const byTicker = body.byTicker || {};
    for (const [ticker, list] of Object.entries(byTicker)) {
      if (Array.isArray(list) && list.length) state.rows.set(ticker.toUpperCase(), list);
    }
    state.snapshotCount = state.rows.size;
    state.origin = state.rows.size ? 'snapshot' : null;
    return state.rows.size > 0;
  }

  async function walk(queue) {
    const q = [...queue];
    const workers = Array.from({ length: Math.min(CONCURRENCY, q.length) }, async () => {
      for (;;) {
        const t = q.shift();
        if (!t) return;
        state.inFlight++;
        await loadOne(t);
        state.inFlight--;
        state.pending = Math.max(0, state.pending - 1);
        emit();
      }
    });
    await Promise.all(workers);
    state.origin = state.snapshotCount ? 'mixed' : 'live';
    emit();
  }

  /** One company. Never throws — a failure is recorded against that ticker and the walk goes on. */
  async function loadOne(key, { force = false } = {}) {
    const t = String(key || '').toUpperCase();
    if (!force && state.rows.has(t)) return state.rows.get(t);
    state.asked.add(t);

    const qs = `&from=${daysAgo(WINDOW_DAYS[kind])}&to=${iso(Date.now())}`.replace('&', '?');
    let res;
    try {
      res = await conditionalJson(ROUTE[kind](key, qs), { key: KEYS.filingRow(kind, t), optional: true });
    } catch {
      res = null;
    }
    const body = res?.value;

    if (!body) {
      // No route at this origin at all — a plain static server rather than the Worker.
      state.failures.set(t, { reason: 'no-route', message: `This origin has no /api/${kind} route. The live feed needs the Cloudflare Worker.` });
      if (!state.reason) {
        state.reason = 'no-route';
        state.message = 'This origin serves the static files only, so there is no live route to answer. Run `npx wrangler dev`, or open the deployed site.';
      }
      return null;
    }
    if (body.ok === false) {
      state.failures.set(t, { reason: body.reason || 'upstream', message: body.message || 'Could not be read.', requestedUrl: body.requestedUrl || null });
      // The first operator-fixable reason becomes the feed's reason, because one expired token is
      // not 123 unrelated failures and the screen should say so once.
      if (!state.reason && ['no-token', 'unauthorised', 'rate-limited'].includes(body.reason)) {
        state.reason = body.reason;
        state.message = body.message;
      }
      return null;
    }

    if (Array.isArray(body.headers) && body.headers.length && !state.headers.length) state.headers = body.headers;
    const list = Array.isArray(body[ROWS_KEY[kind]]) ? body[ROWS_KEY[kind]] : [];
    state.rows.set(t, list);
    state.failures.delete(t);
    if (!state.capturedAt && body.fetchedAt) state.checkedAt = Date.parse(body.fetchedAt) || state.checkedAt;
    return list;
  }

  return {
    load,
    loadOne,
    rows,
    forTicker,
    failureFor,
    meta,
    isLoaded: () => state.loaded,
    invalidate() {
      state = fresh();
      loading = null;
    },
    onChange(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// One instance per feed, module-level so a second visit to the tab repaints instantly instead of
// re-walking. Same reasoning as the super-investor feed.
export const news = createFeed('news');
export const announcements = createFeed('announcements');
export const insider = createFeed('insider');
