// nav-visibility.js — which top-nav sections the desk sees by default.
//
// The desk asked (20 Nov) to open on just three sections — Alerts, Portfolio, Watchlist — with
// everything else tucked behind a "More" picker it can switch on. This is PRESENTATION ONLY and
// DEVICE-LOCAL (same shape as core/holding-filter.js): it changes nothing about routes, data, the
// shared tab order or the shared custom tabs. A section that is not shown stays fully routable by
// hash and from saved links, and the active section is always shown by the shell, so a deep link
// never lands on a tab the reader cannot see.
//
// Stored as the set of OPTIONAL section ids the reader has turned on (not the hidden set), so a
// section added to the product later appears off by default rather than being silently hidden by a
// stale saved list.

const KEY = 'glow:nav-shown:v1';

// Always shown, in this order. Everything else is optional and off until added from "More".
export const CORE_NAV = ['alerts', 'portfolio', 'watchlist'];

const listeners = new Set();
let shown = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (Array.isArray(raw)) return new Set(raw.filter((id) => typeof id === 'string').slice(0, 50));
  } catch { /* storage disabled or damaged — navigation must still work, so default to none */ }
  return new Set();
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify([...shown])); } catch { /* best effort; the choice still holds for this visit */ } }
function emit() { for (const fn of listeners) { try { fn(); } catch (err) { console.error('[nav-visibility] listener failed', err); } } }

export const isCoreNav = (id) => CORE_NAV.includes(id);
export const isNavShown = (id) => CORE_NAV.includes(id) || shown.has(id);
export const shownOptional = () => new Set(shown);

export function setNavShown(id, on) {
  if (CORE_NAV.includes(id)) return;            // core sections cannot be hidden
  const before = shown.has(id);
  if (on) shown.add(id); else shown.delete(id);
  if (before !== shown.has(id)) { persist(); emit(); }
}

// Turn every optional section on (the shell passes the ids it is rendering). "Reset" returns to the
// three-section default. Both are explicit reader actions from the More picker.
export function showAllNav(optionalIds) { shown = new Set(optionalIds.filter((id) => !CORE_NAV.includes(id))); persist(); emit(); }
export function resetNav() { if (shown.size) { shown = new Set(); persist(); emit(); } }

export const onNavVisibilityChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
