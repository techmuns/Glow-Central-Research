// core/router.js — hash-based routing: #/<workspace>/<tab>/<subview>?scope=universe
// Pure URL <-> route-object plumbing. It does NOT know about the tab registry — shell.js
// resolves a raw parsed route against the registry and calls replaceRoute() to normalize it.

import { getLastRoute } from './state.js';

export const DEFAULT_ROUTE = { workspace: 'research', tab: 'earnings-hub', subview: 'latest-results' };

// "#/research/breakouts/strong-breakouts?scope=portfolio&vol=1.5"
//   -> { workspace, tab, subview, scope, params }
// Any missing/malformed piece comes back as null so the caller can decide how to fall back.
// `params` carries every query key EXCEPT scope, so a tab can put its filter state in the URL
// (making a filtered view shareable) without the router knowing what those filters mean.
export function parseHash(raw = location.hash) {
  let hash = raw || '';
  if (hash.startsWith('#')) hash = hash.slice(1);
  const [pathPart, queryPart] = hash.split('?');
  const segments = (pathPart || '').split('/').filter(Boolean);
  const [workspace = null, tab = null, subview = null] = segments;
  const search = new URLSearchParams(queryPart || '');
  const rawScope = search.get('scope');
  const scope = rawScope === 'portfolio' || rawScope === 'universe' ? rawScope : null;
  const params = {};
  for (const [k, v] of search.entries()) if (k !== 'scope') params[k] = v;
  return { workspace, tab, subview, scope, params };
}

export function buildHash({ workspace, tab, subview, scope, params = {} }) {
  const search = new URLSearchParams();
  if (scope) search.set('scope', scope);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    search.set(k, v);
  }
  const query = search.toString();
  // A tab with `subviews: []` has no sub-view, and interpolating one anyway wrote the literal
  // string "null" into the path (`#/research/earnings-hub/null?...`). parseHash then read "null"
  // back as a sub-view id, so a shared link carried a sub-view that does not exist.
  const path = [workspace, tab, subview].filter(Boolean).join('/');
  return `#/${path}${query ? `?${query}` : ''}`;
}

// Push a new history entry (normal in-app navigation — clicking a tab, rail item, search result…).
export function navigate(route, { replace = false } = {}) {
  const hash = buildHash(route);
  if (replace) {
    replaceRoute(route);
    return;
  }
  if (`#${location.hash.slice(1)}` === hash) return; // no-op if nothing actually changes
  location.hash = hash.slice(1);
}

// Rewrite the current URL in place (no new history entry) — used to normalize unknown/partial
// routes and to keep the scope query param present at all times.
export function replaceRoute(route) {
  const hash = buildHash(route);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

// Resolve what to show on first paint: an explicit shareable hash wins, otherwise fall back to
// the last route saved in localStorage, otherwise the hard default.
function initialRoute() {
  if (location.hash && location.hash !== '#') return parseHash();
  const saved = getLastRoute();
  if (saved) return parseHash(saved);
  return { workspace: null, tab: null, subview: null, scope: null };
}

// Subscribe to route changes (hashchange covers back/forward + manual location.hash writes).
// `onRoute(route)` fires once immediately with the resolved initial route, then on every change.
export function start(onRoute) {
  window.addEventListener('hashchange', () => onRoute(parseHash()));
  onRoute(initialRoute());
}
