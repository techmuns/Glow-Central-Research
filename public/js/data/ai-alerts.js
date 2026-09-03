// data/ai-alerts.js — THE EXPLAINABLE PRIORITY LAYER OVER GENERAL ALERTS.
//
// This module adds no source and makes no factual claim that is not already carried by a General
// Alerts event. Its job is narrower: group recent company events, suppress repeated single-feed
// noise, and rank what deserves a human's attention first.
//
// THE SCORE IS NOT AN LLM OPINION. The upstream data is already structured — direction,
// importance, source, date and company — so a deterministic model is faster, testable and cannot
// hallucinate a filing. Every point is returned in `scoreBreakdown` for deterministic verification;
// the card keeps the arithmetic hidden and shows the evidence and next action instead.
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
  // COMPANY NEWS IS DELIBERATELY THE LIGHTEST FEED THAT COUNTS AT ALL. It was zero, because before
  // the tracked keywords every story on it was neutral and low-importance and there was nothing to
  // separate a fraud investigation from a namesake's film release. The keyword rule supplies that
  // separation, so news can carry weight — and it is kept small on purpose. Do the arithmetic: a
  // keyword-matched story on a book company, published today, scores 30 (high importance) + 6 +
  // 16 (today) + 12 (in the book) = 64, which is exactly MIN_SCORE. So a single story surfaces a
  // company on the day it breaks and drops below the line as it ages, and anything older needs a
  // second feed to agree with it. That is the intended shape: news opens the door, it does not
  // decide what is urgent.
  news: 6,
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

// ---------------------------------------------------------------------------------------
// CONFLUENCE — THE NAMED CROSS-FEED PATTERNS
//
// This is the layer that answers "there's a volume breakout AND this superstar investor has bought
// it". Everything else in this file ranks a company by its strongest single event and then adds a
// flat bonus for having several feeds; that bonus is real but it is anonymous — it says *three
// feeds* and never says *which three, or what their combination means*. A reader cannot act on an
// arity.
//
// So a small, fixed set of patterns is checked by name. Each one states which feeds have to agree,
// carries its own points, and writes a sentence out of the ACTUAL matched events rather than a
// template with the company's name dropped in. `confluenceOf()` is pure and exported for exactly
// the reason `moveSeverity` is: a pattern that needs a marquee investor and a volume spike on the
// same company inside seven days will not appear in most days' captures, so waiting for one to
// occur is not a test.
//
// FOUR RULES THIS LAYER OBEYS, AND THEY ARE THE SAME ONES THE REST OF THE FILE DOES:
//
// 1. IT ADDS NO FACT. Every clause in every sentence is quoted from an event that is already on the
//    card and already links to its own source. If a pattern cannot describe itself out of the
//    evidence it matched, it does not fire.
// 2. CO-OCCURRENCE IS NOT CAUSATION, AND THE WORDING MUST NOT SMUGGLE IT IN. Two things happening
//    to one company inside a week is what has been measured, and that is all the sentence may say.
//    A volume spike on the day a fund's book was published does not mean the fund did the buying —
//    a filed shareholding is a QUARTERLY disclosure and the trade behind it may be months old, so
//    the accumulation pattern says "and a tracked investor's latest book shows", never "bought
//    today". Getting that wrong would be the `deriveMoves` error — inventing a trade date — one
//    layer up.
// 3. AN ABSENCE IS A FINDING, BUT ONLY WHERE IT CAN BE MEASURED. `unexplained-move` fires when a
//    big move has no news, filing or result beside it, which is genuinely the most useful thing
//    this layer says — and it is allowed to say it ONLY because the feeds it would have to have
//    seen are all present and current for this company. Where any of them is stale or unread the
//    pattern is withheld, because "nothing explains it" and "we did not look" are the two answers
//    this whole dashboard exists to keep apart.
// 4. THE POINTS ARE CAPPED. Correlation is meant to reorder the list, not to manufacture urgency:
//    `CONFLUENCE_MAX` bounds the whole layer's contribution however many patterns fire.

/** The most a card can gain from every confluence pattern put together. */
export const CONFLUENCE_MAX = 18;

const has = (events, fn) => events.find(fn) || null;
const feedOf = (events, id) => events.filter((e) => e.feed === id);

