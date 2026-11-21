// data/insights-decision.js — the deterministic decision layer for the AI Insights 5-minute read.
//
// Two things the client asked for, computed from the Screener fundamentals we already hold (no model
// call, so they are exact and testable):
//
//   decisionMatrix()   the "decide in 30 seconds" grid — business quality × earnings predictability
//                      × valuation, each good/avg/weak, resolving to Look / Watchlist / Pass / Avoid.
//                      Rule (the client's): weak quality → Avoid outright; otherwise two of three green
//                      → Watchlist, all three → Look.
//
//   buyPriceModel()    the exit-price → entry-price maths. A forward multiple on projected EPS gives an
//                      exit price; discounting it back at a required IRR gives the price you'd pay today
//                      to earn that return. Every assumption is on the face and editable; a missing
//                      input yields { ok:false }, never a fabricated number.
//
// Nothing here is investment advice — it is arithmetic on disclosed figures with stated assumptions.

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

// ---- inputs pulled from a fundamentals.json record -----------------------------
export function epsOf(f) {
  if (finite(f?.epsTtm) && f.epsTtm > 0) return f.epsTtm;
  const pe = f?.ratios?.pe;
  const price = f?.ratios?.price;
  if (finite(pe) && pe > 0 && finite(price) && price > 0) return price / pe;
  return null;
}

/** Conservative annual growth as a fraction: the lower of 3- and 5-yr profit growth, capped. */
export function growthOf(f, { cap = 0.20 } = {}) {
  const p = f?.growth?.profit || {};
  const prof = [p.y3, p.y5].filter((x) => finite(x));
  let g = prof.length ? Math.min(...prof) / 100 : null;
  if (g == null) {
    const s = f?.growth?.sales || {};
    const sales = [s.y3, s.y5].filter((x) => finite(x));
    g = sales.length ? Math.min(...sales) / 100 : 0.08; // last resort: a plain 8%
  }
  return Math.max(-0.10, Math.min(cap, g));
}

/** The default exit multiple: the company's own normal P/E (5-yr median, then median, then current). */
export function defaultExitMultiple(f) {
  const r = f?.ratios || {};
  for (const k of ['peMedian5y', 'peMedian', 'pe']) if (finite(r[k]) && r[k] > 0) return { mult: r[k], source: k };
  return { mult: null, source: null };
}

const MULT_LABEL = { peMedian5y: 'its 5-yr median P/E', peMedian: 'its median P/E', pe: 'its current P/E' };

/**
 * Exit price → entry (buy) price.
 * @param f         fundamentals.json record
 * @param opts.cmp  live price (for the comparison)
 * @param opts.years, opts.requiredIrr (fraction), opts.exitMultiple (override; null = default)
 */
export function buyPriceModel(f, { cmp = null, years = 3, requiredIrr = 0.20, exitMultiple = null } = {}) {
  const eps = epsOf(f);
  const g = growthOf(f);
  const def = defaultExitMultiple(f);
  const mult = finite(exitMultiple) && exitMultiple > 0 ? exitMultiple : def.mult;
  const n = finite(years) && years > 0 ? years : 3;
  const irr = finite(requiredIrr) ? requiredIrr : 0.20;
  if (eps == null || !finite(mult) || mult <= 0) {
    return { ok: false, reason: eps == null ? 'No positive earnings to project' : 'No multiple to apply' };
  }
  const projEps = eps * Math.pow(1 + g, n);
  const exitPrice = projEps * mult;
  const buyPrice = exitPrice / Math.pow(1 + irr, n);
  const price = finite(cmp) && cmp > 0 ? cmp : null;
  // What you'd actually earn buying at today's price, and how far today's price is above the buy price.
  const impliedIrrAtCmp = price ? Math.pow(exitPrice / price, 1 / n) - 1 : null;
  const cmpVsBuy = price ? (price - buyPrice) / buyPrice : null; // >0 => CMP is above the buy price
  return {
    ok: true, eps, g, mult, years: n, requiredIrr: irr,
    multSource: finite(exitMultiple) && exitMultiple > 0 ? 'your multiple' : (MULT_LABEL[def.source] || 'its P/E'),
    projEps, exitPrice, buyPrice, price, impliedIrrAtCmp, cmpVsBuy,
  };
}

// ---- the three axes ------------------------------------------------------------
export function qualityBand(quality) {
  if (!finite(quality)) return 'unknown';
  if (quality >= 66) return 'good';
  if (quality >= 40) return 'average';
  return 'weak';
}

/** Earnings predictability from the annual net-profit record: steady & growing = high. */
export function earningsPredictability(f) {
  const years = f?.annual?.years || [];
  let series = (f?.annual?.netProfit || []).filter((x) => finite(x));
  if (years[years.length - 1] === 'TTM' && series.length === years.length) series = series.slice(0, -1);
  series = series.slice(-6);
  if (series.length < 3) return { level: 'unknown', downs: 0, losses: 0, n: series.length };
  let downs = 0, losses = 0;
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1]) downs++;
  for (const v of series) if (v <= 0) losses++;
  // Scale with the record's length: the share of years that fell, not an absolute count.
  const downRatio = downs / (series.length - 1);
  let level;
  if (losses > 0) level = 'low';
  else if (downRatio <= 0.2) level = 'high';
  else if (downRatio <= 0.4) level = 'medium';
  else level = 'low';
  return { level, downs, losses, n: series.length };
}

/** Valuation stance from today's price against the computed buy price. */
export function valuationStance(cmp, buyPrice) {
  if (!finite(cmp) || !finite(buyPrice) || cmp <= 0 || buyPrice <= 0) return 'unknown';
  const r = cmp / buyPrice;
  if (r <= 1.0) return 'under';   // at or below the price that earns the target return
  if (r <= 1.20) return 'fair';   // within 20% of it
  return 'over';
}

// ---- the matrix ----------------------------------------------------------------
const GREEN = { quality: 'good', predictability: 'high', valuation: new Set(['under', 'fair']) };

export function decisionMatrix({ quality, predictability, valuation }) {
  const q = qualityBand(quality);
  const greenQ = q === 'good';
  const greenP = predictability === 'high';
  const greenV = GREEN.valuation.has(valuation);
  const greens = [greenQ, greenP, greenV].filter(Boolean).length;

  let verdict, tone, reason;
  if (q === 'weak') {
    verdict = 'Avoid'; tone = 'bad';
    reason = 'Business quality is weak — skip it regardless of price.';
  } else if (greens >= 3) {
    verdict = 'Look'; tone = 'good';
    reason = 'Good business, predictable earnings and a fair-or-better price — worth a close look.';
  } else if (greens === 2) {
    verdict = 'Watchlist'; tone = 'watch';
    reason = `Two of the three boxes are green${greenV ? '' : ' — waiting on the price'}. Track it.`;
  } else {
    verdict = 'Pass for now'; tone = 'muted';
    reason = 'Only one box is green — not enough to act on yet.';
  }
  return {
    cells: [
      { key: 'quality', label: 'Business quality', band: q, green: greenQ },
      { key: 'predictability', label: 'Earnings predictability', band: predictability, green: greenP },
      { key: 'valuation', label: 'Valuation', band: valuation, green: greenV },
    ],
    greens, verdict, tone, reason,
  };
}

export const BAND_LABEL = {
  good: 'Good', average: 'Average', weak: 'Weak',
  high: 'High', medium: 'Medium', low: 'Low',
  under: 'Undervalued', fair: 'Fair', over: 'Overvalued',
  unknown: '—',
};
