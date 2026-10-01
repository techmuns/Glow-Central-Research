// FREE COMPANY NEWS. Google News answers a search as an RSS feed: no key and no per-query charge,
// unlike the paid Brave search behind fastapi.muns.io/tools/news-search, which cost the owner
// roughly $650 a month in September 2026. Measured on 30 portfolio companies over one week, Google
// returned about as many headlines that name the company as Brave did (575 against 584), and both
// covered 29 of the 30. The articles come back in the same normalised shape as `fetchNews`, so a
// caller switches providers without changing what it stores.
//
// It is an unofficial feed with no published quota. Callers pace their requests, and a 429 or 503
// is reported as `rate-limited` so a walk stops instead of hammering it.
//
// THE WEBSITE'S WORKER TRIES THREE TIMES. Google refuses most requests from Cloudflare's shared
// addresses: on 1 October 2026 it answered 8 of 24 searches from the deployed Worker, each refusal
// a 503 that took 5-10 s, while an answer took about a second. So the Worker gives each try a short
// deadline and asks again. The scheduled capture runs from GitHub, where Google answers normally,
// and keeps the default single try.

import { normaliseArticle } from '../public/js/data/filings-shared.js';
import { MunsError } from './muns.mjs';

const ENDPOINT = 'https://news.google.com/rss/search';
// India's edition for the portfolio search; the international edition stands in for the old
// unrestricted ("ALL") global search.
const EDITIONS = { IN: 'hl=en-IN&gl=IN&ceid=IN:en', ALL: 'hl=en-US&gl=US&ceid=US:en' };
/** Google answers at most about 100 items per search; a full page may have more behind it. */
export const GOOGLE_NEWS_LIMIT = 100;
const DEADLINE_MS = 20_000;
const MAX_BYTES = 3_000_000;
// A refusal, a slow answer or a dropped connection is worth another try; an error answer is not.
const RETRYABLE = new Set(['rate-limited', 'timeout', 'unreachable']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (value) => String(value || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all);
const tag = (xml, name) => {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1]).trim() : '';
};

/** Every `<item>` in a Google News RSS document, with the outlet split back off the headline. */
export function parseGoogleNewsRss(xml) {
  return String(xml || '').split(/<item[\s>]/).slice(1).map((item) => {
    const source = tag(item, 'source');
    const sourceUrl = decode((item.match(/<source[^>]*\burl="([^"]*)"/) || [])[1] || '') || null;
    let title = tag(item, 'title');
    // Google appends " - Outlet" to every headline; the outlet is already its own field.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    // No summary: Google's <description> only repeats the headline and the outlet as HTML.
    return { title, link: tag(item, 'link'), pubDate: tag(item, 'pubDate'), source, sourceUrl };
  }).filter((row) => row.title && /^https:\/\//.test(row.link));
}

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

/** The search address for one query and date window. `after:` is inclusive, `before:` exclusive. */
export function googleNewsUrl({ query, country = 'IN', fromDate = null, toDate = null }) {
  const window = [isDay(fromDate) ? `after:${fromDate}` : '', isDay(toDate) ? `before:${nextDay(toDate)}` : ''].filter(Boolean);
  const edition = EDITIONS[String(country || 'IN').toUpperCase() === 'ALL' ? 'ALL' : 'IN'];
  return `${ENDPOINT}?q=${encodeURIComponent([String(query).trim(), ...window].join(' '))}&${edition}`;
}

/** One request for the feed, abandoned after `deadlineMs`. */
async function readFeed(url, fetcher, deadlineMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  try {
    const res = await fetcher(url, { headers: { accept: 'application/rss+xml, application/xml;q=0.9', 'user-agent': 'Mozilla/5.0 (compatible; CentralResearch/1.0)' }, signal: abort.signal });
    if (!res.ok) {
      // Release the connection now: a retry should not wait behind an unread refusal.
      await res.body?.cancel().catch(() => {});
      if (res.status === 429 || res.status === 503) {
        throw new MunsError('rate-limited', `Google News is rate limiting this caller (HTTP ${res.status}).`, { status: res.status, url });
      }
      throw new MunsError('upstream', `Google News answered HTTP ${res.status}.`, { status: res.status, url });
    }
    return await res.text();
  } catch (err) {
    if (err instanceof MunsError) throw err;
    throw abort.signal.aborted
      ? new MunsError('timeout', `Google News did not answer within ${deadlineMs / 1000}s.`, { url })
      : new MunsError('unreachable', `Google News could not be reached: ${err?.message || err}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recent articles for a query from Google News, in `fetchNews`'s shape. `country` is `IN` (India's
 * edition) or `ALL` (the international edition). `truncated` says the page was full, so a caller
 * that partitions date ranges knows there may be more.
 *
 * `attempts` above 1 asks again after a refusal, a slow answer or a dropped connection, each try
 * with its own `attemptMs` deadline and a short pause between them. The default is one request.
 */
export async function fetchGoogleNews({ query, country = 'IN', fromDate = null, toDate = null },
  { fetcher = fetch, attempts = 1, attemptMs = DEADLINE_MS, pause = wait } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new MunsError('shape', 'A news search needs a query.');
  const url = googleNewsUrl({ query: q, country, fromDate, toDate });
  const tries = Math.max(1, Math.floor(Number(attempts)) || 1);
  let text;
  for (let attempt = 1; ; attempt++) {
    try {
      text = await readFeed(url, fetcher, attemptMs);
      break;
    } catch (err) {
      if (!RETRYABLE.has(err.reason)) throw err;
      if (attempt >= tries) {
        if (tries > 1) err.message = `${err.message} Tried ${tries} times.`;
        throw err;
      }
      await pause(150 + Math.floor(Math.random() * 250));
    }
  }
  if (text.length > MAX_BYTES) throw new MunsError('shape', 'Google News returned an unexpectedly large feed.', { url });
  if (!/<rss[\s>]/.test(text)) throw new MunsError('shape', 'Google News answered with something that is not RSS.', { url });
  const records = parseGoogleNewsRss(text);
  return {
    query: q,
    country: String(country || 'IN').toUpperCase() === 'ALL' ? 'ALL' : 'IN',
    provider: 'google-news',
    count: records.length,
    truncated: records.length >= GOOGLE_NEWS_LIMIT,
    articles: records.map((row) => normaliseArticle({ title: row.title, url: row.link, pubDate: row.pubDate, source: row.source }, q)),
    rawSample: null,
  };
}
