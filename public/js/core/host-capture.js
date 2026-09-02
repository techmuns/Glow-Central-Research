// core/host-capture.js — the two requests the HOST makes of this dashboard.
//
//   dashboard.capture.visual    -> a PNG Blob of the content region
//   dashboard.capture.snapshot  -> the dashboard's current state as bounded JSON
//
// THE ONE RULE THAT MATTERS: A HANDLER MAY NEVER THROW, AND MAY NEVER RETURN SOMETHING THE
// CHANNEL CANNOT CARRY. Both failures look identical from the host's side — no response, then a
// timeout — so neither is diagnosable from the artefact it leaves. Every path below therefore ends
// at a plain object, including the failures, which say what went wrong in a field the host can
// read. That is the same reasoning as the rest of this codebase: a named failure state beats an
// absence, because an absence is indistinguishable from a hang.
//
// The bound is 512KB, and it is measured with `JSON.stringify` — verified in the shipped bundle.
// Two consequences, and the second is the one that bites:
//   * a Blob stringifies to `{}`, so an image costs ~2 bytes against the cap and is returned
//     DIRECTLY. Base64 would be measured in full and a screenshot of a wide table blows the cap;
//   * the state snapshot is real JSON, so every field in it is charged at full size. It is
//     therefore built from counts and identifiers, never from row payloads — see `capState()`.
//
// WHAT THE VISUAL CAPTURE POINTS AT. `#dashboard-main` is the <main> the shell renders its tab
// into (js/ui/shell.js). That is the content region, not the whole page: the header's scope toggle
// and status pill are chrome the host already draws around us. The two documented fallbacks are
// kept because a capture is worth more than a missing selector is worth reporting.

import { sdk } from './sdk.js';
import { state } from './state.js';
import { getHostContext } from './host-context.js';
import { all as watchlistCompanies } from './watchlist.js';

// html-to-image, loaded from the CDN the first time a capture runs — the same arrangement as
// exceljs in js/ui/export.js, and for the same two reasons: nothing is added to the initial page
// load for a feature most sessions never use, and this repo carries no npm dependency or bundler
// for the front-end by contract (CLAUDE.md, hard rule 2). The published integration pattern says
// `npm install html-to-image`; a plain <script> that publishes `window.htmlToImage` is the same
// library reached the way this codebase already reaches one.
const HTML_TO_IMAGE_CDN = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';

let loaderPromise = null;

function loadHtmlToImage() {
  if (typeof window !== 'undefined' && window.htmlToImage) return Promise.resolve(window.htmlToImage);
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HTML_TO_IMAGE_CDN;
    script.async = true;
    script.onload = () => (window.htmlToImage ? resolve(window.htmlToImage) : reject(new Error('html-to-image loaded but window.htmlToImage is missing')));
    script.onerror = () => {
      // Cleared so a later capture can retry — a CDN blocked once is not blocked for ever, and a
      // cached rejected promise would make the first failure permanent for the life of the page.
      loaderPromise = null;
      reject(new Error('Could not load html-to-image from the CDN'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

/** The element the host wants a picture of. Documented order, and it must not throw. */
function captureRoot() {
  return (
    document.querySelector('#dashboard-main') ||
    document.querySelector("[data-dashboard-capture-root='true']") ||
    document.querySelector('main')
  );
}

// ---- The state snapshot ----------------------------------------------------------------------

// Contributors let a tab describe ITSELF without this module importing eleven tab modules and
// without any tab having to know the host exists. A tab registers on mount and drops the
// registration in destroy(); nothing is registered by default, and the snapshot is complete
// without any of them.
const contributors = new Map();

/**
 * Register a description of what is currently on screen.
 * `fn` returns a small plain object and must not throw; if it does, its section is dropped and the
 * rest of the snapshot still goes out.
 */
export function registerSnapshotSource(id, fn) {
  contributors.set(id, fn);
  return () => {
    if (contributors.get(id) === fn) contributors.delete(id);
  };
}

/** Bound a string so one long field cannot dominate the payload. */
const cut = (v, max = 120) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…` : v);

/**
 * The dashboard's current state, in the documented `{ context, selection, data }` shape.
 *
 * DELIBERATELY DESCRIPTIVE RATHER THAN COMPLETE. The reader may be looking at 1,700 scored rows;
 * the host asked what this dashboard is showing, not for the feed behind it. So this carries the
 * route, the scope and its denominator, and per-source COUNTS — never the rows. A snapshot that
 * tried to be the data would breach the payload cap on exactly the tabs worth capturing, and be
 * dropped in silence.
 */
function capState() {
  const host = getHostContext();
  const watched = safe(() => watchlistCompanies().map((c) => c.ticker).filter(Boolean), []);

  const context = {
    dashboard: 'sattva-central-research',
    route: cut(typeof location === 'undefined' ? null : location.hash || '#/', 200),
    workspace: state.workspace ?? null,
    tab: state.tab ?? null,
    subview: state.subview ?? null,
    // The scope is the single most important thing about any number on this dashboard: the same
    // table means three different things under Portfolio, Watchlist and Universe.
    scope: state.scope ?? null,
    hostTicker: host.ticker,
    hostTickerCompany: cut(host.tickerCompany),
    capturedAt: new Date().toISOString(),
  };

  const selection = {
    scope: state.scope ?? null,
    // Bounded: a watchlist is normally a handful of companies, but it is reader-controlled and
    // nothing stops it being long.
    watchlist: watched.slice(0, 200),
    watchlistCount: watched.length,
    hostTicker: host.ticker,
  };

  const data = { sources: {} };
  for (const [id, fn] of contributors) {
    const section = safe(fn, null);
    if (section && typeof section === 'object') data.sources[id] = section;
  }

  return { context, selection, data };
}

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---- Registration ----------------------------------------------------------------------------

let registered = false;
let disposers = [];

/**
 * Register both host request handlers. Called once from the app bootstrap.
 *
 * Idempotent, because registering twice would leave two handlers on one topic and the host would
 * be answered twice for one request. NOTHING HERE CALLS `sdk.ready()` — the SDK sends
 * `dashboard:ready` from inside its own `host:init` handler, and a manual one from a bootstrap
 * path is the documented way to break the handshake for good.
 */
export function startHostCapture() {
  if (registered) return () => {};
  registered = true;

  // 1) Visual snapshot — a PNG Blob of the content region.
  const offVisual = sdk.onRequest('dashboard.capture.visual', async () => {
    try {
      const el = captureRoot();
      if (!el) throw new Error('capture root not found');
      const { toBlob } = await loadHtmlToImage();
      const blob = await toBlob(el, { pixelRatio: 2 });
      if (!blob) throw new Error('empty snapshot blob');
      return { visualSnapshot: blob, capturedAt: new Date().toISOString() };
    } catch (err) {
      // Structured and cloneable, never a throw: the host gets a reason it can show, instead of a
      // fifteen-second wait that ends in nothing.
      return { ok: false, error: cut(String(err?.message || err), 200) };
    }
  });

  // 2) State snapshot — what this dashboard is currently showing.
  const offSnapshot = sdk.onRequest('dashboard.capture.snapshot', () => {
    try {
      return capState();
    } catch (err) {
      return { ok: false, error: cut(String(err?.message || err), 200) };
    }
  });

  disposers = [offVisual, offSnapshot];

  return () => {
    for (const off of disposers) {
      try {
        off();
      } catch {
        // A disposer that throws must not stop the others running.
      }
    }
    disposers = [];
    registered = false;
  };
}

// Exported for the verification suite, which asserts the snapshot's shape and its bound without a
// host to ask for one.
export { capState as snapshotState };
