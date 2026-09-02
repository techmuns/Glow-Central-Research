// core/sdk.js — the Munshot Dashboard SDK client. ONE client, created at module load.
//
// This dashboard runs inside the Munshot host as an iframe and receives the reader's session
// token and selected ticker over a postMessage channel. This file is the adapter over the shipped
// bundle (`munshot-dashboard-sdk.v1.0.0`), and it is deliberately the only place that touches the
// global the script tag publishes.
//
// THE HANDSHAKE IS TIMING-SENSITIVE, AND EVERY WAY OF GETTING IT WRONG IS SILENT.
// The host posts `host:init` — carrying the channelId and the full context — when it renders the
// iframe. The SDK's window listener is attached in its CONSTRUCTOR, so the client has to exist
// before that message can arrive. That is why this module creates it at import time rather than
// from a mount hook: a client built after the first paint can miss the only message that ever
// carries the channelId, and a dashboard that missed it renders perfectly and never receives a
// token. Nothing throws. Read that sentence again before moving this line.
//
// TWO RULES FOLLOW, AND BOTH ARE "DO NOT":
//   1. `autoReady` is left at its default (true). The SDK sends `dashboard:ready` ITSELF from
//      inside its own `host:init` handler — i.e. at the exact moment it has learned the channelId.
//   2. Nothing here or anywhere else calls `sdk.ready()`. A manual ready fired from a mount effect
//      races ahead of `host:init`, goes out with a placeholder channel the host cannot correlate,
//      and the connection never completes — the reader sees "Waiting for session…" for ever.
//   Verified against the bundle: its handler reads `channelId = t.channelId … options.autoReady &&
//   this.ready()`, in that order, in one message.
//
// WHY A CLASSIC SCRIPT TAG AND NOT AN IMPORT (see index.html).
// The bundle is an IIFE assigned to `var MunshotDashboardSDK`. Loaded as a classic script the
// global ends up as the module namespace exposing `createDashboardClientSdk`; loaded as a module
// the same name instead exposes `{ createClient, Client }`. The probe below covers both spellings
// because the cost of being wrong is a silent fall through to the no-op — but the classic tag is
// the supported form and is what index.html uses.
//
// ON THE VANILLA PORT. The published integration pattern is written as `src/lib/sdk.ts` for a
// React/TypeScript app. This repo has no bundler, no framework, no npm dependency and no
// TypeScript by contract (see CLAUDE.md, hard rule 2), so the SAME client is expressed as an ES
// module with JSDoc types. The structure below — probe order, the no-op fallback's return types,
// the single module-scoped client — is a one-to-one port and should be kept that way.

export const DASHBOARD_ID = 'sattva-central-research';
export const DASHBOARD_NAME = 'Sattva Central Research';

/**
 * @typedef {Object} SessionContext
 * @property {string|null} token     JWT bearer token for Munshot APIs
 * @property {string|null} userName
 * @property {string|null} email
 * @property {string|null} orgId
 * @property {string|null} orgName
 */

/**
 * @typedef {Object} MarketContext
 * @property {string|null} selectedTicker         e.g. "RELIANCE"
 * @property {string|null} selectedTickerCompany  e.g. "Reliance Industries Ltd"
 * @property {string|null} selectedTickerCountry  e.g. "IN"
 * @property {string|null} selectedSymbol         TradingView format, e.g. "NSE:RELIANCE"
 */

/**
 * @typedef {Object} AppContext
 * @property {string|null} route
 * @property {string|null} query
 * @property {string|null} viewMode
 * @property {string|null} selectedCategory
 * @property {string|null} searchQuery
 */

/**
 * @typedef {Object} DashboardHostContext
 * @property {SessionContext} [session]
 * @property {MarketContext} [market]
 * @property {AppContext} [app]
 */

/** The shape every host message arrives in. Context is always at `payload.context`. */
/**
 * @typedef {Object} DashboardSdkEnvelope
 * @property {string} namespace
 * @property {string} version
 * @property {string} channelId
 * @property {'host'|'dashboard'} source
 * @property {string} kind        'host:init' | 'host:context:update' | 'host:event' | …
 * @property {number} timestamp
 * @property {string} [requestId]
 * @property {*} [payload]
 */

