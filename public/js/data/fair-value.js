// data/fair-value.js — a disciplined, transparent fair-value band for ANY company, from the Screener
// fundamentals we capture (js/data/fundamentals.js). PURE and exported, so it is tested offline.
//
// This is the one number on the fundamentals layer that is OURS, not Screener's — so it is labelled a
// guide, shows every input, and is never called a price target. It is a RELATIVE valuation (how a desk
// actually frames it), not a black-box DCF:
//
//   fair P/E   =  the multiple the stock has NORMALLY traded at — the median of its OWN P/E history
//                 (from Screener's P/E chart), clamped only against a data glitch,
//   fair value =  fair P/E  ×  trailing EPS,  as a ±15% band (no false precision).
//
// So the read is "cheap or dear versus how it usually trades?". The market's long-run multiple already
// prices the company's quality and risk, so nothing is nudged on top of it. Where a company has no
// usable P/E history (a recent listing), it FALLS BACK to a simple growth-based rule of thumb (a fair
// P/E from profit growth, nudged for ROE and debt). Every input is reproduced from Screener; only the
// combination is ours. A loss-making company with no positive EPS is refused, never invented.

const PE_FLOOR = 10;   // even a no-growth, steady earner is worth ~10× here
const PE_CAP = 28;     // we don't pay more than ~28× on growth alone, however fast
const PE_HARD = [8, 32]; // after quality nudges, keep the fallback fair multiple inside this
const PE_REL = [5, 80];  // a company's own historical median P/E; a wide clamp that only catches a data glitch
const BAND = 0.15;     // ±15% band around the point estimate

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// A conservative growth estimate: the LOWER of 3-yr and 5-yr profit growth (so one hot year doesn't
// set the multiple), falling back to sales growth, then null. Null means "no usable growth history".
function growthEstimate(f) {
  const p = f?.growth?.profit || {};
  const s = f?.growth?.sales || {};
  const prof = [p.y3, p.y5].filter(finite);
  if (prof.length) return { g: Math.min(...prof), from: 'profit growth' };
  const sales = [s.y3, s.y5].filter(finite);
  if (sales.length) return { g: Math.min(...sales), from: 'sales growth' };
  return { g: null, from: null };
}

/**
 * Compute a fair-value band for a fundamentals record.
 * @param {object} f   a record from fundamentals.json (ratios, growth, epsTtm…)
 * @param {object} opts  { cmp } — the live price to compare against (preferred over Screener's).
 * @returns {object} always an object; `meaningful:false` with a `reason` when earnings can't carry it.
 */
export function fairValue(f, { cmp = null } = {}) {
  const price = finite(cmp) ? cmp : (finite(f?.ratios?.price) ? f.ratios.price : null);

  // Earnings to value on: trailing EPS, unless it's distorted (a one-off has pushed TTM EPS to zero or
  // below) while Screener still shows a positive P/E — then use Screener's own normalised earnings
  // (its price ÷ its P/E), so a profitable company with an exceptional quarter isn't wrongly refused.
  let eps = f?.epsTtm;
  let epsBasis = 'trailing EPS';
  if (!(finite(eps) && eps > 0)) {
    const pe = f?.ratios?.pe;
    const sp = f?.ratios?.price;
    if (finite(pe) && pe > 0 && finite(sp) && sp > 0) { eps = sp / pe; epsBasis = "Screener's normalised earnings"; }
  }

  if (!finite(eps) || eps <= 0) {
    return {
      meaningful: false,
      reason: 'Not valued on earnings — the company has no positive trailing profit to anchor a multiple on.',
      price, eps: finite(f?.epsTtm) ? f.epsTtm : null,
    };
  }

  const { g, from } = growthEstimate(f);
  const roe = f?.ratios?.roe;
  const de = f?.ratios?.debtToEquity;
  const peMedian = f?.ratios?.peMedian;      // its NORMAL P/E — the median of its own P/E history (Screener)
  const peMedian5y = f?.ratios?.peMedian5y;  // the last ~5 years' median, for context

  let fairPe;
  let method;
  let basis;
  let limited = false;

  if (finite(peMedian) && peMedian > 0) {
    // RELATIVE valuation — the preferred path. Value the stock on the multiple it has HISTORICALLY
    // traded at (its "normal" P/E), so the question is "cheap or dear versus how it usually trades?"
    // The market's long-run multiple already embeds the company's quality and risk, so no growth / ROE
    // / debt nudges are applied here — that would be double-counting what the multiple already prices.
    method = 'relative';
    fairPe = clamp(peMedian, PE_REL[0], PE_REL[1]);
    const recentTxt = finite(peMedian5y) ? ` (recent 5 yrs ~${Math.round(peMedian5y)}×)` : '';
    basis = `Valued on its own history — it has normally traded at about ${Math.round(peMedian)}× earnings${recentTxt}, `
      + `applied to ${epsBasis} of ₹${eps.toFixed(1)}. A guide versus how it usually trades, not a price target.`;
  } else {
    // FALLBACK — no usable P/E history (e.g. a recent listing): a simple growth-based rule of thumb,
    // bounded, nudged up for quality (ROE) and down for high debt.
    method = 'rule';
    let base;
    if (finite(g)) base = clamp(g, PE_FLOOR, PE_CAP);
    else { base = 15; limited = true; }
    let qAdj = 1;
    if (finite(roe)) { if (roe >= 18) qAdj *= 1.10; else if (roe < 12) qAdj *= 0.88; }
    if (finite(de) && de > 1) qAdj *= 0.90;
    fairPe = clamp(base * qAdj, PE_HARD[0], PE_HARD[1]);
    const gTxt = finite(g) ? `~${Math.round(g)}% ${from}` : 'a thin growth record';
    const roeTxt = finite(roe) ? `, nudged for quality (ROE ~${Math.round(roe)}%)` : '';
    basis = `No P/E history to anchor on, so a rule of thumb — a fair P/E of about ${fairPe.toFixed(0)}× (from ${gTxt}${roeTxt}), `
      + `on ${epsBasis} of ₹${eps.toFixed(1)}. A guide, not a price target.`;
  }

  const fairPeLow = fairPe * (1 - BAND);
  const fairPeHigh = fairPe * (1 + BAND);
  const fairMid = eps * fairPe;
  const fairLow = eps * fairPeLow;
  const fairHigh = eps * fairPeHigh;

  let tone = 'fair';
  let upside = null;
  if (finite(price) && price > 0) {
    upside = fairMid / price - 1;
    if (price <= fairLow) tone = 'cheap';
    else if (price >= fairHigh) tone = 'rich';
  }

  return {
    meaningful: true,
    method,                 // 'relative' (own historical P/E) | 'rule' (growth fallback)
    eps,
    price,
    fairPe, fairPeLow, fairPeHigh,
    fairLow, fairHigh, fairMid,
    currentPe: f?.ratios?.pe ?? null,
    peMedian: finite(peMedian) ? peMedian : null,
    peMedian5y: finite(peMedian5y) ? peMedian5y : null,
    upside,                 // fraction: +0.20 = ~20% below our fair value
    tone,                   // 'cheap' | 'fair' | 'rich'
    limited,                // true when the fallback used a neutral multiple for thin growth history
    basis,
    inputs: { growth: finite(g) ? g : null, growthFrom: from, roe: finite(roe) ? roe : null, debtToEquity: finite(de) ? de : null, peMedian: finite(peMedian) ? peMedian : null },
  };
}

export const _fvInternal = { growthEstimate, clamp, PE_FLOOR, PE_CAP, PE_HARD, BAND };
