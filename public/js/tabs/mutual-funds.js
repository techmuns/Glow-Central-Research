// tabs/mutual-funds.js — MUTUAL FUNDS: category performance against its benchmark, and every
// tracked scheme's daily return and peer rank. GLOW-OWNED.
//
//   Category Performance   the weekly workbook — every category's published median beside the index
//                          the workbook pairs it with, then a drill into that category's schemes
//   All Schemes            the daily AmfiBeas feed — every scheme's return beside its own category's
//                          published median, and its rank inside its own cohort
//
// IT USED TO BE A SUB-VIEW OF SUPER INVESTORS AND IT SHOULD NOT HAVE BEEN. That tab is about WHO
// HOLDS WHAT — a superstar investor's filed book, an institution's shareholding, an AMC's portfolio.
// A fund's RETURN is not a holding: it does not sum with a stake, it does not join to a company, and
// nothing on it answers the question the rest of that tab exists to answer. It sat there because
// that is where the feed happened to be wired, and one sub-view of somebody else's tab is not where
// a reader looks for fund performance.
//
// ============================================================================================
// TWO FEEDS, TWO DATES, AND NOT ONE NUMBER CROSSES BETWEEN THEM
// ============================================================================================
//
//                   | Category Performance          | All Schemes
//   --------------- | ----------------------------- | ---------------------------------------
//   source          | weekly workbook, committed    | AmfiBeas, read live from the browser
//   as on           | its own stated date           | its own, later, date
//   schemes         | ~620 curated direct plans     | ~1,850, the direct plan of each
//   category median | PUBLISHED by the workbook     | PUBLISHED per cohort, on its own date
//   benchmark       | a PUBLISHED INDEX per category| the scheme's own CATEGORY — no index exists
//   peer rank       | none                          | published, within its own cohort
//
// So the two sub-views never share a row, a column, a total or a comparison. Putting the workbook's
// 14-August index return beside an AmfiBeas 2-September fund return would be a comparison nobody
// measured — the same error as dating a price move by the capture rather than the session
// (CLAUDE.md, "A close is a claim about a SESSION"). Each sub-view prints its own as-on date on its
// own face, and each provenance panel says in words that they are different snapshots.
//
// ============================================================================================
// EVERY RETURN ON THIS TAB CARRIES ITS BENCHMARK, AND THE BENCHMARK IS ALWAYS SOMEBODY ELSE'S
// ============================================================================================
//
// A return with nothing beside it answers nothing: +14% over a year is a good year or a poor one
// entirely according to what the thing it should be compared with did. So no figure here is shown
// alone — a category's median sits over its index, a scheme's return over its category median, and
// on All Schemes every return sits over the median the source publishes for its own cohort.
//
// ONE SHEET IN THE WORKBOOK PRINTS NO INDEX ROW (Smart Beta Strategy Funds), and it is the one
// place this tab shows a comparator the source did not choose. The index comes from the workbook's
// OWN master index sheet, defaults to the one the workbook itself prints first under all eleven
// sectoral and thematic sheets, is changeable by the reader, and is marked "not the workbook's
// pairing" on the benchmark cell, in the reference row, in the picker, in the provenance panel and
// in row 1 of the export. The rule that survives is the labelling, not the absence.
//
// THE MEDIANS, THE INDEX RETURNS, THE COHORT MEDIANS AND THE PEER RANKS ARE ALL THEIRS. Reproduced,
// never recomputed — the con-call rule, applied to a third feed. Exactly two things here are
// derived, and both are labelled wherever they surface:
//
//   1. THE GAP, in percentage POINTS, on the WORKBOOK half: a return minus its category median, or
//      minus its benchmark. Subtraction of two of their own percentages, never shown where either
//      side is absent. (On All Schemes even this is theirs — `excessVsMedian` is published.)
//   2. THE SHADE. The figure in a cell is always the source's; only its background is added here,
//      and js/ui/mf-heatmap.js's legend states what it means, in the provenance panel.
//
// THE HIERARCHY IS A READING AID OVER SOMEBODY ELSE'S CATEGORY, NOT A NEW CATEGORY. Both feeds
// publish a flat bucket — a sheet name, or an "Equity : Large Cap" string — and js/data/mf-taxonomy.js
// groups them into asset class -> group -> category for both. Nothing is renamed or merged, every
// scheme keeps the bucket its source put it in, and a bucket nothing anticipated is `Unclassified`
// and visible rather than folded into whichever group looked closest. All Schemes offers all three
// levels, because there the third one is invisible until a control names it; Category Performance
// offers two, because there the third level IS the row.
//
// AND THERE IS A FOURTH READING THAT IS NOT PART OF THE TREE. Neither source classifies a momentum
// or a quality fund as one — AmfiBeas file all 645 passive equity schemes as `Index`, `Index Funds`
// or `ETFs` and stop there — so the strategy chips read the word out of the SCHEME'S OWN NAME,
// which is where the tracked index is stated, say so on their own face, and change no scheme's
// classification. See FACTORS in js/data/mf-taxonomy.js.
//
// NOTHING ON THIS TAB SHOWS A REGULAR PLAN. The workbook is direct-plan only by construction; the
// live feed returns both, so js/data/fund-returns.js keeps the direct plan of every scheme and the
// single plan of every scheme that has one — an ETF has no plan to choose, and a blanket "drop
// regular" would have deleted all 234 of them.
//
// SCOPE DOES NOT APPLY, AND THE HEAD SAYS SO. These are schemes, not companies: the Portfolio /
// Watchlist / Universe toggle narrows nothing here, no row carries a watchlist star, and
// `allowEmptyScope` keeps an empty watchlist from replacing the tab with the shell's "add
// companies" panel — the same opt-out the two macro tabs and Ask Research take.

import { sectionHead, scoreTable, openModal, pendingPanel } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { peerHeat, gapHeat, HEAT_LEGEND } from '../ui/mf-heatmap.js';
import { renderFundReturns } from '../investors/fund-returns.js';
import * as weekly from '../data/mf-weekly.js';
import * as fundReturns from '../data/fund-returns.js';
import { buildTree, classifyLive, FACTORS, factorsOf, factorLabel } from '../data/mf-taxonomy.js';

export const meta = {
  id: 'mutual-funds',
  title: 'Mutual Funds',
  subtitle:
    'Every mutual-fund category against the index it is benchmarked to, its published median, and each scheme inside it — plus every tracked scheme’s daily return beside its own category’s median and its peer rank.',
  subviews: [
    // The shell opens the first subview when the tab is selected or no subview is named.
    { id: 'all-schemes', label: 'All Schemes' },
    { id: 'category-performance', label: 'Category Performance' },
  ],
  // Scope does not narrow a list of schemes, so an EMPTY watchlist must not replace the tab with
  // the shell's "add companies" panel.
  allowEmptyScope: true,
};

// ---------------------------------------------------------------------------------------
// State that survives a repaint but not leaving the tab
// ---------------------------------------------------------------------------------------

let ctxRef = null;
let renderToken = 0;
let disposers = [];
// The drill: null is the category comparison, an id is that category's schemes.
let openCategory = null;
// Which reading the numeric columns show. 'return' is the source's own figure; the other two are
// the derived gap, in percentage points, and say so in their headings.
let measure = 'return';
// The reader's own table state, carried across the repaints a drill or a measure change causes.
let categoryView = null;
let schemeView = null;
let allSchemesView = null;
// The hierarchy filter, shared by both sub-views: null means "every asset class".
let assetClass = null;
let group = null;
// The third level — the source's own category — offered on All Schemes, where the row is a scheme
// rather than a category. Null means "every category in this group".
let categoryId = null;
// The strategy the scheme's own NAME states. A separate axis from the three above; null means "any".
let strategy = null;
// The reader's own benchmark choice, per category id — one of the indices the workbook prints under
// THAT category, or, for the one sheet it prints none under, one from its own master index sheet.
let chosenBenchmark = {};

