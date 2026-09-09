// investors/fund-returns.js — the All Schemes view, on the AmfiBeas "Returns & Ranking" feed.
//
//   renderFundReturns(ctx, { disposers, repaint })   the scheme table, its pill and its export
//
// One table: every tracked mutual fund and ETF, its point-to-point return for each period, the
// benchmark that return is measured against, and its rank within its own cohort.
//
// EVERY RETURN CARRIES ITS BENCHMARK ON THE FACE OF THE CELL — the scheme's own return above, its
// category's published median beneath it, shaded by the gap between them. A return with nothing
// beside it is a figure the reader cannot act on, and the reference is not behind a toggle for the
// same reason it is not on Category Performance: the whole question is whether this fund beat what
// it should be compared with, and an answer showing one side of it makes the reader hold the other
// in their head.
//
// THE BENCHMARK IS THE CATEGORY, NOT AN INDEX, AND THE HEADING SAYS SO. AMFI's daily NAV snapshot
// carries no index level, so AmfiBeas publish `categoryAverage` / `categoryMedian` for each cohort
// and no index return — and none is borrowed from the weekly workbook on the other sub-view, which
// is a different date. See js/data/fund-returns.js and js/data/mf-weekly.js.
//
// THE RETURNS, THE RANKS AND THE CATEGORY FIGURES ARE ALL THEIRS — reproduced, never recomputed.
// `returns[p].return` is a percentage already (3.4852 → +3.5%): a simple return for 1M/3M/6M/1Y, a
// CAGR for 3Y/5Y/10Y. `rank`/`peerCount` is the scheme's rank WITHIN ITS COHORT, rendered "38/149",
// and `excessVsMedian` is their subtraction rather than one done here. This is the same rule the
// con-call and chatter feeds follow: no re-banding, no re-ranking, no recomputation. The one thing
// this view decides is which period columns to show — a period null for every row is hidden — and
// that is a display choice, not a new number.
//
// A NULL IS NOT A ZERO. A null `return` is "no return for that period" and renders an em dash; a
// null `rank` is "the cohort was too small to rank" and may sit beside a real return. Neither is
// ever coloured or counted as though it were measured.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { gapHeat } from '../ui/mf-heatmap.js';
import { factorLabel } from '../data/mf-taxonomy.js';
import * as fundReturns from '../data/fund-returns.js';
import { fundSearch } from '../ui/fund-search.js';

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

/**
 * Build the panel from the ALREADY-LOADED feed. The dispatcher awaits `fundReturns.load()` and shows
 * a skeleton first, exactly as it did for the filed view, so `all()` / `meta()` are primed here.
 *
 * Returns `{ html, wire(root) }`. On a named failure it returns the failure panel and a wire that
 * arms the "Try again" button, so a mis-configured or briefly-down upstream is recoverable without
 * leaving the tab.
 */
