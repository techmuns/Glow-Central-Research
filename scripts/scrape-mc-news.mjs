#!/usr/bin/env node
// scripts/scrape-mc-news.mjs — market-wide stocks news from Moneycontrol's own listing page.
//
//   node scripts/scrape-mc-news.mjs                    top-up: walk until a known story appears
//   MCNEWS_PAGES=25 MCNEWS_FULL=1 node scripts/…       the one-off deep backfill
//   MCNEWS_DATE_LIMIT=0 node scripts/…                 skip the per-article date fetch
//   MCNEWS_KEEP=600 node scripts/…                     how many stories the file keeps
//
// Writes public/data/market-news.json.
//
// A TOP-UP RUN STOPS AT THE FIRST STORY IT ALREADY HAS. The listing is in publication order, so
// once a known id appears there is nothing newer below it — a normal run is one or two page reads
// and a handful of article reads, which is what makes a twenty-minute cadence defensible against
// somebody else's server. `MCNEWS_FULL=1` disables that, for the first fill and for repair.
//
// THE PUBLISHER'S TIME COSTS ONE REQUEST PER STORY, so it is budgeted and it is optional.
// The listing page carries no date at all (verified: no date, time or timestamp class anywhere on
// it), and the article page carries `datePublished`. New stories are dated newest-first until the
// budget runs out; the rest keep `publishedAt: null` and are rendered as an em dash. THEY ARE NEVER
// STAMPED WITH THE TIME WE SAW THEM — that is `firstSeenAt`, it is a fact about this scraper rather
// than about the story, and it lives in its own field so the two cannot be confused.
//
// MERGING IS BY THE PUBLISHER'S OWN ARTICLE ID, taken from the URL. Never a position in the list,
// never a hash of the title — a headline gets edited after publication and would then read as a
// second story.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchNews, fetchPublishedAt, HEADERS } from '../worker/mc-news.mjs';

const execFileP = promisify(execFile);

