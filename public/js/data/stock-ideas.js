// data/stock-ideas.js — AI RECOMMENDATIONS: TRANSPARENT STOCK IDEAS FROM THE UNIVERSE.
//
// Yamini (22 Oct 2026): "the system itself will look at all the data that's out there and recommend
// some new names which you may want to look from the universe to add to your portfolio." / "What is
// the basis for that?"
//
// So this is a SCREEN, not advice, and the basis is always on the face of it. Every idea is a
// company from the universe that clears one or more deterministic themes defined ONLY on the
// published fundamentals (public/data/fundamentals.json — Screener ratios and multi-year growth).
// Nothing is generated and no figure is invented: each number a card shows is read straight from
// that file, with its source and the date it was captured, so "what is the basis?" is answerable to
// the rupee. Companies the family already holds are excluded — these are NEW names to research.
//
// It never says buy, sell or hold. It surfaces names and the evidence; the desk does the judging.

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const pctWord = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const opmAt = (f, back) => { const o = f?.annual?.opm; return Array.isArray(o) && o.length >= back ? n(o[o.length - back]) : null; };

// A company is big enough to research only above a small market-cap floor; below it the published
// figures are thin and the names illiquid. Not a theme — a gate on the whole universe.
export const MIN_MARKET_CAP_CR = 300;

/**
 * THE THEMES. Each is a named, deterministic reading of one company's fundamentals:
 *   `qualifies(f)` — does this company clear the theme (all inputs must be present; a missing
 *                    figure never qualifies, so a thin record is left out rather than guessed);
 *   `rankBy(f)`    — the figure the theme ranks on, so the strongest names lead;
 *   `basis(f)`     — the exact figures the reading rests on, shown on the card and in the drill.
 * Add a theme here; the tab, the filter and the test pick it up with no other change.
 */
export const THEMES = Object.freeze([
  {
    id: 'earnings-inflection',
    label: 'Earnings inflection',
    blurb: 'Recent profit growth is running well ahead of its 3-year rate while margins hold — earnings may be turning up.',
    qualifies(f) {
      const y1 = n(f.growth?.profit?.y1), y3 = n(f.growth?.profit?.y3), ttm = opmAt(f, 1), prior = opmAt(f, 3);
      return y1 != null && y3 != null && ttm != null && prior != null && y1 >= 15 && y1 > y3 + 5 && ttm >= prior;
    },
    rankBy: (f) => n(f.growth?.profit?.y1) ?? -1,
    basis: (f) => [
      ['Profit growth · latest year', pctWord(n(f.growth?.profit?.y1))],
      ['Profit growth · 3-year', pctWord(n(f.growth?.profit?.y3))],
      ['Profit growth · 5-year', pctWord(n(f.growth?.profit?.y5))],
      ['Operating margin · TTM vs ~2y ago', `${opmAt(f, 1)}% vs ${opmAt(f, 3)}%`],
    ],
  },
  {
    id: 'quality-value',
    label: 'Quality at a fair price',
    blurb: 'Strong returns on capital, and the share trades below its own five-year median P/E.',
    qualifies(f) {
      const roce = n(f.ratios?.roce), roe = n(f.ratios?.roe), pe = n(f.ratios?.pe), med = n(f.ratios?.peMedian5y);
      return roce != null && roe != null && pe != null && med != null && roce >= 18 && roe >= 15 && pe > 0 && pe < med;
    },
    rankBy: (f) => n(f.ratios?.roce) ?? -1,
    basis: (f) => [
      ['Return on capital employed', `${n(f.ratios?.roce)}%`],
      ['Return on equity', `${n(f.ratios?.roe)}%`],
      ['P/E now vs 5-year median', `${n(f.ratios?.pe)} vs ${n(f.ratios?.peMedian5y)}`],
    ],
  },
  {
    id: 'consistent-compounder',
    label: 'Consistent compounder',
    blurb: 'Sales and profit have both grown through the cycle, over five and ten years.',
    qualifies(f) {
      const s5 = n(f.growth?.sales?.y5), p5 = n(f.growth?.profit?.y5), p10 = n(f.growth?.profit?.y10);
      return s5 != null && p5 != null && p10 != null && s5 >= 12 && p5 >= 12 && p10 >= 10;
    },
    rankBy: (f) => n(f.growth?.profit?.y5) ?? -1,
    basis: (f) => [
      ['Sales growth · 5-year', pctWord(n(f.growth?.sales?.y5))],
      ['Profit growth · 5-year', pctWord(n(f.growth?.profit?.y5))],
      ['Profit growth · 10-year', pctWord(n(f.growth?.profit?.y10))],
    ],
  },
  {
    id: 'margin-expansion',
    label: 'Margin expansion',
    blurb: 'Operating margin is at least three points higher than two years ago, with sales still growing.',
    qualifies(f) {
      const ttm = opmAt(f, 1), prior = opmAt(f, 3), sTtm = n(f.growth?.sales?.ttm);
      return ttm != null && prior != null && sTtm != null && ttm >= prior + 3 && sTtm >= 8;
    },
    rankBy: (f) => { const a = opmAt(f, 1), b = opmAt(f, 3); return a != null && b != null ? a - b : -1; },
    basis: (f) => [
      ['Operating margin · TTM', `${opmAt(f, 1)}%`],
      ['Operating margin · ~2y ago', `${opmAt(f, 3)}%`],
      ['Sales growth · TTM', pctWord(n(f.growth?.sales?.ttm))],
    ],
  },
]);

