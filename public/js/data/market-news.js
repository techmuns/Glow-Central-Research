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

import { authHeaders } from '../core/host-context.js';
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
  // COUNT THE IDS THAT ARE NEW, NEVER THE DIFFERENCE IN LENGTH.
  //
  // The capture is trimmed to KEEP (600). Once it is full, one story arriving pushes the oldest
  // off the end and the LENGTH DOES NOT MOVE — measured: capture 10:24 -> 10:41 added id
  // 14019028, dropped one, count 600 both times. So `articles.length - before` is zero for every
  // real arrival on a warm cache, and the button that exists to announce arrivals could never
  // announce one. Same lesson this codebase already carries twice over (see *Performance on large
  // tables* in CLAUDE.md): a count is not a comparison, and only a comparison can catch this.
  const before = new Set(state.byId.keys());
  const changed = await read();
  const added = [...state.byId.keys()].filter((k) => !before.has(k)).length;
  emit();
  return { changed, added, total: state.articles.length, capturedAt: state.capturedAt };
}

/** The ids currently held, for a caller that needs to compare two moments rather than count one. */
export const idsHeld = () => new Set(state.byId.keys());

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
// STARTING A SCRAPE — the half of "refresh" that costs somebody something
// ---------------------------------------------------------------------------------------
//
// `refresh()` above asks whether a newer CAPTURE exists: one conditional GET, usually a bodyless
// 304, free. `startScrape()` asks the GitHub runner to go and READ MONEYCONTROL: a real Action run
// and a real request to the publisher. They are different acts and this module keeps them apart,
// the same way js/data/deep-dive.js keeps a metered POST apart from a free GET.
//
// FOUR THINGS THIS MUST NOT DO, all of them learned elsewhere in this codebase:
//
//   1. NEVER FIRE ON ITS OWN. No poller calls `startScrape`, nothing calls it on render, and the
//      route behind it is POST-only so a prefetcher cannot trip it. It happens on a click.
//   2. NEVER CLAIM THE NEWS HAS ARRIVED WHEN A RUN HAS MERELY FINISHED. The scrape commits only if
//      it found something, and `public/` reaches readers only after deploy.yml then runs. So a
//      completed run is not new stories on screen — `watchScrape` keeps checking the capture and
//      reports what it actually observed.
//   3. NEVER TRANSLATE THEIR VOCABULARY. `status` and `conclusion` are GitHub's words, passed
//      through. The view reproduces them; it does not invent a progress model for their pipeline.
//   4. NEVER TURN A NAMED FAILURE INTO "SOMETHING WENT WRONG". `no-token` is one command for an
//      operator; `unauthorised` is a token to reissue; `no-worker` means this origin is a plain
//      static server. Those have different fixes and the view says which.

// WHO ASKED, CARRIED INTO THE RUN NAME. `button` is a person pressing Fetch; `auto` is this tab
// fetching for a reader who opened it on a stale capture; an external scheduler sends `cron`. The
// last two are what `lastAutomatic` counts — see worker/index.js, which allowlists all three, so a
// value invented here would silently become `button` rather than reaching GitHub.
const DISPATCH_BASE = 'api/market-news/refresh';
const DISPATCH_SOURCES = new Set(['button', 'auto']);
const RUN_ROUTE = 'api/market-news/run';

// Long enough for a queue, a ~40s scrape and a ~90s deploy, and no longer: past this the watch
// stops and SAYS it stopped rather than spinning on a run that may never report.
const WATCH_BUDGET_MS = 6 * 60 * 1000;
const WATCH_EVERY_MS = 6000;
const REQUEST_TIMEOUT_MS = 12000;
// HOW LONG TO WAIT FOR THIS RUN'S CAPTURE TO REACH THE BROWSER, and the number has to be bigger
// than the thing it is waiting for. Measured: a push takes ~110 seconds to be served by
// Cloudflare's Git integration. At 45 seconds the grace expired first almost every time, so the
// watch reported `published` — "a new capture exists that you have not received" — when waiting
// another minute would have produced the real answer. That is not wrong, but it is the least
// informative true thing available, and it crowded out `nothing-new`, which is the one verdict on
// this tab that no other control can ever give.
//
// 150s clears a measured deploy with room to spare and still sits well inside WATCH_BUDGET_MS. A
// parameter, so a test can scale it rather than wait out the real one.
const PUBLISH_GRACE_MS = 150000;

async function askWorker(path, { method = 'GET' } = {}) {
  try {
    const res = await fetch(path, { method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: 'application/json', ...authHeaders(path) } });
    // A STATIC ORIGIN HAS NO WORKER, and that is a configuration fact rather than a failure of the
    // scrape. Saying "could not start" there would send an operator looking for a broken token
    // that does not exist.
    //
    // THE STATUS TO EXPECT IS NOT THE OBVIOUS ONE. `python3 -m http.server` answers a POST with
    // **501 Unsupported method**, not 404 — measured, and the first version of this check missed
    // it and reported the sandbox as an upstream failure. So all three of the answers a static
    // file server can give here are named, and the content type is checked as well: our Worker
    // always replies JSON, so an HTML error page is proof there is no Worker behind this origin
    // whatever number it came with.
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      return { ok: false, reason: 'no-worker', message: `This origin serves static files only — there is no Worker to start a scrape (HTTP ${res.status}).`, requested: path };
    }
    const type = res.headers.get('content-type') || '';
    if (!/json/i.test(type)) {
      return { ok: false, reason: 'no-worker', message: `This origin answered ${res.status} with ${type || 'no content type'}, not JSON — there is no Worker behind it.`, requested: path };
    }
    if (!res.ok) return { ok: false, reason: 'upstream', message: `The Worker answered ${res.status}.`, requested: path };
    return await res.json();
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'unreachable', message: String(err?.message || err), requested: path };
  }
}

