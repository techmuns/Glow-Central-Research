// data/daily-alerts.js — TODAY, ACROSS EVERY FEED THIS DASHBOARD ALREADY READS.
//
//   const day = today();                     // the IST trading date
//   const report = await collect({ scope }); // { day, events, feeds, meta }
//   report.events   one row per thing that happened today, newest first
//   report.feeds    one row per feed: what it contributed, and WHETHER IT REACHES TODAY
//
// This module adds no source of its own. Every event on it is a reading taken from a feed that
// already had a tab, which is the whole point: the tabs answer "what does this feed hold", and this
// answers "what happened today" by asking all of them the same question at once.
//
// ---------------------------------------------------------------------------------------
// THE TWO COLOURS ARE MEASUREMENTS, NOT OPINIONS
//
//   RED (alert)    a direct negative reading on the row itself — profit fell, the loss widened, the
//                  company slipped into loss, the price fell more than MOVE_PCT today, the research
//                  provider's own tier for the call is one of their two lowest, their own sentiment
//                  label is bearish.
//   ORANGE (update) everything else that arrived today.
//
// Every red row carries the reading that made it red, in `reason`, in the row. A colour whose cause
// is not on screen beside it is a judgement, and this dashboard does not make those (CLAUDE.md,
// *Honesty rules for the kit*, rule 2: signals must be direct readings).
//
// TWO FEEDS ARE DELIBERATELY NEVER RED, AND THE REASON IS THE SAME RULE FROM THE OTHER SIDE:
//
//   Insider trades. CLAUDE.md is explicit that this feed carries no model — "no sentiment, no
//   materiality flag" — because its columns are the upstream's own and unknown at build time.
//   Deciding that "Pledge" is red and "Acquisition" is not IS a materiality flag, however obvious
//   it looks. So the upstream's own transaction wording is printed verbatim in the row and nothing
//   here reads it for the reader.
//
//   Corporate announcements. An announcement is an event, not a measurement: BSE's `CATEGORYNAME`
//   is their filing taxonomy, not a verdict, and colouring some categories red would be this
//   dashboard editorialising over somebody else's index.
//
// ---------------------------------------------------------------------------------------
// "NOTHING TODAY" AND "WE HAVE NOT LOOKED AT TODAY" ARE DIFFERENT ANSWERS
//
// Most of these feeds are committed captures refreshed on a schedule, and a schedule is best-effort
// (see *And the schedule is best-effort twice over* in CLAUDE.md). So a feed whose newest capture
// predates today CANNOT say nobody filed — it can only say when it last looked. `feeds[]` carries
// `reachesToday` for exactly that, and the tab prints it per feed rather than rendering an empty
// bucket that reads as an all-clear.
//
// AND NOTHING IN HERE WALKS. Every load below is one conditional GET against a committed file or a
// cached route. The three filings feeds are seeded through `feed.seed()`, which is the snapshot and
// this device and no per-company request at all — see js/data/filings.js.

import * as earnings from './earnings-live.js';
import * as concalls from './concall-scans.js';
import * as technicals from './technicals.js';
import * as chatter from './chatter-live.js';
import * as marketNews from './market-news.js';
import { announcements, insider, news } from './filings.js';
import { resultTierOf, sentimentTierOf } from './stockscans-shared.js';
import { scopeTickers } from './scope.js';
import * as coverage from './coverage.js';

// ---------------------------------------------------------------------------------------
// Today, in IST
// ---------------------------------------------------------------------------------------

// Every date on this dashboard is an Indian trading date — a company files at 14:32 IST and the
// exchange calendar is IST — so `toISOString()` on its own names YESTERDAY for the five and a half
// hours between 18:30 IST and midnight UTC. That window is the evening, which is exactly when a
// reader opens an alerts page to see what happened today.
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export const today = (now = Date.now()) => new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The IST clock time of an instant, as HH:MM, for a row that carries a real timestamp. */
function istTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** The IST calendar date of an instant. */
function istDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------
// The two thresholds this module states out loud
// ---------------------------------------------------------------------------------------

// A day move big enough to be worth a row. Stated here, printed on the tab, and written into row 1
// of the export — a threshold the reader cannot see is a filter applied on their behalf in secret.
export const MOVE_PCT = 5;

// A jump in how often a company is being talked about, against the previous scrape. Same rule: the
// number is on screen. `changePct` on that feed is MENTION VOLUME, never a price move.
export const CHATTER_PCT = 50;

