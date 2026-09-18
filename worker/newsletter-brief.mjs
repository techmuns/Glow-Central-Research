// worker/newsletter-brief.mjs — the brief itself: what goes in it, where each figure comes from,
// and the email it is rendered into. Pure apart from the injected `fetcher`, `env.ASSETS` and the
// breakout capture's Durable Object, so `scripts/verify-newsletter.mjs` builds one offline against
// fixtures and the committed data files.
//
// WHAT THE DESK ASKED FOR, in their words: "the global indices — S&P, NASDAQ, what was the movement
// on the previous day; then the morning Asian indices move, Japan, Taiwan, China; then certain
// commodities like Brent, which is critical for us, and then gold, silver; then certain currencies
// like the dollar index, and USDJPY" — plus "corporate announcements and news", and "in the email,
// I would just send for direct ones". So:
//
//   1. GLOBAL MARKET SCAN — live quotes read at send time from Yahoo's public chart endpoint, one
//      symbol per request, each row carrying its OWN state and time: `Close · Wed 16:00 EDT` for a
//      market that has shut, `Live · 07:58 JST` for one still trading. The series store under
//      public/data/series/ is the fallback for a symbol Yahoo would not answer, and a row filled
//      from it says so and prints the store's date — never a stale close dressed as this morning's.
//   2. CORPORATE ANNOUNCEMENTS · DIRECT HOLDINGS — NSE's live announcements feed, read the way
//      /api/nse-announcements reads it, PLUS the per-day history the hourly NSE capture retains
//      under public/data/nse-filings/ (the live RSS holds the last few minutes of the exchange, not
//      a window), plus BSE's date-indexed capture from the committed file — all narrowed to the
//      book's listed lines and to the brief's window. Routine filings (newspaper copies, NAV
//      declarations, trading-window and certificate notices — `announcementTypeOf`, the same rule
//      the Corp Announcements tab hides by default) are counted on the page and not listed.
//   3. NEWS · DIRECT HOLDINGS — the four publishers' feeds already captured for the News tab,
//      joined to the book by the same identity match the tab uses (`matchPortfolioNews`), so an
//      email can never name a company the dashboard would not; plus the symbol-tagged headlines
//      the TradingView capture keeps per holding, which need no name match at all.
//   4. TRADES · DIRECT HOLDINGS — bulk deals, block deals, SAST and insider disclosures from the
//      insider capture's monthly archive, read with the same direction and thresholds General
//      Alerts read them with (`insiderSignal`), one row per economic event (`insiderTradeIdentity`).
//   5. PRICE MOVES · DIRECT HOLDINGS — a holding that closed ±MOVE_PCT on the session, the same
//      bar General Alerts raise a price-move row at: the evening brief reads the breakout capture's
//      closing quotes, the morning brief the completed daily bars, and each says which it read.
//
// "DIRECT ONES" MEANS `portfolio-companies.json`: the family's listed direct-equity lines, one per
// NSE symbol, the same file the Portfolio scope means on every tab. Fund units, AIFs and the
// ring-fenced holding are outside it there and outside it here.
//
// NOTHING FALLS BETWEEN TWO BRIEFS. Every source here is a capture with a lag, so a brief also reads
// back over the two windows before its own (`lateArrivalsFrom`) and carries anything the ledger of
// sent items (`newsletter-store.mjs`) does not hold, printed as "not in the previous brief" with its
// own publication time. A missed edition's window is therefore carried by the next one rather than
// lost. The ledger is consulted, never written, here: the schedule writes it after a send reaches
// somebody.
//
// NOTHING IS SCORED, SUMMARISED OR RANKED BEYOND THE DASHBOARD'S OWN STATED RULES. Headlines and
// filing subjects are the publishers' and the exchanges' own words; a tracked-keyword tag says what
// a story is ABOUT, never what it means (see data/news-keywords.js); a filing's mood is
// `announcementSignal()`, a trade's is its own transaction word, a price move's is its sign, and a
// published headline carries none. Every section states its window, its source and when that
// source was read, and a source that could not be read says so in the email rather than going quiet.

import { FEED_URL as NSE_FEED_URL, HEADERS as NSE_HEADERS, assertShape as assertNseShape, buildResolver, parseAnnouncements, resolveAll, resolveRow } from './nse-ann.mjs';
import { filingKey as nseFilingKey } from '../public/js/data/nse-history-shared.js';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { matchPortfolioNews } from '../public/js/data/portfolio-news-matching.js';
import { matchKeywords } from '../public/js/data/news-keywords.js';
import { announcementSignal } from '../public/js/data/filing-signals.js';
import { announcementTypeOf } from '../public/js/data/announcement-types.js';
import { insiderSignal } from '../public/js/data/insider-signal.js';
import { insiderTradeIdentity } from '../public/js/data/insider-history.js';
import { insiderTradeSourceUrl } from '../public/js/data/filings-shared.js';
import { BREAKOUT_OBJECT, expectedSession, quoteFresh } from '../public/js/data/breakout-live-shared.js';
import { EDITIONS, dayOnlyInstant, editionWindow, istDay, istDateLong, istInstant, istLabel, istTime, lateArrivalsFrom } from '../public/js/data/newsletter-shared.js';

export const PRODUCTION_ORIGIN = 'https://glow-central-research.tech-441.workers.dev';
export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
export const YAHOO_USER_AGENT = 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)';
export const QUOTE_POOL = 6;
export const QUOTE_TIMEOUT_MS = 8000;
export const NSE_TIMEOUT_MS = 15000;
export const ANNOUNCEMENT_LIMIT = 80;
export const NEWS_LIMIT = 60;
export const TRADE_LIMIT = 40;
export const MOVE_LIMIT = 30;
export const PER_COMPANY_LIMIT = 8;
// The price-move bar is General Alerts' own (`MOVE_PCT` in public/js/data/daily-alerts.js, which
// imports browser modules and so cannot be imported here). Change both or neither.
export const MOVE_PCT = 5;

export const BOOK_PATH = '/data/portfolio-companies.json';
export const BSE_PATH = '/data/corp-announcements.json';
export const NSE_HISTORY_INDEX_PATH = '/data/nse-filings/index.json';
export const nseHistoryDayPath = (day) => `/data/nse-filings/${day}.json`;
export const PUBLISHERS_PATH = '/data/market-news.json';
export const TRADINGVIEW_PATH = '/data/tradingview-news/latest.json';
export const INSIDER_ARCHIVE_INDEX_PATH = '/data/insider-archive/index.json';
export const insiderArchiveMonthPath = (month) => `/data/insider-archive/${month}.json`;
export const IDENTITIES_PATH = '/data/announcement-identities.json';
export const TECHNICALS_PATH = '/data/technicals.json';
export const SERIES_INDEX_PATH = '/data/series/index.json';

// The scan, in the order the desk reads it. `series` names the fallback in the macro store.
export const MARKET_GROUPS = [
  { id: 'us', label: 'United States' },
  { id: 'asia', label: 'Asia' },
  { id: 'india', label: 'India' },
  { id: 'commodities', label: 'Commodities' },
  { id: 'currencies', label: 'Currencies' },
  { id: 'rates', label: 'Rates' },
];
export const MARKET_ROWS = [
  { id: 'sp500', symbol: '^GSPC', label: 'S&P 500', group: 'us', kind: 'index', series: 'sp500' },
  { id: 'nasdaq', symbol: '^IXIC', label: 'Nasdaq Composite', group: 'us', kind: 'index', series: 'nasdaq' },
  { id: 'dow', symbol: '^DJI', label: 'Dow Jones', group: 'us', kind: 'index', series: 'dow-jones' },
  { id: 'nikkei', symbol: '^N225', label: 'Nikkei 225', group: 'asia', kind: 'index', series: 'nikkei-225' },
  { id: 'taiex', symbol: '^TWII', label: 'Taiwan TAIEX', group: 'asia', kind: 'index' },
  { id: 'shanghai', symbol: '000001.SS', label: 'Shanghai Composite', group: 'asia', kind: 'index', series: 'shanghai-composite' },
  { id: 'hangseng', symbol: '^HSI', label: 'Hang Seng', group: 'asia', kind: 'index', series: 'hang-seng' },
  { id: 'kospi', symbol: '^KS11', label: 'Kospi', group: 'asia', kind: 'index' },
  { id: 'nifty', symbol: '^NSEI', label: 'Nifty 50', group: 'india', kind: 'index', series: 'nifty-50' },
  { id: 'sensex', symbol: '^BSESN', label: 'Sensex', group: 'india', kind: 'index', series: 'sensex' },
  { id: 'brent', symbol: 'BZ=F', label: 'Brent crude', unit: '$/bbl', group: 'commodities', kind: 'price', series: 'brent-crude' },
  { id: 'gold', symbol: 'GC=F', label: 'Gold', unit: '$/oz', group: 'commodities', kind: 'price', series: 'gold' },
  { id: 'silver', symbol: 'SI=F', label: 'Silver', unit: '$/oz', group: 'commodities', kind: 'price', series: 'silver' },
  { id: 'dxy', symbol: 'DX-Y.NYB', label: 'Dollar index (DXY)', group: 'currencies', kind: 'index', series: 'dxy' },
  { id: 'usdjpy', symbol: 'JPY=X', label: 'USD/JPY', group: 'currencies', kind: 'fx', series: 'usd-jpy' },
  { id: 'usdinr', symbol: 'INR=X', label: 'USD/INR', group: 'currencies', kind: 'fx', series: 'usd-inr' },
  { id: 'us10y', symbol: '^TNX', label: 'US 10-year yield', group: 'rates', kind: 'yield', series: 'us-10y' },
];
const GLANCE = { morning: ['sp500', 'nikkei', 'brent', 'usdjpy'], evening: ['nifty', 'sensex', 'brent', 'usdinr'] };

