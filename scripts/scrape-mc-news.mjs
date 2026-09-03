#!/usr/bin/env node
// scripts/scrape-mc-news.mjs — market-wide stocks news from Moneycontrol's own listing page.
//
//   node scripts/scrape-mc-news.mjs                    top-up: walk until a known story appears
//   MCNEWS_PAGES=25 MCNEWS_FULL=1 node scripts/…       the one-off deep backfill
//   MCNEWS_DATE_LIMIT=0 node scripts/…                 skip the per-article date fetch
//   MCNEWS_HEAD=600 node scripts/…                     how many stories the HEAD file carries
//   MCNEWS_RESHARD=1 node scripts/…                    re-file what is committed; ask the publisher nothing
//
// Writes public/data/market-news.json (the head) and public/data/market-news/<YYYY-MM>.json
// (the archive, one shard per month).
//
// NOTHING IS EVER DISCARDED, WHICH IS THE POINT OF THE TWO FILES.
//   This script used to end with `all.slice(0, KEEP)` and write only that, so every run deleted
//   whatever had fallen past the six-hundredth story — about thirteen days of history, gone for
//   good, and unrecoverable because the publisher's listing only goes back so far. The reader saw
//   it as a scroll that stopped: "600 of 600 stories" is every story we HELD, not every story
//   there was, and the two are indistinguishable from the screen.
//
//   The cap was a ceiling on BYTES, and it was the right instinct pointed at the wrong file: the
//   head is what every visitor downloads on arrival, so it stays bounded. The archive is fetched
//   one month at a time and only by a reader who scrolled to the end of the head, so it costs
//   nothing until somebody actually wants it. A bounded first paint and unbounded history are
//   not in tension once they are separate files.
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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
const curlOnce = async (url, { headers = {} } = {}) => {
  const args = ['-sSL', '--compressed', '--max-time', '45', '--retry', '2', '--retry-delay', '2', '--retry-all-errors', '--fail-with-body', '-w', '\n%{http_code}'];
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

// A 403 IS A DIFFERENT ANIMAL FROM A TIMEOUT, AND `curl --retry` CANNOT HELP WITH IT.
//
// Measured over 41 hours of scheduled runs: 7 of 12 failed with **HTTP 403 on the listing page**,
// and the split by clock is total —
//
//     every success   10:27 – 21:14 IST
//     every failure   20:28 – 05:29 IST
//
// so the publisher's bot defence is tighter outside Indian peak hours. `--retry-delay 2` re-asks
// the same blocked runner IP two seconds later and is refused again, which is why the failing runs
// all took about seven seconds: three attempts, one outcome.
//
// A longer, JITTERED wait is worth the runner time — a 403 that is rate-shaped rather than
// IP-shaped can clear in a minute, and the alternative is losing the whole run. It is not worth
// much more than that: if the block is on the runner's address it will not clear at all, and the
// on-demand button (which a reader presses during Indian hours) is the path that does not depend
// on this. So: three attempts, ~20s then ~60s apart, and then an honest report.
const BLOCKED_BACKOFF_MS = [20_000, 60_000];
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const curlFetch = async (url, opts = {}) => {
  let res = await curlOnce(url, opts);
  for (let i = 0; !res.ok && res.status === 403 && i < BLOCKED_BACKOFF_MS.length; i++) {
    const wait = jitter(BLOCKED_BACKOFF_MS[i]);
    console.log(`\n  403 from the publisher — waiting ${Math.round(wait / 1000)}s and asking once more (${i + 1}/${BLOCKED_BACKOFF_MS.length})`);
    await sleep(wait);
    res = await curlOnce(url, opts);
  }
  return res;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/market-news.json');

const PAGES = Number(process.env.MCNEWS_PAGES || 4);
const FULL = process.env.MCNEWS_FULL === '1';
const DATE_LIMIT = process.env.MCNEWS_DATE_LIMIT === undefined ? 40 : Number(process.env.MCNEWS_DATE_LIMIT);
// HOW BIG THE HEAD IS — a ceiling on the bytes of the FIRST PAINT, and nothing else.
//
// Every visitor downloads this file on arrival and then revalidates it with a 304, so it stays
// bounded: ~600 stories is roughly 400 KB. What it is NOT any more is a ceiling on how much history
// exists — anything past it goes to the archive rather than to the bin. `MCNEWS_KEEP` is still
// honoured so an existing workflow or runbook keeps working.
const HEAD = Number(process.env.MCNEWS_HEAD || process.env.MCNEWS_KEEP || 600);
const RESHARD = process.env.MCNEWS_RESHARD === '1';
const DATE_CONCURRENCY = 4;

// ---------------------------------------------------------------------------------------
// THE ARCHIVE — one shard per month, and the month is the story's, not the run's
// ---------------------------------------------------------------------------------------

const ARCHIVE_DIR = resolve(__dirname, '../public/data/market-news');
const SHARD = /^(\d{4}-\d{2})\.json$/;

/**
 * Which shard a story is filed under.
 *
 * The publisher's own date wherever they gave one. Where they did not — 303 of the 600 stories in
 * the first capture, because the listing page carries no date and the per-article fetch is budgeted
 * — it falls back to when this scraper first saw the story. That is a fact about US, so the shard
 * says so in its own provenance rather than letting a reader take every date in it as the
 * publisher's. It is only ever used to decide which file a story lives in; the story's own
 * `publishedAt` stays null and still renders as "time not published".
 */
const monthOf = (a) => {
  const d = String(a?.publishedAt || a?.firstSeenAt || '');
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null;
};

function readShard(month) {
  const f = resolve(ARCHIVE_DIR, `${month}.json`);
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(j.articles) ? j.articles : [];
  } catch {
    // A shard that cannot be parsed is NOT treated as an empty month. Returning [] here would let
    // this run rewrite the file with only the stories it happens to be holding, which is the
    // discard this whole change exists to stop. Fail loudly instead.
    throw new Error(`archive shard ${month}.json exists but could not be parsed — refusing to overwrite it`);
  }
}

function writeShard(month, list) {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const rows = [...list].sort(byNewest);
  const dates = rows.map((a) => a.publishedAt || a.firstSeenAt).filter(Boolean).sort();
  const payload = {
    _provenance:
      'One month of market-wide stocks news as Moneycontrol published it. Headlines, standfirsts and section names are theirs, ' +
      'reproduced unchanged; the article stays on their site. A story is filed under this month by the publisher\'s own date where ' +
      'they gave one, and otherwise by the date this dashboard first saw it — so a story with `publishedAt: null` may sit one month ' +
      'later than it was published. Its own time is never invented: it stays null and renders as "time not published".',
    source: 'Moneycontrol — https://www.moneycontrol.com/news/business/stocks/',
    generator: 'scripts/scrape-mc-news.mjs',
    month,
    articleCount: rows.length,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    articles: rows,
  };
  writeFileSync(resolve(ARCHIVE_DIR, `${month}.json`), `${JSON.stringify(payload)}\n`);
  return payload;
}

/**
 * The manifest the browser walks to scroll past the head, newest month first.
 *
 * Read off the DIRECTORY rather than accumulated in memory, so a shard written by an earlier run —
 * or restored by hand — is listed by the next run without anything having to remember it.
 */
function archiveManifest(headKeys = new Set()) {
  if (!existsSync(ARCHIVE_DIR)) return [];
  return readdirSync(ARCHIVE_DIR)
    .map((f) => SHARD.exec(f))
    .filter(Boolean)
    .map(([file, month]) => {
      const j = JSON.parse(readFileSync(resolve(ARCHIVE_DIR, file), 'utf8'));
      const rows = Array.isArray(j.articles) ? j.articles : [];
      // HOW MUCH OF THIS MONTH THE HEAD ALREADY CARRIES, counted here because this is the only
      // place that holds both sets. Without it the browser cannot tell a month it already has in
      // full from one it has never seen, and the reader's first scroll to the end would download
      // every shard to discover it had learned nothing — 400 KB to add zero stories. The head is a
      // window onto the newest month or two, so on a young archive that is EVERY shard.
      const inHead = rows.reduce((n, a) => n + (headKeys.has(a.id || a.url) ? 1 : 0), 0);
      return {
        month,
        file: `market-news/${file}`,
        count: rows.length,
        inHead,
        from: j.from || null,
        to: j.to || null,
      };
    })
    .sort((a, b) => b.month.localeCompare(a.month));
}

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

  // RESHARD: re-file what is already committed, and ask the publisher nothing.
  //
  // Two jobs. It is how the archive was seeded from a head that predated it — the 600 stories in
  // that file were the only copy left and a network run was not available to produce them again —
  // and it is the repair path for a shard deleted or damaged by hand. It cannot invent history the
  // capture never held, so it is not a backfill; a deeper reach needs MCNEWS_FULL=1 with more pages.
  if (RESHARD) {
    // EVERYTHING ON DISK, head AND archive — not the head alone.
    //
    // The head is a WINDOW, so re-filing from it would rebuild the head out of the window and throw
    // the rest away: run it after any change that shrank the head and the archive's older months
    // stop being reachable from the head at all. Measured the hard way — a reshard after a test at
    // MCNEWS_HEAD=200 cut a 600-story head to 200 while all 600 sat safely in the shards beside it.
    // The repair path is the last thing that should be able to lose data.
    for (const m of archiveManifest()) {
      for (const a of readShard(m.month)) {
        const k = a.id || a.url;
        if (!known.has(k)) known.set(k, a);
      }
    }
    console.log(`Re-filing ${num(known.size)} committed stories (head + archive) — no request to the publisher.`);
    if (!known.size) {
      console.error('Neither the head nor the archive carries a story, so there is nothing to re-file. Refusing to write.');
      process.exit(1);
    }
    return finish({ existing, known, requests: 0, reachedKnown: false, capturedAt: existing.capturedAt || new Date().toISOString() });
  }

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

  return finish({ existing, known, requests, reachedKnown, capturedAt: now });
}