export const SEVERITY = { ALERT: 'alert', UPDATE: 'update' };

// ---------------------------------------------------------------------------------------
// Feed registry — id, label, which tab owns it, and what it can contribute
// ---------------------------------------------------------------------------------------

export const FEEDS = [
  { id: 'results', label: 'Results', tab: 'earnings-hub', what: 'Companies that filed quarterly results today.' },
  { id: 'concall', label: 'Con-calls', tab: 'concall', what: 'Earnings calls held today, with the research provider’s own score.' },
  { id: 'announcements', label: 'Announcements', tab: 'corp-announcements', what: 'Everything filed to BSE today, across the exchange.' },
  { id: 'insider', label: 'Insider trades', tab: 'insider-trades', what: 'Insider and promoter disclosures broadcast today.' },
  { id: 'technicals', label: 'Price moves', tab: 'breakouts', what: `Companies that moved more than ${MOVE_PCT}% at today’s close.` },
  { id: 'chatter', label: 'Public chatter', tab: 'public-chatter', what: `Companies whose mention volume moved more than ${CHATTER_PCT}% since the last scrape.` },
  { id: 'news', label: 'Company news', tab: 'news', what: 'Stories published today about a company in scope.' },
  { id: 'market-news', label: 'Market news', tab: 'news', what: 'Market-wide stories published today. Carries no company, so it is Universe only.' },
  {
    id: 'investors',
    label: 'Superstar investors',
    tab: 'super-investors',
    what: 'Filed shareholdings, disclosed quarterly.',
    // NOT A DAILY FEED, and saying so is better than leaving it off the list. A reader who knows
    // this dashboard has an investors tab and does not see it here would reasonably conclude that
    // nothing moved, when the truth is that nothing about it can move on a single day.
    daily: false,
  },
];

const feedById = new Map(FEEDS.map((f) => [f.id, f]));

// ---------------------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------------------

/**
 * Read every feed and return today's events plus a per-feed account of what was read.
 *
 * `Promise.allSettled`, never `all`: one feed being unreachable must cost that feed's rows and
 * nothing else. A failure becomes a `feeds[]` row saying so — the same rule as everywhere here, a
 * failed read is never an empty result.
 */
export async function collect({ scope = 'universe', day = today(), holdings = null, onPartial = null } = {}) {
  const book = holdings || coverage.holdings();
  const wanted = scopeTickers(scope, book);

  const settledFeeds = new Map(); // feed id -> the finished feed row
  const build = () => assemble({ day, scope, settledFeeds });

  // EACH FEED SETTLES ON ITS OWN AND THE PAGE PAINTS AS IT DOES.
  //
  // The first version awaited all eight together, and the landing page then sat blank for as long
  // as the SLOWEST of them — measured at 10-15 seconds on a static origin, because the chatter API
  // is a direct call to somebody else's service and an unreachable host takes its own time to say
  // so. Seven feeds that had already answered were held hostage by the one that had not, on the
  // first tab a reader sees. `Promise.all` over independent reads is head-of-line blocking with a
  // tidy syntax.
  //
  // So each feed loads, collects and reports independently, and `onPartial` fires every time one
  // lands. Nothing rejects: a feed that throws becomes a row saying so, because a failed read is
  // never an empty result.
  await Promise.all(
    FEEDS.filter((f) => f.daily !== false).map(async (feed) => {
      let out;
      try {
        await LOADERS[feed.id]();
        out = COLLECTORS[feed.id]({ day, scope, wanted }) || {};
      } catch (err) {
        out = { events: [], status: 'failed', reachesToday: false, asOf: null, note: String(err?.message || err) };
      }
      settledFeeds.set(feed.id, toFeedRow(feed, out));
      try {
        onPartial?.(build());
      } catch (err) {
        console.error('[daily-alerts] onPartial threw', err);
      }
    })
  );

  return build();
}

const LOADERS = {
  results: () => earnings.load(),
  concall: () => concalls.load(),
  announcements: () => announcements.seed(),
  insider: () => insider.seed(),
  technicals: () => technicals.load(),
  chatter: () => chatter.load(),
  news: () => news.seed(),
  'market-news': () => marketNews.load(),
};

