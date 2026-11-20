// verify-funnel.mjs — the Screening Funnel engine + fundamental parser, offline.
// Run: node scripts/verify-funnel.mjs   (no server, no egress)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseCr, parsePct, parseNum, parseSeries, screenerSlug, normaliseScreenRow,
} from './lib/funnel-fundamentals.mjs';
import {
  runFunnel, defaultConfig, passesFilter, sectorCounts, missingDataCount,
} from '../public/js/data/funnel.js';

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n   ${e.message}`); } };

// ---- parsers ------------------------------------------------------------------
ok('parseCr strips commas and Cr.', () => {
  assert.equal(parseCr('22,820 Cr.'), 22820);
  assert.equal(parseCr('8,71,055 Cr.'), 871055);
  assert.equal(parseCr('1,234'), 1234);
  assert.equal(parseCr(''), null);
  assert.equal(parseCr('-'), null);
  assert.equal(parseCr(null), null);
});
ok('parsePct strips the percent', () => {
  assert.equal(parsePct('3.27 %'), 3.27);
  assert.equal(parsePct('157 %'), 157);
  assert.equal(parsePct('-0.37 %'), -0.37);
  assert.equal(parsePct('0.00 %'), 0);
  assert.equal(parsePct(''), null);
});
ok('parseNum and parseSeries', () => {
  assert.equal(parseNum('7,030'), 7030);
  assert.equal(parseNum('29.4'), 29.4);
  assert.deepEqual(parseSeries('426|352|445'), [426, 352, 445]);
  assert.deepEqual(parseSeries(''), []);
});
ok('screenerSlug reads the symbol', () => {
  assert.equal(screenerSlug('https://www.screener.in/company/TCS/consolidated/'), 'TCS');
  assert.equal(screenerSlug('https://www.screener.in/company/PGHH/'), 'PGHH');
  assert.equal(screenerSlug(''), null);
});

ok('normaliseScreenRow: numbers, cash conversion, P/B, nulls', () => {
  const row = normaliseScreenRow({
    Company: 'Test Co', 'Screener URL': 'https://www.screener.in/company/TESTCO/consolidated/',
    'Market Cap': '12,500 Cr.', 'Current Price': '1,000', 'Stock P/E': '20.0', 'Book Value': '250',
    'Dividend Yield': '1.50 %', ROCE: '25 %', ROE: '18 %', 'Debt to equity': '0.30',
    'Sales growth 3Years': '15 %', 'Profit Var 3Yrs': '20 %', 'CF Operations LY': '80',
    'PAT Series': '40|50|60|100', 'Revenue Series': '500|600|700|800', 'Broad Sector': 'Industrials', Sector: 'Capital Goods',
  });
  assert.equal(row.ticker, 'TESTCO');
  assert.equal(row.marketCapCr, 12500);
  assert.equal(row.pe, 20);
  assert.equal(row.roce, 25);
  assert.equal(row.debtToEquity, 0.3);
  assert.equal(row.patLy, 100);
  assert.equal(row.cashConversionPct, 80); // 80/100 = 80%
  assert.equal(row.pb, 4); // 1000/250
  assert.equal(row.broadSector, 'Industrials');
});
ok('cash conversion is null on a loss (never a fabricated 0)', () => {
  const row = normaliseScreenRow({ 'Screener URL': 'x/company/L/', 'CF Operations LY': '80', 'PAT Series': '10|-20' });
  assert.equal(row.patLy, -20);
  assert.equal(row.cashConversionPct, null);
});
ok('P/B null when book value missing', () => {
  const row = normaliseScreenRow({ 'Screener URL': 'x/company/N/', 'Current Price': '100' });
  assert.equal(row.pb, null);
});

// ---- passesFilter -------------------------------------------------------------
ok('passesFilter modes', () => {
  const c = { roce: 20, pe: 30, debtToEquity: 0.5 };
  assert.equal(passesFilter(c, { enabled: true, metric: 'roce', mode: 'gte', min: 15 }), true);
  assert.equal(passesFilter(c, { enabled: true, metric: 'roce', mode: 'gte', min: 25 }), false);
  assert.equal(passesFilter(c, { enabled: true, metric: 'debtToEquity', mode: 'lte', max: 1 }), true);
  assert.equal(passesFilter(c, { enabled: true, metric: 'pe', mode: 'between', min: 10, max: 40 }), true);
  assert.equal(passesFilter(c, { enabled: true, metric: 'pe', mode: 'between', min: 10, max: 25 }), false);
  assert.equal(passesFilter(c, { enabled: false, metric: 'roce', mode: 'gte', min: 99 }), true); // disabled = pass
});
ok('a null metric fails its filter (can not confirm a pass)', () => {
  assert.equal(passesFilter({ roce: null }, { enabled: true, metric: 'roce', mode: 'gte', min: 15 }), false);
});

// ---- runFunnel on a constructed universe --------------------------------------
const UNIV = [
  { ticker: 'A', name: 'A', marketCapCr: 5000, broadSector: 'Industrials', roce: 25, salesGrowth3y: 15, profitVar3y: 15, debtToEquity: 0.2 },
  { ticker: 'B', name: 'B', marketCapCr: 40000, broadSector: 'Industrials', roce: 30, salesGrowth3y: 20, profitVar3y: 20, debtToEquity: 0.1 }, // too big
  { ticker: 'C', name: 'C', marketCapCr: 8000, broadSector: 'Commodities', roce: 25, salesGrowth3y: 12, profitVar3y: 12, debtToEquity: 0.3 },
  { ticker: 'D', name: 'D', marketCapCr: 3000, broadSector: 'Industrials', roce: 5, salesGrowth3y: 2, profitVar3y: 2, debtToEquity: 2.0 }, // weak quant
  { ticker: 'E', name: 'E', marketCapCr: 2000, broadSector: 'Industrials', roce: null, salesGrowth3y: null, profitVar3y: null, debtToEquity: null }, // missing data
];

ok('default funnel narrows by stage', () => {
  const res = runFunnel(UNIV, defaultConfig(), {});
  const by = Object.fromEntries(res.steps.map((s) => [s.id, s.after]));
  assert.equal(by.universe, 5);
  assert.equal(by.marketCap, 4); // B dropped (40000)
  assert.equal(res.byStage.marketCap.every((c) => c.ticker !== 'B'), true);
});
ok('sector exclude drops the sector', () => {
  const cfg = { ...defaultConfig(), excludeSectors: ['Commodities'] };
  const res = runFunnel(UNIV, cfg, {});
  assert.equal(res.byStage.sector.some((c) => c.ticker === 'C'), false);
});
ok('quantitative drops weak + missing-data companies', () => {
  const res = runFunnel(UNIV, defaultConfig(), {});
  const quant = res.byStage.quant.map((c) => c.ticker);
  assert.equal(quant.includes('A'), true);
  assert.equal(quant.includes('D'), false); // weak
  assert.equal(quant.includes('E'), false); // missing data can't confirm a pass
});
ok('match ANY is looser than match ALL', () => {
  const all = runFunnel(UNIV, { ...defaultConfig(), match: 'all' }, {}).byStage.quant.length;
  const any = runFunnel(UNIV, { ...defaultConfig(), match: 'any' }, {}).byStage.quant.length;
  assert.ok(any >= all, `any(${any}) >= all(${all})`);
});
ok('inflection rescue keeps a failing company flagged, only when enabled', () => {
  const inflection = new Set(['D']);
  const kept = runFunnel(UNIV, { ...defaultConfig(), keepInflection: true }, { inflection });
  const d = kept.byStage.quant.find((c) => c.ticker === 'D');
  assert.ok(d, 'D rescued');
  assert.equal(d._rescued, true);
  const notKept = runFunnel(UNIV, { ...defaultConfig(), keepInflection: false }, { inflection });
  assert.equal(notKept.byStage.quant.some((c) => c.ticker === 'D'), false);
});
ok('qualitative gate uses the framework map when enabled', () => {
  const fw = new Map([['A', { total: 8, gate: 'pass', scoredCount: 5 }], ['C', { total: 3, gate: 'fail', scoredCount: 5 }]]);
  const cfg = { ...defaultConfig(), excludeSectors: [], qualitative: { enabled: true, requireGovPass: true, minTotal: 5 } };
  const res = runFunnel(UNIV, cfg, { framework: fw });
  const q = res.byStage.qualitative.map((c) => c.ticker);
  assert.equal(q.includes('A'), true);   // scored 8, gov pass
  assert.equal(q.includes('C'), false);  // gov fail (also excluded earlier if commodity, but gate would drop it)
  assert.equal(q.includes('B'), false);  // unscored -> can't confirm
});
ok('sectorCounts + missingDataCount', () => {
  const sc = sectorCounts(UNIV);
  assert.equal(sc.find((s) => s.sector === 'Industrials').count, 4);
  const miss = missingDataCount(UNIV, defaultConfig().quant);
  assert.equal(miss, 1); // only E has all-null for the enabled criteria
});

// ---- the shipped snapshot is well-formed --------------------------------------
ok('shipped screener-fundamentals.json is well-formed', () => {
  const doc = JSON.parse(fs.readFileSync(new URL('../public/data/funnel-fundamentals.json', import.meta.url)));
  assert.ok(Array.isArray(doc.companies) && doc.companies.length > 200, 'has companies');
  assert.ok(doc.capturedAt, 'has a capture date');
  for (const c of doc.companies.slice(0, 50)) {
    assert.ok(c.ticker, 'row has a ticker');
    assert.ok(c.marketCapCr == null || typeof c.marketCapCr === 'number', 'market cap is numeric or null');
    assert.ok(c.roce == null || typeof c.roce === 'number', 'roce numeric or null');
  }
  const res = runFunnel(doc.companies, defaultConfig(), {});
  assert.ok(res.survivors.length > 0 && res.survivors.length < doc.companies.length, 'funnel narrows the real universe');
});

console.log(`\nverify-funnel: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