const reasonOf = (error) => {
  if (error?.reason) return String(error.reason);
  const name = String(error?.name || '');
  if (/abort|timeout/i.test(name)) return 'timeout';
  return /shape/i.test(String(error?.message || '')) ? 'shape' : 'unreachable';
};

async function pooled(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

/** One committed JSON asset, read through the Worker's own assets binding; null when unavailable. */
export async function readAsset(env, path) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(path, PRODUCTION_ORIGIN)));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ---- 1. the market scan -------------------------------------------------------------------------

/**
 * One quote from a Yahoo chart response. `live` is decided by Yahoo's own session bounds: the
 * last print fell inside the current regular session and that session has not yet ended.
 */
export function quoteFromChart(body, row, now) {
  const meta = body?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) throw Object.assign(new Error('Yahoo chart shape'), { reason: 'shape' });
  const last = meta.regularMarketPrice;
  const prev = Number.isFinite(meta.chartPreviousClose) ? meta.chartPreviousClose : null;
  const asOf = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null;
  const regular = meta.currentTradingPeriod?.regular;
  const live = !!regular && asOf != null && asOf >= regular.start * 1000 && now < regular.end * 1000;
  return {
    ...row, last, prev,
    change: prev != null ? last - prev : null,
    changePct: prev ? ((last - prev) / prev) * 100 : null,
    asOf, state: live ? 'live' : 'close',
    timezone: typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : null,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    origin: 'yahoo',
  };
}

/** The same row filled from the macro series store, dated to the store, for a symbol Yahoo refused. */
export function quoteFromSeries(manifest, row) {
  const series = (manifest?.series || []).find((s) => s?.id === row.series);
  if (!series || !Number.isFinite(series.last_value) || !series.last) return null;
  const d1 = Number.isFinite(series.returns?.d1) ? series.returns.d1 : null;
  const last = series.last_value;
  return {
    ...row, last,
    prev: d1 != null ? last / (1 + d1 / 100) : null,
    change: d1 != null ? last - last / (1 + d1 / 100) : null,
    changePct: d1, asOf: Date.parse(`${series.last}T00:00:00Z`), state: 'stored',
    timezone: null, currency: null, origin: 'series-store', storedDay: series.last,
  };
}

export async function readMarkets({ env, fetcher = fetch, now = Date.now() } = {}) {
  const rows = [];
  await pooled(MARKET_ROWS, QUOTE_POOL, async (row) => {
    try {
      const url = `${YAHOO_CHART_BASE}${encodeURIComponent(row.symbol)}?range=5d&interval=1d`;
      const res = await fetcher(url, { headers: { 'user-agent': YAHOO_USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS), redirect: 'manual' });
      if (!res.ok) throw Object.assign(new Error(`Yahoo HTTP ${res.status}`), { reason: res.status === 429 ? 'rate-limited' : 'upstream' });
      rows.push(quoteFromChart(await res.json(), row, now));
    } catch (error) {
      rows.push({ ...row, last: null, prev: null, change: null, changePct: null, asOf: null, state: 'unavailable', origin: null, reason: reasonOf(error) });
    }
  });
  const failed = rows.filter((r) => r.state === 'unavailable');
  let stored = [];
  if (failed.length && env?.ASSETS) {
    const manifest = await readAsset(env, SERIES_INDEX_PATH);
    for (const row of failed) {
      const fallback = row.series ? quoteFromSeries(manifest, row) : null;
      if (fallback) { rows[rows.indexOf(row)] = { ...fallback, reason: row.reason }; stored.push(row.id); }
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    readAt: now,
    rows: MARKET_ROWS.map((r) => byId.get(r.id)),
    failed: rows.filter((r) => r.state === 'unavailable').map((r) => r.id),
    stored,
  };
}


// ---- what goes in, and when ------------------------------------------------------------------------

const upper = (v) => String(v || '').trim().toUpperCase();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** The dashboard's own story rank: a tracked keyword, then a directional mood, then importance. */
export const scoreOf = ({ keywords = [], direction = 'neutral', importance = 'low' } = {}) =>
  (keywords.length ? 2 : 0) + (direction !== 'neutral' ? 1 : 0) + (importance === 'high' ? 1 : 0);

/**
 * Where an item published at `at` belongs in THIS brief: inside the window, or a late arrival from
 * the two windows before it that no brief sent to the desk has carried — or nowhere. Late arrivals
 * are read only against a ledger that holds something: an empty ledger is "unknown", not "nothing
 * was sent", so the first brief after the ledger exists is an ordinary window.
 */
export function placementFor({ window, lateFrom, reported = null }) {
  const lateAllowed = !!reported && !reported.empty;
  return (at, keys) => {
    if (!Number.isFinite(at) || at >= window.to) return null;
    if (at >= window.from) return { late: false };
    if (!lateAllowed || at < lateFrom) return null;
    return keys.some((k) => reported.has(k)) ? null : { late: true };
  };
}

/** Rows grouped per company, strongest company first, capped per company and overall. */
function group(rows, limit) {
  const byTicker = new Map();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, { ticker: row.ticker, company: row.company, items: [], more: 0 });
    byTicker.get(row.ticker).items.push(row);
  }
  // Within a company the cap keeps the material rows, then the newest — a company that filed eight
  // intimations and one order win must not lose the order win to the cap.
  const groups = [...byTicker.values()].sort((a, b) => b.items.length - a.items.length || a.company.localeCompare(b.company));
  let budget = limit;
  for (const g of groups) {
    g.items.sort((a, b) => scoreOf(b) - scoreOf(a) || b.at - a.at);
    const keep = Math.max(0, Math.min(PER_COMPANY_LIMIT, budget));
    g.more = g.items.length - keep;
    g.items = g.items.slice(0, keep);
    budget -= g.items.length;
  }
  return { groups: groups.filter((g) => g.items.length), count: rows.length, more: rows.length - groups.reduce((n, g) => n + g.items.length, 0) };
}

const bookIndex = (holdings) => new Map(holdings.map((h) => [upper(h.ticker), h]));

// ---- 2. announcements on direct holdings ----------------------------------------------------------

const headlineOfNse = (row) => String(row.description || '').split('|SUBJECT:')[0].trim() || row.subject || row.company;
const dedupeKey = (row) => `${row.ticker}|${norm(row.headline).slice(0, 60)}`;
const bseKey = (a) => `bse:${a.newsId || [a.scripCode, a.date, a.time, norm(a.headline || a.title).slice(0, 80)].join('|')}`;
const nseKey = (r) => `nse:${nseFilingKey(r)}`;

