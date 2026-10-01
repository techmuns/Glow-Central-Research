#!/usr/bin/env node
// Free company-news sources: Google News search and Upstox News. Fixtures only; no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import worker from '../worker/index.js';
import { fetchGoogleNews, googleNewsUrl, parseGoogleNewsRss, GOOGLE_NEWS_LIMIT } from '../worker/free-news.mjs';
import { fetchUpstoxNews, upstoxArticle, upstoxInstrumentKeys, UPSTOX_KEYS_PER_REQUEST } from './lib/upstox-news.mjs';
import { portfolioNewsEntities } from '../public/js/data/company-news-identity.js';
import { enrichCompanyNews } from './enrich-company-news.mjs';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { commitCompanyNewsArchive, companyNewsArchiveRows } from './lib/company-news-archive.mjs';

const rss = (items) => '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Search - Google News</title>' +
  items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.pubDate}</pubDate>` +
    `<description>&lt;a href="${i.link}"&gt;${i.title}&lt;/a&gt;</description><source url="${i.sourceUrl}">${i.source}</source></item>`).join('') +
  '</channel></rss>';
const story = (n, extra = {}) => ({ title: `Coforge story ${n} - Moneycontrol.com`, link: `https://news.google.com/rss/articles/CBMi${n}?oc=5`,
  pubDate: 'Wed, 01 Oct 2026 07:14:50 GMT', source: 'Moneycontrol.com', sourceUrl: 'https://www.moneycontrol.com', ...extra });

// Parsing: the outlet comes off the headline, entities decode once, and unusable items are dropped.
const parsed = parseGoogleNewsRss(rss([
  story(1, { title: 'Sterlite Technologies bags $1.2 bn order &amp; more - Moneycontrol.com' }),
  story(2, { title: '<![CDATA[Coforge &#39;wins&#39; deal]]> - Moneycontrol.com' }),
  story(3, { link: 'http://insecure.example/story' }),
]));
assert.equal(parsed.length, 2, 'items without an https link are dropped');
assert.equal(parsed[0].title, 'Sterlite Technologies bags $1.2 bn order & more');
assert.equal(parsed[0].source, 'Moneycontrol.com');
assert.equal(parsed[0].sourceUrl, 'https://www.moneycontrol.com');
assert.equal(parsed[1].title, "Coforge 'wins' deal");

// Search addresses: India's edition by default, the international edition for ALL, exact days.
const india = new URL(googleNewsUrl({ query: 'Coforge Limited', fromDate: '2026-09-29', toDate: '2026-10-01' }));
assert.equal(india.searchParams.get('q'), 'Coforge Limited after:2026-09-29 before:2026-10-02', 'before: is exclusive, so it is the next day');
assert.equal(india.searchParams.get('gl'), 'IN');
assert.equal(new URL(googleNewsUrl({ query: 'Coforge', country: 'ALL' })).searchParams.get('gl'), 'US');
assert.equal(new URL(googleNewsUrl({ query: 'Coforge', fromDate: 'not-a-day' })).searchParams.get('q'), 'Coforge');

// Fetching: the normalised shape every caller already stores, and named failures.
const feed = (body, init = {}) => async () => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml' }, ...init });
const found = await fetchGoogleNews({ query: 'Coforge', fromDate: '2026-09-29', toDate: '2026-10-01' }, { fetcher: feed(rss([story(1)])) });
assert.equal(found.count, 1);
assert.equal(found.truncated, false);
assert.equal(found.provider, 'google-news');
assert.deepEqual({ title: found.articles[0].title, source: found.articles[0].source, url: found.articles[0].url, date: found.articles[0].date,
  publishedAt: found.articles[0].publishedAt, query: found.articles[0].query },
{ title: 'Coforge story 1', source: 'Moneycontrol.com', url: 'https://news.google.com/rss/articles/CBMi1?oc=5', date: '2026-10-01',
  publishedAt: '2026-10-01T07:14:50.000Z', query: 'Coforge' });