// WHICH READINGS EACH LEVEL OFFERS, and the reason the two lists differ.
//
// A CATEGORY'S MEDIAN CANNOT BE COMPARED WITH ITSELF. The first version offered "vs Median" on the
// category table too; it produced twenty-six rows of em dashes — correct, and a control the reader
// can press that answers nothing. Worse, the column's `sortValue` still returned the underlying
// median, so clicking a heading reordered the table by a number that was not on screen: a table
// sorting itself by an invisible figure is the shape of bug this codebase keeps finding. The
// resolution is the one this file already uses for a row with no company — do not offer the
// control — rather than a better empty state.
const CATEGORY_MEASURES = [
  ['return', 'Return', 'The workbook’s own median for the category, over its own benchmark.'],
  ['vs-benchmark', 'vs Benchmark', 'The category median minus its benchmark’s return for the same period, in percentage points. Derived here.'],
];
const SCHEME_MEASURES = [
  ['return', 'Return', 'The workbook’s own figure for the period.'],
  ['vs-benchmark', 'vs Benchmark', 'The scheme’s return minus the benchmark’s return for the same period, in percentage points. Derived here.'],
  ['vs-median', 'vs Median', 'The scheme’s return minus its category’s published median for the same period, in percentage points. Derived here.'],
];
// ALL SCHEMES HAS NO INDEX TO OFFER, so its second reading is the excess over the scheme's own
// category median — and that one is not derived here either: it is the source's own
// `excessVsMedian`, on the same NAV date as the return above it.
const LIVE_MEASURES = [
  ['return', 'Return', 'The source’s own return for the period, with its category’s published median beneath it.'],
  ['vs-benchmark', 'vs Category', 'The source’s own excess over its category median for the same period, in percentage points. Their subtraction, not one done here.'],
];
const MEASURES_BY_LEVEL = { category: CATEGORY_MEASURES, scheme: SCHEME_MEASURES, live: LIVE_MEASURES };
const measuresFor = (level) => MEASURES_BY_LEVEL[level] || SCHEME_MEASURES;
/** A measure the current level does not offer falls back to the source's own figure. */
const measureFor = (level) => (measuresFor(level).some(([id]) => id === measure) ? measure : 'return');

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  renderToken++;
  // Leaving Category Performance resets its drill, so returning opens on the comparison rather
  // than inside whichever category was last read.
  if (ctxRef && ctxRef.subview !== ctx.subview) {
    openCategory = null;
    schemeView = null;
  }
  ctxRef = ctx;
  if (ctx.subview === 'all-schemes') renderAllSchemes(ctx);
  else renderCategoryPerformance(ctx);
}

export function destroy() {
  renderToken++;
  ctxRef = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  openCategory = null;
  measure = 'return';
  categoryView = null;
  schemeView = null;
  allSchemesView = null;
  assetClass = null;
  group = null;
  categoryId = null;
  strategy = null;
  chosenBenchmark = {};
}

function releaseDisposers() {
  disposers.forEach((d) => d && d());
  disposers = [];
}

// ---------------------------------------------------------------------------------------
// Category Performance — the weekly workbook
// ---------------------------------------------------------------------------------------

function renderCategoryPerformance(ctx) {
  releaseDisposers();
  const token = renderToken;

  const paint = () => {
    if (token !== renderToken || ctxRef?.subview === 'all-schemes') return;
    releaseDisposers();
    const m = weekly.meta();
    // A FAILED READ IS NEVER AN EMPTY TABLE. `categories: []` only ever travels with a reason.
    if (!m || m.reason) {
      ctx.root.innerHTML = weeklyFailure(m);
      wireRetry(ctx.root, () => weekly.reload().then(paint));
      return;
    }
    const panel = openCategory ? schemePanel(m, paint) : comparisonPanel(m, paint);
    ctx.root.innerHTML = panel.html;
    panel.wire(ctx.root);
  };

  if (weekly.isLoaded()) {
    paint();
    return;
  }
  ctx.root.innerHTML = loadingHtml('Reading the weekly workbook…');
  weekly.load().then(() => {
    if (token === renderToken) paint();
  });
}

/** Categories after the asset-class / group filter. One predicate, used by the tree AND the table. */
function scopedCategories() {
  return weekly.categories().filter((c) => (!assetClass || c.assetClass === assetClass) && (!group || c.group === group));
}

// ---- Level 1: every category against its own benchmark ---------------------------------------

function comparisonPanel(m, repaint) {
  const cats = scopedCategories();
  const periods = m.periods;
  const table = comparisonTable(cats, m, periods);
  // Captured so the NEXT paint — a chip press, a measure toggle, a drill and back — seeds from what
  // the reader had set up rather than discarding it. Read-and-never-written is the shape of bug
  // `initialView` exists to prevent.
  categoryView = table.view;

  const html = `
    ${sectionHead({
      title: 'Category performance against its benchmark',
      description:
        `Every mutual-fund category in the weekly workbook: the median return it published for that category, beside the index it prints beneath it. ` +
        `The medians and the index returns are the workbook’s, reproduced unchanged; the gap between them is the one figure derived here, and it is measured in percentage points.`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${asOfPill(m)}${scopeChip()}</div>`,
      controls: `${hierarchyControls(weekly.categories())}${measureControls('category')}`,
    })}
    ${table.html}
  `;

  return {
    html,
    wire(root) {
      const off = table.wire(root);
      if (off) disposers.push(off);
      wireHierarchy(root, repaint);
      wireMeasure(root, repaint);
      wireProvenance(root, m);
    },
  };
}

function comparisonTable(cats, m, periods) {
  return scoreTable({
    rows: cats,
    key: (c) => c.id,
    // A CATEGORY IS NOT A COMPANY, so it gets no star: the watchlist is a set of companies and a
    // star that matched nothing for ever is worse than a control that is not offered.
    watchKey: () => null,
    // ...and no watchlist FILTER either. It could only ever narrow a list of categories to the
    // reader's watched COMPANIES, which is an empty table every time — the same reasoning that
    // gives the rows no star, applied to the control beside them.
    showWatchFilter: false,
    name: (c) => c.label,
    nameLabel: 'Category',
    sub: (c) => `${c.assetClass} · ${c.group} · ${c.funds.length} scheme${c.funds.length === 1 ? '' : 's'}`,
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 260,
    stickyHead: 'max(320px, calc(100vh - 380px))',
    searchable: (c) => `${c.label} ${c.sheet} ${c.assetClass} ${c.group} ${c.benchmarks.map((b) => b.name).join(' ')}`,
    searchPlaceholder: 'Search category or benchmark...',
    initialSort: { key: 'name', dir: 'asc' },
    initialView: categoryView,
    columns: [
      {
        label: 'Benchmark',
        html: true,
        get: (c) => {
          const { benchmark, reason, paired } = weekly.benchmarkFor(c, chosenBenchmark[c.id]);
          if (!benchmark) {
            return `<span class="text-xs text-slate-400" title="${escapeHtml(reason)}">none published</span>`;
          }
          // A CATEGORY THE WORKBOOK PRINTS NO INDEX UNDER SAYS SO ON THE FACE OF THE CELL. The
          // comparator is still shown — a return with nothing beside it answers nothing — but it is
          // never allowed to read as the workbook's own pairing, here or anywhere else it surfaces.
          if (!paired) {
            return `<span class="text-xs text-slate-600" title="${escapeHtml(reason)}">${escapeHtml(benchmark.name)}<span class="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-100">not the workbook’s pairing</span></span>`;
          }
          return `<span class="text-xs text-slate-600" title="${escapeHtml(reason)}">${escapeHtml(benchmark.name)}</span>`;
        },
        sortValue: (c) => weekly.benchmarkFor(c, chosenBenchmark[c.id]).benchmark?.name || '',
      },
      ...periods.map((p) => ({
        label: periodHeadFor(p, 'category'),
        align: 'right',
        html: true,
        get: (c) => categoryCell(c, p),
        sortValue: (c) => categoryValue(c, p),
      })),
      {
        label: 'AUM ₹Cr',
        align: 'right',
        html: true,
        get: (c) => {
          const total = c.funds.reduce((n, f) => n + (typeof f.aumCr === 'number' ? f.aumCr : 0), 0);
          const missing = c.funds.filter((f) => typeof f.aumCr !== 'number').length;
          if (!total) return dash('No scheme in this category carries an AUM figure');
          const title = missing
            ? `Sum of the ${c.funds.length - missing} schemes that carry one. ${missing} do not, so this is a floor rather than the category's total.`
            : `Sum of all ${c.funds.length} schemes, as at ${c.aumLabel || 'the workbook’s stated month'}.`;
          return `<span class="tabular-nums text-slate-700" title="${escapeHtml(title)}">${escapeHtml(formatNumber(total))}${missing ? '<span class="text-slate-400">+</span>' : ''}</span>`;
        },
        // A category with no AUM at all sorts last rather than as the smallest fund house in India.
        sortValue: (c) => c.funds.reduce((n, f) => n + (typeof f.aumCr === 'number' ? f.aumCr : 0), 0) || null,
      },
    ],
    filters: [
      {
        label: 'All benchmarks',
        options: [
          { value: 'all', label: 'All benchmarks' },
          { value: 'published', label: 'Index published by the workbook' },
          { value: 'none', label: 'Comparator is a stated fallback' },
        ],
        match: (c, v) => (v === 'all' ? true : v === 'published' ? c.benchmarks.length > 0 : c.benchmarks.length === 0),
      },
    ],
    onRowClick: (c) => {
      openCategory = c.id;
      schemeView = null;
      const paint = () => renderCategoryPerformance(ctxRef);
      paint();
    },
    countNoun: 'categories',
    exportName: `glow-mf-categories-${todayStamp()}`,
    // THE ROWS THE READER IS LOOKING AT, not the whole file. The toolbar beside the button says
    // "N of M categories shown"; a workbook carrying M would contradict it, and the kit hands the
    // visible set in precisely so it does not have to.
    onExport: (visible) => exportCategories(visible, m),
    emptyMessage: 'No category matches your filters.',
  });
}

