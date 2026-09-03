// data/nse-filings.js — NSE's live announcements feed, narrowed to the reader's scope.
//
//   nseFilings.load()                the committed snapshot first, then the live route
//   nseFilings.rows()                every announcement held, newest first
//   nseFilings.forScope(scope, h)    narrowed to Portfolio / Watchlist, or all of it for Universe
//   nseFilings.meta()                counts, capture time, origin, resolution coverage
//   nseFilings.startLive(live)       poll the Worker for new filings; stopLive() to stop
//   nseFilings.onChange(fn)          fires when the feed moves
//
// THE ONE EXCHANGE FEED THAT NARROWS TO A READER'S COMPANIES, LIVE. NSE rebuilds its announcements
// RSS every few minutes and every item names the filing company, so each row carries a resolved
// `ticker` and the scope toggle can show just the reader's holdings. Resolution happens on the
// Worker (it needs the universe), so the browser only filters — exactly like every other feed here.
//
// THE BROWSER CANNOT READ NSE ITSELF (CORS `null`), so `api/nse-announcements` is the live source and
// `data/nse-announcements.json` is the committed floor beneath it, painted first and on any origin
// with no Worker. A row with `ticker: null` is a company outside the universe we can name; it shows
// in Universe and never under a narrowed scope, because nothing on it says whose it is.

import { conditionalJson, revalidatedJson, readEntry, KEYS } from '../core/store.js';
import { filterByScope } from './scope.js';

const LIVE_ENDPOINT = 'api/nse-announcements';
const SNAPSHOT_PATH = 'data/nse-announcements.json';
const STORE_KEY = KEYS.nseFilings;

export const LIVE_ID = 'nse-filings';
export const POLL_MS = 90000;

let cache = null;
let loadPromise = null;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

// A stable id per row: NSE's document URL is the natural identity, and where a row has none (an
// exchange surveillance notice with an empty <link/>) the company + time + subject identify it.
// Never a position — the list grows as the feed rebuilds, and a positional key would make one id
// mean different rows across polls (the failure CLAUDE.md documents twice over).
const rowId = (r) => r.url || `${r.ticker || r.company}|${r.publishedAt || ''}|${r.subject || ''}`;

function sortRows(list) {
  return [...list].sort((a, b) => {
    const at = Date.parse(a.publishedAt || '');
    const bt = Date.parse(b.publishedAt || '');
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(bt) ? 1 : -1;
    return String(a.company || '').localeCompare(String(b.company || ''));
  });
}

function ingest(payload, { origin, checkedAt }) {
  const list = Array.isArray(payload?.rows) ? payload.rows : [];
  if (!list.length) return false;
  const byId = new Map();
  for (const r of list) byId.set(rowId(r), r);
  const rows = sortRows([...byId.values()]);
  const resolved = rows.filter((r) => r.ticker).length;
  cache = {
    rows,
    byId,
    meta: {
      count: rows.length,
      resolved,
      unresolved: rows.length - resolved,
      capturedAt: payload.capturedAt || payload.meta?.fetchedAt || null,
      checkedAt: checkedAt || Date.now(),
      origin,
      degraded: payload.degraded || null,
    },
  };
  return true;
}

async function build() {
  const stored = await readEntry(STORE_KEY);
  if (stored?.value?.rows?.length) ingest(stored.value, { origin: 'store', checkedAt: stored.savedAt });

  const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
  if (out.status === 200 && out.value?.rows?.length) ingest(out.value, { origin: 'live', checkedAt: out.checkedAt });
  else if (out.status === 304 && cache) cache.meta = { ...cache.meta, origin: 'live', checkedAt: out.checkedAt };

  // The committed snapshot last: a first visit with no Worker, or an unreachable route.
  if (!cache || out.status === 0) {
    const snap = await revalidatedJson(SNAPSHOT_PATH, { optional: !!cache });
    if (snap?.rows?.length && !cache) ingest(snap, { origin: 'snapshot', checkedAt: Date.now() });
  }
  if (!cache) throw new Error(`${SNAPSHOT_PATH} could not be loaded and no cached copy exists.`);
  return cache;
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

export function startLive(live) {
  live.register(LIVE_ID, {
    intervalMs: POLL_MS,
    fetcher: async () => {
      const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
      if (out.status === 200 && out.value?.rows?.length) {
        const before = cache?.byId ? new Set(cache.byId.keys()) : new Set();
        ingest(out.value, { origin: 'live', checkedAt: out.checkedAt });
        const added = [...cache.byId.keys()].filter((k) => !before.has(k)).length;
        if (added) emit();
      } else if (out.status === 304 && cache) {
        cache.meta = { ...cache.meta, origin: 'live', checkedAt: out.checkedAt };
      }
      return null;
    },
  });
  live.start(LIVE_ID);
}

export function stopLive(live) {
  live.stop(LIVE_ID);
}

export async function refresh() {
  const before = cache?.byId ? new Set(cache.byId.keys()) : new Set();
  const out = await conditionalJson(LIVE_ENDPOINT, { key: STORE_KEY, optional: true });
  if (out.status === 200 && out.value?.rows?.length) ingest(out.value, { origin: 'live', checkedAt: out.checkedAt });
  else if (out.status === 304 && cache) cache.meta = { ...cache.meta, origin: 'live', checkedAt: out.checkedAt };
  const added = cache ? [...cache.byId.keys()].filter((k) => !before.has(k)).length : 0;
  emit();
  return { added, total: cache?.rows.length || 0 };
}

export const all = () => (cache ? cache.rows : []);
export const rows = () => all();
export const meta = () => (cache ? cache.meta : { count: 0, resolved: 0, unresolved: 0, capturedAt: null, checkedAt: null, origin: null });
export const isLoaded = () => !!cache;
export const idsHeld = () => new Set(cache ? cache.byId.keys() : []);

/** Newest arrivals since a caller's remembered id set — for an alert feed, if wired later. */
export const rowKey = rowId;

export function forScope(scope, holdings = [], list = all()) {
  return filterByScope(list, scope, holdings);
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function invalidate() {
  cache = null;
  loadPromise = null;
}
