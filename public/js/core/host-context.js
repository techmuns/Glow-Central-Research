// core/host-context.js — the reader's session and the host's selected ticker, as app state.
//
// This is the `useHostContext` pattern from the SDK integration standard, expressed for a repo
// with no React: read whatever the SDK has already cached, then RE-SYNC ON EVERY HOST MESSAGE.
// Those two halves are both load-bearing and neither is optional:
//
//   * the initial read, because `host:init` routinely lands before any of this app's UI exists —
//     the SDK client is created at import time precisely so it can catch it — and a consumer that
//     only listened forward would miss the one message that carried the token;
//   * the re-sync, because the token is refreshed on login and the ticker changes whenever the
//     reader picks a different company in the host. Both arrive later as `host:context:update`.
//
// WHAT THIS MODULE MAY NOT DO, taken straight from the standard:
//   * never call `sdk.ready()` — the SDK sends `dashboard:ready` itself, and a manual one races
//     the handshake and breaks it permanently;
//   * never `await sdk.requestContext()` — it returns a BOOLEAN, not the context, and awaiting it
//     is a TypeError that takes the page down;
//   * never parse envelopes by hand. `getContext()` is the contract; the envelope shape is not.
//
// A NULL TOKEN IS NOT AN ERROR. It is the normal state for the first few milliseconds inside the
// host, and the permanent state outside it — this dashboard is also served as a plain static site,
// which is how the verification suite drives it. Every consumer treats "no token" as "do not send
// an authenticated request", never as a failure to render. Nothing here blanks a page.

import { sdk } from './sdk.js';

const EMPTY_SESSION = Object.freeze({ token: null, userName: null, email: null, orgId: null, orgName: null });

const EMPTY_MARKET = Object.freeze({
  selectedTicker: null,
  selectedTickerCompany: null,
  selectedTickerCountry: null,
  selectedSymbol: null,
});

let session = EMPTY_SESSION;
let market = EMPTY_MARKET;
/** Set the first time any context at all arrives, so "not asked yet" and "host sent nothing" differ. */
let received = false;

const listeners = new Set();

/**
 * Subscribe to host-context changes. Returns an unsubscribe function.
 *
 * Fired only when a VALUE actually changed, not on every host message. The host re-sends the whole
 * context on any of its own state changes — a route change in the shell around us, say — and
 * repainting a 1,700-row table because the host navigated somewhere else would be a visible cost
 * for no information.
 */
export function onHostContext(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(changed) {
  for (const fn of listeners) {
    try {
      fn(getHostContext(), changed);
    } catch (err) {
      console.error('[host-context] subscriber threw', err);
    }
  }
}

/**
 * Read the SDK's cached context and adopt it. Called once at module load and then on every host
 * message. Cheap and idempotent by design — `getContext()` is synchronous and returns the latest
 * cached object, so this is a couple of comparisons on a message that usually changes nothing.
 */
function sync() {
  const ctx = sdk.getContext();
  if (!ctx) return;

  let changed = null;

  if (ctx.session) {
    const next = { ...EMPTY_SESSION, ...ctx.session };
    if (next.token !== session.token || next.email !== session.email || next.orgId !== session.orgId) {
      session = next;
      changed = changed || {};
      changed.session = true;
    } else {
      // Same identity, possibly a refreshed display name. Adopt it without waking subscribers.
      session = next;
    }
  }

  if (ctx.market) {
    const next = {
      selectedTicker: ctx.market.selectedTicker ?? null,
      selectedTickerCompany: ctx.market.selectedTickerCompany ?? null,
      selectedTickerCountry: ctx.market.selectedTickerCountry ?? null,
      selectedSymbol: ctx.market.selectedSymbol ?? null,
    };
    if (next.selectedTicker !== market.selectedTicker || next.selectedSymbol !== market.selectedSymbol) {
      market = next;
      changed = changed || {};
      changed.market = true;
    } else {
      market = next;
    }
  }

  if (!received && (ctx.session || ctx.market)) {
    received = true;
    changed = changed || {};
    changed.first = true;
  }

  if (changed) notify(changed);
}

// Apply anything the SDK already holds, THEN listen. `host:init` may well have arrived before this
// module was even imported — that is the whole reason the client is constructed at import time.
sync();
sdk.onMessage(sync);

/** The current host context. A plain snapshot — callers must not mutate it. */
export function getHostContext() {
  return {
    session,
    ticker: market.selectedTicker,
    tickerCompany: market.selectedTickerCompany,
    tickerCountry: market.selectedTickerCountry,
    selectedSymbol: market.selectedSymbol,
    /** True once the host has sent any context at all. */
    received,
  };
}

/** The reader's session JWT, or null. Null is normal — see the header. */
export function hostToken() {
  return session.token || null;
}

/** The company the host has selected, or null when it has selected none. */
export function hostTicker() {
  return market.selectedTicker || null;
}

// ---- Which requests may carry the token ------------------------------------------------------

// A SESSION JWT IS THE READER'S IDENTITY, SO WHERE IT IS SENT IS A SECURITY DECISION, NOT A
// CONVENIENCE ONE. This dashboard talks to three different kinds of address and only one of them
// may ever see the header:
//
//   * OUR OWN `api/…` routes on the Worker, which proxy the Munshot APIs — yes. Same origin, and
//     the Worker forwards the credential to the Munshot upstream it was issued for.
//   * `*.muns.io` directly — yes, for the same reason: that is the issuer.
//   * everything else — NO, and this is the part that has to be a predicate rather than a habit.
//     `data/*.json` are committed static files that need no credential and would only lose their
//     browser cache entry for one. The Concall Deep Dive dashboard and the chatter API are
//     SEPARATE deployments on other origins (see index.html): sending a reader's Munshot JWT to
//     either would hand a third party a live credential it has no business holding, and it would
//     travel on every poll. There is no "it is only a read" version of that.
//
// So the predicate is an allow-list, and the default is no header.

const MUNS_HOSTS = /(^|\.)muns\.io$/i;

/** True when `path` addresses a Munshot API this dashboard is entitled to authenticate against. */
export function isMunshotApi(path) {
  if (typeof path !== 'string' || !path) return false;
  let url;
  try {
    url = new URL(path, typeof location === 'undefined' ? 'https://localhost/' : location.href);
  } catch {
    return false;
  }
  if (MUNS_HOSTS.test(url.hostname)) return true;
  // Same-origin only: an absolute URL to somebody else's `/api/…` is somebody else's API.
  if (typeof location !== 'undefined' && url.origin !== location.origin) return false;
  return /(^|\/)api\//.test(url.pathname);
}

/**
 * The Authorization header for a request, or an empty object.
 *
 * Empty is the answer in three different situations and the caller does not need to tell them
 * apart: no host (static origin), a host that has not sent the token yet, and a target that is not
 * a Munshot API. Spreading `{}` into a headers literal is a no-op, so every call site reads the
 * same whether or not there is a session.
 *
 *   fetch(path, { headers: { accept: 'application/json', ...authHeaders(path) } })
 */
export function authHeaders(path) {
  const token = hostToken();
  if (!token) return {};
  if (!isMunshotApi(path)) return {};
  return { authorization: `Bearer ${token}` };
}
