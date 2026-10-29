// core/holding-filter.js — THE HOLDING FILTER, one choice for the whole desk view (GLOW-OWNED).
//
// Glow's holding category (Direct Equity, PMS, …) sits beside the scope in the header and narrows
// every scoped tab, including the shared tabs readers build with Add tab. It was AI Alerts' own
// dropdown first; one control per tab would have been fifteen copies of the same question with
// fifteen chances to disagree, so it is now chrome, exactly as the scope is.
//
// `all` is the default and changes nothing anywhere: every consumer short-circuits on it. The
// choice is a display preference kept on this device, like the theme — not a route, so Back never
// lands on a view narrowed by a choice the reader has since undone. It never touches the book,
// the shared watchlist or any capture.
//
// This module only holds the choice. Which companies a category covers — and whether any company
// carries it at all, without which it reads as All — is answered from the current book in
// js/data/scope.js, so a book that arrives or changes is read afresh.
import { normalizeHoldingCategory } from '../data/holding-categories.js';

const KEY = 'glow:holding-category:v1';
const listeners = new Set();
let current = 'all';
try { current = normalizeHoldingCategory(localStorage.getItem(KEY)); } catch { /* Session choice still works. */ }

export const holdingCategory = () => current;

export function setHoldingCategory(value) {
  const next = normalizeHoldingCategory(value);
  if (next === current) return false;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* Keep the session choice. */ }
  for (const fn of [...listeners]) {
    try { fn(next); } catch (err) { console.error('[holding-filter] listener threw', err); }
  }
  return true;
}

export function onHoldingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