const COLLECTORS = {
  results: fromResults,
  concall: fromConcalls,
  announcements: fromAnnouncements,
  insider: fromInsider,
  technicals: fromTechnicals,
  chatter: fromChatter,
  news: fromCompanyNews,
  'market-news': fromMarketNews,
};

function toFeedRow(feed, out) {
  return {
    ...feed,
    status: out.status || 'ok',
    count: (out.events || []).length,
    events: out.events || [],
    // Whether this feed's data actually extends to today. `null` where the feed cannot know.
    reachesToday: out.reachesToday ?? null,
    asOf: out.asOf ?? null,
    note: out.note || null,
    scopable: out.scopable !== false,
  };
}

/**
 * Build the report out of whatever has settled so far.
 *
 * A feed nobody has heard from yet is `pending` — NOT "nothing today", which is the one thing a
 * half-finished read must never be allowed to say. It carries no count at all, so the totals below
 * are of what has actually been read rather than of what is eventually expected.
 */
function assemble({ day, scope, settledFeeds }) {
  const feeds = FEEDS.map((feed) => {
    if (feed.daily === false) {
      return { ...feed, status: 'not-daily', count: 0, events: [], reachesToday: null, asOf: null, note: 'Disclosed quarterly — nothing about it changes on a single day.' };
    }
    return settledFeeds.get(feed.id) || { ...feed, status: 'pending', count: 0, events: [], reachesToday: null, asOf: null, note: null };
  });

  const events = [];
  for (const f of feeds) for (const ev of f.events) events.push({ ...ev, feed: f.id, feedLabel: f.label, tab: f.tab });
  events.sort(byNewestFirst);
  ensureUniqueIds(events);

  const done = feeds.filter((f) => f.status === 'ok' || f.status === 'failed');
  return {
    day,
    scope,
    events,
    feeds,
    pending: feeds.filter((f) => f.status === 'pending').length,
    meta: {
      alerts: events.filter((e) => e.severity === SEVERITY.ALERT).length,
      updates: events.filter((e) => e.severity === SEVERITY.UPDATE).length,
      companies: new Set(events.map((e) => e.ticker).filter(Boolean)).size,
      // The FRESHEST feed and the STALEST feed, both, because one number cannot describe eight
      // captures taken at eight different times and picking the freshest would flatter the rest.
      newestRead: maxTime(done.map((f) => f.asOf)),
      oldestRead: minTime(done.filter((f) => f.status === 'ok').map((f) => f.asOf)),
      feedsReachingToday: feeds.filter((f) => f.reachesToday === true).length,
      feedsBehind: feeds.filter((f) => f.reachesToday === false).length,
      feedsPending: feeds.filter((f) => f.status === 'pending').length,
      feedsDaily: feeds.filter((f) => f.daily !== false).length,
      moveThreshold: MOVE_PCT,
      chatterThreshold: CHATTER_PCT,
    },
  };
}

/**
 * ONE KEY MUST NEVER MEAN TWO ROWS — closed here, once, for every feed.
 *
 * `scoreTable`'s repaint holds `<tr>` nodes in a Map keyed by the row key, so a duplicate key
 * silently displaces one node and orphans it in the DOM: wrong row, wrong place, invisible to any
 * COUNT. That has bitten this codebase twice already (the News table's position-derived key, and
 * the con-call table's `(company, time)` pair), and it bit here on the third read: **the same story
 * is returned by two companies' news searches**, so `news:<url>` named two different rows — a
 * RELIANCE row and an HDFCBANK row about one article. Both are real and neither may be dropped.
 *
 * So the ids stay content-derived — never positional, which is the failure that cannot be fixed by
 * a counter — and a counter closes genuine content duplicates. The reverse failure, two keys
 * meaning one row, is not possible here: the suffix is assigned in the feed's own settled order.
 *
 * It lives in `assemble()` rather than in each collector because this is the only place that sees
 * every feed's rows together, and a collision can span two feeds as easily as two rows of one.
 */
function ensureUniqueIds(events) {
  const seen = new Map();
  for (const ev of events) {
    const n = seen.get(ev.id) || 0;
    seen.set(ev.id, n + 1);
    if (n) ev.id = `${ev.id}#${n}`;
  }
  return events;
}

/** Newest first. A row with no clock time sorts after one that has it, never before. */
function byNewestFirst(a, b) {
  const at = a.time || '';
  const bt = b.time || '';
  if (at && bt) return bt.localeCompare(at);
  if (at) return -1;
  if (bt) return 1;
  return String(a.company || '').localeCompare(String(b.company || ''));
}