export const themeById = (id) => THEMES.find((t) => t.id === id) || null;

const safe = (fn) => { try { return fn(); } catch { return false; } };

/**
 * The ideas: every company we hold fundamentals for that clears at least one theme and is above the
 * market-cap floor. Each carries the themes it cleared (strongest-ranked first) and a score that is
 * simply how many themes it clears — a company that is cheap AND compounding AND inflecting is a
 * stronger idea than one that merely clears a single screen, and the count is a reason a reader can
 * see rather than a weight nobody can check.
 *
 * A company already in the book is NOT dropped — it is flagged `held`, so the desk can filter to the
 * names it does not own ("New") or read its holdings as a conviction check. The pool of NEW names is
 * only as wide as the universe we hold multi-year fundamentals for; until that widens past the book,
 * most ideas here will be holdings, and the tab says so rather than implying a market-wide screen.
 */
export function stockIdeas(universe, isHeld = () => false) {
  const ideas = [];
  for (const f of Array.isArray(universe) ? universe : []) {
    if (!f || !f.symbol) continue;
    const mcap = n(f.ratios?.marketCap);
    if (mcap == null || mcap < MIN_MARKET_CAP_CR) continue;
    const cleared = THEMES.filter((t) => safe(() => t.qualifies(f) === true));
    if (!cleared.length) continue;
    cleared.sort((a, b) => (b.rankBy(f) ?? -1) - (a.rankBy(f) ?? -1));
    ideas.push({
      symbol: f.symbol, name: f.name || f.symbol, sector: f.sector || null, fundamentals: f,
      themes: cleared.map((t) => t.id), score: cleared.length,
      lead: cleared[0].id, held: safe(() => isHeld(f.symbol) === true),
    });
  }
  // Most themes cleared first; then the lead theme's own ranking figure; a stable, explainable order.
  ideas.sort((a, b) => b.score - a.score || (themeById(b.lead).rankBy(b.fundamentals) ?? -1) - (themeById(a.lead).rankBy(a.fundamentals) ?? -1));
  return ideas;
}

/** The basis for one idea under one theme — the figures, ready to render. */
export function ideaBasis(fundamentals, themeId) {
  const t = themeById(themeId);
  return t ? { label: t.label, blurb: t.blurb, rows: safe(() => t.basis(fundamentals)) || [] } : null;
}
