// data/sheet-market.js — THE MARKET'S HALF OF THE PORTFOLIO AND WATCHLIST TABS. GLOW-OWNED.
//
// Every figure in these two tabs that nobody types comes through here, and every one is read from a
// feed this dashboard already runs — nothing is fetched per company:
//
//   CMP and 1-day return   the minute price capture (`/api/breakouts/snapshot`, Upstox primary), read every
//                          15 seconds while visible by data/breakout-live.js — the same reader and
//                          the same label as Breakouts; the daily close stands in, dated, when no
//                          current quote exists.
//   1-month return         CMP over the adjusted close on or before the same day last month, from
//                          the technicals capture's 120-session close history (or, for a company it
//                          does not price, the recent closes in sheet-history.json).
//   Market cap             shares outstanding (mc-ticker-map.json) × CMP, so it moves with the price;
//                          where no share count is held, Screener's figure at the technicals close,
//                          moved by the price change since — labelled as such.
//   Sector                 NSE's industry classification as Screener prints it (company-
//                          classification.json), then the technicals capture's sector.
//   Dividends, splits,     sheet-history.json (scripts/scrape-sheet-history.mjs): Yahoo's
//   Nifty 500 history      dividend and split events per company and the Nifty 500's daily closes.
//   Nifty 500 now          /api/benchmark-quote (Upstox, then NSE), read every minute while visible;
//                          the latest captured close stands in, dated, when it cannot be read.
//
// A MISSING FIGURE IS NULL, NEVER ZERO, and each accessor says why in words the tab can print.

import * as technicals from './technicals.js';
import * as breakoutLive from './breakout-live.js';
import { revalidatedJson } from '../core/store.js';
import { parseCrore } from './company-profile.js';
import { closeOnOrBefore, monthBefore, istToday } from './sheet-math.js';

const HISTORY_PATH = 'data/sheet-history.json';
const TICKER_MAP_PATH = 'data/mc-ticker-map.json';
const CLASSIFICATION_PATH = 'data/company-classification.json';
const BENCHMARK_ROUTE = '/api/benchmark-quote';
const BENCHMARK_POLL_MS = 60_000;
const RELOAD_AFTER_MS = 10 * 60_000;

let history = null;
let historyError = null;
let shares = new Map();
let classification = null;
let technicalsError = null;
let loading = null;
let loadedAt = 0;
let benchmarkQuote = null;
let benchmarkState = 'unchecked';

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => { try { fn(); } catch (error) { console.error('[sheet-market] subscriber failed', error); } });
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };

function validHistory(value) {
  if (value?.version !== 1 || !Array.isArray(value?.benchmark?.rows) || typeof value.companies !== 'object') throw new Error('Invalid sheet history');
  return value;
}

// The share counts alone — what a market cap needs — for a reader that must not pull the 3.5 MB
// technicals capture to get them (AI Alerts' Compact rows). Shared with `load()` below.
let sharesLoading = null;
let sharesLoadedAt = 0;
export function loadShareCounts({ force = false } = {}) {
  if (sharesLoading && !force && Date.now() - sharesLoadedAt < RELOAD_AFTER_MS) return sharesLoading;
  sharesLoadedAt = Date.now();
  sharesLoading = revalidatedJson(TICKER_MAP_PATH, { optional: true }).then((map) => {
    const next = new Map();
    for (const entry of Object.values(map?.map || {})) {
      if (entry?.ticker && Number.isFinite(entry.shares) && entry.shares > 0) next.set(String(entry.ticker).toUpperCase(), entry.shares);
    }
    const changed = next.size && next.size !== shares.size;
    if (next.size) shares = next;
    if (changed) emit();
  });
  return sharesLoading;
}

/**
 * Load (or revalidate) every committed file the tabs read. Resolves when each has settled, whatever
 * its outcome: a failed file leaves its figures null with a reason, and never blanks the table.
 */
