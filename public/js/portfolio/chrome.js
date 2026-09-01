// portfolio/chrome.js — the shared furniture for the four Portfolio Analytics sub-views.
//
// All four load the same data module and all four must tell the same story about what is live
// and what is mock, so the provenance pill, the loading skeleton, the error panel and the money cells
// live here rather than being copy-pasted four times and drifting.
//
// THE PROVENANCE SPLIT ON THIS WORKSPACE IS UNUSUAL, AND IT USED TO TAKE A WHOLE RIBBON TO SAY SO
//   Every other mock surface in the dashboard is mock end to end, so an amber ribbon covers it.
//   Here the ledger is synthetic but the marks and the price history are real, and a flat "mock
//   data" ribbon would understate the numbers while a "live" badge would overstate them.
//
//   That used to be a four-line amber block at the top of all four sub-views — two pills, a
//   paragraph naming the generator script, the mark's age, the curve's window, and the list of
//   tickers the curve excludes. It was the first thing anyone saw on this workspace, above the
//   money, on every view, every time. Correct, and far too loud: a caveat that big reads as a
//   warning about the page rather than a note about one input to it.
//
//   So it became a passive label in the section head. Decluttering a page is fine, deleting its
//   accountability is not: the full explanation remains in exports and the canonical source
//   metadata. The label still says "illustrative ledger" on its face, in amber, on every
//   sub-view — and when the mark is missing it says THAT on its face instead, because a position
//   shown at cost reads as a position that has not moved.
//
//   The other four markers are untouched: the freshness card, the "at cost" row tag, the drill
//   note, and row 1 of every exported sheet. The export banner matters most — a workbook leaves
//   the page without its chrome, and it is the one artefact nobody can see a pill on.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatPct, formatRupee, formatRelativeTime, toneForValue } from '../core/format.js';
import { sectionHead, openModal } from '../ui/screener.js';

/**
 * The passive provenance label. Every sub-view renders this in its section head, beside the
 * scope summary. It reports status without opening an explainer dialog.
 */
export function provenancePill(meta) {
  if (!meta) return '';
  // Two faces, because the two states are not equally urgent. Normally the one thing the reader
  // must know is that the trades are invented; if the mark is missing, the one thing they must
  // know is that every P&L on screen is zero for want of a price, not for want of a move.
  const cls = meta.marksAreLive
    ? 'bg-amber-50 text-amber-800 ring-amber-300'
    : 'bg-rose-50 text-rose-800 ring-rose-300';
  const face = meta.marksAreLive
    ? 'Illustrative ledger · live marks'
    : 'Marks unavailable · shown at cost';
  return `
    <span data-pf-info title="Portfolio data status"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ${cls}">
      <span class="h-1.5 w-1.5 rounded-full ${meta.marksAreLive ? 'bg-amber-500' : 'bg-rose-500'}"></span>
      <span>${escapeHtml(face)}</span>
    </span>`;
}

/**
 * The chips under every sub-view's heading: the provenance pill, then the scope summary.
 *
 * This goes in `sectionHead`'s `controls` slot, NOT its `meta` slot, for the reason set out
 * beside `sectionHead` — `meta` shares a `justify-between` row with the title, so whether it
 * renders beside the heading or wraps under it depends on how long that sub-view's description
 * happens to be. Overview's is two lines and Allocation's is one, so the same two chips would sit
 * in two different places on two views of the same book. `controls` is a row of its own.
 */
export function headMeta(meta, scopeHtml = '') {
  return `${provenancePill(meta)}${scopeHtml}`;
}

export function wireProvenancePill(root, meta) {
  // Passive status only. The verbose provenance popup was intentionally removed.
}

