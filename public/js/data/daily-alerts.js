// data/daily-alerts.js — A NEWEST-FIRST TIMELINE ACROSS THIS DASHBOARD'S RESEARCH FEEDS.
//
//   const day = today();                     // the IST trading date
//   const report = await collect({ scope, includeHistory: true });
//   report.events   one row per thing in the retained feed windows, newest first
//   report.feeds    one row per feed: what it contributed, and WHETHER IT REACHES TODAY
//
// This module adds no source of its own. Every event on it is a reading taken from a feed that
// already had a tab, which is the whole point: the tabs answer "what does this feed hold", and this
// answers "what happened" by asking several of them the same question at once. The timeline tab
// requests retained history; the default remains one day so callers that need a daily report keep
// that exact contract.
//
// ---------------------------------------------------------------------------------------
// Nine feeds are consolidated: price moves, earnings, con-calls, public chatter, investor changes,
// announcements, insider activity, company news and market news. The module still introduces no
// source and never walks companies; it reuses each owning tab's committed snapshot or cached route.
//
// Every event carries TWO INDEPENDENT readings:
//   direction   positive | negative | neutral
//   importance  high | low
// Source-provided bands win where they exist. Announcements use a small, exported keyword policy;
// insider and investor activity use the transaction itself plus stated numeric thresholds. The
// row always carries both reasons, so neither colour is an unexplained judgement. News remains
// neutral: an editorial headline is not sentiment data.
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
// NOTHING HERE STARTS A POLLER. The owning modules may maintain cached/live routes on their own
// tabs; this page takes one reading on mount and another only when the reader presses Refresh.

import * as technicals from './technicals.js';
import * as marketNews from './market-news.js';
import * as earnings from './earnings-live.js';
import * as concalls from './concall-scans.js';
import * as chatter from './chatter-live.js';
import * as investors from './super-investors.js';
import { announcements, insider, news } from './filings.js';
import { insiderTradeSourceUrl } from './filings-shared.js';
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
// The thresholds and signal vocabulary this module states out loud
// ---------------------------------------------------------------------------------------

// A day move big enough to be worth a row. Stated here, printed on the tab, and written into row 1
// of the export — a threshold the reader cannot see is a filter applied on their behalf in secret.
//
// It is the price-feed entry threshold. Changing it also changes that feed's importance rule, and
// the tab, export and tests all read this constant rather than repeating it.
export const MOVE_PCT = 5;
export const INSIDER_HIGH_PCT = 1;
export const INSIDER_HIGH_VALUE = 100_000_000; // ₹10 crore
export const INVESTOR_HIGH_PP = 1;
export const CHATTER_HIGH_MENTIONS = 10;
export const CHATTER_HIGH_CHANGE_PCT = 100;

export const DIRECTION = { POSITIVE: 'positive', NEGATIVE: 'negative', NEUTRAL: 'neutral' };
export const IMPORTANCE = { HIGH: 'high', LOW: 'low' };

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

const signal = (direction, importance, signalReason, importanceReason) => ({
  direction,
  importance,
  signalReason,
  importanceReason,
  // Kept for notification/backward compatibility. The table no longer presents this legacy
  // binary model; a negative reading is an alert and every other reading is an update.
  severity: direction === DIRECTION.NEGATIVE ? SEVERITY.ALERT : SEVERITY.UPDATE,
  reason: signalReason,
});

const textOf = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();

