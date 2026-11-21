// scripts/build-funnel-fundamentals.mjs — build the Screener funnel's universe from the full tracked
// universe, so the funnel covers the client's ₹1,000–25,000 Cr band (~1,180 companies) instead of the
// ~209 large-caps the earlier large-cap-only capture reached. GLOW-OWNED.
//
// WHY THIS EXISTS. The funnel filters on 3-year growth, OPM, debt/equity and multi-year series. Those
// come from Screener's rich per-company pages. The earlier `funnel-fundamentals.json` only carried ~537
// large-caps with those metrics, so the whole small-cap heart of the client's universe was invisible.
// `scripts/fixtures/tracked-universe.csv` is a Screener export of the WHOLE tracked universe (~2,012
// companies incl. the small-caps) but a LEANER column set: market cap, ROCE, ROE, P/E, P/B, pledge are
// clean, OPM is derivable (EBIDT ÷ Sales), but it carries no 3-year growth and no series.
//
// So this script MERGES two honest sources, never inventing a figure:
//   • the tracked-universe CSV → the universe + its clean metrics + derived OPM / P/B,  and
//   • the rich per-company feeds (fundamentals.json's multi-year series, and the previous
//     funnel-fundamentals.json) → the 3-year growth / series, OVERLAID where a company has them.
// A company with no rich overlay keeps its clean metrics and a null for every 3-year field — null,
// never 0 — so the funnel drops it at the quantitative stage for MISSING DATA (surfaced on the tab),
// rather than on a faked number. The scheduled authenticated walk (scrape-screener-fundamentals.mjs
// over this same universe) fills those nulls over time; this file is the honest breadth layer beneath it.
//
//   node scripts/build-funnel-fundamentals.mjs
//
// Pure Node 22, no dependency. Reads only committed files; writes public/data/funnel-fundamentals.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CSV = 'scripts/fixtures/tracked-universe.csv';
const RICH_ONEPAGER = 'public/data/fundamentals.json';          // nested per-company (annual series)
const PREV_FUNNEL = 'public/data/funnel-fundamentals.json';     // the earlier flat screen rows
const WALK_RICH = 'scripts/fixtures/funnel-universe-rich.json'; // the authenticated walk's flat output
const OUT = 'public/data/funnel-fundamentals.json';

const n = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === 'NA') return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// Compound annual growth over the last `years` steps of a series, as a %. Honest only when both ends
// are present and the base is positive (a CAGR across zero or a loss is meaningless → null).
function cagr(series, years) {
  if (!Array.isArray(series) || series.length < years + 1) return null;
  const end = series[series.length - 1];
  const start = series[series.length - 1 - years];
  if (!Number.isFinite(end) || !Number.isFinite(start) || start <= 0 || end <= 0) return null;
  return round((Math.pow(end / start, 1 / years) - 1) * 100, 1);
}

// ── 1. The universe + clean metrics, from the tracked-universe CSV ──────────────────────────────────
function readCsvUniverse() {
  const lines = readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',');
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = {
    name: col('Name'), nse: col('NSE Code'), industryGroup: col('Industry Group'), industry: col('Industry'),
    cmp: col('Current Price'), mcap: col('Market Capitalization'), ebidt: col('EBIDT last year'),
    debt: col('Debt'), pledged: col('Pledged percentage'), pe: col('Price to Earning'), sales: col('Sales'),
    roce: col('Return on capital employed'), roe: col('Return on equity'), npm: col('NPM latest quarter'),
    pb: col('Price to book value'), fii: col('FII holding'), dii: col('DII holding'),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length !== header.length) continue;                    // skip any malformed row rather than mis-align
    const ticker = (p[idx.nse] || '').trim().toUpperCase();
    if (!ticker) continue;                                       // no NSE symbol → the funnel can't key it
    const mcap = n(p[idx.mcap]);
    const sales = n(p[idx.sales]);
    const ebidt = n(p[idx.ebidt]);
    rows.push({
      ticker,
      name: (p[idx.name] || '').trim(),
      screenerSlug: ticker,
      screenerUrl: `https://www.screener.in/company/${ticker}/`,
      marketCapCr: mcap,
      cmp: n(p[idx.cmp]),
      pe: n(p[idx.pe]),
      pb: n(p[idx.pb]),
      bookValue: null,
      roce: n(p[idx.roce]),
      roe: n(p[idx.roe]),
      npmPct: n(p[idx.npm]),
      // OPM is not in this export, but EBIDT ÷ Sales is the operating margin by definition — derived, honest.
      opmPct: sales != null && sales > 0 && ebidt != null ? round((ebidt / sales) * 100, 1) : null,
      pledgedPct: n(p[idx.pledged]),
      // 3-year metrics and series are NOT in this leaner export — null until the rich overlay fills them.
      salesGrowth3y: null, profitVar3y: null, epsGrowth3y: null, epsGrowth5y: null,
      debtToEquity: null, intCoverage: null, currentRatio: null, cashConversionPct: null, divYieldPct: null,
      patSeries: [], revenueSeries: [], patLy: null, revenueLy: null, cfOperationsLy: null, cfOperationsPy: null,
      chgFiiHold: null, chgDiiHold: null, chgPromHold: null,
      broadSector: (p[idx.industryGroup] || '').trim() || null,
      sector: (p[idx.industryGroup] || '').trim() || null,
      broadIndustry: (p[idx.industry] || '').trim() || null,
      industry: (p[idx.industry] || '').trim() || null,
      _clean: 'tracked-universe.csv',
    });
  }
  return rows;
}

