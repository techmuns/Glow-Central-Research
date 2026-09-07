// data/fund-returns.js — the AmfiBeas "Returns & Ranking" feed: per-scheme point-to-point returns,
// same-cohort peer rank AND the cohort's own published average and median. Loaded once, cached,
// called DIRECT from the browser.
//
//   load()        fetch, resolve, cache — every failure is a NAMED state, never a thrown error
//   reload()      forget the cache and fetch again (the "Try again" control)
//   all()         the schemes the tab shows — DIRECT PLAN, one row per scheme (see below)
//   allPlans()    every row the source returned, both plans, for counting and for the provenance
//   meta()        asOfDate, periods, counts, provenance, and a named `reason` on failure
//   periods()     the periods the payload carries
//
// ============================================================================================
// EVERY RETURN ARRIVES WITH ITS BENCHMARK, AND THE BENCHMARK IS THEIRS
// ============================================================================================
//
// A return with nothing beside it is a number the reader cannot act on: +3.9% over three months is
// a good quarter or a bad one entirely according to what the rest of the category did. AmfiBeas
// publish that comparison themselves — `categoryAverage` and `categoryMedian` for the scheme's own
// cohort, plus `excessVsAverage` / `excessVsMedian`, `percentile` and `quartile` — on the SAME NAV
// date as the return, computed over the same snapshot. So the benchmark on this feed is the
// scheme's own category, reproduced unchanged, exactly as the rank already was.
//
// THAT IS WHY THIS ASKS FOR `fields=full` RATHER THAN `fields=compact`. The compact projection
// carries `{ return, rank, peerCount }` and nothing to compare a return against, which is why this
// view had no benchmark column at all. The full projection is ~5.8 MB against ~1.9 MB (about 610 KB
// against 205 KB over the wire, gzipped) — a real cost, paid once per visit on a tab nobody opens
// by accident, and the device store keeps it.
//
// IT IS A CATEGORY BENCHMARK, NOT AN INDEX, AND THE VIEW SAYS SO. AMFI's daily NAV snapshot carries
// no index level, so AmfiBeas publish no index return and none is invented here. The workbook on
// the other sub-view publishes index returns — on ITS OWN, EARLIER date — and not one of them may
// cross over. See js/data/mf-weekly.js.
//
// ============================================================================================
// ONE ROW PER SCHEME: THE DIRECT PLAN
// ============================================================================================
//
// The source returns both plans of every scheme — 1,822 regular and 1,617 direct — so the table
// listed each fund twice, once under each plan, differing only by the expense ratio baked into the
// NAV. `all()` returns the direct plan.
//
// AN ETF HAS NO PLAN TO CHOOSE, AND DROPPING EVERY REGULAR ROW WOULD DELETE ALL OF THEM. A listed
// fund has one unit and one expense ratio; AmfiBeas file all 234 of them as `regular` because that
// is the only plan they have. So the rule is not "keep direct" but "keep direct WHERE THE SOURCE
// LISTS ONE" — a scheme the source files under a single plan is kept as it is, and 232 rows arrive
// that way. Same shape as `dedupeGroup` in the family book: the duplicate is dropped, the row that
// exists only once is not.
//
// TWO MORE THINGS THE SOURCE'S OWN LABELLING MAKES NECESSARY, AND BOTH ARE VISIBLE ON SCREEN
// WITHOUT THEM. It files 31 schemes under two ids with identical figures, so both survived the rule
// above and painted one under the other; and it names hundreds of direct-plan rows "…-Reg(G)",
// which is the regular plan's label on a direct plan's row. `foldIdenticalRows()` and
// `displayNameOf()` below close each, and neither touches a figure.

