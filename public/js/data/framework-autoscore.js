// data/framework-autoscore.js — deterministic AUTO scores for the desk's Framework rubric, computed
// from the funnel fundamentals. GLOW-OWNED, pure and testable.
//
// WHY. The Framework tab is a 0/1/2 scoring grid, and the founder's rule is "everything is AI
// calculated, nothing is manual" [client call 25:07]. A blank grid the desk types into by hand is the
// opposite of that. So every criterion is auto-scored from a NAMED metric the funnel already carries,
// the desk keeps the final say (a typed score always wins and is marked as theirs), and — the honesty
// line this whole dashboard runs on — NOTHING IS INVENTED: a criterion with no data returns null, not
// a zero, and the genuinely qualitative criteria (differentiation, catalyst) carry a FINANCIAL PROXY
// that says so on its face, for the desk to confirm or override. Governance is a disqualifier, never
// auto-passed (clean governance needs a human read), only auto-FLAGGED on a hard financial red flag.
//
// The thresholds are editable defaults in one place, not gates; they are the sensible starting bands
// for the ₹1,000–25,000 Cr universe. A later LLM pass can replace the two proxy criteria with a real
// qualitative read (the client's "qualitative filter, run on AI" [39:58]); until then this is the
// honest deterministic floor, and it fills in as the authenticated walk lands each company's metrics.

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const r0 = (v) => (fin(v) ? Math.round(v) : v);

// A 0/1/2 band: 2 at or above `hi`, 1 at or above `lo`, else 0; null when the metric is absent.
export function band(v, hi, lo) { return fin(v) ? (v >= hi ? 2 : v >= lo ? 1 : 0) : null; }

// The editable default bands, one row per criterion key in framework.json.
export const AUTO_BANDS = {
  'business-quality': { hi: 20, lo: 12 },   // ROCE %
  differentiation: { hi: 25, lo: 15 },      // operating margin % (pricing-power proxy)
  'growth-runway': { hi: 18, lo: 9 },       // 3-yr sales growth %
  'catalyst-infelction': { hi: 10, lo: 3 }, // latest-year growth minus 3-yr CAGR, in pp (acceleration proxy)
  'earnings-materiality': { hi: 18, lo: 9 },// 3-yr profit growth %
};

// Each scorer returns { score: 0|1|2, basis, proxy? } or null when its metric is absent.
export const AUTO_CRITERIA = {
  'business-quality': (f) => {
    const s = band(f.roce, AUTO_BANDS['business-quality'].hi, AUTO_BANDS['business-quality'].lo);
    return s == null ? null : { score: s, basis: `ROCE ${r0(f.roce)}%${fin(f.opmPct) ? ` · OPM ${r0(f.opmPct)}%` : ''}` };
  },
  differentiation: (f) => {
    const s = band(f.opmPct, AUTO_BANDS.differentiation.hi, AUTO_BANDS.differentiation.lo);
    return s == null ? null : { score: s, basis: `Operating margin ${r0(f.opmPct)}% — pricing-power proxy, review`, proxy: true };
  },
  'growth-runway': (f) => {
    const s = band(f.salesGrowth3y, AUTO_BANDS['growth-runway'].hi, AUTO_BANDS['growth-runway'].lo);
    return s == null ? null : { score: s, basis: `Sales growth ${r0(f.salesGrowth3y)}% (3-yr)` };
  },
  'catalyst-infelction': (f) => {
    // Inflection proxy: the latest reported year's revenue growth running ABOVE the 3-yr CAGR is a
    // sign the business is accelerating. Needs the revenue series and the 3-yr figure both present.
    const rev = (f.revenueSeries || []).filter(fin);
    if (rev.length < 2 || !fin(f.salesGrowth3y) || rev[rev.length - 2] <= 0) return null;
    const ly = (rev[rev.length - 1] / rev[rev.length - 2] - 1) * 100;
    if (!fin(ly)) return null;
    const accel = ly - f.salesGrowth3y;
    const s = band(accel, AUTO_BANDS['catalyst-infelction'].hi, AUTO_BANDS['catalyst-infelction'].lo);
    return s == null ? null : { score: s, basis: `Latest year ${r0(ly)}% vs 3-yr ${r0(f.salesGrowth3y)}% — acceleration proxy, review`, proxy: true };
  },
  'earnings-materiality': (f) => {
    const s = band(f.profitVar3y, AUTO_BANDS['earnings-materiality'].hi, AUTO_BANDS['earnings-materiality'].lo);
    return s == null ? null : { score: s, basis: `Profit growth ${r0(f.profitVar3y)}% (3-yr)` };
  },
};

// Governance GATE — a disqualifier. Auto-flag a FAIL only on a hard financial red flag (heavy promoter
// pledge or extreme leverage); never auto-PASS, because confirming clean governance needs a human read.
export function autoGate(f) {
  if (!f) return null;
  if (fin(f.pledgedPct) && f.pledgedPct >= 50) return { gate: 'fail', basis: `Promoter pledge ${r0(f.pledgedPct)}%` };
  if (fin(f.debtToEquity) && f.debtToEquity >= 3) return { gate: 'fail', basis: `Debt/equity ${f.debtToEquity}×` };
  return null;
}

/** Auto-score one company's funnel record → { scores: {key→{score,basis,proxy?}}, gate|null }. */
export function autoScore(f) {
  if (!f) return { scores: {}, gate: null };
  const scores = {};
  for (const [key, fn] of Object.entries(AUTO_CRITERIA)) {
    const r = fn(f);
    if (r) scores[key] = r;
  }
  return { scores, gate: autoGate(f) };
}

/** Build a ticker→autoScore map from the funnel-fundamentals companies array. */
export function autoScoreIndex(funnelCompanies) {
  const out = new Map();
  for (const f of funnelCompanies || []) {
    if (!f || !f.ticker) continue;
    out.set(String(f.ticker).toUpperCase(), autoScore(f));
  }
  return out;
}