function provenanceModalHtml(meta) {
  // The modal must not describe a curve that does not exist. Without the history file the
  // positions and P&L on this page are still perfectly good — only the curve is gone — and
  // saying so beats either claiming the curve is there or blanking a page that still works.
  const curveClause = meta.historyError
    ? `<strong>The equity curve is unavailable.</strong> <code class="rounded bg-slate-100 px-1">data/portfolio-history.json</code>
       could not be loaded (${escapeHtml(meta.historyError)}), so Drawdown shows nothing rather than an estimate.`
    : `<strong>The equity curve</strong> is built from ${meta.tradingDays ? `${escapeHtml(String(meta.tradingDays))} trading days of ` : ''}real
       closing prices${meta.historyFrom ? `, ${escapeHtml(formatDate(meta.historyFrom))} → ${escapeHtml(formatDate(meta.historyTo))}` : ''}.`;

  const excluded = meta.excluded?.length
    ? `<p class="mt-2 text-xs text-slate-500"><strong>Excluded from the equity curve:</strong>
         ${meta.excluded.map((e) => `${escapeHtml(e.ticker)} (${escapeHtml(e.reason)}${e.qty ? `, ${e.qty} shares held` : ''})`).join(' · ')}
         — carried at running cost rather than dropped, so the curve does not silently shrink the book.</p>`
    : '';

  return `
    <div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">What is real on this page, and what is not</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p class="rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">
          <strong>Which trades were made, and when, is synthetic</strong> — generated by
          <code class="rounded bg-amber-100 px-1">scripts/gen-mock-transactions.mjs</code>. Quantities, dates and the
          sequence of buys and sells are invented. Nothing here is a record of a real transaction.
        </p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Every price in it is real</h3>
        <p class="mt-1 text-xs">Execution prices are actual Yahoo closes on actual trading days, so a cost basis is what those
          shares would genuinely have cost on that date.
          ${
            meta.marksAreLive
              ? `Positions are marked to market from the live technicals feed${meta.pricedAt ? `, read ${escapeHtml(formatRelativeTime(meta.pricedAt))}` : ''}.`
              : '<strong class="text-rose-700">The live mark is unavailable right now, so positions are shown at cost</strong> — every unrealised P&L on screen is zero because no price could be read, not because nothing moved. Each affected row carries an "at cost" tag.'
          }
        </p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The drawdown, and why it is the number to watch</h3>
        <p class="mt-1 text-xs">${curveClause}
          A drawdown computed from an invented price series is the one figure on this workspace nobody could check, which is
          exactly why the series behind it is real.</p>
        ${excluded}

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Where this shows up again</h3>
        <p class="mt-1 text-xs text-slate-500">Row 1 of every workbook exported from this workspace repeats all of the above. A
          spreadsheet leaves the page without its chrome, and a number that travels has to carry its provenance with it.</p>
      </div>
    </div>`;
}

/** The `?` explainer shared by the P&L stat card on three of the four sub-views. */
export const PNL_HELP = {
  title: 'How P&L is calculated, and what is real in it',
  body: `<p><strong>Unrealised</strong> = <code class="rounded bg-slate-100 px-1">(live price − FIFO average cost) × quantity</code>.
         The live price is <code class="rounded bg-slate-100 px-1">cmp</code> from the technicals feed, scraped weekday mornings.</p>
       <p class="mt-2"><strong>Realised</strong> comes from FIFO lot matching: each sell consumes the oldest open lots first, and the
         resulting gain carries its own buy date, holding period and short/long term classification.</p>
       <p class="mt-2"><strong>Charges are folded into the cost basis</strong> — STT, exchange, GST, SEBI, stamp and DP — so the average
         price you see is what the shares actually cost, not the screen price at the time.</p>
       <p class="mt-2"><strong>Dividends are tracked separately</strong> and never folded into the basis, because doing so would
         disguise income as a lower purchase price.</p>
       <p class="mt-3 text-slate-500">Two identities are asserted numerically in <code class="rounded bg-slate-100 px-1">scripts/verify-ui.mjs</code>:
         the open lots sum to the position quantity, and realised + unrealised + dividends equals total P&L.</p>`,
};

export const RETURN_HELP = {
  title: 'XIRR vs time-weighted return',
  body: `<p>They answer different questions and neither substitutes for the other.</p>
       <p class="mt-2"><strong>XIRR</strong> is money-weighted: the annual rate that discounts every cashflow — buys out, sells and
         dividends in, today's market value as the terminal inflow — back to zero. It measures what <em>this investor</em> earned,
         timing of contributions included.</p>
       <p class="mt-2"><strong>TWR</strong> is time-weighted: daily returns chained together with the day's contributions removed first.
         It measures what the <em>strategy</em> returned, and it is the only one of the two that may be compared to an index.</p>
       <p class="mt-3 text-slate-500">Most of the equity curve's rise is money paid in, not return earned — which is exactly what
         TWR exists to strip out.</p>`,
};

