// data/super-investors.js — the live super-investor feed, off Ticker Finology via our Worker.
//
//   load()              the list, then every book, painting as they arrive
//   list()              [{ name, slug, bio, imageUrl }]
//   book(slug)          one normalised portfolio, or null if it has not landed
//   books()             every book that has landed
//   movesFor(slug)      quarter-over-quarter changes for one investor
//   allMoves()          the same across every loaded book
//   meta()              what loaded, what failed, where the paint came from, and when
//   onChange(fn)        fires as each book lands, so the grid fills in progressively
//
// LOADED ONCE PER PAGE, NEVER POLLED. Shareholding data changes when a company files, which is
// once a quarter. A poller here would re-scrape somebody else's service every thirty seconds to
// re-learn a number that moves four times a year.
//
// THE DEVICE IS READ BEFORE THE NETWORK IS ASKED ANYTHING.
//   Ninety investors means ninety-one requests: the list, then one page per book. Conditional
//   fetching already made the BYTES nearly free on a second visit — every unchanged book is a
//   bodyless 304 — but a 304 is still a round trip, and ninety-one of them four at a time is
//   twenty-three sequential waits before the grid is full. That is the delay, and no amount of
//   caching at the HTTP layer removes it, because the wait is latency and not bandwidth.
//
//   So `load()` now runs in two passes. The first reads everything already on this device and paints
//   it, touching the network zero times; the second revalidates in the background and repaints only
//   the books that actually moved. A returning reader sees the whole grid immediately.
//
//   THE STORE HOLDS THE SERVER'S OWN BYTES UNDER THE SERVER'S OWN TAG — never a locally patched
//   copy — which is the entire basis for trusting a paint that asked nobody. `meta().origin` says
//   `store` while that is what is on screen, and flips to `live` once the revalidation lands, so
//   the view can never claim a freshness it has not confirmed.
//
// A FAILED BOOK IS NOT AN EMPTY BOOK. `ok: false` from the Worker carries a `reason`, and this
// module keeps it per investor. The card says "could not be read" and names why; it never shows a
// holdings count of zero for a book that failed to load.
//
// THREE THINGS THAT MADE A RETURN VISIT SLOW, AND WHAT REPLACED THEM.
//   1. EVERY BOOK WAS RE-ASKED ON EVERY PAGE LOAD. The revalidation pass walked all ninety-one
//      unconditionally, so a reader who opened the tab twice in a minute paid ninety-one round
//      trips to be told nothing had changed. The Worker's own edge window is six hours, so asking
//      again inside it CANNOT learn anything new — the server would hand back the identical bytes
//      it already gave us. `REVALIDATE_AFTER_MS` matches that window exactly, and a book confirmed
//      inside it is left alone. A book that has never been read, and one carrying the server's
//      `stale` flag, are always asked for regardless: the first has nothing to skip and the second
//      is precisely the copy that wants replacing.
//   2. NINETY-ONE INDEXEDDB TRANSACTIONS BEFORE FIRST PAINT. `readEntry` per book, each opening
//      its own transaction. `readEntries` does the lot in one.
//   3. NINETY FULL REPAINTS OF A FOUR-THOUSAND-ROW TABLE. Every arriving book emitted, and the tab
//      rebuilds its whole panel — stat strip, ninety cards and the positions table — on each emit.
//      Arrivals are now coalesced into at most one repaint per EMIT_COALESCE_MS, which turns that
//      into a handful. The walk's final emit is still immediate, so the settled state is never
//      left waiting behind a timer.
//
// NONE OF THAT MAY BUY SPEED WITH A FRESHNESS CLAIM WE CANNOT SUPPORT. `meta().origin` still reads
// `store` for as long as any painted book is unconfirmed — which, with the skip above, is the
// normal state of a quick return visit — and `meta().checkedAt` reports the OLDEST confirmation
// behind what is on screen rather than the newest. `refresh()` is the escape hatch, wired to a
// re-read control in the Live pill's modal, and it asks for everything again.

import { conditionalJson, readEntries, KEYS, isPersistent } from '../core/store.js';
import { normalisePortfolio, deriveMoves, summarise, quarterOrder } from './finology-shared.js';

const LIST_PATH = 'api/super-investors';
const bookPath = (slug) => `api/super-investors/${encodeURIComponent(slug)}`;

