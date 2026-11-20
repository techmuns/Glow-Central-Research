// scripts/lib/funnel-fundamentals.mjs
// Pure parser for the Screening Funnel's fundamentals SCREEN — one flat row per company from
// Screener.in's "fundareal" bulk screen (the LKP/klpdash approach). This is the funnel's breadth
// layer and is DELIBERATELY SEPARATE from the per-company one-pager feed
// (public/data/fundamentals.json + scripts/lib/screener-fundamentals.mjs), which covers far fewer
// companies in a nested shape and lacks the screen's cash-conversion / pledge / margin columns.
// Unifying the two Screener feeds into one source is tracked as the LKP-merge task; until then this
// file owns the flat, comparable screening row. No dependency, no I/O.

/** "22,820 Cr." / "8,71,055 Cr." / "1,234" -> 22820 / 871055 / 1234. */
export function parseCr(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').replace(/cr\.?/i, '').replace(/[₹\s]/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "3.27 %" / "157 %" / "-0.37 %" -> 3.27 / 157 / -0.37. */
export function parsePct(v) {
  if (v == null) return null;
  const s = String(v).replace(/%/g, '').replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Plain number string -> number ("29.4" -> 29.4, "7,030" -> 7030). */
export function parseNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "426|352|445" -> [426,352,445]; "" -> []. */
export function parseSeries(v) {
  if (v == null) return [];
  return String(v).split('|').map((x) => parseNum(x)).filter((x) => x != null);
}

/** Screener URL -> upper-case slug. ".../company/TCS/consolidated/" -> "TCS". */
export function screenerSlug(url) {
  const m = /\/company\/([^/]+)/.exec(String(url || ''));
  return m ? m[1].toUpperCase() : null;
}

const FIELD = {
  name: ['Company', 'Name'],
  screenerUrl: ['Screener URL', 'Url', 'URL'],
  marketCapCr: ['Market Cap', 'Market Capitalization'],
  cmp: ['Current Price', 'CMP', 'Price'],
  pe: ['Stock P/E', 'P/E', 'PE'],
  bookValue: ['Book Value'],
  divYieldPct: ['Dividend Yield'],
  roce: ['ROCE', 'Return on capital employed'],
  roe: ['ROE', 'Return on equity'],
  currentRatio: ['Current ratio'],
  intCoverage: ['Int Coverage', 'Interest Coverage'],
  debtToEquity: ['Debt to equity', 'Debt / Equity'],
  pledgedPct: ['Pledged percentage', 'Pledged %'],
  opmPct: ['OPM last year', 'OPM'],
  npmPct: ['NPM last year', 'NPM'],
  salesGrowth3y: ['Sales growth 3Years', 'Sales growth 3Yrs'],
  profitVar3y: ['Profit Var 3Yrs', 'Profit growth 3Years'],
  epsGrowth3y: ['EPS growth 3Years'],
  epsGrowth5y: ['EPS growth 5Years'],
  chgFiiHold: ['Chg in FII Hold'],
  chgDiiHold: ['Chg in DII Hold'],
  chgPromHold: ['Change in Prom Hold', 'Chg in Prom Hold'],
  cfOperationsLy: ['CF Operations LY'],
  cfOperationsPy: ['CF Operations PY'],
  broadSector: ['Broad Sector'],
  sector: ['Sector'],
  broadIndustry: ['Broad Industry'],
  industry: ['Industry'],
};

const PCT_FIELDS = new Set(['divYieldPct', 'roce', 'roe', 'pledgedPct', 'opmPct', 'npmPct', 'salesGrowth3y', 'profitVar3y', 'epsGrowth3y', 'epsGrowth5y', 'chgFiiHold', 'chgDiiHold', 'chgPromHold']);
const CR_FIELDS = new Set(['marketCapCr', 'cfOperationsLy', 'cfOperationsPy']);
const NUM_FIELDS = new Set(['cmp', 'pe', 'bookValue', 'currentRatio', 'intCoverage', 'debtToEquity']);
const TEXT_FIELDS = new Set(['name', 'screenerUrl', 'broadSector', 'sector', 'broadIndustry', 'industry']);

function pick(raw, keys) {
  for (const k of keys) if (raw[k] != null && String(raw[k]).trim() !== '') return raw[k];
  return null;
}

/** Normalise one raw Screener screen row into the funnel's flat shape. */
export function normaliseScreenRow(raw, { ticker } = {}) {
  const out = {};
  for (const [field, keys] of Object.entries(FIELD)) {
    const v = pick(raw, keys);
    if (TEXT_FIELDS.has(field)) out[field] = v == null ? null : String(v).trim();
    else if (PCT_FIELDS.has(field)) out[field] = parsePct(v);
    else if (CR_FIELDS.has(field)) out[field] = parseCr(v);
    else if (NUM_FIELDS.has(field)) out[field] = parseNum(v);
  }
  const slug = screenerSlug(out.screenerUrl);
  out.screenerSlug = slug;
  out.ticker = (ticker || slug || '').toUpperCase() || null;

  const patSeries = parseSeries(pick(raw, ['PAT Series']));
  const revenueSeries = parseSeries(pick(raw, ['Revenue Series']));
  out.patSeries = patSeries;
  out.revenueSeries = revenueSeries;
  out.patLy = patSeries.length ? patSeries[patSeries.length - 1] : null;
  out.revenueLy = revenueSeries.length ? revenueSeries[revenueSeries.length - 1] : null;

  out.cashConversionPct =
    out.cfOperationsLy != null && out.patLy != null && out.patLy > 0
      ? Math.round((out.cfOperationsLy / out.patLy) * 1000) / 10
      : null;
  out.pb =
    out.cmp != null && out.bookValue != null && out.bookValue > 0
      ? Math.round((out.cmp / out.bookValue) * 100) / 100
      : null;
  return out;
}
