// scoring/earnings-scoring.js — Result Quality & Growth: 15 rules, 21 points, 5 categories.
//
// NOTE ON THE RULE COUNT: the brief headlined "14 rules, 21 points" but enumerated fifteen —
// Growth 4, Margins 3, Earnings Quality 4, Surprise 2, Consistency 2. The per-category point
// totals it specified (7/4/5/3/2 = 21) only add up with all fifteen present, so every named
// rule is implemented and the headline count is treated as the typo.
//
// Second model on the shared scoring contract (tech-scoring.js is the first). Same shapes
// throughout, so the screener kit consumes it with zero special-casing:
//
//   rule.fn(c)     -> { points, max, status, value, note }
//   ACTIVE_RULES   -> [{ key, label, category, criteria, fn }]
//   DEFERRED       -> [] (rules named but not yet scoreable)
//   scoreCompany(c)-> { company, breakdown, totalPoints, totalMax, scorePct, hardFails, naCount }
//
// `status` is one of pass | partial | fail | hard_fail | na.
//
// TWO RULES OF THIS FILE:
//   1. A missing input returns `na` with the rule's full `max`. It costs the company those
//      points and says why — it never guesses, and never scores a silent zero that reads
//      like a real measurement.
//   2. Every `value` string shows the actual numbers behind the verdict ("OPM 18.4% vs
//      17.1% LY — +130bps"), and every `note` explains the verdict in one plain sentence.
//
// The only hard fail is a negative PAT: a loss-making quarter drops the company out of the
// quality pipeline regardless of what else is working.

const NA = { points: 0, max: 0, status: 'na', value: null, note: 'Data not available' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmtPct = (n, d = 1) => (n == null ? '—' : `${n.toFixed(d)}%`);
const fmtSigned = (n, d = 1) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`);
const fmtBps = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}bps`);
// A gap between two percentages is measured in percentage points, not percent — using
// fmtSigned here would render the doubled unit "+2.0% pp".
const fmtPP = (n, d = 1) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}pp`);
const fmtCr = (n) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')} Cr`);

// ---------------------------------------------------------------------------------------
// Quarter helpers. `c.quarters` is 8 quarters oldest-first; index -1 is the latest.
// ---------------------------------------------------------------------------------------

const latest = (c) => (Array.isArray(c?.quarters) && c.quarters.length ? c.quarters.at(-1) : null);
const prevQ = (c) => (Array.isArray(c?.quarters) && c.quarters.length >= 2 ? c.quarters.at(-2) : null);
// Same quarter one year ago = four quarters back.
const yearAgo = (c) => (Array.isArray(c?.quarters) && c.quarters.length >= 5 ? c.quarters.at(-5) : null);

