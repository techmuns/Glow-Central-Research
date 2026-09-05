#!/usr/bin/env node
// scripts/scrape-rss-news.mjs — the market-news feed's other publishers, read from their own RSS.
//
//   node scripts/scrape-rss-news.mjs               read every configured feed and merge
//   RSS_ONLY=mint,economic-times node scripts/…    just these publishers
//   RSS_HEAD=600 node scripts/…                    how many stories the head file carries
//
// Merges into the SAME capture the Moneycontrol walk writes — public/data/market-news.json plus the
// monthly shards beside it — through scripts/lib/news-store.mjs. It never replaces: a run of this
// script must not be able to delete Moneycontrol's stories, and a run of that one must not be able
// to delete these.
//
// WHY THIS IS A COMMITTED CAPTURE AND NOT A WORKER ROUTE.
//   Two of the four publishers cannot be read by `fetch` at all. Measured with node's fetch, which
//   is what a Cloudflare Worker uses: Business Standard 200/190 KB, Investing.com 200/4.8 KB, Mint
//   **403 with a 24-byte body**, Economic Times **403 with a 24-byte body**. That 24-byte 403 is
//   the same signature www.moneycontrol.com gives, and `curl` with a browser user-agent gets all
//   four at 200 — TLS/HTTP2 fingerprinting, which no header set fixes. So this shells out to curl
//   on a normal runner, exactly as the Moneycontrol scrape does, and worker/rss-news.mjs stays pure
//   with `fetchImpl` as a parameter so the parser is testable offline.
//
// A PUBLISHER HAVING A BAD AFTERNOON COSTS ONLY THAT PUBLISHER. Each feed is read independently and
// a failure is recorded against its own source entry rather than failing the run — twelve feeds
// behind one exit code would mean one refusal throwing away eleven good reads. The run only fails
// when EVERY feed failed, which is a fact about us or the network rather than about a publisher.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FEEDS, fetchAll, HEADERS } from '../worker/rss-news.mjs';
import { loadEverything, commit, keyOf, HEAD_FILE } from './lib/news-store.mjs';

const execFileP = promisify(execFile);

const HEAD = Number(process.env.RSS_HEAD || process.env.MCNEWS_HEAD || 600);
const ONLY = (process.env.RSS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const GAP_MS = Number(process.env.RSS_GAP_MS || 300);

const num = (n) => Number(n).toLocaleString('en-IN');

/**
 * curl, for the same reason the Moneycontrol scrape uses it — see the header.
 *
 * Returns a Response-alike so worker/rss-news.mjs neither knows nor cares. A non-zero curl exit is
 * reported as status 0 rather than thrown, because the caller treats one dead feed as one dead feed.
 */
async function curlFetch(url, { headers = {} } = {}) {
  const args = ['-sS', '--compressed', '--max-time', '45', '-w', '\\n%{http_code}'];
  for (const [k, v] of Object.entries({ ...HEADERS, ...headers })) args.push('-H', `${k}: ${v}`);
  args.push(url);
  try {
    const { stdout } = await execFileP('curl', args, { maxBuffer: 64 * 1024 * 1024 });
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1).trim()) || 0;
    const body = stdout.slice(0, Math.max(0, cut));
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  } catch (err) {
    const out = String(err?.stdout || '');
    const cut = out.lastIndexOf('\n');
    const status = cut >= 0 ? Number(out.slice(cut + 1).trim()) || 0 : 0;
    return { ok: false, status, text: async () => (cut >= 0 ? out.slice(0, cut) : '') };
  }
}

async function main() {
  const feeds = ONLY.length ? FEEDS.filter((f) => ONLY.includes(f.id)) : FEEDS;
  if (!feeds.length) {
    console.error(`RSS_ONLY=${process.env.RSS_ONLY} matched no configured feed. Known ids: ${[...new Set(FEEDS.map((f) => f.id))].join(', ')}`);
    process.exit(1);
  }

  const publishers = [...new Set(feeds.map((f) => f.publisher))];
  console.log(`RSS market news — ${feeds.length} feed(s) across ${publishers.length} publisher(s): ${publishers.join(', ')}`);

  const results = await fetchAll(feeds, {
    fetchImpl: curlFetch,
    gapMs: GAP_MS,
    onProgress: (r) =>
      console.log(
        `  ${r.feed.publisher} / ${r.feed.section}  ${r.ok ? `${String(r.stories.length).padStart(3)} stories` : `FAILED (${r.reason}${r.status ? ` ${r.status}` : ''})`}`,
      ),
  });

  // EVERY feed failing is a fact about us; one failing is a fact about that publisher. Only the
  // first is a reason to refuse to write — refusing on the second would let one refusal throw away
  // eleven good reads and leave the capture older than it needed to be.
  if (results.every((r) => !r.ok)) {
    console.error(`\nAll ${results.length} feed(s) failed. Refusing to write — the committed capture is unchanged and still correct.`);
    for (const r of results) console.error(`  ${r.feed.publisher}/${r.feed.section}: ${r.reason} ${r.status || ''} ${r.message || ''}`);
    process.exit(2);
  }

  const { all: known } = loadEverything();
  const now = new Date().toISOString();

  let added = 0;
  let refreshed = 0;
  for (const r of results) {
    for (const story of r.stories) {
      const k = keyOf(story);
      const held = known.get(k);
      if (!held) {
        known.set(k, { ...story, firstSeenAt: now });
        added += 1;
      } else if (!held.publishedAt && story.publishedAt) {
        // The publisher put a time on it since we last looked. Take it — but never overwrite one we
        // already have, because a feed re-dating a story on edit would silently move it in the list.
        held.publishedAt = story.publishedAt;
        refreshed += 1;
      }
    }
  }

  // Per PUBLISHER, not per feed: the reader's filter and the provenance panel are about publishers,
  // and three Business Standard sections that all worked is one working publisher. A publisher is
  // `ok` when any of its feeds answered — one dead section is not a dead masthead.
  const sources = [...new Set(results.map((r) => r.feed.id))].map((id) => {
    const mine = results.filter((r) => r.feed.id === id);
    const good = mine.filter((r) => r.ok);
    return {
      id,
      publisher: mine[0].feed.publisher,
      feeds: mine.length,
      feedsOk: good.length,
      url: mine[0].feed.url,
      capturedAt: now,
      ok: good.length > 0,
      stories: good.reduce((n, r) => n + r.stories.length, 0),
      ...(good.length === mine.length ? {} : { reason: mine.find((r) => !r.ok)?.reason || 'unreachable' }),
    };
  });

  const { kept, archive, archived, withDate, undatable } = commit({
    articles: [...known.values()],
    capturedAt: now,
    head: HEAD,
    sources,
  });

  console.log(`\n  ${num(added)} new · ${num(refreshed)} gained the publisher's time · ${num(kept.length)} in the head (${num(withDate)} dated)`);
  console.log(`  ${num(archived)} in the archive across ${archive.length} month(s): ${archive.map((a) => `${a.month} ${num(a.count)}`).join(' · ') || 'none'}`);
  if (undatable) console.log(`  ${num(undatable)} story/stories carried no date at all and stayed in the head only`);
  console.log(`  wrote ${HEAD_FILE}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err?.reason ? `[${err.reason}] ` : ''}${err?.message || err}`);
  if (err?.detail) console.error(err.detail);
  process.exit(1);
});
