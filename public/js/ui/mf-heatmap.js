// ui/mf-heatmap.js — the Mutual Funds performance heatmap: how a return cell is shaded.
//
//   peerHeat(value, peers)        a scheme's cell, shaded by where it sits among its own category
//   gapHeat(gapPp, period)        a category-vs-benchmark cell, shaded by the size of the gap
//   HEAT_LEGEND                   the legend the tab prints, so the shading explains itself
//   percentileOf(value, peers)    the reading behind peerHeat, exported so it can be tested
//
// EMERALD AND ROSE, NEVER THE BRAND RAMP. Above the middle of its category is good and below it is
// bad, and that is a semantic reading — so it takes the semantic slots. CLAUDE.md is explicit that
// the brand gold may never mean "good" and that emerald/amber/rose may never mean "branded"; a gold
// heatmap would break both halves of that rule at once. Amber is deliberately unused here: it means
// PARTIAL in this codebase's vocabulary, and a mid-table fund is not a partial pass.
//
// EVERY CLASS STRING IS WRITTEN OUT IN FULL, AND THAT IS LOAD-BEARING.
//   The stylesheet is precompiled by scanning `./public/**/*.{html,js}` for candidate class names.
//   The scanner reads TEXT — it does not evaluate anything — so `` `bg-emerald-${step}` `` produces
//   a class that exists in the DOM and in no stylesheet: the cell renders with no background at
//   all, nothing throws, and the heatmap is simply invisible. Literal strings in the arrays below
//   are found; a composed one never is. If you add a step, write the whole class and rebuild:
//     npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i scripts/tailwind-input.css -o public/css/tailwind.css --minify
//
// THE NUMBER IN THE CELL IS ALWAYS THE SOURCE'S OWN. The shading is the only thing derived here,
// and what it is derived from is stated on screen in HEAT_LEGEND rather than left to be guessed
// from the colour. A tint that means something the reader has to infer is a judgement without its
// reason beside it — the thing every badge in this codebase carries one for.

// Cell backgrounds, palest first. 50/100/200 are the only steps light enough to carry the dark
// figure printed on top of them; 300 and darker would need white text, and a numeric column that
// changes its text colour by value is far harder to read down than one that does not.
const ABOVE = ['bg-emerald-50', 'bg-emerald-100', 'bg-emerald-200'];
const BELOW = ['bg-rose-50', 'bg-rose-100', 'bg-rose-200'];
// The middle of the category is not a finding, so it gets no fill at all rather than a grey one —
// a shaded "neutral" reads as a fourth verdict.
const NEUTRAL = '';

// A cell whose figure is ABSENT is never shaded. A scheme too young for the period has no return,
// and tinting an em dash would place it somewhere in a ranking it is not in.
const NONE = { className: '', title: null, band: 'none' };

/**
 * Where `value` sits among `peers`, as a percentage of the peers at or below it (0–100).
 *
 * A COUNT, NOT A MODEL. This is the same kind of reading as the AmfiBeas peer rank on the other
 * sub-view: how many of the schemes in this category, over this period, this one beat. Nothing is
 * weighted, scaled or fitted. `peers` must already be the category's returns for that one period,
 * absences removed — a null counted as a zero would rank a scheme that reported nothing above every
 * scheme that lost money.
 */
export function percentileOf(value, peers) {
  if (typeof value !== 'number' || !Array.isArray(peers) || peers.length < 2) return null;
  const below = peers.reduce((n, p) => n + (p < value ? 1 : 0), 0);
  const equal = peers.reduce((n, p) => n + (p === value ? 1 : 0), 0);
  // Midpoint of the tied block, so two identical returns share one position instead of one of them
  // arbitrarily out-ranking the other.
  return ((below + equal / 2) / peers.length) * 100;
}

/**
 * A scheme's cell: shaded by where it sits among the schemes in its OWN category, for that period.
 *
 * Why a percentile rather than a distance from the median: the distances are not comparable between
 * periods. A week's spread across a category is a fraction of a point and five years' is tens of
 * points, so one set of percentage-point thresholds paints every 1W cell neutral and every 5Y cell
 * saturated — a heatmap that is brightest wherever the window is longest, which is a fact about the
 * calendar rather than about the funds. A percentile is the same measurement in every column.
 *
 * The bands are quartiles, which is also why the wording works: above the median is the top half.
 *
 * `peers` is the category's returns for this period with absences removed. Fewer than two peers is
 * not a ranking, so nothing is shaded — a lone scheme is not "top of its category".
 */