export async function readAnnouncements({ env, fetcher = fetch, now = Date.now(), window, lateFrom = window.from, reported = null, holdings }) {
  const byTicker = bookIndex(holdings);
  const place = placementFor({ window, lateFrom, reported });
  const from = Math.min(lateFrom, window.from);
  const inSpan = (at) => Number.isFinite(at) && at >= from && at < window.to;
  const rows = [];

  // NSE's live feed: the last few minutes of the exchange, read now.
  let nse;
  try {
    const res = await fetcher(NSE_FEED_URL, { headers: NSE_HEADERS, signal: AbortSignal.timeout(NSE_TIMEOUT_MS), redirect: 'manual' });
    const xml = await res.text();
    if (!res.ok) throw Object.assign(new Error(`NSE HTTP ${res.status}`), { reason: res.status === 403 || res.status === 430 ? 'blocked' : 'upstream' });
    assertNseShape(xml, { status: res.status });
    const parsed = resolveAll(parseAnnouncements(xml), buildResolver({ book: holdings }));
    nse = { ok: true, readAt: now, count: parsed.length, resolved: parsed.filter((r) => r.ticker).length, matched: 0 };
    for (const r of parsed) {
      const ticker = upper(r.ticker);
      const at = Date.parse(r.publishedAt || '');
      if (!ticker || !byTicker.has(ticker) || !inSpan(at)) continue;
      nse.matched += 1;
      rows.push({ exchange: 'NSE', ticker, company: byTicker.get(ticker).name, subject: r.subject || null, category: null, description: r.description || null, headline: headlineOfNse(r), url: r.url || null, at, key: nseKey(r), dayOnly: false });
    }
  } catch (error) {
    nse = { ok: false, readAt: now, reason: reasonOf(error), count: 0, resolved: 0, matched: 0 };
  }

  // NSE's retained history: one committed file per IST day the hourly capture reached. The index is
  // read first so a day the capture never wrote is never asked for.
  const index = await readAsset(env, NSE_HISTORY_INDEX_PATH);
  const nseHistory = { ok: !!index, capturedAt: index?.capturedAt || null, days: [], matched: 0 };
  if (index) {
    const held = new Set((index.days || []).map((d) => d?.day).filter(Boolean));
    const resolver = buildResolver({ book: holdings });
    for (let day = istDay(from); day <= istDay(window.to - 1); day = istDay(istInstant(day) + 86400000)) {
      if (!held.has(day)) continue;
      const file = await readAsset(env, nseHistoryDayPath(day));
      if (!Array.isArray(file?.rows)) continue;
      nseHistory.days.push(day);
      for (const raw of file.rows) {
        const r = raw?.ticker ? raw : resolveRow(raw || {}, resolver);
        const ticker = upper(r.ticker);
        const at = Date.parse(r.publishedAt || '');
        if (!ticker || !byTicker.has(ticker) || !inSpan(at)) continue;
        nseHistory.matched += 1;
        rows.push({ exchange: 'NSE', ticker, company: byTicker.get(ticker).name, subject: r.subject || null, category: null, description: r.description || null, headline: headlineOfNse(r), url: r.url || null, at, key: nseKey(r), dayOnly: false });
      }
    }
  }

  // BSE's date-indexed capture.
  const capture = await readAsset(env, BSE_PATH);
  let bse;
  if (capture?.byTicker && typeof capture.byTicker === 'object') {
    bse = { ok: true, capturedAt: capture.capturedAt || null, from: capture.from || null, to: capture.to || null, matched: 0 };
    for (const [ticker, list] of Object.entries(capture.byTicker)) {
      const key = upper(ticker);
      if (!byTicker.has(key) || !Array.isArray(list)) continue;
      for (const a of list) {
        if (!a?.date) continue;
        // BSE prints the filing's own exchange time, which is Indian time. A row with no clock is
        // filed at its day's close and says "day only" on the page.
        const dayOnly = !a.time;
        const at = dayOnly ? dayOnlyInstant(a.date) : istInstant(a.date, String(a.time).slice(0, 5));
        if (!inSpan(at)) continue;
        bse.matched += 1;
        rows.push({
          exchange: 'BSE', ticker: key, company: byTicker.get(key).name,
          subject: a.subCategory || a.category || null, category: a.category || null, description: null,
          headline: a.headline || a.title || a.subCategory || a.category || key, url: a.url || null, at, key: bseKey(a), dayOnly, critical: a.critical === true,
        });
      }
    }
  } else {
    bse = { ok: false, reason: 'capture-unavailable', capturedAt: null, from: null, to: null, matched: 0 };
  }

  // One filing lodged with both exchanges is one filing: fold the copies, name both venues, and keep
  // every copy's identity so the ledger recognises the filing under whichever copy it saw first.
  const folded = new Map();
  for (const row of rows.sort((a, b) => b.at - a.at)) {
    const key = dedupeKey(row);
    const held = folded.get(key);
    if (held) {
      if (!held.exchanges.includes(row.exchange)) held.exchanges.push(row.exchange);
      if (!held.keys.includes(row.key)) held.keys.push(row.key);
      held.copies.push(row);
      held.firstAt = Math.min(held.firstAt, row.at);
      continue;
    }
    folded.set(key, { ...row, exchanges: [row.exchange], keys: [row.key], copies: [row], firstAt: row.at });
  }

  const admitted = [];
  let routineHidden = 0;
  let outside = 0;
  for (const f of folded.values()) {
    // Classify on the copy with the richer taxonomy: BSE's sub-category names the filing type.
    const typed = f.copies.find((c) => c.exchange === 'BSE') || f;
    const type = announcementTypeOf(typed.exchange === 'BSE'
      ? { category: typed.category, subCategory: typed.subject, title: typed.headline }
      : { title: typed.subject, description: typed.description });
    if (type.id === 'routine') { routineHidden += 1; continue; }
    const where = place(f.firstAt, f.keys);
    if (!where) { outside += 1; continue; }
    const reading = matchKeywords(f.headline);
    const signal = announcementSignal({ category: typed.category, subCategory: typed.subject, headline: f.headline, description: typed.description, critical: f.critical });
    const { copies, firstAt, ...rest } = f;
    admitted.push({
      ...rest, at: firstAt, late: where.late, type: type.id,
      keywords: reading.map((k) => k.label), keywordIds: reading.map((k) => k.id), keywordGroups: [...new Set(reading.map((k) => k.group))],
      direction: signal.direction, importance: signal.importance, filingRule: signal.filingRule,
    });
  }
  return { nse, nseHistory, bse, routineHidden, outside, ...group(admitted, ANNOUNCEMENT_LIMIT) };
}

// ---- 3. news on direct holdings ---------------------------------------------------------------------

export async function readNews({ env, window, lateFrom = window.from, reported = null, holdings }) {
  const byTicker = bookIndex(holdings);
  const place = placementFor({ window, lateFrom, reported });
  const seen = new Set();
  const titles = new Set();
  const rows = [];
  const story = (ticker, company, article, { publisher, url, keys, via = null, late }) => {
    const reading = matchKeywords(article.title);
    return {
      ticker, company, headline: String(article.title || ''), summary: typeof article.summary === 'string' ? article.summary : '',
      url: typeof url === 'string' && /^https?:\/\//.test(url) ? url : null,
      publisher, via, at: Date.parse(article.publishedAt), late, keys, dayOnly: false,
      keywords: reading.map((k) => k.label), keywordIds: reading.map((k) => k.id), keywordGroups: [...new Set(reading.map((k) => k.group))],
    };
  };

  // The four publishers' feeds, joined to the book by name.
  const feed = await readAsset(env, PUBLISHERS_PATH);
  let source;
  if (Array.isArray(feed?.articles)) {
    const entities = portfolioNewsEntities(holdings);
    let inWindow = 0;
    let oldest = null;
    for (const article of feed.articles) {
      const at = Date.parse(article?.publishedAt || '');
      if (!Number.isFinite(at)) continue;
      oldest = oldest == null ? at : Math.min(oldest, at);
      if (at < window.from || at >= window.to) { if (at < Math.min(lateFrom, window.from) || at >= window.to) continue; } else inWindow += 1;
      for (const match of matchPortfolioNews(article, entities)) {
        const ticker = upper(match.ticker || match.entityId);
        const key = `news:${ticker}|${article.url || article.id}`;
        if (!ticker || seen.has(key)) continue;
        const where = place(at, [key]);
        if (!where) continue;
        seen.add(key);
        titles.add(`${ticker}|${norm(article.title)}`);
        rows.push({ ...story(ticker, match.company || match.attribution?.companyName || ticker, article, { publisher: article.publisher || article.source || null, url: article.url, keys: [key], late: where.late }), attribution: match.attribution?.status || null });
      }
    }
    const publishers = (feed.sources || []).map((s) => (typeof s === 'string' ? s : s?.name || s?.label || s?.publisher || s?.id)).filter(Boolean);
    source = { ok: true, capturedAt: feed.capturedAt || null, publishers, articles: feed.articles.length, inWindow, oldest };
  } else {
    source = { ok: false, reason: 'capture-unavailable' };
  }

  // TradingView's symbol-tagged headlines per holding. A tag is TradingView's, not the publisher's,
  // and a sector story is tagged with every bank in it — measured, eight of one day's stories under
  // State Bank of India were about the NSE IPO and bond yields — so a headline joins only under the
  // dashboard's own name match (`matchPortfolioNews`, the rule the News tab and the publisher rows
  // above use), or when the story is tagged with at most two symbols and this holding is one of
  // them, which is a story about the company by the tag's own say-so. A headline the publishers
  // already carried is one story.
  const latest = await readAsset(env, TRADINGVIEW_PATH);
  let tradingview;
  if (latest?.byTicker && typeof latest.byTicker === 'object') {
    tradingview = { ok: true, capturedAt: latest.newsUpdatedAt || latest.capturedAt || null, matched: 0, tagged: 0 };
    const entities = portfolioNewsEntities(holdings);
    const ownSymbol = (ticker, symbol) => /^(?:NSE|BSE):/.test(String(symbol || '')) && upper(String(symbol).slice(4)) === ticker;
    for (const [t, list] of Object.entries(latest.byTicker)) {
      const ticker = upper(t);
      if (!byTicker.has(ticker) || !Array.isArray(list)) continue;
      for (const a of list) {
        const at = Date.parse(a?.publishedAt || '');
        const key = `tv:${ticker}|${a?.tradingViewId || a?.url}`;
        if (!a?.title || seen.has(key) || titles.has(`${ticker}|${norm(a.title)}`)) continue;
        const where = place(at, [key]);
        if (!where) continue;
        tradingview.tagged += 1;
        const named = matchPortfolioNews(a, entities).some((m) => upper(m.ticker || m.entityId) === ticker);
        const tags = Array.isArray(a.relatedSymbols) ? a.relatedSymbols : [];
        const soleSubject = tags.length > 0 && tags.length <= 2 && tags.some((symbol) => ownSymbol(ticker, symbol));
        if (!named && !soleSubject) continue;
        seen.add(key);
        titles.add(`${ticker}|${norm(a.title)}`);
        tradingview.matched += 1;
        rows.push({ ...story(ticker, byTicker.get(ticker).name, a, { publisher: a.source || null, url: a.url || a.tradingViewUrl, keys: [key], via: 'TradingView', late: where.late }), attribution: named ? 'confirmed' : 'symbol' });
      }
    }
  } else {
    tradingview = { ok: false, reason: 'capture-unavailable', matched: 0, tagged: 0 };
  }
  return { source, tradingview, ...group(rows.sort((a, b) => b.at - a.at), NEWS_LIMIT) };
}

