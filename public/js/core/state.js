// core/state.js — single global state object + localStorage persistence + a tiny pub/sub.
// Nothing here talks to the DOM; router.js and shell.js react to changes via subscribe().

import { isScope } from '../data/scope.js';

const STORAGE_KEYS = {
  lastRoute: 'sattva:lastRoute',
};

// THE SCOPE VOCABULARY LIVES IN js/data/scope.js — this module only validates it, and importing the
// list keeps the two from drifting the way two hard-coded string pairs would.
//
// PORTFOLIO IS THE DEFAULT. The first question on opening a dashboard about your own money is what
// your own money did; "every listed company" is the widest possible answer to that and was only
// ever the default because it was the scope that needed no data to be loaded first.
export const DEFAULT_SCOPE = 'portfolio';

// AND IT IS THE DEFAULT ON EVERY OPEN, NOT ONLY THE FIRST ONE.
//
// The scope used to persist in `sattva:scope`, and the saved route in `sattva:lastRoute` carries a
// `?scope=` of its own — so one afternoon spent in Universe made Universe the scope the dashboard
// opened in for ever after, and the "Portfolio is the default" rule above only ever described a
// reader who had never touched the toggle. A default that any single click permanently overrides is
// not a default; it is an initial value.
//
// So the scope is now SESSION state. It still lives in `state.scope`, the toggle still changes it,
// and every navigation still writes it into the hash — which is what keeps two things working that
// matter more than remembering:
//
//   • A SHARED LINK STILL WINS. `?scope=universe` in the URL is an explicit instruction from
//     whoever sent it, and `initialRoute()` reads the hash before it reads anything saved.
//   • A RELOAD STILL HOLDS ITS SCOPE, because the shell keeps `?scope=` in the address bar at all
//     times, so reloading is a URL with a scope on it rather than a fresh open.
//
// What changes is only the case the reader means by "opening the dashboard": arriving with no
// scope named. That lands on Portfolio, whatever last week did. `getLastRoute()` strips the scope
// off the saved route for the same reason — the tab you were on is worth resuming, the scope you
// were in is the thing this rule is about.

// The single source of truth for the app. Treat fields as read-only outside this module —
// always go through the setters below so persistence + subscribers stay in sync.
export const state = {
  workspace: null,
  tab: null,
  subview: null,
  // Session state, not a saved preference. Every open starts here; see DEFAULT_SCOPE above.
  scope: DEFAULT_SCOPE,
  lastTick: null,
  data: null, // populated by app.js: the critical file first, the deferred ones mutated in later
  deferredData: null, // Promise for the bootstrap files the shell does not block on
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

export function setScope(scope) {
  if (!isScope(scope)) return;
  if (state.scope === scope) return;
  state.scope = scope;
  // Deliberately NOT written to localStorage — see DEFAULT_SCOPE above. The scope lives in the URL,
  // which is where a shared link reads it from and where a reload finds it again.
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

/**
 * The route this reader was last on, WITHOUT its scope.
 *
 * The saved hash carries `?scope=` because the shell keeps it in the address bar at all times, so
 * returning it whole would restore last week's scope and reinstate exactly what DEFAULT_SCOPE is
 * there to prevent. Stripping it hands the router a workspace/tab/sub-view and no scope, which
 * `handleRoute` then fills from `state.scope` — Portfolio, on a fresh open.
 *
 * A scope in the ADDRESS BAR is untouched by this: `initialRoute()` reads `location.hash` first and
 * only falls back here when the reader named no route at all.
 */
export function getLastRoute() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.lastRoute);
    if (!saved) return null;
    const [path, query = ''] = saved.split('?');
    const params = new URLSearchParams(query);
    params.delete('scope');
    const rest = params.toString();
    return rest ? `${path}?${rest}` : path;
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

/**
 * The promise for the bootstrap files the shell does NOT wait for.
 *
 * Two tabs read `ctx.data` directly — Breakouts → Earnings Surprise and Super Investors →
 * Institutions — and their inputs are in that deferred set. Handing them the same promise is what
 * keeps them from either racing it (rendering an empty view a beat before the data lands) or
 * firing a second fetch for a file already on the wire. It resolves rather than rejects: a
 * consumer checks what arrived, because "the corpus failed to load" is a thing to say on the panel
 * that needed it, not a reason to take down the app.
 */
export function setDeferredData(promise) {
  state.deferredData = promise;
  promise.then(() => notify('data'));
}

/** Await the deferred bootstrap files. Resolves immediately once they have landed. */
export function whenDeferredData() {
  return state.deferredData || Promise.resolve(state.data);
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
