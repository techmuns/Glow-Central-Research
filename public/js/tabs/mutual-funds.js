// tabs/mutual-funds.js — MUTUAL FUNDS: category performance against its benchmark, and every
// tracked scheme's daily return and peer rank. GLOW-OWNED.
//
//   Category Performance   the weekly workbook — every category's published median beside the index
//                          the workbook pairs it with, then a drill into that category's schemes
//   All Schemes            the daily AmfiBeas feed — ~3,400 schemes, each ranked in its own cohort
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
//   schemes         | ~620 curated direct plans     | ~3,400, every plan and option
//   category median | PUBLISHED by the workbook     | none — the payload has no median
//   benchmark       | PUBLISHED per category        | none — AMFI's NAV snapshot has none
//   peer rank       | none                          | published, within its own cohort
//
// So the two sub-views never share a row, a column, a total or a comparison. Putting the workbook's
// 14-August index return beside an AmfiBeas 2-September fund return would be a comparison nobody
// measured — the same error as dating a price move by the capture rather than the session
// (CLAUDE.md, "A close is a claim about a SESSION"). Each sub-view prints its own as-on date on its
// own face, and the tab says in words that they are different snapshots.
//
// THE MEDIANS, THE INDEX RETURNS AND THE PEER RANKS ARE ALL THEIRS. Reproduced, never recomputed —
// the con-call rule, applied to a third feed. Exactly two things here are derived, and both are
// labelled wherever they surface:
//
//   1. THE GAP, in percentage POINTS: a return minus its category median, or minus its benchmark.
//      Subtraction of two of their own percentages. Never shown where either side is absent.
//   2. THE SHADE. The figure in a cell is always the source's; only its background is added here,
//      and js/ui/mf-heatmap.js's legend states what it means on the same screen it appears on.
//
// THE HIERARCHY IS A READING AID OVER SOMEBODY ELSE'S CATEGORY, NOT A NEW CATEGORY. Both feeds
// publish a flat bucket — a sheet name, or an "Equity : Large Cap" string — and js/data/mf-taxonomy.js
// groups them into asset class -> group -> category for both. Nothing is renamed or merged, every
// scheme keeps the bucket its source put it in, and a bucket nothing anticipated is `Unclassified`
// and visible rather than folded into whichever group looked closest.
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
import { buildTree, classifyLive } from '../data/mf-taxonomy.js';

