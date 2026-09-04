import assert from 'node:assert/strict';
import { createCorporateAnnouncementsFeed, nseAnnouncement, LIVE_ID, POLL_MS } from '../public/js/data/corporate-announcements.js';

const nseRow = { ticker: 'TEST', company: 'Test Company', subject: 'Board meeting', publishedAt: '2026-09-03T20:00:00Z', url: 'https://example.test/nse.pdf' };
const mapped = nseAnnouncement(nseRow);
assert.equal(mapped.date, '2026-09-04');
assert.equal(mapped.time, '01:30:00');
assert.equal(nseAnnouncement({ ...nseRow, publishedAt: null }).date, null);
assert.equal(nseAnnouncement({ ...nseRow, url: 'javascript:alert(1)' }).url, null);

let bse = [{ ticker: 'TEST', title: 'BSE filing', date: '2026-09-03', url: 'https://example.test/bse.pdf', source: 'BSE' }, { ...mapped, providers: ['Muns corporate announcements'] }];
let nse = [nseRow], failNse = false, baseReads = 0, nseReads = 0, release;
const archiveReady = new Promise((done) => { release = done; });
const subscribers = new Set();
const base = {
  rows: () => bse, meta: () => ({ kind: 'announcements', reason: null }), isLoaded: () => true,
  load: async () => { baseReads++; }, refreshSnapshot: async () => { baseReads++; },
  onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
  async loadArchive(options) {
    assert.equal(options.onlyChanged, true);
    await archiveReady;
    bse = [...bse, { ticker: 'OTHER', title: 'Older history', date: '2025-01-01', url: 'https://example.test/old.pdf', source: 'DRHP' }];
  },
};
const live = {
  retainedRows: () => nse, meta: () => ({ capturedAt: '2026-09-04T00:00:00Z' }),
  load: async () => { nseReads++; }, refresh: async () => { nseReads++; if (failNse) throw new Error('Offline'); },
  loadHistory: async (days, options) => { assert.equal(days, 90); assert.equal(options.updateWindow, false); },
  onChange: () => () => {},
};
const feed = createCorporateAnnouncementsFeed({ base, nse: live });
let arrivals = 0;
const off = feed.onChange(() => { arrivals++; });
const loading = feed.load([]);
assert.equal(feed.refresh(), loading, 'load and refresh share one in-flight read');
await new Promise((done) => setImmediate(done));
assert(arrivals > 0, 'newest records are published before history finishes');
assert.equal(feed.rows().length, 2, 'the same NSE document from Muns and RSS appears once');
assert.deepEqual(feed.rows()[0].providers, ['Muns corporate announcements', 'NSE announcements RSS']);
await loading;
await feed.refresh();
assert.equal(baseReads, 2, 'live updates do not wait for a slow archive download');
release(); await feed.loadArchive();
assert.equal(feed.rows().length, 3);
assert.equal(baseReads, 2); assert.equal(nseReads, 2);
bse = []; nse = [{ ...nseRow, subject: 'New filing', publishedAt: '2026-09-04T11:00:00Z', url: 'https://example.test/new.pdf' }];
await feed.refresh();
assert.equal(feed.rows()[0].title, 'New filing');
assert.equal(feed.rows().length, 4, 'rollover never erases previously observed filings');
failNse = true; nse = [];
await feed.refresh();
assert.equal(feed.rows().length, 4, 'source failure retains the whole stream');
assert.equal(feed.meta().nse.error, 'Offline');
assert.equal(feed.forTicker('test').length, 3);
const calls = [];
const engine = { register: (id, config) => calls.push([id, config.intervalMs]), start: (id) => calls.push(['start', id]), stop: (id) => calls.push(['stop', id]) };
feed.startLive(engine); feed.stopLive(engine);
assert.deepEqual(calls, [[LIVE_ID, POLL_MS], ['start', LIVE_ID], ['stop', LIVE_ID]]);
off(); assert.equal(subscribers.size, 0);
console.log('PASS corporate stream: IST dates, safe links, deduplication, automatic history, live arrivals, retention, coalescing and poll lifecycle');