const full = await fetchGoogleNews({ query: 'Coforge' }, { fetcher: feed(rss(Array.from({ length: GOOGLE_NEWS_LIMIT }, (_, i) => story(i)))) });
assert.equal(full.truncated, true, 'a full page says there may be more');
const reason = async (fetcher, query = 'Coforge') => {
  try { await fetchGoogleNews({ query }, { fetcher }); } catch (err) { return err.reason; }
  return 'no error';
};
assert.equal(await reason(feed('', { status: 429 })), 'rate-limited');
assert.equal(await reason(feed('', { status: 503 })), 'rate-limited');
assert.equal(await reason(feed('', { status: 500 })), 'upstream');
assert.equal(await reason(feed('<html>consent page</html>')), 'shape');
assert.equal(await reason(async () => { throw Error('offline'); }), 'unreachable');
assert.equal(await reason(feed(rss([])), '  '), 'shape');

// The Worker route: with NEWS_PROVIDER=google it never calls the paid Muns news API.
const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
const cache = new Map(), pending = [], seen = [];
globalThis.caches = { default: { match: async (key) => cache.get(key.url)?.clone(),
  put: async (key, response) => { cache.set(key.url, response.clone()); } } };
globalThis.fetch = async (input) => {
  const url = String(input?.url || input);
  seen.push(url);
  if (url.startsWith('https://news.google.com/rss/search')) return new Response(rss([story(1)]), { headers: { 'content-type': 'application/rss+xml' } });
  throw Error(`unexpected request ${url}`);
};
try {
  const route = async (query) => {
    const response = await worker.fetch(new Request(`https://fixture.test/api/news?${query}`), { NEWS_PROVIDER: 'google' },
      { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending.splice(0));
    return response.json();
  };
  const body = await route('q=Coforge&from=2026-09-29&to=2026-10-01');
  assert.equal(body.ok, true);
  assert.equal(body.country, 'IN');
  assert.equal(body.articles[0].source, 'Moneycontrol.com');
  const global = await route('q=Coforge&country=ALL');
  assert.equal(global.country, 'ALL');
  assert.equal(new URL(seen.at(-1)).searchParams.get('gl'), 'US');
  assert(seen.every((url) => url.startsWith('https://news.google.com/')), 'no paid search request');
} finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }

// Upstox: instrument keys from active ISINs, batches of 30, pages, and a failed batch kept apart.
assert.deepEqual(upstoxInstrumentKeys({ ticker: 'JAYNECOIND', portfolioIsins: ['INE854B01010', 'bad'] }), ['NSE_EQ|INE854B01010']);
assert.deepEqual(upstoxInstrumentKeys({ ticker: '504375', portfolioIsins: ['INE000A01011'] }), ['BSE_EQ|INE000A01011']);
assert.deepEqual(upstoxInstrumentKeys({ ticker: null, portfolioIsins: ['INE000000001'] }), ['BSE_EQ|INE000000001']);
assert.equal(upstoxArticle({ heading: 'No link', article_link: 'http://insecure.example' }), null);
assert.deepEqual(upstoxArticle({ heading: ' Result ', summary: 'Profit rose', article_link: 'https://upstox.com/news/a/', published_time: 1759302000000 }),
  { title: 'Result', url: 'https://upstox.com/news/a/', summary: 'Profit rose', publishedAt: '2025-10-01T07:00:00.000Z', date: '2025-10-01',
    source: 'upstox.com', discoverySource: 'upstox-news' });
const many = Array.from({ length: UPSTOX_KEYS_PER_REQUEST + 1 }, (_, i) => ({ entityId: `e${i}`, ticker: `T${i}`,
  portfolioIsins: [`INE${String(i).padStart(9, '0')}`] }));