const maxTime = (list) => list.filter(Boolean).sort().slice(-1)[0] || null;
const minTime = (list) => list.filter(Boolean).sort()[0] || null;

const inScope = (wanted, ticker) => !wanted || (!!ticker && wanted.has(String(ticker).toUpperCase()));

// ---------------------------------------------------------------------------------------
// Per-feed collectors
//
// Each returns { events, status, reachesToday, asOf, note }. `reachesToday` is the honest half:
// a collector that finds nothing must say whether it LOOKED at today.
// ---------------------------------------------------------------------------------------

/** Quarterly results filed today. Red when the profit reading is negative — never a bare number. */
function fromResults({ day, wanted }) {
  const range = earnings.dateRange();
  const m = earnings.meta() || {};
  // The results feed knows the newest date it holds, so it can answer "did we look at today"
  // without guessing from a capture time.
  const reachesToday = !!range.last && range.last >= day;

  const rows = earnings.all().filter((r) => r.resultDate === day && inScope(wanted, r.ticker));
  const events = rows.map((r) => {
    const profit = r.netProfit || null;
    const revenue = r.revenue || null;
    const bad = profitIsNegative(profit);
    return {
      id: `results:${r.scId}:${r.resultDate}`,
      severity: bad ? SEVERITY.ALERT : SEVERITY.UPDATE,
      // The results feed dates a filing to the day, not to the minute — so no clock time is
      // invented for it. A blank time column is the honest rendering of "the day, not the hour".
      time: null,
      at: r.resultDate,
      ticker: r.ticker || null,
      company: r.company || r.name || r.ticker || '—',
      headline: `Filed ${r.basis ? r.basis.toLowerCase() : ''} results`.replace(/\s+/g, ' ').trim(),
      detail: [metricPhrase('Revenue', revenue), metricPhrase('Net profit', profit)].filter(Boolean).join(' · ') || 'Figures not carried on this row',
      reason: bad ? profitReason(profit) : null,
      url: r.mcUrl || null,
    };
  });

  return {
    events,
    reachesToday,
    // Normalised to an ISO string: `fetchedAt` is one and `checkedAt` is an epoch number, and
    // `meta.newestRead` sorts these, so a mixed pair would compare a number against a string.
    asOf: m.fetchedAt || (m.checkedAt ? new Date(m.checkedAt).toISOString() : null),
    note: reachesToday ? null : `The newest result this feed holds is ${range.last || 'unknown'} — it has not seen ${day}.`,
  };
}

/**
 * Is the profit reading a negative one?
 *
 * Reads `kind` from `classifyChange()` (worker/mc.mjs) rather than the percentage, because 13% of a
 * full quarter's rows report a move across a sign change where a plain percentage is not a growth
 * rate at all: Vodafone Idea's "+43%" is a loss narrowing. A loss that narrowed is NOT an alert —
 * it improved — and reading the raw percentage would have got that exactly backwards.
 */
function profitIsNegative(metric) {
  if (!metric) return false;
  if (metric.kind === 'slipped-to-loss' || metric.kind === 'loss-widened') return true;
  if (metric.kind === 'normal') return metric.direction < 0;
  return false;
}

function profitReason(metric) {
  if (!metric) return null;
  if (metric.kind === 'slipped-to-loss') return 'Profit last year, loss this quarter';
  if (metric.kind === 'loss-widened') return 'Loss-making in both periods, and the loss widened';
  const pct = metric.pct;
  return pct == null ? 'Net profit fell' : `Net profit fell ${Math.abs(pct).toFixed(1)}%`;
}

/**
 * One metric as a sentence, honouring the sign-change rules: where no honest percentage exists the
 * KIND is named instead, exactly as the Earnings Hub renders it.
 */
function metricPhrase(label, metric) {
  if (!metric) return null;
  switch (metric.kind) {
    case 'turnaround':
      return `${label}: turned profitable`;
    case 'slipped-to-loss':
      return `${label}: slipped to a loss`;
    case 'loss-narrowed':
      return `${label}: loss narrowed`;
    case 'loss-widened':
      return `${label}: loss widened`;
    case 'loss-flat':
      return `${label}: loss unchanged`;
    case 'from-zero':
      return `${label}: no prior-period base`;
    case 'na':
      return null;
    default:
      return metric.pct == null ? null : `${label}: ${metric.pct > 0 ? '+' : ''}${metric.pct.toFixed(1)}%`;
  }
}

