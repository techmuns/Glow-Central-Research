// worker/rss-news.mjs — the shared RSS reader for the market-news feed's other publishers.
//
// Pure and dependency-free: `fetchImpl` is a parameter, exactly as worker/mc-news.mjs takes one, so
// the parser is testable offline and knows nothing about how its bytes were obtained. That matters
// here because HALF THESE PUBLISHERS CANNOT BE READ BY `fetch` AT ALL — see below.
//
// WHY RSS IS THE RIGHT ANSWER HERE AND WAS THE WRONG ONE FOR MONEYCONTROL.
//   CLAUDE.md says RSS "looks like the easy answer and is a trap", and that finding stands exactly
//   as written: moneycontrol.com/rss/*.xml resolve 200 with well-formed items whose newest entry is
//   from April 2024. The lesson was never "RSS is dead" — it was **a 200 with valid XML is not
//   evidence a feed is live, so check the newest item's date**. These four were checked the same
//   way and passed, measured 2026-09-03 at 17:07 IST:
//
//     Business Standard  markets / companies / latest   newest 16:49, 16:25, 17:03 the same day
//     Mint               markets / companies / money    newest 17:16 the same day
//     Economic Times     markets / industry / top       newest 17:04, 16:39, 12:08 the same day
//     Investing.com      most-popular financial news    newest 10:30 the same day
//
//   Re-run that check before adding a feed, and drop one whose newest item goes stale: a publisher
//   abandoning a feed does not take it down, they just stop writing to it, and nothing in the
//   response says so.
//
// TWO OF THE FOUR ARE THE MONEYCONTROL BLOCK AGAIN, WHICH DECIDES THE ARCHITECTURE.
//   Measured with node's `fetch` — which is what a Cloudflare Worker would use:
//
//     Business Standard   200, 190 KB, 98 items
//     Investing.com       200, 4.8 KB, 10 items
//     Mint                **403, 24-byte body**
//     Economic Times      **403, 24-byte body**
//
//   That 24-byte 403 is byte-for-byte the signature www.moneycontrol.com gives, and `curl` with a
//   browser user-agent gets all four at 200 — so it is TLS/HTTP2 fingerprinting again, not headers,
//   and no header set fixes it. A GitHub Action shelling out to curl is the only reader that works
//   for all four, which is why these feeds are a committed capture like the Moneycontrol one and
//   NOT a Worker route. Do not add one; it will 403 on two of the four and look like a bug.
//
// NOTHING IS SUMMARISED, SCORED OR RANKED. Headlines and standfirsts are the publisher's,
// reproduced unchanged, and every row links to their own page.

