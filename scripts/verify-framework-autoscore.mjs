// verify-framework-autoscore.mjs — the Framework auto-scorer: honest deterministic scores from the
// funnel fundamentals, typed scores always overriding, no number invented. Pure, offline, no server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { band, autoScore, autoGate, autoScoreIndex, AUTO_BANDS } from '../public/js/data/framework-autoscore.js';
import { frameworkRows } from '../public/js/data/framework-rows.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  PASS', msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); console.log('  PASS', msg); passed++; };

// 1) band(): the 2/1/0 cut-points, and null for a missing metric (never 0).
eq(band(25, 20, 12), 2, 'band: at/above hi → 2');
eq(band(12, 20, 12), 1, 'band: at lo → 1');
eq(band(5, 20, 12), 0, 'band: below lo → 0');
eq(band(null, 20, 12), null, 'band: a missing metric is null, not 0');
eq(band(undefined, 20, 12), null, 'band: undefined is null');

// 2) autoScore maps each criterion to its metric; a missing metric yields no score for that criterion.
const strong = autoScore({ ticker: 'X', roce: 30, opmPct: 30, salesGrowth3y: 25, profitVar3y: 25, revenueSeries: [100, 110, 130], pledgedPct: 0, debtToEquity: 0.3 });
eq(strong.scores['business-quality'].score, 2, 'business-quality 2 from a high ROCE');
eq(strong.scores.differentiation.score, 2, 'differentiation 2 from a high OPM');
ok(strong.scores.differentiation.proxy === true, 'differentiation is marked a proxy');
eq(strong.scores['growth-runway'].score, 2, 'growth-runway 2 from high 3-yr sales growth');
eq(strong.scores['earnings-materiality'].score, 2, 'earnings-materiality 2 from high 3-yr profit growth');
ok(strong.scores['catalyst-infelction'].proxy === true, 'catalyst is marked a proxy');
ok(/ROCE 30%/.test(strong.scores['business-quality'].basis), 'the basis quotes the real metric');

// A company with no fundamentals scores nothing — not a row of zeros.
const blank = autoScore({ ticker: 'Y', roce: null, opmPct: null, salesGrowth3y: null, profitVar3y: null });
eq(Object.keys(blank.scores).length, 0, 'no metrics → no auto scores (never invented zeros)');

// A clean-metrics-only company (no 3-yr data) still auto-scores business-quality + differentiation.
const cleanOnly = autoScore({ ticker: 'Z', roce: 18, opmPct: 20, salesGrowth3y: null, profitVar3y: null, revenueSeries: [] });
eq(cleanOnly.scores['business-quality'].score, 1, 'clean ROCE alone scores business-quality');
eq(cleanOnly.scores.differentiation.score, 1, 'clean OPM alone scores differentiation');
ok(!cleanOnly.scores['growth-runway'], 'no 3-yr growth → growth-runway stays unscored');

// 3) Governance is a disqualifier: auto-FLAG a fail on a hard red flag, never auto-PASS.
eq(autoGate({ pledgedPct: 60 }).gate, 'fail', 'heavy pledge auto-flags a governance Fail');
eq(autoGate({ debtToEquity: 4 }).gate, 'fail', 'extreme leverage auto-flags a governance Fail');
eq(autoGate({ pledgedPct: 0, debtToEquity: 0.5 }), null, 'clean financials are NEVER auto-passed (left for a human)');

// 4) frameworkRows integration: a typed score overrides auto; auto fills a blank; neither → null.
const fw = {
  criteria: [{ key: 'business-quality', label: 'Business quality' }, { key: 'growth-runway', label: 'Growth runway' }],
  companies: [{ key: 'ACME', name: 'Acme', ticker: 'ACME' }],
};
const idx = autoScoreIndex([{ ticker: 'ACME', roce: 30, opmPct: 30, salesGrowth3y: 25, profitVar3y: 25 }]);
const typed = new Map([['ACME:score:business-quality', 0]]); // desk typed a 0 for business-quality
const record = { valueFor: (key, field) => typed.get(`${key}:${field}`) ?? null };
const [row] = frameworkRows(fw, record, idx);
eq(row.scores['business-quality'], 0, 'a typed score wins over the auto score');
eq(row.source['business-quality'], 'typed', 'and is marked typed');
eq(row.scores['growth-runway'], 2, 'the untyped criterion takes the auto score');
eq(row.source['growth-runway'], 'auto', 'and is marked auto');
ok(/Sales growth/.test(row.autoBasis['growth-runway']), 'the auto basis is carried to the row');
eq(row.total, 2, 'the total counts typed + auto (0 + 2)');
eq(row.typedCount, 1, 'one typed');
eq(row.autoCount, 1, 'one auto');

// a ticker with no auto entry and no typed score → null, not 0.
const fw2 = { criteria: [{ key: 'business-quality', label: 'X' }], companies: [{ key: 'NONE', name: 'None', ticker: 'NOPE' }] };
const [row2] = frameworkRows(fw2, { valueFor: () => null }, idx);
eq(row2.scores['business-quality'], null, 'no auto + no typed → null, never 0');
eq(row2.scoredCount, 0, 'and it counts as unscored');

// 5) The shipped data really auto-scores the universe.
const real = JSON.parse(readFileSync('public/data/framework.json', 'utf8'));
const ff = JSON.parse(readFileSync('public/data/funnel-fundamentals.json', 'utf8')).companies;
const realIdx = autoScoreIndex(ff);
const realRows = frameworkRows(real, { valueFor: () => null }, realIdx);
const scored = realRows.filter((r) => r.autoCount > 0).length;
ok(scored >= 150, `the shipped funnel data auto-scores the Framework universe (${scored} companies)`);
ok(realRows.every((r) => Object.values(r.scores).every((v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 2))), 'every score is 0–2 or null');

console.log(`\nverify-framework-autoscore: ${passed} checks passed`);
