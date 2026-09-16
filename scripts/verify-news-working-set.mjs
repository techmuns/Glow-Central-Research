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