function pctChange(now, then) {
  const a = num(now);
  const b = num(then);
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

// YoY revenue growth for each of the last `n` quarters that has a year-ago comparator.
function revYoySeries(c, n = 4) {
  const qs = c?.quarters;
  if (!Array.isArray(qs) || qs.length < 5) return [];
  const out = [];
  for (let i = qs.length - 1; i >= 4 && out.length < n; i--) {
    const g = pctChange(qs[i].revenue, qs[i - 4].revenue);
    if (g != null) out.push(g);
  }
  return out; // newest first
}

// ---------------------------------------------------------------------------------------
// GROWTH — 7 points
// ---------------------------------------------------------------------------------------

function ruleRevenueYoY(c) {
  const q = latest(c);
  const y = yearAgo(c);
  if (!q || !y) return { ...NA, max: 2, note: 'Needs the year-ago quarter — fewer than 5 quarters of history.' };
  const g = pctChange(q.revenue, y.revenue);
  if (g == null) return { ...NA, max: 2 };
  const value = `Revenue ${fmtCr(q.revenue)} vs ${fmtCr(y.revenue)} LY — ${fmtSigned(g)}`;
  if (g > 15) return { points: 2, max: 2, status: 'pass', value, note: 'Revenue growing faster than 15% year on year.' };
  if (g >= 8) return { points: 1, max: 2, status: 'partial', value, note: 'Single-digit-to-mid growth — steady but not compounding hard.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'Revenue growth under 8% — the topline is barely moving.' };
}

function rulePatYoY(c) {
  const q = latest(c);
  const y = yearAgo(c);
  if (!q || !y) return { ...NA, max: 2, note: 'Needs the year-ago quarter — fewer than 5 quarters of history.' };
  const pat = num(q.netProfit);
  if (pat == null) return { ...NA, max: 2 };

  // A loss is the model's only hard fail: it exits the quality pipeline outright.
  if (pat < 0) {
    return {
      points: 0,
      max: 2,
      status: 'hard_fail',
      value: `Net profit ${fmtCr(pat)} — loss-making quarter`,
      note: 'Loss for the quarter. A negative PAT fails the quality screen outright, whatever the rest of the print looks like.',
    };
  }
  const g = pctChange(pat, y.netProfit);
  if (g == null) return { ...NA, max: 2 };
  const value = `PAT ${fmtCr(pat)} vs ${fmtCr(y.netProfit)} LY — ${fmtSigned(g)}`;
  if (g > 15) return { points: 2, max: 2, status: 'pass', value, note: 'Profit growing faster than 15% year on year.' };
  if (g >= 5) return { points: 1, max: 2, status: 'partial', value, note: 'Profit growing, but in single digits to low teens.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'Profit growth under 5% — earnings are stalling.' };
}

function ruleRevenueAcceleration(c) {
  // Eight quarters of history yield exactly FOUR YoY readings (each needs a year-ago
  // comparator), so the trailing baseline is the three quarters before the latest — not
  // four. The value string names the window so the comparison is never ambiguous.
  const series = revYoySeries(c, 4); // newest first: [latest, q-1, q-2, q-3]
  if (series.length < 3) return { ...NA, max: 2, note: 'Needs at least three quarters of YoY growth to establish a run-rate — insufficient history.' };
  const current = series[0];
  const trailing = series.slice(1);
  const avg = trailing.reduce((s, v) => s + v, 0) / trailing.length;
  const delta = current - avg;
  const value = `Latest YoY ${fmtSigned(current)} vs prior ${trailing.length}-quarter average ${fmtSigned(avg)} — ${fmtPP(delta)}`;
  if (delta > 1) return { points: 2, max: 2, status: 'pass', value, note: 'Growth is accelerating against its own recent run-rate.' };
  if (delta >= -1) return { points: 1, max: 2, status: 'partial', value, note: 'Growth holding steady — within a point of the trailing average.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'Growth is decelerating versus the last four quarters.' };
}

function ruleRevenueQoQ(c) {
  const q = latest(c);
  const p = prevQ(c);
  if (!q || !p) return { ...NA, max: 1, note: 'Needs the preceding quarter.' };
  const g = pctChange(q.revenue, p.revenue);
  if (g == null) return { ...NA, max: 1 };
  const value = `Revenue ${fmtCr(q.revenue)} vs ${fmtCr(p.revenue)} last quarter — ${fmtSigned(g)}`;
  if (g > 0) return { points: 1, max: 1, status: 'pass', value, note: 'Sequential revenue growth — no quarter-on-quarter slip.' };
  return { points: 0, max: 1, status: 'fail', value, note: 'Revenue fell sequentially. Check for seasonality before reading it as weakness.' };
}

// ---------------------------------------------------------------------------------------
// MARGINS — 4 points
// ---------------------------------------------------------------------------------------

function ruleOpmExpansion(c) {
  const q = latest(c);
  const y = yearAgo(c);
  if (!q || !y) return { ...NA, max: 2, note: 'Needs the year-ago quarter.' };
  const now = num(q.opm);
  const then = num(y.opm);
  if (now == null || then == null) return { ...NA, max: 2 };
  const deltaPp = now - then; // percentage points
  const value = `OPM ${fmtPct(now)} vs ${fmtPct(then)} LY — ${fmtBps(deltaPp)}`;
  if (deltaPp >= 1) return { points: 2, max: 2, status: 'pass', value, note: 'Operating margin expanded by 100bps or more year on year.' };
  if (deltaPp >= 0) return { points: 1, max: 2, status: 'partial', value, note: 'Margin broadly flat — expanding, but by less than 100bps.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'Operating margin contracted year on year.' };
}

function ruleOpmLevel(c) {
  const q = latest(c);
  const qs = c?.quarters;
  if (!q || !Array.isArray(qs) || qs.length < 8) return { ...NA, max: 1, note: 'Needs 8 quarters to compute the trailing average.' };
  const now = num(q.opm);
  const vals = qs.map((x) => num(x.opm)).filter((v) => v != null);
  if (now == null || vals.length < 8) return { ...NA, max: 1 };
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const value = `OPM ${fmtPct(now)} vs 8-quarter average ${fmtPct(avg)} — ${fmtBps(now - avg)}`;
  if (now > avg) return { points: 1, max: 1, status: 'pass', value, note: 'Running above its own two-year average margin.' };
  return { points: 0, max: 1, status: 'fail', value, note: 'Margin sits below the two-year average — this quarter is not a high-water mark.' };
}

function ruleNpmExpansion(c) {
  const q = latest(c);
  const y = yearAgo(c);
  if (!q || !y) return { ...NA, max: 1, note: 'Needs the year-ago quarter.' };
  const now = num(q.npm);
  const then = num(y.npm);
  if (now == null || then == null) return { ...NA, max: 1 };
  const deltaPp = now - then;
  const value = `NPM ${fmtPct(now)} vs ${fmtPct(then)} LY — ${fmtBps(deltaPp)}`;
  if (deltaPp > 0) return { points: 1, max: 1, status: 'pass', value, note: 'Net margin improved year on year.' };
  return { points: 0, max: 1, status: 'fail', value, note: 'Net margin compressed year on year.' };
}

// ---------------------------------------------------------------------------------------
// EARNINGS QUALITY — 5 points
// ---------------------------------------------------------------------------------------

function ruleOpVsPat(c) {
  const q = latest(c);
  const y = yearAgo(c);
  if (!q || !y) return { ...NA, max: 2, note: 'Needs the year-ago quarter.' };
  // Comparing two growth rates only means something when both are measured off a positive
  // base and land on one. With an operating loss on either side, "OP grew faster than PAT"
  // is arithmetic, not a finding — a collapse from +466 Cr to -268 Cr scores -157% and would
  // otherwise beat a PAT that fell harder, handing an operating-loss quarter full marks for
  // earnings quality. Same guard as other_inc and tax_rate use on a negative PBT.
  const opNow = num(q.operatingProfit);
  const opThen = num(y.operatingProfit);
  if (opNow == null || opThen == null) return { ...NA, max: 2 };
  if (opNow <= 0 || opThen <= 0) {
    return {
      ...NA,
      max: 2,
      value: `Operating profit ${fmtCr(opNow)} vs ${fmtCr(opThen)} LY`,
      note:
        opNow <= 0
          ? 'Operating loss this quarter — there is no operating profit growth to compare PAT against.'
          : 'Operating loss in the year-ago quarter — growth off a negative base is not comparable.',
    };
  }
  const opG = pctChange(opNow, opThen);
  const patG = pctChange(q.netProfit, y.netProfit);
  if (opG == null || patG == null) return { ...NA, max: 2 };
  const gap = opG - patG;
  const value = `Operating profit ${fmtSigned(opG)} vs PAT ${fmtSigned(patG)} — ${fmtPP(gap)} gap`;
  if (gap >= 0) return { points: 2, max: 2, status: 'pass', value, note: 'Profit growth is coming from the operating line, not from below it.' };
  if (gap >= -5) return { points: 1, max: 2, status: 'partial', value, note: 'PAT is growing slightly faster than operating profit — a small non-operating contribution.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'PAT is outrunning operating profit — other income or one-offs are carrying the print.' };
}

function ruleOtherIncome(c) {
  const q = latest(c);
  if (!q) return { ...NA, max: 1 };
  const oi = num(q.otherIncome);
  const pbt = num(q.pbt);
  if (oi == null || pbt == null || pbt <= 0) {
    return {
      ...NA,
      max: 1,
      value: pbt != null && pbt <= 0 ? `Other income ${fmtCr(oi)} on PBT ${fmtCr(pbt)}` : null,
      note: pbt != null && pbt <= 0 ? 'PBT is zero or negative — the ratio is not meaningful.' : 'Other income or PBT not reported.',
    };
  }
  const share = (oi / pbt) * 100;
  const value = `Other income ${fmtCr(oi)} = ${fmtPct(share)} of PBT ${fmtCr(pbt)}`;
  if (share < 15) return { points: 1, max: 1, status: 'pass', value, note: 'Other income is a small share of pre-tax profit — earnings are operational.' };
  return { points: 0, max: 1, status: 'fail', value, note: 'Other income is 15% or more of PBT — a material part of profit is non-operating.' };
}

function ruleExceptional(c) {
  const q = latest(c);
  if (!q) return { ...NA, max: 1 };
  const ex = num(q.exceptionalItems);
  if (ex == null) return { ...NA, max: 1, note: 'Exceptional items line not reported.' };
  if (ex === 0) return { points: 1, max: 1, status: 'pass', value: 'No exceptional items this quarter', note: 'A clean print — nothing one-off distorting the comparison.' };
  const pbt = num(q.pbt);
  const share = pbt && pbt !== 0 ? (Math.abs(ex) / Math.abs(pbt)) * 100 : null;
  const value = `Exceptional items ${fmtCr(ex)}${share != null ? ` — ${fmtPct(share)} of PBT` : ''}`;
  return { points: 0, max: 1, status: 'fail', value, note: `${ex > 0 ? 'A one-off gain' : 'A one-off charge'} sits in this quarter — strip it out before comparing to prior periods.` };
}

function ruleTaxRate(c) {
  const q = latest(c);
  if (!q) return { ...NA, max: 1 };
  const tax = num(q.taxExpense);
  const pbt = num(q.pbt);
  if (tax == null || pbt == null || pbt <= 0) {
    return {
      ...NA,
      max: 1,
      value: pbt != null && pbt <= 0 ? `Tax ${fmtCr(tax)} on PBT ${fmtCr(pbt)}` : null,
      note: pbt != null && pbt <= 0 ? 'PBT is zero or negative — the effective rate is not meaningful.' : 'Tax expense or PBT not reported.',
    };
  }
  const rate = (tax / pbt) * 100;
  const value = `Effective tax rate ${fmtPct(rate)} (tax ${fmtCr(tax)} on PBT ${fmtCr(pbt)})`;
  if (rate >= 20 && rate <= 30) return { points: 1, max: 1, status: 'pass', value, note: 'Effective tax rate in the normal 20–30% band.' };
  if (rate < 20) return { points: 0.5, max: 1, status: 'partial', value, note: 'Tax rate below 20% — a credit, exemption or deferred-tax reversal is flattering PAT.' };
  return { points: 0.5, max: 1, status: 'partial', value, note: 'Tax rate above 30% — a one-off charge or prior-period adjustment is depressing PAT.' };
}

// ---------------------------------------------------------------------------------------
// SURPRISE — 3 points
// ---------------------------------------------------------------------------------------

function ruleEpsSurprise(c) {
  const q = latest(c);
  const est = num(c?.consensus?.eps);
  const act = num(q?.eps);
  if (act == null || est == null || est === 0) return { ...NA, max: 2, note: 'No street EPS estimate available for this quarter.' };
  const surprise = ((act - est) / Math.abs(est)) * 100;
  const value = `EPS ₹${act.toFixed(2)} vs street ₹${est.toFixed(2)} — ${fmtSigned(surprise)}`;
  if (surprise > 1) return { points: 2, max: 2, status: 'pass', value, note: 'Beat the street EPS estimate.' };
  if (surprise >= -1) return { points: 1, max: 2, status: 'partial', value, note: 'In line with the street, within a percent either way.' };
  return { points: 0, max: 2, status: 'fail', value, note: 'Missed the street EPS estimate.' };
}

function ruleRevenueSurprise(c) {
  const q = latest(c);
  const est = num(c?.consensus?.revenue);
  const act = num(q?.revenue);
  if (act == null || est == null || est === 0) return { ...NA, max: 1, note: 'No street revenue estimate available for this quarter.' };
  const surprise = ((act - est) / Math.abs(est)) * 100;
  const value = `Revenue ${fmtCr(act)} vs street ${fmtCr(est)} — ${fmtSigned(surprise)}`;
  if (surprise > 1) return { points: 1, max: 1, status: 'pass', value, note: 'Topline came in ahead of the street.' };
  if (surprise >= -1) return { points: 0.5, max: 1, status: 'partial', value, note: 'Topline in line with the street.' };
  return { points: 0, max: 1, status: 'fail', value, note: 'Topline missed the street estimate.' };
}

// ---------------------------------------------------------------------------------------
// CONSISTENCY — 2 points
// ---------------------------------------------------------------------------------------

function ruleRevenueStreak(c) {
  const series = revYoySeries(c, 4);
  if (series.length < 4) return { ...NA, max: 1, note: 'Needs 4 quarters with year-ago comparators.' };
  const positive = series.filter((g) => g > 0).length;
  const value = `${positive} of 4 quarters with positive revenue YoY (${series.map((g) => fmtSigned(g, 0)).join(', ')})`;
  // Binary by design: the criterion is "positive in ALL of the last four quarters".
  if (positive === 4) return { points: 1, max: 1, status: 'pass', value, note: 'Revenue grew year on year in every one of the last four quarters.' };
  return { points: 0, max: 1, status: 'fail', value, note: `Revenue went backwards in ${4 - positive} of the last four quarters — growth is not consistent.` };
}

function rulePatStreak(c) {
  const qs = c?.quarters;
  if (!Array.isArray(qs) || qs.length < 4) return { ...NA, max: 1, note: 'Needs 4 quarters of history.' };
  const last4 = qs.slice(-4);
  const vals = last4.map((q) => num(q.netProfit));
  if (vals.some((v) => v == null)) return { ...NA, max: 1 };
  const positive = vals.filter((v) => v > 0).length;
  const value = `${positive} of 4 quarters profitable (${vals.map((v) => fmtCr(v)).join(', ')})`;
  // Binary by design: the criterion is "profitable in ALL of the last four quarters".
  if (positive === 4) return { points: 1, max: 1, status: 'pass', value, note: 'Profitable in all four of the last quarters.' };
  return { points: 0, max: 1, status: 'fail', value, note: `${4 - positive} of the last four quarters were loss-making.` };
}

// ---------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------

// Nothing deferred: all 14 rules score off data the contract already provides.
const DEFERRED = [];

const ACTIVE_RULES = [
  { key: 'rev_yoy', label: 'Revenue YoY', category: 'Growth', criteria: '> 15%', fn: ruleRevenueYoY },
  { key: 'pat_yoy', label: 'PAT YoY', category: 'Growth', criteria: '> 15% · loss = hard fail', fn: rulePatYoY },
  { key: 'rev_accel', label: 'Revenue Acceleration', category: 'Growth', criteria: 'Above trailing-4Q average', fn: ruleRevenueAcceleration },
  { key: 'rev_qoq', label: 'Revenue QoQ', category: 'Growth', criteria: 'Positive sequentially', fn: ruleRevenueQoQ },

  { key: 'opm_exp', label: 'OPM Expansion YoY', category: 'Margins', criteria: '≥ 100bps', fn: ruleOpmExpansion },
  { key: 'opm_level', label: 'OPM vs 8-Quarter Average', category: 'Margins', criteria: 'Above average', fn: ruleOpmLevel },
  { key: 'npm_exp', label: 'NPM Expansion YoY', category: 'Margins', criteria: 'Positive', fn: ruleNpmExpansion },

  { key: 'op_vs_pat', label: 'Operating Profit vs PAT Growth', category: 'Earnings Quality', criteria: 'OP growth ≥ PAT growth', fn: ruleOpVsPat },
  { key: 'other_inc', label: 'Other Income Share', category: 'Earnings Quality', criteria: '< 15% of PBT', fn: ruleOtherIncome },
  { key: 'exceptional', label: 'No Exceptional Items', category: 'Earnings Quality', criteria: 'Clean quarter', fn: ruleExceptional },
  { key: 'tax_rate', label: 'Effective Tax Rate', category: 'Earnings Quality', criteria: '20 – 30%', fn: ruleTaxRate },

  { key: 'eps_surp', label: 'EPS vs Consensus', category: 'Surprise', criteria: 'Beat the street', fn: ruleEpsSurprise },
  { key: 'rev_surp', label: 'Revenue vs Consensus', category: 'Surprise', criteria: 'Beat the street', fn: ruleRevenueSurprise },

  { key: 'rev_streak', label: 'Revenue Growth Streak', category: 'Consistency', criteria: '4 of 4 quarters positive', fn: ruleRevenueStreak },
  { key: 'pat_streak', label: 'Profitability Streak', category: 'Consistency', criteria: '4 of 4 quarters profitable', fn: rulePatStreak },
];

// The model's declared maximum, independent of any single company's data availability.
export const TOTAL_MAX = ACTIVE_RULES.reduce((s, r) => s + (r.fn({}).max || 0), 0);

export function scoreCompany(c) {
  if (!c || c.error) {
    return {
      company: c || {},
      breakdown: [],
      deferred: DEFERRED,
      totalPoints: 0,
      totalMax: 0,
      scorePct: 0,
      hardFails: [],
      naCount: ACTIVE_RULES.length,
      tickerError: c?.error || 'No result data for this company',
    };
  }
  const breakdown = ACTIVE_RULES.map((r) => ({ ...r, ...r.fn(c) }));
  const totalPoints = breakdown.reduce((s, b) => s + b.points, 0);
  const totalMax = breakdown.reduce((s, b) => s + b.max, 0);
  const naCount = breakdown.filter((b) => b.status === 'na').length;
  const hardFails = breakdown.filter((b) => b.status === 'hard_fail').map((b) => b.label);
  return {
    company: c,
    breakdown,
    deferred: DEFERRED,
    totalPoints: Math.round(totalPoints * 100) / 100,
    totalMax,
    scorePct: totalMax ? Math.round((totalPoints / totalMax) * 100) : 0,
    hardFails,
    naCount,
  };
}

// Compact per-metric record, mirroring techVals() in tech-scoring.js. The Result Scans
// builder filters on these so a scan can test any threshold without re-deriving the maths.
export function earningsVals(c) {
  if (!c || !Array.isArray(c.quarters) || !c.quarters.length) return null;
  const q = latest(c);
  const y = yearAgo(c);
  const p = prevQ(c);
  const revYoY = y ? pctChange(q.revenue, y.revenue) : null;
  const patYoY = y ? pctChange(q.netProfit, y.netProfit) : null;
  const opYoY = y ? pctChange(q.operatingProfit, y.operatingProfit) : null;
  const opmDelta = y && num(q.opm) != null && num(y.opm) != null ? q.opm - y.opm : null;
  const series = revYoySeries(c, 4);
  const trailingAvg = series.length >= 3 ? series.slice(1).reduce((s, v) => s + v, 0) / (series.length - 1) : null;
  const epsEst = num(c?.consensus?.eps);
  const revEst = num(c?.consensus?.revenue);
  return {
    revYoY,
    patYoY,
    opYoY,
    revQoQ: p ? pctChange(q.revenue, p.revenue) : null,
    opmDelta,
    opm: num(q.opm),
    npmDelta: y && num(q.npm) != null && num(y.npm) != null ? q.npm - y.npm : null,
    revAccel: revYoY != null && trailingAvg != null ? revYoY - trailingAvg : null,
    epsSurprise: epsEst ? ((num(q.eps) - epsEst) / Math.abs(epsEst)) * 100 : null,
    revSurprise: revEst ? ((num(q.revenue) - revEst) / Math.abs(revEst)) * 100 : null,
    otherIncomeShare: num(q.pbt) > 0 && num(q.otherIncome) != null ? (q.otherIncome / q.pbt) * 100 : null,
    taxRate: num(q.pbt) > 0 && num(q.taxExpense) != null ? (q.taxExpense / q.pbt) * 100 : null,
    hasExceptional: num(q.exceptionalItems) != null ? q.exceptionalItems !== 0 : null,
    lossMaking: num(q.netProfit) != null ? q.netProfit < 0 : null,
    prevLossMaking: p && num(p.netProfit) != null ? p.netProfit < 0 : null,
  };
}

export { ACTIVE_RULES, DEFERRED };