/** Conservative, visible rules over BSE's title/taxonomy. Neutral is the deliberate fallback. */
export function announcementSignal(row = {}) {
  const text = textOf(row.category, row.subCategory, row.title, row.headline);
  const negative = [
    ['rating downgrade', /\b(?:rating\s+)?downgrad(?:e|ed|ing)\b/],
    ['default or insolvency', /\bdefault(?:ed)?\b|\binsolvenc\w*\b|\bbankrupt\w*\b|\bliquidat\w*\b|\bwinding[ -]?up\b/],
    ['fraud or enforcement action', /\bfraud\w*\b|\bpenalt(?:y|ies)\b|\bfine\b|\bshow[ -]?cause\b|\btax demand\b|\bdemand notice\b/],
    ['contract cancellation or suspension', /\b(?:order|contract)\s+(?:cancel\w*|terminat\w*)\b|\bsuspension\b/],
    ['auditor resignation', /\bauditor\w*.{0,80}\bresign\w*\b|\bresign\w*.{0,80}\bauditor\w*\b/],
  ].find(([, re]) => re.test(text));
  // An approval is directional only when the filing also names a regulator or exchange. A client
  // approving a drawing or an internal proposal is not the same event. BSE titles commonly put
  // the noun first ("Receipt of In-Principle Approval from the Stock Exchanges"), so the action
  // accepts both word orders while the context guard keeps the rule narrow.
  const regulatoryApproval =
    /\b(?:approval (?:received|granted)|approved by|receipt of.{0,80}\bapproval)\b/.test(text) &&
    /\b(?:bse|nse|stock exchanges?|sebi|rbi|government|ministr(?:y|ies)|authorit(?:y|ies)|regulator\w*|nclt|courts?|drug controller|usfda|fda)\b/.test(text);
  const positive = [
    ['rating upgrade', /\b(?:rating\s+)?upgrad(?:e|ed|ing)\b/.test(text)],
    ['shareholder distribution', /\bdividend\b|\bbonus (?:issue|share)\b|\bbuyback\b/.test(text)],
    // A bare "order received" is also how adjudication, court and regulator notices are titled.
    // Commercial context is required before that phrase can be called business won.
    ['order or contract award', /\bcontract\s+(?:award\w*|won|received|secured)\b|\b(?:purchase|work|supply|export)\s+order\s+(?:award\w*|won|received|secured)\b|\border\s+(?:award\w*|won|secured)\b|\bawarded (?:an? )?(?:order|contract)\b/.test(text)],
    ['regulatory approval or patent grant', regulatoryApproval || /\bpatent (?:granted|received)\b/.test(text)],
    ['commercial production start', /\bcommercial production (?:commenc(?:ed|ement)|started|began)\b|\b(?:start|commencement) of (?:the )?commercial production\b/.test(text)],
  ].find(([, matched]) => matched);
  const matched = negative || positive;
  const direction = negative ? DIRECTION.NEGATIVE : positive ? DIRECTION.POSITIVE : DIRECTION.NEUTRAL;
  const importance = row.critical === true || matched ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
  return signal(
    direction,
    importance,
    matched ? `Rule-derived from the filing text: ${matched[0]}.` : 'No directional announcement rule matched; shown as neutral.',
    row.critical === true
      ? 'High: BSE marked this filing critical.'
      : matched
        ? 'High: a stated material announcement rule matched.'
        : 'Low: BSE did not mark it critical and no material rule matched.'
  );
}

