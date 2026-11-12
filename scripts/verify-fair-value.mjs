// scripts/verify-fair-value.mjs — offline checks for the fundamentals parser and the fair-value model.
// No server, no network: a small synthetic Screener-shaped page for the parser, constructed inputs for
// the model's branches, and the shipped fundamentals.json run through the model to prove it never
// throws and never invents a value for a company with no positive earnings.
//
//   node scripts/verify-fair-value.mjs

import { readFileSync } from 'node:fs';
import { parseScreenerFundamentals } from './lib/screener-fundamentals.mjs';
import { fairValue } from '../public/js/data/fair-value.js';

let fail = 0;
const ok = (c, m) => { if (!c) { console.error('  ✗ ' + m); fail++; } else console.log('  ✓ ' + m); };
const near = (a, b, t = 0.5) => Math.abs(a - b) <= t;

console.log('1) Parser on a synthetic Screener-shaped page');
{
  const html = `<html><body>
    <h1><span class="logo"></span>Testco Ltd <button></button></h1>
    <ul id="top-ratios">
      <li class="flex"><span class="name">Market Cap </span><span class="nowrap value">₹ <span class="number">12,345</span></span></li>
      <li class="flex"><span class="name">Current Price </span><span class="nowrap value">₹ <span class="number">500</span></span></li>
      <li class="flex"><span class="name">High / Low </span><span class="nowrap value">₹ <span class="number">600</span> / <span class="number">300</span></span></li>
      <li class="flex"><span class="name">Stock P/E </span><span class="value">20.0</span></li>
      <li class="flex"><span class="name">ROE </span><span class="value">18.5 %</span></li>
      <li class="flex"><span class="name">ROCE </span><span class="value">22.0 %</span></li>
      <li class="flex"><span class="name">Dividend Yield </span><span class="value">1.2 %</span></li>
      <li class="flex"><span class="name">Book Value </span><span class="nowrap value">₹ <span class="number">150</span></span></li>
    </ul>
    <section id="profit-loss">
      <p>Compounded Profit Growth</p>
      <table class="ranges-table"><tbody>
        <tr><td>10 Years:</td><td>12%</td></tr><tr><td>5 Years:</td><td>16%</td></tr>
        <tr><td>3 Years:</td><td>20%</td></tr><tr><td>1 Year:</td><td>25%</td></tr>
      </tbody></table>
      <table>
        <thead><tr><th></th><th>Mar 2024</th><th>Mar 2025</th><th>Mar 2026</th><th>TTM</th></tr></thead>
        <tbody>
          <tr><td><button>Sales</button></td><td>800</td><td>900</td><td>1,000</td><td>1,100</td></tr>
          <tr><td>Net Profit&nbsp;+</td><td>80</td><td>95</td><td>110</td><td>120</td></tr>
          <tr><td>OPM %</td><td>18%</td><td>19%</td><td>20%</td><td>20%</td></tr>
          <tr><td>EPS in Rs</td><td>16.0</td><td>19.0</td><td>22.0</td><td>25.0</td></tr>
        </tbody>
      </table>
    </section>
    <div class="pros" style="flex-basis:50%"><p class="title">Pros</p><ul><li>Low debt</li><li>Good ROE</li></ul></div>
    <div class="cons" style="flex-basis:50%"><p class="title">Cons</p><ul><li>Pricey</li></ul></div>
  </body></html>`;
  const f = parseScreenerFundamentals(html, { symbol: 'TESTCO', basis: 'standalone' });
  ok(f && f.name === 'Testco Ltd', 'reads the company name');
  ok(f.ratios.marketCap === 12345 && f.ratios.pe === 20 && f.ratios.roe === 18.5 && f.ratios.roce === 22, 'reads market cap, P/E, ROE, ROCE');
  ok(f.ratios.bookValue === 150 && f.ratios.divYield === 1.2, 'reads book value and dividend yield');
  ok(f.ratios.high === 600 && f.ratios.low === 300, 'splits High / Low into two numbers');
  ok(f.growth.profit && f.growth.profit.y3 === 20 && f.growth.profit.y5 === 16, 'reads compounded profit growth');
  ok(JSON.stringify(f.annual.eps) === JSON.stringify([16, 19, 22, 25]), 'reads the annual EPS row incl. TTM');
  ok(JSON.stringify(f.annual.netProfit) === JSON.stringify([80, 95, 110, 120]), 'reads the Net Profit row');
  ok(f.epsTtm === 25, 'epsTtm is the last EPS column');
  ok(f.pros.length === 2 && f.cons.length === 1, 'reads pros and cons');
  // a sparse consolidated shell (ratios list but no values) must parse to no-usable-data
  const sparse = parseScreenerFundamentals('<h1>X Ltd</h1><ul id="top-ratios"><li><span class="name">Market Cap </span><span class="value"></span></li></ul>', { symbol: 'X' });
  ok(!sparse || (!Number.isFinite(sparse.ratios.pe) && !Number.isFinite(sparse.epsTtm) && !sparse.annual.years.length), 'a sparse shell yields no usable financials');
}

