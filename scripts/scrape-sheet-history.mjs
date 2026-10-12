#!/usr/bin/env node
// scrape-sheet-history.mjs — the dated history behind the Portfolio tab's returns. GLOW-OWNED.
//
//   node scripts/scrape-sheet-history.mjs                         # writes public/data/sheet-history.json
//   SHEET_HISTORY_LIMIT=5 node scripts/scrape-sheet-history.mjs   # a smoke run over five companies
//
// The Portfolio tab prints, per holding, a total shareholder return INCLUDING DIVIDENDS, its XIRR,
// and its alpha over the NSE 500. Each needs a fact no other capture here carries:
//
//   • the Nifty 500's daily close since 2005, so a holding bought on any day has a benchmark level
//     for that day (the technicals capture keeps only the index's last close and a 6-month return);
//   • every dividend and split each company has paid, so the dividends a holding received since it
//     was bought can be counted, and a split after a statement date can be applied to its quantity;
//   • for a company the technicals capture does not price, its recent daily closes, so its one-month
//     return has a base.
//
// All three come from Yahoo Finance's chart API — the reader the technicals scrape already uses
// (scripts/lib/yahoo.mjs), on the same runner. Its dividend events are already expressed per
// CURRENT share (a pre-split dividend is divided by the split), which is the basis the tab's
// quantity is on, so nothing here rescales them. Nothing is summed, scored or interpolated: the
// file reproduces dated events and closes, and the tab does the arithmetic it labels as its own.
//
// A FAILED READ IS NEVER AN EMPTY HISTORY. A company Yahoo cannot answer keeps the entry the last
// run captured, with that run's `checkedAt`, and is named in `failed` — so "no dividends" (an empty
// list Yahoo returned) and "could not read" (absent, or retained) stay different answers. A run that
// cannot read the index and has no previous index refuses to write at all.

import { readFileSync, writeFileSync } from 'node:fs';
import { fetchBars, sleep, USER_AGENT, INDEX_SYMBOL } from './lib/yahoo.mjs';

const OUT = 'public/data/sheet-history.json';
const ORIGIN = process.env.DASHBOARD_ORIGIN || 'https://glow-central-research.tech-441.workers.dev';
const INDEX_FROM = new Date('2005-01-01T00:00:00Z');
const EVENTS_FROM = new Date('1995-01-01T00:00:00Z');
const RECENT_DAYS = 120;
const LIMIT = Number(process.env.SHEET_HISTORY_LIMIT) || Infinity;
const PAUSE_MS = 350;

const readJson = (path, fallback = null) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
};
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const day = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The public-direct holdings the Portfolio tab lists: listed equity outside every PMS mandate. */
export function publicDirectTickers(book, companies) {
  const listed = new Map((companies?.holdings || []).map((h) => [h.isin, h]));
  const out = new Set();
  for (const p of book?.positions || []) {
    if (p.assetClass !== 'Equity' || p.engagement === 'PMS') continue;
    if (listed.get(p.isin)?.listed === false) continue;
    const ticker = p.symbol || listed.get(p.isin)?.ticker || null;
    if (ticker) out.add(String(ticker).toUpperCase());
  }
  return out;
}

/** Yahoo's symbol for an exchange identity: NSE symbols take `.NS`, six-digit BSE codes `.BO`. */
export const yahooSymbol = (ticker) => (/^\d{6}$/.test(ticker) ? `${ticker}.BO` : `${ticker}.NS`);

async function getJson(url, timeout = 20000) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/** Dividend and split events over the company's whole Yahoo history, oldest first. */
export async function fetchEvents(symbol) {
  const p1 = Math.floor(EVENTS_FROM.getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  // Monthly bars keep the response small; the EVENTS block carries each event's own exact date
  // whatever the bar interval.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1mo&events=div%2Csplits`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = await getJson(url);
      const result = body?.chart?.result?.[0];
      if (!result) throw Object.assign(new Error(body?.chart?.error?.description || 'no chart data'), { status: 404 });
      const dividends = Object.values(result.events?.dividends || {})
        .filter((d) => Number.isFinite(d?.date) && Number.isFinite(d?.amount) && d.amount > 0)
        .map((d) => [day(d.date), r6(d.amount)])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const splits = Object.values(result.events?.splits || {})
        .filter((s) => Number.isFinite(s?.date) && s.numerator > 0 && s.denominator > 0)
        .map((s) => [day(s.date), s.numerator, s.denominator])
        .sort((a, b) => a[0].localeCompare(b[0]));
      return { dividends, splits, currency: result.meta?.currency || null, firstTrade: result.meta?.firstTradeDate ? day(result.meta.firstTradeDate) : null };
    } catch (error) {
      lastError = error;
      if (error.status === 404) break;
      await sleep(800 * attempt);
    }
  }
  throw lastError;
}

