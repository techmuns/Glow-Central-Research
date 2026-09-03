// data/mf-weekly.js — the weekly mutual-fund performance workbook: every category's schemes, its
// published median and the index rows printed beneath it.
//
//   load()              fetch + cache; every failure a NAMED state, never a thrown error
//   isLoaded()          has the payload landed
//   meta()              asOf, periods, coverage, counts, provenance, and `reason` on failure
//   categories()        every category, in taxonomy order
//   category(id)        one category
//   tree()              asset class -> group -> category, off js/data/mf-taxonomy.js
//   benchmarkIndex()    the workbook's own 36-index master sheet
//   benchmarkFor(cat, id?)  the index that category is compared against, why that one, and what
//                       else the workbook printed under it. `id` is the reader's own pick.
//   medianOf(cat, p)    the PUBLISHED median for a period — reproduced, never recomputed
//   relativeTo(a, b)    a - b in percentage POINTS, or null if either side is absent
//   priceBasisCategories()  the categories whose index is a PRICE index, not a total-return one
//
// THIS IS A COMMITTED SNAPSHOT, NOT A LIVE FEED, and the difference is the whole reason it exists
// beside `js/data/fund-returns.js`:
//
//                    | mf-weekly (this file)              | fund-returns (AmfiBeas)
//   ---------------- | ---------------------------------- | ------------------------------------
//   cadence          | weekly workbook, committed          | daily, read live from the browser
//   as on            | one stated date for every sheet     | its own, later, date
//   schemes          | ~620 curated direct-plan schemes    | ~3,400, every plan and option
//   periods          | 1W 1M 3M 6M 1Y 3Y 5Y + inception    | 1M 3M 6M 1Y 3Y 5Y 10Y
//   category median  | PUBLISHED by the workbook           | none — the payload has no median
//   benchmark        | PUBLISHED per category              | none — AMFI's NAV snapshot has none
//   peer rank        | none                                | published, within its own cohort
//
// THEY ARE DATED DIFFERENT DAYS, SO NOTHING CROSSES BETWEEN THEM. Not a benchmark, not a median,
// not a total, not a "vs" column. A 14 August index return under a 2 September fund return would be
// a comparison nobody measured — the same error class as dating a price move by the capture rather
// than the session (CLAUDE.md, "A close is a claim about a SESSION"). The two live on separate
// sub-views, each carrying its own as-on date on its face.
//
// THE MEDIANS AND THE INDEX RETURNS ARE THE WORKBOOK'S. Reproduced unchanged, exactly as the
// con-call scores are StockScans' and the holding values are Trendlyne's. The import script
// recomputes each median as a PARSE CHECK and refuses to write the file when one disagrees, but the
// number that ships is always the published one. The single figure derived here is the gap between
// a return and its median or its benchmark, which is subtraction of two of their own percentages,
// is measured in percentage POINTS, and is labelled derived everywhere it surfaces.

import { revalidatedJson } from '../core/store.js';
import { buildTree, WORKBOOK_TAXONOMY } from './mf-taxonomy.js';

const PATH = 'data/mf-weekly.json';

export const PERIODS = ['1W', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'SI'];
// 3Y and 5Y are annualised in this workbook, as they are in every fund factsheet; the shorter
// windows are simple point-to-point returns. Stated so a heading can say which it is.
export const ANNUALISED = new Set(['3Y', '5Y']);

let cache = null;
let loadPromise = null;

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build();
  return loadPromise;
}

/** Forget everything and fetch again — the retry behind the failure panel's button. */
export function reload() {
  cache = null;
  loadPromise = null;
  return load();
}

async function build() {
  // `optional: true` so a missing or broken file becomes a NAMED state rather than a rejection the
  // tab has to catch. A failed read is never an empty result: `categories: []` only ever travels
  // with a `reason` beside it, so the view says "could not be read" instead of "no funds".
  const raw = await revalidatedJson(PATH, { optional: true });
  cache = raw ? ingest(raw) : fail('unreachable');
  return cache;
}

function fail(reason) {
  return {
    categories: [],
    benchmarkIndex: [],
    meta: { reason, asOf: null, periods: PERIODS, source: null, path: PATH, categoryCount: 0, fundCount: 0, benchmarkCount: 0, coverage: [], medianCheck: null },
  };
}