// ---- 4. trades on direct holdings ------------------------------------------------------------------

const monthOf = (day) => String(day).slice(0, 7);
const cell = (cells, ...names) => names.map((n) => cells?.[n]).find((v) => v != null && v !== '') ?? null;

export async function readTrades({ env, window, lateFrom = window.from, reported = null, holdings }) {
  const byTicker = bookIndex(holdings);
  const byIsin = new Map(holdings.map((h) => [upper(h.isin), h]).filter(([k]) => k));
  const place = placementFor({ window, lateFrom, reported });
  const index = await readAsset(env, INSIDER_ARCHIVE_INDEX_PATH);
  if (!index?.months || typeof index.months !== 'object') return { source: { ok: false, reason: 'capture-unavailable' }, groups: [], count: 0, more: 0 };

  // The capture files a company under its NSE symbol where it has one and under its BSE scrip code
  // otherwise; the exchange identity file turns a code into the book line it belongs to.
  const identities = await readAsset(env, IDENTITIES_PATH);
  const codeToTicker = new Map();
  for (const e of identities?.entries || []) {
    const line = byIsin.get(upper(e?.isin));
    if (!line?.ticker) continue;
    for (const code of [e.bseCode, ...(e.bseCodes || [])]) if (code) codeToTicker.set(String(code), upper(line.ticker));
  }
  const tickerOf = (row) => {
    const t = upper(row?.ticker);
    if (byTicker.has(t)) return t;
    return /^\d+$/.test(t) ? codeToTicker.get(t) || null : null;
  };

  const from = Math.min(lateFrom, window.from);
  const months = [];
  for (let day = istDay(from); day <= istDay(window.to - 1); day = istDay(istInstant(day) + 86400000)) {
    const m = monthOf(day);
    if (!months.includes(m) && index.months[m] != null) months.push(m);
  }
  const seen = new Set();
  const rows = [];
  for (const month of months) {
    const file = await readAsset(env, insiderArchiveMonthPath(month));
    for (const row of Array.isArray(file?.rows) ? file.rows : []) {
      const ticker = tickerOf(row);
      if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || ''))) continue;
      const at = dayOnlyInstant(row.date);
      const key = `trade:${insiderTradeIdentity(row)}`;
      if (seen.has(key)) continue;
      const where = place(at, [key]);
      if (!where) continue;
      seen.add(key);
      const cells = row.cells || {};
      const signal = insiderSignal(cells);
      const category = cell(cells, 'Trade Category', 'Disclosure Type') || 'Insider trade';
      const who = cell(cells, 'Insider', 'Person', 'Person Name', 'Name of Insider', 'Acquirer', 'Holder');
      const action = cell(cells, 'Transaction', 'Transaction Type', 'Acq/Disp', 'Mode');
      rows.push({
        ticker, company: byTicker.get(ticker).name, at, dayOnly: true, late: where.late, keys: [key],
        category, headline: `${category}: ${[who, action].filter(Boolean).join(' — ') || 'details not carried'}`,
        detail: [
          category, cell(cells, 'Category'), cell(cells, 'Security Type'),
          cell(cells, 'Trade Shares') ? `${cell(cells, 'Trade Shares')} shares` : null,
          cell(cells, 'Trade %') ? `${cell(cells, 'Trade %')}% of the company` : null,
          cell(cells, 'Trade Value') ? `value ${cell(cells, 'Trade Value')}` : null,
          cell(cells, 'Price') ? `at ${cell(cells, 'Price')}` : null,
          cell(cells, 'Mode') && action !== cell(cells, 'Mode') ? cell(cells, 'Mode') : null,
        ].filter(Boolean).join(' · '),
        source: cell(cells, 'Source') || cell(cells, 'Exchange') || 'Screener.in',
        url: insiderTradeSourceUrl(row),
        keywords: [], keywordIds: [], keywordGroups: [],
        direction: signal.direction, importance: signal.importance, signalReason: signal.signalReason,
      });
    }
  }
  return { source: { ok: true, capturedAt: index.updatedAt || null, months, identities: !!identities }, ...group(rows.sort((a, b) => b.at - a.at), TRADE_LIMIT) };
}

// ---- 5. price moves on direct holdings --------------------------------------------------------------

const pctOf = (last, prev) => (Number.isFinite(last) && Number.isFinite(prev) && prev > 0 ? ((last - prev) / prev) * 100 : null);

/**
 * The holdings that moved at least MOVE_PCT on the session this brief speaks about. The evening
 * brief reads the breakout capture's closing quotes (Yahoo, every 15 minutes, the last of them after
 * the close); the morning brief reads the completed daily bars the technicals scrape wrote — and
 * where the scrape has not yet caught up, the capture's closing quote stands in and says so. Either
 * way the row prints the session it measures and the time of the print.
 */
export async function readMoves({ env, now = Date.now(), edition, window, lateFrom = window.from, reported = null, holdings }) {
  const byTicker = bookIndex(holdings);
  const place = placementFor({ window, lateFrom, reported });
  const session = expectedSession(now);
  const out = { state: 'unavailable', session, asOf: null, reason: null, groups: [], count: 0, more: 0 };
  if (!session) return { ...out, reason: 'no-session' };

  const fromCapture = async () => {
    const object = env?.CAPTURE_REGISTRY?.getByName?.(BREAKOUT_OBJECT);
    if (!object?.breakoutRead) return { reason: 'capture-unavailable', rows: [] };
    let capture;
    try { capture = await object.breakoutRead(); } catch { return { reason: 'capture-unavailable', rows: [] }; }
    const rows = [];
    for (const row of Array.isArray(capture?.rows) ? capture.rows : []) {
      const ticker = upper(row?.ticker);
      if (!byTicker.has(ticker) || row.sessionDate !== session || !quoteFresh(row, now)) continue;
      const pct = pctOf(row.price, row.prevClose);
      if (pct == null) continue;
      rows.push({ ticker, pct, last: row.price, prev: row.prevClose, at: Date.parse(row.quoteAt), provider: row.provider || 'Yahoo Finance', basis: 'capture' });
    }
    return { reason: rows.length ? null : 'no-session-quotes', rows, asOf: rows.reduce((m, r) => Math.max(m, r.at), 0) || null };
  };
  const fromDaily = async () => {
    const daily = await readAsset(env, TECHNICALS_PATH);
    if (!daily) return { reason: 'daily-unavailable', rows: [] };
    if (daily.price_date !== session) return { reason: 'daily-behind', priceDate: daily.price_date || null, rows: [] };
    const rows = [];
    for (const row of daily.rows || daily.companies || []) {
      const ticker = upper(row?.ticker);
      const pct = Number(row?.pct_change_today);
      if (!byTicker.has(ticker) || (row.bar_date || session) !== session || !Number.isFinite(pct)) continue;
      rows.push({ ticker, pct, last: Number.isFinite(row.cmp) ? row.cmp : null, prev: null, at: istInstant(session, '15:30'), provider: daily.source || 'Yahoo Finance', basis: 'daily', verified: row.move_check || null });
    }
    return { reason: null, rows, asOf: Date.parse(daily.generated_at || '') || null, priceDate: daily.price_date };
  };

  const order = edition === 'morning' ? [fromDaily, fromCapture] : [fromCapture, fromDaily];
  let read = null;
  const reasons = [];
  for (const attempt of order) {
    const result = await attempt();
    if (result.rows.length) { read = result; break; }
    reasons.push(result.reason);
    if (result.priceDate) out.priceDate = result.priceDate;
  }
  if (!read) return { ...out, reason: reasons.join('; ') || 'unavailable' };

  const rows = [];
  for (const r of read.rows) {
    if (Math.abs(r.pct) < MOVE_PCT) continue;
    const key = `move:${r.ticker}|${session}`;
    const where = place(r.at, [key]);
    if (!where) continue;
    rows.push({
      ...r, company: byTicker.get(r.ticker).name, late: where.late, keys: [key], dayOnly: false,
      keywords: [], keywordIds: [], keywordGroups: [], direction: r.pct < 0 ? 'negative' : 'positive', importance: 'high',
    });
  }
  rows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
  return { ...out, state: read.rows[0].basis, asOf: read.asOf || null, ...group(rows, MOVE_LIMIT) };
}