export function load({ force = false } = {}) {
  if (loading && !force && Date.now() - loadedAt < RELOAD_AFTER_MS) return loading;
  loadedAt = Date.now();
  loading = Promise.allSettled([
    technicals.load().then(() => { technicalsError = null; }, (error) => { technicalsError = error?.message || 'unavailable'; }),
    revalidatedJson(HISTORY_PATH).then((value) => { history = validHistory(value); historyError = null; },
      (error) => { historyError = error?.message || 'unavailable'; }),
    loadShareCounts({ force: true }),
    revalidatedJson(CLASSIFICATION_PATH, { optional: true }).then((value) => { if (value?.companies) classification = value.companies; }),
  ]).then(() => { emit(); });
  return loading;
}

export const historyMeta = () => (history
  ? { generatedAt: history.generatedAt, benchmarkTo: history.benchmark?.to || null, failed: history.failed || [], coverage: history.coverage || null }
  : { error: historyError });
export const technicalsMeta = () => (technicals.isLoaded() ? technicals.meta() : { error: technicalsError });

/** The technicals capture's own row for a company, or null. */
const daily = (ticker) => (ticker && technicals.isLoaded() ? technicals.rowFor(ticker) : null);

/**
 * The price a reader can act on now: the minute capture's quote, else the completed daily close,
 * each with its own time and source. `null` when neither exists for this company.
 */
export function quote(ticker) {
  if (!ticker) return null;
  const company = daily(ticker) || { ticker, cmp: null, pct_change_today: null, price_date: null };
  const info = breakoutLive.priceInfo(company);
  return info.price > 0 ? { ...info, dailyDate: company.price_date || null } : null;
}

/** One-month return: CMP over the close on or before the same day last month. */
export function monthReturn(ticker, price, now = Date.now()) {
  if (!ticker || !(price > 0)) return null;
  const target = monthBefore(istToday(now));
  const own = daily(ticker)?.closeHistory;
  const rows = (own?.rows?.length ? own.rows : null) || history?.companies?.[ticker]?.closes?.rows || null;
  const base = closeOnOrBefore(rows, target);
  if (!base || !(base[1] > 0)) return { value: null, reason: rows ? `No close on or before ${target} in the captured history` : 'No daily price history is captured for this company' };
  const basis = own?.rows?.length ? 'adjusted close (Yahoo, technicals capture)' : 'close (Yahoo Finance history capture)';
  return { value: (price / base[1] - 1) * 100, baseDate: base[0], baseClose: base[1], basis };
}

/**
 * Market cap in ₹ crore, moved by the current price. `basis` says how it was reached, because the
 * two routes are not the same measurement and the cell's title has to say which one it carries.
 */
export function marketCap(ticker, price) {
  if (!ticker) return null;
  const count = shares.get(ticker);
  if (count && price > 0) return { value: (count * price) / 1e7, basis: `shares outstanding (${count.toLocaleString('en-IN')}, Moneycontrol) × CMP` };
  // No share count: Screener's own figure as the technicals capture carries it, NOT moved by the
  // price since — that figure's own pricing date is not stated, so scaling it would be a derivation
  // resting on a guess. It is labelled as the printed figure it is.
  const printed = parseCrore(daily(ticker)?.marketCap);
  if (printed) return { value: printed, basis: `Screener's market cap as printed in the technicals capture (does not move with today's price)` };
  return null;
}

/** Sector, as NSE's classification names it, else as the technicals capture does. */
export function sector(ticker) {
  if (!ticker) return null;
  const c = classification?.[ticker];
  if (c?.sector) return { value: c.sector, source: c.industry ? `NSE classification via Screener · ${c.industry}` : 'NSE classification via Screener' };
  const row = daily(ticker);
  const own = row?.sector && row.sector !== 'Unclassified' ? row.sector : null;
  return own ? { value: own, source: row.industry ? `Screener · ${row.industry}` : 'Screener' } : null;
}

/** Display name from the technicals capture, for a company no other list names. */
export const dailyName = (ticker) => daily(ticker)?.name || null;

