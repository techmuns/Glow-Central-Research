// data/filings.js — the feed behind News, Corporate Announcements and Insider Trades.
//
//   const feed = createFeed('announcements');
//   feed.load(items)        snapshot first, then a bounded live walk for whatever it is missing
//                           (items are tickers, or { ticker, name } — the name is what news searches)
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
// `store`, `mixed` or `live` produced what is on screen and `meta().capturedAt` when the snapshot
// was taken, and both reach the pill. An announcement is an event with its own date; the risk here
// is not that a row is old, it is that the READER cannot tell how recently we looked. It is derived
// rather than assigned — see `originNow` — because as a field it kept reading `null` mid-walk, and
// the pill renders that as "Live".
//
// NEWS IS SEARCHED BY COMPANY NAME, NOT BY SYMBOL. `?q=JAYNECOIND` returns three results, most of
// them quote pages; `?q=Jayaswal Neco Industries` returns twenty, about the company. The ticker is
// still what a row is filed under and what the store is keyed by — only the search term changes.
//
// A FAILED COMPANY IS NOT A COMPANY WITH NO NEWS. Failures are kept per ticker with the reason the
// Worker named, and the pill says how many could not be read. Rendering them as zero rows would
// report an outage as an absence of events.

import { conditionalJson, readEntries, KEYS, isPersistent } from '../core/store.js';

// How many companies a live walk will ask about before it stops and says so. The upstreams allow
// 60 requests a minute; forty keeps a cold start under a minute and well inside that budget.
const LIVE_LIMIT = 40;
const CONCURRENCY = 4;

// How long a company's rows are reused without asking again. Matches the Worker's own edge window
// per feed, deliberately rather than as a guess at tolerable staleness: inside it the server has
// nothing else to tell us, so a request would be spent receiving bytes we already hold.
const REVALIDATE_AFTER_MS = { news: 180_000, announcements: 900_000, insider: 900_000 };

const SNAPSHOT = {
  news: 'data/news.json',
  announcements: 'data/corp-announcements.json',
  insider: 'data/insider-trades.json',
};

// EACH ROUTE APPENDS THE DATE RANGE ITSELF, because only the route knows whether it already has a
// query string. The previous version built one `qs` string and patched a `?` onto the front of it,
// which is right for the two path-parameter routes and WRONG for news — `api/news?q=X` + `?from=…`
// produced a URL with two question marks, so the Worker read `q` as `"RELIANCE?from=2026-07-18"`
// and `from` as absent. The upstream then searched for that literal string, which is why every
// company came back with the same generic market news instead of its own.
const ROUTE = {
  news: (query, range) => `api/news?q=${encodeURIComponent(query)}&${range}`,
  announcements: (ticker, range) => `api/announcements/${encodeURIComponent(ticker)}?${range}`,
  insider: (ticker, range) => `api/insider-trades/${encodeURIComponent(ticker)}?${range}`,
};

// Which array each payload carries its rows in, and what a row's company is called.
const ROWS_KEY = { news: 'articles', announcements: 'announcements', insider: 'trades' };

/** How far back each feed asks. An announcement is worth a year; news past a month is not news. */
export const WINDOW_DAYS = { news: 30, announcements: 365, insider: 365 };

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);

/**
 * One story at two addresses is one story.
 *
 * `moneycontrol.com/news/…-13990522.html` and `…/amp` are the same article, as are
 * `economictimes.com/…` and `m.economictimes.com/…`. A search engine returns both, and a table that
 * lists them twice reads as broken even though the payload is faithful. So the comparison is on
 * host-without-its-mobile-prefix plus path-without-`/amp`.
 *
 * WHAT IT DELIBERATELY DOES NOT MERGE:
 *   • the query string, which on some sites is the whole identity of the page;
 *   • the same story from two DIFFERENT publishers — Hindustan Times and the Economic Times both ran
 *     "Prestige Group launches 3 housing projects in Q1", and those are two outlets reporting, not
 *     one row duplicated;
 *   • the same story under two companies. A story that genuinely mentions two of the companies in
 *     scope appears under each, because the ticker a row is filed under is OUR search term — which
 *     is what the provenance modal says — and dropping one would hide it from whichever reader was
 *     looking at that company. Hence: within a company, never across.
 */
const canonicalUrl = (raw) => {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
    const path = u.pathname.replace(/\/amp\/?$/i, '').replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return String(raw);
  }
};