const participation = (e) => e.feed === 'technicals' && (e.kind === 'volume' || e.kind === 'breakout');
const priceMove = (e) => e.feed === 'technicals' && e.kind === 'move';
const anyTechnical = (e) => e.feed === 'technicals';

// THE BUYING AND SELLING LEGS ASK FOR A *MATERIAL* MOVE, AND THE THRESHOLD IS ALREADY PUBLISHED.
//
// Every feed here states its own materiality on the tab and in the source registry — an investor
// change is high at INVESTOR_HIGH_PP (1 percentage point) or on an appearance or disappearance, an
// insider trade at INSIDER_HIGH_PCT or INSIDER_HIGH_VALUE — and `importance` is the answer that
// carries. Reading direction alone made every one of those thresholds a dead letter here: measured
// on the shipped capture, four of the eight surfaced cards led with "Life Insurance Corporation
// reduced by 0.62–0.81pp", a holder that appears in nearly every book moving less than the feed's
// own bar for mattering. Nothing was wrong with the reading and the correlation was still noise.
//
// So the predicate defers to the stated threshold rather than inventing a second one beside it —
// two predicates over one question is what this codebase keeps having to un-write.
const investorAdd = (e) => e.feed === 'investors' && e.direction === 'positive' && e.importance === 'high';
const investorCut = (e) => e.feed === 'investors' && e.direction === 'negative' && e.importance === 'high';
const insiderBuy = (e) => e.feed === 'insider' && e.direction === 'positive' && e.importance === 'high';
const insiderSell = (e) => e.feed === 'insider' && e.direction === 'negative' && e.importance === 'high';
const trackedNews = (e) => e.feed === 'news' && (e.keywords || []).length > 0;
const materialFiling = (e) => e.feed === 'announcements' && e.importance === 'high';
const resultEvent = (e) => e.feed === 'earnings' || e.feed === 'concalls';

/** The tracked keywords on a card's news rows, deduplicated, for a sentence that names them. */
const newsTopics = (events) => [...new Set(events.flatMap((e) => (e.feed === 'news' ? e.keywords || [] : [])))];

/**
 * The patterns, in the order they are reported. `detect` returns the sentence it matched on, or
 * null — the sentence is built from the events themselves, so a pattern that fires can always be
 * traced back to rows the reader can open.
 */
const CONFLUENCE = [
  {
    id: 'accumulation',
    label: 'Volume with a buyer behind it',
    points: 10,
    detect: (events) => {
      const tape = has(events, participation) || has(events, (e) => priceMove(e) && e.direction === 'positive');
      const buyer = has(events, investorAdd) || has(events, insiderBuy);
      if (!tape || !buyer) return null;
      const who = buyer.feed === 'investors' ? "a tracked investor's latest book" : 'an insider disclosure';
      return `${tape.headline}, and ${who} shows buying — ${buyer.headline}.`;
    },
  },
  {
    id: 'distribution',
    label: 'Volume with selling behind it',
    points: 10,
    detect: (events) => {
      const tape = has(events, participation) || has(events, (e) => priceMove(e) && e.direction === 'negative');
      const seller = has(events, investorCut) || has(events, insiderSell);
      if (!tape || !seller) return null;
      const who = seller.feed === 'investors' ? "a tracked investor's latest book" : 'an insider disclosure';
      return `${tape.headline}, and ${who} shows selling — ${seller.headline}.`;
    },
  },
  {
    id: 'insider-and-investor',
    label: 'Insider and institution agree',
    points: 8,
    detect: (events) => {
      const insider = has(events, insiderBuy) || has(events, insiderSell);
      const institution = has(events, investorAdd) || has(events, investorCut);
      if (!insider || !institution) return null;
      const sameWay =
        (insider.direction === 'positive' && institution.direction === 'positive') ||
        (insider.direction === 'negative' && institution.direction === 'negative');
      if (!sameWay) return null;
      return `An insider and a tracked investor moved the same way: ${insider.headline}, and ${institution.headline}.`;
    },
  },
  {
    id: 'news-behind-the-move',
    label: 'The move has a story behind it',
    points: 8,
    detect: (events) => {
      const tape = has(events, anyTechnical);
      const story = has(events, trackedNews) || has(events, materialFiling);
      if (!tape || !story) return null;
      const topics = newsTopics(events);
      const why = topics.length ? ` (${topics.join(', ')})` : '';
      return `${tape.headline}, alongside ${story.feed === 'news' ? 'a tracked story' : 'a material filing'}${why}: ${story.headline}.`;
    },
  },
  {
    id: 'results-reaction',
    label: 'A result and a reaction',
    points: 8,
    detect: (events) => {
      const result = has(events, resultEvent);
      const tape = has(events, anyTechnical);
      if (!result || !tape) return null;
      return `${result.headline}, and the tape responded — ${tape.headline}.`;
    },
  },
  {
    id: 'risk-cluster',
    label: 'Risk showing up in more than one place',
    points: 10,
    detect: (events) => {
      const bad = events.filter((e) => e.direction === 'negative' && e.importance === 'high');
      const feeds = [...new Set(bad.map((e) => e.feed))];
      if (feeds.length < 2) return null;
      return `High-importance negative readings on ${feeds.length} independent feeds: ${bad
        .slice(0, 2)
        .map((e) => e.headline)
        .join('; ')}.`;
    },
  },
  {
    id: 'unexplained-move',
    label: 'A move nothing else explains',
    points: 6,
    // See rule 3 in the header: this is the one pattern that reports an ABSENCE, so it may only
    // speak when the feeds whose silence it is reporting were actually read and reach the day.
    detect: (events, { silentFeedsReadable }) => {
      if (!silentFeedsReadable) return null;
      const tape = has(events, (e) => anyTechnical(e) && e.importance === 'high');
      if (!tape) return null;
      const explains = events.some((e) => trackedNews(e) || materialFiling(e) || resultEvent(e));
      if (explains) return null;
      return `${tape.headline}, with no tracked story, material filing or result beside it in the last ${WINDOW_DAYS} days.`;
    },
  },
];