/**
 * One cell of the category table: the category's published median over the benchmark's own return
 * for the same period, shaded by the gap between them.
 *
 * BOTH FIGURES ARE ON THE FACE OF THE CELL, not one behind a toggle. The whole question this view
 * answers is "did the middle of this category beat its index", and an answer that shows only one
 * side of it makes the reader hold the other in their head.
 */
function categoryCell(cat, period) {
  const med = weekly.medianOf(cat, period);
  const { benchmark } = weekly.benchmarkFor(cat, chosenBenchmark[cat.id]);
  const bm = weekly.benchmarkReturn(benchmark, period);
  const gap = weekly.relativeTo(med, bm);

  // The derived gap on its own, for a reader comparing categories by excess rather than by level.
  // `vs-median` is not offered at this level (see CATEGORY_MEASURES), so there is one branch and no
  // literal zero anywhere in it — a null gap is an em dash with a reason, never 0.00.
  if (measureFor('category') === 'vs-benchmark') {
    if (gap == null) return dash(gapAbsentReason(med, bm, period, benchmark));
    const heat = gapHeat(gap, period);
    return `<span class="inline-block w-full rounded px-1 py-0.5 text-right tabular-nums ${heat.className}" title="${escapeHtml(`${heat.title}. Category median ${fmtPct(med)} against ${benchmark.name} ${fmtPct(bm)}.`)}">${escapeHtml(fmtPp(gap))}</span>`;
  }

  if (med == null && bm == null) return dash(`Neither the category median nor its index reports ${period}`);
  const heat = gap == null ? { className: '', title: null } : gapHeat(gap, period);
  const title = gap == null ? gapAbsentReason(med, bm, period, benchmark) : `${heat.title}. Median ${fmtPct(med)} against ${benchmark?.name} ${fmtPct(bm)}.`;
  return `
    <span class="inline-block w-full rounded px-1 py-0.5 text-right ${heat.className}" title="${escapeHtml(title)}">
      <span class="block tabular-nums font-semibold ${toneOf(med)}">${escapeHtml(fmtPct(med))}</span>
      <span class="block text-[10px] tabular-nums text-slate-400" title="Benchmark">${escapeHtml(bm == null ? '—' : fmtPct(bm))}</span>
    </span>`;
}

function categoryValue(cat, period) {
  if (measureFor('category') === 'vs-benchmark') {
    const { benchmark } = weekly.benchmarkFor(cat, chosenBenchmark[cat.id]);
    return weekly.relativeTo(weekly.medianOf(cat, period), weekly.benchmarkReturn(benchmark, period));
  }
  return weekly.medianOf(cat, period);
}

/** Why a gap is absent — which side of it, in words, so an em dash is never just "missing". */
function gapAbsentReason(med, bm, period, benchmark) {
  if (!benchmark) return `The workbook publishes no index for this category, so there is nothing to compare ${period} against.`;
  if (med == null && bm == null) return `Neither the category median nor ${benchmark.name} reports ${period}.`;
  if (med == null) return `The workbook publishes no median for ${period} in this category.`;
  return `${benchmark.name} has no ${period} return in this workbook.`;
}

// ---- Level 2: the schemes inside one category ------------------------------------------------