export function renderFundReturns(ctx, {
  disposers = [], repaint = null, rows = null, headHtml = '', view = null, onView = null,
  measure = 'return', extraProvenance = '',
} = {}) {
  const m = fundReturns.meta();
  // `rows` lets the OWNING TAB narrow the set — the Mutual Funds tab's asset-class / group chips
  // sit above this panel and hand down what they selected. Null means the whole feed, which is what
  // every other caller wants. The narrowed set is what the table, the count and the export all read,
  // so no number on screen can describe a wider set than the rows beneath it.
  const funds = rows || fundReturns.all();

  // A FAILED READ IS NEVER AN EMPTY TABLE. `meta().reason` is set on every failure and `funds` is
  // then []; render the named state rather than "no funds", which would read as an empty universe.
  if (!m || m.reason) {
    return { html: failurePanel(m), wire: (root) => wireRetry(root, repaint) };
  }

  const visiblePeriods = periodsWithData(funds, m.periods);
  const table = buildTable(funds, m, visiblePeriods, view, measure);

  // ONE TABLE AND NOTHING ELSE, the way the filed view and the Earnings Hub are built. No stat strip,
  // no ranking grid: this is a listing the reader scans and sorts. The provenance is one click away
  // in the pill, which is the honesty rule the kit is built on — declutter the page, never delete
  // the accountability.
  const html = `
    ${sectionHead({
      title: 'Fund Returns & Ranking',
      description: descriptionFor(m),
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}</div>`,
      // Trusted markup from the owning tab — the classification chips, where there are any.
      controls: headHtml,
    })}
    ${table.html}
  `;

  return {
    html,
    wire(root) {
      const off = table.wire(root);
      if (off) disposers.push(off);
      // The reader's own search / filter / sort, handed back so a repaint (a chip press) can seed
      // the next instance with it rather than discarding what they had set up.
      onView?.(table.view);
      root.querySelector('[data-fund-returns-info]')?.addEventListener('click', () => openProvenance(m, extraProvenance));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Which period columns to show
// ---------------------------------------------------------------------------------------

/**
 * Hide a period whose return AND rank are null for EVERY row — 10Y is empty for most cohorts, and a
 * column of em dashes is noise. This drops nothing a reader could have used: a period kept is a
 * period at least one scheme reports.
 */
function periodsWithData(funds, periods) {
  return periods.filter((p) =>
    funds.some((f) => {
      const cell = f.returns?.[p];
      return cell && (cell.return != null || cell.rank != null);
    }),
  );
}

// ---------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------

function buildTable(funds, m, visiblePeriods, view = null, measure = 'return') {
  const search = fundSearch({ rows: funds, selected: view?.fundSearch?.categories, q: view?.q });
  const table = scoreTable({
    rows: funds,
    // The scheme code is the stable, content-derived id — never a row index (see the perf notes in
    // CLAUDE.md: a positional key breaks the repaint fast path the moment the row set changes).
    key: (r) => r.schemecode,
    // A MUTUAL-FUND SCHEME IS NOT A COMPANY, so it gets no star.
    //
    // Without this, `watchKey` defaults to `key` — the AmfiBeas scheme code, a bare number like
    // "119551" — and the watchlist store rejects it against its symbol pattern. The star then
    // repainted HOLLOW on every click: the state was correct (nothing was stored, because a scheme
    // code is not a ticker) and only the control the reader had just pressed disagreed with it,
    // which is the exact failure `staleKeys` exists to close, arrived at from the other side. The
    // rule is already written down for this case — "a row with no company gets NO STAR, not a dead
    // one" — and it applies to all ~3,400 rows here. The Watchlist FILTER goes with it: the kit
    // drops that control when no row on a table is watchable.
    watchKey: () => null,
    // The filter goes with the star, for the same reason: narrowing ~3,400 SCHEMES by the reader's
    // watched COMPANIES can only ever produce an empty table.
    showWatchFilter: false,
    name: (r) => r.fundName,
    nameLabel: 'Scheme',
    sub: (r) => identitySub(r),
    // No leading rank counter: the list is alphabetical, so "#7" would number the current sort
    // rather than rank anything — and this table already carries a real, per-period rank.
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 300,
    stickyHead: 'max(320px, calc(100vh - 300px))',
    searchControl: search,
    // Alphabetical by name, exactly as the source lists them.
    initialSort: { key: 'name', dir: 'asc' },
    initialView: view,
    columns: columnsFor(visiblePeriods, measure),
    exportName: `glow-fund-returns-${todayStamp()}`,
    onExport: (visible) => exportFunds(visible, m, visiblePeriods),
    countNoun: 'schemes',
    emptyMessage: 'No scheme matches your filters.',
  });
  // Keep category selections alongside the table's query and sort when a chip or measure repaints it.
  table.view.fundSearch = search.view;
  return table;
}

/**
 * The sub-line under a scheme name: its classification, the strategy its own name states, and its
 * option.
 *
 * THE PLAN IS NOT PRINTED. Every row is the direct plan bar the schemes that have only one, so a
 * word repeated on 1,600 rows says nothing; where a row is a single-plan scheme the table says so
 * once, in the head. See directOnly() in js/data/fund-returns.js.
 */
function identitySub(r) {
  const option = r.option && r.option !== 'unknown' ? cap(r.option === 'idcw' ? 'IDCW' : r.option) : null;
  const strategy = (r.factors || []).map(factorLabel).join(' · ') || null;
  return [r.classification, strategy, option].filter(Boolean).join(' · ');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------------------
// Columns — two per visible period: the return, then the rank
// ---------------------------------------------------------------------------------------

function columnsFor(periods, measure) {
  const cols = [];
  for (const p of periods) {
    const label = fundReturns.PERIOD_LABEL[p] || p;
    cols.push({
      // THE HEADING NAMES THE UNIT WHEN THE UNIT CHANGES. A gap between two percentages is measured
      // in percentage POINTS, and a screenshot travels without the chip row that selected the mode.
      label: measure === 'return' ? label : `${label} pp`,
      get: (r) => (measure === 'return' ? returnCell(r.returns?.[p], p) : excessCell(r.returns?.[p], p)),
      html: true,
      align: 'right',
      sortable: true,
      sortValue: (r) => valueOrNull(measure === 'return' ? r.returns?.[p]?.return : r.returns?.[p]?.excessVsMedian),
    });
    cols.push({
      // The rank sub-column. `wrapHeads` lets "3Y CAGR Rank" stack instead of forcing the column
      // as wide as the label — the headings, not the "38/149" figures, are what would overflow.
      label: `${label} Rank`,
      get: (r) => rankCell(r.returns?.[p]),
      html: true,
      align: 'right',
      sortable: true,
      // Ascending rank is "best first"; a null rank sorts last, which scoreTable's comparator does
      // for null on its own.
      sortValue: (r) => valueOrNull(r.returns?.[p]?.rank),
    });
  }
  return cols;
}

const valueOrNull = (v) => (v == null || Number.isNaN(v) ? null : v);

const fmt1 = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const fmtPp = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;

/**
 * One period's cell: the scheme's own return, and beneath it the benchmark that return is measured
 * against — the category median AmfiBeas publish for the scheme's own cohort on the same NAV date.
 * Shaded by the gap between them, which is their `excessVsMedian` and not a subtraction done here.
 *
 * A cohort too small for statistics carries a return and no median. That prints the return with an
 * em dash beneath it and a title saying which side is missing — never a zero, and never a benchmark
 * quietly borrowed from a wider set.
 */
function returnCell(cell, period) {
  const v = cell?.return;
  if (v == null) return dash(cell?.reason || 'no return for this period');
  const median = cell.categoryMedian;
  const excess = cell.excessVsMedian;
  const heat = excess == null ? { className: '', title: null } : gapHeat(excess, period);
  const tone = v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';
  const title = median == null
    ? `${fmt1(v)} over ${period}. This scheme’s cohort is too small for the source to publish a category median, so there is nothing to compare it with — not a zero.`
    : `${heat.title}. Scheme ${fmt1(v)} against its category median ${fmt1(median)}${cell.categoryAverage != null ? ` (average ${fmt1(cell.categoryAverage)})` : ''} over ${period}.`;
  return `
    <span class="inline-block w-full rounded px-1 py-0.5 text-right ${heat.className}" title="${escapeHtml(title)}">
      <span class="block font-semibold tabular-nums ${tone}">${escapeHtml(fmt1(v))}</span>
      <span class="block text-[10px] tabular-nums text-slate-400">${escapeHtml(median == null ? '—' : fmt1(median))}</span>
    </span>`;
}

/** The same cell in the gap reading: the source's own excess over its category median, in points. */
function excessCell(cell, period) {
  const excess = cell?.excessVsMedian;
  if (excess == null) {
    return dash(
      cell?.return == null
        ? cell?.reason || 'no return for this period'
        : 'this scheme’s cohort is too small for the source to publish a category median, so no gap can be shown',
    );
  }
  const heat = gapHeat(excess, period);
  return `<span class="inline-block w-full rounded px-1 py-0.5 text-right tabular-nums font-semibold ${heat.className}" title="${escapeHtml(`${fmt1(cell.return)} against its category median ${fmt1(cell.categoryMedian)} over ${period} — ${heat.title}. The excess is the source’s own figure.`)}">${escapeHtml(fmtPp(excess))}</span>`;
}

/**
 * The peer rank: "rank/peerCount" within the scheme's own cohort, an em dash where the cohort was
 * too small to rank. Reproduced, not computed — the same rule the con-call score follows.
 */
function rankCell(cell) {
  if (!cell || cell.rank == null) return dash('the cohort was too small to rank');
  const peers = cell.peerCount != null ? cell.peerCount : '—';
  // The quartile and percentile are the source's too, so they ride in the title rather than as two
  // more columns on a table that already carries fourteen.
  const extra = [
    cell.quartile ? `${cell.quartile} of its cohort` : null,
    cell.percentile != null ? `${cell.percentile.toFixed(0)}th percentile` : null,
  ].filter(Boolean).join(' · ');
  const title = `Rank within the scheme’s own cohort${extra ? ` — ${extra}` : ''}. The source’s own ranking.`;
  return `<span class="tabular-nums text-slate-600" title="${escapeHtml(title)}">${escapeHtml(String(cell.rank))}/${escapeHtml(String(peers))}</span>`;
}

/** A dash that says why it is a dash — never a zero. */
const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// ---------------------------------------------------------------------------------------
// Chrome — the pill and the provenance modal
// ---------------------------------------------------------------------------------------

function descriptionFor(m) {
  const asOf = m.asOfDate ? ` as of ${formatDateLabel(m.asOfDate)}` : '';
  return (
    `Every tracked mutual fund and ETF${asOf}, from AmfiBeas over AMFI’s daily NAV snapshot: its point-to-point return, its category’s published median beneath it, and its rank within its own cohort. ` +
    `The returns, the category medians and the ranks are theirs, reproduced unchanged; this view adds no scoring of its own. ` +
    `One row per scheme — the direct plan, and the single plan a listed fund has.`
  );
}

/** The green Live pill — the always-visible statement of what the figures are and how fresh. */
function livePill(m) {
  const freshness = originLabel(m);
  return `
    <button type="button" data-fund-returns-info title="Where these figures come from, what the benchmark is, and what the rank measures"
      class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100 transition-colors hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span>${escapeHtml(freshness)}</span>
      <span class="font-medium text-emerald-600">${escapeHtml(formatNumber(m.total || m.count))} schemes${m.asOfDate ? ` · as of ${escapeHtml(formatDateLabel(m.asOfDate))}` : ''}</span>
    </button>`;
}

/**
 * The pill's leading word states WHERE this paint came from, never claims a freshness it has not
 * confirmed — the same rule the store rests on. `live` was read from the network this session,
 * `store` is a 304-confirmed device copy; both are real reads, so both say "Live", but a reader can
 * tell which via the modal.
 */
function originLabel(m) {
  return m.origin === 'store' ? 'Cached' : 'Live';
}

function openProvenance(m, extra = '') {
  openModal(
    `<div class="p-6 sm:p-8">
      <h3 class="font-display text-xl font-bold text-slate-900">Where this comes from</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        Live from the <strong>AmfiBeas</strong> Returns &amp; Ranking API, called <strong>directly from your browser</strong>
        rather than through this site’s Worker — the feed is CORS-open and read-only, so there is no credential to hold and
        nothing to proxy for (and Cloudflare refuses a Worker-to-Worker request inside one account anyway). It computes
        point-to-point returns from AMFI’s daily NAV snapshot and ranks each scheme within its own cohort.
      </p>
      ${extra}
      <dl class="mt-5 space-y-3 text-sm">
        <div><dt class="font-semibold text-slate-800">Theirs, reproduced unchanged</dt>
          <dd class="text-slate-600">Every return, every category median and average, every excess and every rank. A return is a percentage already — a simple return for 1M/3M/6M/1Y and a CAGR for 3Y/5Y/10Y. Nothing here is re-banded, re-ranked or recomputed; even the gap under each return is their <code>excessVsMedian</code> rather than a subtraction done here.</dd></div>
        <div><dt class="font-semibold text-slate-800">What the benchmark is — and what it is not</dt>
          <dd class="text-slate-600">The small figure beneath every return is <strong>the scheme’s own category median</strong>, published by the source for that cohort on the <strong>same NAV date</strong> as the return above it. It is a <strong>category</strong> benchmark, not an index: AMFI’s daily NAV snapshot carries no index level, so this feed publishes no index return and <strong>none is invented here</strong>. The index comparison lives on <strong>Category Performance</strong>, which reads a different source on its own earlier date — and no figure crosses between the two.</dd></div>
        <div><dt class="font-semibold text-slate-800">One row per scheme — the direct plan</dt>
          <dd class="text-slate-600">The source returns both plans of every scheme, which listed each fund twice under two NAVs that differ only by the distributor’s trail. This table shows the <strong>direct plan wherever the source lists one</strong>${
            m.hiddenRegular ? `, so ${escapeHtml(formatNumber(m.hiddenRegular))} regular-plan rows are not shown` : ''
          }. <strong>A scheme with only one plan is kept as it is</strong> — every exchange-traded fund is filed <em>regular</em> because a listed unit has no plan to choose, and dropping those rows would have deleted every ETF from this tab${
            m.singlePlan ? `; ${escapeHtml(formatNumber(m.singlePlan))} rows arrive that way` : ''
          }.${
            m.foldedDuplicates
              ? ` The source also lists ${escapeHtml(formatNumber(m.foldedDuplicates))} schemes <strong>twice, under two ids</strong>, with the same name bar a plan suffix and <strong>every figure identical</strong>; those are shown once. Only rows that are indistinguishable on screen are folded — a pair differing in any return or rank is two schemes and both stay.`
              : ''
          } ${escapeHtml(formatNumber(m.total || m.count))} of the source’s ${escapeHtml(formatNumber(m.universe || m.total || m.count))} rows are listed.</dd></div>
        <div><dt class="font-semibold text-slate-800">Why a scheme’s name may differ from the source’s</dt>
          <dd class="text-slate-600">The source names hundreds of <em>direct-plan</em> rows <code>…-Reg(G)</code> — the regular plan’s label on the direct plan’s row, which its own <code>plan</code> field contradicts. The trailing <strong>plan</strong> marker is dropped from the name shown here and <strong>nothing else is</strong>: the option suffix stays, no scheme is renamed, and the export carries the source’s own string in its own column beside ours.</dd></div>
        <div><dt class="font-semibold text-slate-800">What the rank measures</dt>
          <dd class="text-slate-600">The scheme’s rank <strong>within its own cohort</strong>, shown <code>rank/peerCount</code> — e.g. <code>38/149</code>. It is a rank against comparable schemes, not against the whole list; the quartile and percentile the source publishes beside it are in each cell’s tooltip.</dd></div>
        <div><dt class="font-semibold text-slate-800">“Strategy in the name” is read from the scheme name</dt>
          <dd class="text-slate-600">Neither this feed nor the weekly workbook classifies a fund as a momentum or a quality fund — the source files every passive equity scheme as <em>Index</em>, <em>Index Funds</em> or <em>ETFs</em> and stops there. The strategy filter reads the word out of the <strong>scheme’s own name</strong>, which is where the tracked index is stated, and it is a separate axis: it never changes a scheme’s classification and a scheme matching nothing is simply not in a strategy.</dd></div>
        <div><dt class="font-semibold text-slate-800">A dash is not a zero</dt>
          <dd class="text-slate-600">A missing <strong>return</strong> means the scheme has no return for that period; a missing <strong>median</strong> means the cohort was too small for the source to publish one; a missing <strong>rank</strong> means the same and can sit beside a real return. None is counted or coloured as a measured value.</dd></div>
        <div><dt class="font-semibold text-slate-800">Which periods are shown</dt>
          <dd class="text-slate-600">A period that is empty for every scheme is hidden — that is the only display choice this view makes. ${escapeHtml(String((m.periods || []).length))} periods are carried in the feed.</dd></div>
        <div><dt class="font-semibold text-slate-800">Freshness</dt>
          <dd class="text-slate-600">${provenanceFreshness(m)}</dd></div>
      </dl>
      <div class="mt-6 flex justify-end">
        <button data-modal-close class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">Close</button>
      </div>
    </div>`,
    { size: 'wide' },
  );
}

function provenanceFreshness(m) {
  const asOf = m.asOfDate ? `As of <strong>${escapeHtml(formatDateLabel(m.asOfDate))}</strong> (the AMFI NAV date the returns were computed to). ` : '';
  const origin =
    m.origin === 'store'
      ? 'This paint came from your device’s cache, revalidated against the upstream’s ETag'
      : 'This paint was read live from the upstream this session';
  const checked = m.checkedAt ? `, last confirmed ${escapeHtml(formatRelativeTime(new Date(m.checkedAt)))}` : '';
  return `${asOf}${origin}${checked}. The API refreshes daily; this page revalidates and reuses your cached copy when nothing changed.`;
}

// A NAV date is "YYYY-MM-DD"; render it as "12 Aug 2026" without inventing a timezone.
function formatDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

// ---------------------------------------------------------------------------------------
// Failure panel — a named state, never an empty table, with a way back
// ---------------------------------------------------------------------------------------

function failurePanel(m) {
  const reason = m?.reason || 'unknown';
  const url = m?.url || null;
  const REASONS = {
    'no-url': {
      title: 'The fund-returns feed has no address',
      body:
        'No upstream is configured. Set <code>window.AMFIBEAS_API_BASE</code> in <code>public/index.html</code> to the AmfiBeas host ' +
        '(or <code>localStorage["sattva:amfibeas-base"]</code> for a one-off), then reload. The API is not yet deployed to a fixed host.',
    },
    'not-found': {
      title: 'The fund-returns upstream answered 404',
      body: 'The host resolved but <code>/api/returns-ranking</code> was not there. Check the base URL, and that the API branch is deployed.',
    },
    unreachable: {
      title: 'The fund-returns upstream could not be reached',
      body: 'The request never completed — the host is down, the network is offline, or a CORS preflight was refused.',
    },
    upstream: {
      title: 'The fund-returns upstream returned an error',
      body: 'It answered, but with an error status. Try again shortly.',
    },
    shape: {
      title: 'The fund-returns upstream returned something unexpected',
      body: 'It answered, but not in the documented shape — the <code>funds</code> array was missing. Their contract may have changed.',
    },
  };
  const r = REASONS[reason] || { title: 'The fund-returns feed could not be read', body: 'No further detail was reported.' };
  return `
    ${sectionHead({ title: 'Fund Returns & Ranking', description: 'Point-to-point returns and same-cohort peer rank for every tracked mutual fund and ETF, from AmfiBeas.' })}
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
      <div class="flex items-start gap-3">
        <span class="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-amber-400"></span>
        <div class="min-w-0">
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(r.title)}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-600">${r.body}</p>
          ${url ? `<p class="mt-3 text-xs text-slate-500">Requested <code class="rounded bg-slate-100 px-1">${escapeHtml(url)}</code> — the exact address, so this can be diagnosed without guessing at it.</p>` : ''}
          <p class="mt-3 text-xs text-slate-400">Nothing is shown rather than a zero: an empty list and a list we could not read must never look the same.</p>
          <button type="button" data-fund-returns-retry
            class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60">
            Try again
          </button>
        </div>
      </div>
    </div>`;
}

function wireRetry(root, repaint) {
  const btn = root.querySelector('[data-fund-returns-retry]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    try {
      await fundReturns.reload();
    } catch {
      /* reload never rejects on a named failure; a thrown one falls through to the repaint below */
    }
    if (repaint) repaint();
  });
}

// ---------------------------------------------------------------------------------------
// Export — the one artefact that leaves without the page's chrome, so the banner carries the source
// ---------------------------------------------------------------------------------------

async function exportFunds(visible, m, periods) {
  const banner =
    `THIRD-PARTY DATA, REPRODUCED. Fund returns, category medians and same-cohort peer ranks from the AmfiBeas Returns & Ranking API ` +
    `(computed over AMFI’s daily NAV snapshot)${m.asOfDate ? `, as of ${formatDateLabel(m.asOfDate)}` : ''}. ` +
    `THE RETURNS, THE CATEGORY FIGURES AND THE RANKS ARE THEIRS — reproduced unchanged, not recomputed or re-ranked here. ` +
    `A return is a percentage already: a simple return for 1M/3M/6M/1Y and a CAGR for 3Y/5Y/10Y. ` +
    `THE BENCHMARK IN THIS SHEET IS THE SCHEME'S OWN CATEGORY, NOT AN INDEX: AMFI's NAV snapshot carries no index level, so this source publishes no index return and none is substituted. ` +
    `The excess column is the source's own "excessVsMedian", in percentage POINTS, not a subtraction done here. ` +
    `A rank is "rank of peerCount" WITHIN THE SCHEME'S OWN COHORT, not against the whole list. ` +
    `ONE ROW PER SCHEME — the DIRECT plan wherever the source lists one; a scheme with only one plan (every exchange-traded fund) is kept as it is. Regular-plan duplicates are not in this sheet. ` +
    `Where the source lists one scheme twice under two ids with EVERY FIGURE IDENTICAL, it appears once. ` +
    `The "Scheme" column drops the trailing PLAN marker from the source's own name, because it labels direct-plan rows "-Reg(G)" against its own plan field; the source's string is in the column beside it, unaltered. ` +
    `"Strategy in name" is read from the SCHEME'S OWN NAME, where the tracked index is stated — it is not a classification either source publishes, and it never changes the classification column beside it. ` +
    `A blank return means no return for that period; a blank median or rank means the cohort was too small for the source to publish one — NONE IS A ZERO. ` +
    `NOT COMPARABLE WITH THE CATEGORY PERFORMANCE SHEET, which reads a weekly workbook on an earlier date. ` +
    `Source: ${m.source || 'AmfiBeas'}. Exported ${new Date().toISOString()}.`;

  const columns = [
    { header: 'Scheme code', key: 'code', width: 14, get: (r) => r.schemecode },
    { header: 'Scheme', key: 'name', width: 46, get: (r) => r.fundName },
    { header: 'Scheme (as the source names it)', key: 'srcname', width: 46, get: (r) => r.sourceName || r.fundName },
    { header: 'Classification', key: 'cls', width: 26, get: (r) => r.classification || '' },
    { header: 'Strategy in name (read from the name)', key: 'fac', width: 30, get: (r) => (r.factors || []).map(factorLabel).join(' · ') },
    { header: 'Plan', key: 'plan', width: 10, get: (r) => (r.plan && r.plan !== 'unknown' ? cap(r.plan) : '') },
    { header: 'Option', key: 'opt', width: 10, get: (r) => (r.option && r.option !== 'unknown' ? (r.option === 'idcw' ? 'IDCW' : cap(r.option)) : '') },
  ];
  for (const p of periods) {
    const label = fundReturns.PERIOD_LABEL[p] || p;
    columns.push({
      header: `${label} return %`,
      key: `r_${p}`,
      width: 16,
      get: (r) => {
        const v = r.returns?.[p]?.return;
        return v == null ? '' : Number(v.toFixed(2));
      },
    });
    columns.push({
      header: `${label} category median % (benchmark)`,
      key: `m_${p}`,
      width: 24,
      get: (r) => {
        const v = r.returns?.[p]?.categoryMedian;
        return v == null ? '' : Number(v.toFixed(2));
      },
    });
    columns.push({
      header: `${label} vs category median (pp)`,
      key: `x_${p}`,
      width: 22,
      get: (r) => {
        const v = r.returns?.[p]?.excessVsMedian;
        return v == null ? '' : Number(v.toFixed(2));
      },
    });
    columns.push({
      header: `${label} rank`,
      key: `k_${p}`,
      width: 14,
      get: (r) => {
        const cell = r.returns?.[p];
        return !cell || cell.rank == null ? '' : `${cell.rank}/${cell.peerCount ?? ''}`;
      },
    });
  }

  await exportSheets({
    filename: `glow-fund-returns-${todayStamp()}`,
    banner,
    sheets: [{ name: 'Returns & Ranking', columns, rows: visible }],
  });
}