// How many books are in flight at once. Each one MAY be a live scrape upstream, so this is
// politeness as much as it is throughput: four keeps a cold edge filling steadily without arriving
// as a burst of sixty simultaneous page reads on their service. Against a warm edge every one of
// these is a cache read of a few milliseconds and the ceiling stops mattering.
const CONCURRENCY = 4;

// Matches INVESTOR_TTL_S in worker/index.js. This is not a guess at how stale is tolerable — it is
// the window inside which the server has nothing else to tell us, so a request would be spent
// receiving bytes we already hold.
const REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1000;

// Books arrive faster than a repaint of the panel takes. Long enough to absorb a burst, short
// enough that the grid still visibly fills rather than appearing in one jump.
const EMIT_COALESCE_MS = 120;

let state = fresh();
let loading = null;
const subscribers = new Set();

function fresh() {
  return {
    loaded: false,
    listOk: false,
    reason: null, // 'no-token' | 'unauthorised' | 'unreachable' | 'upstream' | 'shape' | null
    message: null,
    investors: [],
    dropped: 0,
    books: new Map(), // slug -> normalised portfolio
    failures: new Map(), // slug -> { reason, message }
    // slug -> when the SERVER last confirmed those bytes. Read off the device entry's savedAt on
    // a seeded paint and off the response's checkedAt on a live one, so it means the same thing
    // either way: the last moment anything but this tab vouched for the figure on screen.
    confirmedAt: new Map(),
    // Slugs the Worker served from its last-good copy because the upstream was down. Real filed
    // data, labelled, and never eligible for the revalidation skip.
    staleBooks: new Set(),
    stale: false, // the LIST itself came back as a last-good copy
    staleReason: null,
    fetchedAt: null,
    checkedAt: null,
    origin: null, // 'live' | 'store'
    inFlight: 0,
    // Books painted from the device and not yet confirmed against the server. While this is
    // non-empty the view says the paint came from the cache, because it did.
    unconfirmed: new Set(),
    revalidating: false,
  };
}

export const isLoaded = () => state.loaded;
export const list = () => state.investors;
export const book = (slug) => state.books.get(slug) || null;
export const books = () => [...state.books.values()];
export const failureFor = (slug) => state.failures.get(slug) || null;

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------------------------------
// Repaints, coalesced
//
// A subscriber here is the whole tab panel: stat strip, ninety investor cards and a table of every
// disclosed position across every book. Rebuilding that is tens of milliseconds, and the walk used
// to trigger one per arriving book. Ninety of them, back to back, is what a reader experienced as
// the view "taking too long" even after the data was on the device.
//
// A trailing throttle rather than a debounce, deliberately: a debounce would keep deferring while
// books kept landing and the grid would sit still until the walk finished.
// ---------------------------------------------------------------------------------------
let emitTimer = null;
const fire = () => subscribers.forEach((fn) => fn());

function emit({ now = false } = {}) {
  if (now) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    fire();
    return;
  }
  if (emitTimer) return; // one is already scheduled; this arrival rides on it
  emitTimer = setTimeout(() => {
    emitTimer = null;
    fire();
  }, EMIT_COALESCE_MS);
}

// Every derived view of the books — every holding, every move, the quarter columns — is rebuilt
// from scratch by the tab on each paint. `version` moves whenever a book does, so the work is done
// once per change instead of once per paint. See `derived()` at the foot of this file.
let version = 0;
const bump = () => {
  version++;
};

// WHICH STATE AN IN-FLIGHT REQUEST BELONGS TO.
//
// `state` is a module binding that `invalidate()` REPLACES, and the walk is ninety-one requests
// deep when a reader hits "Re-read everything now". Without this, the abandoned pass would keep
// writing into the new state as its requests landed: books and confirmation stamps from the run
// that was discarded, and — worse — its `finally` would clear `revalidating` and flip `origin` to
// `live` for a pass that had not happened yet. Every async continuation therefore checks that the
// generation it started in is still the current one before it touches anything.
let generation = 0;
const current = (gen) => gen === generation;

