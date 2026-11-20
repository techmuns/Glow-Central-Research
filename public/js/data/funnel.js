// data/funnel.js — the Screening Funnel engine (pure, testable).
//
// The client's funnel: a universe narrowed in named stages to a short, high-conviction list.
//   Stage 1  Market cap     — the universe band (default Rs 1,000-25,000 Cr, EDITABLE)
//   Stage 2  Sector exclude — drop whole sectors the desk won't cover (commodity, AI-at-risk, …)
//   Stage 3  Quantitative   — ROCE / growth / debt / cash conversion ranges (EDITABLE, AND or OR),
//                             with an inflection rescue so a capex/new-product company isn't cut
//   Stage 4  Qualitative    — the Framework score (governance gate + minimum total)
//   Stage 5  Valuation       — P/E / P/B / yield ranges
//
// NOTHING IS HARDCODED: every threshold is a default the desk edits. A default is a sensible
// starting range, not a gate. A company with a null figure for a criterion FAILS that one
// criterion (we can't confirm it passes) — but under "match ANY" it can still survive on another,
// and the engine counts how many are dropped for missing data so that is never silent.
//
// runFunnel(companies, config, ctx) returns the count before/after each stage, the survivors,
// and the survivor set *up to and including* each stage, so clicking a stage shows exactly its
// companies. It is deterministic and side-effect-free; the tab renders what it returns.

import { FUNDAMENTAL_METRICS } from './funnel-metrics.js';

export const METRICS = FUNDAMENTAL_METRICS;
const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

export const STAGES = [
  { id: 'universe', label: 'Universe', kind: 'base' },
  { id: 'marketCap', label: 'Market cap', kind: 'range' },
  { id: 'sector', label: 'Sector exclude', kind: 'sector' },
  { id: 'quant', label: 'Quantitative', kind: 'criteria' },
  { id: 'qualitative', label: 'Qualitative (Framework)', kind: 'framework' },
  { id: 'valuation', label: 'Valuation', kind: 'criteria' },
];