function schemePanel(m, repaint) {
  const cat = weekly.category(openCategory);
  if (!cat) {
    openCategory = null;
    return comparisonPanel(m, repaint);
  }
  const { benchmark, reason, alternatives = [], chosen, paired } = weekly.benchmarkFor(cat, chosenBenchmark[cat.id]);
  const periods = m.periods;
  const table = schemeTable(cat, benchmark, m, periods);
  schemeView = table.view;

  const html = `
    ${sectionHead({
      title: `${cat.label} — every scheme`,
      description:
        `${cat.funds.length} scheme${cat.funds.length === 1 ? '' : 's'} in the workbook’s ${cat.sheet} sheet, each direct-plan growth. ` +
        `Every return is the workbook’s own; the reference row below carries the category’s published median and ${
          benchmark
            ? paired
              ? `the ${benchmark.name}`
              : `the ${benchmark.name} — a stated fallback from the workbook’s master index sheet, because it prints no index row under this one`
            : 'the fact that no index is published here'
        }.`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${asOfPill(m)}${scopeChip()}</div>`,
      controls: `${backControl(cat)}${measureControls('scheme')}`,
    })}
    ${referenceStrip(cat, benchmark, reason, alternatives, periods, chosen, paired)}
    ${table.html}
  `;

  return {
    html,
    wire(root) {
      const off = table.wire(root);
      if (off) disposers.push(off);
      const back = root.querySelector('[data-mf-back]');
      const onBack = () => {
        openCategory = null;
        schemeView = null;
        repaint();
      };
      back?.addEventListener('click', onBack);
      if (back) disposers.push(() => back.removeEventListener('click', onBack));
      wireMeasure(root, repaint);
      root.querySelectorAll('[data-mf-benchmark]').forEach((el) => {
        const on = () => {
          chosenBenchmark = { ...chosenBenchmark, [cat.id]: el.dataset.mfBenchmark };
          repaint();
        };
        el.addEventListener('click', on);
        disposers.push(() => el.removeEventListener('click', on));
      });
      // The master-sheet picker, for a category the workbook prints no index under. A <select>
      // rather than 36 chips: the same choice, at a width the head can hold.
      const pickSelect = root.querySelector('[data-mf-benchmark-select]');
      if (pickSelect) {
        const onPick = () => {
          chosenBenchmark = { ...chosenBenchmark, [cat.id]: pickSelect.value };
          repaint();
        };
        pickSelect.addEventListener('change', onPick);
        disposers.push(() => pickSelect.removeEventListener('change', onPick));
      }
      wireProvenance(root, m, 'scheme');
    },
  };
}

function schemeTable(cat, benchmark, m, periods) {
  // The peer set for each period, computed once per paint rather than once per cell: the heatmap
  // asks "where does this scheme sit among its category" for 624 x 8 cells, and rebuilding the
  // array inside the cell would be quadratic on the widest table here.
  const peers = Object.fromEntries(periods.map((p) => [p, cat.funds.map((f) => f.returns?.[p]).filter((v) => typeof v === 'number')]));

  return scoreTable({
    rows: cat.funds,
    key: (f) => f.id,
    watchKey: () => null,
    showWatchFilter: false,
    name: (f) => f.scheme,
    nameLabel: 'Scheme',
    sub: (f) => [f.house, factorsOf(f.scheme).map(factorLabel).join(' · ') || null, f.option !== 'unknown' ? cap(f.option) : null].filter(Boolean).join(' · '),
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 300,
    stickyHead: 'max(320px, calc(100vh - 420px))',
    searchable: (f) => `${f.scheme} ${f.house || ''} ${factorsOf(f.scheme).join(' ')}`,
    searchPlaceholder: 'Search scheme or fund house...',
    initialSort: { key: 'name', dir: 'asc' },
    initialView: schemeView,
    columns: [
      ...periods.map((p) => ({
        label: periodHeadFor(p, 'scheme'),
        align: 'right',
        html: true,
        get: (f) => schemeCell(f, cat, benchmark, p, peers[p]),
        sortValue: (f) => schemeValue(f, cat, benchmark, p),
      })),
      {
        label: 'AUM ₹Cr',
        align: 'right',
        html: true,
        get: (f) =>
          typeof f.aumCr === 'number'
            ? `<span class="tabular-nums text-slate-700" title="${escapeHtml(`As at ${cat.aumLabel || 'the workbook’s stated month'}, not the return date`)}">${escapeHtml(formatNumber(f.aumCr))}</span>`
            : dash('The workbook carries no AUM for this scheme'),
        sortValue: (f) => (typeof f.aumCr === 'number' ? f.aumCr : null),
      },
      {
        // ONLY THE DIRECT EXPENSE RATIO. Every return on this sheet is a direct-plan return, so the
        // regular figure beside it belonged to a scheme none of these rows describe — and this
        // dashboard now shows the direct plan on both sub-views, so a regular figure has nowhere it
        // could be read against.
        label: 'Expense direct',
        align: 'right',
        html: true,
        get: (f) => expenseCell(f.expense?.direct, 'direct'),
        sortValue: (f) => (typeof f.expense?.direct === 'number' ? f.expense.direct : null),
      },
    ],
    filters: [houseFilter(cat), strategyFilter(cat.funds, (f) => factorsOf(f.scheme))].filter(Boolean),
    countNoun: 'schemes',
    exportName: `glow-mf-${cat.id}-${todayStamp()}`,
    onExport: (visible) => exportSchemes(cat, benchmark, m, periods, visible),
    emptyMessage: 'No scheme matches your filters.',
  });
}

/**
 * One scheme's cell.
 *
 * In `return` mode it is the workbook's own figure, shaded by where the scheme sits among the
 * schemes in its OWN category over that same period — a count, not a model, and the same kind of
 * reading as the peer rank on the All Schemes view. In the two gap modes it is the derived
 * difference in percentage points, shaded by size.
 */
function schemeCell(fund, cat, benchmark, period, peers) {
  const measure = measureFor('scheme');
  const value = fund.returns?.[period];
  if (typeof value !== 'number') {
    return dash(`This scheme reports no ${period} return — it is younger than the period, or the workbook prints none. Not a zero.`);
  }

  if (measure === 'return') {
    const heat = peerHeat(value, peers, { period });
    const med = weekly.medianOf(cat, period);
    const bm = weekly.benchmarkReturn(benchmark, period);
    const parts = [heat.title];
    if (med != null) parts.push(`category median ${fmtPct(med)}`);
    parts.push(benchmark ? (bm == null ? `${benchmark.name} has no ${period} return` : `${benchmark.name} ${fmtPct(bm)}`) : 'no index published for this category');
    return `<span class="inline-block w-full rounded px-1 py-0.5 text-right tabular-nums font-semibold ${heat.className} ${toneOf(value)}" title="${escapeHtml(parts.filter(Boolean).join(' · '))}">${escapeHtml(fmtPct(value))}</span>`;
  }

  const ref = measure === 'vs-benchmark' ? weekly.benchmarkReturn(benchmark, period) : weekly.medianOf(cat, period);
  const gap = weekly.relativeTo(value, ref);
  if (gap == null) {
    return dash(
      measure === 'vs-benchmark'
        ? benchmark
          ? `${benchmark.name} has no ${period} return in this workbook, so there is nothing to measure this against.`
          : 'The workbook publishes no index for this category, so no benchmark gap can be shown.'
        : `The workbook publishes no ${period} median for this category.`,
    );
  }
  const heat = gapHeat(gap, period);
  const refLabel = measure === 'vs-benchmark' ? benchmark.name : 'the category median';
  return `<span class="inline-block w-full rounded px-1 py-0.5 text-right tabular-nums font-semibold ${heat.className}" title="${escapeHtml(`${fmtPct(value)} against ${refLabel} ${fmtPct(ref)} — ${heat.title}`)}">${escapeHtml(fmtPp(gap))}</span>`;
}

function schemeValue(fund, cat, benchmark, period) {
  const measure = measureFor('scheme');
  const v = fund.returns?.[period];
  if (typeof v !== 'number') return null;
  if (measure === 'return') return v;
  const ref = measure === 'vs-benchmark' ? weekly.benchmarkReturn(benchmark, period) : weekly.medianOf(cat, period);
  return weekly.relativeTo(v, ref);
}

function expenseCell(v, which) {
  if (typeof v !== 'number') return dash(`The workbook carries no ${which}-plan expense ratio for this scheme`);
  return `<span class="tabular-nums text-slate-600" title="${escapeHtml(`The workbook’s quoted ${which}-plan expense ratio. The returns in this row are the direct plan’s.`)}">${escapeHtml(v.toFixed(2))}%</span>`;
}

/**
 * The strategy the scheme's own name states, as a filter for a table that has no chip row of its
 * own. Same reading as `strategyControls()` and the same caveat: read from the name, never a
 * classification either source publishes.
 */
function strategyFilter(rows, factorsOfRow) {
  const present = FACTORS.map((f) => ({ ...f, count: rows.filter((r) => factorsOfRow(r).includes(f.id)).length })).filter((f) => f.count > 0);
  if (present.length < 2) return null;
  return {
    label: 'Any strategy',
    options: [
      { value: 'all', label: 'Any strategy in the name' },
      ...present.map((f) => ({ value: f.id, label: `${f.label} · ${f.count}` })),
    ],
    match: (r, v) => factorsOfRow(r).includes(v),
  };
}

function houseFilter(cat) {
  const houses = [...new Set(cat.funds.map((f) => f.house).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (houses.length < 2) return null;
  return {
    label: 'All fund houses',
    options: [{ value: 'all', label: 'All fund houses' }, ...houses.map((h) => ({ value: h, label: h }))],
    match: (f, v) => v === 'all' || f.house === v,
  };
}

/**
 * The reference row above the scheme table: the category's published median, the index the workbook
 * pairs it with, and the gap between them — the same three facts the comparison view shows, for the
 * one category being read.
 */
function referenceStrip(cat, benchmark, reason, alternatives, periods, chosen = false, paired = true) {
  const row = (label, sub, get, cls = '') => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-2">
        <div class="text-xs font-semibold text-slate-700">${escapeHtml(label)}</div>
        ${sub ? `<div class="text-[10px] text-slate-400">${escapeHtml(sub)}</div>` : ''}
      </td>
      ${periods.map((p) => `<td class="px-2 py-2 text-right tabular-nums text-xs ${cls}">${get(p)}</td>`).join('')}
    </tr>`;

  return `
    <div class="mb-4 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-100" data-mf-reference>
      <table class="w-full min-w-[720px]">
        <thead>
          <tr class="bg-slate-50">
            <th scope="col" class="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500">Category reference</th>
            ${periods.map((p) => `<th scope="col" class="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(periodLabel(p))}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${row('Category median', 'Published by the workbook — reproduced, not recomputed', (p) => {
            const v = weekly.medianOf(cat, p);
            return v == null ? dash(`No median published for ${p}`) : `<span class="font-semibold ${toneOf(v)}">${escapeHtml(fmtPct(v))}</span>`;
          })}
          ${
            benchmark
              ? row(paired ? benchmark.name : `${benchmark.name} — not the workbook’s pairing`, reason, (p) => {
                  const v = weekly.benchmarkReturn(benchmark, p);
                  return v == null ? dash(`${benchmark.name} has no ${p} return in this workbook`) : `<span class="font-semibold ${toneOf(v)}">${escapeHtml(fmtPct(v))}</span>`;
                })
              : `<tr class="border-t border-slate-100"><td colspan="${periods.length + 1}" class="px-3 py-3 text-xs text-slate-500">${escapeHtml(reason)}</td></tr>`
          }
          ${
            benchmark
              ? row('Median − benchmark', 'Derived here · percentage points', (p) => {
                  const g = weekly.relativeTo(weekly.medianOf(cat, p), weekly.benchmarkReturn(benchmark, p));
                  if (g == null) return dash('One side of this comparison is absent, so no gap is shown');
                  const heat = gapHeat(g, p);
                  return `<span class="inline-block rounded px-1.5 py-0.5 font-semibold ${heat.className}" title="${escapeHtml(heat.title)}">${escapeHtml(fmtPp(g))}</span>`;
                })
              : ''
          }
        </tbody>
      </table>
      ${benchmarkPicker(cat, benchmark, alternatives, chosen, paired)}
    </div>`;
}

/**
 * WHICH INDEX THIS CATEGORY IS HELD AGAINST, and who chose it.
 *
 * For a category the workbook pairs with indices, the options are exactly those and the picker says
 * whose choice is showing — the workbook's default or the reader's. For the one sheet the workbook
 * prints NO index row under, the options are the workbook's own 36-index master sheet, offered as a
 * <select> because thirty-six chips is not a control, and every label around it says the pairing is
 * not the workbook's. Nothing outside this workbook is ever offered.
 */
function benchmarkPicker(cat, benchmark, alternatives, chosen, paired) {
  if (!benchmark) return '';
  if (paired) {
    if (!alternatives.length) return '';
    return `<div class="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500" data-mf-bench-picker>
        <span class="font-semibold text-slate-600">Compare against:</span>
        ${cat.benchmarks
          .map((b) => chipBtn(`data-mf-benchmark="${escapeHtml(b.id)}"`, b.name + (b.tri ? '' : ' · price'), b === benchmark,
            b.tri ? 'A Total Return Index — dividends reinvested, like a NAV.' : 'A price index. It excludes dividends, so a gap measured against it is not on the same scale as one measured against a Total Return Index.'))
          .join('')}
        <span class="ml-1">${escapeHtml(chosen ? 'Your choice, from the indices this workbook prints under this category.' : 'The workbook’s own default. Every option here is an index it prints under this category — none is borrowed from the master sheet.')}</span>
      </div>`;
  }
  const options = weekly.benchmarkOptions(cat);
  return `<div class="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500" data-mf-bench-picker>
      <span class="font-semibold text-slate-600">Compare against:</span>
      <select data-mf-benchmark-select
        class="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        ${options.map((b) => `<option value="${escapeHtml(b.id)}"${b === benchmark ? ' selected' : ''}>${escapeHtml(b.name)}${b.tri ? '' : ' · price'}</option>`).join('')}
      </select>
      <span class="ml-1">${escapeHtml(
        `The workbook prints no index row under this sheet, so ${chosen ? 'this is your choice' : 'this is a stated fallback'} from its own master sheet of ${options.length} indices — not a pairing the workbook makes.`,
      )}</span>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// All Schemes — the daily AmfiBeas feed, unchanged, under the hierarchy filter
