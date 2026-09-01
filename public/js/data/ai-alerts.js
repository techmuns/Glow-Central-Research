// data/ai-alerts.js — THE EXPLAINABLE PRIORITY LAYER OVER GENERAL ALERTS.
//
// This module adds no source and makes no factual claim that is not already carried by a General
// Alerts event. Its job is narrower: group recent company events, suppress repeated single-feed
// noise, and rank what deserves a human's attention first.
//
// THE SCORE IS NOT AN LLM OPINION. The upstream data is already structured — direction,
// importance, source, date and company — so a deterministic model is faster, testable and cannot
// hallucinate a filing. Every point is returned in `scoreBreakdown` and printed on the card.
//
// PORTFOLIO HONESTY: `coverage.js` is the real 142-company book used by the Research scope. The
// separate Portfolio Analytics ledger is explicitly illustrative, so its weights and conviction
// labels MUST NOT influence a real alert priority. A real book company gets a membership boost;
// nothing here claims to know the real position size.

import * as generalAlerts from './daily-alerts.js';
import * as coverage from './coverage.js';

export const WINDOW_DAYS = 7;
export const MIN_SCORE = 64;
export const MUST_SEE_SCORE = 82;

const FEED_WEIGHT = {
  earnings: 12,
  announcements: 10,
  insider: 9,
  investors: 8,
  concalls: 8,
  technicals: 6,
  chatter: 4,
  news: 0,
  'market-news': 0,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function shiftDay(day, amount) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

function ageInDays(eventDay, throughDay) {
  const event = Date.parse(`${eventDay}T00:00:00Z`);
  const through = Date.parse(`${throughDay}T00:00:00Z`);
  if (!Number.isFinite(event) || !Number.isFinite(through)) return WINDOW_DAYS;
  return Math.max(0, Math.round((through - event) / 86_400_000));
}

function recencyPoints(age) {
  if (age === 0) return 16;
  if (age === 1) return 10;
  if (age <= 3) return 6;
  return 2;
}

function normalizedHeadline(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** Keep one copy of a story per feed without erasing genuine cross-feed corroboration. */
function dedupe(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.feed}:${normalizedHeadline(event.headline) || event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventScore(event, day, feedState) {
  const age = ageInDays(event.day, day);
  const parts = [
    { label: event.importance === 'high' ? 'High-importance event' : 'Low-importance event', points: event.importance === 'high' ? 30 : 4 },
    { label: `${event.feedLabel || event.feed} source weight`, points: FEED_WEIGHT[event.feed] || 0 },
    { label: age === 0 ? 'Occurred today' : age === 1 ? 'Occurred yesterday' : `Occurred ${age} days ago`, points: recencyPoints(age) },
  ];
  if (event.direction === 'negative') parts.push({ label: 'Negative risk signal', points: 10 });
  else if (event.direction === 'positive') parts.push({ label: 'Positive directional signal', points: 6 });

  const unavailable = !feedState || feedState.status !== 'ok' || feedState.reachesToday === false;
  if (unavailable) parts.push({ label: 'Source is stale, incomplete or unread', points: -10 });
  return { points: parts.reduce((sum, part) => sum + part.points, 0), parts, unavailable };
}

function directionSummary(events) {
  const count = { positive: 0, negative: 0, neutral: 0 };
  for (const event of events) count[event.direction] = (count[event.direction] || 0) + 1;
  return count;
}

function insightFor(card) {
  const feeds = card.feedLabels.join(', ');
  if (card.mixed) {
    return `Signals conflict across ${feeds}: ${card.directions.positive} positive and ${card.directions.negative} negative. Reconcile the source evidence before acting.`;
  }
  if (card.directions.negative > 0 && card.feedCount > 1) {
    return `Risk signals are converging across ${feeds}. The latest material event is: ${card.topEvent.headline}.`;
  }
  if (card.directions.positive > 0 && card.feedCount > 1) {
    return `Several independent signals point positive across ${feeds}. The latest material event is: ${card.topEvent.headline}.`;
  }
  if (card.directions.negative > 0) return `${card.topEvent.headline}. This is the strongest recent risk signal for the company.`;
  if (card.directions.positive > 0) return `${card.topEvent.headline}. This is the strongest recent positive signal for the company.`;
  return `${card.topEvent.headline}. It ranks here because of its materiality, recency and portfolio relevance.`;
}

function actionFor(card) {
  if (card.mixed) return 'Read the conflicting source items and update the company thesis only after they reconcile.';
  if (card.directions.negative > 0 && card.highCount > 0) return 'Review the source filing or disclosure and reassess the risk to the thesis.';
  if (card.directions.positive > 0 && card.highCount > 0) return 'Check whether the new evidence changes the thesis, estimates or valuation.';
  return 'Keep this company on the review list and verify the primary source.';
}

/**
 * Pure ranking function. It is exported because the scoring thresholds and noise suppression are
 * product rules; testing only whatever today's capture happens to contain would leave branches
 * unexercised most days.
 */
export function rankReport(report, { holdings = coverage.holdings() } = {}) {
  const day = report?.day || generalAlerts.today();
  const firstDay = shiftDay(day, -(WINDOW_DAYS - 1));
  const feedById = new Map((report?.feeds || []).map((feed) => [feed.id, feed]));
  const holdingByTicker = new Map(
    (holdings || [])
      .filter((holding) => holding.ticker)
      .map((holding) => [String(holding.ticker).toUpperCase(), holding])
  );

  const recent = (report?.events || []).filter(
    (event) => event.ticker && event.day && event.day >= firstDay && event.day <= day
  );
  const grouped = new Map();
  for (const event of recent) {
    const ticker = String(event.ticker).toUpperCase();
    const list = grouped.get(ticker);
    if (list) list.push(event);
    else grouped.set(ticker, [event]);
  }

  let cards = [...grouped].map(([ticker, rawEvents]) => {
    const events = dedupe(rawEvents);
    const scoredEvents = events
      .map((event) => ({ event, score: eventScore(event, day, feedById.get(event.feed)) }))
      .sort((a, b) => b.score.points - a.score.points || String(b.event.day).localeCompare(String(a.event.day)) || String(b.event.time || '').localeCompare(String(a.event.time || '')));
    const top = scoredEvents[0];
    const directions = directionSummary(events);
    const feeds = [...new Set(events.map((event) => event.feed))];
    const feedLabels = [...new Set(events.map((event) => event.feedLabel || event.feed))];
    const highCount = events.filter((event) => event.importance === 'high').length;
    const hasMaterialNegative = events.some((event) => event.importance === 'high' && event.direction === 'negative');
    const holding = holdingByTicker.get(ticker) || null;
    const mixed = directions.positive > 0 && directions.negative > 0;
    const scoreBreakdown = [...(top?.score.parts || [])];

    if (holding) scoreBreakdown.push({ label: 'Company is in the real Portfolio list', points: 12 });
    // Corroboration changes ordering but cannot make a routine event urgent on its own. The first
    // draft gave another feed twelve points and promoted nearly every well-covered company; six
    // keeps the independent confirmation valuable without rewarding mere data availability.
    if (feeds.length > 1) scoreBreakdown.push({ label: `${feeds.length} independent feeds`, points: Math.min(12, (feeds.length - 1) * 6) });
    if (highCount > 1) scoreBreakdown.push({ label: `${highCount} high-importance events`, points: Math.min(6, (highCount - 1) * 3) });
    if (mixed) scoreBreakdown.push({ label: 'Conflicting directional evidence needs review', points: 6 });
    else if (directions.negative > 0) scoreBreakdown.push({ label: 'Consistent negative evidence', points: 4 });
    else if (directions.positive > 1) scoreBreakdown.push({ label: 'Repeated positive evidence', points: 3 });

    return {
      ticker,
      company: top?.event.company || holding?.name || ticker,
      sector: holding?.sector || null,
      holding: !!holding,
      // Cards show the strongest evidence first. General Alerts remains the chronological record.
      events: scoredEvents.map((entry) => entry.event),
      topEvent: top?.event || events[0],
      directions,
      mixed,
      highCount,
      hasMaterialNegative,
      feedCount: feeds.length,
      feeds,
      feedLabels,
      stale: scoredEvents.every((entry) => entry.score.unavailable),
      scoreBreakdown,
      score: scoreBreakdown.reduce((sum, part) => sum + part.points, 0),
    };
  });

  // A simultaneous negative cluster inside one real portfolio sector matters more than the same
  // isolated company event. The boost is intentionally small: it changes ordering, not truth.
  const negativeBySector = new Map();
  for (const card of cards) {
    if (!card.holding || !card.sector || !card.hasMaterialNegative) continue;
    negativeBySector.set(card.sector, (negativeBySector.get(card.sector) || 0) + 1);
  }
  cards = cards.map((card) => {
    const peers = card.sector ? negativeBySector.get(card.sector) || 0 : 0;
    if (card.hasMaterialNegative && peers > 1) {
      card.scoreBreakdown.push({ label: `${peers} portfolio companies in ${card.sector} have negative signals`, points: 3 });
      card.sectorCluster = peers;
      card.score += 3;
    } else {
      card.sectorCluster = 0;
    }
    const unclamped = card.score;
    card.score = clamp(unclamped, 0, 100);
    if (card.score !== unclamped) {
      // Keep the printed arithmetic equal to the printed score even if future feed/rule additions
      // would push a company above the deliberately bounded 100-point scale.
      card.scoreBreakdown.push({ label: '100-point priority scale cap', points: card.score - unclamped });
    }
    card.priority = card.score >= MUST_SEE_SCORE ? 'must-see' : card.score >= MIN_SCORE ? 'important' : 'watch';
    card.insight = insightFor(card);
    card.action = actionFor(card);
    return card;
  });

  cards.sort(
    (a, b) => b.score - a.score || b.highCount - a.highCount || String(b.topEvent?.day || '').localeCompare(String(a.topEvent?.day || '')) || a.company.localeCompare(b.company)
  );
  const surfaced = cards.filter((card) => card.score >= MIN_SCORE);
  const marketWide = (report?.events || []).filter(
    (event) => !event.ticker && event.day && event.day >= firstDay && event.day <= day
  ).length;

  return {
    day,
    scope: report?.scope || 'universe',
    pending: report?.pending || 0,
    feeds: report?.feeds || [],
    cards: surfaced,
    allCards: cards,
    meta: {
      firstDay,
      rawEvents: recent.length,
      dedupedEvents: cards.reduce((sum, card) => sum + card.events.length, 0),
      activeCompanies: cards.length,
      surfacedCompanies: surfaced.length,
      suppressedCompanies: cards.length - surfaced.length,
      mustSee: surfaced.filter((card) => card.priority === 'must-see').length,
      important: surfaced.filter((card) => card.priority === 'important').length,
      marketWideExcluded: marketWide,
      staleFeeds: (report?.feeds || []).filter((feed) => feed.status !== 'ok' || feed.reachesToday === false).length,
    },
  };
}

/** Collect General Alerts once and rank each partial/final report without adding any request. */
export async function collect({ scope = 'portfolio', holdings = null, refresh = false, onPartial = null } = {}) {
  const book = holdings || coverage.holdings();
  const report = await generalAlerts.collect({
    scope,
    holdings: book,
    includeHistory: true,
    refresh,
    onPartial: onPartial ? (partial) => onPartial(rankReport(partial, { holdings: book })) : null,
  });
  return rankReport(report, { holdings: book });
}