export function meta() {
  return {
    ok: state.listOk,
    reason: state.reason,
    message: state.message,
    total: state.investors.length,
    dropped: state.dropped,
    loadedBooks: state.books.size,
    failedBooks: state.failures.size,
    pending: Math.max(0, state.investors.length - state.books.size - state.failures.size),
    inFlight: state.inFlight,
    fetchedAt: state.fetchedAt,
    // The OLDEST confirmation behind what is on screen, not the newest. With the revalidation skip
    // most of a return visit's books are as fresh as the device copy and no fresher, and reporting
    // the list's own check would overstate every one of them.
    checkedAt: oldestCheckedAt(),
    // `store` until every painted book has been confirmed against the server, then `live`. The view
    // must never say it read something live that it read off this device.
    origin: state.unconfirmed.size ? 'store' : state.origin,
    confirming: state.revalidating,
    // The Worker could not reach the upstream and served its last good read instead. Real filed
    // data of a known age, never invented — but it is not what the source would say right now,
    // and the panel says so.
    stale: state.stale || state.staleBooks.size > 0,
    staleReason: state.staleReason,
    staleBooks: state.staleBooks.size,
    persisted: isPersistent(),
    source: 'Ticker Finology, via devde.muns.io',
  };
}

/** The oldest moment anything on screen was confirmed by the server. */
function oldestCheckedAt() {
  let oldest = state.checkedAt;
  for (const slug of state.unconfirmed) {
    const at = state.confirmedAt.get(slug);
    if (at != null && (oldest == null || at < oldest)) oldest = at;
  }
  return oldest;
}

/** Discard everything and re-read. Nothing calls this on a timer. */
export function invalidate() {
  state = fresh();
  loading = null;
  generation++;
  bump();
}

/**
 * Throw away every confirmation and read the whole feed again.
 *
 * This is what makes the revalidation skip honest rather than merely fast: a reader who wants to
 * know whether anything has moved in the last six hours has a control that asks. It is wired to
 * the Live pill's modal in js/investors/live.js and to nothing automatic.
 */
export function refresh() {
  invalidate();
  return load();
}

/**
 * Fetch the list, then every book.
 *
 * Resolves once the LIST has landed, not once every book has — the grid can render investors from
 * the list alone, and each card fills in as its book arrives. Waiting for all of them would leave
 * the tab blank for as long as the slowest scrape takes.
 */
export function load() {
  if (loading) return loading;
  const gen = generation;
  loading = (async () => {
    // PASS ONE — everything this device already has, with no network at all.
    //
    // A hit here means the grid is complete before the first request is even sent. A miss is not an
    // error and never has been: it means "fetch it", which is what pass two does regardless.
    const seeded = await seedFromStore(gen);
    if (!current(gen)) return state; // a re-read replaced everything while the device was read
    if (seeded) {
      state.loaded = true;
      state.origin = 'store';
      emit({ now: true });
      // Confirm in the background. Deliberately not awaited — the caller's `then` should fire on
      // the paint it can already make, not on a revalidation the reader will never notice.
      revalidate();
      return state;
    }

    let res;
    try {
      res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
    } catch {
      res = null;
    }
    if (!current(gen)) return state;
    const body = res?.value;
    state.checkedAt = res?.checkedAt || Date.now();
    state.origin = res?.fromStore ? 'store' : 'live';

    if (!body) {
      // No route at this origin at all — a plain static server rather than the Worker.
      state.reason = 'no-route';
      state.message = 'This origin has no /api/super-investors route. The live feed needs the Cloudflare Worker.';
      state.loaded = true;
      emit({ now: true });
      return state;
    }
    if (body.ok === false) {
      state.reason = body.reason || 'upstream';
      state.message = body.message || 'The super-investor feed could not be read.';
      state.loaded = true;
      emit({ now: true });
      return state;
    }

    state.listOk = true;
    state.investors = Array.isArray(body.investors) ? body.investors : [];
    state.dropped = body.dropped || 0;
    state.fetchedAt = body.fetchedAt || null;
    state.stale = body.stale === true;
    state.staleReason = body.stale === true ? body.staleReason || null : null;
    state.loaded = true;
    bump();
    emit({ now: true });

    // Books land in the background. Deliberately not awaited: the grid is already useful.
    walkBooks();
    return state;
  })();
  return loading;
}

/**
 * Pass one: rebuild the whole view from the device, asking the network nothing.
 *
 * Returns false when the list is not on this device, in which case there is nothing to paint early
 * and the normal path runs. A PARTIAL hit is still a hit — books that are not cached simply stay
 * pending and arrive in pass two, exactly as they would on a first visit.
 */
