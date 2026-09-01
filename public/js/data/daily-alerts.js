// data/daily-alerts.js — A NEWEST-FIRST TIMELINE ACROSS FOUR OF THIS DASHBOARD'S TABS.
//
//   const day = today();                     // the IST trading date
//   const report = await collect({ scope, includeHistory: true });
//   report.events   one row per thing in the retained feed windows, newest first
//   report.feeds    one row per feed: what it contributed, and WHETHER IT REACHES TODAY
//
// This module adds no source of its own. Every event on it is a reading taken from a feed that
// already had a tab, which is the whole point: the tabs answer "what does this feed hold", and this
// answers "what happened" by asking several of them the same question at once. The landing tab
// requests retained history; the default remains one day so callers that need a daily report keep
// that exact contract.
//
// ---------------------------------------------------------------------------------------
// WHICH TABS, AND — JUST AS IMPORTANTLY — WHICH NOT
//
// Four: **Breakouts / Technical, News, Corp Announcements and Insider Trades.** News contributes
// twice, because that tab is two feeds behind one name: the per-company search and the market-wide
// capture.
//
// The Earnings Hub, Con-call, Public Chatter and Super Investors are NOT consolidated here. That is
// a deliberate scope, not a gap, and the tab says so on its face — otherwise a reader who knows
// this dashboard has an earnings tab and sees no earnings row would reasonably conclude the page
// was broken. Adding one back is an entry in FEEDS plus a collector; nothing else here is special-
// cased by feed id.
//
// ---------------------------------------------------------------------------------------
// THE TWO COLOURS ARE MEASUREMENTS, NOT OPINIONS — AND ONLY ONE FEED CAN MAKE A RED ONE
//
//   RED (alert)    a direct negative reading on the row itself. On these four tabs there is exactly
//                  one: the price fell more than MOVE_PCT at today's close.
//   ORANGE (update) everything else that arrived on the date carried by the row.
//
// Every red row carries the reading that made it red, in `reason`, in the row. A colour whose cause
// is not on screen beside it is a judgement, and this dashboard does not make those (CLAUDE.md,
// *Honesty rules for the kit*, rule 2: signals must be direct readings).
//
// THAT ONE-SOURCE RULE IS A CONSEQUENCE OF THE SCOPE, NOT A LIMITATION TO PAPER OVER. Three of the
// four tabs carry no model at all, and each for a reason already settled elsewhere in this codebase:
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
//   News. A headline is editorial. Reading a sentiment off it would be inventing a model this
//   dashboard does not have, over somebody else's words.
//
// So a quiet day here reads as a page of orange, and that is the honest rendering: nothing on these
// four tabs measured anything negative. The feeds that DID carry models — the results feed's filed
// figures, the con-call provider's own tiers, the chatter source's own labels — are on their own
// tabs, and the alert card's help modal says where they went.
//
// ---------------------------------------------------------------------------------------
// "NOTHING TODAY" AND "WE HAVE NOT LOOKED AT TODAY" ARE DIFFERENT ANSWERS
//
// All of these feeds are committed captures refreshed on a schedule, and a schedule is best-effort
// (see *And the schedule is best-effort twice over* in CLAUDE.md). So a feed whose newest capture
// predates today CANNOT say nobody filed — it can only say when it last looked. `feeds[]` carries
// `reachesToday` for exactly that, and the tab prints it per feed rather than rendering an empty
// bucket that reads as an all-clear.
//
// AND NOTHING IN HERE WALKS. Every load below is one conditional GET against a committed file or a
// cached route. The three filings feeds are seeded through `feed.seed()`, which is the snapshot and
// this device and no per-company request at all — see js/data/filings.js.
//
// NOTHING HERE POLLS EITHER. All four tabs are scheduled captures rather than live routes, so the
// page is built on mount and rebuilt when the reader presses Refresh — it must never be dressed as
// a live feed, because none of what it reads is one.

import * as technicals from './technicals.js';
import * as marketNews from './market-news.js';
import { announcements, insider, news } from './filings.js';
import { scopeMatcher } from './scope.js';
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
//
// IT IS ALSO THE ONLY THING ON THIS PAGE THAT CAN TURN A ROW RED. See the header: of the four tabs
// this page reads, three carry no model at all, so a price fall past this line is the whole of the
// alert rule. Changing this number changes what "alert" means here, and the tab says so in three
// places — all of which read this constant rather than repeating it.
export const MOVE_PCT = 5;

