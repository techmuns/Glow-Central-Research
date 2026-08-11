#!/usr/bin/env node
// scrape-portfolio-history.mjs — daily closes for every portfolio holding, plus the Nifty 500.
//
//   node scripts/scrape-portfolio-history.mjs
//   HISTORY_YEARS=5 node scripts/scrape-portfolio-history.mjs
//
// Writes public/data/portfolio-history.json.
//
// WHY THIS IS REAL AND NOT GENERATED
//   The Drawdown view is a risk metric. A max drawdown of −24% computed from an invented price
//   series is the single worst number in this dashboard to fake, because unlike a mock revenue
//   figure it looks exactly like a real one and nobody can check it against anything. The
//   portfolio is a dozen tickers, Yahoo is reachable, so the equity curve is built from actual
//   closes and the file records what it could not fetch.
//
// FAILURES ARE RECORDED, NOT DROPPED. A ticker Yahoo will not serve appears in `failures[]`
// with the reason, and the UI names the positions the curve excludes. A quietly shorter curve
// that still reports a drawdown would be a lie of omission.
//
// The fetch helper is shared with scrape-technicals.mjs (scripts/lib/yahoo.mjs) so both feeds
// agree about what a close price is.

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBars, sleep, INDEX_SYMBOL } from './lib/yahoo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = resolve(__dirname, '../public/data/portfolio.json');
const TRANSACTIONS_PATH = resolve(__dirname, '../public/data/mock/transactions.json');
const UNIVERSE_PATH = resolve(__dirname, '../public/data/universe.json');
const OUT_PATH = resolve(__dirname, '../public/data/portfolio-history.json');

const YEARS = Number(process.env.HISTORY_YEARS || 3);

// ---------------------------------------------------------------------------------------
// Which tickers to fetch: everything the portfolio holds now, plus everything that has ever
// been traded. A position that was fully exited two years ago still contributed to the equity
// curve while it was held, so leaving it out would silently flatten that stretch.
// ---------------------------------------------------------------------------------------
function tickersToFetch() {
  const set = new Set();
  const portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'));
  for (const h of portfolio.holdings || []) set.add(String(h.ticker).toUpperCase());
  try {
    const tx = JSON.parse(readFileSync(TRANSACTIONS_PATH, 'utf8'));
    const rows = Array.isArray(tx) ? tx : tx.transactions || [];
    for (const t of rows) if (t.ticker) set.add(String(t.ticker).toUpperCase());
  } catch {
    // No ledger yet — current holdings alone are enough to start.
  }
  // Bootstrap hatch. A ticker that is about to enter the ledger is not in it yet, and the mock
  // generator prices its trades off this file — so without this the two scripts deadlock, each
  // waiting for the other. EXTRA_TICKERS=ASIANPAINT breaks the cycle once; after that the
  // ledger names the ticker and the plain run picks it up.
  for (const t of (process.env.EXTRA_TICKERS || '').split(',')) {
    const clean = t.trim().toUpperCase();
    if (clean) set.add(clean);
  }
  return [...set].sort();
}

/**
 * Yahoo's symbol for an NSE ticker. The universe file is the authority on which symbols exist;
 * anything not in it still gets tried with a `.NS` suffix, and lands in `failures[]` if Yahoo
 * does not serve it.
 */
function yahooSymbol(ticker) {
  return `${ticker}.NS`;
}

async function main() {
  const tickers = tickersToFetch();
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - YEARS);

  console.log(`Fetching ${YEARS}y of daily closes for ${tickers.length} tickers + ${INDEX_SYMBOL}\n`);

  const series = {};
  const failures = [];
  let ok = 0;

  // The index first — without a benchmark the drawdown view can only report absolute numbers,
  // and "the portfolio fell 22%" means very little without "the market fell 19%".
  let benchmark = null;
  try {
    const bars = await fetchBars(INDEX_SYMBOL, start, end);
    benchmark = { symbol: INDEX_SYMBOL, name: 'Nifty 500', points: bars.map((b) => ({ d: b.date, c: round2(b.close) })) };
    console.log(`  ${'Nifty 500'.padEnd(22)} ${INDEX_SYMBOL.padEnd(16)} OK   ${bars.length} bars`);
  } catch (err) {
    failures.push({ ticker: INDEX_SYMBOL, symbol: INDEX_SYMBOL, reason: String(err.message || err), kind: 'benchmark' });
    console.log(`  ${'Nifty 500'.padEnd(22)} ${INDEX_SYMBOL.padEnd(16)} FAIL ${err.message || err}`);
  }

  let universeTickers = new Set();
  try {
    const universe = JSON.parse(readFileSync(UNIVERSE_PATH, 'utf8'));
    universeTickers = new Set(
      universe.map((e) => String(e['Screener URL'] || '').match(/\/company\/([^/]+)/)?.[1]?.toUpperCase()).filter(Boolean)
    );
  } catch {
    /* optional */
  }

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const symbol = yahooSymbol(ticker);
    const label = `[${i + 1}/${tickers.length}]`;
    try {
      const bars = await fetchBars(symbol, start, end);
      if (!bars.length) throw new Error('no bars returned');
      series[ticker] = bars.map((b) => ({ d: b.date, c: round2(b.close) }));
      ok++;
      console.log(`${label} ${ticker.padEnd(16)} ${symbol.padEnd(16)} OK   ${bars.length} bars  ${bars[0].date} → ${bars.at(-1).date}`);
    } catch (err) {
      failures.push({
        ticker,
        symbol,
        reason: String(err.message || err),
        inUniverse: universeTickers.size ? universeTickers.has(ticker) : null,
        kind: 'holding',
      });
      console.log(`${label} ${ticker.padEnd(16)} ${symbol.padEnd(16)} FAIL ${err.message || err}`);
    }
    await sleep(220); // be polite; this is a public endpoint
  }

  const allDates = new Set();
  for (const points of Object.values(series)) for (const p of points) allDates.add(p.d);
  const dates = [...allDates].sort();

  const payload = {
    _provenance:
      'REAL DATA. Daily closing prices from Yahoo Finance for every ticker the portfolio holds or has ever traded, ' +
      'plus the Nifty 500 index. This file is what the Drawdown view computes its equity curve from — a synthetic ' +
      'price series would produce a risk number nobody could check.',
    generated_at: new Date().toISOString(),
    source: 'Yahoo Finance',
    years: YEARS,
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    trading_days: dates.length,
    ticker_count: Object.keys(series).length,
    requested_count: tickers.length,
    failure_count: failures.length,
    // Named so the UI can say which positions the curve excludes rather than quietly shortening it.
    failures,
    benchmark,
    series,
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(payload)}\n`);

  console.log('\n=== Done ===');
  console.log(`Tickers:       ${ok} OK, ${failures.filter((f) => f.kind === 'holding').length} failed`);
  console.log(`Benchmark:     ${benchmark ? `${benchmark.points.length} bars` : 'FAILED — the drawdown view will have no comparison'}`);
  console.log(`Trading days:  ${dates.length}  (${payload.from} → ${payload.to})`);
  if (failures.length) {
    console.log('\nFailures (recorded in the file, surfaced in the UI):');
    for (const f of failures) console.log(`  ${f.ticker.padEnd(16)} ${f.reason}${f.inUniverse === false ? '  [not in the NSE-500 universe]' : ''}`);
  }
  console.log(`\nWrote: ${OUT_PATH}`);
}

const round2 = (n) => Math.round(n * 100) / 100;

main().catch((err) => {
  console.error('scrape-portfolio-history failed:', err);
  process.exit(1);
});
