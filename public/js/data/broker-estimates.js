// data/broker-estimates.js — #452 "What brokers say": the named-broker price-target anchor for a
// company, from the broker reports we already capture (data/broker-reports.json via
// data/broker-reports.js). PURE and exported, so it is tested offline and the page cannot drift
// from the test.
//
// IT REPRODUCES, IT DOES NOT MODEL. Every rating and every price target is the BROKER'S OWN, as the
// post printed it (broker-reports-shared.js reads it out of the title; nothing is inferred). The
// only figures computed here are:
//   • the spread of the brokers' OWN targets — min / max / median — a summary of their numbers,
//     never a Glow fair value;
//   • how far that median sits from TODAY'S live price — a factual distance, labelled as measured
//     against the current price, never attributed to any broker.
// A target is never derived from an upside, and a stance never from an upside (broker-reports rules).

import { STANCE_OF, BROKER_WINDOW_DAYS } from './broker-reports-shared.js';

const toMs = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

/** The middle of a numeric list (the mean of the two middles for an even count). */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The named-broker estimates for one company.
 *
 * @param {Array}  reports  every broker report (broker-reports.js `reports()`), each carrying a
 *                          resolved `ticker`, the broker's `rating` / `stance` / `target` /
 *                          `upsidePct` as printed, `publishedAt`, `url`, and the broker's own
 *                          `previous` rated report (for a rating or target change).
 * @param {string} ticker   the company's NSE symbol.
 * @param {object} opts      { windowDays, now, cmp }. `now` (ms) applies a recency floor; omit it to
 *                          take every report given (the captured file is already windowed). `cmp` is
 *                          the live price the brokers' targets are measured against.
 * @returns {object|null}   null when no broker report names the company; otherwise
 *                          { ticker, windowDays, asOf, count, rows, consensus }.
 */
export function brokerEstimates(reports, ticker, { windowDays = BROKER_WINDOW_DAYS, now = null, cmp = null } = {}) {
  if (!ticker || !Array.isArray(reports)) return null;
  const sym = String(ticker).toUpperCase();
  const floor = Number.isFinite(now) ? now - windowDays * 864e5 : null;

  // Every in-window report naming this company, newest first.
  const mine = reports
    .filter((r) => r && String(r.ticker || '').toUpperCase() === sym)
    .map((r) => ({ r, ms: toMs(r.publishedAt) }))
    .filter((x) => x.ms != null && (floor == null || x.ms >= floor))
    .sort((a, b) => b.ms - a.ms);
  if (!mine.length) return null;

  // ONE ROW PER BROKER — the broker's LATEST report in the window (their current call). An older
  // report from the same broker is their previous view, already carried on the report's `previous`.
  const byBroker = new Map();
  for (const { r } of mine) {
    const key = String(r.broker || '').toLowerCase();
    if (!key || byBroker.has(key)) continue;
    byBroker.set(key, r);
  }

  const rows = [...byBroker.values()].map((r) => {
    const prev = r.previous || null;
    const ratingChanged = !!(prev?.rating && r.rating && prev.rating !== r.rating);
    const targetChanged = !!(prev && Number.isFinite(prev.target) && Number.isFinite(r.target) && prev.target !== r.target);
    return {
      broker: r.broker,
      rating: r.rating || null,
      stance: r.stance || (r.rating ? (STANCE_OF[r.rating] || null) : null),
      target: Number.isFinite(r.target) ? r.target : null,
      upsidePct: Number.isFinite(r.upsidePct) ? r.upsidePct : null,
      kind: r.kind || 'view',
      publishedAt: r.publishedAt || null,
      url: r.url || (Array.isArray(r.urls) ? r.urls[0] : null) || null,
      points: r.points || null,
      // The broker's OWN move since its last rated report, where the post carried one.
      changed: (ratingChanged || targetChanged)
        ? { fromRating: ratingChanged ? prev.rating : null, fromTarget: targetChanged ? prev.target : null }
        : null,
    };
  }).sort((a, b) => (toMs(b.publishedAt) || 0) - (toMs(a.publishedAt) || 0));

  // CONSENSUS — a summary of the brokers' OWN numbers. Targets only where a broker printed one.
  const targets = rows.map((x) => x.target).filter((t) => Number.isFinite(t));
  const rated = rows.filter((x) => x.stance);
  const stances = {
    bullish: rated.filter((x) => x.stance === 'bullish').length,
    neutral: rated.filter((x) => x.stance === 'neutral').length,
    bearish: rated.filter((x) => x.stance === 'bearish').length,
  };
  const med = median(targets);
  const price = Number.isFinite(cmp) && cmp > 0 ? cmp : null;
  const consensus = {
    count: rows.length,
    ratedCount: rated.length,
    stances,
    initiations: rows.filter((x) => x.kind === 'initiation').length,
    changes: rows.filter((x) => x.changed).length,
    targets: targets.length ? { n: targets.length, min: Math.min(...targets), max: Math.max(...targets), median: med } : null,
    // DERIVED, OURS: the brokers' median target measured against today's live price. Null without both.
    vsCmp: (price && med) ? { cmp: price, medianPct: med / price - 1 } : null,
    // The dominant lean of the RATED brokers — for colouring only, never a Glow rating.
    lean: stances.bullish > stances.bearish ? 'bullish' : stances.bearish > stances.bullish ? 'bearish' : 'mixed',
  };

  return { ticker: sym, windowDays, asOf: rows[0]?.publishedAt || null, count: rows.length, rows, consensus };
}