/**
 * Calls held today.
 *
 * THE SCORE AND THE TIER ARE THE RESEARCH PROVIDER'S, NOT OURS, and so is the band that turns one
 * red: `resultTierOf` and `sentimentTierOf` use their cut-points, lifted from their own client.
 * Re-banding their score under our colour would present our judgement as theirs. The tab says this
 * in words on every surface it reaches, per the StockScans rule in CLAUDE.md.
 *
 * A `pending` call is an UPDATE, never an alert and never a zero: the call joined the feed when it
 * was held and gains its analysis minutes later. A red row for "not analysed yet" would claim they
 * assessed it and thought little of it.
 */
function fromConcalls({ day, wanted }) {
  const m = concalls.meta() || {};
  const rows = concalls.all().filter((r) => r.date === day && inScope(wanted, r.ticker));

  const events = rows.map((r) => {
    const result = resultTierOf(r.resultScore);
    const sentiment = sentimentTierOf(r.sentimentTier);
    // Their two lowest result bands, and their two lowest sentiment tiers. Their vocabulary, their
    // boundaries — this only decides which of THEIR labels is worth interrupting the reader for.
    const bad = (result && (result.label === 'Poor' || result.label === 'Weak')) || (sentiment && (sentiment.label === 'Bearish' || sentiment.label === 'Cautious'));
    return {
      id: `concall:${concalls.rowUid(r)}`,
      severity: bad ? SEVERITY.ALERT : SEVERITY.UPDATE,
      time: istTime(r.when),
      at: r.when || r.date,
      ticker: r.ticker || null,
      company: r.name || r.ticker || '—',
      headline: 'Earnings call held',
      detail: r.resultScore == null ? 'Analysis pending' : `${result ? result.label : '—'} · score ${r.resultScore.toFixed(1)}/100${sentiment ? ` · ${sentiment.label}` : ''} — a third-party research provider’s assessment, not this dashboard’s`,
      reason: bad ? `The research provider’s own tier for this call is ${[result?.label, sentiment?.label].filter(Boolean).join(' / ')}` : null,
      url: r.ssUrl ? concallUrl(r) : null,
    };
  });

  return {
    events,
    // This feed is a live route with an index that covers today by construction: a call that has
    // been held is in it. Nothing to be behind on.
    reachesToday: true,
    asOf: m?.checkedAt ? new Date(m.checkedAt).toISOString() : null,
  };
}

// The DOCUMENT route, never the company route — the company route needs a period segment the scan
// payload does not carry, and every link built that way 404'd. See CLAUDE.md.
function concallUrl(r) {
  const doc = r.ssUrl || r.pptSsUrl;
  return doc ? `https://www.stockscans.in/document/${encodeURIComponent(doc)}` : null;
}

/**
 * Everything filed to BSE today.
 *
 * ALWAYS AN UPDATE. BSE's `CATEGORYNAME` is their filing taxonomy and not a verdict, so promoting
 * some categories to red would be this dashboard editorialising over somebody else's index. The
 * category is printed instead, in their words, and the reader decides.
 */
function fromAnnouncements({ day, wanted }) {
  const m = announcements.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = announcements.rows().filter((r) => r.date === day && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => ({
    id: `ann:${r.newsId || `${r.ticker}|${r.date}|${i}`}`,
    severity: SEVERITY.UPDATE,
    time: r.time ? String(r.time).slice(0, 5) : null,
    at: r.date,
    ticker: r.ticker || null,
    company: r.company || r.ticker || '—',
    headline: r.title || r.headline || 'Filing',
    detail: [r.category, r.subCategory].filter(Boolean).join(' · ') || 'Category not carried',
    reason: null,
    url: r.url || null,
  }));

  return {
    events,
    // A DATE-INDEXED CAPTURE CAN ANSWER THIS EXACTLY. The snapshot asks BSE what was filed on a
    // day across the whole exchange, so if the capture ran today it has today; if it did not, an
    // empty bucket means nobody looked, not that nobody filed.
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: capturedDay && capturedDay >= day ? null : `The newest capture of the exchange's filings ran on ${capturedDay || 'an unknown date'}, so nothing here has looked at ${day}.`,
  };
}