export class RssNewsError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const HEADERS = {
  'user-agent': UA,
  accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// ---------------------------------------------------------------------------------------
// THE FEEDS
// ---------------------------------------------------------------------------------------
//
// `id` is what a story is filed under and what the reader filters by, so it is stable and short.
// `section` is OURS, not the publisher's: these are separate URLs on their side rather than a field
// in the payload, so the section is a fact about which feed a story came from. It is kept in its
// own field and never presented as something the publisher tagged the story with.
//
// A feed is added here and nowhere else. `scripts/scrape-rss-news.mjs` walks this list.

export const FEEDS = [
  { id: 'business-standard', publisher: 'Business Standard', section: 'markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { id: 'business-standard', publisher: 'Business Standard', section: 'companies', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { id: 'business-standard', publisher: 'Business Standard', section: 'latest', url: 'https://www.business-standard.com/rss/latest.rss' },
  { id: 'mint', publisher: 'Mint', section: 'markets', url: 'https://www.livemint.com/rss/markets' },
  { id: 'mint', publisher: 'Mint', section: 'companies', url: 'https://www.livemint.com/rss/companies' },
  { id: 'mint', publisher: 'Mint', section: 'money', url: 'https://www.livemint.com/rss/money' },
  { id: 'economic-times', publisher: 'Economic Times', section: 'markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { id: 'economic-times', publisher: 'Economic Times', section: 'industry', url: 'https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms' },
  { id: 'economic-times', publisher: 'Economic Times', section: 'top', url: 'https://economictimes.indiatimes.com/rssfeedstopstories.cms' },
  { id: 'investing', publisher: 'Investing.com', section: 'markets', url: 'https://in.investing.com/rss/news_285.rss' },
  { id: 'investing', publisher: 'Investing.com', section: 'commodities', url: 'https://in.investing.com/rss/commodities.rss' },
  { id: 'investing', publisher: 'Investing.com', section: 'economy', url: 'https://in.investing.com/rss/market_overview.rss' },
];

// ---------------------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------------------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#\d+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? NAMED[n] ?? m);
}

/**
 * One element's text, CDATA unwrapped.
 *
 * READ BY SHAPE, NEVER BY ONE GUESSED SPELLING — the filings rule, and it earns its keep here:
 * Business Standard sends `<link>` bare, Mint wraps every field including `<pubDate>` in CDATA, and
 * Economic Times puts a trailing space inside the CDATA. All three are valid RSS. A parser written
 * against whichever one was opened first breaks on the other two, silently, by returning null and
 * letting the row render as a story with no date.
 */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return null;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
  const out = decodeEntities(raw).replace(/<[^>]+>/g, '').trim();
  return out || null;
}

/** An attribute off the first matching element, for the several ways a feed attaches an image. */
function tagAttr(xml, tag, attr) {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["']`, 'i').exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * The story's own image, whichever of the three ways this publisher attaches one.
 *
 * `media:thumbnail` before `media:content` before `enclosure`: Business Standard sends a thumbnail
 * nested inside the content element and the thumbnail is the smaller file, which is what a 110px
 * card wants. Only http(s) is ever returned — this is external content deciding what the page loads.
 */
export function imageFrom(xml) {
  const url =
    tagAttr(xml, 'media:thumbnail', 'url') ||
    tagAttr(xml, 'media:content', 'url') ||
    tagAttr(xml, 'enclosure', 'url') ||
    tagAttr(xml, 'image', 'url');
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * The publisher's time, as an ISO string, or null.
 *
 * NULL IS A REAL ANSWER AND IS NEVER FILLED IN. A date that cannot be parsed does not become now,
 * and it does not become the time we read the feed — that is `firstSeenAt`, a fact about this
 * scraper, and it lives in its own field so the two can never be confused. Same rule the
 * Moneycontrol capture follows for the stories its date budget did not reach.
 */
export function publishedAtFrom(xml) {
  const raw = (tagText(xml, 'pubDate') || tagText(xml, 'dc:date') || tagText(xml, 'published') || tagText(xml, 'updated') || '').trim();
  if (!raw) return null;

  // THE ZONE-LESS FORM IS TESTED FIRST, AND IT HAS TO BE.
  //
  // Investing.com sends `2026-09-03 09:06:08` with no zone at all. `Date.parse` does not reject
  // that — it reads it as the RUNNER'S local time, which on a CI container is UTC, so it succeeds
  // and returns a timestamp five and a half hours late. A `Date.parse`-first version of this
  // function therefore never reached the fallback below, and the only symptom was every story on
  // that feed sorting into the wrong place in a merged list. Measured: 09:06:08 came back as
  // 09:06:08Z where the publisher meant 03:36:08Z.
  //
  // It is an Indian edition publishing on IST, so a zone-less stamp is read as IST.
  const bare = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (bare) {
    const [, y, mo, d, h, mi, se] = bare;
    const ist = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se || '00'}+05:30`);
    return Number.isFinite(ist) ? new Date(ist).toISOString() : null;
  }

  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * A stable id for a story.
 *
 * DERIVED FROM CONTENT, NEVER FROM A POSITION — the rule that broke the News table once already
 * (CLAUDE.md, *Performance on large tables*): an index in a key makes one key mean two different
 * rows the moment the list grows. The publisher's own `<guid>` is used where they send one that is
 * not simply the link again; otherwise the canonical URL is the identity, which is what it is.
 *
 * Prefixed with the feed id so two publishers running the same wire story stay two rows under two
 * bylines rather than one silently overwriting the other.
 */
export function storyId(feedId, { guid, link }) {
  const g = guid && guid !== link ? guid : link;
  return `${feedId}:${String(g || '').replace(/^https?:\/\//i, '').slice(0, 180)}`;
}

/** Every `<item>` in one feed document. */
export function parseFeed(xml, feed) {
  const out = [];
  for (const m of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    const link = tagText(it, 'link');
    const title = tagText(it, 'title');
    if (!link || !/^https?:\/\//i.test(link) || !title) continue;
    out.push({
      id: storyId(feed.id, { guid: tagText(it, 'guid'), link }),
      url: link,
      title,
      summary: tagText(it, 'description'),
      image: imageFrom(it),
      premium: false,
      publisher: feed.publisher,
      // OURS, from which feed URL this came, not a tag the publisher put on the story.
      section: feed.section,
      publishedAt: publishedAtFrom(it),
    });
  }
  return out;
}

/**
 * A document that parsed to nothing is not a quiet news day.
 *
 * The Moneycontrol lesson, applied before it can cost anything here: a 200 that is not the feed you
 * asked for is not evidence about that feed. A refusal wearing a 200 (an interstitial, a login wall)
 * carries no `<item>` and no `<rss`/`<feed` root; a genuine feed that has been emptied carries the
 * root and no items. Those are different problems for different people, so they are different
 * errors — `blocked` is somebody else's server saying no, `shape` is ours to go and look at.
 */
export function assertShape(xml, { url, status = 200 } = {}) {
  const s = String(xml || '');
  const bytes = s.length;
  const items = (s.match(/<item(?:\s|>)/gi) || []).length;
  if (items > 0) return items;
  const isFeed = /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(s);
  if (!isFeed) {
    throw new RssNewsError('blocked', `${url} answered ${status} with ${bytes} bytes that are not an RSS document — a refusal, not an empty feed.`, { url, status, bytes, items });
  }
  throw new RssNewsError('shape', `${url} is a well-formed feed carrying zero items in ${bytes} bytes — the publisher has emptied or restructured it.`, { url, status, bytes, items });
}

/**
 * Read one feed. Never throws for a single feed's sake — the caller walks a dozen of them and one
 * publisher having a bad afternoon must not cost the other eleven.
 */
export async function fetchFeed(feed, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(feed.url, { headers: HEADERS });
    const body = await res.text();
    if (!res.ok) {
      return { feed, ok: false, reason: res.status === 403 || res.status === 429 ? 'blocked' : 'upstream', status: res.status, bytes: body.length, stories: [] };
    }
    assertShape(body, { url: feed.url, status: res.status });
    return { feed, ok: true, status: res.status, bytes: body.length, stories: parseFeed(body, feed) };
  } catch (err) {
    return { feed, ok: false, reason: err?.reason || 'unreachable', status: err?.detail?.status || 0, bytes: err?.detail?.bytes || 0, message: String(err?.message || err), stories: [] };
  }
}

/** Every configured feed, in order, with a courtesy gap between requests. */
export async function fetchAll(feeds = FEEDS, { fetchImpl = fetch, gapMs = 300, onProgress = null } = {}) {
  const results = [];
  for (const feed of feeds) {
    const r = await fetchFeed(feed, { fetchImpl });
    results.push(r);
    onProgress?.(r);
    if (gapMs) await new Promise((res) => setTimeout(res, gapMs));
  }
  return results;
}