console.log('2) Fair-value model branches');
{
  // healthy grower, reasonably priced → meaningful, tone around fair
  const h = fairValue({ epsTtm: 25, ratios: { pe: 20, roe: 18.5, price: 500 }, growth: { profit: { y3: 20, y5: 16 } } }, { cmp: 500 });
  ok(h.meaningful && h.fairPe > 0 && h.fairLow < h.fairHigh, 'healthy company gets a fair-value band');
  ok(h.fairLow < h.fairMid && h.fairMid < h.fairHigh, 'band brackets the mid');
  ok(['cheap', 'fair', 'rich'].includes(h.tone), 'a tone is assigned');

  // loss-making, no positive P/E → refuses honestly
  const loss = fairValue({ epsTtm: -5, ratios: { pe: null, price: 100 } });
  ok(!loss.meaningful && /no positive trailing profit/i.test(loss.reason), 'loss-making with no P/E is refused, not invented');

  // negative TTM EPS but a positive P/E (one-off) → uses Screener's normalised earnings
  const oneoff = fairValue({ epsTtm: -2.73, ratios: { pe: 27.8, price: 400, roe: 15 }, growth: { profit: { y3: 5, y5: 8 } } }, { cmp: 400 });
  ok(oneoff.meaningful, 'a one-off negative TTM EPS still values on Screener normalised earnings');
  ok(near(oneoff.eps, 400 / 27.8, 0.1), 'normalised EPS = Screener price ÷ P/E');

  // hyper-grower → fair P/E is capped
  const hot = fairValue({ epsTtm: 5, ratios: { roe: 40, price: 400 }, growth: { profit: { y3: 80, y5: 70 } } }, { cmp: 400 });
  ok(hot.fairPe <= 32, 'fair P/E is capped for a hyper-grower');

  // thin history + weak quality + high debt → limited flag and a low multiple
  const thin = fairValue({ epsTtm: 10, ratios: { pe: 30, roe: 8, price: 300, debtToEquity: 1.5 }, growth: { profit: {}, sales: {} } }, { cmp: 300 });
  ok(thin.limited === true, 'thin growth history is flagged');
  ok(thin.fairPe < 15, 'weak quality + high debt pulls the fair multiple down');
  ok(thin.tone === 'rich', 'an expensive, weak, thin-history stock reads rich');

  // conservative growth: uses the LOWER of 3y/5y profit growth
  const cons = fairValue({ epsTtm: 10, ratios: { roe: 15, price: 100 }, growth: { profit: { y3: 30, y5: 10 } } }, { cmp: 100 });
  ok(cons.inputs.growth === 10, 'growth estimate takes the lower of 3y and 5y');

  // RELATIVE valuation: when the company's own normal (median) P/E is known, value on THAT, not growth.
  // Aarti-like: no growth, but a normal P/E of 18 → fair ≈ 18 × 25 = 450, so ~445 reads FAIR (not rich).
  const rel = fairValue({ epsTtm: 25, ratios: { pe: 19.5, roe: 13, price: 445, peMedian: 18, peMedian5y: 26 }, growth: { profit: { y3: -2, y5: -5 } } }, { cmp: 445 });
  ok(rel.method === 'relative', 'uses relative valuation when a median P/E is present');
  ok(Math.round(rel.fairPe) === 18, 'fair P/E is the historical median, not the growth floor');
  ok(rel.tone === 'fair', 'a no-growth stock near its normal multiple reads FAIR, not rich');
  ok(/normally traded|its own history/i.test(rel.basis), 'the basis says it is valued on its own history');
  // growth fallback still applies when there is no median P/E
  const noMed = fairValue({ epsTtm: 25, ratios: { pe: 19.5, roe: 13, price: 445 }, growth: { profit: { y3: -2, y5: -5 } } }, { cmp: 445 });
  ok(noMed.method === 'rule', 'falls back to the growth rule when no median P/E is captured');
}

console.log('3) Shipped fundamentals.json runs through the model cleanly');
{
  let raw;
  try { raw = JSON.parse(readFileSync('public/data/fundamentals.json', 'utf8')); } catch { raw = null; }
  ok(raw && raw.companies && Object.keys(raw.companies).length > 50, 'fundamentals.json is present with the book captured');
  if (raw) {
    let meaningful = 0, refused = 0, threw = 0, badBand = 0;
    for (const [sym, rec] of Object.entries(raw.companies)) {
      let fv;
      try { fv = fairValue(rec, { cmp: null }); } catch { threw++; continue; }
      if (fv.meaningful) {
        meaningful++;
        if (!(fv.fairLow > 0 && fv.fairLow < fv.fairHigh && Number.isFinite(fv.fairMid))) { badBand++; console.error('    bad band:', sym); }
      } else refused++;
    }
    ok(threw === 0, `model never throws across ${Object.keys(raw.companies).length} companies (threw ${threw})`);
    ok(badBand === 0, 'every meaningful result has a valid positive band');
    console.log(`     → ${meaningful} valued, ${refused} refused (no positive earnings)`);
    ok(meaningful > 100, 'most of the book gets a fair value');
  }
}

console.log(fail ? `\nFAIL: ${fail} check(s) failed` : '\nPASS: all fair-value checks passed');
process.exit(fail ? 1 : 0);