/**
 * Insider and promoter disclosures broadcast today.
 *
 * ALWAYS AN UPDATE — see the module header. The upstream's own transaction wording is carried into
 * `detail` verbatim, under whatever it called the column, because renaming or grading it would put
 * our word on their data.
 */
function fromInsider({ day, wanted }) {
  const m = insider.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = insider.rows().filter((r) => r.date === day && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => {
    const cells = r.cells || {};
    const pick = (...names) => names.map((n) => cells[n]).find((v) => v != null && v !== '');
    return {
      id: `insider:${r.ticker}|${r.date}|${i}`,
      severity: SEVERITY.UPDATE,
      time: null,
      at: r.date,
      ticker: r.ticker || null,
      company: pick('Company') || r.ticker || '—',
      headline: [pick('Insider'), pick('Transaction', 'Acq/Disp', 'Mode')].filter(Boolean).join(' — ') || 'Insider disclosure',
      detail: [pick('Category'), pick('Mode'), pick('Trade Shares') ? `${pick('Trade Shares')} shares` : null].filter(Boolean).join(' · ') || 'Details not carried',
      reason: null,
      url: null,
    };
  });

  return {
    events,
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: capturedDay && capturedDay >= day ? null : `The newest insider capture ran on ${capturedDay || 'an unknown date'}, so nothing here has looked at ${day}.`,
  };
}

/**
 * Companies that moved more than MOVE_PCT at today's close.
 *
 * A MOVE IS AN EVENT; A SCORE IS A STATE. The technicals feed also carries the model's hard fails
 * and its 24-point score, and neither belongs here: they describe how a company stands, not what
 * happened today, so a daily page would repeat the same rows every day until the reading changed.
 * `pct_change_today` is the one figure in that feed that is about today.
 *
 * The feed is end-of-day, so `reachesToday` is a real question: before the scrape runs, the newest
 * close is yesterday's, and reporting yesterday's moves under today's date would be the worst
 * available answer.
 */
function fromTechnicals({ day, wanted }) {
  const m = technicals.meta() || {};
  const generated = m.generated_at || null;
  // EQUALS, NOT ">=". The other feeds hold rows that carry their own date, so a capture taken
  // later still covers an earlier day. This one holds a single end-of-day snapshot and
  // `pct_change_today` is that day's move and no other — so a snapshot from a different date has
  // nothing to say about this one, and reporting its moves under this date would stamp one day's
  // measurement with another day's label.
  const generatedDay = istDay(generated);
  const reachesToday = generatedDay === day;

  const events = [];
  if (reachesToday) {
    for (const s of technicals.all()) {
      const c = s.company || {};
      const move = c.pct_change_today;
      if (move == null || Math.abs(move) < MOVE_PCT) continue;
      if (!inScope(wanted, c.ticker)) continue;
      const down = move < 0;
      events.push({
        id: `tech:${c.ticker}:${generatedDay}`,
        severity: down ? SEVERITY.ALERT : SEVERITY.UPDATE,
        time: null,
        at: generatedDay,
        ticker: c.ticker || null,
        company: c.name || c.ticker || '—',
        headline: `${down ? 'Fell' : 'Rose'} ${Math.abs(move).toFixed(1)}% at the close`,
        detail: [c.cmp != null ? `Close ₹${c.cmp}` : null, c.rsi14 != null ? `RSI ${c.rsi14}` : null, c.above_200dma === false ? 'below its 200-day average' : null].filter(Boolean).join(' · '),
        reason: down ? `Down ${Math.abs(move).toFixed(1)}% on the day, past the ${MOVE_PCT}% threshold this page states` : null,
        url: c.screenerUrl || null,
      });
    }
  }

  return {
    events,
    reachesToday,
    asOf: generated,
    note: reachesToday ? null : `The end-of-day scrape in this feed closed on ${generatedDay || 'an unknown date'}, so it holds no move for ${day}.`,
  };
}

/**
 * Companies whose mention volume jumped since the previous scrape.
 *
 * `changePct` on this feed is MENTION VOLUME and never a price move — the shared normaliser renames
 * it `mentionsChangePct` for exactly that reason, and so does this.
 *
 * The colour comes from THEIR sentiment label, reproduced, not re-derived from the counts.
 */
