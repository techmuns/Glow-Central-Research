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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchNews, fetchPublishedAt, HEADERS } from '../worker/mc-news.mjs';
import { loadEverything, commit, keyOf, isMcId, HEAD_FILE } from './lib/news-store.mjs';

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

const num = (n) => Number(n).toLocaleString('en-IN');

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
  // EVERY story on disk, not just the head. A scraper that merged into the head alone would write
  // the head back as the whole capture and drop the other publishers' stories and the older months
  // with them — the discard this whole arrangement exists to end, arrived at from another side.
  const { head: existing, all: known } = loadEverything();
  const stopAtId = FULL ? null : existing.newestId;

  // RESHARD: re-file what is already committed, and ask the publisher nothing.
  //
  // Two jobs. It is how the archive was seeded from a head that predated it — those stories were
  // the only copy left and a network run was not available to produce them again — and it is the
  // repair path for a shard deleted or damaged by hand. It cannot invent history the capture never
  // held, so it is not a backfill; a deeper reach needs MCNEWS_FULL=1 with more pages.
  if (RESHARD) {
    // A story captured before this feed carried more than one publisher has no byline. A NUMERIC id
    // is by construction a Moneycontrol article number — nothing else in this capture has one — so
    // the attribution is derived rather than assumed, and a story whose id is not one is left alone
    // rather than being labelled with a guess.
    let named = 0;
    for (const a of known.values()) {
      if (!a.publisher && isMcId(a.id)) { a.publisher = 'Moneycontrol'; named += 1; }
    }
    console.log(`Re-filing ${num(known.size)} committed stories (head + archive) — no request to the publisher.`);
    if (named) console.log(`  ${num(named)} back-filled with their publisher, from the shape of their id`);
    if (!known.size) {
      console.error('Neither the head nor the archive carries a story, so there is nothing to re-file. Refusing to write.');
      process.exit(1);
    }
    return finish({ known, requests: 0, reachedKnown: false, capturedAt: existing.capturedAt || new Date().toISOString(), sources: [] });
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

  const fresh = articles.filter((a) => !known.has(keyOf(a)));
  console.log(`  ${num(articles.length)} read · ${num(fresh.length)} new · ${requests} listing request(s)${reachedKnown ? ' · stopped at a known story' : ''}`);

  const now = new Date().toISOString();
  for (const a of fresh) {
    a.firstSeenAt = now;
    // Named on every row, because this list carries several publishers now and a headline with no
    // byline in a mixed feed silently attributes itself to whichever one the reader assumes.
    a.publisher = 'Moneycontrol';
  }
  const dated = await datesFor(fresh, DATE_LIMIT);
  if (fresh.length) console.log(`  ${num(dated)} of ${num(Math.min(DATE_LIMIT, fresh.length))} dated from the article page`);

  // Merge: a story already held keeps its firstSeenAt and any date it already had.
  for (const a of fresh) known.set(keyOf(a), a);
  for (const a of articles) {
    const held = known.get(keyOf(a));
    if (held && !held.publishedAt && a.publishedAt) held.publishedAt = a.publishedAt;
  }

  return finish({
    known,
    requests,
    reachedKnown,
    capturedAt: now,
    sources: [{ id: 'moneycontrol', publisher: 'Moneycontrol', feeds: 1, url: 'https://www.moneycontrol.com/news/business/stocks/', capturedAt: now, ok: true, stories: fresh.length }],
  });
}

/** Everything downstream of "which stories do we hold" — shared by a scrape and by a reshard. */
function finish({ known, requests, reachedKnown, capturedAt, sources }) {
  const { kept, archive, archived, withDate, undatable, payload } = commit({
    articles: [...known.values()],
    capturedAt,
    head: HEAD,
    sources,
    extra: { pagesRead: PAGES, listingRequests: requests, stoppedAtKnown: reachedKnown },
  });

  console.log(`  ${num(kept.length)} stories in the head (${num(withDate)} with the publisher's time) · newest Moneycontrol id ${payload.newestId}`);
  console.log(`  ${num(archived)} in the archive across ${archive.length} month(s): ${archive.map((a) => `${a.month} ${num(a.count)}${a.inHead === a.count ? ' (all in head)' : ''}`).join(' · ') || 'none'}`);
  if (undatable) console.log(`  ${num(undatable)} story/stories carried no date at all and stayed in the head only`);
  console.log(`  wrote ${HEAD_FILE}`);
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
