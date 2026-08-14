// tabs/super-investors.js — who owns what, from two live sources and nothing else.
//
//   Superstar Investors  every tracked investor's book, live off Ticker Finology  → investors/live.js
//   Institutions         funds, from shareholding filings and AMC portfolios      → investors/filed.js
//
// THIS MODULE IS A DISPATCHER AND ALMOST NOTHING ELSE. Both sub-views own their own rendering,
// provenance and export; all that is left here is the tab contract, the two lifetimes, and the
// loading state.
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
import { renderFiled } from '../investors/filed.js';
import { renderLive } from '../investors/live.js';
import * as liveInvestors from '../data/super-investors.js';
import * as filed from '../data/institution-holdings.js';

export const meta = {
  id: 'super-investors',
  title: 'Super Investors',
  subtitle: 'Superstar-investor and institutional holdings, quarter on quarter and month on month.',
  subviews: [
    { id: 'superstar-investors', label: 'Superstar Investors' },
    { id: 'institutions', label: 'Institutions' },
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
// Institutions — filed shareholdings and AMC portfolios
// ---------------------------------------------------------------------------------------

/**
 * One table per fund, with a picker across the top.
 *
 * Two kinds of fund sit behind that picker and they measure different things — see the header of
 * js/investors/filed.js. This function does not know or care which; `renderFiled` branches.
 */
function renderInstitutions(ctx) {
  disposers.forEach((d) => d && d());
  disposers = [];

  const panel = renderFiled(ctx, { disposers });
  if (!panel.html) {
    // No holdings file on disk. Say so rather than rendering an empty table, which would read as a
    // fund that holds nothing.
    ctx.root.innerHTML = `
      ${sectionHead({ title: 'Institutions', description: 'Fund holdings, from shareholding filings and AMC portfolio disclosures.' })}
      <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-base font-bold text-slate-900">No holdings file loaded</h3>
        <p class="mt-1.5 text-sm leading-relaxed text-slate-600">
          <code class="rounded bg-slate-100 px-1">public/data/institution-holdings.json</code> did not load at bootstrap.
          It is written by <code class="rounded bg-slate-100 px-1">scripts/scrape-institution-holdings.mjs</code> and
          <code class="rounded bg-slate-100 px-1">scripts/import-amc-portfolio.mjs</code>.
        </p>
        <p class="mt-3 text-xs text-slate-500">
          <strong>Nothing is shown.</strong> Not an empty book — there is simply no file to read.
        </p>
      </div>`;
    return;
  }

  ctx.root.innerHTML = panel.html;
  panel.wire(ctx.root);
}

/** Exposed for the verification suite, which asserts the two kinds never merge. */
export const _funds = () => filed.all();