/** Everything downstream of "which stories do we hold" — shared by a scrape and by a reshard. */
function finish({ existing, known, requests, reachedKnown, capturedAt }) {
  const now = capturedAt;
  const all = [...known.values()].sort(byNewest);

  // FILE EVERY STORY BEFORE TRIMMING ANYTHING. The head below is a window onto this, not the set
  // of stories that survive — a story leaving the head has already been written to its month.
  const touched = new Map();
  let undatable = 0;
  for (const a of all) {
    const m = monthOf(a);
    if (!m) { undatable += 1; continue; }
    if (!touched.has(m)) touched.set(m, new Map(readShard(m).map((x) => [x.id || x.url, x])));
    touched.get(m).set(a.id || a.url, a);
  }
  for (const [month, rows] of touched) writeShard(month, [...rows.values()]);

  const kept = all.slice(0, HEAD);
  const withDate = kept.filter((a) => a.publishedAt).length;
  const archive = archiveManifest(new Set(kept.map((a) => a.id || a.url)));
  const archived = archive.reduce((n, s) => n + s.count, 0);

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
    keep: HEAD,
    // WHAT THE BROWSER WALKS TO SCROLL PAST THE HEAD, newest month first. Each entry is a file
    // under public/data/, so the client needs no directory listing and no second index request.
    archive,
    // Every story ever captured, across the head and the archive. This is the number the reader is
    // scrolling through; `articleCount` is only how many arrived in the first paint.
    archivedCount: archived,
    pagesRead: PAGES,
    listingRequests: requests,
    stoppedAtKnown: reachedKnown,
    articles: kept,
  };

  writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`  ${num(kept.length)} stories in the head (${num(withDate)} with the publisher's time) · newest id ${payload.newestId}`);
  console.log(`  ${num(archived)} in the archive across ${archive.length} month(s): ${archive.map((a) => `${a.month} ${num(a.count)}${a.inHead === a.count ? ' (all in head)' : ''}`).join(' · ') || 'none'}`);
  if (undatable) console.log(`  ${num(undatable)} story/stories carried no date at all and stayed in the head only`);
  console.log(`  wrote ${OUT}`);
}