async function seedFromStore(gen) {
  let entry;
  try {
    entry = (await readEntries([KEYS.investorList])).get(KEYS.investorList);
  } catch {
    return false;
  }
  if (!current(gen)) return false;
  const body = entry?.value;
  // A stored failure is not something to paint. `ok: false` is cached for fifteen seconds upstream
  // precisely so a corrected token takes effect at once, and replaying it from disk would undo that.
  if (!body || body.ok === false || !Array.isArray(body.investors) || !body.investors.length) return false;

  state.listOk = true;
  state.investors = body.investors;
  state.dropped = body.dropped || 0;
  state.fetchedAt = body.fetchedAt || null;
  state.checkedAt = entry.savedAt || null;
  state.stale = body.stale === true;
  state.staleReason = body.stale === true ? body.staleReason || null : null;

  // ONE transaction for every book, not one per book. Ninety-one round trips to the storage thread
  // sat directly on the critical path of the first paint, which is the paint this whole two-pass
  // arrangement exists to make fast.
  let stored;
  try {
    stored = await readEntries(state.investors.map((i) => KEYS.investorBook(i.slug)));
  } catch {
    stored = new Map();
  }
  if (!current(gen)) return false;
  for (const i of state.investors) {
    const hit = stored.get(KEYS.investorBook(i.slug));
    const value = hit?.value;
    if (!value || value.ok === false) continue;
    // Re-normalised rather than trusted: these bytes were written by whatever version of the Worker
    // was live when they were cached, and the shape guard is what makes that safe.
    state.books.set(i.slug, normalisePortfolio(value, i.slug));
    state.unconfirmed.add(i.slug);
    state.confirmedAt.set(i.slug, hit.savedAt || null);
    // A last-good copy the Worker served during an outage. It is real and it is labelled, and it
    // is the one thing the revalidation skip must never apply to.
    if (value.stale === true) state.staleBooks.add(i.slug);
  }
  bump();
  return true;
}

/**
 * Pass two: confirm what was painted from the device, and fill in what was not.
 *
 * Every book goes back through `conditionalJson`, so an unchanged one is a bodyless 304 and its row
 * is left alone — no repaint, no flicker, no work. Only a book whose bytes actually changed emits.
 * Nothing here can turn a painted book into an empty one: a failed revalidation leaves the cached
 * copy on screen and is recorded against the investor, because a book we HAVE is better than a gap,
 * and pretending the fund holds nothing would be worse than both.
 */
async function revalidate() {
  if (state.revalidating) return;
  const gen = generation;
  state.revalidating = true;
  try {
    let res;
    try {
      res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
    } catch {
      res = null;
    }
    if (!current(gen)) return;
    const body = res?.value;
    if (body && body.ok !== false && Array.isArray(body.investors)) {
      state.checkedAt = res.checkedAt;
      state.dropped = body.dropped || 0;
      if (body.fetchedAt) state.fetchedAt = body.fetchedAt;
      state.stale = body.stale === true;
      state.staleReason = body.stale === true ? body.staleReason || null : null;
      // An investor added or removed upstream since the cached read.
      if (body.investors.length !== state.investors.length) {
        state.investors = body.investors;
        bump();
      }
    }
    await walkBooks({ force: true });
  } finally {
    // Only the pass that owns the current state may report on it. An abandoned pass finishing here
    // would clear `revalidating` and flip `origin` to `live` for a re-read that has not run yet.
    if (current(gen)) {
      state.revalidating = false;
      // NOT a blanket clear. A book the walk deliberately skipped is a book nobody confirmed, and
      // wiping it out of `unconfirmed` would let `meta().origin` report `live` for bytes that were
      // read off this device — the precise claim the store layer is built never to make. `loadBook`
      // removes each slug as the server actually vouches for it.
      if (!state.unconfirmed.size) state.origin = 'live';
      emit({ now: true });
    }
  }
}

/**
 * Fetch every book that still needs fetching, CONCURRENCY at a time, emitting as they land.
 *
 * `force` re-asks for books already in memory, which is what the revalidation pass needs; the
 * first-visit walk skips them, because a book in memory there has just been fetched.
 *
 * WHAT THE REVALIDATION PASS DOES *NOT* ASK FOR is the change that made a return visit quick. A
 * book the server confirmed within REVALIDATE_AFTER_MS is inside the Worker's own edge window, so
 * the request would spend a round trip receiving bytes already on this device. Two exceptions,
 * both of which would otherwise strand a reader on something worse than a slow paint: a book we do
 * not have at all, and a book the Worker served from its last-good copy during an outage.
 */
