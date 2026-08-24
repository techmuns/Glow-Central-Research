// core/refresh.js — the registry behind the header's Refresh button, for feeds that are NOT polled.
//
//   const off = refresh.register('news', { label: 'News', refresh: () => feed.refresh() });
//   const { announced, results } = await refresh.refreshAll();
//   refresh.onChange(fn)          fires when a registration is added, removed or finishes
//
// WHY THIS EXISTS SEPARATELY FROM `core/live.js`
//   `live.js` is a poller: it owns an interval, a backoff and a visibility rule, and `refreshAll()`
//   there ticks whatever is currently running. That is exactly right for the two feeds that SHOULD
//   poll — the results feed and the con-call scan are conditional GETs whose unchanged tick is a
//   bodyless 304, and both drive the alert stack, which is only worth having if it fires while the
//   reader is on another tab.
//
//   It is exactly wrong for News, Corporate Announcements, Insider Trades and Superstar Investors.
//   Those are **one request per company**, and there is no cheap tick: a walk of forty companies is
//   forty round trips against somebody else's rate-limited service, and ninety-one for the investor
//   books. A feed like that must not run on a page load at all — it is work the reader has to ask
//   for, which is what this registry models.
//
// THE CONTRACT
//   `refresh()` returns `{ added, checked }` — how many rows arrived and how many companies were
//   asked about — or throws. It is called ONLY from the header button (or a control the reader
//   clicks), never on a timer, never on a route change, never on a repaint.
//
// AND WHAT REPLACES THE AUTOMATIC WALK: the committed snapshot, revalidated with one conditional
// GET on load. That is what "new data arrives on its own" means for these feeds — a scheduled job
// captures it and the browser picks the file up for free. Anything newer than the last capture is
// what the button is for, and the tab says so rather than leaving the reader to guess.

const entries = new Map(); // id -> { id, label, refresh, lastResult, lastAt, running }
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

/**
 * Register a feed the Refresh button should drive. Returns a disposer.
 *
 * Registering twice under one id replaces the entry rather than adding a second — a tab that
 * re-mounts must not leave a stale closure behind that refreshes an unmounted feed's state.
 */
export function register(id, { label, refresh }) {
  if (typeof refresh !== 'function') throw new TypeError(`refresh.register("${id}") needs a refresh function`);
  entries.set(id, { id, label: label || id, refresh, lastResult: null, lastAt: null, running: false });
  emit();
  return () => {
    entries.delete(id);
    emit();
  };
}

export const registered = () => [...entries.values()].map(({ id, label, lastResult, lastAt, running }) => ({ id, label, lastResult, lastAt, running }));

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** When this feed last completed a refresh in this session, or null if it never has. */
export const lastRefreshAt = (id) => entries.get(id)?.lastAt ?? null;

/** Is a refresh in flight for this feed? The tab disables its own control while one is. */
export const isRunning = (id) => entries.get(id)?.running === true;

/**
 * Refresh one feed by id. Never throws — a failure is recorded and reported, because the button
 * that calls this must say what happened rather than leaving a spinner.
 */
export async function refreshOne(id) {
  const entry = entries.get(id);
  if (!entry || entry.running) return { id, added: 0, checked: 0, skipped: true };
  entry.running = true;
  emit();
  try {
    const out = (await entry.refresh()) || {};
    entry.lastResult = { added: out.added || 0, checked: out.checked || 0, failed: out.failed || 0 };
    entry.lastAt = Date.now();
    return { id, ...entry.lastResult };
  } catch (err) {
    entry.lastResult = { added: 0, checked: 0, failed: 0, error: String(err?.message || err) };
    entry.lastAt = Date.now();
    return { id, added: 0, checked: 0, error: entry.lastResult.error };
  } finally {
    entry.running = false;
    emit();
  }
}

/**
 * Refresh every registered feed, concurrently, and report the total.
 *
 * REGISTRATION IS BY MOUNTED TAB, so this is not "walk everything the dashboard can read" — it is
 * "re-read what is on screen". A reader on News does not pay for ninety-one investor books, and
 * the button stays a bounded, predictable cost rather than a lottery.
 */
export async function refreshAll() {
  // A feed already walking is not refreshed again — but it is not "nothing to do" either. Reporting
  // zero for it would let the button say "Up to date" over a walk that is still in flight, which is
  // the same class of lie as saying it after a check that never completed.
  const skipped = [...entries.values()].filter((e) => e.running).length;
  const due = [...entries.values()].filter((e) => !e.running);
  if (!due.length) return { announced: 0, results: [], skipped };
  const results = await Promise.all(due.map((e) => refreshOne(e.id)));
  return { announced: results.reduce((a, r) => a + (r.added || 0), 0), results, skipped };
}