export function defaultConfig() {
  return {
    // How the Stage-3 and Stage-5 criteria combine: 'all' (AND) or 'any' (OR).
    match: 'all',
    marketCap: { enabled: true, min: 1000, max: 25000 },
    excludeSectors: [],
    keepInflection: true,
    quant: [
      { metric: 'roce', mode: 'gte', min: 15, max: null, enabled: true },
      { metric: 'salesGrowth3y', mode: 'gte', min: 10, max: null, enabled: true },
      { metric: 'profitVar3y', mode: 'gte', min: 10, max: null, enabled: true },
      { metric: 'debtToEquity', mode: 'lte', min: null, max: 1, enabled: true },
      { metric: 'cashConversionPct', mode: 'gte', min: 40, max: null, enabled: false },
      { metric: 'pledgedPct', mode: 'lte', min: null, max: 10, enabled: false },
    ],
    qualitative: { enabled: false, requireGovPass: true, minTotal: 0 },
    valuation: [
      { metric: 'pe', mode: 'lte', min: null, max: 40, enabled: false },
      { metric: 'pb', mode: 'lte', min: null, max: 8, enabled: false },
      { metric: 'divYieldPct', mode: 'gte', min: 0, max: null, enabled: false },
    ],
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Evaluate one metric filter against a company. null = metric absent (counts as a miss). */
export function passesFilter(company, filter) {
  if (!filter || !filter.enabled) return true;
  const v = num(company ? company[filter.metric] : null);
  if (v == null) return false; // can't confirm it passes
  const min = num(filter.min);
  const max = num(filter.max);
  if (filter.mode === 'gte') return min == null ? true : v >= min;
  if (filter.mode === 'lte') return max == null ? true : v <= max;
  if (filter.mode === 'between') {
    if (min != null && v < min) return false;
    if (max != null && v > max) return false;
    return true;
  }
  return true;
}

/** Combine a set of criteria by match mode. Only enabled filters count. */
function passesCriteria(company, filters, match) {
  const active = (filters || []).filter((f) => f && f.enabled && METRIC_BY_KEY.has(f.metric));
  if (!active.length) return true; // no criteria set => nothing to fail
  if (match === 'any') return active.some((f) => passesFilter(company, f));
  return active.every((f) => passesFilter(company, f));
}

function passesMarketCap(company, mc) {
  if (!mc || !mc.enabled) return true;
  const v = num(company.marketCapCr);
  if (v == null) return false;
  const min = num(mc.min);
  const max = num(mc.max);
  if (min != null && v < min) return false;
  if (max != null && v > max) return false;
  return true;
}

function passesSector(company, excluded) {
  if (!excluded || !excluded.length) return true;
  const set = excluded instanceof Set ? excluded : new Set(excluded);
  return !set.has(company.broadSector) && !set.has(company.sector);
}

function passesQualitative(company, q, framework) {
  if (!q || !q.enabled) return true;
  const fw = framework ? framework.get(String(company.ticker || '').toUpperCase()) : null;
  if (!fw) return false; // required but unscored => can't confirm
  if (q.requireGovPass && fw.gate === 'fail') return false;
  if (num(q.minTotal) != null && (num(fw.total) == null || fw.total < q.minTotal)) return false;
  return true;
}

/**
 * Run the funnel.
 * @param companies  array of fundamental rows (from data/fundamentals.js)
 * @param config     funnel config (see defaultConfig)
 * @param ctx        { framework: Map<ticker,{total,gate}>, inflection: Set<ticker> }
 */
export function runFunnel(companies, config, ctx = {}) {
  const cfg = config || defaultConfig();
  const framework = ctx.framework || null;
  const inflection = ctx.inflection instanceof Set ? ctx.inflection : new Set();

  const base = Array.isArray(companies) ? companies.slice() : [];
  const byStage = { universe: base };
  const steps = [{ id: 'universe', label: 'Universe', before: base.length, after: base.length, removed: 0 }];

  let current = base;
  const step = (id, label, predicate) => {
    const before = current.length;
    const kept = current.filter(predicate);
    byStage[id] = kept;
    steps.push({ id, label, before, after: kept.length, removed: before - kept.length });
    current = kept;
  };

  step('marketCap', 'Market cap', (c) => passesMarketCap(c, cfg.marketCap));
  step('sector', 'Sector exclude', (c) => passesSector(c, cfg.excludeSectors));

  // Quantitative, with the inflection rescue: a company at an inflection point (qualifying recent
  // announcement) is kept even if it fails the quantitative cut, so a capex / new-product story is
  // not screened out on trailing numbers. The rescue is flagged on the company for the table.
  step('quant', 'Quantitative', (c) => {
    if (passesCriteria(c, cfg.quant, cfg.match)) { c._rescued = false; return true; }
    if (cfg.keepInflection && inflection.has(String(c.ticker || '').toUpperCase())) {
      c._rescued = true;
      return true;
    }
    return false;
  });

  step('qualitative', 'Qualitative (Framework)', (c) => passesQualitative(c, cfg.qualitative, framework));
  step('valuation', 'Valuation', (c) => passesCriteria(c, cfg.valuation, cfg.match));

  return { steps, survivors: current, byStage };
}

/** How many survivors of a stage are missing data for the enabled criteria of the NEXT stage. */
export function missingDataCount(companies, filters) {
  const active = (filters || []).filter((f) => f && f.enabled && METRIC_BY_KEY.has(f.metric));
  if (!active.length) return 0;
  return (companies || []).filter((c) => active.every((f) => num(c[f.metric]) == null)).length;
}

/** Distinct broad sectors present in the universe, with a count each (for the exclude checkboxes). */
export function sectorCounts(companies) {
  const m = new Map();
  for (const c of companies || []) {
    const s = c.broadSector || c.sector;
    if (!s) continue;
    m.set(s, (m.get(s) || 0) + 1);
  }
  return [...m.entries()].map(([sector, count]) => ({ sector, count })).sort((a, b) => b.count - a.count);
}

export { METRIC_BY_KEY };
