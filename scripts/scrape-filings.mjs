#!/usr/bin/env node
// scripts/scrape-filings.mjs — news, corporate announcements and insider trades for the universe.
//
//   MUNS_TOKEN=… node scripts/scrape-filings.mjs                 all three, the whole universe
//   MUNS_TOKEN=… node scripts/scrape-filings.mjs announcements   just one feed
//   FILINGS_LIMIT=20 node scripts/scrape-filings.mjs             a smoke run
//   FILINGS_SCOPE=book node scripts/scrape-filings.mjs           the 123 book tickers only
//
// Writes public/data/news.json, corp-announcements.json and insider-trades.json.
//
// WHY THIS EXISTS AT ALL, WHEN THERE ARE PERFECTLY GOOD LIVE ROUTES
//   Two of these three upstreams are per-ticker and all three are rate limited to about sixty
//   requests a minute. The universe is 603 companies, so "show me everything" live is 603 requests
//   and ten minutes — on every visit, against somebody else's service. That is not a page load.
//
//   So the schedule pays that cost once and commits the result, and the browser reads one file. The
//   live routes stay, for the companies a snapshot does not cover yet and for refreshing one
//   company on demand. Same division as the technicals feed.
//
// THE TOKEN IS READ FROM THE ENVIRONMENT AND NEVER WRITTEN ANYWHERE. It is a session JWT and it
// expires, so a run that starts working and then 401s halfway is expected rather than a bug — the
// output records how far it got instead of pretending the rest had nothing.
//
// A COMPANY THAT COULD NOT BE READ IS NOT A COMPANY WITH NOTHING. Failures are written into the
// snapshot under `failed`, with the reason, so the tab can say "40 could not be read" rather than
// silently showing 563 of 603 as if that were the whole picture.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNews, fetchAnnouncements, fetchInsiderTrades, MunsError } from '../worker/muns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => resolve(__dirname, '../public/data', f);

const FEEDS = {
  news: { file: 'news.json', rowsKey: 'articles', windowDays: 30 },
  announcements: { file: 'corp-announcements.json', rowsKey: 'announcements', windowDays: 365 },
  insider: { file: 'insider-trades.json', rowsKey: 'trades', windowDays: 365 },
};

// Sixty requests a minute is the documented ceiling. One request per second with four in flight
// sits under it with room for the retries muns.mjs does on a timeout — and being comfortably under
// somebody else's limit is cheaper than discovering where it is.
const CONCURRENCY = 4;
const GAP_MS = 250;

const env = { MUNS_TOKEN: process.env.MUNS_TOKEN, MUNS_NEWS_TOKEN: process.env.MUNS_NEWS_TOKEN, MUNS_BASE: process.env.MUNS_BASE, MUNS_NEWS_BASE: process.env.MUNS_NEWS_BASE };
const LIMIT = Number(process.env.FILINGS_LIMIT || 0);
const SCOPE = process.env.FILINGS_SCOPE || 'universe';
const only = process.argv.slice(2).filter((a) => FEEDS[a]);
const wanted = only.length ? only : Object.keys(FEEDS);

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The companies to walk: the book first, then the rest of the universe.
 *
 * BOOK FIRST IS DELIBERATE. A run that is cut short — by the rate limit, by an expiring token, by
 * the Action's time budget — should have covered the holdings before the index. The alphabetical
 * order that fell out of the file would have covered whatever happened to start with A.
 */
function companies() {
  const book = JSON.parse(readFileSync(DATA('portfolio-companies.json'), 'utf8'));
  const held = (book.holdings || []).filter((h) => h.ticker).map((h) => ({ ticker: h.ticker.toUpperCase(), name: h.name, held: true }));
  if (SCOPE === 'book') return dedupe(held);

  const tech = JSON.parse(readFileSync(DATA('technicals.json'), 'utf8'));
  const rest = (tech.companies || []).filter((c) => c.ticker).map((c) => ({ ticker: String(c.ticker).toUpperCase(), name: c.name, held: false }));
  return dedupe([...held, ...rest]);
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c.ticker)) continue;
    seen.add(c.ticker);
    out.push(c);
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

/** One feed, walked CONCURRENCY at a time, writing what it got even if it did not get all of it. */
async function run(kind, list) {
  const { file, rowsKey, windowDays } = FEEDS[kind];
  const from = daysAgo(windowDays);
  const to = iso(Date.now());

  const byTicker = {};
  const failed = {};
  const headers = new Set();
  let done = 0;

  const queue = [...list];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      try {
        let res;
        if (kind === 'news') res = await fetchNews({ query: `${c.name || c.ticker} share price results`, country: 'IN', fromDate: from, toDate: to }, env);
        else if (kind === 'announcements') res = await fetchAnnouncements({ ticker: c.ticker, fromDate: from, toDate: to }, env);
        else res = await fetchInsiderTrades({ ticker: c.ticker, country: 'india', fromDate: from, toDate: to }, env);

        const rows = res[rowsKey] || [];
        // `raw` is for the browser's drill, not for a committed file — it is the whole upstream
        // record again and would multiply the snapshot several times over for nothing.
        if (rows.length) byTicker[c.ticker] = rows.map(({ raw, ...rest }) => rest);
        for (const h of res.headers || []) headers.add(h);
      } catch (err) {
        const e = err instanceof MunsError ? err : new MunsError('upstream', String(err?.message || err));
        failed[c.ticker] = { reason: e.reason, message: e.message };
        // An expired token will not fix itself, and walking six hundred more companies to collect
        // six hundred identical 401s wastes half an hour and the whole rate-limit budget.
        if (e.reason === 'no-token' || e.reason === 'unauthorised') {
          queue.length = 0;
          console.error(`\n  ${kind}: stopping — ${e.message}`);
          return;
        }
      }
      done++;
      if (done % 25 === 0) process.stdout.write(`\r  ${kind}: ${done}/${list.length} …`);
      await sleep(GAP_MS);
    }
  });
  await Promise.all(workers);

  const rowCount = Object.values(byTicker).reduce((a, r) => a + r.length, 0);
  const payload = {
    _provenance:
      `REAL DATA, NOT OURS. ${kind} for Indian listed companies via the Muns API, reaching back ${windowDays} days. ` +
      'Headlines, subjects, column headings and wording are the source\'s own, reproduced unchanged and never summarised. ' +
      'A company absent from `byTicker` had nothing in this window OR could not be read — `failed` says which, and the two must not be conflated.',
    kind,
    source: 'Muns filings/news API',
    generator: 'scripts/scrape-filings.mjs',
    capturedAt: new Date().toISOString(),
    from,
    to,
    windowDays,
    scope: SCOPE,
    asked: list.length,
    covered: Object.keys(byTicker).length,
    rowCount,
    failedCount: Object.keys(failed).length,
    headers: [...headers],
    byTicker,
    failed,
  };
  writeFileSync(DATA(file), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `\r  ${kind}: ${rowCount} rows across ${payload.covered} of ${list.length} companies` +
      `${payload.failedCount ? `, ${payload.failedCount} could not be read` : ''} -> public/data/${file}`
  );
}

const list = companies();
console.log(`Walking ${list.length} companies (${SCOPE}) for: ${wanted.join(', ')}\n`);
if (!env.MUNS_TOKEN) {
  console.error('MUNS_TOKEN is not set. These endpoints need a bearer token; nothing was written.');
  process.exit(2);
}
for (const kind of wanted) await run(kind, list);