/**
 * Standard async wrapper. Bumps a render token so a slow load resolving after the user has
 * navigated away is discarded rather than painting over whatever is on screen now.
 */
export function createLoader(tabTitle, tabSubtitle) {
  let token = 0;
  return function run(ctx, paint, portfolioModule) {
    const mine = ++token;
    ctx.root.innerHTML = loadingHtml(tabTitle, tabSubtitle);
    portfolioModule
      .load()
      .then(() => {
        if (mine !== token) return;
        paint(ctx);
      })
      .catch((err) => {
        if (mine !== token) return;
        console.error(`[${tabTitle}] portfolio load failed`, err);
        ctx.root.innerHTML = errorHtml(tabTitle, err);
      });
  };
}

export function loadingHtml(title, subtitle) {
  return `
    ${sectionHead({ title, description: subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

export function errorHtml(title, err) {
  return `
    ${sectionHead({ title, description: 'The portfolio data could not be assembled.' })}
    <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
      <div class="text-3xl">⚠️</div>
      <div class="mt-2 text-sm font-semibold text-slate-700">Could not build the portfolio</div>
      <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err?.message || err))}</div>
      <p class="mx-auto mt-3 max-w-md text-xs text-slate-400">
        The ledger and the holdings config load at startup; the mark and the price history load when this
        workspace mounts. Navigating away and back retries.
      </p>
    </div>`;
}

// ---- cells -------------------------------------------------------------------------------

export function moneyCell(value, { decimals = 0 } = {}) {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${escapeHtml(formatRupee(value, { decimals }))}</span>`;
}

export function pctCell(value) {
  if (value == null) return '<span class="text-slate-400">—</span>';
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${escapeHtml(formatPct(value))}</span>`;
}

export function convictionPill(tier) {
  const cls =
    tier === 'Core'
      ? 'bg-indigo-50 text-indigo-700 ring-indigo-200'
      : tier === 'High Conviction'
        ? 'bg-purple-50 text-purple-700 ring-purple-200'
        : tier === 'Exited'
          ? 'bg-slate-100 text-slate-500 ring-slate-200'
          : 'bg-sky-50 text-sky-700 ring-sky-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${escapeHtml(tier)}</span>`;
}

/**
 * The marker for a position with no live price. It is deliberately loud: a row marked at cost
 * shows a P&L of exactly zero, and a zero that means "we don't know" must not look like a zero
 * that means "flat".
 */
export function unpricedTag() {
  return `<span class="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-300" title="No live price in the technicals feed — marked at cost, and excluded from the equity curve">at cost</span>`;
}

export function termPill(term) {
  const cls = term === 'long' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-amber-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${term === 'long' ? 'Long' : 'Short'}</span>`;
}

/** The gradient hero card, identical across the four sub-views. */
export function freshnessCard(meta) {
  return {
    hero: true,
    label: 'Marked at',
    value: meta?.pricedAt ? formatDate(meta.pricedAt) : meta?.asOf ? formatDate(meta.asOf) : '—',
    note: meta?.marksAreLive ? `Live technicals · ledger to ${meta.asOf ? formatDate(meta.asOf) : '—'}` : 'No live mark · positions at cost',
  };
}

/** The banner row every exported sheet from this workspace carries as row 1. */
export function exportBanner(meta) {
  return (
    'ILLUSTRATIVE LEDGER, REAL PRICES. Which trades were made and when is synthetic ' +
    '(scripts/gen-mock-transactions.mjs). Execution prices are real Yahoo closes on real trading days; ' +
    `positions are marked to market from the live technicals feed${meta?.pricedAt ? ` (${meta.pricedAt})` : ''}; ` +
    `the equity curve uses ${meta?.tradingDays || 0} trading days of real closes` +
    `${meta?.excluded?.length ? `. Excluded from the curve: ${meta.excluded.map((e) => `${e.ticker} (${e.reason})`).join('; ')}` : '.'}`
  );
}