// ---- the brief -----------------------------------------------------------------------------------

/**
 * Build one edition. Throws only when the BOOK cannot be read — an email about "direct holdings"
 * with no book behind it would be about nothing. Every other source reports its own failure on
 * the page instead. `reported` is the ledger of items a brief sent to the desk has carried; without
 * one, or with an empty one, no late arrivals are read.
 */
export async function buildBrief({ edition, day, settings, env, fetcher = fetch, now = Date.now(), to = null, reported = null }) {
  if (!EDITIONS[edition]) throw Object.assign(new Error('Unknown edition'), { code: 'invalid-edition' });
  const book = await readAsset(env, BOOK_PATH);
  if (!Array.isArray(book?.holdings)) throw Object.assign(new Error('The portfolio book could not be read'), { code: 'book-unavailable' });
  const holdings = book.holdings.filter((h) => h?.ticker && h?.name);
  const window = editionWindow(edition, day, settings, { to });
  // Late arrivals are read back to two windows before this one, but never to before the ledger
  // began: an earlier brief carried those and the ledger cannot vouch either way.
  const lateFrom = reported && !reported.empty
    ? Math.min(window.from, Math.max(lateArrivalsFrom(edition, day, settings), Number.isFinite(reported.since) ? reported.since : -Infinity))
    : window.from;
  const common = { env, window, lateFrom, reported, holdings };
  // The quotes are network-bound and run alongside; the committed files are read one after another
  // so the object never holds more than one large capture in memory at a time.
  const markets = readMarkets({ env, fetcher, now });
  const announcements = await readAnnouncements({ ...common, fetcher, now });
  const news = await readNews(common);
  const trades = await readTrades(common);
  const moves = await readMoves({ ...common, now, edition });
  const brief = {
    version: 2, edition, day, at: window.at, builtAt: now,
    onDemand: to != null,
    window: { from: window.from, to: window.to },
    lateFrom: lateFrom < window.from ? lateFrom : null,
    book: { asOf: book.asOf || null, lines: book.count ?? book.holdings.length, listed: holdings.length },
    markets: await markets, announcements, news, trades, moves,
  };
  // What a send of this brief would put in the ledger: every item it carries, by every identity it
  // was seen under.
  brief.reported = briefStories(brief).flatMap((s) => (s.keys || []).map((key) => ({ key, publishedAt: s.at })));
  return brief;
}


// ---- stories -------------------------------------------------------------------------------------
//
// THE EMAIL IS A GLOW VENTURES BROADSHEET, AND IT LEADS WITH THE PORTFOLIO COMPANIES. The desk
// reads it for what happened to the companies they own, so every filing, story, trade and move is
// filed under its COMPANY, companies with a tracked or directional item first, and the global market
// scan follows them. Two readings travel on each — both of them readings this dashboard already makes:
//
//   TOPIC  what the story is ABOUT, from the desk's thirty tracked keywords (data/news-keywords.js).
//          The seven topics fold those keyword families: Orders is the three order keywords,
//          Growth the rest of that family, Money is capital raising and results, Approvals & IP is
//          regulatory, Trouble is risk and governance, and a story matching nothing is Other. A
//          trade is filed under Trades and a price move under Price, because neither is a headline.
//   MOOD   a direction, and only where a stated rule gives one: `announcementSignal()` over a
//          filing's own subject and category (dividend, order award, downgrade, default…), the
//          transaction word on a trade (`insiderSignal`), the sign of a price move. A published
//          headline carries NO sentiment reading anywhere on this dashboard, so a news story's dot
//          is Neutral — never a guess dressed as a judgement.

// The masthead is the family office's own name: this is Glow Ventures' dashboard, not a platform
// newsletter. Munshot stays only as the small platform credit in the footer.
export const BRAND = 'Glow Ventures';
export const PRODUCT_NAME = 'Research Central';
export const EDITION_NAME = 'Portfolio companies';
export const TAGLINES = { morning: 'Morning Portfolio Brief', evening: 'Evening Portfolio Brief' };

export const TOPICS = [
  { id: 'growth', label: 'Growth', color: '#10b981' },
  { id: 'orders', label: 'Orders', color: '#3b82f6' },
  { id: 'deals', label: 'Deals', color: '#8b5cf6' },
  { id: 'money', label: 'Money', color: '#f59e0b' },
  { id: 'approvals', label: 'Approvals & IP', color: '#14b8a6' },
  { id: 'trouble', label: 'Trouble', color: '#f43f5e' },
  { id: 'trades', label: 'Trades', color: '#0ea5e9' },
  { id: 'price', label: 'Price', color: '#6366f1' },
  { id: 'other', label: 'Other', color: '#64748b' },
];
const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));
const ORDER_KEYWORDS = new Set(['order', 'orderbook', 'receipt-of-order']);
const TOPIC_BY_GROUP = { growth: 'growth', deals: 'deals', capital: 'money', results: 'money', regulatory: 'approvals', risk: 'trouble', research: 'other' };
export const MOODS = {
  good: { id: 'good', label: 'Good', color: '#10b981' },
  watch: { id: 'watch', label: 'Watch-out', color: '#f43f5e' },
  neutral: { id: 'neutral', label: 'Neutral', color: '#94a3b8' },
};

export function topicOf({ kind = null, keywordIds = [], keywordGroups = [] } = {}) {
  if (kind === 'trade') return TOPIC_BY_ID.get('trades');
  if (kind === 'move') return TOPIC_BY_ID.get('price');
  if (keywordIds.some((id) => ORDER_KEYWORDS.has(id))) return TOPIC_BY_ID.get('orders');
  for (const group of keywordGroups) {
    const topic = TOPIC_BY_GROUP[group];
    if (topic && topic !== 'other') return TOPIC_BY_ID.get(topic);
  }
  return TOPIC_BY_ID.get('other');
}

// A mood needs a stated rule behind it: a filing rule, a trade's transaction word, a move's sign.
// A published headline has none and stays neutral whatever it says.
export const moodOf = (item) => (item.kind === 'news' || item.direction === 'neutral' ? MOODS.neutral
  : item.direction === 'positive' ? MOODS.good : item.direction === 'negative' ? MOODS.watch : MOODS.neutral);