/**
 * The dated events behind a company's dividends and splits, or why there are none to count.
 * `state` is `read` (Yahoo answered this run, an empty list included), `retained` (an earlier run's
 * answer, kept because this run's read failed), `failed` or `uncovered` (not in the capture yet).
 */
export function events(ticker) {
  if (!history) return { state: 'unavailable', reason: historyError ? `The dividend history could not be read (${historyError})` : 'The dividend history has not loaded' };
  const entry = ticker ? history.companies?.[ticker] : null;
  const failure = (history.failed || []).find((f) => f.ticker === ticker);
  if (entry) return { state: entry.retained ? 'retained' : 'read', dividends: entry.dividends || [], splits: entry.splits || [], checkedAt: entry.checkedAt || null, reason: failure?.reason || null };
  if (failure) return { state: 'failed', reason: failure.reason };
  return { state: 'uncovered', reason: `Not in the dividend history yet — it is captured daily for every public-direct holding and watchlist company (last run ${history.generatedAt?.slice(0, 10) || 'unknown'})` };
}

/** The Nifty 500's close on or before a date, from the captured history. */
export function benchmarkAt(date) {
  const row = closeOnOrBefore(history?.benchmark?.rows, date);
  return row ? { date: row[0], level: row[1] } : null;
}

/**
 * The Nifty 500's newest level: the live route's print where it is newer than every captured
 * close, else the latest captured close (the history file or the technicals capture, whichever is
 * later). Each carries its own date and where it came from.
 */
export function benchmarkNow() {
  const candidates = [];
  const last = history?.benchmark?.rows?.at(-1);
  if (last) candidates.push({ date: last[0], level: last[1], at: null, source: 'Nifty 500 close (Yahoo Finance history capture)', live: false });
  const tm = technicals.isLoaded() ? technicals.meta() : null;
  if (tm?.index_close > 0 && tm.price_date) candidates.push({ date: tm.price_date, level: tm.index_close, at: null, source: 'Nifty 500 close (Yahoo Finance, technicals capture)', live: false });
  if (benchmarkQuote?.ok && benchmarkQuote.last > 0 && benchmarkQuote.sessionDate) {
    candidates.push({ date: benchmarkQuote.sessionDate, level: benchmarkQuote.last, at: benchmarkQuote.asOf, live: benchmarkQuote.state === 'live',
      source: `Nifty 500 ${benchmarkQuote.state === 'live' ? 'live' : benchmarkQuote.state} print (${benchmarkQuote.origin === 'nse' ? 'NSE' : 'Upstox'})` });
  }
  // Newest session wins; within one session a timed print beats a close of the same day only if it
  // is a live print, because a captured close of today is the settled figure.
  candidates.sort((a, b) => b.date.localeCompare(a.date) || Number(b.live) - Number(a.live));
  return candidates[0] || null;
}

export const benchmarkStatus = () => benchmarkState;

async function readBenchmark() {
  try {
    const res = await fetch(BENCHMARK_ROUTE, { cache: 'no-cache', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if ([404, 405, 501].includes(res.status)) { benchmarkState = 'no-worker'; return; }
    const body = await res.json();
    if (body?.ok && body.last > 0) { benchmarkQuote = body; benchmarkState = 'read'; }
    else benchmarkState = 'unavailable';
  } catch {
    benchmarkState = 'unavailable';
  } finally {
    emit();
  }
}

/**
 * Keep prices moving while a sheet tab is visible: the shared 15-second quote reader, plus the
 * Nifty 500 every minute. Returns the disposer the tab calls in destroy().
 */
export function watch(fn) {
  const off = onChange(fn);
  const stopQuotes = breakoutLive.watch(() => fn());
  const tick = () => { if (document.visibilityState !== 'hidden' && benchmarkState !== 'no-worker') void readBenchmark(); };
  const timer = setInterval(tick, BENCHMARK_POLL_MS);
  document.addEventListener('visibilitychange', tick);
  tick();
  return () => {
    off();
    stopQuotes();
    clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
  };
}