/**
 * Every named pattern this company's recent events satisfy, strongest first.
 *
 * Pure and exported: a marquee investor and a volume spike landing on one company inside a week is
 * exactly the case a fixture has to supply, because most days' captures do not contain one.
 */
export function confluenceOf(events, { feedById = new Map() } = {}) {
  // The absence pattern needs to know that the feeds it would be reporting silence from were
  // actually read. A feed absent from the report at all counts as unreadable, not as quiet.
  const silentFeedsReadable = ['news', 'announcements', 'earnings'].every((id) => {
    const feed = feedById.get(id);
    return !!feed && feed.status === 'ok' && feed.reachesToday !== false;
  });
  const ctx = { silentFeedsReadable };
  const found = [];
  for (const pattern of CONFLUENCE) {
    const detail = pattern.detect(events, ctx);
    if (detail) found.push({ id: pattern.id, label: pattern.label, points: pattern.points, detail });
  }
  return found.sort((a, b) => b.points - a.points);
}

function directionSummary(events) {
  const count = { positive: 0, negative: 0, neutral: 0 };
  for (const event of events) count[event.direction] = (count[event.direction] || 0) + 1;
  return count;
}

function insightFor(card) {
  const feeds = card.feedLabels.join(', ');
  // THE CORRELATION IS THE HEADLINE WHENEVER THERE IS ONE. "Signals conflict across four feeds" is
  // a description of the data's shape; "volume 3.2x its average, and a tracked investor's latest
  // book shows buying" is the finding. Where a named pattern fired, it leads — and a conflict is
  // still reported, after it, because the two are not alternatives.
  if (card.confluence?.length) {
    const lead = card.confluence[0];
    const alsoConflicts = card.mixed ? ' Direction still conflicts across the sources, so reconcile them before acting.' : '';
    return `${lead.label}: ${lead.detail}${alsoConflicts}`;
  }
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

    // THE NAMED PATTERNS, before the anonymous feed-count bonus below — they are the specific
    // reading of the same fact and are what the card actually shows the reader.
    const confluence = confluenceOf(events, { feedById });
    const confluencePoints = Math.min(
      CONFLUENCE_MAX,
      confluence.reduce((sum, pattern) => sum + pattern.points, 0)
    );
    for (const pattern of confluence) scoreBreakdown.push({ label: `Confluence — ${pattern.label}`, points: pattern.points });
    const overCap = confluencePoints - confluence.reduce((sum, pattern) => sum + pattern.points, 0);
    if (overCap !== 0) scoreBreakdown.push({ label: `Confluence contribution capped at ${CONFLUENCE_MAX}`, points: overCap });

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
      confluence,
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
      correlated: surfaced.filter((card) => card.confluence?.length).length,
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