main().catch((err) => {
  // TWO FAILURES THAT LOOK THE SAME IN A RUN LOG AND ARE NOT THE SAME PROBLEM.
  //
  //   403 on the listing   the publisher refused THIS RUNNER. Nothing here is broken; the
  //                        capture on disk is untouched and still correct. Measured at 7 of 12
  //                        scheduled runs, all of them outside Indian market hours.
  //   anything else        the markup changed, the network died, or this script has a bug — a
  //                        thing to go and look at.
  //
  // Reporting the first as a generic FAILED sends an operator to read a scraper that is working.
  // Exit 2 marks it so the workflow can say which it was without parsing the message.
  // `status` lives on `detail`, which is where McNewsError puts it — reading `err.status` here
  // would have been undefined and this branch would never have fired.
  // A REFUSAL WEARS TWO DIFFERENT COSTUMES AND NEITHER IS A BUG IN THIS CODE.
  //
  //   403 on the listing        the plain version
  //   200 with an interstitial  a body over 5 KB carrying no article links at all — measured, and
  //                             answered in 0.6 seconds, while curl elsewhere got the full 600 KB
  //
  // `assertShape` names the second one `blocked` for exactly that reason, so both land here.
  // Everything else — including a listing page that HAS article links but no `newslist` blocks —
  // is a real change to go and look at, and still exits 1.
  const blocked = err.reason === 'blocked' || (err.reason === 'upstream' && (err.detail?.status === 403 || err.status === 403));
  if (blocked) {
    console.error('\nBLOCKED: the publisher refused this runner. Nothing here is broken.');
    console.error('  The committed capture is unchanged and still correct — nothing was overwritten.');
    console.error('  Measured: 7 of 12 scheduled runs are refused, and every one of them fell outside');
    console.error('  Indian market hours (all successes 10:27-21:14 IST, all refusals 20:28-05:29 IST).');
    console.error(`  ${err.message}`);
    if (err.detail) console.error(' ', JSON.stringify(err.detail));
    process.exit(2);
  }
  console.error(`\nFAILED: ${err.reason ? `[${err.reason}] ` : ''}${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exit(1);
});