/** Ask the runner to read Moneycontrol. THE ONE CALL HERE THAT STARTS WORK. */
export function startScrape(source = 'button') {
  const who = DISPATCH_SOURCES.has(source) ? source : 'button';
  // The route owns its own query string, so it is built here and never patched onto by a caller —
  // the two-question-marks bug that made every News search ask for the same thing.
  return askWorker(`${DISPATCH_BASE}?source=${who}`, { method: 'POST' });
}

/** How the run is going. Free, so this is the half that may be polled. */
export function runStatus() {
  return askWorker(RUN_ROUTE);
}

/**
 * Watch a dispatched run through to an outcome, reporting each step to `onStep`.
 *
 * The outcome is a STATEMENT ABOUT WHAT WAS OBSERVED, never a freshness claim bought on credit:
 *
 *   'landed'     new article ids arrived. `added` counts them — BY IDENTITY, never by length,
 *                because a full capture drops one story for each it gains.
 *   'nothing-new' the run's own capture reached this browser and carried no id we did not already
 *                hold. Measured, not inferred from the absence of a deploy — the scrape restamps
 *                `capturedAt` and so commits on every run, which makes a following deploy evidence
 *                of nothing at all.
 *   'publishing' the scrape finished and a deploy is running, so stories are on their way but are
 *                not on screen yet. Different from both of the above.
 *   'published'  the run finished and its capture has not reached this browser inside the grace.
 *                Neither "nothing new" (nothing measured that) nor "landed" (nothing arrived).
 *   'failed'     GitHub reports the run as failed. Theirs to fix, and it says so.
 *   'timed-out'  the budget ran out with the run still going. NOT a failure — see CLAUDE.md's
 *                "Still reading… is a fourth outcome": reporting an unfinished check as failed is
 *                a failure claim about work that has not failed.
 */
export async function watchScrape({ onStep = () => {}, budgetMs = WATCH_BUDGET_MS, everyMs = WATCH_EVERY_MS, publishGraceMs = PUBLISH_GRACE_MS, now = Date.now } = {}) {
  const startedAt = now();
  // Identity, not length — see `refresh()`. On a full capture a new story replaces an old one and
  // the count never moves, so counting would report every arrival as "nothing new".
  const idsBefore = new Set(state.byId.keys());
  const capturedBefore = state.capturedAt;
  let sawRunFinish = null;

  while (now() - startedAt < budgetMs) {
    await new Promise((r) => setTimeout(r, everyMs));
    const st = await runStatus();

    if (st.ok === false) {
      // A blip must not end the watch — but a configuration failure will not fix itself.
      if (['no-worker', 'no-token', 'no-repo', 'unauthorised', 'forbidden'].includes(st.reason)) return { outcome: 'failed', ...st };
      onStep({ phase: 'checking', error: st.reason });
      continue;
    }

    const { scrape, publish } = st;

    if (!scrape || scrape.status !== 'completed') {
      onStep({ phase: 'scraping', scrape, publish });
      continue;
    }
    if (scrape.conclusion && scrape.conclusion !== 'success') {
      return { outcome: 'failed', scrape, publish, message: `The scrape run finished as "${scrape.conclusion}".` };
    }
    if (!sawRunFinish) sawRunFinish = now();

    await refresh();
    const added = [...state.byId.keys()].filter((k) => !idsBefore.has(k)).length;
    if (added > 0) return { outcome: 'landed', added, scrape, publish };

    // ZERO NEW IDS IS ONLY AN ANSWER ONCE WE ARE LOOKING AT THIS RUN'S OWN OUTPUT.
    //
    // The scrape stamps `capturedAt` on every run and therefore commits on every run, so a deploy
    // following the run proves nothing about whether stories were found — the first version read
    // it as proof and concluded "nothing new" from its absence, seconds after the run ended and
    // long before any deploy could have appeared. The honest gate is the capture itself: until
    // `capturedAt` moves past what we held, the bytes on screen predate the run and say nothing
    // about it.
    const movedOn = state.capturedAt && state.capturedAt !== capturedBefore;
    if (movedOn) return { outcome: 'nothing-new', scrape, publish };

    if (publish && publish.status !== 'completed') {
      onStep({ phase: 'publishing', scrape, publish });
      continue;
    }
    if (publish && publish.conclusion && publish.conclusion !== 'success') {
      return { outcome: 'publish-failed', scrape, publish, message: `The run finished, but the deploy after it finished as "${publish.conclusion}", so the new capture is not on the site yet.` };
    }
    // The run is done and its capture has not reached this browser. Give it a bounded grace, then
    // say exactly that — neither "nothing new" (unmeasured) nor "landed" (untrue).
    if (now() - sawRunFinish >= publishGraceMs) return { outcome: 'published', scrape, publish };
    onStep({ phase: 'publishing', scrape, publish });
  }
  return { outcome: 'timed-out' };
}

// ---------------------------------------------------------------------------------------
// The twenty-minute poll
// ---------------------------------------------------------------------------------------

export const LIVE_ID = 'market-news';

// TWENTY MINUTES, AND THE REASON IS NO LONGER "THAT IS THE ACTION'S CADENCE".
//
// It was, and the measurement killed that rationale: a `*/20` cron fired 12 times in 41 hours, and
// the job now runs every 30 minutes across the window the publisher answers and hourly outside it.
// So this interval is no longer matched to anything upstream — it is simply a floor on how stale a
// mounted tab can be, chosen because an unchanged poll is a bodyless 304 and therefore nearly free.
// Polling faster would not surface a story sooner; polling slower would only delay one that landed.
// The capture's own `capturedAt` is what the page reports, so this number is never a freshness
// claim — it only decides how quickly a published capture is noticed.
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