/**
 * A faithful no-op, used ONLY when the SDK script is absent — which is the normal case for
 * `python3 -m http.server -d public` and for every verification run. Return types match the real
 * client exactly, so app code takes the identical branches whether or not a host is present. It is
 * not an error state and must never be rendered as one: outside the host there is no session to
 * wait for, and the dashboard's committed snapshots are the whole of what it needs to paint.
 * @returns {DashboardClientSdk}
 */
function createNoopSdk() {
  return {
    getContext: () => null,
    getChannelId: () => null,
    onMessage: () => () => {},
    onTopic: () => () => {},
    onRequest: () => () => {},
    ready: () => false,
    requestContext: () => false,
    publish: () => false,
    request: async () => null,
    sendError: () => false,
    destroy: () => {},
  };
}

/**
 * @typedef {Object} DashboardClientSdk
 * @property {() => DashboardHostContext|null} getContext
 * @property {() => string|null} getChannelId
 * @property {(handler: (env: DashboardSdkEnvelope, meta: {origin: string}) => void) => (() => void)} onMessage
 * @property {(topic: string, handler: Function) => (() => void)} onTopic
 * @property {(topic: string, handler: Function) => (() => void)} onRequest
 * @property {() => boolean} ready
 * @property {() => boolean} requestContext
 * @property {(topic: string, data?: *, metadata?: *) => boolean} publish
 * @property {(topic: string, data?: *, options?: {timeoutMs?: number, metadata?: *}) => Promise<*>} request
 * @property {(message: string, code?: string, details?: *) => boolean} sendError
 * @property {() => void} destroy
 */

// Set by initSdk() when a REAL client was built. Kept as a flag rather than derived by comparing
// methods against a fresh no-op — every call to createNoopSdk() makes new closures, so such a
// comparison is always true and would report "connected to the host" on a static origin.
let attached = false;

function initSdk() {
  const g = typeof window === 'undefined' ? null : window.MunshotDashboardSDK;

  // Only the two identifiers. Every other option is left at the SDK's own default, and
  // `autoReady` most of all — see the header. `requestTimeoutMs` (15s), `maxPayloadBytes` (512KB),
  // `lockOriginOnFirstMessage` (true) and the target window are the bundle's, not ours.
  const config = { dashboardId: DASHBOARD_ID, dashboardName: DASHBOARD_NAME };

  const factory = g?.createDashboardClientSdk ?? g?.createClient;
  if (typeof factory === 'function') {
    try {
      const client = factory(config);
      attached = true;
      return client;
    } catch (err) {
      console.error('[sdk] Munshot SDK factory failed', err);
    }
  }

  const Ctor = g?.DashboardClientSdk ?? g?.Client;
  if (typeof Ctor === 'function') {
    try {
      const client = new Ctor(config);
      attached = true;
      return client;
    } catch (err) {
      console.error('[sdk] Munshot SDK constructor failed', err);
    }
  }

  // `console.info`, not `warn`: running this dashboard as a static site is a supported mode — it is
  // how the verification suite drives it — and the repo's bar is zero console errors. A warning
  // here would be noise on every local run and would train the reader to ignore the console.
  console.info('[sdk] MunshotDashboardSDK not found; using the no-op client. Expected outside the Munshot host iframe.');
  return createNoopSdk();
}

/**
 * THE client. Created at import time, exactly once, so its window listener is live before
 * `host:init` can arrive. Do not construct a second one anywhere — two clients means two channels
 * and dropped messages.
 * @type {DashboardClientSdk}
 */
export const sdk = initSdk();

/**
 * True when a REAL client was constructed — i.e. the SDK script loaded. It says nothing about
 * whether the host has answered yet: the handshake completes when `host:init` arrives, which is
 * `sdk.getChannelId() !== null`. Two different questions, and the UI needs both — "no SDK at all"
 * is the standalone case and is normal, "SDK but no channel yet" is a handshake still in flight.
 */
export function hasHostSdk() {
  return attached;
}

/** True once the host has completed the handshake and assigned this dashboard a channel. */
export function isHostConnected() {
  return attached && sdk.getChannelId() !== null;
}