export function peerHeat(value, peers, { period = null } = {}) {
  const pct = percentileOf(value, peers);
  if (pct == null) return NONE;
  const n = peers.length;
  const where = period ? ` over ${period}` : '';
  const rank = n - Math.round((pct / 100) * n) + 1;
  const detail = `${ordinal(Math.min(Math.max(rank, 1), n))} of ${n} in its category${where}`;
  if (pct >= 87.5) return { className: ABOVE[2], title: `Top eighth of its category — ${detail}`, band: 'above-3' };
  if (pct >= 75) return { className: ABOVE[1], title: `Top quartile — ${detail}`, band: 'above-2' };
  if (pct > 50) return { className: ABOVE[0], title: `Above the category median — ${detail}`, band: 'above-1' };
  if (pct === 50) return { className: NEUTRAL, title: `At the category median — ${detail}`, band: 'median' };
  if (pct > 25) return { className: BELOW[0], title: `Below the category median — ${detail}`, band: 'below-1' };
  if (pct > 12.5) return { className: BELOW[1], title: `Bottom quartile — ${detail}`, band: 'below-2' };
  return { className: BELOW[2], title: `Bottom eighth of its category — ${detail}`, band: 'below-3' };
}

// HOW BIG A GAP HAS TO BE BEFORE IT IS SHADED, per period, in PERCENTAGE POINTS.
//
// The category-vs-benchmark view has no peer group to rank against — there is one category median
// and one index return — so here the size of the gap is the reading, and a threshold has to be
// stated rather than derived. These are stated constants for exactly that reason, printed in the
// legend and carried into the export, the way daily-alerts.js publishes MOVE_PCT: a threshold the
// reader cannot see is a judgement they cannot check.
//
// They widen with the window because a week and a year are not the same distance, and 3Y/5Y are
// ANNUALISED in this workbook, so a point of annualised excess is a large gap rather than a small
// one — which is why they are tighter than 1Y rather than wider.
export const GAP_BAND_PP = { '1W': 0.25, '1M': 0.75, '3M': 1.5, '6M': 2, '1Y': 2.5, '3Y': 1.5, '5Y': 1.5, SI: 2 };

/**
 * A category-vs-benchmark cell: shaded by how far the category's published median sits from the
 * index the workbook pairs it with, in percentage points.
 *
 * A null gap is NOT a zero gap. Either side may be absent — a category with no index row at all,
 * or a period the workbook does not publish for that index — and an unshaded, undashed cell reading
 * "0.0 pp" would claim the two were measured and found equal.
 */
export function gapHeat(gapPp, period) {
  if (typeof gapPp !== 'number') return NONE;
  const band = GAP_BAND_PP[period] ?? 2;
  const steps = Math.min(Math.floor(Math.abs(gapPp) / band), 3);
  if (steps === 0) return { className: NEUTRAL, title: `Within ${band} pp of the benchmark`, band: 'median' };
  const ramp = gapPp > 0 ? ABOVE : BELOW;
  const side = gapPp > 0 ? 'ahead of' : 'behind';
  return {
    className: ramp[steps - 1],
    title: `${Math.abs(gapPp).toFixed(2)} pp ${side} the benchmark over ${period}`,
    band: `${gapPp > 0 ? 'above' : 'below'}-${steps}`,
  };
}

function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

/**
 * The legend, as data. Rendered by the tab so the shading says what it means on the same screen it
 * appears on — the shading is the one derived reading here and it may not go unexplained.
 */
export const HEAT_LEGEND = {
  peer: {
    title: 'Shaded by position within its own category',
    body: 'Each return is shaded by where the scheme sits among the schemes in its own category over that same period — green above the category median, deepening for the top quartile and the top eighth; red below it, on the same steps. The figure printed is always the workbook’s own return; only the shade is added here.',
    steps: [
      { className: ABOVE[2], label: 'Top eighth' },
      { className: ABOVE[1], label: 'Top quartile' },
      { className: ABOVE[0], label: 'Above median' },
      { className: 'bg-white ring-1 ring-slate-200', label: 'At the median' },
      { className: BELOW[0], label: 'Below median' },
      { className: BELOW[1], label: 'Bottom quartile' },
      { className: BELOW[2], label: 'Bottom eighth' },
    ],
  },
  gap: {
    title: 'Shaded by the gap to the benchmark',
    body: 'Each category’s published median is compared with the index the workbook prints beneath that category, and the difference is shaded in percentage points — green where the category median is ahead of its index, red where it is behind. One shade step per band, up to three.',
    steps: [
      { className: ABOVE[2], label: 'Three bands ahead or more' },
      { className: ABOVE[1], label: 'Two bands ahead' },
      { className: ABOVE[0], label: 'One band ahead' },
      { className: 'bg-white ring-1 ring-slate-200', label: 'Within one band' },
      { className: BELOW[0], label: 'One band behind' },
      { className: BELOW[1], label: 'Two bands behind' },
      { className: BELOW[2], label: 'Three bands behind or more' },
    ],
  },
};