const upstoxRequests = [];
const upstox = await fetchUpstoxNews({ entities: many, token: 'fixture-token', fetcher: async (input, init) => {
  const url = new URL(input);
  upstoxRequests.push({ keys: url.searchParams.get('instrument_keys').split(','), page: Number(url.searchParams.get('page_number')), auth: init.headers.authorization });
  if (upstoxRequests.at(-1).keys.length === 1) return Response.json({ status: 'error', errors: [{ errorCode: 'UDAPI1193' }] }, { status: 400 });
  const page = Number(url.searchParams.get('page_number'));
  return Response.json({ status: 'success', data: { 'NSE_EQ|INE000000000': [{ heading: `Story ${page}`, article_link: `https://upstox.com/news/${page}/`, published_time: 1759302000000 }],
    'NSE_EQ|INE999999999': [{ heading: 'Not ours', article_link: 'https://upstox.com/news/x/' }] }, metadata: { page: { page_number: page, total_pages: 2 } } });
} });
assert.equal(upstoxRequests[0].keys.length, UPSTOX_KEYS_PER_REQUEST, 'thirty instrument keys per request');
assert(upstoxRequests.every((request) => request.auth === 'Bearer fixture-token'));
assert.equal(upstox.requests, 3, 'two pages of the first batch, then the failed second batch');
assert.deepEqual(upstox.rows.map(({ entity, row }) => [entity.entityId, row.title]), [['e0', 'Story 1'], ['e0', 'Story 2']], 'unrequested keys are ignored');
assert.equal(upstox.errors.length, 1);
assert.equal(upstox.errors[0].error, 'UDAPI1193');

// The real enrichment pipeline with both free sources, in disposable files.
const scratch = mkdtempSync(join(tmpdir(), 'free-news-enrichment-test-'));
try {
  const dir = join(scratch, 'company-news');
  const [entity] = portfolioNewsEntities([{ ticker: 'COFORGE', name: 'Coforge', isin: 'INE591G01017' }]);
  commitCompanyNewsArchive({ dir, entities: [entity], articles: [{ entityId: entity.entityId, ticker: entity.ticker,
    title: 'Old archive', date: '2026-06-01', url: 'https://example.test/old' }] });
  writeJson(join(scratch, 'news.json'), { byTicker: {}, capturedAt: '2026-10-01T00:00:00Z', empty: [] });
  let googleStatus = 200;
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'news.google.com') {
      assert.equal(url.searchParams.get('gl'), 'US', 'the global search uses the international edition');
      return googleStatus === 200 ? new Response(rss([story(7)]), { headers: { 'content-type': 'application/rss+xml' } }) : new Response('', { status: googleStatus });
    }
    if (url.hostname === 'api.upstox.com') {
      assert.equal(init.headers.authorization, 'Bearer fixture-token');
      return Response.json({ status: 'success', data: { [`NSE_EQ|${entity.portfolioIsins[0]}`]: [{ heading: 'Coforge order win',
        article_link: 'https://upstox.com/news/coforge/', published_time: Date.parse('2026-10-01T06:00:00Z') }] }, metadata: { page: { total_pages: 1 } } });
    }
    throw Error(`unexpected request ${url}`);
  };
  const now = Date.parse('2026-10-01T07:00:00Z');
  const options = { dataDir: scratch, fetcher, now, gapMs: 0, provider: 'google', upstoxToken: 'fixture-token' };
  const coverage = await enrichCompanyNews(options);
  assert.equal(coverage.provider, 'google-news');
  assert.deepEqual({ configured: coverage.upstox.configured, articles: coverage.upstox.articles, failedRequests: coverage.upstox.failedRequests },
    { configured: true, articles: 1, failedRequests: 0 });
  assert(coverage.completedQueries >= 1);
  const rows = companyNewsArchiveRows(dir);
  assert(rows.some((row) => row.discoverySource === 'upstox-news' && row.title === 'Coforge order win'));
  assert(rows.some((row) => row.discoverySource === 'global-news-search' && row.url.startsWith('https://news.google.com/')));
  assert(rows.some((row) => row.url === 'https://example.test/old'), 'retained history is kept');

  googleStatus = 429;
  calls.length = 0;
  const limited = await enrichCompanyNews({ ...options, now: now + 26 * 3600000, upstoxToken: null });
  assert.equal(calls.filter((host) => host === 'news.google.com').length, 1, 'a rate limit stops the walk after one refused read');
  assert.equal(limited.upstox.configured, false, 'no token: Upstox is skipped and says so');
  assert(!calls.includes('api.upstox.com'));
  assert(companyNewsArchiveRows(dir).length >= rows.length, 'a refused read never retracts articles');
  assert.equal(readJson(join(dir, 'discovery.json')).coverage.provider, 'google-news');
} finally { rmSync(scratch, { recursive: true, force: true }); }

console.log('PASS free company news: Google News parsing, editions, date windows, named failures, the Worker route without paid search, Upstox batches and pages, and the enrichment pipeline with both sources.');