const fmtInr = (v) => (Number.isFinite(v) ? `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null);
const fmtPct1 = (v) => `${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

/** "Up 6.2% on the day at ₹412.30" — a measurement in the sign's own words, no judgement added. */
export function moveHeadline(m) {
  const last = fmtInr(m.last);
  return `${m.pct < 0 ? 'Down' : 'Up'} ${fmtPct1(m.pct)} on the day${last ? ` at ${last}` : ''}`;
}

/** Every filing, story, trade and move in the brief as one list, strongest first. */
export function briefStories(brief) {
  const rows = [];
  const base = (kind, g, item) => ({
    kind, ticker: g.ticker, company: g.company, at: item.at, late: !!item.late, dayOnly: !!item.dayOnly, keys: item.keys || [],
    keywords: item.keywords || [], keywordIds: item.keywordIds || [], keywordGroups: item.keywordGroups || [],
  });
  for (const g of brief.announcements.groups) {
    for (const item of g.items) rows.push({
      ...base('filing', g, item), headline: item.headline,
      dek: [item.exchanges.join(' and '), item.subject].filter(Boolean).join(' filing · ') || null,
      url: item.url, source: item.exchanges.join(' · '),
      direction: item.direction || 'neutral', importance: item.importance || 'low',
    });
  }
  for (const g of brief.news.groups) {
    for (const item of g.items) rows.push({
      ...base('news', g, item), headline: item.headline,
      dek: item.summary || null, url: item.url,
      source: [item.publisher || 'Publisher not recorded', item.via ? `via ${item.via}` : null].filter(Boolean).join(' · '),
      direction: 'neutral', importance: item.keywords.length ? 'high' : 'low', related: item.attribution === 'related',
    });
  }
  for (const g of brief.trades?.groups || []) {
    for (const item of g.items) rows.push({
      ...base('trade', g, item), headline: item.headline, dek: item.detail || null, url: item.url, source: item.source,
      direction: item.direction || 'neutral', importance: item.importance || 'low',
    });
  }
  for (const g of brief.moves?.groups || []) {
    for (const item of g.items) rows.push({
      ...base('move', g, item), headline: moveHeadline(item),
      dek: [
        item.prev != null ? `Previous close ${fmtInr(item.prev)}` : null,
        item.basis === 'capture' ? `last print ${istTime(item.at)} IST` : `${brief.moves.session} close, completed daily bar`,
        item.verified === 'confirmed' ? 'move confirmed against the exchange close' : null,
      ].filter(Boolean).join(' · '),
      url: null, source: item.provider || 'Yahoo Finance',
      direction: item.direction, importance: 'high', pct: item.pct,
    });
  }
  const stories = rows.map((row) => {
    const topic = topicOf(row);
    const mood = moodOf(row);
    return { ...row, topic, mood, score: scoreOf({ keywords: row.keywords, direction: mood.id === 'neutral' ? 'neutral' : row.direction, importance: row.importance }) };
  });
  return stories.sort((a, b) => b.score - a.score || b.at - a.at);
}

/**
 * The stories filed under their companies. A company's rank is its strongest story (tracked
 * keyword, then a directional mood, then importance), then how much it had, then how recently —
 * so a downgrade or an order win leads the sheet, and a day of routine intimations reads newest
 * first. Within a company the same order holds. Nothing new is read: the score is `briefStories`'.
 */
export function briefCompanies(stories) {
  const byTicker = new Map();
  for (const s of stories) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, { ticker: s.ticker, company: s.company, stories: [] });
    const entry = byTicker.get(s.ticker);
    // The book's own name wins over a publisher match's spelling of it.
    if (s.kind !== 'news') entry.company = s.company;
    entry.stories.push(s);
  }
  const companies = [...byTicker.values()].map((c) => {
    c.stories.sort((a, b) => b.score - a.score || b.at - a.at);
    return {
      ...c,
      score: c.stories[0].score,
      latest: Math.max(...c.stories.map((s) => s.at)),
      good: c.stories.filter((s) => s.mood.id === 'good').length,
      watch: c.stories.filter((s) => s.mood.id === 'watch').length,
    };
  });
  return companies.sort((a, b) => b.score - a.score || b.stories.length - a.stories.length || b.latest - a.latest || a.company.localeCompare(b.company));
}

export function briefStats(brief) {
  const stories = briefStories(brief);
  return {
    stories: stories.length,
    good: stories.filter((s) => s.mood.id === 'good').length,
    watch: stories.filter((s) => s.mood.id === 'watch').length,
    late: stories.filter((s) => s.late).length,
    companies: briefCompanies(stories),
  };
}

/** The figures the panel keeps for a delivery — counts, never rows. */
export function briefSummary(brief) {
  const stats = briefStats(brief);
  return {
    quotes: brief.markets.rows.filter((r) => r.last != null).length,
    quotesFailed: brief.markets.failed,
    quotesStored: brief.markets.stored,
    announcements: brief.announcements.count,
    news: brief.news.count,
    trades: brief.trades?.count ?? 0,
    moves: brief.moves?.count ?? 0,
    routineHidden: brief.announcements.routineHidden || 0,
    stories: stats.stories, companies: stats.companies.length, good: stats.good, watch: stats.watch, late: stats.late,
    nse: brief.announcements.nse.ok, nseHistory: brief.announcements.nseHistory?.ok ?? false, bse: brief.announcements.bse.ok,
    publishers: brief.news.source.ok, tradingview: brief.news.tradingview?.ok ?? false,
    tradesSource: brief.trades?.source?.ok ?? false, prices: brief.moves?.state || 'unavailable',
  };
}

// ---- formatting ----------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNumber = (v, decimals) => v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const signed = (v, decimals, suffix = '') => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNumber(Math.abs(v), decimals) + suffix;
const INK = '#1a1712', PAPER = '#fbf9f3', CREAM = '#f2eee3', RULE = '#d9d2c2', META = '#8a8272', BODY = '#4a4438', BODY2 = '#5c5445';
// Glow Ventures' gold, from public/css/glow.css (--brand-600 on the page, --brand-mid on the mark).
const GOLD = '#8a6a1c', GOLD_LIGHT = '#d9c48f';
const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = 'Arial,Helvetica,sans-serif';
const NUM = 'font-variant-numeric:tabular-nums;white-space:nowrap;';
const toneOf = (v) => (v > 0 ? MOODS.good.color : v < 0 ? MOODS.watch.color : MOODS.neutral.color);

export function formatLast(row) {
  if (row.last == null) return null;
  if (row.kind === 'yield') return `${fmtNumber(row.last, 2)}%`;
  if (row.kind === 'fx') return fmtNumber(row.last, row.last < 10 ? 4 : 2);
  return fmtNumber(row.last, 2);
}

export function formatChange(row) {
  if (row.change == null) return null;
  if (row.kind === 'yield') return signed(row.change * 100, 1, ' bp');
  return signed(row.change, row.kind === 'fx' && row.last < 10 ? 4 : 2);
}

export const formatPct = (row) => (row.changePct == null ? null : signed(row.changePct, 2, '%'));

const zoneShort = (ms, timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', hour12: false }).formatToParts(ms);
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
  } catch {
    return istLabel(ms);
  }
};

/** "Close · Wed 16:00 EDT", "Live · Thu 07:58 JST", "Series store · 2026-09-08" or "unavailable". */
export function asOfLabel(row) {
  if (row.state === 'unavailable') return 'unavailable';
  if (row.state === 'stored') return `Series store · ${row.storedDay}`;
  const when = row.timezone ? zoneShort(row.asOf, row.timezone) : istLabel(row.asOf);
  return `${row.state === 'live' ? 'Live' : 'Close'} · ${when}`;
}

export function glanceLine(brief) {
  const byId = new Map(brief.markets.rows.map((r) => [r.id, r]));
  const parts = [];
  for (const id of GLANCE[brief.edition] || []) {
    const row = byId.get(id);
    if (!row || row.last == null) continue;
    const pct = formatPct(row);
    if (row.kind === 'price') parts.push(`${row.label} $${formatLast(row)}`);
    else if (row.kind === 'fx') parts.push(`${row.label} ${formatLast(row)}`);
    else if (pct) parts.push(`${row.label} ${pct}`);
  }
  return parts.join(' · ');
}

const shortDate = (ms) => istLabel(ms, { time: false }).replace(/^\w{3} /, '');
const STORY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
/** "16 Sept" — the story date as the broadsheet prints it; the window strip carries the times. */
export const storyDate = (ms) => { const d = new Date(ms + 5.5 * 3600 * 1000); return `${d.getUTCDate()} ${STORY_MONTHS[d.getUTCMonth()]}`; };
/** "8:00 AM IST" from "08:00". */
const clockLabel = (time) => { const [h, m] = String(time).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} IST`; };

/** "Glow Ventures · 12 updates on your portfolio companies — 17 Sep" */
export function briefSubject(brief, { brand = BRAND } = {}) {
  const n = briefStats(brief).stories;
  return `${brand} · ${n} update${n === 1 ? '' : 's'} on your ${EDITION_NAME.toLowerCase()} — ${shortDate(brief.at)}`;
}

const windowLine = (brief) => `${istLabel(brief.window.from)} → ${istLabel(brief.window.to)}`;
const groupNote = (brief, groupId) => {
  if (groupId === 'us') return brief.edition === 'morning' ? 'previous session' : 'last close';
  if (groupId === 'asia') return brief.edition === 'morning' ? 'this morning' : 'today';
  if (groupId === 'india') return brief.edition === 'morning' ? 'previous close' : "today's close";
  return null;
};

// ---- the email -----------------------------------------------------------------------------------
//
// Email-safe only: tables, every style inline, web-safe fonts, a 640px sheet, light mode declared.
// No stylesheet, no script, no web font, no gradient — what Gmail, Outlook and Apple Mail render.

const dot = (color, size = 8, square = false) => `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:${square ? 1 : size}px;background:${color};vertical-align:middle;"></span>`;
const caps = (text, extra = '') => `<span style="font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;${extra}">${text}</span>`;
// Every link opens in a new tab — in the preview page and in a web mail client alike — so reading a
// filing never takes the reader away from the brief they were working down.
const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';
const link = (url, inner, style) => (url ? `<a href="${esc(url)}" ${NEW_TAB} style="${style}text-decoration:none;">${inner}</a>` : inner);
/** The dashboard's All Alerts view, narrowed to one company — the same route the host ticker chip opens. */
const companyUrl = (dashboardUrl, ticker) => (/^[A-Z0-9&_.-]{1,20}$/.test(ticker || '')
  ? `${dashboardUrl}/#/research/daily-alerts?scope=portfolio&company=${encodeURIComponent(ticker)}` : null);