/**
 * The severity of a day move, or null if it does not reach the threshold at all.
 *
 * Exported because it IS the alert rule, and a rule that only runs inside a collector can only be
 * tested on days the data happens to contain a big faller — which is most days not at all. The
 * suite asserts it directly.
 */
export function moveSeverity(pct) {
  if (pct == null || Number.isNaN(pct) || Math.abs(pct) < MOVE_PCT) return null;
  return pct < 0 ? SEVERITY.ALERT : SEVERITY.UPDATE;
}

export const SEVERITY = { ALERT: 'alert', UPDATE: 'update' };

// ---------------------------------------------------------------------------------------
// Feed registry — id, label, which tab owns it, and what it can contribute
// ---------------------------------------------------------------------------------------

export const FEEDS = [
  { id: 'technicals', label: 'Price moves', tab: 'breakouts', what: `Companies that moved more than ${MOVE_PCT}% at the retained end-of-day snapshot's close.` },
  { id: 'announcements', label: 'Announcements', tab: 'corp-announcements', what: 'Everything filed to BSE in the retained exchange-wide capture.' },
  { id: 'insider', label: 'Insider trades', tab: 'insider-trades', what: 'Retained insider and promoter disclosures, under their broadcast dates.' },
  { id: 'news', label: 'Company news', tab: 'news', what: 'Retained stories about a company in scope, under their published dates.' },
  { id: 'market-news', label: 'Market news', tab: 'news', what: 'Retained market-wide stories. Carries no company, so it is Universe only.' },
];

const feedById = new Map(FEEDS.map((f) => [f.id, f]));

// ---------------------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------------------

/**
 * Read every feed and return the requested day (default) or retained history through it, plus a
 * per-feed account of what was read.
 *
 * `Promise.allSettled`, never `all`: one feed being unreachable must cost that feed's rows and
 * nothing else. A failure becomes a `feeds[]` row saying so — the same rule as everywhere here, a
 * failed read is never an empty result.
 */
