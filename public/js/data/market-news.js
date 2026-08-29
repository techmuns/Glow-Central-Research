// data/market-news.js — market-wide stocks news, the Universe half of the News tab.
//
//   marketNews.load()          the committed capture, from this device first
//   marketNews.rows()          every story, newest first, by the publisher's own id
//   marketNews.meta()          counts, capture time, when we last checked, where the paint came from
//   marketNews.refresh()       re-check for a newer capture — what the tab's button calls
//   marketNews.onChange(fn)    fires when the capture moves
//   marketNews.newArrivals()   stories that appeared since this page loaded (for the alert stack)
//
// TWO HALVES OF ONE TAB, ASKING TWO DIFFERENT QUESTIONS.
//   Portfolio scope asks "what has been written about each of these companies" — a search, one
//   request per company, which is why it makes the reader name them. Universe scope cannot work
//   that way at 603 companies, so it asks the other question: "what has been published". Same move
//   as the announcements feed — when the per-entity route cannot cover the universe, look for the
//   one indexed the other way round.
//
// THE BROWSER CANNOT READ MONEYCONTROL, AND NEITHER CAN THE WORKER. Measured: `curl` with a browser
// user-agent gets 200 and 598 KB; node's `fetch` gets **403 with a 24-byte body** on every header
// set tried, including the full sixteen-header browser set; and a Cloudflare Worker running under
// `wrangler dev` gets **403 as well**. It is TLS fingerprinting, so there is no proxy route and no
// header fix. A GitHub Action on a normal runner is the only thing that can read this page, and
// that is why this module reads a COMMITTED FILE rather than a live route.
//
// WHICH MAKES THE REFRESH BUTTON'S HONESTY THE WHOLE DESIGN.
//   The button cannot fetch Moneycontrol. What it can do — and does — is ask whether a newer
//   capture has been published, which is one conditional GET and usually a bodyless 304. So the two
//   times are kept apart and both are shown, because they are different facts:
//
//     capturedAt   when the Action last READ Moneycontrol
//     checkedAt    when this browser last confirmed it had the newest capture
//
//   A 304 moves the second and not the first. Collapsing them into one "last updated" would let a
//   twenty-minute-old capture read as though it had just arrived — the same error the header's two
//   competing chips made before they were removed.
//
// A STORY WITH NO PUBLISHER TIME KEEPS NULL. The listing page carries no date at all, so a date is
// fetched per article and is budgeted; the ones the budget did not reach render an em dash. They
// are never stamped with `firstSeenAt`, which is when WE saw the story and is a fact about the
// scraper, not about the story.

import { conditionalJson, KEYS } from '../core/store.js';

const SNAPSHOT = 'data/market-news.json';

let state = fresh();
let loading = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function fresh() {
  return {
    loaded: false,
    articles: [],
    byId: new Map(),
    capturedAt: null,
    checkedAt: null,
    // Ids present on the first paint. Anything outside this set arrived while the reader was here,
    // which is the only thing worth announcing — see `newArrivals`.
    baseline: null,
    arrivals: [],
    withPublishedAt: 0,
    withoutPublishedAt: 0,
    newestId: null,
    reason: null,
    message: null,
    // 'snapshot' when painted from the committed file, 'store' when this device had it already.
    origin: null,
  };
}

const keyOf = (a) => String(a?.id || a?.url || '');

/** Newest first, by the publisher's own id — which orders correctly even without a date. */
function sortRows(list) {
  return [...list].sort((a, b) => {
    const ai = a.id;
    const bi = b.id;
    if (ai && bi) return ai.length === bi.length ? bi.localeCompare(ai) : Number(bi) - Number(ai);
    return String(b.publishedAt || b.firstSeenAt || '').localeCompare(String(a.publishedAt || a.firstSeenAt || ''));
  });
}