function marketSection(brief) {
  const m = brief.markets;
  const note = [
    `quotes ${esc(istTime(m.readAt))} IST`,
    m.stored.length ? `${m.stored.length} from the series store` : null,
    m.failed.length ? `${m.failed.length} unavailable` : null,
  ].filter(Boolean).join(' · ');
  const glance = glanceLine(brief);
  const rows = [];
  for (const g of MARKET_GROUPS) {
    const members = m.rows.filter((r) => r.group === g.id);
    if (!members.length) continue;
    const gnote = groupNote(brief, g.id);
    rows.push(`<tr><td colspan="5" style="padding:10px 0 3px;font-family:${SANS};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${META};">${esc(g.label)}${gnote ? ` <span style="letter-spacing:0;text-transform:none;">· ${esc(gnote)}</span>` : ''}</td></tr>`);
    for (const r of members) {
      const last = formatLast(r);
      const pct = formatPct(r);
      const tone = r.changePct == null ? META : toneOf(r.changePct);
      rows.push(`<tr>
        <td style="padding:5px 6px 5px 0;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:12px;color:${INK};">${esc(r.label)}${r.unit ? ` <span style="color:${META};font-size:10px;">${esc(r.unit)}</span>` : ''}</td>
        <td align="right" style="padding:5px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:12px;color:${INK};${NUM}">${last == null ? `<span style="color:${META};">—</span>` : esc(last)}</td>
        <td align="right" style="padding:5px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;color:${META};${NUM}">${r.change == null ? '' : esc(formatChange(r))}</td>
        <td align="right" style="padding:5px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:12px;font-weight:bold;color:${tone};${NUM}">${pct == null ? `<span style="color:${META};font-weight:normal;">—</span>` : esc(pct)}</td>
        <td align="right" style="padding:5px 0 5px 6px;border-bottom:1px solid ${RULE};font-family:${SANS};font-size:10px;color:${META};white-space:nowrap;">${esc(asOfLabel(r))}</td>
      </tr>`);
    }
  }
  return `<tr><td style="padding:30px 34px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      <td style="padding:0 0 4px;border-bottom:1px solid ${INK};">${caps('Global market scan', `color:${INK};font-weight:bold;letter-spacing:3px;`)}</td>
      <td align="right" style="padding:0 0 4px;border-bottom:1px solid ${INK};">${caps(esc(note), `color:${META};letter-spacing:1px;`)}</td>
    </tr></table>
    ${glance ? `<div style="padding:8px 0 2px;font-family:${SANS};font-size:12px;line-height:1.6;color:${BODY};">${esc(glance)}</div>` : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.join('')}</table>
  </td></tr>`;
}


const topicTag = (topic) => caps(esc(topic.label), `color:${topic.color};font-weight:bold;letter-spacing:1px;`);
/** "17 Sept, 19:09 IST", or "17 Sept, day only" for a disclosure that carries a broadcast day and no clock. */
const storyWhen = (s) => `${storyDate(s.at)}, ${s.dayOnly ? 'day only' : `${istTime(s.at)} IST`}`;

/** One story under its company: the exchange's or publisher's own headline, then where and when. */
const companyStory = (s, isFirst) => `<tr><td style="padding:${isFirst ? '10px' : '12px'} 0 11px;${isFirst ? '' : `border-top:1px solid ${RULE};`}">
  <div style="font-family:${SERIF};font-size:15px;line-height:1.4;font-weight:bold;color:${INK};">${link(s.url, esc(s.headline), `color:${INK};`)}</div>
  ${s.dek ? `<div style="margin-top:4px;font-family:${SANS};font-size:12px;line-height:1.55;color:${BODY2};">${esc(s.dek)}</div>` : ''}
  <div style="margin-top:6px;font-family:${SANS};font-size:11px;line-height:1.6;color:${META};">${topicTag(s.topic)} &nbsp;·&nbsp; ${dot(s.mood.color)} ${esc(s.mood.label)} · ${esc(s.source)} · ${esc(storyWhen(s))}${s.late ? ` · <span style="color:${GOLD};font-weight:bold;">not in the previous brief</span>` : ''}${s.related ? ' · related entity' : ''}${s.url ? ` · <a href="${esc(s.url)}" ${NEW_TAB} style="color:${GOLD};font-weight:bold;text-decoration:none;">Read →</a>` : ''}</div>
</td></tr>`;

/** A portfolio company and everything filed, published, traded or moved about it in the window. */
function companyBlock(c, dashboardUrl) {
  const n = c.stories.length;
  const counts = [
    `${n} update${n === 1 ? '' : 's'}`,
    c.good ? `<span style="color:${MOODS.good.color};">${c.good} good</span>` : null,
    c.watch ? `<span style="color:${MOODS.watch.color};">${c.watch} watch-out${c.watch === 1 ? '' : 's'}</span>` : null,
  ].filter(Boolean).join(' · ');
  const href = companyUrl(dashboardUrl, c.ticker);
  return `<tr><td style="padding:20px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      <td valign="bottom" style="padding:0 8px 6px 0;border-bottom:2px solid ${INK};">
        <div style="font-family:${SERIF};font-size:21px;line-height:1.2;font-weight:bold;color:${INK};">${link(href, esc(c.company), `color:${INK};`)}</div>
        <div style="margin-top:3px;font-family:${SANS};font-size:10px;letter-spacing:1px;color:${META};${NUM}">${esc(c.ticker)} · ${counts}</div>
      </td>
      <td valign="bottom" align="right" style="padding:0 0 8px;border-bottom:2px solid ${INK};font-family:${SANS};font-size:11px;white-space:nowrap;">${href ? `<a href="${esc(href)}" ${NEW_TAB} style="color:${GOLD};font-weight:bold;text-decoration:none;">On the dashboard →</a>` : ''}</td>
    </tr></table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${c.stories.map((s, i) => companyStory(s, i === 0)).join('')}</table>
  </td></tr>`;
}

const capturedLabel = (iso) => (iso && Number.isFinite(Date.parse(iso)) ? istLabel(Date.parse(iso)) : 'an unknown time');
/** Every source the brief read, with its own time, in one sentence a reader can check a gap against. */
export function sourcesNote(brief) {
  const a = brief.announcements;
  const n = brief.news;
  const t = brief.trades;
  const m = brief.moves;
  const bits = [];
  bits.push(a.nse.ok ? `NSE live feed read ${istLabel(a.nse.readAt)}` : `NSE live feed could not be read (${a.nse.reason || 'unavailable'})`);
  bits.push(a.nseHistory?.ok
    ? `NSE history ${a.nseHistory.days.length ? `${a.nseHistory.days.length} day file${a.nseHistory.days.length === 1 ? '' : 's'} (${a.nseHistory.days.join(', ')})` : 'no day file for this window'}, captured ${capturedLabel(a.nseHistory.capturedAt)}`
    : 'NSE history unavailable');
  bits.push(a.bse.ok ? `BSE capture dated ${capturedLabel(a.bse.capturedAt)}${a.bse.capturedAt && Date.parse(a.bse.capturedAt) < brief.window.to ? ', so later BSE filings reach the next brief' : ''}` : 'BSE capture unavailable');
  bits.push(n.source.ok
    ? `publisher feeds (${n.source.publishers.join(', ') || 'four publishers'}) captured ${capturedLabel(n.source.capturedAt)}${n.source.capturedAt && Date.parse(n.source.capturedAt) < brief.window.to ? ', so later stories reach the next brief' : ''}${n.source.oldest != null && n.source.oldest > brief.window.from ? `; that capture starts at ${istLabel(n.source.oldest)}, so earlier publisher stories are not included` : ''}`
    : 'publisher capture unavailable');
  bits.push(n.tradingview?.ok ? `TradingView headlines captured ${capturedLabel(n.tradingview.capturedAt)}` : 'TradingView headlines unavailable');
  bits.push(t?.source?.ok ? `trades (bulk, block, SAST, insider) captured ${capturedLabel(t.source.capturedAt)}, dated by broadcast day${t.source.identities ? '' : '; BSE-only lines could not be matched'}` : 'trades capture unavailable');
  if (m) {
    bits.push(m.state === 'capture' ? `prices from the closing quotes captured ${m.asOf ? istLabel(m.asOf) : 'at an unknown time'} for the ${m.session} session`
      : m.state === 'daily' ? `prices from the completed daily bars for ${m.session}, written ${m.asOf ? istLabel(m.asOf) : 'at an unknown time'}`
      : `price moves unavailable (${m.reason || 'unavailable'}${m.priceDate ? `; daily bars end ${m.priceDate}` : ''})`);
  }
  const late = brief.lateFrom != null ? ` Items published since ${istLabel(brief.lateFrom)} that no earlier brief carried are included and marked.` : '';
  return `Window ${windowLine(brief)} · ${bits.join(' · ')}.${late}`;
}