const numeric = (value) => {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Transaction direction plus comparable, stated thresholds; unknown transaction words stay neutral. */
export function insiderSignal(cells = {}) {
  const transaction = String(cells.Transaction ?? cells['Acq/Disp'] ?? '').trim();
  const mode = String(cells.Mode ?? '').trim();
  const transactionWords = transaction.toLowerCase();
  const modeWords = mode.toLowerCase();
  let direction = DIRECTION.NEUTRAL;
  let basis = 'No recognised directional transaction word was carried; shown as neutral.';
  // Transaction is the authoritative action. Mode describes how it happened and is consulted
  // only for a generic/pledge transaction; otherwise "Disposal · Market Purchase" becomes a buy.
  if (/\b(?:revoke|revocation|release)\w*\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream transaction wording.';
  } else if (/\binvoke\w*\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream transaction wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sale)\b/.test(transactionWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream transaction wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|purchase)\b/.test(transactionWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream transaction wording.';
  } else if (/\bpledge\b/.test(transactionWords)) {
    if (/\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
      direction = DIRECTION.POSITIVE;
      basis = 'Pledge release/revocation in the upstream mode wording.';
    } else {
      direction = DIRECTION.NEGATIVE;
      basis = 'Pledge creation/invocation in the upstream transaction wording.';
    }
  } else if (/\b(?:revoke|revocation|release)\w*\b.*\bpledge\b|\bpledge\b.*\b(?:revoke|revocation|release)\w*\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Pledge release/revocation in the upstream mode wording.';
  } else if (/\b(?:invoke\w*|creat\w*)\b.*\bpledge\b|\bpledge\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Pledge creation/invocation in the upstream mode wording.';
  } else if (/\b(?:disposal|dispose\w*|sell|sale)\b/.test(modeWords)) {
    direction = DIRECTION.NEGATIVE;
    basis = 'Disposal/sale in the upstream mode wording.';
  } else if (/\b(?:acquisition|acquire\w*|buy|purchase)\b/.test(modeWords)) {
    direction = DIRECTION.POSITIVE;
    basis = 'Acquisition/purchase in the upstream mode wording.';
  }

  const pct = numeric(cells['Trade %']);
  const value = numeric(cells['Trade Value']);
  const highPct = pct != null && Math.abs(pct) >= INSIDER_HIGH_PCT;
  const highValue = value != null && Math.abs(value) >= INSIDER_HIGH_VALUE;
  const importance = highPct || highValue ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
  const why = [
    highPct ? `${Math.abs(pct).toFixed(2)}% is at least ${INSIDER_HIGH_PCT}%` : null,
    highValue ? `₹${(Math.abs(value) / 10_000_000).toFixed(1)} crore is at least ₹${INSIDER_HIGH_VALUE / 10_000_000} crore` : null,
  ].filter(Boolean);
  return signal(
    direction,
    importance,
    basis,
    why.length ? `High: ${why.join(' and ')}.` : `Low: below ${INSIDER_HIGH_PCT}% and ₹${INSIDER_HIGH_VALUE / 10_000_000} crore, or those values were not carried.`
  );
}

// ---------------------------------------------------------------------------------------
// Feed registry — id, label, which tab owns it, and what it can contribute
// ---------------------------------------------------------------------------------------

export const FEEDS = [
  { id: 'technicals', label: 'Price moves', tab: 'breakouts', what: `Companies whose last completed close moved more than ${MOVE_PCT}% against the close before it, dated to that session — never to the capture. Moves past the check threshold are re-derived from the Muns market-data endpoint where it answered.` },
  { id: 'earnings', label: 'Earnings', tab: 'earnings-hub', what: 'Filed quarterly results, graded from the source revenue and net-profit comparison.' },
  { id: 'concalls', label: 'Con-calls', tab: 'concall', what: "Held con-calls, using StockScans' own result and sentiment bands." },
  { id: 'chatter', label: 'Public chatter', tab: 'public-chatter', what: "The source's rolling 30-day company sentiment snapshot, dated to its capture." },
  { id: 'investors', label: 'Investor activity', tab: 'super-investors', what: 'Quarter-over-quarter disclosed holding changes from Super Investors, dated to each current investor book confirmation.' },
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
export async function collect({ scope = 'universe', day = today(), holdings = null, includeHistory = false, refresh = false, onPartial = null } = {}) {
  const book = holdings || coverage.holdings();
  const wanted = scopeMatcher(scope, book);

  const settledFeeds = new Map(); // feed id -> the finished feed row
  const build = () => assemble({ day, scope, includeHistory, settledFeeds });

  // EACH FEED SETTLES ON ITS OWN AND THE PAGE PAINTS AS IT DOES.
  //
  // The first version awaited all eight together, and the timeline then sat blank for as long
  // as the SLOWEST of them — measured at 10-15 seconds on a static origin, because the chatter API
  // is a direct call to somebody else's service and an unreachable host takes its own time to say
  // so. Seven feeds that had already answered were held hostage by the one that had not, on the
  // page. `Promise.all` over independent reads is head-of-line blocking with a
  // tidy syntax.
  //
  // So each feed loads, collects and reports independently, and `onPartial` fires every time one
  // lands. Nothing rejects: a feed that throws becomes a row saying so, because a failed read is
  // never an empty result.
  await Promise.all(
    FEEDS.map(async (feed) => {
      let out;
      try {
        await LOADERS[feed.id](refresh);
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
  earnings: (refresh) => refresh ? earnings.refresh() : earnings.load(),
  concalls: (refresh) => refresh ? concalls.refresh() : concalls.load(),
  chatter: (refresh) => refresh ? chatter.refresh() : chatter.load(),
  // One bulk snapshot only. `investors.refresh()` is a ninety-one-request upstream walk and belongs
  // to that tab's explicit "Re-read everything" control, not this consolidated header button.
  investors: (refresh) => refresh ? investors.refreshSnapshot() : investors.load(),
  announcements: () => announcements.seed(),
  insider: () => insider.seed(),
  news: () => news.seed(),
  'market-news': () => marketNews.load(),
};

const COLLECTORS = {
  technicals: fromTechnicals,
  earnings: fromEarnings,
  concalls: fromConcalls,
  chatter: fromChatter,
  investors: fromInvestors,
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
      positive: events.filter((e) => e.direction === DIRECTION.POSITIVE).length,
      negative: events.filter((e) => e.direction === DIRECTION.NEGATIVE).length,
      neutral: events.filter((e) => e.direction === DIRECTION.NEUTRAL).length,
      highImportance: events.filter((e) => e.importance === IMPORTANCE.HIGH).length,
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

const maxTime = (list) => latestConfirmation(...list);
const minTime = (list) => {
  let oldest = null;
  let oldestMs = Infinity;
  for (const value of list.filter((v) => v != null)) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(ms) && ms < oldestMs) {
      oldest = value;
      oldestMs = ms;
    }
  }
  return oldest;
};

/** Newest real confirmation across mixed ISO-string and epoch timestamps. */
function latestConfirmation(...values) {
  let latest = null;
  let latestMs = -Infinity;
  for (const value of values.filter((v) => v != null)) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

const inScope = (wanted, ticker) => !wanted || (!!ticker && wanted.has(String(ticker).toUpperCase()));

// ---------------------------------------------------------------------------------------
// Per-feed collectors
//
// Each returns { events, status, reachesToday, asOf, note }. `reachesToday` is the honest half:
// a collector that finds nothing must say whether it LOOKED at today.
// ---------------------------------------------------------------------------------------

const metricText = (metric) => {
  if (!metric) return null;
  const label = metric.label || 'Metric';
  const pct = numeric(metric.pct);
  if (metric.kind === 'turnaround') return `${label} to profit`;
  if (metric.kind === 'slipped-to-loss') return `${label} to loss`;
  if (metric.kind === 'loss-narrowed') return `${label} loss narrowed${pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`}`;
  if (metric.kind === 'loss-widened') return `${label} loss widened${pct == null ? '' : ` ${Math.abs(pct).toFixed(1)}%`}`;
  if (metric.kind === 'loss-flat') return `${label} loss flat`;
  if (metric.kind === 'flat') return `${label} 0%`;
  if (metric.kind !== 'normal' || pct == null) return `${label} comparison unavailable`;
  return `${label} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
};

/** Filed results. Direction uses the source's YoY/QoQ revenue and net-profit comparisons. */
function fromEarnings({ day, wanted, includeHistory }) {
  const m = earnings.meta() || {};
  const degraded = !!m.degraded;
  // Reading a committed file proves only that the file is readable now, not that Moneycontrol was
  // read now. `checkedAt` is source freshness only for a live/store confirmation.
  const confirmedAt = degraded || m.origin === 'snapshot' ? m.fetchedAt : latestConfirmation(m.checkedAt, m.fetchedAt);
  const fetchedDay = istDay(confirmedAt);
  const basis = String(m.subType || 'yoy').toUpperCase();
  const rows = earnings.all().filter((r) => inRequestedWindow(r.resultDate, day, includeHistory) && inScope(wanted, r.ticker));
  const events = rows.map((r) => {
    const revenue = Number(r.revenue?.direction || 0);
    const profit = Number(r.netProfit?.direction || 0);
    const direction = profit > 0 && revenue >= 0
      ? DIRECTION.POSITIVE
      : profit < 0 && revenue <= 0
        ? DIRECTION.NEGATIVE
        : DIRECTION.NEUTRAL;
    const reading = direction === DIRECTION.POSITIVE
      ? `${basis}: net profit rose and revenue did not fall.`
      : direction === DIRECTION.NEGATIVE
        ? `${basis}: net profit fell and revenue did not rise.`
        : `${basis}: revenue and net profit were mixed or flat; shown as neutral.`;
    return {
      id: `earnings:${r.scId || r.ticker}:${r.resultDate}:${basis}`,
      ...signal(direction, IMPORTANCE.HIGH, reading, 'High: a quarterly financial result was filed.'),
      time: null,
      at: r.resultDate,
      ticker: r.ticker || null,
      company: r.company || r.fullName || r.name || r.ticker || '—',
      headline: `${basis} quarterly result filed`,
      detail: [metricText(r.revenue), metricText(r.netProfit)].filter(Boolean).join(' · ') || 'Filed figures carried without a comparable percentage',
      url: r.mcUrl || null,
    };
  });
  return {
    events,
    status: degraded ? 'failed' : 'ok',
    reachesToday: !degraded && !!fetchedDay && fetchedDay >= day,
    asOf: confirmedAt,
    note: degraded
      ? `The earnings feed is using its retained snapshot because the live read degraded (${m.degraded}).`
      : fetchedDay && fetchedDay >= day ? null : `The earnings feed was last read on ${fetchedDay || 'an unknown date'}.`,
  };
}

/** Held con-calls, reproducing StockScans' own sentiment and result bands. */
function fromConcalls({ day, wanted, includeHistory }) {
  const m = concalls.meta() || {};
  const degraded = !!m.degraded;
  const confirmedAt = degraded || m.origin === 'snapshot' ? m.fetchedAt : latestConfirmation(m.checkedAt, m.fetchedAt);
  const fetchedDay = istDay(confirmedAt);
  const rows = concalls.all().filter((r) => inRequestedWindow(r.date || r.when, day, includeHistory) && inScope(wanted, r.ticker));
  const events = rows.map((r) => {
    const sentiment = r.sentiment?.label || null;
    const direction = ['Bullish', 'Optimistic'].includes(sentiment)
      ? DIRECTION.POSITIVE
      : ['Bearish', 'Cautious'].includes(sentiment)
        ? DIRECTION.NEGATIVE
        : DIRECTION.NEUTRAL;
    const analysed = r.resultScore != null;
    const importance = direction !== DIRECTION.NEUTRAL || (analysed && (r.resultScore >= 80 || r.resultScore < 20))
      ? IMPORTANCE.HIGH
      : IMPORTANCE.LOW;
    const result = r.resultTier?.label ? `${r.resultTier.label} result score ${Number(r.resultScore).toFixed(1)}` : 'result analysis pending';
    return {
      id: `concall:${concalls.rowUid(r)}`,
      ...signal(
        direction,
        importance,
        sentiment ? `StockScans sentiment: ${sentiment}.` : 'StockScans sentiment is pending; shown as neutral.',
        importance === IMPORTANCE.HIGH ? `High: non-neutral sentiment or an extreme StockScans result band (${result}).` : `Low: neutral or pending analysis (${result}).`
      ),
      time: istTime(r.when),
      at: r.when || r.date,
      ticker: r.ticker || null,
      company: r.name || r.ticker || '—',
      headline: `Con-call ${analysed ? 'analysis published' : 'held; analysis pending'}`,
      detail: [result, ...(r.tags || []).slice(0, 2)].join(' · '),
      url: r.transcriptUrl || null,
    };
  });
  return {
    events,
    status: degraded ? 'failed' : 'ok',
    reachesToday: !degraded && !!fetchedDay && fetchedDay >= day,
    asOf: confirmedAt,
    note: degraded
      ? `The con-call feed is using its retained snapshot because the live read degraded (${m.degraded}).`
      : fetchedDay && fetchedDay >= day ? null : `The con-call feed was last read on ${fetchedDay || 'an unknown date'}.`,
  };
}

/** One event per covered company in the source's rolling public-chatter snapshot. */
function fromChatter({ day, wanted, includeHistory }) {
  const m = chatter.meta() || {};
  const generatedDay = istDay(m.generatedAt);
  const inWindow = inRequestedWindow(generatedDay, day, includeHistory);
  const rows = inWindow ? chatter.companies().filter((r) => inScope(wanted, r.ticker)) : [];
  const events = rows.map((r) => {
    const label = String(r.sentiment?.label || 'neutral').toLowerCase();
    const direction = label === 'bullish' ? DIRECTION.POSITIVE : label === 'bearish' ? DIRECTION.NEGATIVE : DIRECTION.NEUTRAL;
    const mentions = numeric(r.mentions) || 0;
    const change = numeric(r.mentionsChangePct);
    const importance = mentions >= CHATTER_HIGH_MENTIONS || (change != null && Math.abs(change) >= CHATTER_HIGH_CHANGE_PCT)
      ? IMPORTANCE.HIGH
      : IMPORTANCE.LOW;
    const threshold = [
      mentions >= CHATTER_HIGH_MENTIONS ? `${mentions} mentions` : null,
      change != null && Math.abs(change) >= CHATTER_HIGH_CHANGE_PCT ? `${Math.abs(change).toFixed(0)}% mention change` : null,
    ].filter(Boolean);
    return {
      id: `chatter:${r.ticker}:${m.generatedAt || generatedDay}`,
      ...signal(
        direction,
        importance,
        `Source rolling-${m.window || '30d'} sentiment: ${r.sentiment?.labelText || r.sentiment?.label || 'Neutral'}.`,
        importance === IMPORTANCE.HIGH
          ? `High: ${threshold.join(' and ')} reached the stated chatter threshold.`
          : `Low: fewer than ${CHATTER_HIGH_MENTIONS} mentions and less than ${CHATTER_HIGH_CHANGE_PCT}% absolute mention change.`
      ),
      time: istTime(m.generatedAt),
      at: m.generatedAt || generatedDay,
      // `at` is a UTC instant. Preserve the already-computed IST date so an evening capture does
      // not move back one day when `eventDay()` sees the ISO prefix.
      day: generatedDay,
      ticker: r.ticker || null,
      company: r.name || r.ticker || '—',
      headline: `${r.sentiment?.labelText || r.sentiment?.label || 'Neutral'} public chatter`,
      detail: `${mentions} mentions in the rolling ${m.window || '30d'} window${change == null ? '' : ` · ${change > 0 ? '+' : ''}${change.toFixed(0)}% vs prior window`}`,
      url: m.url || null,
    };
  });
  return {
    events,
    status: m.ok === false ? 'failed' : 'ok',
    reachesToday: m.ok === false ? false : generatedDay === day,
    asOf: latestConfirmation(m.checkedAt, m.generatedAt),
    note: m.ok === false
      ? `Public Chatter could not be confirmed (${m.reason || 'upstream'}).${events.length ? ' Retained rows remain visible.' : ''}`
      : generatedDay === day
        ? null
        : `Public Chatter is a rolling snapshot last generated on ${generatedDay || 'an unknown date'}; it is not a post-by-post event log.`,
  };
}

const investorTicker = (move) => {
  const slug = String(move.companySlug || '').trim().toUpperCase();
  return slug && !slug.startsWith('SCRIP-') ? slug : null;
};

/** The complete/incomplete rule for the investor feed, exported so an outage is testable. */
export function investorCoverageState(m = {}) {
  const listFailed = m.ok === false;
  const missingBooks = Number(m.pending || 0) + Number(m.failedBooks || 0);
  const staleBooks = Number(m.staleBooks || 0);
  const incomplete = listFailed || missingBooks > 0 || m.stale === true || staleBooks > 0;
  const problems = [
    listFailed
      ? `the investor list could not be read${m.reason || m.message ? ` (${m.reason || m.message})` : ''}`
      : null,
    missingBooks > 0 ? `${m.loadedBooks || 0} of ${m.total || 0} investor books are available; ${missingBooks} could not be included` : null,
    staleBooks > 0
      ? `${staleBooks} investor book${staleBooks === 1 ? ' is' : 's are'} last-good fallback data${m.staleReason ? ` (${m.staleReason})` : ''}`
      : m.stale === true
        ? `the investor list is last-good fallback data${m.staleReason ? ` (${m.staleReason})` : ''}`
        : null,
  ].filter(Boolean);
  return { incomplete, missingBooks, staleBooks, problems };
}

/** Quarterly disclosed holding changes. A disappearance is labelled, not overstated as a sale. */
function fromInvestors({ day, scope, wanted, includeHistory }) {
  const m = investors.meta() || {};
  const confirmedAt = (move) => investors.confirmedAtFor(move.slug) || m.checkedAt || m.capturedAt || m.fetchedAt;
  const moves = investors.allMoves().filter((move) => {
    const confirmedDay = istDay(confirmedAt(move));
    const ticker = investorTicker(move);
    return move.action !== 'held'
      && inRequestedWindow(confirmedDay, day, includeHistory)
      && (ticker ? inScope(wanted, ticker) : scope === 'universe');
  });
  const events = moves.map((move) => {
    const ticker = investorTicker(move);
    const bookConfirmedAt = confirmedAt(move);
    const confirmedDay = istDay(bookConfirmedAt);
    const positive = move.action === 'new' || move.action === 'added';
    const direction = positive ? DIRECTION.POSITIVE : DIRECTION.NEGATIVE;
    const presenceChange = move.action === 'new' || move.action === 'exited';
    const largeDelta = move.deltaPp != null && Math.abs(move.deltaPp) >= INVESTOR_HIGH_PP;
    const importance = presenceChange || largeDelta ? IMPORTANCE.HIGH : IMPORTANCE.LOW;
    const actionText = {
      new: 'newly disclosed',
      added: `increased by ${Math.abs(move.deltaPp || 0).toFixed(2)}pp`,
      trimmed: `reduced by ${Math.abs(move.deltaPp || 0).toFixed(2)}pp`,
      exited: 'no longer disclosed',
    }[move.action] || move.action;
    return {
      id: `investor:${move.slug}:${move.companySlug}:${move.latest}:${move.action}`,
      ...signal(
        direction,
        importance,
        `${move.investor}'s holding was ${actionText} between ${move.prior} and ${move.latest}.`,
        presenceChange
          ? 'High: the holding appeared in or disappeared from disclosure.'
          : importance === IMPORTANCE.HIGH
            ? `High: the disclosed holding changed by at least ${INVESTOR_HIGH_PP} percentage point.`
            : `Low: the disclosed holding changed by less than ${INVESTOR_HIGH_PP} percentage point.`
      ),
      time: istTime(bookConfirmedAt),
      at: bookConfirmedAt || confirmedDay,
      day: confirmedDay,
      ticker,
      company: move.company || ticker || '—',
      headline: `${move.investor}: ${actionText}`,
      detail: `${move.prior} → ${move.latest}${move.action === 'exited' ? ' · “No longer disclosed” does not prove a complete sale.' : ''}`,
      url: move.companySlug ? `https://ticker.finology.in/company/${encodeURIComponent(move.companySlug)}` : null,
    };
  });
  // `meta().checkedAt` is deliberately the OLDEST confirmation behind the current set of books.
  // It is therefore the only honest feed-wide freshness claim when books were confirmed at
  // different moments; individual rows above keep the confirmation for their own investor book.
  const coverageAt = m.checkedAt || m.capturedAt || m.fetchedAt;
  const coverageDay = istDay(coverageAt);
  const coverage = investorCoverageState(m);
  return {
    events,
    status: coverage.incomplete ? 'failed' : 'ok',
    reachesToday: !coverage.incomplete && coverageDay === day,
    asOf: coverageAt || null,
    note: coverage.incomplete
      ? `${coverage.problems.join('; ')}. This reading is incomplete.`
      : coverageDay === day
      ? 'Investor changes are quarterly disclosure comparisons dated to each investor book confirmation, not trade timestamps.'
      : `Investor changes are quarterly disclosure comparisons; the oldest current book confirmation is ${coverageDay || 'unknown'}, not a trade date.`,
  };
}

/** Everything filed to BSE, with the exported conservative rule and BSE's own critical flag. */
function fromAnnouncements({ day, wanted, includeHistory }) {
  const m = announcements.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = announcements.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => ({
    id: `ann:${r.newsId || `${r.ticker}|${r.date}|${i}`}`,
    ...announcementSignal(r),
    time: r.time ? String(r.time).slice(0, 5) : null,
    at: r.date,
    ticker: r.ticker || null,
    company: r.company || r.ticker || '—',
    headline: r.title || r.headline || 'Filing',
    detail: [r.category, r.subCategory].filter(Boolean).join(' · ') || 'Category not carried',
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

/** Insider and promoter disclosures, classified from the transaction and measurable size. */
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
      ...insiderSignal(cells),
      time: null,
      at: r.date,
      ticker: r.ticker || null,
      company: pick('Company') || r.ticker || '—',
      headline: [pick('Insider'), pick('Transaction', 'Acq/Disp', 'Mode')].filter(Boolean).join(' — ') || 'Insider disclosure',
      detail: [pick('Category'), pick('Mode'), pick('Trade Shares') ? `${pick('Trade Shares')} shares` : null].filter(Boolean).join(' · ') || 'Details not carried',
      // Prefer the exchange filing URL when one is carried; otherwise use the same exact-insider
      // public disclosure search as the Insider Trades tab. AI Alerts can then trace this evidence
      // to a public record instead of ending at a derived dashboard sentence.
      url: insiderTradeSourceUrl(r),
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
function fromTechnicals({ day, wanted, includeHistory }) {
  const m = technicals.meta() || {};
  const generated = m.generated_at || null;
  // THE MOVE IS DATED BY ITS SESSION, NOT BY THE CAPTURE. `pct_change_today` is the change between
  // a company's last two completed closes, and the file says which session that close belongs to
  // (`price_date`, per row `bar_date`). The scrape is scheduled for 07:00 IST — the morning AFTER
  // those closes — and when GitHub ran it late, mid-session, the capture day and the session day
  // disagreed in the other direction too: an unfinished 2 September bar was printed as that day's
  // close. Dating by the capture was wrong both ways. A file from before `price_date` existed falls
  // back to the capture's IST day, which is the best it can say.
  const priceDay = m.price_date || istDay(generated);
  // EQUALS, NOT ">=". This feed holds ONE session's closes and nothing about any other day.
  const reachesToday = priceDay === day;

  const events = [];
  for (const s of technicals.all()) {
    const c = s.company || {};
    const move = c.pct_change_today;
    // THE ONE ALERT RULE ON THIS PAGE, asked of the exported predicate rather than re-implemented
    // here — the suite tests that predicate directly, and a second copy of the comparison is a
    // second thing that can drift from the number the tab prints.
    const severity = moveSeverity(move);
    if (!severity) continue;
    if (!inScope(wanted, c.ticker)) continue;
    const barDay = c.bar_date || priceDay;
    // A row priced on another session than the file's is still that session's move, dated so —
    // and, like every other feed's rows, it is reported only inside the requested window.
    if (!inRequestedWindow(barDay, day, includeHistory)) continue;
    const down = move < 0;
    const verified = c.move_source ? ` Re-derived from the Muns market-data endpoint's closes (${c.move_check}).` : '';
    events.push({
      id: `tech:${c.ticker}:${barDay}`,
      ...signal(
        down ? DIRECTION.NEGATIVE : DIRECTION.POSITIVE,
        IMPORTANCE.HIGH,
        `${down ? 'Down' : 'Up'} ${Math.abs(move).toFixed(1)}% between the ${c.prev_bar_date || c.move_prev_date || 'previous'} and ${barDay} closes, past the ${MOVE_PCT}% threshold this page states.${verified}`,
        `High: the absolute day move reached the stated ${MOVE_PCT}% threshold.`
      ),
      time: null,
      at: barDay,
      ticker: c.ticker || null,
      company: c.name || c.ticker || '—',
      headline: `${down ? 'Fell' : 'Rose'} ${Math.abs(move).toFixed(1)}% at the ${barDay} close`,
      detail: [c.cmp != null ? `Close ₹${Number(c.cmp).toFixed(2)}` : null, c.prev_bar_date ? `vs ${c.prev_bar_date}` : null, c.rsi14 != null ? `RSI ${c.rsi14}` : null, c.above_200dma === false ? 'below its 200-day average' : null].filter(Boolean).join(' · '),
      url: c.screenerUrl || null,
    });
  }

  return {
    events,
    reachesToday,
    asOf: generated,
    note: reachesToday ? null : `The latest completed close in this feed is ${priceDay || 'unknown'}; there is no close for ${day} yet.`,
  };
}

/** Company news published today. An editorial headline is not sentiment data, so it stays neutral. */
function fromCompanyNews({ day, wanted, includeHistory }) {
  const m = news.meta();
  const capturedDay = istDay(m.capturedAt);
  const rows = news.rows().filter((r) => inRequestedWindow(r.date, day, includeHistory) && inScope(wanted, r.ticker));

  const events = rows.map((r, i) => ({
    // THE TICKER IS PART OF THE IDENTITY. One story is returned by several companies' searches,
    // and a RELIANCE row and an HDFCBANK row about the same article are two rows, not one.
    id: `news:${r.ticker || '?'}|${r.url || `${r.date}|${i}`}`,
    ...signal(DIRECTION.NEUTRAL, IMPORTANCE.LOW, 'Publisher headline; not directionally graded.', 'Low: no structured materiality field is carried.'),
    // `publishedAt`, NOT `raw.page_age` — `raw` is stripped before the snapshot is committed, so
    // reading the time off it worked on a live walk and returned undefined for every row that came
    // from the file. See `isoInstant` in filings-shared.js.
    time: istTime(r.publishedAt) || null,
    at: r.date,
    ticker: r.ticker || null,
    company: r.ticker || '—',
    headline: r.title || 'Story',
    detail: r.source ? `Published by ${r.source}` : 'Publisher not carried',
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
          ...signal(DIRECTION.NEUTRAL, IMPORTANCE.LOW, 'Publisher headline; not directionally graded.', 'Low: no structured materiality field is carried.'),
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