// ── 2. Rich overlays: the 3-year growth / series, from the per-company feeds ─────────────────────────
// (a) the nested one-pager feed — compute the CAGRs from its real annual series.
function richFromOnepager() {
  if (!existsSync(RICH_ONEPAGER)) return new Map();
  const d = JSON.parse(readFileSync(RICH_ONEPAGER, 'utf8'));
  const out = new Map();
  for (const [ticker, f] of Object.entries(d.companies || {})) {
    const a = f.annual || {};
    const sales = a.sales || []; const pat = a.netProfit || a.pat || []; const eps = a.eps || []; const opm = a.opm || [];
    out.set(ticker.toUpperCase(), {
      salesGrowth3y: cagr(sales, 3), profitVar3y: cagr(pat, 3),
      epsGrowth3y: cagr(eps, 3), epsGrowth5y: cagr(eps, 5),
      opmPct: opm.length ? round(opm[opm.length - 1], 1) : null,
      debtToEquity: round(n(f.ratios?.debtToEquity), 2), roce: round(n(f.ratios?.roce), 1), roe: round(n(f.ratios?.roe), 1),
      pe: round(n(f.ratios?.pe), 2), bookValue: n(f.ratios?.bookValue),
      revenueSeries: sales.slice(-9), patSeries: pat.slice(-9),
      revenueLy: sales.length ? sales[sales.length - 1] : null, patLy: pat.length ? pat[pat.length - 1] : null,
      _rich: 'fundamentals.json',
    });
  }
  return out;
}
// (b) the earlier flat funnel rows — already in the funnel shape, so take their 3-year fields verbatim.
function richFromPrevFunnel() {
  if (!existsSync(PREV_FUNNEL)) return new Map();
  let d; try { d = JSON.parse(readFileSync(PREV_FUNNEL, 'utf8')); } catch { return new Map(); }
  const out = new Map();
  for (const c of d.companies || []) {
    if (!c.ticker) continue;
    out.set(String(c.ticker).toUpperCase(), c);
  }
  return out;
}
// (c) the authenticated universe walk's flat output (scrape-funnel-universe.mjs) — the freshest and most
// complete rich source, so it takes priority over the book one-pager and the earlier capture. Absent
// until the scheduled walk has run (needs the SCREENER_USERNAME / SCREENER_PASSWORD secrets).
function richFromWalk() {
  if (!existsSync(WALK_RICH)) return new Map();
  let d; try { d = JSON.parse(readFileSync(WALK_RICH, 'utf8')); } catch { return new Map(); }
  const out = new Map();
  for (const [ticker, rec] of Object.entries(d.companies || d || {})) {
    if (rec && typeof rec === 'object') out.set(ticker.toUpperCase(), rec);
  }
  return out;
}

const RICH_FIELDS = ['salesGrowth3y', 'profitVar3y', 'epsGrowth3y', 'epsGrowth5y', 'opmPct', 'debtToEquity',
  'intCoverage', 'currentRatio', 'cashConversionPct', 'divYieldPct', 'patSeries', 'revenueSeries',
  'patLy', 'revenueLy', 'cfOperationsLy', 'cfOperationsPy', 'chgFiiHold', 'chgDiiHold', 'chgPromHold', 'bookValue'];

function overlay(base, rich) {
  if (!rich) return base;
  for (const k of RICH_FIELDS) {
    const v = rich[k];
    const has = Array.isArray(v) ? v.length > 0 : v != null;
    const baseHas = Array.isArray(base[k]) ? base[k].length > 0 : base[k] != null;
    if (has && !baseHas) base[k] = v;
  }
  // pb from the book value, if the overlay supplied one and the CSV did not.
  if (base.pb == null && base.cmp != null && base.bookValue != null && base.bookValue > 0) base.pb = round(base.cmp / base.bookValue, 2);
  return base;
}

function main() {
  const universe = readCsvUniverse();
  const walk = richFromWalk();
  const onepager = richFromOnepager();
  const prev = richFromPrevFunnel();

  // Start from the CSV universe (breadth); fold any ticker the previous funnel had that the CSV lacks,
  // so no company we already priced is dropped.
  const byTicker = new Map(universe.map((c) => [c.ticker, c]));
  for (const [ticker, c] of prev) if (!byTicker.has(ticker)) byTicker.set(ticker, { ...c, _clean: 'prev-funnel-only' });

  let withRich = 0;
  for (const [ticker, base] of byTicker) {
    const rich = walk.get(ticker) || onepager.get(ticker) || prev.get(ticker) || null;
    overlay(base, rich);
    if (base.salesGrowth3y != null || base.profitVar3y != null) withRich++;
    delete base._clean;
  }

  const companies = [...byTicker.values()].sort((a, b) => (b.marketCapCr || 0) - (a.marketCapCr || 0));
  const inBand = companies.filter((c) => c.marketCapCr >= 1000 && c.marketCapCr <= 25000).length;

  let csvDate = null;
  try { csvDate = execSync(`git log -1 --format=%aI -- ${CSV}`, { encoding: 'utf8' }).trim() || null; } catch { /* not in git */ }

  const out = {
    generatedAt: new Date().toISOString(),
    capturedAt: csvDate,
    source: 'Screener.in tracked-universe export (universe + clean metrics) merged with the per-company '
      + 'feeds (3-year growth and series). Every figure is Screener\'s own, reproduced; OPM is EBIDT ÷ Sales. '
      + 'A company with no rich per-company read yet carries null for the 3-year fields — never 0 — and the '
      + 'funnel drops it at the quantitative stage for missing data, not on a faked number.',
    note: `${companies.length} companies (${inBand} in the ₹1,000–25,000 Cr band). ${withRich} carry 3-year `
      + 'growth from a per-company read; the rest await the scheduled authenticated walk.',
    count: companies.length,
    companies,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[funnel-universe] wrote ${OUT}: ${companies.length} companies, ${inBand} in ₹1,000–25,000 Cr band, ${withRich} with 3-year growth.`);
}

main();
