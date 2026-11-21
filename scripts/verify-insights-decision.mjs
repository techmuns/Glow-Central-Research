// verify-insights-decision.mjs — the AI Insights decision layer (matrix + buy-price), offline.
import assert from 'node:assert/strict';
import {
  epsOf, growthOf, defaultExitMultiple, buyPriceModel, qualityBand,
  earningsPredictability, valuationStance, decisionMatrix,
  businessQualityBreakdown, clampWeight, sectorValuation, kpiTrends, sparkPoints, technicalEntry,
} from '../public/js/data/insights-decision.js';

let pass = 0, fail = 0;
const ok = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${n}\n   ${e.message}`); } };
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

ok('epsOf prefers epsTtm, falls back to price/pe', () => {
  assert.equal(epsOf({ epsTtm: 25 }), 25);
  assert.equal(epsOf({ ratios: { pe: 20, price: 400 } }), 20);
  assert.equal(epsOf({ epsTtm: -3, ratios: { pe: 20, price: 400 } }), 20); // loss ttm -> derive
  assert.equal(epsOf({}), null);
});

ok('growthOf is conservative and capped', () => {
  assert.equal(growthOf({ growth: { profit: { y3: 10, y5: 30 } } }), 0.10); // lower of the two
  assert.equal(growthOf({ growth: { profit: { y3: 50, y5: 60 } } }), 0.20); // capped at 20%
  assert.equal(growthOf({ growth: { profit: { y3: -40 } } }), -0.10);       // floored at -10%
  assert.equal(growthOf({}), 0.08);                                          // last resort
});

ok('defaultExitMultiple prefers the 5-yr median P/E', () => {
  assert.deepEqual(defaultExitMultiple({ ratios: { peMedian5y: 25.6, peMedian: 18, pe: 20 } }), { mult: 25.6, source: 'peMedian5y' });
  assert.deepEqual(defaultExitMultiple({ ratios: { pe: 20 } }), { mult: 20, source: 'pe' });
  assert.deepEqual(defaultExitMultiple({ ratios: {} }), { mult: null, source: null });
});

ok('buyPriceModel: exit = projEPS × multiple, buy = exit discounted at IRR', () => {
  // eps 10, no growth record -> 8%, 3 years, mult 20, IRR 20%
  const f = { epsTtm: 10, ratios: { peMedian5y: 20, price: 250 } };
  const r = buyPriceModel(f, { cmp: 250, years: 3, requiredIrr: 0.20, exitMultiple: null });
  assert.equal(r.ok, true);
  assert.equal(r.mult, 20);
  // projEps = 10 * 1.08^3 = 12.597; exit = 251.94; buy = 251.94 / 1.2^3 = 145.8
  assert.ok(near(r.projEps, 12.6, 0.1), `projEps ${r.projEps}`);
  assert.ok(near(r.exitPrice, 251.9, 1), `exit ${r.exitPrice}`);
  assert.ok(near(r.buyPrice, 145.8, 1), `buy ${r.buyPrice}`);
  // CMP 250 is above the 145.8 buy price
  assert.ok(r.cmpVsBuy > 0, 'cmp above buy price');
  // implied IRR at cmp = (251.9/250)^(1/3)-1 ≈ 0.25% — far below the 20% target
  assert.ok(r.impliedIrrAtCmp < 0.20, 'implied IRR at cmp below target');
});

ok('buyPriceModel refuses without positive earnings or a multiple', () => {
  assert.equal(buyPriceModel({ ratios: { peMedian5y: 20 } }, { cmp: 100 }).ok, false); // no eps
  assert.equal(buyPriceModel({ epsTtm: 10, ratios: {} }, { cmp: 100 }).ok, false);      // no multiple
});

ok('an override multiple wins and is labelled as the reader\'s', () => {
  const r = buyPriceModel({ epsTtm: 10, ratios: { peMedian5y: 20 } }, { cmp: 100, exitMultiple: 30 });
  assert.equal(r.mult, 30);
  assert.equal(r.multSource, 'your multiple');
});

ok('qualityBand thresholds', () => {
  assert.equal(qualityBand(80), 'good');
  assert.equal(qualityBand(50), 'average');
  assert.equal(qualityBand(20), 'weak');
  assert.equal(qualityBand(null), 'unknown');
});

ok('earningsPredictability reads the annual net-profit record', () => {
  const steady = { annual: { years: ['a', 'b', 'c', 'd', 'e', 'TTM'], netProfit: [10, 12, 14, 16, 18, 19] } };
  assert.equal(earningsPredictability(steady).level, 'high'); // TTM dropped, 10..18 all up
  const bumpy = { annual: { years: ['a', 'b', 'c', 'd', 'e'], netProfit: [10, 8, 14, 9, 18] } };
  assert.equal(earningsPredictability(bumpy).level, 'low');   // 2+ down-years
  const loss = { annual: { years: ['a', 'b', 'c', 'd'], netProfit: [10, -2, 14, 16] } };
  assert.equal(earningsPredictability(loss).level, 'low');    // a loss year
  assert.equal(earningsPredictability({ annual: { netProfit: [10] } }).level, 'unknown');
});

ok('valuationStance: at/below buy = under, within 20% = fair, else over', () => {
  assert.equal(valuationStance(100, 110), 'under'); // cmp below buy
  assert.equal(valuationStance(110, 100), 'fair');  // 10% above
  assert.equal(valuationStance(150, 100), 'over');  // 50% above
  assert.equal(valuationStance(null, 100), 'unknown');
});

ok('decisionMatrix: weak quality is Avoid regardless', () => {
  const m = decisionMatrix({ quality: 20, predictability: 'high', valuation: 'under' });
  assert.equal(m.verdict, 'Avoid');
});
ok('decisionMatrix: all three green is Look', () => {
  const m = decisionMatrix({ quality: 80, predictability: 'high', valuation: 'fair' });
  assert.equal(m.verdict, 'Look');
  assert.equal(m.greens, 3);
});
ok('decisionMatrix: two green is Watchlist', () => {
  const m = decisionMatrix({ quality: 80, predictability: 'high', valuation: 'over' });
  assert.equal(m.verdict, 'Watchlist');
  assert.equal(m.greens, 2);
});
ok('decisionMatrix: one green is Pass for now', () => {
  const m = decisionMatrix({ quality: 50, predictability: 'low', valuation: 'under' });
  assert.equal(m.verdict, 'Pass for now');
});

// ---- business-quality breakdown ------------------------------------------------
ok('clampWeight bounds 0..3, defaults 1', () => {
  assert.equal(clampWeight(2), 2);
  assert.equal(clampWeight(5), 3);
  assert.equal(clampWeight(-1), 0);
  assert.equal(clampWeight(undefined), 1);
  assert.equal(clampWeight('x'), 1);
});
ok('businessQualityBreakdown scores five params 0–2 and totals 0–10', () => {
  const f = {
    ratios: { roce: 28, debtToEquity: null }, // null D/E -> debt-free -> 2
    growth: { profit: { y3: 25 } },            // >=15 -> 2
    annual: { years: ['a', 'b', 'c', 'd', 'e'], opm: [20, 21, 22, 21, 20], netProfit: [10, 12, 14, 16, 18] },
  };
  const b = businessQualityBreakdown(f);
  assert.equal(b.params.length, 5);
  const by = Object.fromEntries(b.params.map((p) => [p.key, p.score]));
  assert.equal(by.returns, 2);        // roce 28
  assert.equal(by.growth, 2);         // 25%
  assert.equal(by.balance, 2);        // debt-free
  assert.equal(by.margins, 2);        // opm 20
  assert.equal(by.consistency, 2);    // steady rise
  assert.equal(b.total, 10);          // all 2s, equal weights -> 10/10
  assert.equal(b.band, 'good');
});
ok('a param with no data is shown but not counted', () => {
  const f = { ratios: { roce: 28 }, growth: {}, annual: {} }; // only returns scorable
  const b = businessQualityBreakdown(f);
  assert.equal(b.scored, 1);
  assert.equal(b.total, 10); // 2/2 over the one scorable param
  const growth = b.params.find((p) => p.key === 'growth');
  assert.equal(growth.score, null);
  assert.match(growth.note, /not available/);
});
ok('weights tilt the total', () => {
  const f = {
    ratios: { roce: 28, debtToEquity: 3 }, // returns 2, balance 0
    growth: { profit: { y3: 2 } },         // growth 0
    annual: { opm: [5], netProfit: [10, 8, 6] }, // margins 0, consistency low 0
  };
  const even = businessQualityBreakdown(f).total;              // mostly 0s, one 2 -> 2/10
  const heavyReturns = businessQualityBreakdown(f, { returns: 3, growth: 0, balance: 0, margins: 0, consistency: 0 }).total;
  assert.ok(heavyReturns > even, `weighting returns lifts the score (${even} -> ${heavyReturns})`);
  assert.equal(heavyReturns, 10); // only returns counts, and it is a 2
});

// ---- sector valuation ----------------------------------------------------------
ok('sectorValuation uses P/B for lenders, P/E for the rest', () => {
  const bank = sectorValuation({ ratios: { price: 180, bookValue: 100 } }, 'Banks');
  assert.equal(bank.metric, 'P/B');
  assert.equal(bank.value, 1.8);
  const nbfc = sectorValuation({ ratios: { price: 180, bookValue: 100 } }, 'NBFC & Housing Finance');
  assert.equal(nbfc.metric, 'P/B');
  const fin = sectorValuation({ ratios: { price: 180, bookValue: 100 } }, 'Financials');
  assert.equal(fin.metric, 'P/B'); // the bare "Financials" label lenders carry in the feed
  const auto = sectorValuation({ ratios: { pe: 20, peMedian5y: 25 } }, 'Auto OEMs');
  assert.equal(auto.metric, 'P/E');
  assert.equal(auto.value, 20);
  assert.equal(auto.stance, 'cheap vs its own history'); // 20/25 = 0.8 <= 0.85
});
ok('sectorValuation reads P/E against the company\'s own median', () => {
  assert.equal(sectorValuation({ ratios: { pe: 30, peMedian5y: 25 } }, 'IT').stance, 'rich vs its own history');
  assert.equal(sectorValuation({ ratios: { pe: 26, peMedian5y: 25 } }, 'IT').stance, 'about its own historical average');
});
ok('sectorValuation returns null when the metric can\'t be formed', () => {
  assert.equal(sectorValuation({ ratios: {} }, 'IT'), null);              // no P/E
  assert.equal(sectorValuation({ ratios: { price: 100 } }, 'Banks'), null); // no book value
});

// ---- KPI trends ----------------------------------------------------------------
ok('kpiTrends drops TTM, keeps last 10, carries CAGRs', () => {
  const f = {
    annual: {
      years: ['Mar 2022', 'Mar 2023', 'Mar 2024', 'Mar 2025', 'Mar 2026', 'TTM'],
      sales: [100, 120, 140, 160, 180, 200],
      netProfit: [10, 12, 14, 16, 18, 20],
      opm: [18, 19, 20, 21, 22, 22],
    },
    growth: { sales: { y3: 21, y5: 17, y10: 10 }, profit: { y3: 25, y5: 25, y10: 16 } },
  };
  const t = kpiTrends(f);
  assert.deepEqual(t.revenue.series, [100, 120, 140, 160, 180]); // TTM 200 dropped
  assert.deepEqual(t.profit.series, [10, 12, 14, 16, 18]);
  assert.equal(t.revenue.cagr.y3, 21);
  assert.equal(t.margin.latest, 22);
  assert.equal(t.years.length, 5);
});
ok('kpiTrends returns null for a series too short to chart', () => {
  const t = kpiTrends({ annual: { years: ['a'], sales: [100] }, growth: {} });
  assert.equal(t.revenue, null);
});
ok('sparkPoints normalises to [0,1] with first and last at the extremes', () => {
  const pts = sparkPoints([10, 20, 30, 40, 50]);
  assert.equal(pts.length, 5);
  assert.equal(pts[0].y, 0);   // min
  assert.equal(pts[4].y, 1);   // max
  assert.equal(pts[0].x, 0);
  assert.equal(pts[4].x, 1);
  assert.equal(sparkPoints([5]).length, 0); // too short
});

// A5.6 — the technical entry read (the client's second path to a buy price).
ok('technicalEntry: null row → null', () => { assert.equal(technicalEntry(null), null); });
ok('technicalEntry: oversold near a support → good pullback verdict', () => {
  const e = technicalEntry({ cmp: 100, sma50: 98, sma200: 90, rsi14: 28, volume_ratio_10d: 1.0, high_52w: 150 });
  assert.equal(e.rsiState, 'oversold');
  assert.equal(e.tone, 'good');
  assert.match(e.verdict, /pullback|Cooled/);
  assert.ok(e.supports.length >= 1);
});
ok('technicalEntry: overbought at the 52-wk high → extended, wait', () => {
  const e = technicalEntry({ cmp: 149, sma50: 120, sma200: 100, rsi14: 78, volume_ratio_10d: 1.1, high_52w: 150 });
  assert.equal(e.rsiState, 'overbought');
  assert.equal(e.tone, 'bad');
  assert.match(e.verdict, /Extended/);
});
ok('technicalEntry: breakout + accelerating volume → momentum entry', () => {
  const e = technicalEntry({ cmp: 110, sma50: 100, sma200: 95, rsi14: 60, volume_ratio_10d: 2.0, high_52w: 130, consolidation_breakout: true });
  assert.equal(e.volState, 'accelerating');
  assert.match(e.verdict, /Momentum/);
  assert.equal(e.tone, 'good');
});
ok('technicalEntry: supports are the MAs below the price, nearest first', () => {
  const e = technicalEntry({ cmp: 100, sma50: 95, sma200: 80, rsi14: 50, volume_ratio_10d: 1 });
  assert.equal(e.supports[0].label, '50-DMA');
  assert.ok(e.supports[0].distPct < e.supports[1].distPct);
});
ok('technicalEntry: price below all MAs → no supports, never throws', () => {
  const e = technicalEntry({ cmp: 70, sma50: 95, sma200: 100, rsi14: 45, volume_ratio_10d: 0.5 });
  assert.equal(e.supports.length, 0);
  assert.equal(e.volState, 'quiet');
  assert.equal(typeof e.verdict, 'string');
});
ok('technicalEntry: a missing figure drops out — no invented number', () => {
  const e = technicalEntry({ cmp: 100, sma50: 98 });
  assert.equal(e.rsi, null);
  assert.equal(e.rsiState, null);
  assert.equal(e.volState, null);
});

console.log(`\nverify-insights-decision: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
