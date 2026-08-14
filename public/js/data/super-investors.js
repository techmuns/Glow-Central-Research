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

import { conditionalJson, readEntry, KEYS, isPersistent } from '../core/store.js';
import { normalisePortfolio, deriveMoves, summarise, quarterOrder } from './finology-shared.js';

const LIST_PATH = 'api/super-investors';
const bookPath = (slug) => `api/super-investors/${encodeURIComponent(slug)}`;

// How many books are in flight at once. Each one is a live scrape upstream, so this is politeness
// as much as it is throughput: four keeps a cold cache filling steadily without arriving as a
// burst of sixty simultaneous page reads on their service.
const CONCURRENCY = 4;

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
const emit = () => subscribers.forEach((fn) => fn());

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
    checkedAt: state.checkedAt,
    // `store` until every painted book has been confirmed against the server, then `live`. The view
    // must never say it read something live that it read off this device.
    origin: state.unconfirmed.size ? 'store' : state.origin,
    confirming: state.revalidating,
    persisted: isPersistent(),
    source: 'Ticker Finology, via devde.muns.io',
  };
}

/** Discard everything and re-read. The Refresh control uses this; nothing calls it on a timer. */
export function invalidate() {
  state = fresh();
  loading = null;
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
  loading = (async () => {
    // PASS ONE — everything this device already has, with no network at all.
    //
    // A hit here means the grid is complete before the first request is even sent. A miss is not an
    // error and never has been: it means "fetch it", which is what pass two does regardless.
    const seeded = await seedFromStore();
    if (seeded) {
      state.loaded = true;
      state.origin = 'store';
      emit();
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
    const body = res?.value;
    state.checkedAt = res?.checkedAt || Date.now();
    state.origin = res?.fromStore ? 'store' : 'live';

    if (!body) {
      // No route at this origin at all — a plain static server rather than the Worker.
      state.reason = 'no-route';
      state.message = 'This origin has no /api/super-investors route. The live feed needs the Cloudflare Worker.';
      state.loaded = true;
      emit();
      return state;
    }
    if (body.ok === false) {
      state.reason = body.reason || 'upstream';
      state.message = body.message || 'The super-investor feed could not be read.';
      state.loaded = true;
      emit();
      return state;
    }

    state.listOk = true;
    state.investors = Array.isArray(body.investors) ? body.investors : [];
    state.dropped = body.dropped || 0;
    state.fetchedAt = body.fetchedAt || null;
    state.loaded = true;
    emit();

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
async function seedFromStore() {
  let entry;
  try {
    entry = await readEntry(KEYS.investorList);
  } catch {
    return false;
  }
  const body = entry?.value;
  // A stored failure is not something to paint. `ok: false` is cached for fifteen seconds upstream
  // precisely so a corrected token takes effect at once, and replaying it from disk would undo that.
  if (!body || body.ok === false || !Array.isArray(body.investors) || !body.investors.length) return false;

  state.listOk = true;
  state.investors = body.investors;
  state.dropped = body.dropped || 0;
  state.fetchedAt = body.fetchedAt || null;
  state.checkedAt = entry.savedAt || null;

  const books = await Promise.all(
    state.investors.map(async (i) => {
      try {
        const hit = await readEntry(KEYS.investorBook(i.slug));
        return hit?.value && hit.value.ok !== false ? [i.slug, hit.value] : null;
      } catch {
        return null;
      }
    })
  );
  for (const hit of books) {
    if (!hit) continue;
    const [slug, value] = hit;
    // Re-normalised rather than trusted: these bytes were written by whatever version of the Worker
    // was live when they were cached, and the shape guard is what makes that safe.
    state.books.set(slug, normalisePortfolio(value, slug));
    state.unconfirmed.add(slug);
  }
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
  state.revalidating = true;
  try {
    let res;
    try {
      res = await conditionalJson(LIST_PATH, { key: KEYS.investorList, optional: true });
    } catch {
      res = null;
    }
    const body = res?.value;
    if (body && body.ok !== false && Array.isArray(body.investors)) {
      state.checkedAt = res.checkedAt;
      state.dropped = body.dropped || 0;
      if (body.fetchedAt) state.fetchedAt = body.fetchedAt;
      // An investor added or removed upstream since the cached read.
      if (body.investors.length !== state.investors.length) state.investors = body.investors;
    }
    await walkBooks({ force: true });
  } finally {
    state.revalidating = false;
    state.unconfirmed.clear();
    state.origin = 'live';
    emit();
  }
}

/**
 * Fetch every book, CONCURRENCY at a time, emitting as each lands.
 *
 * `force` re-asks for books already in memory, which is what the revalidation pass needs; the
 * first-visit walk skips them, because a book in memory there has just been fetched.
 */
async function walkBooks({ force = false } = {}) {
  const queue = state.investors.map((i) => i.slug).filter(Boolean);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      state.inFlight++;
      const changed = await loadBook(slug, { force });
      state.inFlight--;
      // On the revalidation pass an unchanged book is the common case and repainting for it would
      // rebuild the grid ninety times to display exactly what is already there.
      if (!force || changed) emit();
    }
  });
  await Promise.all(workers);
  emit();
}

/**
 * One book. Never throws — a failure is recorded against that investor and the walk continues.
 *
 * Returns the portfolio on a first read, `true` when a revalidation found different bytes, and
 * `false` when it did not.
 */
export async function loadBook(slug, { force = false } = {}) {
  const had = state.books.get(slug);
  if (had && !force) return had;

  let res;
  try {
    res = await conditionalJson(bookPath(slug), { key: KEYS.investorBook(slug), optional: true });
  } catch {
    res = null;
  }
  const body = res?.value;
  if (!body || body.ok === false) {
    // A revalidation that fails must not delete a book we already have. The cached copy is a real
    // read of a real filing; replacing it with "could not be read" because a later request timed
    // out would throw away good data to report a transient network event.
    if (had) {
      state.unconfirmed.delete(slug);
      return false;
    }
    state.failures.set(slug, {
      reason: body?.reason || 'unreachable',
      message: body?.message || 'This investor’s book could not be read.',
    });
    return null;
  }
  if (had) {
    state.unconfirmed.delete(slug);
    // `fromStore` is the conditional layer reporting a 304 — the server confirmed the bytes we
    // already had, so there is nothing to re-normalise and nothing to repaint.
    if (res.fromStore) return false;
    state.books.set(slug, normalisePortfolio(body, slug));
    state.failures.delete(slug);
    return true;
  }
  // Re-normalise client-side rather than trusting the shape that came back. The Worker already
  // guarded it, but this module also serves values read straight out of the device store, which
  // were written by whatever version of the Worker was live when they were cached.
  const portfolio = normalisePortfolio(body, slug);
  state.books.set(slug, portfolio);
  state.failures.delete(slug);
  if (!state.fetchedAt && body.fetchedAt) state.fetchedAt = body.fetchedAt;
  return portfolio;
}

/** Quarter-over-quarter changes for one investor. Derived — see finology-shared.js. */
export function movesFor(slug) {
  const b = state.books.get(slug);
  return b ? deriveMoves(b) : { comparable: false, latest: null, prior: null, moves: [] };
}

/** Every move across every loaded book, tagged with whose it is. */
export function allMoves() {
  const out = [];
  for (const b of state.books.values()) {
    const { comparable, latest, prior, moves } = deriveMoves(b);
    if (!comparable) continue;
    for (const m of moves) out.push({ ...m, investor: b.name, slug: b.slug, latest, prior });
  }
  return out;
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
  const out = [];
  for (const b of state.books.values()) {
    const [latest] = b.quarters;
    for (const h of b.holdings) {
      out.push({
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
  }
  return out;
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
export function quarterLabels() {
  const seen = [];
  for (const b of state.books.values()) {
    for (const q of b.quarters) if (!seen.includes(q)) seen.push(q);
  }
  const keyed = seen.map((q, i) => ({ q, i, n: quarterOrder(q) }));
  if (keyed.some((k) => k.n == null)) return seen;
  return keyed.sort((a, b) => b.n - a.n || a.i - b.i).map((k) => k.q);
}

/** The newest quarter any loaded book publishes — what "this quarter" means across the feed. */
export function latestQuarter() {
  return quarterLabels()[0] || null;
}