const dedupeArticles = (list) => {
  const seenUrl = new Set();
  const seenStory = new Set();
  return list.filter((r) => {
    const u = r?.url ? canonicalUrl(r.url) : null;
    // No URL is not the same as the same URL — an article with none is kept.
    if (u) {
      if (seenUrl.has(u)) return false;
      seenUrl.add(u);
    }
    // Same publisher, same headline, twice. Unambiguous, and the only title comparison made: two
    // headlines that merely share a long prefix are two stories, and the table shows the prefix.
    const story = r?.title && r?.source ? `${r.source} :: ${String(r.title).trim().toLowerCase()}` : null;
    if (story) {
      if (seenStory.has(story)) return false;
      seenStory.add(story);
    }
    return true;
  });
};

export function createFeed(kind) {
  let state = fresh();
  let loading = null;
  // The picker's walks are serialised through this, so a second Search click cannot prune the rows
  // the first one is still landing. See `ensure()`.
  let ensuring = Promise.resolve();
  const subscribers = new Set();
  const emit = () => subscribers.forEach((fn) => fn());

  function fresh() {
    return {
      loaded: false,
      rows: new Map(), // ticker -> rows[]
      failures: new Map(), // ticker -> { reason, message, requestedUrl }
      asked: new Set(),
      // ticker -> company name, so the news search asks about the COMPANY rather than the symbol.
      names: new Map(),
      // Companies the committed snapshot covers. They are not re-walked: the snapshot is the bulk
      // source and is refreshed on a schedule, and its age is reported as `capturedAt` rather than
      // hidden by 603 live requests.
      fromSnapshot: new Set(),
      // ticker -> when the SERVER last confirmed those rows, whether that was this session or an
      // earlier one. A company inside its window is not re-asked; one never read always is.
      confirmedAt: new Map(),
      // The subset the server confirmed IN THIS SESSION. Kept apart from `confirmedAt` because they
      // answer different questions: that one is "how old are these bytes", this one is "did we
      // check". A device-cached company has a real confirmation time and has not been checked, and
      // only the second of those may be allowed to spell "Live".
      confirmedHere: new Set(),
      snapshotCount: 0,
      capturedAt: null,
      checkedAt: null,
      reason: null,
      message: null,
      inFlight: 0,
      pending: 0,
      truncated: 0,
      headers: [], // insider trades keeps the upstream's own column headings
    };
  }

  /**
   * Where what is on screen came from — DERIVED, never asserted.
   *
   * It was a field that four different places wrote to, and it spent the whole of a live walk
   * reading `null`, which the pill renders as "Live" over rows that had come off the device. A
   * freshness control that can claim a freshness it has not confirmed is worse than none. Computing
   * it from the two facts that decide it — what is painted, and what the server has confirmed in
   * this session — means it cannot drift from them.
   *
   *   live      every painted company was confirmed by the server this session
   *   mixed     some were
   *   snapshot  none were, and every painted company came from the committed file
   *   store     none were, and at least one came off this device's cache
   */
  function originNow() {
    const covered = state.rows.size;
    if (!covered) return null;
    let confirmed = 0;
    let snapshot = 0;
    for (const t of state.rows.keys()) {
      if (state.confirmedHere.has(t)) confirmed++;
      else if (state.fromSnapshot.has(t)) snapshot++;
    }
    if (confirmed === covered) return 'live';
    if (confirmed) return 'mixed';
    return snapshot === covered ? 'snapshot' : 'store';
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
      // The OLDEST confirmation behind what is on screen, not the newest — otherwise one fresh
      // company would overstate the age of the forty beside it. Only confirmations for companies
      // STILL on screen count: the News picker prunes rows when a company is deselected but keeps
      // its confirmation time (so re-adding it inside the window costs no request), and a pruned
      // company must not go on ageing the pill for the ones left.
      checkedAt: (() => {
        const shown = [...state.confirmedAt].filter(([t]) => state.rows.has(t)).map(([, v]) => v);
        return shown.length ? Math.min(...shown) : state.checkedAt;
      })(),
      origin: originNow(),
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
   * Does this company still need asking about?
   *
   * ONE definition, used by the queue AND by the request, because they were two and they disagreed:
   * `load()` queued every company whose rows were old, and `loadOne()` then returned early for any
   * company that had rows at all. So the walk counted down through forty companies without sending
   * a single request, the strip said "reading 40 more companies" the whole time, and nothing was
   * ever revalidated after its window expired.
   */
  const stale = (t) => {
    const at = state.confirmedAt.get(t);
    return at == null || Date.now() - at > REVALIDATE_AFTER_MS[kind];
  };

  // The news search asks about the COMPANY, not the symbol — see the header. A ticker whose name
  // the caller did not supply falls back to the ticker, which is a worse search and still a search.
  const queryFor = (t) => state.names.get(t) || t;

  /**
   * Fill from the committed snapshot, then walk live for what is still missing.
   *
   * Resolves once there is something to paint, not once every company has answered — the same rule
   * the super-investor feed follows. The walk continues in the background and `onChange` fires as
   * rows land.
   *
   * `items` may be tickers or `{ ticker, name }`. The name is what the news search uses.
   */
  function load(items = []) {
    if (loading) return loading;
    loading = (async () => {
      const wanted = [];
      for (const item of items) {
        const t = String(item?.ticker ?? item ?? '').toUpperCase();
        if (!t || wanted.includes(t)) continue;
        wanted.push(t);
        if (item?.name) state.names.set(t, String(item.name));
      }

      // PASS ONE — the committed snapshot and this device, with no network at all.
      //
      // A return visit paints the whole table before a single request is sent. The walk that used
      // to run on every visit was the delay: forty companies, four at a time, is ten sequential
      // waits for rows that were already on the device from last time.
      await seedFromSnapshot();
      await seedFromDevice(wanted);
      state.loaded = true;
      emit();

      // PASS TWO — only what is genuinely missing or genuinely old. A company confirmed inside the
      // feed's own cache window is skipped, because the server cannot answer differently yet, and
      // a company the committed snapshot covers is skipped outright.
      const missing = wanted.filter((t) => !state.failures.has(t) && !state.fromSnapshot.has(t) && stale(t));
      if (missing.length) {
        state.truncated = Math.max(0, missing.length - LIVE_LIMIT);
        state.pending = Math.min(missing.length, LIVE_LIMIT);
        // Not awaited: whatever we already had is on screen and the walk fills in behind it.
        walk(missing.slice(0, LIVE_LIMIT));
      }
      return state;
    })();
    return loading;
  }

  /**
   * Load a specific, caller-chosen set of companies — the News picker's entry point.
   *
   * `load()` runs the whole in-scope walk exactly ONCE (that is what the `loading` guard is for);
   * the picker instead asks about the handful of companies the reader has selected, and asks again
   * every time that selection changes, so it cannot go through that guard. What it does otherwise is
   * the same shape as `load()`: register each company's name (news searches by name, not symbol),
   * seed the selected companies from the committed snapshot and from this device with no network,
   * paint, then walk whatever is missing or stale — bounded by LIVE_LIMIT like every walk here.
   *
   * It is SELECTION-SCOPED: rows, failures and snapshot/confirmation bookkeeping for companies no
   * longer selected are dropped, so `rows()` and `meta().covered` describe the current selection
   * rather than everything ever searched this session. `confirmedAt` is deliberately kept, so
   * re-adding a company inside its cache window costs no request; `meta().checkedAt` already
   * ignores confirmations whose company is no longer on screen.
   *
   * Calls are serialised, so a rapid second Search cannot prune rows the first is still landing.
   * Resolves once its walk settles.
   */
  function ensure(items = []) {
    const run = ensuring.then(() => ensureInner(items));
    ensuring = run.catch(() => {});
    return run;
  }

  async function ensureInner(items) {
    const wanted = [];
    for (const item of items) {
      const t = String(item?.ticker ?? item ?? '').toUpperCase();
      if (!t || wanted.includes(t)) continue;
      wanted.push(t);
      if (item?.name) state.names.set(t, String(item.name));
    }
    const want = new Set(wanted);

    // Forget everything about companies that are no longer selected — but keep `confirmedAt`, which
    // is this feed's memory of how fresh a company's bytes are and lets a re-add skip the network.
    for (const t of [...state.rows.keys()]) if (!want.has(t)) state.rows.delete(t);
    for (const t of [...state.failures.keys()]) if (!want.has(t)) state.failures.delete(t);
    state.fromSnapshot = new Set([...state.fromSnapshot].filter((t) => want.has(t)));
    state.confirmedHere = new Set([...state.confirmedHere].filter((t) => want.has(t)));
    // A stale operator-level reason (an expired token from a previous search) must not outlive the
    // selection that hit it; the walk below re-establishes one if it still applies.
    state.reason = null;
    state.message = null;

    state.loaded = true;
    if (!wanted.length) {
      state.pending = 0;
      state.truncated = 0;
      emit();
      return state;
    }

    // PASS ONE — the snapshot (restricted to the selection) and this device, no network.
    await seedFromSnapshot(want);
    await seedFromDevice(wanted.filter((t) => !state.rows.has(t)));
    emit();

    // PASS TWO — walk only what the snapshot did not cover and the device could not vouch for.
    const missing = wanted.filter((t) => !state.fromSnapshot.has(t) && stale(t));
    state.truncated = Math.max(0, missing.length - LIVE_LIMIT);
    state.pending = Math.min(missing.length, LIVE_LIMIT);
    emit();
    if (missing.length) await walk(missing.slice(0, LIVE_LIMIT));
    else emit();
    return state;
  }

  /**
   * Everything this device already holds for the wanted companies, in ONE store transaction.
   *
   * A miss is not an error — it means "fetch it", which pass two does. A stored FAILURE is never
   * replayed: the Worker caches `ok: false` for fifteen seconds precisely so a corrected token
   * takes effect at once, and painting one from disk would undo that.
   */
  async function seedFromDevice(tickers) {
    if (!tickers.length) return;
    let entries;
    try {
      entries = await readEntries(tickers.map((t) => KEYS.filingRow(kind, t)));
    } catch {
      return;
    }
    for (const t of tickers) {
      const hit = entries.get(KEYS.filingRow(kind, t));
      const body = hit?.value;
      if (!body || body.ok === false) continue;
      const list = rowsIn(body);
      if (!state.rows.has(t)) state.rows.set(t, list);
      if (Array.isArray(body.headers) && body.headers.length && !state.headers.length) state.headers = body.headers;
      // `savedAt` is when the SERVER's bytes were written here, so it is a real confirmation time
      // rather than this tab vouching for itself.
      if (hit.savedAt) state.confirmedAt.set(t, hit.savedAt);
    }
  }

  /**
   * The committed snapshot. A miss is not an error — it means the scheduled run has not run yet.
   *
   * `only`, when given, restricts the seed to that set of tickers — the News picker asks about a
   * handful of chosen companies and has no use for the other ~600 the snapshot carries, and seeding
   * them all would make `meta().covered` read "603 companies" over a four-company search.
   */
  async function seedFromSnapshot(only = null) {
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
      if (!Array.isArray(list) || !list.length) continue;
      const t = ticker.toUpperCase();
      if (only && !only.has(t)) continue;
      state.rows.set(t, kind === 'news' ? dedupeArticles(list) : list);
      state.fromSnapshot.add(t);
    }
    // Count snapshot-origin companies, not `state.rows.size` — the picker seeds the device before
    // this on some calls, so the two can differ.
    state.snapshotCount = state.fromSnapshot.size;
    return state.fromSnapshot.size > 0;
  }

  /** The rows out of one company's payload, deduplicated where duplication is meaningless. */
  function rowsIn(body) {
    const list = Array.isArray(body[ROWS_KEY[kind]]) ? body[ROWS_KEY[kind]] : [];
    return kind === 'news' ? dedupeArticles(list) : list;
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
    emit();
  }

  /** One company. Never throws — a failure is recorded against that ticker and the walk goes on. */
  async function loadOne(key, { force = false } = {}) {
    const t = String(key || '').toUpperCase();
    if (!force && !stale(t)) return state.rows.get(t) || [];
    state.asked.add(t);

    const range = `from=${daysAgo(WINDOW_DAYS[kind])}&to=${iso(Date.now())}`;
    const path = ROUTE[kind](kind === 'news' ? queryFor(t) : t, range);
    let res;
    try {
      res = await conditionalJson(path, { key: KEYS.filingRow(kind, t), optional: true });
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
    const list = rowsIn(body);
    state.rows.set(t, list);
    state.fromSnapshot.delete(t);
    state.failures.delete(t);
    state.confirmedAt.set(t, res?.checkedAt || Date.now());
    state.confirmedHere.add(t);
    if (!state.capturedAt && body.fetchedAt) state.checkedAt = Date.parse(body.fetchedAt) || state.checkedAt;
    return list;
  }

  return {
    load,
    ensure,
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
