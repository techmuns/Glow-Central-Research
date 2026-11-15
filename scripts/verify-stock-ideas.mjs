// Offline oracle for the AI Recommendations screen (data/stock-ideas.js): every pick clears a named
// theme on present figures, held names are flagged not dropped, the market-cap floor holds, and a
// thin record is never guessed into an idea.
import assert from 'node:assert/strict';
import { stockIdeas, THEMES, ideaBasis, themeById, MIN_MARKET_CAP_CR } from '../public/js/data/stock-ideas.js';

const co = (symbol, over = {}) => ({
  symbol, name: `${symbol} Ltd`, sector: 'Test',
  ratios: { marketCap: 5000, pe: 15, peMedian5y: 25, roce: 22, roe: 18, ...(over.ratios || {}) },
  growth: { sales: { ttm: 20, y5: 15, y10: 12 }, profit: { y1: 30, y3: 10, y5: 14, y10: 11 }, ...(over.growth || {}) },
  annual: { opm: [10, 12, 16], ...(over.annual || {}) },
  epsTtm: 20, fetchedAt: '2026-11-15T00:00:00Z',
});

// A strong all-round name clears several themes, each with a basis.
let ideas = stockIdeas([co('STRONG')]);
assert.equal(ideas.length, 1);
assert.ok(ideas[0].themes.length >= 2, 'a strong name clears multiple themes');
assert.equal(ideas[0].score, ideas[0].themes.length, 'score is the count of themes cleared');
for (const id of ideas[0].themes) assert.ok(ideaBasis(ideas[0].fundamentals, id).rows.length > 0, `theme ${id} shows its basis`);
assert.ok(Number.isFinite(themeById(ideas[0].lead).rankBy(ideas[0].fundamentals)), 'the lead theme ranks on a real figure');

// Held is flagged, never dropped — the pool is the universe we hold fundamentals for.
ideas = stockIdeas([co('HELD'), co('NEW')], (s) => s === 'HELD');
assert.equal(ideas.length, 2, 'held names are kept, flagged, not excluded');
assert.equal(ideas.find((i) => i.symbol === 'HELD').held, true);
assert.equal(ideas.find((i) => i.symbol === 'NEW').held, false);

// The market-cap floor holds.
assert.equal(stockIdeas([co('TINY', { ratios: { marketCap: MIN_MARKET_CAP_CR - 1 } })]).length, 0, 'below the floor is excluded');

// A thin record is never guessed into an idea.
assert.equal(stockIdeas([{ symbol: 'THIN', ratios: { marketCap: 5000 } }]).length, 0, 'no growth data → no idea');

// A dull name clears nothing.
assert.equal(stockIdeas([co('DULL', { growth: { sales: { ttm: 1, y5: 1, y10: 1 }, profit: { y1: 1, y3: 1, y5: 1, y10: 1 } }, ratios: { marketCap: 5000, pe: 40, peMedian5y: 20, roce: 5, roe: 5 }, annual: { opm: [12, 12, 12] } })]).length, 0, 'a dull name is no idea');

// Earnings inflection specifically: accelerating profit with margins holding.
const infl = stockIdeas([co('INFL', { growth: { profit: { y1: 25, y3: 5, y5: 8, y10: 7 } }, annual: { opm: [10, 11, 13] }, ratios: { marketCap: 5000, pe: 40, peMedian5y: 20, roce: 5, roe: 5 } })]);
assert.ok(infl.length === 1 && infl[0].themes.includes('earnings-inflection'), 'accelerating profit + holding margin → inflection');

// Quality-at-a-fair-price: cheap vs its own history, strong returns.
const qv = stockIdeas([co('QUAL', { growth: { sales: { ttm: 2, y5: 2, y10: 2 }, profit: { y1: 2, y3: 2, y5: 2, y10: 2 } }, annual: { opm: [15, 15, 15] }, ratios: { marketCap: 5000, pe: 12, peMedian5y: 22, roce: 25, roe: 20 } })]);
assert.ok(qv.length === 1 && qv[0].themes.includes('quality-value'), 'high ROCE/ROE + below median P/E → quality-value');

console.log(`stock-ideas: ${THEMES.length} themes, all checks passed`);