// ---------------------------------------------------------------------------------------

function renderAllSchemes(ctx) {
  releaseDisposers();
  const token = renderToken;

  const paint = () => {
    if (token !== renderToken || ctxRef?.subview !== 'all-schemes') return;
    releaseDisposers();
    const m = fundReturns.meta();
    const tree = liveTree();
    // The hierarchy and strategy narrow the feed before the table applies its search predicate.
    // The result count and export read that same final set.
    const rows = m && !m.reason ? liveScoped(fundReturns.all()) : null;
    // Count alternatives within the chosen classification and search, BEFORE applying strategy.
    // Applying strategy here would hide other valid choices; using the whole feed invented matches
    // under Debt. Refresh only this strip as text changes so the search input retains focus.
    const strategyBase = liveScoped(fundReturns.all(), { includeStrategy: false });
    const updateStrategyCounts = (view, matchesSearch) => {
      if (token !== renderToken) return;
      const mount = ctx.root.querySelector('[data-mf-strategy-mount]');
      if (mount) mount.innerHTML = strategyControls(strategyBase.filter((f) => matchesSearch(f, view.q)), (f) => f.factors);
    };
    const panel = renderFundReturns(ctx, {
      disposers,
      repaint: paint,
      rows,
      // THE THIRD LEVEL IS OFFERED HERE AND NOT ON CATEGORY PERFORMANCE, because there the third
      // level IS the row: a chip per category above a table of categories is the same control
      // twice. Here the categories are invisible until something names them, which is how "ETFs"
      // and "Index" — words the source itself uses — had no control at all.
      headHtml: `${hierarchyControls(null, tree, { coverage: false, depth: 3 })}<div data-mf-strategy-mount></div>${measureControls('live')}`,
      view: allSchemesView,
      onView: (v, matchesSearch) => { allSchemesView = v; updateStrategyCounts(v, matchesSearch); },
      onSearchChange: updateStrategyCounts,
      measure: measureFor('live'),
      extraProvenance: twoFeedsProvenance(m),
    });
    ctx.root.innerHTML = panel.html;
    panel.wire(ctx.root);
    wireHierarchy(ctx.root, paint);
    wireStrategy(ctx.root, paint);
    wireMeasure(ctx.root, paint);
  };

  if (fundReturns.isLoaded()) {
    paint();
    return;
  }
  ctx.root.innerHTML = loadingHtml('Reading the daily scheme feed…');
  fundReturns.load().then(() => {
    if (token === renderToken) paint();
  });
}

function liveTree() {
  return buildTree(fundReturns.all(), (f) => classifyLive(f.classification));
}

/**
 * The live feed under the chips above it — asset class, group, category and strategy. Strategy
 * counts reuse the hierarchy without their own filter, so they describe the available alternatives.
 */
function liveScoped(all, { includeStrategy = true } = {}) {
  const chosenStrategy = includeStrategy ? strategy : null;
  if (!assetClass && !group && !categoryId && !chosenStrategy) return all;
  return all.filter((f) => {
    const t = classifyLive(f.classification);
    return (!assetClass || t.assetClass === assetClass)
      && (!group || t.group === group)
      && (!categoryId || t.categoryId === categoryId)
      && (!chosenStrategy || f.factors?.includes(chosenStrategy));
  });
}

/**
 * THE ONE THING THE FEED'S OWN PILL CANNOT SAY: that this is a different snapshot from the other
 * sub-view, taken on a different day, and that nothing crosses between them.
 *
 * It used to be a full-width paragraph above the table. It is the same sentences, now inside the
 * provenance modal the Live pill opens — the resolution this codebase takes whenever a caveat
 * competes with the content it qualifies. The claim is not deleted, it is one click away from every
 * screen, and the pill on the face of the page still carries the date.
 */
function twoFeedsProvenance(m) {
  // A FAILED LIVE READ GETS NO TWO-DATES PARAGRAPH. Printing "as on 14 Aug" beside a panel that has
  // no figures at all puts the workbook's date on a screen the workbook is not on.
  if (!m || m.reason) return '';
  const live = m.asOfDate;
  const bookDate = weekly.meta()?.asOf || null;
  return `
    <div class="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-100" data-mf-two-feeds>
      <span class="font-semibold">A different snapshot from Category Performance.</span>
      This is the daily AmfiBeas feed${live ? `, as on <span class="font-semibold">${escapeHtml(live)}</span>` : ''} — every scheme ranked inside its own cohort, benchmarked against its own category median on that same date.
      Category Performance reads the weekly workbook${bookDate ? `, as on <span class="font-semibold">${escapeHtml(bookDate)}</span>` : ''}, which is the only one of the two that publishes an index return.
      ${live && bookDate && live !== bookDate ? 'They are dated different days, so no figure from one is compared with, summed with, or used as a benchmark for the other.' : 'Neither figure is combined with the other.'}
      This feed carries no index of its own; where an index benchmark is needed, Category Performance is where it lives.
    </div>`;
}

// ---------------------------------------------------------------------------------------
// The hierarchy control
// ---------------------------------------------------------------------------------------

/**
 * Asset class, then group. Two rows of chips rather than a tree widget: the whole taxonomy is three
 * levels deep and the third level IS the table, so a collapsible tree would be a second navigation
 * for a list the reader can already see.
 *
 * `All` is null, not "every chip pressed" — the same distinction `scopeTickers()` draws between a
 * null and a full Set, for the same reason: the two look identical until a category appears or
 * disappears. The counts on a chip describe the TAXONOMY, so they do not move when you press one.
 */