export const meta = {
  id: 'mutual-funds',
  title: 'Mutual Funds',
  subtitle:
    'Every mutual-fund category against the index it is benchmarked to, its published median, and each scheme inside it — plus every tracked scheme’s daily return and peer rank.',
  subviews: [
    { id: 'category-performance', label: 'Category Performance' },
    { id: 'all-schemes', label: 'All Schemes' },
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
// The reader's own benchmark choice, per category id. Only ever one of the indices the workbook
// prints under THAT category — never one borrowed from the master sheet.
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
const measuresFor = (level) => (level === 'category' ? CATEGORY_MEASURES : SCHEME_MEASURES);
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
    ${coverageNote(m, cats)}
    ${table.html}
    ${heatLegend(HEAT_LEGEND.gap)}
    ${derivationNote(m)}
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
          const { benchmark, reason } = weekly.benchmarkFor(c, chosenBenchmark[c.id]);
          // A CATEGORY THE WORKBOOK PUBLISHES NO INDEX FOR SAYS SO. Nothing is borrowed from the
          // master index sheet to fill the gap: pairing a category with an index the source did not
          // pair it with would be this dashboard's judgement wearing the workbook's clothes.
          if (!benchmark) {
            return `<span class="text-xs text-slate-400" title="${escapeHtml(reason)}">none published</span>`;
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
          { value: 'published', label: 'Has a published index' },
          { value: 'none', label: 'No index published' },
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
  const { benchmark, reason, alternatives = [], chosen } = weekly.benchmarkFor(cat, chosenBenchmark[cat.id]);
  const periods = m.periods;
  const table = schemeTable(cat, benchmark, m, periods);
  schemeView = table.view;

  const html = `
    ${sectionHead({
      title: `${cat.label} — every scheme`,
      description:
        `${cat.funds.length} scheme${cat.funds.length === 1 ? '' : 's'} in the workbook’s ${cat.sheet} sheet, each direct-plan growth. ` +
        `Every return is the workbook’s own; the reference row below carries the category’s published median and ${benchmark ? `the ${benchmark.name}` : 'the fact that no index is published here'}.`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${asOfPill(m)}${scopeChip()}</div>`,
      controls: `${backControl(cat)}${measureControls('scheme')}`,
    })}
    ${referenceStrip(cat, benchmark, reason, alternatives, periods, chosen)}
    ${table.html}
    ${heatLegend(measureFor('scheme') === 'return' ? HEAT_LEGEND.peer : HEAT_LEGEND.gap)}
    ${derivationNote(m)}
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
      wireProvenance(root, m);
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
    sub: (f) => [f.house, f.plan !== 'unknown' ? cap(f.plan) : null, f.option !== 'unknown' ? cap(f.option) : null].filter(Boolean).join(' · '),
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 300,
    stickyHead: 'max(320px, calc(100vh - 420px))',
    searchable: (f) => `${f.scheme} ${f.house || ''}`,
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
        label: 'Expense direct',
        align: 'right',
        html: true,
        get: (f) => expenseCell(f.expense?.direct, 'direct'),
        sortValue: (f) => (typeof f.expense?.direct === 'number' ? f.expense.direct : null),
      },
      {
        label: 'Expense regular',
        align: 'right',
        html: true,
        get: (f) => expenseCell(f.expense?.regular, 'regular'),
        sortValue: (f) => (typeof f.expense?.regular === 'number' ? f.expense.regular : null),
      },
    ],
    filters: houseFilter(cat),
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
function referenceStrip(cat, benchmark, reason, alternatives, periods, chosen = false) {
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
              ? row(benchmark.name, reason, (p) => {
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
      ${
        alternatives.length
          ? `<div class="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500" data-mf-bench-picker>
              <span class="font-semibold text-slate-600">Compare against:</span>
              ${cat.benchmarks
                .map((b) => chipBtn(`data-mf-benchmark="${escapeHtml(b.id)}"`, b.name + (b.tri ? '' : ' · price'), b === benchmark,
                  b.tri ? 'A Total Return Index — dividends reinvested, like a NAV.' : 'A price index. It excludes dividends, so a gap measured against it is not on the same scale as one measured against a Total Return Index.'))
                .join('')}
              <span class="ml-1">${escapeHtml(chosen ? 'Your choice, from the indices this workbook prints under this category.' : 'The workbook’s own default. Every option here is an index it prints under this category — none is borrowed from the master sheet.')}</span>
            </div>`
          : ''
      }
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
    // THE CHIPS NARROW THE FEED, they do not merely decorate it. One predicate, `liveScoped()`,
    // produces the rows AND the counts, so the head can never describe a wider set than the table
    // beneath it — the same rule `scopeFilter(ctx)` follows on Super Investors.
    const rows = m && !m.reason ? liveScoped(fundReturns.all()) : null;
    const panel = renderFundReturns(ctx, {
      disposers,
      repaint: paint,
      rows,
      headHtml: hierarchyControls(null, tree, { coverage: false }),
      view: allSchemesView,
      onView: (v) => { allSchemesView = v; },
    });
    ctx.root.innerHTML = `${allSchemesHead(m, rows)}${panel.html}`;
    panel.wire(ctx.root);
    wireHierarchy(ctx.root, paint);
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

/** The live feed under the same asset-class / group filter the chips show. One predicate, one truth. */
function liveScoped(all) {
  if (!assetClass && !group) return all;
  return all.filter((f) => {
    const t = classifyLive(f.classification);
    return (!assetClass || t.assetClass === assetClass) && (!group || t.group === group);
  });
}

/**
 * The head above the live feed's own panel. It exists to say ONE thing the feed's own pill cannot:
 * that this is a different snapshot from the one on the other sub-view, taken on a different day,
 * and that nothing crosses between them.
 */
function allSchemesHead(m, rows) {
  // A FAILED LIVE READ GETS NO TWO-DATES PARAGRAPH. Printing "as on 14 Aug" beside a panel that has
  // no figures at all puts the workbook's date on a screen the workbook is not on — the reader sees
  // one date and one empty table and has every reason to read the first as belonging to the second.
  // The failure panel below says what went wrong; this says nothing over it.
  if (!m || m.reason) return '';
  const live = m.asOfDate;
  const bookDate = weekly.meta()?.asOf || null;
  const narrowed = rows && rows.length !== fundReturns.all().length
    ? ` Showing <span class="font-semibold text-slate-600">${escapeHtml(formatNumber(rows.length))}</span> of ${escapeHtml(formatNumber(fundReturns.all().length))} schemes under the classification chosen above.`
    : '';
  return `
    <div class="mb-4 rounded-2xl bg-white px-4 py-3 text-xs leading-relaxed text-slate-500 shadow-sm ring-1 ring-slate-100" data-mf-two-feeds>
      <span class="font-semibold text-slate-600">A different snapshot from Category Performance.</span>
      This is the daily AmfiBeas feed${live ? `, as on <span class="font-semibold text-slate-600">${escapeHtml(live)}</span>` : ''} — every plan and option, each scheme ranked inside its own cohort.
      Category Performance reads the weekly workbook${bookDate ? `, as on <span class="font-semibold text-slate-600">${escapeHtml(bookDate)}</span>` : ''}, which is the only one of the two that publishes a category median or a benchmark.
      ${live && bookDate && live !== bookDate ? 'They are dated different days, so no figure from one is compared with, summed with, or used as a benchmark for the other.' : 'Neither figure is combined with the other.'}
      This feed carries no index and no median of its own; where a benchmark is needed, Category Performance is where it lives.${narrowed}
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
function hierarchyControls(all, tree = weekly.tree(all), { coverage = true } = {}) {
  const classChips = tree
    .map((n) => chipBtn(`data-mf-class="${escapeHtml(n.assetClass)}"`, `${n.assetClass} · ${n.count}`, assetClass === n.assetClass))
    .join('');
  const active = tree.find((n) => n.assetClass === assetClass);
  const groupChips = active
    ? `<span class="mx-1 h-4 w-px bg-slate-200"></span>${chipBtn('data-mf-group=""', 'All groups', !group)}${active.groups
        .map((g) => chipBtn(`data-mf-group="${escapeHtml(g.group)}"`, `${g.group} · ${g.count}`, group === g.group))
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
      ${
        uncovered.length
          ? `<span class="ml-1 cursor-help text-[11px] text-slate-400" title="${escapeHtml(uncovered.map((c) => c.note).join(' '))}">${escapeHtml(uncovered.map((c) => c.label).join(', '))} not covered here</span>`
          : ''
      }
    </div>`;
}

function wireHierarchy(root, repaint) {
  root.querySelectorAll('[data-mf-class]').forEach((el) => {
    const on = () => {
      assetClass = el.dataset.mfClass || null;
      group = null;
      openCategory = null;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
  root.querySelectorAll('[data-mf-group]').forEach((el) => {
    const on = () => {
      group = el.dataset.mfGroup || null;
      openCategory = null;
      repaint();
    };
    el.addEventListener('click', on);
    disposers.push(() => el.removeEventListener('click', on));
  });
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
function coverageNote(m, shown) {
  const uncovered = (m.coverage || []).filter((c) => !c.covered).map((c) => c.label);
  const noBench = shown.filter((c) => !c.benchmarks.length).map((c) => c.label);
  const total = weekly.categories().length;
  const parts = [
    `${shown.length}${shown.length === total ? '' : ` of ${total}`} categories, ${formatNumber(shown.reduce((n, c) => n + c.funds.length, 0))} schemes.`,
  ];
  if (uncovered.length) parts.push(`This workbook publishes no ${uncovered.join(', ').toLowerCase()} sheet, so ${uncovered.length === 1 ? 'that asset class is' : 'those asset classes are'} absent here rather than empty — the daily feed on All Schemes does carry them, on its own date.`);
  if (noBench.length) parts.push(`${noBench.join(', ')} ${noBench.length === 1 ? 'carries' : 'carry'} no index row in the workbook, so no benchmark is shown for ${noBench.length === 1 ? 'it' : 'them'} and none is substituted.`);
  // A PRICE INDEX AND A TOTAL RETURN INDEX ARE NOT ON ONE SCALE, and their gaps share one sortable
  // column. Roughly a point a year separates them — the width of a shade step — so the categories
  // measured on the narrower basis are named rather than left to be discovered from a tooltip.
  const priceBasis = weekly.priceBasisCategories(shown).map((c) => c.label);
  if (priceBasis.length) parts.push(`${priceBasis.join(', ')} ${priceBasis.length === 1 ? 'is' : 'are'} compared against a price index rather than a total-return one, because the workbook prints no TRI under ${priceBasis.length === 1 ? 'that sheet' : 'those sheets'} — a price index excludes dividends, so ${priceBasis.length === 1 ? 'that gap is' : 'those gaps are'} not on the same scale as the rest of the column.`);
  return `<p class="mb-3 text-xs leading-relaxed text-slate-500">${parts.map((p) => escapeHtml(p)).join(' ')}</p>`;
}

function derivationNote(m) {
  return `
    <p class="mt-3 rounded-2xl bg-white px-4 py-3 text-xs leading-relaxed text-slate-500 shadow-sm ring-1 ring-slate-100">
      <span class="font-semibold text-slate-600">The returns, the medians and the index figures are the workbook’s</span> — reproduced unchanged, as on ${escapeHtml(m.asOf || 'its stated date')}.
      <span class="font-semibold text-slate-600">3Y and 5Y are annualised</span>; the shorter windows are simple point-to-point returns, and <span class="font-semibold text-slate-600">Since inception</span> spans a different length for every scheme, so it is not comparable across rows.
      A cell reading <span class="font-mono">—</span> means the source publishes no figure for that period — a scheme younger than the window, or an index the workbook does not quote that far — <span class="font-semibold text-slate-600">never a zero</span>.
      Exactly two things are derived here: the <span class="font-semibold text-slate-600">gap</span>, in percentage points, and the <span class="font-semibold text-slate-600">shade</span>, explained in the legend above.
      AUM is as at ${escapeHtml(weekly.categories()[0]?.aumLabel || 'the workbook’s stated month')}, which is not the return date.
    </p>`;
}

function heatLegend(legend) {
  return `
    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-100" data-mf-legend>
      <span class="text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(legend.title)}</span>
      <div class="flex flex-wrap items-center gap-2">
        ${legend.steps
          .map((s) => `<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-600"><span class="inline-block h-3.5 w-6 rounded ${s.className}"></span>${escapeHtml(s.label)}</span>`)
          .join('')}
      </div>
      <p class="w-full text-[11px] leading-relaxed text-slate-500">${escapeHtml(legend.body)}</p>
    </div>`;
}

function wireProvenance(root, m) {
  const btn = root.querySelector('[data-mf-info]');
  if (!btn) return;
  const on = () => openProvenance(m);
  btn.addEventListener('click', on);
  disposers.push(() => btn.removeEventListener('click', on));
}

function openProvenance(m) {
  const cats = weekly.categories();
  const noBench = cats.filter((c) => !c.benchmarks.length);
  const uncovered = (m.coverage || []).filter((c) => !c.covered);
  openModal(
    `
    <div class="p-6">
      <h3 class="font-display text-lg font-bold text-slate-900">Where these figures come from</h3>
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
              ? ` <strong>${escapeHtml(noBench.map((c) => c.label).join(', '))}</strong> ${noBench.length === 1 ? 'has' : 'have'} no index row at all, so no benchmark is shown and <strong>none is substituted</strong> from the master sheet — pairing a category with an index the source did not pair it with would be this dashboard's judgement wearing the workbook's.`
              : ''
          }</dd></div>
        <div><dt class="font-semibold text-slate-800">Not the same snapshot as All Schemes</dt>
          <dd>The other sub-view reads the daily AmfiBeas feed, which is a different date and a different universe and carries no median or benchmark at all. No figure crosses between the two.</dd></div>
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
    `This is NOT the same snapshot as the All Schemes view, which reads a daily feed on a different date; no figure here may be compared with one from there.`
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
          { header: 'Benchmark', width: 30, get: (c) => weekly.benchmarkFor(c, chosenBenchmark[c.id]).benchmark?.name ?? 'none published' },
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
    ...(benchmark ? [{ scheme: `BENCHMARK — ${benchmark.name} (published by the workbook)`, house: '', returns: benchmark.returns, aumCr: null, expense: {} }] : []),
  ];
  exportSheets({
    filename: `glow-mf-${cat.id}-${todayStamp()}`,
    banner: `${exportBanner(m)} Category: ${cat.label} (${cat.sheet}). ${benchmark ? `Benchmark: ${benchmark.name}.` : 'The workbook prints no index row for this category, so no benchmark is stated and none is substituted.'}`,
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
          { header: 'Expense regular %', width: 17, get: (f) => f.expense?.regular ?? null },
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
