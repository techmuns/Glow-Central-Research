// Exact full-history / selected-view equivalence using the shipped source captures. No egress.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve('public');
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
// Freeze one real run instant, and query the last completed IST day. This remains a
// meaningful news test as daily captures advance, rather than rejecting them as future data.
const now = Date.now();
Date.now = () => now;
const completedDay = new Date(now + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
globalThis.fetch = async input => {
  const path = String(input).split('?')[0];
  if (/^https?:/.test(path)) return new Response('{}', { status: 503 });
  const mapped = { 'api/earnings': 'data/earnings-live.json', 'api/concalls': 'data/concall-scans.json',
    'api/nse-announcements': 'data/nse-announcements.json', 'api/ipo-filings': 'data/ipo-filings.json' }[path] || path;
  assert(resolve(root, mapped).startsWith(root + '/'));
  try { return new Response(readFileSync(resolve(root, mapped)), { headers: { 'content-type': 'application/json' } }); }
  catch { return new Response('{}', { status: 404 }); }
};
const coverage = await import('../public/js/data/coverage.js');
coverage.prime(JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'))));
const alerts = await import('../public/js/data/daily-alerts.js');
const options = { scope: 'universe', day: completedDay, includeHistory: true };
const full = await alerts.collect(options);
assert(full.feeds.find(f => f.id === 'news').count > 0, 'the full-history oracle must actually load retained news');
console.log(JSON.stringify({ day: completedDay, full: full.events.length, news: full.feeds.find(f => f.id === 'news').count }));
const { inAlertQuery } = alerts;
for (const days of (process.env.NEWS_QUERY_DAYS || '1,3,14,30').split(',').map(Number)) {
  const queryWindow = { from: new Date(Date.parse(options.day) - (days-1)*86400000).toISOString().slice(0,10), to: options.day, includeUndated: false };
  const bounded = await alerts.collect({ ...options, queryWindow });
  const expected = full.events.filter(event => inAlertQuery(event, queryWindow));
  const actual = new Map(bounded.events.map(event => [event.id, event]));
  const missing = expected.filter(event => !actual.has(event.id));
  const ids = new Set(expected.map(event => event.id));
  const extra = bounded.events.filter(event => !ids.has(event.id));
  assert.deepEqual({ missing: missing.map(e=>({id:e.id,headline:e.headline,feed:e.feed})), extra: extra.map(e=>({id:e.id,headline:e.headline,feed:e.feed})) }, { missing: [], extra: [] }, `${days}-day identities`);
  for (const event of expected) {
    try { assert.deepEqual(actual.get(event.id), event, `${days}-day original fields/provenance: ${event.id}`); }
    catch(error) {
      console.log(JSON.stringify({queryWindow,feedCounts:bounded.feeds.map(f=>({id:f.id,count:f.count,status:f.status,note:f.note})),
        companions:bounded.sourceFeeds.flatMap(f=>f.events.filter(e=>e.url===event.url).map(e=>({feed:f.id,id:e.id,day:e.day,at:e.at}))),
        rawPublisher:(await import('../public/js/data/market-news.js')).rows().filter(r=>r.url===event.url).map(r=>({id:r.id,publishedAt:r.publishedAt}))}));
      throw error;
    }
  }
  console.log(`PASS ${days}-day query: ${expected.length} exact complete events`);
}
// Research owns its prepared shared source records independently of a mounted alert tab.
await alerts.prepareSources({ feedIds: ['news'] });
const { news } = await import('../public/js/data/filings.js');
const preparedNews = news.rows();
const off = alerts.onChange(() => {}); off();
assert.equal(news.rows(), preparedNews, 'leaving alerts must not invalidate a prepared research estate');
console.log('PASS bounded raw reading preserves canonical history, corrections, provenance and independent research ownership.');

// A RELEASED READER STARTS NO FURTHER READS. The archive walk is one sequential request per
// month, so a cancellation observed only after the walk lets a disposed tab go on fetching every
// remaining month — requests that start after destroy, are discarded on arrival, and hold
// connections the next view needs. Nothing throws, no count is wrong and no state is lost, which
// is why the browser suite could only catch it as a race it could not reproduce locally. Asserted
// here against the paths actually requested, so the guarantee is testable off a clock.
const { createNewsWorkingSet } = await import('../public/js/data/news-working-set.js');
const month = (file, url, day) => [file, { articles: [{ url, publishedAt: `${day}T00:00:00Z` }] }];
const captures = Object.fromEntries([
  ['data/news.json', { archive: { index: 'company-news/index.json' }, byTicker: { AAA: [{ url: 'https://example.test/head', publishedAt: '2026-08-02T00:00:00Z' }] } }],
  ['data/tradingview-news/latest.json', { archive: { index: 'tradingview-news/index.json' }, articles: [] }],
  ['data/company-news/index.json', { updatedAt: '2026-08-31T00:00:00Z', entities: [],
    archive: [{ file: 'company-news/2026-08.json', count: 1 }, { file: 'company-news/2026-07.json', count: 1 }] }],
  ['data/tradingview-news/index.json', { updatedAt: '2026-08-31T00:00:00Z', entities: [],
    archive: [{ file: 'tradingview-news/2026-08.json', count: 1 }, { file: 'tradingview-news/2026-07.json', count: 1 }] }],
  month('data/company-news/2026-08.json', 'https://example.test/c8', '2026-08-10'),
  month('data/company-news/2026-07.json', 'https://example.test/c7', '2026-07-10'),
  month('data/tradingview-news/2026-08.json', 'https://example.test/t8', '2026-08-11'),
  month('data/tradingview-news/2026-07.json', 'https://example.test/t7', '2026-07-11'),
]);
const held = 'data/company-news/2026-08.json';
const requested = [];
let openGate, atGate;
const gate = new Promise(resolve => { openGate = resolve; });
const reached = new Promise(resolve => { atGate = resolve; });
const workingSet = createNewsWorkingSet({
  window: () => null,
  read: async (path) => {
    requested.push(path);
    if (path === held) { atGate(); await gate; }
    if (!Object.hasOwn(captures, path)) throw Error(`Unexpected read: ${path}`);
    return { value: structuredClone(captures[path]), tag: path };
  },
  diskRead: async () => null,
  diskWrite: async () => {},
  fetcher: async () => { throw Error('this fixture has no sharded parts to fetch'); },
});
const walk = workingSet.prepare().then(() => 'completed', (error) => error.message);
await reached;
workingSet.release();
const duringWalk = requested.length;
openGate();
assert.equal(await walk, 'Obsolete news view', 'a released preparation is abandoned rather than adopted');
await new Promise(resolve => setTimeout(resolve, 50));
const after = requested.slice(duringWalk);
assert.deepEqual(after, [], `a released reader starts no further reads (started: ${after.join(', ') || 'none'})`);
assert(duringWalk < Object.keys(captures).length, 'the fixture must leave unread months for the walk to skip');
console.log(`PASS released news reader stops after ${duringWalk} reads instead of walking all ${Object.keys(captures).length} captures.`);