function hierarchyControls(all, tree = weekly.tree(all), { coverage = true, depth = 2 } = {}) {
  const classChips = tree
    .map((n) => chipBtn(`data-mf-class="${escapeHtml(n.assetClass)}"`, `${n.assetClass} · ${n.count}`, assetClass === n.assetClass))
    .join('');
  const active = tree.find((n) => n.assetClass === assetClass);
  const groupChips = active
    ? `<span class="mx-1 h-4 w-px bg-slate-200"></span>${chipBtn('data-mf-group=""', 'All groups', !group)}${active.groups
        .map((g) => chipBtn(`data-mf-group="${escapeHtml(g.group)}"`, `${g.group} · ${g.count}`, group === g.group))
        .join('')}`
    : '';
  // THE THIRD LEVEL IS THE SOURCE'S OWN CATEGORY, and until it was offered a reader had no way to
  // ask for "ETFs" or "Index" — words the source itself prints on 645 equity schemes. Only shown
  // where the third level is not already the row (see the call site on All Schemes).
  const activeGroup = depth >= 3 && active ? active.groups.find((g) => g.group === group) : null;
  const categoryChips = activeGroup
    ? `<span class="mx-1 h-4 w-px bg-slate-200"></span>${chipBtn('data-mf-category=""', 'All categories', !categoryId)}${activeGroup.categories
        .map((c) => chipBtn(`data-mf-category="${escapeHtml(c.id)}"`, `${c.label} · ${c.items.length}`, categoryId === c.id))
        .join('')}`
    : '';
  // `coverage: false` on All Schemes. The note names what the WEEKLY WORKBOOK does not publish;
  // the live feed carries debt, commodities and fund-of-funds, so printing it there would tell the
  // reader a feed does not cover data it is displaying at that moment.
  const uncovered = coverage ? (weekly.meta()?.coverage || []).filter((c) => !c.covered) : [];
  return `
    <div class="flex flex-wrap items-center gap-1.5" data-mf-hierarchy>
      <span class="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Classification</span>
      ${chipBtn('data-mf-class=""', 'All', !assetClass)}
      ${classChips}
      ${groupChips}
      ${categoryChips}
      ${
        uncovered.length
          ? `<span class="ml-1 cursor-help text-[11px] text-slate-400" title="${escapeHtml(uncovered.map((c) => c.note).join(' '))}">${escapeHtml(uncovered.map((c) => c.label).join(', '))} not covered here</span>`
          : ''
      }
    </div>`;
}

/**
 * THE STRATEGY ROW — momentum, quality, value, low volatility, alpha, equal weight, dividend yield.
 *
 * NEITHER SOURCE CLASSIFIES A MOMENTUM FUND AS ONE. AmfiBeas file all 645 passive equity schemes as
 * `Index`, `Index Funds` or `ETFs` and stop there; the workbook files all 70 of them as one Smart
 * Beta sheet. So the question "which of these are the momentum funds" had no control on either
 * sub-view and could only be answered by typing the word into a search box and hoping.
 *
 * IT READS THE SCHEME'S OWN NAME, WHICH IS WHERE THE TRACKED INDEX IS STATED, and the row says so
 * on its own face. It is a SEPARATE axis from the classification chips beside it: a momentum fund's
 * classification is still `Equity : Index`, nothing here moves it, and a scheme matching no pattern
 * is simply not in a strategy rather than placed in the nearest one. Counts follow the classification
 * and search filters, excluding the strategy itself so other valid choices remain available.
 */
function strategyControls(all, factorsOf) {
  const present = FACTORS.map((f) => ({ ...f, count: all.filter((r) => factorsOf(r)?.includes(f.id)).length }))
    .filter((f) => f.count > 0 || f.id === strategy);
  return `
    <div class="flex flex-wrap items-center gap-1.5" data-mf-strategies>
      <span class="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400" title="Read from each scheme’s own name, where the tracked index is stated. Neither source publishes this as a classification.">Strategy in the name</span>
      ${chipBtn('data-mf-strategy=""', 'Any', !strategy)}
      ${present.map((f) => chipBtn(`data-mf-strategy="${escapeHtml(f.id)}"`, `${f.label} · ${f.count}`, strategy === f.id,
        `${f.count} schemes match the current classification and search filters and state ${f.label.toLowerCase()} in their own name.`)).join('')}
      ${present.some((f) => f.count > 0) ? '' : '<span class="text-[11px] text-slate-400">No named strategies match these filters.</span>'}
    </div>`;
}

