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
// THE FAN-OUT IS BOUNDED AND PROGRESSIVE. The list is one request; each book is another. With
// dozens of investors that is dozens of requests, so they run CONCURRENCY at a time and the tab
// repaints as each lands rather than blocking on the slowest. The device store makes the second
// visit nearly free — every book is held under its own ETag and a repeat fetch is a bodyless 304.
//
// A FAILED BOOK IS NOT AN EMPTY BOOK. `ok: false` from the Worker carries a `reason`, and this
// module keeps it per investor. The card says "could not be read" and names why; it never shows a
// holdings count of zero for a book that failed to load.

import { conditionalJson, KEYS, isPersistent } from '../core/store.js';
import { normalisePortfolio, deriveMoves, summarise } from './finology-shared.js';

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
    origin: state.origin,
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

/** Fetch every book, CONCURRENCY at a time, emitting as each lands. */
async function walkBooks() {
  const queue = state.investors.map((i) => i.slug).filter(Boolean);
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      state.inFlight++;
      await loadBook(slug);
      state.inFlight--;
      emit();
    }
  });
  await Promise.all(workers);
  emit();
}

/** One book. Never throws — a failure is recorded against that investor and the walk continues. */
export async function loadBook(slug) {
  if (state.books.has(slug)) return state.books.get(slug);
  let res;
  try {
    res = await conditionalJson(bookPath(slug), { key: KEYS.investorBook(slug), optional: true });
  } catch {
    res = null;
  }
  const body = res?.value;
  if (!body || body.ok === false) {
    state.failures.set(slug, {
      reason: body?.reason || 'unreachable',
      message: body?.message || 'This investor’s book could not be read.',
    });
    return null;
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

/** Every quarter label seen across the loaded books, newest first as the source orders them. */
export function quarterLabels() {
  const seen = [];
  for (const b of state.books.values()) {
    for (const q of b.quarters) if (!seen.includes(q)) seen.push(q);
  }
  return seen;
}
