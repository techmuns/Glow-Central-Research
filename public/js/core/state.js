// core/state.js — single global state object + localStorage persistence + a tiny pub/sub.
// Nothing here talks to the DOM; router.js and shell.js react to changes via subscribe().

const STORAGE_KEYS = {
  scope: 'sattva:scope',
  lastRoute: 'sattva:lastRoute',
};

export const DEFAULT_SCOPE = 'universe';

// The single source of truth for the app. Treat fields as read-only outside this module —
// always go through the setters below so persistence + subscribers stay in sync.
export const state = {
  workspace: null,
  tab: null,
  subview: null,
  scope: loadScope(),
  lastTick: null,
  data: null, // populated once by app.js after the initial fetch of public/data/*.json
  dataLoading: true,
  dataError: null,
  dataLoadedAt: null, // Date.now() when setData() ran — feeds the header "Updated" chip
};

const listeners = new Set();

// Subscribe to any state change. Returns an unsubscribe function.
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(reason) {
  for (const fn of listeners) {
    try {
      fn(reason, state);
    } catch (err) {
      console.error('[state] subscriber threw', err);
    }
  }
}

function loadScope() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.scope);
    return saved === 'portfolio' || saved === 'universe' ? saved : DEFAULT_SCOPE;
  } catch {
    return DEFAULT_SCOPE;
  }
}

export function setScope(scope) {
  if (scope !== 'portfolio' && scope !== 'universe') return;
  if (state.scope === scope) return;
  state.scope = scope;
  try {
    localStorage.setItem(STORAGE_KEYS.scope, scope);
  } catch {
    // localStorage unavailable (private mode, quota) — scope just won't persist across reloads.
  }
  notify('scope');
}

// Called by the router whenever the resolved route changes (including on first load).
export function setRoute({ workspace, tab, subview }) {
  state.workspace = workspace;
  state.tab = tab;
  state.subview = subview;
  notify('route');
}

export function saveLastRoute(hash) {
  try {
    localStorage.setItem(STORAGE_KEYS.lastRoute, hash);
  } catch {
    // ignore — not critical, just loses "resume where I left off" on reload.
  }
}

export function getLastRoute() {
  try {
    return localStorage.getItem(STORAGE_KEYS.lastRoute);
  } catch {
    return null;
  }
}

export function setData(data) {
  state.data = data;
  state.dataLoading = false;
  state.dataError = null;
  state.dataLoadedAt = Date.now();
  notify('data');
}

export function setDataError(err) {
  state.dataLoading = false;
  state.dataError = err;
  notify('data');
}

export function setLastTick(ts) {
  state.lastTick = ts;
  notify('tick');
}