async function walkBooks({ force = false } = {}) {
  const gen = generation;
  const queue = state.investors.map((i) => i.slug).filter(Boolean).filter((slug) => !force || needsRevalidation(slug));
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      // A re-read abandons this walk. Ninety-one requests deep, continuing would spend them all
      // filling a state nobody is looking at any more.
      if (!current(gen)) return;
      const slug = queue.shift();
      if (!slug) return;
      state.inFlight++;
      const changed = await loadBook(slug, { force, gen });
      if (!current(gen)) return;
      state.inFlight--;
      // On the revalidation pass an unchanged book is the common case and repainting for it would
      // rebuild the grid ninety times to display exactly what is already there.
      if (!force || changed) emit();
    }
  });
  await Promise.all(workers);
  if (current(gen)) emit({ now: true });
}

function needsRevalidation(slug) {
  if (!state.books.has(slug)) return true; // never read: there is nothing to skip
  if (state.staleBooks.has(slug)) return true; // a last-good copy is exactly what wants replacing
  const at = state.confirmedAt.get(slug);
  if (at == null) return true; // no idea when it was confirmed, so treat it as unconfirmed
  return Date.now() - at >= REVALIDATE_AFTER_MS;
}

/**
 * One book. Never throws — a failure is recorded against that investor and the walk continues.
 *
 * Returns the portfolio on a first read, `true` when a revalidation found different bytes, and
 * `false` when it did not.
 */
export async function loadBook(slug, { force = false, gen = generation } = {}) {
  const had = state.books.get(slug);
  if (had && !force) return had;

  let res;
  try {
    res = await conditionalJson(bookPath(slug), { key: KEYS.investorBook(slug), optional: true });
  } catch {
    res = null;
  }
  // A re-read replaced the state while this was in flight. The bytes are already in the device
  // store, where the new pass will find them; writing them into a state they do not belong to
  // would stamp a confirmation the new pass never made.
  if (!current(gen)) return false;
  const body = res?.value;
  if (!body || body.ok === false) {
    // A revalidation that fails must not delete a book we already have. The cached copy is a real
    // read of a real filing; replacing it with "could not be read" because a later request timed
    // out would throw away good data to report a transient network event.
    //
    // It also must not be recorded as CONFIRMED. Nothing vouched for those bytes — the request
    // failed — so the slug stays in `unconfirmed`, `meta().origin` keeps saying `store`, and the
    // next visit asks again instead of resting on a six-hour skip it never earned.
    if (had) return false;
    state.failures.set(slug, {
      reason: body?.reason || 'unreachable',
      message: body?.message || 'This investor’s book could not be read.',
    });
    return null;
  }
  // The server answered, so whatever it said about these bytes is now confirmed as of this moment.
  state.confirmedAt.set(slug, res.checkedAt || Date.now());
  if (body.stale === true) state.staleBooks.add(slug);
  else state.staleBooks.delete(slug);

  if (had) {
    state.unconfirmed.delete(slug);
    // `fromStore` is the conditional layer reporting a 304 — the server confirmed the bytes we
    // already had, so there is nothing to re-normalise and nothing to repaint.
    if (res.fromStore) return false;
    state.books.set(slug, normalisePortfolio(body, slug));
    state.failures.delete(slug);
    bump();
    return true;
  }
  // Re-normalise client-side rather than trusting the shape that came back. The Worker already
  // guarded it, but this module also serves values read straight out of the device store, which
  // were written by whatever version of the Worker was live when they were cached.
  const portfolio = normalisePortfolio(body, slug);
  state.books.set(slug, portfolio);
  state.failures.delete(slug);
  if (!state.fetchedAt && body.fetchedAt) state.fetchedAt = body.fetchedAt;
  bump();
  return portfolio;
}

/** Quarter-over-quarter changes for one investor. Derived — see finology-shared.js. */
export function movesFor(slug) {
  const b = state.books.get(slug);
  return b ? deriveMoves(b) : { comparable: false, latest: null, prior: null, moves: [] };
}

