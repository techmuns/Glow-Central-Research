// data/funnel-metrics.js — the numeric fields the funnel can screen on.
// The browser-side source of truth; scripts/lib/screener-fundamentals.mjs keeps a matching list
// for the scraper. `better` is the sensible default direction of a one-sided filter; `fmt` is how
// the value prints in the table and the editor.

export const FUNDAMENTAL_METRICS = [
  { key: 'marketCapCr', label: 'Market cap', unit: 'Cr', better: 'high', fmt: 'cr' },
  { key: 'roce', label: 'ROCE', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'roe', label: 'ROE', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'salesGrowth3y', label: 'Sales growth 3Y', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'profitVar3y', label: 'Profit growth 3Y', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'epsGrowth3y', label: 'EPS growth 3Y', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'epsGrowth5y', label: 'EPS growth 5Y', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'cashConversionPct', label: 'Cash conversion', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'debtToEquity', label: 'Debt / equity', unit: '×', better: 'low', fmt: 'x' },
  { key: 'intCoverage', label: 'Interest coverage', unit: '×', better: 'high', fmt: 'x' },
  { key: 'pledgedPct', label: 'Promoter pledge', unit: '%', better: 'low', fmt: 'pct' },
  { key: 'opmPct', label: 'Operating margin', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'npmPct', label: 'Net margin', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'pe', label: 'P/E', unit: '×', better: 'low', fmt: 'x' },
  { key: 'pb', label: 'P/B', unit: '×', better: 'low', fmt: 'x' },
  { key: 'divYieldPct', label: 'Dividend yield', unit: '%', better: 'high', fmt: 'pct' },
  { key: 'cmp', label: 'Price', unit: '', better: 'high', fmt: 'num' },
];

export const METRIC_FMT = {
  cr: (v) => (v == null ? '—' : v >= 100000 ? `${(v / 100000).toFixed(2)}L Cr` : `${Math.round(v).toLocaleString('en-IN')} Cr`),
  pct: (v) => (v == null ? '—' : `${v}%`),
  x: (v) => (v == null ? '—' : `${v}×`),
  num: (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-IN')),
};

export function fmtMetric(key, value) {
  const m = FUNDAMENTAL_METRICS.find((x) => x.key === key);
  const f = m && METRIC_FMT[m.fmt];
  return f ? f(value) : value == null ? '—' : String(value);
}