// NODE'S `fetch` CANNOT READ THIS SITE, AND NO HEADER SET FIXES IT.
//
// Measured against www.moneycontrol.com/news/business/stocks/: `curl` with a browser user-agent
// returns 200 and 598 KB, while node's undici `fetch` returns **403 with a 24-byte body** — with a
// bare user-agent, with a user-agent plus accept, and with the full sixteen-header browser set
// including sec-fetch-* and sec-ch-ua. It is TLS/HTTP2 fingerprinting, not headers, so tuning the
// headers is time spent on the wrong thing. (api.moneycontrol.com, which worker/mc.mjs uses for the
// earnings feed, does NOT do this — it is the www host only.)
//
// So this script shells out to curl. worker/mc-news.mjs stays pure and takes `fetchImpl` as a
// parameter, which is what makes that possible without the parser knowing anything about it.
const curlFetch = async (url, { headers = {} } = {}) => {
  const args = ['-sSL', '--compressed', '--max-time', '45', '--retry', '3', '--retry-delay', '2', '--retry-all-errors', '--fail-with-body', '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries({ ...HEADERS, ...headers })) args.push('-H', `${k}: ${v}`);
  args.push(url);
  try {
    const { stdout } = await execFileP('curl', args, { maxBuffer: 64 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1).trim());
    const body = stdout.slice(0, cut);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  } catch (err) {
    const out = String(err.stdout || '');
    const cut = out.lastIndexOf('\n');
    const status = Number(out.slice(cut + 1).trim()) || 0;
    return { ok: false, status, text: async () => out.slice(0, Math.max(0, cut)) };
  }
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/market-news.json');

const PAGES = Number(process.env.MCNEWS_PAGES || 4);
const FULL = process.env.MCNEWS_FULL === '1';
const DATE_LIMIT = process.env.MCNEWS_DATE_LIMIT === undefined ? 40 : Number(process.env.MCNEWS_DATE_LIMIT);
// A ceiling on bytes, not on relevance. ~600 stories is roughly 400 KB, which every visitor
// downloads once and then revalidates with a 304.
const KEEP = Number(process.env.MCNEWS_KEEP || 600);
const DATE_CONCURRENCY = 4;

const num = (n) => Number(n).toLocaleString('en-IN');

function loadExisting() {
  if (!existsSync(OUT)) return { articles: [], newestId: null };
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    return { articles: Array.isArray(prev.articles) ? prev.articles : [], newestId: prev.newestId || null };
  } catch {
    return { articles: [], newestId: null };
  }
}

/** Newest first, by the publisher's own id. Falls back to the date, then to first sight. */
const byNewest = (a, b) => {
  if (a.id && b.id && a.id.length === b.id.length) return b.id.localeCompare(a.id);
  if (a.id && b.id) return Number(b.id) - Number(a.id);
  return String(b.publishedAt || b.firstSeenAt || '').localeCompare(String(a.publishedAt || a.firstSeenAt || ''));
};

async function datesFor(articles, limit) {
  if (limit <= 0 || !articles.length) return 0;
  const queue = articles.slice(0, limit);
  let done = 0;
  let filled = 0;
  const workers = Array.from({ length: Math.min(DATE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const a = queue[done++];
      if (!a) return;
      try {
        const at = await fetchPublishedAt(a.url, { fetchImpl: curlFetch });
        if (at) {
          a.publishedAt = at;
          filled++;
        }
      } catch {
        // A story whose page would not load keeps a null date. It is not given "now".
      }
      process.stdout.write(`\r  dating ${filled}/${Math.min(limit, articles.length)}   `);
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');
  return filled;
}

async function main() {
  const existing = loadExisting();
  const known = new Map(existing.articles.map((a) => [a.id || a.url, a]));
  const stopAtId = FULL ? null : existing.newestId;

  console.log(`Moneycontrol market news — ${FULL ? `full walk, ${PAGES} pages` : `top-up, stopping at ${stopAtId || 'nothing known yet'}`}`);

  const { articles, requests, reachedKnown } = await fetchNews(
    { pages: PAGES, stopAtId },
    {
      fetchImpl: curlFetch,
      onProgress: ({ page, got }) => process.stdout.write(`\r  page ${String(page).padStart(2)}  ${String(got).padStart(4)} stories   `),
    },
  );
  process.stdout.write('\n');

  // A run that read pages and parsed nothing is the markup having changed, not a quiet news day.
  if (!articles.length && !reachedKnown) {
    console.error('Parsed zero stories and never reached a known one. Refusing to write.');
    process.exit(1);
  }

  const fresh = articles.filter((a) => !known.has(a.id || a.url));
  console.log(`  ${num(articles.length)} read · ${num(fresh.length)} new · ${requests} listing request(s)${reachedKnown ? ' · stopped at a known story' : ''}`);

  const now = new Date().toISOString();
  for (const a of fresh) a.firstSeenAt = now;
  const dated = await datesFor(fresh, DATE_LIMIT);
  if (fresh.length) console.log(`  ${num(dated)} of ${num(Math.min(DATE_LIMIT, fresh.length))} dated from the article page`);

  // Merge: a story already held keeps its firstSeenAt and any date it already had.
  for (const a of fresh) known.set(a.id || a.url, a);
  for (const a of articles) {
    const held = known.get(a.id || a.url);
    if (held && !held.publishedAt && a.publishedAt) held.publishedAt = a.publishedAt;
  }

  const all = [...known.values()].sort(byNewest);
  const kept = all.slice(0, KEEP);
  const withDate = kept.filter((a) => a.publishedAt).length;

  const payload = {
    _provenance:
      'Market-wide stocks news as Moneycontrol publish it at /news/business/stocks/. Headlines, standfirsts and section names are theirs, reproduced unchanged; ' +
      'the article stays on their site and every row links to it. Nothing here is summarised, scored or ranked by this dashboard — the order is the publisher\'s own.',
    source: 'Moneycontrol — https://www.moneycontrol.com/news/business/stocks/',
    generator: 'scripts/scrape-mc-news.mjs',
    capturedAt: now,
    newestId: kept[0]?.id || existing.newestId || null,
    articleCount: kept.length,
    // Two different facts, kept apart deliberately: how many carry the PUBLISHER'S time, and how
    // many we have only ever seen. A story with no `publishedAt` renders a dash, never a guess.
    withPublishedAt: withDate,
    withoutPublishedAt: kept.length - withDate,
    keep: KEEP,
    pagesRead: PAGES,
    listingRequests: requests,
    stoppedAtKnown: reachedKnown,
    articles: kept,
  };

  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`  ${num(kept.length)} stories kept (${num(withDate)} with the publisher's time) · newest id ${payload.newestId}`);
  console.log(`  wrote ${OUT}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.reason ? `[${err.reason}] ` : ''}${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exit(1);
});