const routineNote = (n) => `${n} routine filing${n === 1 ? '' : 's'} (newspaper copies, NAV declarations, trading-window, certificate and demat notices) ${n === 1 ? 'is' : 'are'} not listed here; ${n === 1 ? 'it stays' : 'they stay'} on the dashboard.`;

/**
 * The email. `recipient` personalises the footer only, so one build serves every subscriber.
 */
export function renderBriefHtml(brief, { dashboardUrl = PRODUCTION_ORIGIN, recipient = null, productName = PRODUCT_NAME, brand = BRAND, settings = null } = {}) {
  const subject = briefSubject(brief, { brand });
  const stats = briefStats(brief);
  const sendTime = settings?.[brief.edition]?.time || EDITIONS[brief.edition].defaultTime;
  const unsubscribeUrl = `${dashboardUrl}/#/research/ask-research?newsletter=manage`;
  const parts = [];

  parts.push(`<tr><td align="center" style="padding:30px 34px 0;">
    <div style="font-family:${SERIF};font-size:34px;line-height:1.1;font-weight:bold;letter-spacing:6px;color:${INK};">${esc(brand.toUpperCase())}</div>
    <div style="border-top:3px double ${INK};margin:12px 0 7px;font-size:0;line-height:0;">&nbsp;</div>
    <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${META};">${esc(productName)} — ${esc(TAGLINES[brief.edition])}</div>
    <div style="margin-top:10px;padding:7px 0;border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${META};">${esc(istDateLong(brief.at).replace(/^(\w+) /, '$1, '))} · Edition: ${esc(EDITION_NAME)}${brief.onDemand ? ' · built on request' : ''}</div>
  </td></tr>`);

  const reported = stats.companies.length;
  parts.push(`<tr><td style="padding:14px 34px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${BODY};">
    <strong style="color:${INK};">${stats.stories} ${stats.stories === 1 ? 'update' : 'updates'}</strong> across <strong style="color:${INK};">${reported} of ${brief.book.listed}</strong> portfolio compan${brief.book.listed === 1 ? 'y' : 'ies'} &nbsp;·&nbsp; ${dot(MOODS.good.color, 9)} ${stats.good} good &nbsp;·&nbsp; ${dot(MOODS.watch.color, 9)} ${stats.watch} watch-out${stats.watch === 1 ? '' : 's'}${stats.late ? ` &nbsp;·&nbsp; <span style="color:${GOLD};">${stats.late} not in the previous brief</span>` : ''}
  </td></tr>`);

  parts.push(`<tr><td style="padding:24px 34px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
      <td style="padding:0 0 4px;border-bottom:3px solid ${GOLD_LIGHT};">${caps('Your portfolio companies', `color:${INK};font-weight:bold;letter-spacing:3px;`)}</td>
      <td align="right" style="padding:0 0 4px;border-bottom:3px solid ${GOLD_LIGHT};">${caps(esc(windowLine(brief)), `color:${META};letter-spacing:1px;`)}</td>
    </tr></table>
  </td></tr>`);

  const readable = brief.announcements.nse.ok || brief.announcements.nseHistory?.ok || brief.announcements.bse.ok || brief.news.source.ok || brief.news.tradingview?.ok || brief.trades?.source?.ok || (brief.moves && brief.moves.state !== 'unavailable');
  if (!stats.stories) {
    parts.push(`<tr><td align="center" style="padding:30px 34px 6px;">
      <div style="font-family:${SERIF};font-size:20px;line-height:1.3;font-style:italic;color:${INK};">Quiet window — nothing to report.</div>
      <div style="margin-top:8px;font-family:${SANS};font-size:11px;line-height:1.6;color:${META};">${readable ? 'Nothing was filed, published, traded or moved about a portfolio company in this window.' : 'No filing, publisher, trade or price feed could be read for this window, so stories are not known — not absent.'}</div>
    </td></tr>`);
  } else {
    parts.push(`<tr><td style="padding:0 34px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${stats.companies.map((c) => companyBlock(c, dashboardUrl)).join('')}</table>
    </td></tr>`);
    const more = brief.announcements.more + brief.news.more + (brief.trades?.more || 0) + (brief.moves?.more || 0);
    if (more > 0) parts.push(`<tr><td style="padding:14px 34px 0;font-family:${SANS};font-size:11px;line-height:1.6;color:${META};">${more} more in this window on the <a href="${esc(`${dashboardUrl}/#/research/daily-alerts?scope=portfolio`)}" ${NEW_TAB} style="color:${GOLD};font-weight:bold;text-decoration:none;">dashboard →</a>; whatever is not shown here reaches the next brief.</td></tr>`);
  }
  if (brief.announcements.routineHidden) {
    parts.push(`<tr><td style="padding:${stats.stories ? 8 : 14}px 34px 0;font-family:${SANS};font-size:11px;line-height:1.6;color:${META};">${esc(routineNote(brief.announcements.routineHidden))}</td></tr>`);
  }

  parts.push(marketSection(brief));
  parts.push(`<tr><td style="padding:22px 34px 0;font-family:${SANS};font-size:10px;line-height:1.6;color:${META};">${esc(sourcesNote(brief))}</td></tr>`);

  const subscribedLine = recipient?.test
    ? 'This is a test copy you asked for.'
    : `You're subscribed to the ${esc(brand)} brief on your ${esc(EDITION_NAME.toLowerCase())}, every weekday at ${esc(clockLabel(sendTime))}.${recipient?.addedBy ? ` Added by ${esc(recipient.addedBy)}.` : ''}`;
  const disclaimer = 'Filings, headlines and disclosures as the exchanges, publishers and reporting sources wrote them — nothing summarised. Mood follows this dashboard’s stated rules: a filing’s subject, a trade’s own transaction word, the sign of a price move; published stories are shown neutral. This brief is informational, not investment advice.';
  parts.push(`<tr><td style="padding:22px 34px;background:${INK};color:#d8d0be;font-family:${SANS};font-size:12px;line-height:1.7;">
    ${subscribedLine}<br>
    <a href="${esc(unsubscribeUrl)}" ${NEW_TAB} style="color:${GOLD_LIGHT};text-decoration:underline;">Unsubscribe</a> · <strong style="color:${GOLD_LIGHT};letter-spacing:1px;">${esc(brand)}</strong> ${esc(productName)} · powered by Munshot<br>
    <span style="color:#6b6455;font-size:10px;">${esc(disclaimer)} Sent ${esc(istLabel(brief.builtAt, { year: true }))}.</span>
  </td></tr>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<base target="_blank">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${CREAM};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${PAPER};border:1px solid ${RULE};">
${parts.join('\n')}
</table>
<div style="padding-top:12px;font-family:${SANS};font-size:10px;letter-spacing:1px;color:#a49b88;">${esc(brand)} · ${esc(productName)}</div>
</td></tr></table>
</body>
</html>`;
}

/** The same brief as plain text — what the tests read, and a copy that survives any client. */
export function renderBriefText(brief, { productName = PRODUCT_NAME, brand = BRAND } = {}) {
  const stats = briefStats(brief);
  const lines = [];
  lines.push(brand.toUpperCase(), `${productName} — ${TAGLINES[brief.edition]}`, `${istDateLong(brief.at)} · Edition: ${EDITION_NAME}`);
  lines.push(`${stats.stories} updates across ${stats.companies.length} of ${brief.book.listed} portfolio companies · ${stats.good} good · ${stats.watch} watch-outs${stats.late ? ` · ${stats.late} not in the previous brief` : ''}`);
  lines.push('', `YOUR PORTFOLIO COMPANIES · ${windowLine(brief)}`);
  if (!stats.stories) lines.push('Quiet window — nothing to report.');
  for (const c of stats.companies) {
    lines.push('', `${c.company} (${c.ticker}) · ${c.stories.length} update${c.stories.length === 1 ? '' : 's'}`);
    for (const s of c.stories) lines.push(`  [${s.topic.label}] ${s.headline}`, `    ${s.mood.label} · ${s.source} · ${storyWhen(s)}${s.late ? ' · not in the previous brief' : ''}${s.url ? ` · ${s.url}` : ''}`);
  }
  if (brief.announcements.routineHidden) lines.push('', routineNote(brief.announcements.routineHidden));
  lines.push('', 'GLOBAL MARKET SCAN');
  for (const g of MARKET_GROUPS) {
    const members = brief.markets.rows.filter((r) => r.group === g.id);
    if (!members.length) continue;
    lines.push(`  ${g.label}`);
    for (const r of members) lines.push(`    ${r.label.padEnd(20)} ${(formatLast(r) ?? '—').padStart(11)} ${(formatPct(r) ?? '—').padStart(8)}   ${asOfLabel(r)}`);
  }
  lines.push('', sourcesNote(brief));
  return lines.join('\n');
}