//
// WHY IT IS CALLED DIRECT, NOT PROXIED. The AmfiBeas API is CORS-open (Access-Control-Allow-Origin:
// *) and read-only — the same shape as the SentimentDash chatter feed — so the browser reads it
// straight and revalidates against its ETag through `conditionalJson`. There is no credential to
// hold, so nothing to proxy for. See js/data/chatter-live.js for the same pattern and the platform
// rule (Cloudflare error 1042) that makes a Worker proxy impossible for a same-account upstream.
//
// THE RETURNS AND RANKS ARE THEIRS. `returns[period].return` is a percentage already (3.4852 →
// +3.49%): a simple return for 1M/3M/6M/1Y, a CAGR for 3Y/5Y/10Y. `rank`/`peerCount` is the scheme's
// rank WITHIN ITS COHORT. Nothing here re-bands, re-ranks or recomputes — the same rule the con-call
// and chatter feeds follow. A null `return` is "no return for that period", never a zero; a null
// `rank` is "the cohort was too small to rank" and may sit beside a non-null return.

import { conditionalJson, KEYS, isPersistent } from '../core/store.js';
import { factorsOf } from './mf-taxonomy.js';

export const PERIODS = ['1M', '3M', '6M', '1Y', '3Y', '5Y', '10Y'];
// The label each period wears in the table — " CAGR" is appended for the multi-year ones, which is
// how the source labels them (3Y is a CAGR, 1M is a simple return).
export const PERIOD_LABEL = { '1M': '1M', '3M': '3M', '6M': '6M', '1Y': '1Y', '3Y': '3Y CAGR', '5Y': '5Y CAGR', '10Y': '10Y CAGR' };

const STORE_KEY = KEYS.fundReturns;
// AmfiBeas has no committed host yet, so the default is empty — set window.AMFIBEAS_API_BASE in
// index.html once the API is deployed. An empty base surfaces as the `no-url` state, which the view
// turns into "configure the host" rather than a broken table.
const DEFAULT_BASE = '';

/** `localStorage` first so a verification run (or a screenshot) can point the whole feed at a stub. */
function baseUrl() {
  try {
    const override = localStorage.getItem('sattva:amfibeas-base');
    if (override) return override.replace(/\/+$/, '');
  } catch {
    /* storage disabled — fall through */
  }
  const configured = typeof window !== 'undefined' ? window.AMFIBEAS_API_BASE : null;
  return String(configured || DEFAULT_BASE).replace(/\/+$/, '');
}

let cache = null;
let loadPromise = null;

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // a thrown (not named) failure may retry on a later mount
    throw err;
  });
  return loadPromise;
}

/** Forget everything and fetch again — the retry control behind the "Try again" button. */
export function reload() {
  cache = null;
  loadPromise = null;
  return load();
}

async function build() {
  ingest(await fetchFeed());
  return cache;
}

/**
 * One read of the feed, with every failure NAMED rather than thrown. Returns `{ ok: true, body }`,
 * or `{ ok: false, reason, url? }`. `no-url` (host not configured) and `not-found` (the API branch
 * is not deployed) are things an operator fixes; `unreachable` / `upstream` are things to wait for;
 * `shape` means the contract moved. The requested URL travels with every failure, so it can be
 * diagnosed from its own artefact.
 */
