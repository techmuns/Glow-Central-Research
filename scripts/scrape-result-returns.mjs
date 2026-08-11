#!/usr/bin/env node
// scrape-result-returns.mjs — the base price for the "Return since result" column.
//
//   node scripts/scrape-result-returns.mjs
//   RETURNS_LIMIT=50 node scripts/scrape-result-returns.mjs   # smoke run
//
// Writes public/data/result-returns.json.
//
// WHAT THIS SOLVES, AND WHY IT IS ONLY HALF THE COLUMN
//   "Return since result" is (price now − price when the result landed) / price when it landed.
//   The second half of that — today's price — arrives LIVE with every poll, because Moneycontrol
//   ships `ltp` on every row. The first half is a closing price on a date already in the past,
//   which will never change again.
//
//   So the split is: this script caches the immutable half, and the browser computes the return
//   fresh on every tick. The column is live without anyone refetching a single historical price.
//   A cache entry, once written, is never recomputed — a rerun costs one Yahoo request per
//   result we have not already priced.
//
// THE CONVENTION, STATED BECAUSE IT IS A CHOICE
//   Indian results are usually announced after the close, so the base is the CLOSING PRICE ON THE
//   RESULT DATE — the last price at which the market could trade without knowing the numbers.
//   Measuring from the next day's open would also be defensible; it is not what this does, and the
//   help modal in the UI says so. If the result date was not a trading day, the previous close is
//   used and the entry records which date was actually priced.
//
// A ticker Yahoo will not serve lands in `failures` and renders as "—", never as 0%.
//
// Node's built-in fetch ignores HTTPS_PROXY. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBars, sleep } from './lib/yahoo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '../public/data/earnings-live.json');
const OUT_PATH = resolve(__dirname, '../public/data/result-returns.json');

const LIMIT = Number(process.env.RETURNS_LIMIT || 4000);
const CONCURRENCY = 5;
const PAUSE_MS = 150;

const readJson = (p, fb) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
};

const dayBefore = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - n * 86400000);
const dayAfter = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000);

/**
 * The close on `isoDate`, or the most recent close before it. Returns `{ close, pricedOn }` so the
 * UI can show which date was actually used when the result landed on a holiday.
 */
async function baseCloseFor(ticker, isoDate) {
  // A 12-day window back and 3 forward comfortably spans a long weekend plus a festival cluster.
  const bars = await fetchBars(`${ticker}.NS`, dayBefore(isoDate, 12), dayAfter(isoDate, 3));
  if (!bars.length) throw new Error('no bars');
  let pick = null;
  for (const b of bars) {
    if (b.date <= isoDate) pick = b;
    else break;
  }
  if (!pick) throw new Error('no close on or before the result date');
  return { close: Math.round(pick.close * 100) / 100, pricedOn: pick.date };
}

async function main() {
  const snap = readJson(SNAPSHOT_PATH, null);
  if (!snap?.rows?.length) {
    console.error('No earnings snapshot found. Run scripts/scrape-earnings.mjs first.');
    process.exit(1);
  }
  const cache = readJson(OUT_PATH, { base: {}, failures: [] });
  const base = { ...cache.base };
  const failures = new Set(cache.failures || []);

  // One entry per (ticker, result date). A company that reports again gets a new key, so the old
  // quarter's base price is kept rather than overwritten — history stays correct.
  const wanted = [];
  for (const r of snap.rows) {
    if (!r.ticker || !r.resultDate) continue;
    const key = `${r.ticker}@${r.resultDate}`;
    if (base[key] || failures.has(key)) continue;
    wanted.push({ key, ticker: r.ticker, date: r.resultDate });
  }

  const todo = wanted.slice(0, LIMIT);
  console.log(`Result-day closes: ${Object.keys(base).length} cached · ${wanted.length} missing · fetching ${todo.length}`);
  if (!todo.length) {
    console.log('Nothing to do.');
    return;
  }

  let done = 0;
  let ok = 0;
  let bad = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const job = queue.shift();
        try {
          const hit = await baseCloseFor(job.ticker, job.date);
          base[job.key] = hit;
          ok++;
        } catch {
          failures.add(job.key);
          bad++;
        }
        done++;
        if (done % 50 === 0 || done === todo.length) process.stdout.write(`\r  ${done}/${todo.length}  (${ok} priced, ${bad} unavailable)`);
        await sleep(PAUSE_MS);
      }
    })
  );
  process.stdout.write('\n');

  writeFileSync(
    OUT_PATH,
    `${JSON.stringify({
      _provenance:
        'REAL DATA. Closing price on each result date, from Yahoo Finance, keyed TICKER@YYYY-MM-DD. This is the BASE of the ' +
        '"Return since result" column; the current price comes live from the Moneycontrol feed on every poll, so the return ' +
        'itself is live. A past close never changes, so entries are written once and never recomputed. Keys in `failures` ' +
        'could not be priced and render as "—", never as 0%.',
      generated_at: new Date().toISOString(),
      source: 'Yahoo Finance daily closes',
      convention: 'Close on the result date, or the last close before it if that day was not a trading day (`pricedOn` records which).',
      count: Object.keys(base).length,
      failure_count: failures.size,
      failures: [...failures].sort(),
      base,
    })}\n`
  );
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${Object.keys(base).length} result-day closes cached · ${failures.size} unavailable`);
}

main().catch((err) => {
  console.error('scrape-result-returns failed:', err.message || err);
  process.exit(1);
});
