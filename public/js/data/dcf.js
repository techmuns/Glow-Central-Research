// data/dcf.js — a transparent, assumptions-on-the-face DCF for ANY company we hold Screener
// fundamentals for (js/data/fundamentals.js). PURE and exported, so it is tested offline.
//
// Two readings, both driven ENTIRELY from real inputs — trailing EPS and the live price — with every
// assumption shown. Nothing is hand-authored per company and no figure is invented; this is a MODEL,
// labelled a guide, never a price target. It complements fair-value.js (a relative P/E band) with the
// two questions a desk also asks:
//
//   Forward DCF (#453)  — "what is it worth on its own cash?" A two-stage earnings-power DCF: trailing
//                         EPS compounded at a conservative growth rate for N years, then a terminal
//                         value, discounted back. Growth is the LOWER of the company's own 3- & 5-year
//                         profit growth (so one hot year can't set it), capped hard so a 10-year run at
//                         a heroic rate is impossible. Earnings are treated as owner cash — a standard
//                         simplification, stated on the face.
//
//   Reverse DCF (#454)  — "what's already in the price?" The same model, run backwards: the growth rate
//                         the market is paying for today. Compared against what the company has ACTUALLY
//                         grown, so the reader sees whether the price is demanding or undemanding.
//
// Assumptions (shown everywhere they are used): discount rate 12%, terminal growth 4%, 10-year horizon.
// A loss-making company (no positive EPS) or one with no live/again price is refused, never modelled.

const DISCOUNT = 0.12;   // cost of equity assumed for an Indian listed company — STATED, not derived
const TERMINAL = 0.04;   // long-run (perpetual) growth after the forecast horizon — below the discount
const YEARS = 10;        // explicit forecast horizon
const FWD_G_CAP = 0.14;  // the most forward growth we will assume for 10 straight years (quality compounder)
const FWD_G_FLOOR = 0.03; // and the least — a steady earner still grows with nominal GDP
const BAND = 0.12;       // ±12% band around the DCF point estimate (no false precision)

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Present value of a two-stage earnings stream: EPS grows at g for YEARS, then a Gordon terminal at
// TERMINAL. Monotonic increasing in g, which is what lets the reverse solve bisect.
function pvOfGrowth(eps, g, r = DISCOUNT, t = TERMINAL, n = YEARS) {
  let pv = 0;
  let e = eps;
  for (let y = 1; y <= n; y += 1) {
    e *= (1 + g);
    pv += e / Math.pow(1 + r, y);
  }
  // terminal value at year n, on the next year's earnings, discounted back
  const terminal = (e * (1 + t)) / (r - t);
  pv += terminal / Math.pow(1 + r, n);
  return pv;
}

// The company's own conservative growth record: the lower of 3- & 5-year profit growth (fraction),
// falling back to sales growth, then null. Same spirit as fair-value.js's growthEstimate.
function historicalGrowth(f) {
  const p = f?.growth?.profit || {};
  const s = f?.growth?.sales || {};
  const prof = [p.y3, p.y5].filter(finite);
  if (prof.length) return { g: Math.min(...prof) / 100, from: 'its own 3–5 yr profit growth' };
  const sales = [s.y3, s.y5].filter(finite);
  if (sales.length) return { g: Math.min(...sales) / 100, from: 'its own 3–5 yr sales growth' };
  return { g: null, from: null };
}

/**
 * Compute the forward + reverse DCF for a fundamentals record.
 * @param {object} f     a record from fundamentals.json (epsTtm, ratios, growth…)
 * @param {object} opts  { cmp } — the live price (preferred over Screener's stored price).
 * @returns {object} always an object; `meaningful:false` with a `reason` when it can't be modelled.
 */
export function dcf(f, { cmp = null } = {}) {
  const price = finite(cmp) ? cmp : (finite(f?.ratios?.price) ? f.ratios.price : null);

  // Earnings to value on: trailing EPS, or Screener's normalised earnings if a one-off distorted TTM
  // EPS while a positive P/E still stands (mirrors fair-value.js, so the two layers agree on earnings).
  let eps = f?.epsTtm;
  let epsBasis = 'trailing EPS';
  if (!(finite(eps) && eps > 0)) {
    const pe = f?.ratios?.pe;
    const sp = f?.ratios?.price;
    if (finite(pe) && pe > 0 && finite(sp) && sp > 0) { eps = sp / pe; epsBasis = "Screener's normalised earnings"; }
  }
  if (!finite(eps) || eps <= 0) {
    return { meaningful: false, reason: 'No positive trailing profit to run a DCF on.', price, eps: finite(f?.epsTtm) ? f.epsTtm : null };
  }
  if (!finite(price) || price <= 0) {
    return { meaningful: false, reason: 'No live price to compare the DCF against.', price: null, eps };
  }

  const assumptions = { discount: DISCOUNT, terminal: TERMINAL, years: YEARS };

  // ---- Forward DCF: value on a conservative, capped growth assumption ----
  const hist = historicalGrowth(f);
  let gUsed;
  let gSource;
  let limited = false;
  if (finite(hist.g)) { gUsed = clamp(hist.g, FWD_G_FLOOR, FWD_G_CAP); gSource = hist.from; }
  else { gUsed = 0.08; gSource = 'a conservative 8% (no clean growth record)'; limited = true; }

  const fairMid = pvOfGrowth(eps, gUsed);
  const fairLow = fairMid * (1 - BAND);
  const fairHigh = fairMid * (1 + BAND);
  const upside = fairMid / price - 1;             // +0.20 = DCF ~20% above the price
  const tone = price <= fairLow ? 'cheap' : price >= fairHigh ? 'rich' : 'fair';

  // ---- Reverse DCF: the growth the current price is paying for ----
  // Bisection on g so that pvOfGrowth(eps, g) == price. Monotonic, so it converges cleanly.
  let lo = -0.10;
  let hi = 0.60;
  let implied = null;
  if (pvOfGrowth(eps, lo) > price) {
    implied = lo;                                 // even a 10%/yr decline is worth more than the price
  } else if (pvOfGrowth(eps, hi) < price) {
    implied = hi;                                 // the price needs more than 60%/yr for 10 yrs
  } else {
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      if (pvOfGrowth(eps, mid) < price) lo = mid; else hi = mid;
    }
    implied = (lo + hi) / 2;
  }

  return {
    meaningful: true,
    eps, epsBasis, price,
    fairMid, fairLow, fairHigh, upside, tone,
    growthUsed: gUsed, growthSource: gSource, limited,
    historicalGrowth: finite(hist.g) ? hist.g : null,
    impliedGrowth: implied,
    impliedCapped: implied <= -0.10 || implied >= 0.60,
    assumptions,
  };
}

export const _dcfInternal = { pvOfGrowth, historicalGrowth, DISCOUNT, TERMINAL, YEARS, FWD_G_CAP, FWD_G_FLOOR, BAND };
