// tabs/super-investors.js — who owns what, from two live sources and nothing else.
//
//   Superstar Investors  every tracked investor's book, live off Ticker Finology  → investors/live.js
//   Institutions         every tracked scheme's returns and peer rank, off AmfiBeas → investors/fund-returns.js
//
// THIS MODULE IS A DISPATCHER AND ALMOST NOTHING ELSE. Both sub-views own their own rendering,
// provenance and export; all that is left here is the tab contract, the two lifetimes, and the
// loading state.
//
// THE INSTITUTIONS SUB-VIEW WAS REBUILT. It used to be filed shareholdings (Trendlyne) and AMC
// portfolios (`js/investors/filed.js` over `institution-holdings.json`); it now renders the AmfiBeas
// "Returns & Ranking" table — every tracked mutual fund and ETF, its point-to-point return for each
// period and its rank within its own cohort. The URL id stays `institutions` so saved links keep
// working; the old view's modules are left on disk, dormant, rather than deleted in the same change.
//
// THE SYNTHETIC HALF IS GONE, AND ITS MACHINERY WITH IT. There used to be a third sub-view, Fund
// Flows, running on `superinvestors.json` / `institutions.json` — real names against generated
// positions, held together by an amber ribbon, plus a four-tab per-investor workspace on the same
// invented data. Both live sub-views are now real, so the tab had one synthetic surface and two
// genuine ones sharing a rail.
//
// That is the situation CLAUDE.md already has an answer for, learned on the Con-call tab: when a
// tab acquires two provenances, the preferred resolution is to remove the synthetic one, not to
// write a better ribbon. So the sub-view, `js/data/investors.js`, `js/investors/deep-dive.js`,
// `scripts/gen-mock-investors.mjs` and the two mock payloads are deleted rather than deprecated.
// Every number on this tab is now somebody's disclosure. If aggregate flow data is ever wanted,
// AMFI publish the real monthly figures and it comes back pointed at those.

import { sectionHead } from '../ui/screener.js';
import { renderFundReturns } from '../investors/fund-returns.js';
import { renderLive } from '../investors/live.js';
import * as liveInvestors from '../data/super-investors.js';
import * as fundReturns from '../data/fund-returns.js';

export const meta = {
  id: 'super-investors',
  title: 'Super Investors',
  subtitle: 'Superstar-investor holdings and every tracked scheme’s returns and peer rank.',
  subviews: [
    { id: 'superstar-investors', label: 'Superstar Investors' },
    // The URL id stays `institutions` for saved-link stability; the label is what the reader sees.
    { id: 'institutions', label: 'Fund Returns' },
  ],
};

let renderToken = 0;
let ctxRef = null;
// Disposers from the tables' global listeners. `scoreTable.wire()` returns one when it registers
// anything on the document, and it has to be released on nav away or every visit stacks another.
let disposers = [];
// The live Superstar view's own lifetime: a subscription that survives repaints (books arrive one
// at a time) and the table's search/sort/filter state, carried across those repaints so a book
// landing mid-read does not throw away what the reader had set up.
let liveUnsub = null;
let liveView = null;

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  renderToken++;
  ctxRef = ctx;
  const view = { institutions: renderInstitutions }[ctx.subview] || renderIndividuals;
  view(ctx);
}

export function destroy() {
  renderToken++;
  ctxRef = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  // The book-arrival subscription outlives a repaint by design, so leaving the tab is the only
  // place it can be released. Without this, every visit stacks another repainter on a dead ctx.
  liveUnsub?.();
  liveUnsub = null;
  // Leaving is a deliberate exit; coming back should be a clean table rather than last visit's
  // half-applied filter. Only a repaint mid-load carries the view forward.
  liveView = null;
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 3 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

// ---------------------------------------------------------------------------------------
// Superstar Investors — live off Ticker Finology
// ---------------------------------------------------------------------------------------

/**
 * The books arrive one at a time — each is a separate page on Finology's side — so this subscribes
 * and repaints as they land rather than blocking the whole view on the slowest one.
 *
 * A SECOND VISIT PAINTS IMMEDIATELY. `isLoaded()` is true for the rest of the session once the list
 * has landed, and the feed's own cache means even a fresh page load paints from the device before
 * it asks the network anything. See js/data/super-investors.js.
 */
function renderIndividuals(ctx) {
  disposers.forEach((d) => d && d());
  disposers = [];

  if (!liveInvestors.isLoaded()) {
    ctx.root.innerHTML = loadingHtml();
    const token = renderToken;
    liveInvestors.load().then(() => {
      if (token === renderToken) renderIndividuals(ctx);
    });
    return;
  }

  renderLive(ctx, { disposers, tableView: liveView, onView: (v) => (liveView = v) });

  // Repaint as each book lands. The subscription is a mount-lifetime thing, so it is released in
  // destroy() and not by the next repaint — otherwise the first arrival would tear down the
  // subscription that produced it.
  if (!liveUnsub) {
    const token = renderToken;
    liveUnsub = liveInvestors.onChange(() => {
      if (token !== renderToken || ctxRef?.subview !== 'superstar-investors') return;
      // A re-read from the Live pill discards the whole feed and starts again, so for a moment
      // there is no list. Rendering the panel then would put "the API returned an error" on screen
      // for something the reader just asked for and which has not failed. The skeleton is the
      // honest state: this is loading.
      if (!liveInvestors.isLoaded()) {
        ctxRef.root.innerHTML = loadingHtml();
        return;
      }
      renderLive(ctxRef, { disposers, tableView: liveView, onView: (v) => (liveView = v) });
    });
  }
}

// ---------------------------------------------------------------------------------------
// Institutions — every tracked scheme's returns and peer rank, off AmfiBeas
// ---------------------------------------------------------------------------------------

/**
 * One table: every tracked mutual fund and ETF, its point-to-point return per period and its rank
 * within its own cohort. The whole view is `js/investors/fund-returns.js`; this only owns the load
 * gate and the repaint used by that view's "Try again" control.
 *
 * `fundReturns.load()` NEVER REJECTS — every failure is a named state carried on `meta().reason` —
 * so the panel renders either the table or a named failure (with a retry), and `paint` is safe to
 * call again from the retry button.
 */
function renderInstitutions(ctx) {
  disposers.forEach((d) => d && d());
  disposers = [];
  const token = renderToken;

  const paint = () => {
    if (token !== renderToken || ctxRef?.subview !== 'institutions') return;
    // A repaint (the failure view's retry) must release the previous paint's listeners first, or
    // each retry stacks another on the document.
    disposers.forEach((d) => d && d());
    disposers = [];
    const panel = renderFundReturns(ctx, { disposers, repaint: paint });
    ctx.root.innerHTML = panel.html;
    panel.wire(ctx.root);
  };

  // On any visit but a cold one the feed is already loaded and the shimmer never renders. It is
  // awaited rather than raced: an unprimed `all()` is empty, and an empty table on screen would
  // read as "no schemes" — exactly the failure the named panel is written to avoid.
  if (fundReturns.isLoaded()) {
    paint();
    return;
  }
  ctx.root.innerHTML = loadingHtml();
  fundReturns.load().then(() => {
    if (token === renderToken) paint();
  });
}