// ---------------------------------------------------------------------------------------
// The derived views, built once per change rather than once per paint
//
// The tab rebuilds its whole panel from these on every repaint, and with ninety books they are the
// most expensive thing it does: `allHoldings` allocates a row per investor-company pair — several
// thousand — and `allMoves` runs `deriveMoves` over every book. Both were recomputed from scratch
// on each of the ninety arrivals.
//
// `version` moves whenever a book, a failure or the investor list does, so this memo can never
// serve a view of data that has since changed. It is a cache of a pure function of `state`, which
// is the only kind of cache that needs no invalidation rules beyond that.
// ---------------------------------------------------------------------------------------
let memo = { version: -1 };

function derived() {
  if (memo.version === version) return memo;

  const moves = [];
  const holdings = [];
  const seenQuarters = [];
  for (const b of state.books.values()) {
    for (const q of b.quarters) if (!seenQuarters.includes(q)) seenQuarters.push(q);

    const [latest] = b.quarters;
    for (const h of b.holdings) {
      holdings.push({
        investor: b.name,
        slug: b.slug,
        company: h.company,
        companySlug: h.companySlug,
        quarterlyHoldings: h.quarterlyHoldings,
        quarters: b.quarters,
        latest: latest || null,
        pct: latest ? h.quarterlyHoldings[latest] : null,
        valueCr: h.valueCr,
      });
    }

    const { comparable, latest: l, prior, moves: ms } = deriveMoves(b);
    if (!comparable) continue;
    for (const m of ms) moves.push({ ...m, investor: b.name, slug: b.slug, latest: l, prior });
  }

  memo = { version, moves, holdings, quarters: orderQuarters(seenQuarters) };
  return memo;
}

/**
 * Every quarter label seen across the loaded books, newest first.
 *
 * ONE COLUMN PER QUARTER IS BUILT FROM THIS, so the order is the table's order. Collecting in
 * book-arrival order put whichever investor answered first at the left, which is a property of the
 * network rather than of the calendar — and with books published to different quarters the columns
 * came out interleaved. Sorted on the parsed label instead, falling back to arrival order for
 * labels that do not parse.
 */
function orderQuarters(seen) {
  const keyed = seen.map((q, i) => ({ q, i, n: quarterOrder(q) }));
  if (keyed.some((k) => k.n == null)) return seen;
  return keyed.sort((a, b) => b.n - a.n || a.i - b.i).map((k) => k.q);
}

/** Every move across every loaded book, tagged with whose it is. */
export function allMoves() {
  return derived().moves;
}

/** Totals for one book. */
export const totalsFor = (slug) => {
  const b = state.books.get(slug);
  return b ? summarise(b) : null;
};

/**
 * Companies held by more than one tracked investor, most-held first.
 *
 * A count of who discloses the same name, not a view about it. Only the latest quarter of each
 * book counts, because an overlap between one investor's 2024 position and another's 2026 one is
 * not an overlap.
 */
export function overlaps() {
  const byCompany = new Map();
  for (const b of state.books.values()) {
    const [latest] = b.quarters;
    if (!latest) continue;
    for (const h of b.holdings) {
      if (h.quarterlyHoldings[latest] == null) continue;
      const key = h.company;
      if (!byCompany.has(key)) byCompany.set(key, { company: key, companySlug: h.companySlug, holders: [] });
      byCompany.get(key).holders.push({ investor: b.name, slug: b.slug, pct: h.quarterlyHoldings[latest], valueCr: h.valueCr });
    }
  }
  return [...byCompany.values()]
    .filter((c) => c.holders.length > 1)
    .sort((a, b) => b.holders.length - a.holders.length || b.holders.reduce((s, h) => s + h.pct, 0) - a.holders.reduce((s, h) => s + h.pct, 0));
}

/**
 * Every holding across every loaded book, one row per investor-company pair.
 *
 * This is what the all-positions table renders, and what the export writes.
 */
export function allHoldings() {
  return derived().holdings;
}

/** Every quarter label seen across the loaded books, newest first. See `orderQuarters` above. */
export function quarterLabels() {
  return derived().quarters;
}

/** The newest quarter any loaded book publishes — what "this quarter" means across the feed. */
export function latestQuarter() {
  return derived().quarters[0] || null;
}