async function sharedTickers(path, pick) {
  try {
    const body = await getJson(`${ORIGIN}${path}`, 15000);
    return { ok: true, tickers: pick(body) };
  } catch (error) {
    return { ok: false, tickers: [], reason: error.message };
  }
}

async function main() {
  const book = readJson('public/data/book.json');
  const companies = readJson('public/data/portfolio-companies.json');
  const technicals = readJson('public/data/technicals.json', { companies: [] });
  const previous = readJson(OUT, null);
  if (!book || !companies) throw new Error('book.json and portfolio-companies.json are required');

  const priced = new Set((technicals.companies || []).filter((c) => (c.closeHistory?.rows || []).length >= 25).map((c) => c.ticker));
  const direct = publicDirectTickers(book, companies);
  // The shared watchlist and the hand-added holdings live on the Worker. Reading them is best
  // effort: a run that cannot reach them keeps the companies the previous file covered.
  const watch = await sharedTickers('/api/watchlist', (b) => (Array.isArray(b?.companies) ? b.companies.map((c) => c.ticker) : []));
  const manual = await sharedTickers('/api/research-sheet', (b) => (Array.isArray(b?.rows) ? b.rows.map((r) => r.key) : []));
  const wanted = new Set([...direct, ...watch.tickers, ...manual.tickers].map((t) => String(t || '').toUpperCase())
    .filter((t) => /^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(t)));
  if (!watch.ok || !manual.ok) for (const t of Object.keys(previous?.companies || {})) wanted.add(t);

  // ---- the benchmark ----
  let benchmark = previous?.benchmark || null;
  const failed = [];
  try {
    const bars = await fetchBars(INDEX_SYMBOL, INDEX_FROM, new Date());
    const rows = bars.filter((b) => b.close > 0).map((b) => [b.date, r2(b.close)]);
    if (rows.length < 1000) throw new Error(`only ${rows.length} index closes`);
    benchmark = {
      id: 'nifty-500', name: 'Nifty 500', symbol: INDEX_SYMBOL, basis: 'price index',
      note: 'Yahoo Finance daily closes of the Nifty 500 price index (dividends not reinvested).',
      from: rows[0][0], to: rows.at(-1)[0], checkedAt: new Date().toISOString(), rows,
    };
  } catch (error) {
    failed.push({ ticker: INDEX_SYMBOL, reason: `benchmark: ${error.message}` });
    if (!benchmark) throw new Error(`The Nifty 500 history could not be read and no previous copy exists: ${error.message}`);
  }

  // ---- the companies ----
  const out = {};
  const list = [...wanted].sort().slice(0, LIMIT);
  for (const ticker of list) {
    const symbol = yahooSymbol(ticker);
    const held = previous?.companies?.[ticker] || null;
    try {
      const events = await fetchEvents(symbol);
      const entry = { symbol, checkedAt: new Date().toISOString(), dividends: events.dividends, splits: events.splits };
      if (!priced.has(ticker)) {
        const from = new Date(Date.now() - RECENT_DAYS * 86400000);
        const bars = await fetchBars(symbol, from, new Date());
        entry.closes = { basis: 'close', from: bars[0]?.date || null, to: bars.at(-1)?.date || null, rows: bars.map((b) => [b.date, r2(b.close)]) };
      }
      out[ticker] = entry;
    } catch (error) {
      const reason = error.status === 404 ? 'not on Yahoo Finance under this symbol (an SME or BSE-only listing has no history here)' : error.message;
      failed.push({ ticker, reason });
      if (held) out[ticker] = { ...held, retained: true };
    }
    await sleep(PAUSE_MS);
  }

  const payload = {
    version: 1,
    _provenance: 'Dated history for the Portfolio tab: Nifty 500 daily closes, and each covered company\'s dividend and split events (and recent closes where the technicals capture has none), read from Yahoo Finance by scripts/scrape-sheet-history.mjs. Dividends are Yahoo\'s, per current share. Nothing here is summed or scored.',
    source: 'Yahoo Finance chart API',
    generatedAt: new Date().toISOString(),
    coverage: {
      wanted: wanted.size, publicDirect: direct.size, watchlist: watch.ok ? watch.tickers.length : null, manual: manual.ok ? manual.tickers.length : null,
      read: Object.values(out).filter((e) => !e.retained).length, retained: Object.values(out).filter((e) => e.retained).length,
      sharedListsRead: watch.ok && manual.ok,
    },
    benchmark,
    companies: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))),
    failed,
  };
  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(JSON.stringify({ wrote: OUT, ...payload.coverage, benchmarkTo: benchmark?.to, failed: failed.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