function ingest(body) {
  if (!body || !Array.isArray(body.categories) || !body.categories.length) return fail('shape');
  if (!body.asOf) return fail('shape');

  const byId = new Map();
  const categories = body.categories
    .filter((c) => c && c.id && Array.isArray(c.funds))
    .map((c) => {
      // The tab reads the taxonomy for a category's placement rather than trusting the file's own
      // copy of it, so a taxonomy edit takes effect without a re-import. The file's assetClass and
      // group stay as a record of what the import filed it under.
      const t = WORKBOOK_TAXONOMY[c.sheet] || null;
      const benchmarks = Array.isArray(c.benchmarks) ? c.benchmarks : [];
      return {
        ...c,
        assetClass: t?.assetClass || c.assetClass,
        group: t?.group || c.group,
        label: t?.label || c.label || c.sheet,
        funds: c.funds.filter((f) => f && f.id && f.scheme),
        benchmarks,
        // Resolved here rather than trusted from the file, so a workbook whose primary index id no
        // longer matches any row falls back to a real one instead of to nothing.
        primaryBenchmark: benchmarks.find((b) => b.id === c.primaryBenchmarkId) || benchmarks.find((b) => b.tri) || benchmarks[0] || null,
      };
    });
  categories.forEach((c) => byId.set(c.id, c));

  return {
    categories,
    byId,
    benchmarkIndex: Array.isArray(body.benchmarkIndex) ? body.benchmarkIndex : [],
    meta: {
      reason: null,
      asOf: body.asOf,
      source: body.source || 'Weekly mutual fund performance workbook',
      sourceFile: body.sourceFile || null,
      path: PATH,
      periods: Array.isArray(body.periods) && body.periods.length ? body.periods : PERIODS,
      periodLabels: body.periodLabels || null,
      benchmarkPeriods: Array.isArray(body.benchmarkPeriods) ? body.benchmarkPeriods : PERIODS.filter((p) => p !== 'SI'),
      coverage: Array.isArray(body.assetClasses) ? body.assetClasses : [],
      medianCheck: body.medianCheck || null,
      medianBasis: body.medianBasis || null,
      categoryCount: categories.length,
      fundCount: categories.reduce((n, c) => n + c.funds.length, 0),
      benchmarkCount: Array.isArray(body.benchmarkIndex) ? body.benchmarkIndex.length : 0,
      // Named, not inferred from an empty array — the tab prints this list.
      withoutBenchmark: categories.filter((c) => !c.benchmarks.length).map((c) => c.label),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------

export const isLoaded = () => !!cache && !cache.meta.reason;
export const meta = () => (cache ? cache.meta : null);
export const categories = () => (cache ? cache.categories : []);
export const category = (id) => (cache ? cache.byId.get(id) || null : null);
export const benchmarkIndex = () => (cache ? cache.benchmarkIndex : []);

/** asset class -> group -> category, over the categories (optionally a narrowed subset). */
export function tree(list = categories()) {
  return buildTree(list, (c) => ({ assetClass: c.assetClass, group: c.group, label: c.label, categoryId: c.id, sourceLabel: c.sheet }));
}

/**
 * The index a category is compared against — the workbook's own, never one substituted for it.
 *
 * Returns `{ benchmark, reason }`. `benchmark: null` with a reason is the honest answer for a sheet
 * that publishes no index row (Smart Beta is the one), and the tab prints that reason where a
 * comparison column would otherwise sit. Nothing here reaches into the master index sheet to fill
 * the gap: pairing a category with an index the source did not pair it with would be this
 * dashboard's judgement wearing the workbook's clothes.
 */
export function benchmarkFor(cat, chosenId = null) {
  if (!cat) return { benchmark: null, reason: 'No category selected.', alternatives: [], chosen: false };
  if (!cat.benchmarks.length) {
    return { benchmark: null, reason: cat.benchmarkNote || 'The workbook prints no index row for this category, so it states no benchmark. None is substituted.', alternatives: [], chosen: false };
  }
  // A READER'S OWN CHOICE IS HONOURED AND LABELLED AS THEIRS — and only ever from among the indices
  // the workbook printed under THIS category. Never the master sheet: that would pair a category
  // with an index the source did not pair it with, which is the line the whole file draws.
  const picked = chosenId ? cat.benchmarks.find((x) => x.id === chosenId) : null;
  const b = picked || cat.primaryBenchmark;
  const first = cat.benchmarks[0];
  const why = picked
    ? 'Your choice, from the indices the workbook prints under this category. The workbook’s own default is the first option in the row.'
    : b === first
      ? 'The first index the workbook lists under this category — the workbook’s own ordering is the only preference it expresses.'
      : 'The Total Return Index of the same index the workbook lists first: not a different index, the same one measured the way a NAV is, with dividends reinvested.';
  return {
    benchmark: b,
    reason: why,
    alternatives: cat.benchmarks.filter((x) => x !== b),
    chosen: !!picked,
    // A PRICE INDEX AND A TOTAL RETURN INDEX ARE NOT ON ONE SCALE, and a gap measured against each
    // sits in the same sortable column. The one category whose sheet prints no TRI (Large Cap, which
    // lists Nifty 100 and Nifty 50) is therefore compared on a basis the other twenty-five are not —
    // a real difference of about a point a year, which is exactly the size of a shade step. It is
    // flagged rather than silently ranked alongside them.
    basis: b.tri ? 'tri' : 'price',
  };
}

/** Categories whose benchmark is a PRICE index — not comparable, point for point, with a TRI gap. */
export function priceBasisCategories(list = categories()) {
  return list.filter((c) => c.benchmarks.length && !benchmarkFor(c).benchmark?.tri);
}

/** The PUBLISHED median for a period, or null. Never recomputed — see the header. */
export function medianOf(cat, period) {
  const v = cat?.median?.returns?.[period];
  return typeof v === 'number' ? v : null;
}

/** A benchmark's return for a period, or null. */
export function benchmarkReturn(benchmark, period) {
  const v = benchmark?.returns?.[period];
  return typeof v === 'number' ? v : null;
}

/**
 * `a - b`, in PERCENTAGE POINTS, or null if either side is absent.
 *
 * A NULL IS NOT A ZERO, on either side. A scheme too young for the period has no return, and a
 * benchmark this workbook does not publish for the period has none either; a gap of "0.0 pp" would
 * claim they were measured and found equal. Both are absent, and absent stays absent.
 *
 * The unit is percentage points because both operands are already percentages — see CLAUDE.md, "A
 * gap between two percentages is measured in percentage points".
 */
export function relativeTo(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return a - b;
}