function absorb(body, { fromStore = false } = {}) {
  const list = Array.isArray(body?.articles) ? body.articles : [];
  if (!list.length) return false;

  const before = state.byId;
  const next = new Map();
  for (const a of list) {
    const k = keyOf(a);
    if (k) next.set(k, a);
  }

  // The FIRST paint sets the baseline and announces nothing. Everything in the committed file was
  // published before the reader arrived, so replaying it through the alert stack would announce
  // history and teach them to ignore the component — the same rule watch.js follows for the two
  // polled feeds.
  if (state.baseline === null) {
    state.baseline = new Set(next.keys());
  } else {
    const added = [...next.keys()].filter((k) => !before.has(k) && !state.baseline.has(k));
    if (added.length) state.arrivals = [...added.map((k) => next.get(k)), ...state.arrivals].slice(0, 80);
  }

  state.byId = next;
  state.articles = sortRows([...next.values()]);
  state.capturedAt = body.capturedAt || null;
  state.newestId = body.newestId || state.articles[0]?.id || null;
  state.withPublishedAt = Number.isFinite(body.withPublishedAt) ? body.withPublishedAt : state.articles.filter((a) => a.publishedAt).length;
  state.withoutPublishedAt = Number.isFinite(body.withoutPublishedAt) ? body.withoutPublishedAt : state.articles.length - state.withPublishedAt;
  state.origin = fromStore ? 'store' : 'snapshot';
  state.reason = null;
  state.message = null;
  return true;
}

async function read() {
  try {
    // No "force" needed: `conditionalJson` fetches with `cache: 'no-cache'`, which revalidates on
    // every call and reuses the bytes only when the server confirms them. A manual re-check and an
    // automatic one are therefore the same request — the difference is only who asked for it.
    const res = await conditionalJson(SNAPSHOT, { key: KEYS.marketNews, optional: true });
    // `fromStore` means the server answered 304 and these are bytes this device already held. The
    // check still happened, so `checkedAt` moves either way — that is the point of the two fields.
    state.checkedAt = Date.now();
    if (res?.value) {
      const changed = absorb(res.value, { fromStore: !!res.fromStore });
      return changed;
    }
    if (!state.articles.length) {
      state.reason = 'no-capture';
      state.message = 'No market-news capture has been committed yet.';
    }
    return false;
  } catch (err) {
    state.checkedAt = Date.now();
    if (!state.articles.length) {
      state.reason = 'unreachable';
      state.message = String(err?.message || err);
    }
    return false;
  }
}

export function load() {
  if (loading) return loading;
  loading = (async () => {
    await read();
    state.loaded = true;
    emit();
    return state;
  })();
  return loading;
}

/**
 * Ask whether a newer capture exists. One conditional GET, usually a bodyless 304.
 *
 * IT DOES NOT AND CANNOT FETCH MONEYCONTROL — see the header. The reader is owed that distinction,
 * so the tab's control says "check for a newer capture" rather than anything that implies this
 * reaches the publisher.
 */
export async function refresh() {
  const before = state.articles.length;
  const changed = await read();
  emit();
  return { changed, added: Math.max(0, state.articles.length - before), total: state.articles.length, capturedAt: state.capturedAt };
}

export const isLoaded = () => state.loaded;
export const rows = () => state.articles;
export const byId = (id) => state.byId.get(String(id)) || null;

/** Stories that appeared after this page's first paint. Consumed by core/watch.js. */
export const newArrivals = () => state.arrivals;

export function meta() {
  return {
    loaded: state.loaded,
    count: state.articles.length,
    withPublishedAt: state.withPublishedAt,
    withoutPublishedAt: state.withoutPublishedAt,
    capturedAt: state.capturedAt,
    checkedAt: state.checkedAt,
    newestId: state.newestId,
    arrivals: state.arrivals.length,
    origin: state.origin,
    reason: state.reason,
    message: state.message,
  };
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Test seam: forget everything so a check can drive a first paint again. */
export function invalidate() {
  state = fresh();
  loading = null;
}

// ---------------------------------------------------------------------------------------
// The twenty-minute poll
// ---------------------------------------------------------------------------------------

export const LIVE_ID = 'market-news';

// TWENTY MINUTES, WHICH IS THE CADENCE OF THE THING BEING WATCHED, not a guess at tolerable
// staleness. The scheduled Action reads Moneycontrol every twenty minutes, so polling faster than
// that cannot surface a story sooner — it would only spend requests confirming the same capture.
// An unchanged poll is a bodyless 304, which is why watching this app-wide is affordable at all.
export const POLL_MS = 20 * 60 * 1000;

/**
 * Register and start the poll. Returns a stop function.
 *
 * Resolving with a value is what makes `live.js` notify subscribers, so this returns the state only
 * when the capture actually moved. A tick that finds the same capture repaints nothing — otherwise
 * the table would rebuild every twenty minutes and throw away the reader's search and sort for a
 * tick that carried nothing.
 */
export function startLive(live) {
  if (!live) return () => {};
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const changed = await read();
      if (!changed) return null;
      emit();
      return state;
    },
  });
  live.start(LIVE_ID);
  return () => live.stop(LIVE_ID);
}
