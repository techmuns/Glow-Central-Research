// worker/mc-news.mjs — Moneycontrol's market-wide stocks news, read from their own listing page.
//
// WHY A WHOLE-MARKET FEED SITS BESIDE A PER-COMPANY ONE
//   The News tab's Portfolio scope searches one company at a time, because that is the only shape
//   the Muns news API has. Universe scope cannot work that way — 603 searches is ten minutes of
//   somebody else's service — so it asks a different question entirely: not "what has been written
//   about each of these companies" but "what has been published". Moneycontrol publish exactly that
//   at /news/business/stocks/, ten articles a page, paginated. Same move as the announcements feed:
//   when the per-entity route cannot cover the universe, look for the one indexed the other way.
//
// THERE IS NO PUBLISH TIME ON THE LISTING PAGE. Checked: not one element on it carries a date, a
// time or a timestamp class. The article's own page does — `"datePublished":"2026-08-28T22:27:59
// +05:30"` — so a date costs one extra request per ARTICLE, which is affordable only because the
// scheduled runs see a handful of new articles at a time.
//
//   • A story whose date we fetched carries `publishedAt`, the publisher's own time.
//   • A story whose date we did not fetch carries `publishedAt: null` and renders as an em dash.
//     It is NEVER given the time we happened to see it — `firstSeenAt` is a fact about US and is
//     kept in its own field, labelled as such, precisely so the two can never be confused.
//
// ORDERING IS THE PUBLISHER'S, NOT OURS. Every Moneycontrol article URL ends `-<id>.html` and the
// id increases with publication, so the id sorts the list correctly even for stories we have no
// date for. That is why it is also the merge key: it is the publisher's own identifier for the
// story, not a position in a list and not a hash of fields that could change.
//
// RSS IS NOT AN OPTION AND IT LOOKS LIKE ONE. moneycontrol.com/rss/*.xml still resolve with HTTP
// 200 and well-formed items — buzzingstocks.xml, marketreports.xml, latestnews.xml — and every one
// of them is abandoned: their newest item is from April 2024, and MCtopnews.xml's is from 2016. A
// 200 with valid XML is not a live feed. Do not "simplify" this module onto them.

const LIST_URL = 'https://www.moneycontrol.com/news/business/stocks/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

export class McNewsError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.reason = reason;
    this.detail = detail;
  }
}

/** Page 1 has no suffix; the rest are `/page-N/`. */
export const listUrl = (page = 1) => (page <= 1 ? LIST_URL : `${LIST_URL}page-${page}/`);

/** The numeric id Moneycontrol give every article, from its URL. Null when the URL has none. */
export function articleId(url) {
  const m = /-(\d{5,})\.html/.exec(String(url || ''));
  return m ? m[1] : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

/** Decode the entities a scraped headline actually contains. Numeric forms included. */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : m));
}

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Every article on one listing page.
 *
 * Read by SHAPE rather than by a brittle full-block regex: find each `<li id="newslist-N">`, then
 * pull the fields out of it. A markup change costs one field, not the page.
 */
export function parseList(html) {
  const out = [];
  const blocks = String(html || '').split(/<li[^>]*id="newslist-\d+"/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split('</li>')[0];
    const href = /<a[^>]*href="([^"]+)"/i.exec(block)?.[1] || null;
    if (!href || !/moneycontrol\.com\/news\//i.test(href)) continue;

    // The <h2> is the headline as displayed. Premium stories carry a crown <span> inside it, which
    // is a flag worth keeping and must not end up inside the title text.
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] || '';
    const premium = /isPremiumCrown/i.test(h2) || /isPremiumCrown/i.test(block);
    const title = stripTags(h2) || decodeEntities(/<a[^>]*title="([^"]*)"/i.exec(block)?.[1] || '');
    if (!title) continue;

    // First non-empty <p> is the standfirst; Moneycontrol emit a trailing empty one.
    const summary = ([...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).find(Boolean)) || null;
    const image = /data-src="([^"]+)"/i.exec(block)?.[1] || /<img[^>]*\ssrc="(https:[^"]+)"/i.exec(block)?.[1] || null;

    out.push({
      id: articleId(href),
      url: href,
      title,
      summary,
      image,
      premium,
      // Their section, taken from the URL path — /news/business/markets/… — rather than invented.
      section: (/moneycontrol\.com\/news\/business\/([^/]+)\//i.exec(href)?.[1] || null),
      publishedAt: null, // filled in by fetchPublishedAt, or left null. Never guessed.
    });
  }
  return out;
}

/**
 * A page that parsed to nothing is not an empty news day.
 *
 * Moneycontrol answer 200 with a full page for a section that has no more articles, and they would
 * answer 200 with a redirect or a shell if the path changed. So a run that finds no `newslist`
 * blocks at all on page 1 is the page having changed shape, and must fail loudly rather than commit
 * an empty file over a good one.
 */
export function assertShape(html, { url, page }) {
  const s = String(html || '');
  if (!s || s.length < 5000) throw new McNewsError('shape', `Moneycontrol returned ${s.length} bytes for ${url} — that is not the listing page.`, { url, page });
  if (page <= 1 && !/id="newslist-\d+"/i.test(s)) {
    throw new McNewsError('shape', 'Moneycontrol\'s listing page carried no `newslist` blocks — the markup has changed.', { url, page });
  }
  return s;
}

/** One article's own page, for the publisher's timestamp. The only per-article request made. */
export async function fetchPublishedAt(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: HEADERS });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /"datePublished"\s*:\s*"([^"]+)"/.exec(html);
  if (!m) return null;
  const t = Date.parse(m[1]);
  // An unparseable date stays null rather than becoming now.
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * `pages` listing pages of market news, newest first.
 *
 * `stopAtId` makes a scheduled run cheap: the list is in publication order, so once a known article
 * appears there is nothing older worth walking. It stops the walk, it does not filter the results —
 * a story that reappears higher up is still the same story and is deduped by id upstream.
 */
export async function fetchNews({ pages = 3, stopAtId = null }, { fetchImpl = fetch, gapMs = 400, onProgress = null } = {}) {
  const articles = [];
  const seen = new Set();
  let requests = 0;
  let stopped = false;

  for (let page = 1; page <= pages && !stopped; page++) {
    const url = listUrl(page);
    const res = await fetchImpl(url, { headers: HEADERS });
    requests++;
    if (!res.ok) {
      if (page === 1) throw new McNewsError('upstream', `Moneycontrol answered HTTP ${res.status} for ${url}.`, { url, status: res.status });
      break; // a deeper page failing is the end of the walk, not the end of the run
    }
    const html = assertShape(await res.text(), { url, page });
    const batch = parseList(html);
    if (!batch.length) break;
    for (const a of batch) {
      const key = a.id || a.url;
      if (seen.has(key)) continue;
      seen.add(key);
      if (stopAtId && a.id && a.id === stopAtId) {
        stopped = true;
        break;
      }
      articles.push(a);
    }
    if (onProgress) onProgress({ page, got: articles.length, requests });
    if (gapMs && page < pages && !stopped) await new Promise((r) => setTimeout(r, gapMs));
  }

  return { articles, requests, reachedKnown: stopped };
}
