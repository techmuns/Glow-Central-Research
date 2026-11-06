// core/watch-list-choice.js — WHICH LIST THE WATCHLIST SCOPE MEANS (GLOW-OWNED).
//
// The Watchlist scope is two lists, and the reader picks one from the menu on the scope toggle:
//
//   bookmarked   the companies the desk has starred — the shared watchlist (core/watchlist.js)
//   previous     the companies the family once held directly, through a PMS mandate or through
//                an AIF and now holds none of (js/data/coverage.js → previouslyOwned())
//
// The same arrangement as the header's Holding filter (core/holding-filter.js): this module only
// holds the choice, js/data/scope.js applies it, so every scoped tab — and every new one — narrows
// by whichever list is chosen without a line of its own. The scope id stays `watchlist`: every
// branch that treats Watchlist as "a narrowed list of companies the reader keeps" stays correct
// for both lists, and the membership sets (and so every cache keyed on them) differ by list.
//
// `bookmarked` is the default and changes nothing anywhere. The choice is a display preference
// kept on this device, like the theme and the Holding filter — never a capture, never the shared
// watchlist, never the book.

export const WATCH_LISTS = [
  ['bookmarked', 'Bookmarked'],
  ['previous', 'Previously owned'],
];
export const BOOKMARKED = 'bookmarked';
export const PREVIOUS = 'previous';

const KEY = 'glow:watch-list:v1';
const listeners = new Set();
export const normalizeWatchList = (value) => (WATCH_LISTS.some(([id]) => id === value) ? value : BOOKMARKED);
export const watchListLabel = (value) => WATCH_LISTS.find(([id]) => id === value)?.[1] || 'Bookmarked';

let current = BOOKMARKED;
try { current = normalizeWatchList(localStorage.getItem(KEY)); } catch { /* Session choice still works. */ }

export const watchList = () => current;
export const isPreviouslyOwned = () => current === PREVIOUS;

export function setWatchList(value) {
  const next = normalizeWatchList(value);
  if (next === current) return false;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* Keep the session choice. */ }
  for (const fn of [...listeners]) {
    try { fn(next); } catch (err) { console.error('[watch-list] listener threw', err); }
  }
  return true;
}

export function onWatchListChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