async function fetchFeed() {
  const base = baseUrl();
  if (!/^https?:\/\//i.test(base)) return { ok: false, reason: 'no-url' };
  // `fields=full` → the cohort's own `categoryAverage` / `categoryMedian` and the excess over each,
  // beside every return. `fields=compact` carries none of them, and a return with nothing to compare
  // it against is the thing this view was missing. All seven periods come by default.
  const url = `${base}/api/returns-ranking?fields=full`;
  let out;
  try {
    out = await conditionalJson(url, { key: STORE_KEY, optional: true });
  } catch {
    return { ok: false, reason: 'unreachable', url };
  }
  if (!out.value) {
    if (out.status === 0) return { ok: false, reason: 'unreachable', url };
    if (out.status === 404) return { ok: false, reason: 'not-found', status: 404, url };
    return { ok: false, reason: 'upstream', status: out.status, url };
  }
  if (!out.value || !Array.isArray(out.value.funds)) return { ok: false, reason: 'shape', url };
  return { ok: true, body: out.value, checkedAt: out.checkedAt, fromStore: out.status === 304, url };
}

function baseMeta(extra) {
  return {
    reason: null, url: null, status: null, asOfDate: null, generatedAt: null, source: null, periods: PERIODS,
    total: 0, count: 0, universe: 0, hiddenRegular: 0, singlePlan: 0, foldedDuplicates: 0, benchmarkBasis: null,
    checkedAt: null, origin: null, persisted: isPersistent(), ...extra,
  };
}

/** A number, or null. Never NaN, never a zero standing in for an absent figure. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One period's cell, in this dashboard's vocabulary. Every figure here is the source's own — the
 * return, the rank, the cohort's average and median, and the excess over each. Nothing is computed
 * from another field: `excessVsMedian` is theirs, not `return - categoryMedian` worked out here, so
 * a rounding or a cohort definition of ours can never disagree with the number beside it.
 */
function cellOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    return: num(raw.return),
    rank: num(raw.rank),
    peerCount: num(raw.peerCount),
    percentile: num(raw.percentile),
    quartile: typeof raw.quartile === 'string' ? raw.quartile : null,
    categoryAverage: num(raw.categoryAverage),
    categoryMedian: num(raw.categoryMedian),
    excessVsAverage: num(raw.excessVsAverage),
    excessVsMedian: num(raw.excessVsMedian),
    // Their own words for why a figure is absent, kept so an em dash can say which absence it is.
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

const byName = (a, c) => a.fundName.localeCompare(c.fundName);

/**
 * THE SOURCE'S DISPLAY NAME CONTRADICTS ITS OWN `plan` FIELD ON HUNDREDS OF ROWS. Scheme `30046-D`
 * is filed `plan: "direct"` and named *"360 ONE Focused Fund-Reg(G)"* — the regular plan's label on
 * the direct plan's row. Printed verbatim beside a table that shows nothing but direct plans, that
 * reads as the one thing the table is there not to show.
 *
 * So the trailing PLAN marker is dropped from the displayed name, and only that: `(G)` and `(IDCW)`
 * stay, because they are the option and the option genuinely varies row to row. This is not a
 * rename — it is removing a suffix the same payload's own `plan` field contradicts, the same
 * resolution as `displayName()` on the Finology books, where the list is authoritative for the name
 * and a second string for one subject is unreadable. `sourceName` keeps the string as it arrived,
 * and the export carries both.
 */
const PLAN_SUFFIX = /\s*[-–]\s*(Reg|Regular|Dir|Direct)\s*(Plan)?\s*(\([A-Za-z]{1,4}\))?\s*$/i;
function displayNameOf(raw) {
  const trimmed = String(raw || '').replace(PLAN_SUFFIX, '').trim();
  // Never strip a name down to nothing: a scheme called only by its plan keeps what it arrived with.
  return trimmed || String(raw || '');
}

/**
 * TWO ROWS THE READER CANNOT TELL APART ARE ONE SCHEME LISTED TWICE.
 *
 * The source lists 31 schemes under two ids — an AMFI code and a synthetic one, e.g. `30046-D` and
 * `d-360-one-11-D` — with the same name bar a plan suffix and **every figure identical**. Both
 * survive the plan rule above (both are direct), so both were painted, one under the other, with
 * the same returns and the same ranks: a duplicate that reads as a bug in the feed.
 *
 * The identity is deliberately the strictest one available: the displayed name, the option, the
 * classification AND every rendered return and rank. A pair differing in any figure is two schemes
 * and both stay — this only ever folds rows that are indistinguishable on screen. Which of the two
 * is kept is decided by the name that carries no plan marker (the source's own cleaner label) and
 * then by scheme code, so the choice is the same on every reload.
 */
function foldIdenticalRows(rows) {
  const key = (r) => `${r.fundName.toLowerCase()}\u0000${r.option}\u0000${r.classification || ''}\u0000${
    Object.entries(r.returns).map(([p, c]) => `${p}:${c.return}:${c.rank}:${c.categoryMedian}`).join(';')
  }`;
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const kept = [];
  let folded = 0;
  for (const group of groups.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    folded += group.length - 1;
    const best = [...group].sort((a, c) =>
      Number(PLAN_SUFFIX.test(a.sourceName)) - Number(PLAN_SUFFIX.test(c.sourceName))
      || a.schemecode.localeCompare(c.schemecode))[0];
    kept.push(best);
  }
  return { kept, folded };
}

/**
 * ONE ROW PER SCHEME — the direct plan where the source lists one.
 *
 * Identity is the source's own display name, its option and its classification, all three exact: a
 * looser key that stripped "Reg"/"Direct" out of the text would fold *Aditya Birla SL Regular
 * Savings Fund* into *Aditya Birla SL Savings Fund*, which are two different funds. Where a group
 * holds a direct row, the regular twin is the same portfolio with a distributor's trail baked into
 * its NAV and is dropped. Where it holds none — every ETF, and a handful of legacy schemes — the
 * row is kept, because that is a scheme with one plan rather than a plan we chose against.
 */
function directOnly(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.fundName}\u0000${r.option}\u0000${r.classification || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const shown = [];
  let singlePlan = 0;
  for (const group of groups.values()) {
    const direct = group.filter((r) => r.plan === 'direct');
    if (direct.length) { shown.push(...direct); continue; }
    singlePlan += group.length;
    shown.push(...group);
  }
  return { shown: shown.sort(byName), singlePlan };
}

function ingest(res) {
  // A FAILED READ IS NEVER AN EMPTY RESULT: `funds: []` only ever travels with a `reason` beside it,
  // so the view can say "could not be read" rather than "no funds".
  if (!res.ok) {
    cache = { funds: [], allPlans: [], meta: baseMeta({ reason: res.reason, url: res.url || null, status: res.status || null }) };
    return;
  }
  const b = res.body;
  const periods = Array.isArray(b.periods) && b.periods.length ? b.periods.filter((p) => PERIODS.includes(p)) : PERIODS;
  const allPlans = b.funds
    .filter((f) => f && f.schemecode != null)
    .map((f) => {
      const fundName = f.fundName || '(unnamed scheme)';
      const returns = {};
      if (f.returns && typeof f.returns === 'object') {
        for (const p of periods) {
          const cell = cellOf(f.returns[p]);
          if (cell) returns[p] = cell;
        }
      }
      return {
        schemecode: String(f.schemecode),
        fundName: displayNameOf(fundName),
        // The string exactly as it arrived, so the export can carry the source's own label and a
        // reader can always get back to what was published.
        sourceName: fundName,
        classification: f.classification || null,
        plan: f.plan || 'unknown',
        option: f.option || 'unknown',
        cohortKey: f.cohortKey || null,
        // The strategy the scheme's OWN NAME states, never a re-classification — see mf-taxonomy.js.
        factors: factorsOf(fundName),

        returns,
      };
    })
    .sort(byName); // alphabetical, exactly as the source lists them
  const { shown, singlePlan } = directOnly(allPlans);
  const { kept, folded } = foldIdenticalRows(shown);
  cache = {
    funds: kept,
    allPlans,
    meta: baseMeta({
      url: res.url,
      asOfDate: b.asOfDate || null,
      generatedAt: b.generatedAt || null,
      source: b.source || 'AmfiBeas daily NAV snapshot (AMFI)',
      periods,
      // `total` is what the tab lists; `universe` is every row the source returned, both plans. Two
      // different claims, so two fields — neither has to be reached by subtracting the other.
      total: kept.length,
      count: kept.length,
      universe: Number.isFinite(b.total) ? b.total : allPlans.length,
      hiddenRegular: allPlans.length - shown.length,
      singlePlan,
      // Rows the source listed twice under two ids with every figure identical — a different claim
      // from `hiddenRegular`, so a different field.
      foldedDuplicates: folded,
      // What a return is compared against on this feed, named once so the table heading, the modal
      // and the export cannot drift about it.
      benchmarkBasis: 'category',
      checkedAt: res.checkedAt || Date.now(),
      origin: res.fromStore ? 'store' : 'live',
    }),
  };
}

export const isLoaded = () => !!cache;
export const all = () => (cache ? cache.funds : []);
/** Every row the source returned, both plans — for counts and provenance, never for the table. */
export const allPlans = () => (cache ? cache.allPlans : []);
export const meta = () => (cache ? cache.meta : null);
export const periods = () => (cache ? cache.meta.periods : PERIODS);
