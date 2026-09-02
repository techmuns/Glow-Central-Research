// lib/technicals-file.mjs — the two derived header figures of technicals.json, in ONE place.
//
// Both the daily scrape (scripts/scrape-technicals.mjs) and the follow-up move verifier
// (scripts/verify-price-moves.mjs) write this file, and a corrected day move can flip a row's
// sign — so market breadth has to be recomputed by whichever of them wrote last, from the same
// rule. Two copies of the rule would be two things that can disagree about what "Nifty 500
// breadth" counts.

/**
 * Market-wide advances vs declines across the Nifty 500 universe.
 *
 * NSE-500 ROWS ONLY, deliberately. Breadth is a statement about the index, and the file also
 * carries held companies that are not in it. Folding 68 small- and mid-caps into an
 * advance/decline ratio would leave it labelled "Nifty 500" while measuring something else —
 * the same class of error as reporting a count without its denominator.
 */
export function marketBreadth(rows) {
  const withChange = rows.filter((r) => r.listSource !== 'book' && Number.isFinite(r.pct_change_today));
  const advances = withChange.filter((r) => r.pct_change_today > 0).length;
  const declines = withChange.filter((r) => r.pct_change_today < 0).length;
  return withChange.length
    ? { advances, declines, unchanged: withChange.length - advances - declines, ad_ratio: declines === 0 ? null : Math.round((advances / declines) * 100) / 100, universe: withChange.length }
    : null;
}

/** The most common `bar_date` among priced rows — the session this file's closes belong to. */
export function priceDateOf(rows) {
  const counts = new Map();
  for (const r of rows) if (r.bar_date) counts.set(r.bar_date, (counts.get(r.bar_date) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
}