function fromChatter({ day, wanted }) {
  const m = chatter.meta();
  if (!m || !m.ok) {
    return { events: [], status: 'failed', reachesToday: false, asOf: m?.generatedAt || null, note: m?.reason ? `The chatter API answered "${m.reason}".` : 'The chatter API could not be read.' };
  }
  // Equals, for the same reason as the technicals feed above: this is one scrape's counts, and
  // `mentionsChangePct` compares it to the scrape before it. It describes the day it ran on.
  const scrapeDay = istDay(m.generatedAt);
  const reachesToday = scrapeDay === day;

  const events = [];
  if (reachesToday) {
    for (const e of chatter.companies()) {
      const change = e.mentionsChangePct;
      if (change == null || Math.abs(change) < CHATTER_PCT) continue;
      if (!inScope(wanted, e.ticker)) continue;
      const bearish = e.sentiment === 'bearish';
      events.push({
        id: `chatter:${e.slug}:${scrapeDay}`,
        severity: bearish ? SEVERITY.ALERT : SEVERITY.UPDATE,
        time: null,
        at: scrapeDay,
        ticker: e.ticker || null,
        company: e.name || e.ticker || '—',
        headline: `Mentions ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(0)}% since the last scrape`,
        detail: `${e.mentions} mentions in the window · sentiment "${e.sentiment}" as the source labels it`,
        reason: bearish ? 'The source labels the sentiment on this company bearish' : null,
        url: null,
      });
    }
  }

  return {
    events,
    reachesToday,
    asOf: m.generatedAt || null,
    note: reachesToday ? null : `The chatter scrape in this feed ran on ${scrapeDay || 'an unknown date'}, so it holds no reading for ${day}.`,
  };
}

/** Company news published today. An article is not a measurement, so it is always an update. */
function fromCompanyNews({ day, wanted }) {
  const m = news.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = news.rows().filter((r) => r.date === day && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => ({
    // THE TICKER IS PART OF THE IDENTITY. One story is returned by several companies' searches,
    // and a RELIANCE row and an HDFCBANK row about the same article are two rows, not one.
    id: `news:${r.ticker || '?'}|${r.url || `${r.date}|${i}`}`,
    severity: SEVERITY.UPDATE,
    time: istTime(r.raw?.page_age) || null,
    at: r.date,
    ticker: r.ticker || null,
    company: r.ticker || '—',
    headline: r.title || 'Story',
    detail: r.source ? `Published by ${r.source}` : 'Publisher not carried',
    reason: null,
    url: r.url || null,
  }));

  return {
    events,
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: capturedDay && capturedDay >= day ? null : `The newest company-news capture ran on ${capturedDay || 'an unknown date'}.`,
  };
}

/**
 * Market-wide stories published today.
 *
 * THESE CARRY NO COMPANY, so they cannot be narrowed by one. Filtering them by ticker would report
 * "your companies are not in the news" when the truth is that nothing on the row says whose it is —
 * the same rule the chatter tab follows for its unresolved half. They appear under Universe and the
 * feed row says why they do not appear under the other two.
 */
function fromMarketNews({ day, scope }) {
  const m = marketNews.meta();
  const capturedDay = istDay(m.capturedAt);
  const scopable = scope === 'universe';

  const events = scopable
    ? marketNews
        .rows()
        .filter((a) => istDay(a.publishedAt) === day)
        .map((a) => ({
          id: `mcnews:${a.id}`,
          severity: SEVERITY.UPDATE,
          time: istTime(a.publishedAt),
          at: a.publishedAt,
          ticker: null,
          // "Market-wide" under a heading that says Company is the honest reading of a row that has
          // no company on it — the section goes in the sub-line, where it describes the story
          // rather than standing in for a name nobody supplied.
          company: 'Market-wide',
          section: a.section || null,
          headline: a.title || 'Story',
          detail: a.summary || 'Market-wide story — no company attached',
          reason: null,
          url: a.url || null,
        }))
    : [];

  return {
    events,
    scopable,
    reachesToday: !!capturedDay && capturedDay >= day,
    asOf: m.capturedAt || null,
    note: scopable
      ? capturedDay && capturedDay >= day
        ? null
        : `The newest market-news capture ran on ${capturedDay || 'an unknown date'}.`
      : 'Market-wide stories carry no company, so they cannot be narrowed to a book or a watchlist. Switch to Universe to see them.',
  };
}

export const feedLabel = (id) => feedById.get(id)?.label || id;