function wireHierarchy(root, repaint) {
  root.querySelectorAll('[data-mf-class]').forEach((el) => {
    const on = () => {
      assetClass = el.dataset.mfClass || null;
      group = null;
      categoryId = null;
      openCategory = null;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
  root.querySelectorAll('[data-mf-group]').forEach((el) => {
    const on = () => {
      group = el.dataset.mfGroup || null;
      categoryId = null;
      openCategory = null;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
  root.querySelectorAll('[data-mf-category]').forEach((el) => {
    const on = () => {
      categoryId = el.dataset.mfCategory || null;
      openCategory = null;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
}

function wireStrategy(root, repaint) {
  // The buttons are replaced as the search changes; one listener on their stable mount survives it.
  const mount = root.querySelector('[data-mf-strategy-mount]');
  if (!mount) return;
  const on = (event) => {
    const button = event.target.closest('[data-mf-strategy]');
    if (!button || !mount.contains(button)) return;
    strategy = button.dataset.mfStrategy || null;
    repaint();
  };
  mount.addEventListener('click', on);
  disposers.push(() => mount.removeEventListener('click', on));
}

function measureControls(level) {
  const active = measureFor(level);
  return `
    <div class="flex flex-wrap items-center gap-1.5" data-mf-measures>
      <span class="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Show</span>
      ${measuresFor(level).map(([id, label, title]) => chipBtn(`data-mf-measure="${id}"`, label, active === id, title)).join('')}
    </div>`;
}

function wireMeasure(root, repaint) {
  root.querySelectorAll('[data-mf-measure]').forEach((el) => {
    const on = () => {
      measure = el.dataset.mfMeasure;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
}

function backControl(cat) {
  return `
    <button type="button" data-mf-back
      class="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50">
      ← All categories<span class="text-slate-400">· leaving ${escapeHtml(cat.label)}</span>
    </button>`;
}

// ---------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------

const chipBtn = (attrs, label, active = false, title = '') =>
  `<button type="button" ${attrs} class="rounded-md px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${
    active ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
  }"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;

/**
 * The as-on pill. It carries the WORKBOOK'S OWN DATE on its face, not a relative age and not the
 * import time — those are two different facts and the modal keeps them apart. A weekly snapshot is
 * not stale at six days old, so nothing here turns amber on a clock; what a reader needs to know is
 * which day the figures are, and that is printed.
 */
function asOfPill(m) {
  return `<button type="button" data-mf-info
    class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50"
    title="Where these figures come from">
    <span class="h-1.5 w-1.5 rounded-full bg-slate-400"></span>Weekly workbook · as on ${escapeHtml(m.asOf || 'unknown')}
  </button>`;
}

const scopeChip = () =>
  `<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200"
    title="These are mutual-fund schemes, not companies, so the Portfolio / Watchlist / Universe toggle narrows nothing here.">Schemes · scope does not apply</span>`;

/**
 * What this view covers and what it does not — stated, never left to be read off an absence.
 *
 * A missing asset class and a category with no index are the two gaps here, and both are the kind
 * that read as a broken fetch when they are silent.
 */
/**
 * WHAT THIS VIEW COVERS AND WHAT IT DOES NOT — stated, never left to be read off an absence.
 *
 * IT LIVES BEHIND THE AS-ON PILL RATHER THAN ABOVE THE TABLE. Three blocks used to close and open
 * this view — a coverage paragraph, the shade legend and a five-sentence derivation note — and
 * between them they were the tallest thing on a screen whose point is the table. That is the
 * resolution this codebase has taken four times now (the Earnings Hub ribbon, Portfolio's four-line
 * provenance block, the market-news freshness card, the con-call schedule chips): move the
 * explanation behind a control that still states the claim, and never delete the claim. Every
 * sentence below is the one that was on the page, and the pill is one click away from every screen.
 */
function coverageSentences(m, shown = weekly.categories()) {
  const uncovered = (m.coverage || []).filter((c) => !c.covered).map((c) => c.label);
  const noBench = weekly.unpairedCategories(shown).map((c) => c.label);
  const total = weekly.categories().length;
  const parts = [
    `${shown.length}${shown.length === total ? '' : ` of ${total}`} categories, ${formatNumber(shown.reduce((n, c) => n + c.funds.length, 0))} schemes.`,
  ];
  if (uncovered.length) parts.push(`This workbook publishes no ${uncovered.join(', ').toLowerCase()} sheet, so ${uncovered.length === 1 ? 'that asset class is' : 'those asset classes are'} absent here rather than empty — the daily feed on All Schemes does carry them, on its own date.`);
  if (noBench.length) parts.push(`${noBench.join(', ')} ${noBench.length === 1 ? 'carries' : 'carry'} no index row in the workbook, so the index shown against ${noBench.length === 1 ? 'it' : 'them'} is a stated fallback from the workbook’s own master sheet and is labelled as not the workbook’s pairing.`);
  // A PRICE INDEX AND A TOTAL RETURN INDEX ARE NOT ON ONE SCALE, and their gaps share one sortable
  // column. Roughly a point a year separates them — the width of a shade step — so the categories
  // measured on the narrower basis are named rather than left to be discovered from a tooltip.
  const priceBasis = weekly.priceBasisCategories(shown).map((c) => c.label);
  if (priceBasis.length) parts.push(`${priceBasis.join(', ')} ${priceBasis.length === 1 ? 'is' : 'are'} compared against a price index rather than a total-return one, because the workbook prints no TRI under ${priceBasis.length === 1 ? 'that sheet' : 'those sheets'} — a price index excludes dividends, so ${priceBasis.length === 1 ? 'that gap is' : 'those gaps are'} not on the same scale as the rest of the column.`);
  return parts;
}

function derivationSentences(m) {
  return [
    `The returns, the medians and the index figures are the workbook’s — reproduced unchanged, as on ${m.asOf || 'its stated date'}.`,
    '3Y and 5Y are annualised; the shorter windows are simple point-to-point returns, and Since inception spans a different length for every scheme, so it is not comparable across rows.',
    'A cell reading — means the source publishes no figure for that period, a scheme younger than the window or an index the workbook does not quote that far. Never a zero.',
    'Exactly two things are derived here: the gap, in percentage points, and the shade, explained below.',
    `AUM is as at ${weekly.categories()[0]?.aumLabel || 'the workbook’s stated month'}, which is not the return date.`,
  ];
}

/** The shade legend, for the provenance modal. `data-mf-legend` follows it there. */
function heatLegend(legend) {
  return `
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-100" data-mf-legend>
      <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(legend.title)}</span>
      <div class="flex flex-wrap items-center gap-2">
        ${legend.steps
          .map((s) => `<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-600"><span class="inline-block h-3.5 w-6 rounded ${s.className}"></span>${escapeHtml(s.label)}</span>`)
          .join('')}
      </div>
      <p class="w-full text-[11px] leading-relaxed text-slate-500">${escapeHtml(legend.body)}</p>
    </div>`;
}

function wireProvenance(root, m, level = 'category') {
  const btn = root.querySelector('[data-mf-info]');
  if (!btn) return;
  const on = () => openProvenance(m, level);
  btn.addEventListener('click', on);
  disposers.push(() => btn.removeEventListener('click', on));
}

function openProvenance(m, level = 'category') {
  const cats = weekly.categories();
  const noBench = weekly.unpairedCategories(cats);
  const uncovered = (m.coverage || []).filter((c) => !c.covered);
  const shown = scopedCategories();
  openModal(
    `
    <div class="p-6">
      <h3 class="font-display text-lg font-bold text-slate-900">Where these figures come from</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">${escapeHtml(coverageSentences(m, shown).join(' '))}</p>
      ${heatLegend(level === 'scheme' && measureFor('scheme') === 'return' ? HEAT_LEGEND.peer : HEAT_LEGEND.gap)}
      <dl class="mt-4 space-y-3 text-sm text-slate-600">
        <div><dt class="font-semibold text-slate-800">Source</dt>
          <dd>${escapeHtml(m.source || 'Weekly mutual fund performance workbook')} — a weekly point-to-point performance sheet, one tab per category, imported by <code class="rounded bg-slate-100 px-1 text-xs">scripts/import-mf-weekly.mjs</code> into <code class="rounded bg-slate-100 px-1 text-xs">public/data/mf-weekly.json</code>.</dd></div>
        <div><dt class="font-semibold text-slate-800">As on</dt>
          <dd><span class="font-semibold text-slate-700">${escapeHtml(m.asOf || 'unknown')}</span> — the date the workbook itself states, read from its own text, and the only date that describes these figures. The title row also carries a number the sheets do not explain; it decodes to neither this date nor any other the workbook uses, so it travels with the data as <code class="rounded bg-slate-100 px-1 text-xs">serial</code> and is never interpreted.</dd></div>
        <div><dt class="font-semibold text-slate-800">What it covers</dt>
          <dd>${escapeHtml(String(m.categoryCount))} categories, ${escapeHtml(formatNumber(m.fundCount))} direct-plan growth schemes, and a master sheet of ${escapeHtml(String(m.benchmarkCount))} indices.${
            uncovered.length ? ` ${escapeHtml(uncovered.map((c) => c.note).join(' '))}` : ''
          }</dd></div>
        <div><dt class="font-semibold text-slate-800">Whose numbers these are</dt>
          <dd><strong>The returns, the category medians and the index returns are the workbook’s</strong>, reproduced unchanged — this view adds no scoring and no ranking of its own. The import recomputes every published median from the scheme rows it parsed purely as a <em>parse check</em> and refuses to write the file when one disagrees${
            m.medianCheck ? `; on this file ${escapeHtml(String(m.medianCheck.reconciled))} of ${escapeHtml(String(m.medianCheck.checked))} reconcile` : ''
          }. The number that ships is always the published one.</dd></div>
        <div><dt class="font-semibold text-slate-800">What is derived</dt>
          <dd>Two things. The <strong>gap</strong> — a return minus its category median or its benchmark, in percentage <em>points</em>, shown only where both sides exist. And the <strong>shade</strong>: in Return mode a scheme's cell is shaded by where it sits among the schemes in its own category over that period, and a category's cell by the size of its gap to its own index.</dd></div>
        <div><dt class="font-semibold text-slate-800">Which index a category is compared with</dt>
          <dd>The one the workbook prints beneath that category. Where it prints more than one, the Total Return Index is used, because a fund's NAV carries reinvested dividends and a TRI is the like-for-like comparator; the others stay visible on the category page and in the export.${
            noBench.length
              ? ` <strong>${escapeHtml(noBench.map((c) => c.label).join(', '))}</strong> ${noBench.length === 1 ? 'has' : 'have'} <strong>no index row at all</strong>. A return with nothing beside it answers nothing, so ${noBench.length === 1 ? 'it is' : 'they are'} shown against <strong>Nifty 500 TRI</strong> — the index the workbook itself prints first under every sectoral and thematic sheet — drawn from the workbook's own master sheet and <strong>labelled everywhere as a stated fallback, not the workbook's pairing</strong>: on the benchmark cell, in the reference row, in the picker and in row 1 of the export. Nothing is imported from outside this workbook, and the reader can change it to any index on its master sheet.`
              : ''
          }</dd></div>
        <div><dt class="font-semibold text-slate-800">How to read a cell</dt>
          <dd>${escapeHtml(derivationSentences(m).join(' '))}</dd></div>
        <div><dt class="font-semibold text-slate-800">Not the same snapshot as All Schemes</dt>
          <dd>The other sub-view reads the daily AmfiBeas feed, which is a <strong>different date</strong> and a different universe, and whose benchmark is each scheme’s own <em>category</em> rather than an index. No figure crosses between the two: nothing from one is compared with, summed with, or used as a benchmark for the other.</dd></div>
        <div><dt class="font-semibold text-slate-800">Files</dt>
          <dd><code class="rounded bg-slate-100 px-1 text-xs">${escapeHtml(m.sourceFile || 'scripts/fixtures/mf-weekly.xlsx')}</code> · <code class="rounded bg-slate-100 px-1 text-xs">public/data/mf-weekly.json</code> · <code class="rounded bg-slate-100 px-1 text-xs">public/js/data/mf-weekly.js</code> · <code class="rounded bg-slate-100 px-1 text-xs">public/js/data/mf-taxonomy.js</code> · <code class="rounded bg-slate-100 px-1 text-xs">public/js/ui/mf-heatmap.js</code></dd></div>
      </dl>
    </div>`,
    { size: 'wide' },
  );
}

// ---------------------------------------------------------------------------------------
// Failure and loading
// ---------------------------------------------------------------------------------------

function weeklyFailure(m) {
  const reason = m?.reason || 'unreachable';
  const body =
    reason === 'shape'
      ? 'The committed snapshot is there but does not carry the categories this view expects. Re-run <code class="rounded bg-slate-100 px-1 text-xs">node scripts/import-mf-weekly.mjs</code> and commit the result.'
      : 'The committed snapshot <code class="rounded bg-slate-100 px-1 text-xs">public/data/mf-weekly.json</code> could not be read. It ships with the site, so this is a deployment that is missing the file rather than an upstream that is down — run <code class="rounded bg-slate-100 px-1 text-xs">node scripts/import-mf-weekly.mjs</code> and commit it.';
  return `
    <div class="fade-in rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-100" data-mf-failure data-reason="${escapeHtml(reason)}">
      <h3 class="font-display text-lg font-bold text-slate-900">The category workbook could not be read</h3>
      <p class="mt-2 max-w-2xl text-sm text-slate-500">${body}</p>
      <p class="mt-2 max-w-2xl text-xs text-slate-400">This is an empty screen, not an empty universe: no category is being reported as having no schemes.</p>
      <button type="button" data-mf-retry
        class="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">Try again</button>
    </div>`;
}

function wireRetry(root, retry) {
  const btn = root.querySelector('[data-mf-retry]');
  if (!btn) return;
  const on = () => retry();
  btn.addEventListener('click', on);
  disposers.push(() => btn.removeEventListener('click', on));
}

function loadingHtml(label) {
  return `
    <div class="fade-in space-y-3" data-mf-loading>
      <div class="h-8 w-72 animate-pulse rounded-lg bg-slate-100"></div>
      <div class="h-64 animate-pulse rounded-2xl bg-slate-100"></div>
      <p class="text-xs text-slate-400">${escapeHtml(label)}</p>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

// A WORKBOOK LEAVES THE PAGE WITHOUT ITS CHROME, so row 1 of every sheet carries the whole claim:
// whose the figures are, which day they are, what is derived, and what the shading meant.
function exportBanner(m) {
  return (
    `Weekly mutual fund performance workbook, as on ${m.asOf}. ` +
    `The returns, the category medians and the index returns are the workbook's own and are reproduced unchanged — this dashboard adds no scoring or ranking of its own. ` +
    `Any column headed "vs" is DERIVED here: a return minus its category median or its benchmark, in percentage POINTS, and blank wherever either side is absent. ` +
    `A blank return means the source publishes none for that period — a scheme younger than the window, or an index it does not quote that far — never a zero. ` +
    `3Y and 5Y are annualised; Since inception spans a different length for every scheme and is not comparable across rows. ` +
    `AUM is as at the workbook's own stated month, not the return date. ` +
    `EVERY RETURN IN THIS WORKBOOK IS A DIRECT-PLAN RETURN, and the expense ratio quoted beside it is the direct plan's. ` +
    `A "Strategy in name" column is read from the SCHEME'S OWN NAME, where the tracked index is stated — it is not a classification the workbook publishes and it changes no category. ` +
    `WHERE THE BENCHMARK COLUMN IS MARKED "not the workbook's pairing", the workbook prints NO index row under that sheet: the index shown is a stated fallback drawn from the workbook's own master index sheet, chosen here or by the reader, and the workbook makes no such pairing. ` +
    `This is NOT the same snapshot as the All Schemes view, which reads a daily feed on a different date and benchmarks each scheme against its own CATEGORY rather than an index; no figure here may be compared with one from there.`
  );
}

function exportCategories(cats, m) {
  const periods = m.periods;
  exportSheets({
    filename: `glow-mf-categories-${todayStamp()}`,
    banner: exportBanner(m),
    sheets: [
      {
        name: 'Categories',
        columns: [
          { header: 'Asset class', width: 16, get: (c) => c.assetClass },
          { header: 'Group', width: 20, get: (c) => c.group },
          { header: 'Category', width: 26, get: (c) => c.label },
          { header: 'Workbook sheet', width: 22, get: (c) => c.sheet },
          { header: 'Schemes', width: 10, get: (c) => c.funds.length },
          { header: 'Benchmark', width: 30, get: (c) => {
            const { benchmark, paired } = weekly.benchmarkFor(c, chosenBenchmark[c.id]);
            if (!benchmark) return 'none published';
            return paired ? benchmark.name : `${benchmark.name} (NOT the workbook's pairing — stated fallback from its master index sheet)`;
          } },
          ...periods.flatMap((p) => [
            { header: `Median ${p}`, width: 13, get: (c) => weekly.medianOf(c, p) },
            { header: `Benchmark ${p}`, width: 15, get: (c) => weekly.benchmarkReturn(weekly.benchmarkFor(c, chosenBenchmark[c.id]).benchmark, p) },
            { header: `Median vs benchmark ${p} (pp, derived)`, width: 30, get: (c) => weekly.relativeTo(weekly.medianOf(c, p), weekly.benchmarkReturn(weekly.benchmarkFor(c, chosenBenchmark[c.id]).benchmark, p)) },
          ]),
        ],
        rows: cats,
      },
      {
        name: 'Benchmark index',
        columns: [
          { header: 'Index', width: 40, get: (b) => b.name },
          { header: 'Total return index', width: 18, get: (b) => (b.tri ? 'yes' : 'no') },
          ...m.benchmarkPeriods.map((p) => ({ header: p, width: 12, get: (b) => b.returns?.[p] ?? null })),
        ],
        rows: weekly.benchmarkIndex(),
      },
    ],
  });
}

function exportSchemes(cat, benchmark, m, periods, visible) {
  const reference = [
    { scheme: 'CATEGORY MEDIAN (published by the workbook)', house: '', returns: cat.median.returns, aumCr: null, expense: {} },
    ...(benchmark
      ? [{
          scheme: cat.benchmarks.length
            ? `BENCHMARK — ${benchmark.name} (published by the workbook under this category)`
            : `BENCHMARK — ${benchmark.name} (STATED FALLBACK from the workbook's master index sheet — NOT its pairing for this category)`,
          house: '', returns: benchmark.returns, aumCr: null, expense: {},
        }]
      : []),
  ];
  exportSheets({
    filename: `glow-mf-${cat.id}-${todayStamp()}`,
    banner: `${exportBanner(m)} Category: ${cat.label} (${cat.sheet}). ${
      benchmark
        ? `Benchmark: ${benchmark.name}.${cat.benchmarks.length ? '' : " THE WORKBOOK PRINTS NO INDEX ROW UNDER THIS SHEET — this index is a stated fallback from the workbook's own master index sheet and is NOT a pairing the workbook makes."}`
        : 'The workbook prints no index row for this category and its master index sheet is empty, so no benchmark is stated.'
    }`,
    sheets: [
      {
        name: cat.label.slice(0, 28),
        columns: [
          { header: 'Scheme', width: 46, get: (f) => f.scheme },
          { header: 'Fund house', width: 22, get: (f) => f.house || '' },
          ...periods.map((p) => ({ header: p === 'SI' ? 'Since inception' : p, width: 13, get: (f) => f.returns?.[p] ?? null })),
          ...(benchmark ? periods.map((p) => ({ header: `vs benchmark ${p} (pp, derived)`, width: 24, get: (f) => weekly.relativeTo(f.returns?.[p], benchmark.returns?.[p]) })) : []),
          ...periods.map((p) => ({ header: `vs category median ${p} (pp, derived)`, width: 26, get: (f) => weekly.relativeTo(f.returns?.[p], cat.median.returns?.[p]) })),
          { header: 'AUM ₹Cr', width: 14, get: (f) => f.aumCr },
          { header: 'Expense direct %', width: 16, get: (f) => f.expense?.direct ?? null },
          { header: 'Strategy in name (read from the name)', width: 30, get: (f) => factorsOf(f.scheme).map(factorLabel).join(' · ') },
        ],
        rows: [...reference, ...(visible || cat.funds)],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

const periodLabel = (p) => (p === 'SI' ? 'Since inception' : weekly.ANNUALISED.has(p) ? `${p} p.a.` : p);
/**
 * The column heading, which CHANGES WITH THE MEASURE. In a gap mode it names the unit — a gap
 * between two percentages is measured in percentage POINTS, and "+2.64" under a heading reading
 * "3Y p.a." is this dashboard's arithmetic wearing the workbook's clothes. A screenshot travels
 * without the chip row that selected the mode, so the unit has to be in the table itself.
 */
const periodHeadFor = (p, level) => (measureFor(level) === 'return' ? periodLabel(p) : `${periodLabel(p)} pp`);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;
const fmtPct = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—');
const fmtPp = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}` : '—');
const toneOf = (v) => (typeof v !== 'number' ? 'text-slate-400' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-600');

/** Exposed for the verification suite, which asserts the two feeds never share a figure. */
export const _weeklyMeta = () => weekly.meta();
export const _liveMeta = () => fundReturns.meta();
void pendingPanel;