export async function collect({ scope = 'universe', day = today(), holdings = null, includeHistory = false, onPartial = null } = {}) {
  const book = holdings || coverage.holdings();
  const wanted = scopeMatcher(scope, book);

  const settledFeeds = new Map(); // feed id -> the finished feed row
  const build = () => assemble({ day, scope, includeHistory, settledFeeds });

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
    FEEDS.map(async (feed) => {
      let out;
      try {
        await LOADERS[feed.id]();
        out = COLLECTORS[feed.id]({ day, scope, wanted, includeHistory }) || {};
      } catch (err) {
        out = { events: [], status: 'failed', reachesToday: false, asOf: null, note: String(err?.message || err) };
      }
      settledFeeds.set(feed.id, toFeedRow(feed, out, day));
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
  technicals: () => technicals.load(),
  announcements: () => announcements.seed(),
  insider: () => insider.seed(),
  news: () => news.seed(),
  'market-news': () => marketNews.load(),
};

const COLLECTORS = {
  technicals: fromTechnicals,
  announcements: fromAnnouncements,
  insider: fromInsider,
  news: fromCompanyNews,
  'market-news': fromMarketNews,
};

function toFeedRow(feed, out, day) {
  const events = (out.events || []).map((event) => ({ ...event, day: eventDay(event) }));
  const days = events.map((event) => event.day).filter(Boolean).sort();
  return {
    ...feed,
    status: out.status || 'ok',
    count: events.length,
    todayCount: events.filter((event) => event.day === day).length,
    oldestDay: days[0] || null,
    newestDay: days.at(-1) || null,
    events,
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
function assemble({ day, scope, includeHistory, settledFeeds }) {
  const feeds = FEEDS.map(
    (feed) => settledFeeds.get(feed.id) || { ...feed, status: 'pending', count: 0, events: [], reachesToday: null, asOf: null, note: null }
  );

  const events = [];
  for (const f of feeds) for (const ev of f.events) events.push({ ...ev, feed: f.id, feedLabel: f.label, tab: f.tab });
  events.sort(byNewestFirst);
  ensureUniqueIds(events);
  const eventDays = [...new Set(events.map((event) => event.day).filter(Boolean))].sort();

  const done = feeds.filter((f) => f.status === 'ok' || f.status === 'failed');
  return {
    day,
    scope,
    includeHistory,
    events,
    feeds,
    pending: feeds.filter((f) => f.status === 'pending').length,
    meta: {
      alerts: events.filter((e) => e.severity === SEVERITY.ALERT).length,
      updates: events.filter((e) => e.severity === SEVERITY.UPDATE).length,
      companies: new Set(events.map((e) => e.ticker).filter(Boolean)).size,
      days: eventDays.length,
      oldestEventDay: eventDays[0] || null,
      newestEventDay: eventDays.at(-1) || null,
      // The FRESHEST feed and the STALEST feed, both, because one number cannot describe eight
      // captures taken at eight different times and picking the freshest would flatter the rest.
      newestRead: maxTime(done.map((f) => f.asOf)),
      oldestRead: minTime(done.filter((f) => f.status === 'ok').map((f) => f.asOf)),
      feedsReachingToday: feeds.filter((f) => f.reachesToday === true).length,
      feedsBehind: feeds.filter((f) => f.reachesToday === false).length,
      feedsPending: feeds.filter((f) => f.status === 'pending').length,
      feedsTotal: feeds.length,
      moveThreshold: MOVE_PCT,
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

/** Newest day first, then newest clock time. A row with no time follows timed rows on that day. */
function byNewestFirst(a, b) {
  const ad = eventDay(a) || '';
  const bd = eventDay(b) || '';
  if (ad !== bd) return bd.localeCompare(ad);
  const at = a.time || '';
  const bt = b.time || '';
  if (at && bt) return bt.localeCompare(at);
  if (at) return -1;
  if (bt) return 1;
  return String(a.company || '').localeCompare(String(b.company || ''));
}

/** The Indian trading date committed on the row, whether `at` is a day or a full instant. */
function eventDay(event) {
  if (event?.day && /^\d{4}-\d{2}-\d{2}$/.test(String(event.day))) return String(event.day);
  const at = event?.at;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at)) return at.slice(0, 10);
  return istDay(at);
}

/** One-day mode matches exactly; history mode includes every retained row through the report day. */
function inRequestedWindow(value, day, includeHistory) {
  const rowDay = typeof value === 'string' ? value.slice(0, 10) : eventDay({ at: value });
  if (!rowDay) return false;
  return includeHistory ? rowDay <= day : rowDay === day;
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

/**
 * Everything filed to BSE today.
 *
 * ALWAYS AN UPDATE. BSE's `CATEGORYNAME` is their filing taxonomy and not a verdict, so promoting
 * some categories to red would be this dashboard editorialising over somebody else's index. The
 * category is printed instead, in their words, and the reader decides.
 */
function fromAnnouncements({ day, wanted, includeHistory }) {
  const m = announcements.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = announcements.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

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
function fromInsider({ day, wanted, includeHistory }) {
  const m = insider.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = insider.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => {
    const cells = r.cells || {};
    const pick = (...names) => names.map((n) => cells[n]).find((v) => v != null && v !== '');
    return {
      // Content-derived rather than position-derived: loading an older day must not rename every
      // row after it, or a refresh would report the whole timeline as newly arrived.
      id: `insider:${r.ticker}|${r.date}|${[pick('Insider'), pick('Transaction', 'Acq/Disp', 'Mode'), pick('Trade Shares'), pick('From Date'), pick('To Date')].filter(Boolean).join('|') || i}`,
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
      // THE ONE ALERT RULE ON THIS PAGE, asked of the exported predicate rather than re-implemented
      // here — the suite tests that predicate directly, and a second copy of the comparison is a
      // second thing that can drift from the number the tab prints.
      const severity = moveSeverity(move);
      if (!severity) continue;
      if (!inScope(wanted, c.ticker)) continue;
      const down = move < 0;
      events.push({
        id: `tech:${c.ticker}:${generatedDay}`,
        severity,
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

/** Company news published today. An article is not a measurement, so it is always an update. */
function fromCompanyNews({ day, wanted, includeHistory }) {
  const m = news.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = news.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => ({
    // THE TICKER IS PART OF THE IDENTITY. One story is returned by several companies' searches,
    // and a RELIANCE row and an HDFCBANK row about the same article are two rows, not one.
    id: `news:${r.ticker || '?'}|${r.url || `${r.date}|${i}`}`,
    severity: SEVERITY.UPDATE,
    // `publishedAt`, NOT `raw.page_age` — `raw` is stripped before the snapshot is committed, so
    // reading the time off it worked on a live walk and returned undefined for every row that came
    // from the file. See `isoInstant` in filings-shared.js.
    time: istTime(r.publishedAt) || null,
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
function fromMarketNews({ day, scope, includeHistory }) {
  const m = marketNews.meta();
  const capturedDay = istDay(m.capturedAt);
  const scopable = scope === 'universe';

  const events = scopable
    ? marketNews
        .rows()
        .filter((a) => inRequestedWindow(a.publishedAt, day, includeHistory))
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
