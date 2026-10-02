#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createFeed } from '../public/js/data/filings.js';
import { mergeAnnouncements, mergeAnnouncementsAsync } from '../public/js/data/announcements-shared.js';
import { createCorporateAnnouncementsFeed } from '../public/js/data/corporate-announcements.js';
import { mapSteps, runStepsInSlices } from '../public/js/core/slices.js';
import { announcementSearch, prepareAnnouncementSearch } from '../public/js/ui/announcement-search.js';

const rows = Array.from({ length: 24000 }, (_, i) => ({ ticker: `ISSUER${i % 200}`,
  date: `2026-09-${String(i % 28 + 1).padStart(2, '0')}`, time: '10:00:00',
  title: `Original filing ${i}`, category: 'Company Update', source: 'BSE',
  url: `https://example.test/filing-${i}.pdf`, newsId: `filing-${i}`, extra: { value: i } }));
const anonymous = { ticker: 'ISSUER0', date: null, title: 'Unlinked original notice', source: 'NSE' };
const supplement = [
  { ...rows[0], source: 'NSE', providers: ['Additional capture'], summary: 'Retained source detail' },
  { ...rows[100], url: 'https://example.test/correction.pdf', revision: 2, time: '11:00:00' },
  anonymous, { ...anonymous },
  { ticker: 'OLD', date: '2018-01-01', title: 'Offscreen historical filing', url: 'https://example.test/old.pdf', source: 'DRHP' },
];
const before = JSON.stringify([rows, supplement]);
const reference = mergeAnnouncements(rows, supplement);
let yields = 0;
const sliced = await mergeAnnouncementsAsync([rows, supplement], { sliceMs: 0,
  yieldForInput: async () => { yields++; } });
assert(yields > 100, 'large preparation offers input opportunities throughout the complete merge');
assert.deepEqual(sliced, reference, 'all fields, provenance, duplicates, dates and order equal the synchronous result');
assert.equal(JSON.stringify([rows, supplement]), before, 'preparation never mutates source records');
assert.equal(sliced.filter(r => r.title === anonymous.title).length, 2, 'distinct unlinked occurrences survive');
assert(sliced.some(r => r.date === '2018-01-01'), 'older offscreen history survives');
assert(sliced.find(r => r.newsId === rows[0].newsId).sourceUrls.some(link => link.source === 'NSE'));
assert.equal(sliced.find(r => r.newsId === rows[100].newsId).revision, 2);
assert.deepEqual(await runStepsInSlices(mapSteps(sliced, r => JSON.stringify(r)), { sliceMs: 0, yieldForInput: async () => {} }),
  sliced.map(r => JSON.stringify(r)), 'chunked publication checks every complete record');

const snapshot = { capturedAt: '2026-09-28T10:00:00Z', coversUniverse: true, byTicker: { ISSUER0: [rows[0]] } };
const base = createFeed('announcements', { read: async () => ({ value: snapshot }), allowColdStart: false });
await base.load([{ ticker: 'ISSUER0', name: 'Original scope label' }]);
const first = base.rows();
base.setWanted([{ ticker: 'ISSUER0', name: 'Another scope label' }, { ticker: 'ISSUER0' }]);
assert.equal(base.rows(), first, 'scope changes cannot invalidate unchanged announcement projections');
assert.deepEqual(base.rows()[0].extra, rows[0].extra);

let current = rows.slice(0, 3000), nse = [];
const stream = createCorporateAnnouncementsFeed({
  base: { rows: () => current, meta: () => ({}), onChange: () => () => {}, loadArchive: async () => {},
    load: async () => {}, refreshSnapshot: async () => {} },
  nse: { retainedRows: () => nse, meta: () => ({}), onChange: () => () => {}, loadHistory: async () => {},
    load: async () => {}, refresh: async () => {} },
  readIdentities: async () => ({ value: { version: 1, entries: [], capturedAt: snapshot.capturedAt } }),
  readNseIdentities: async () => ({ value: { version: 1, directories: { sme: { entries: [] }, equity: { entries: [] } } } }),
});
await stream.prepareRows();
const held = stream.rows();
await stream.prepareRows();
assert.equal(stream.rows(), held, 'unchanged preparation preserves the displayed reading objects');
current = [...current, rows[3000]];
const preparing = stream.prepareRows();
// A new source publication arrives while preparation is yielding.
queueMicrotask(() => { current = [...current, rows[3001]]; });
await preparing;
assert.equal(stream.rows().length, 3002, 'new arrivals cannot be lost to an older unfinished preparation');
current = [];
await stream.prepareRows();
assert.equal(stream.rows().length, 3002, 'an empty/failed current input cannot retract retained history');
assert.equal(stream.forTicker('ISSUER0').length, 16, 'offscreen company search still sees the complete retained stream');

let textReads = 0;
const searchable = row => { textReads++; return row.title; };
const searchOptions = { companies: [], companyKey: row => row.ticker,
  resolveCompany: row => row, allowsCompany: () => true, scopeLabel: 'Universe',
  searchable };
const search = announcementSearch(searchOptions);
const searchableRow = { ticker: 'ISSUER0', title: 'Café — new order' };
search.prepare(searchableRow);
assert(search.matches(searchableRow, 'cafe new order'), 'idle preparation uses the actual company-search normalization');
assert(!search.matches(searchableRow, 'unrelated'));
assert.equal(textReads, 1, 'the first keystroke reuses the prepared index');
assert(search.matches({ ...searchableRow, title: 'Corrected order' }, 'corrected'), 'replacement records build a fresh search entry');
yields = 0;
await prepareAnnouncementSearch(rows, searchable, { sliceMs: 0, yieldForInput: async () => { yields++; } });
assert(yields > 100, 'full-archive type/text preparation yields before table filtering');
const preparedReads = textReads;
const returnedSearch = announcementSearch(searchOptions);
assert(returnedSearch.matches(rows.at(-1), rows.at(-1).title), 'a return can search the archive tail immediately');
assert.equal(textReads, preparedReads, 'returning table instances reuse the prepared immutable rows');
assert(!announcementSearch({ ...searchOptions, searchable: () => 'Different reading' }).matches(rows[0], rows[0].title),
  'a different search reader cannot inherit another reader’s text');
let cancelledReads = 0;
await prepareAnnouncementSearch(rows, () => { cancelledReads++; return ''; }, {
  sliceMs: 0, yieldForInput: async () => {}, keepGoing: () => false });
assert.equal(cancelledReads, 128, 'leaving the view stops unfinished preparation at the next slice');

// All Alerts shares the announcement reader. Reading a cold archive synchronously here models
// the multi-second merge that can land after the reader has already switched away from filings.
const { announcements } = await import('../public/js/data/filings.js');
const { collect, prepareSources } = await import('../public/js/data/daily-alerts.js');
const original = { rows: announcements.rows, meta: announcements.meta,
  seed: announcements.seed, prepareRows: announcements.prepareRows, onChange: announcements.onChange };
let prepared = false, preparations = 0, publication = rows;
const sourceListeners = [];
let onMeta = null;
try {
  announcements.onChange = fn => { sourceListeners.push(fn); return () => {}; };
  announcements.rows = () => {
    assert(prepared, 'the shared archive must be prepared before a synchronous alert read');
    return publication;
  };
  announcements.meta = () => {
    assert(prepared, 'metadata must not synchronously merge a newly seeded archive');
    onMeta?.();
    return { capturedAt: '2026-09-04T13:00:00Z' };
  };
  announcements.seed = async () => { prepared = false; };
  announcements.prepareRows = async () => {
    preparations++;
    // A correction/new filing arrives during the first preparation's input opportunity.
    if (preparations === 2) publication = [...rows, { ...rows[0] },
      { ...rows[0], title: 'Corrected filing with the same source ID' },
      { ...rows[0], newsId: 'undated-arrival', title: 'Undated new filing', date: null }];
    prepared = true;
  };
  const report = await collect({ load: false, holdings: [], day: '2026-09-30', includeHistory: true });
  assert(report.events.some(event => event.headline === 'Undated new filing'),
    'All Alerts prepares cold announcements and includes arrivals during that preparation');
  const announcementFeed = report.feeds.find(feed => feed.id === 'announcements');
  assert.equal(announcementFeed.count, rows.length + 2, 'sliced normalization removes only exact duplicates');
  assert.equal(announcementFeed.oldestDay, '2026-09-01');
  assert.equal(announcementFeed.newestDay, '2026-09-28');
  assert.equal(announcementFeed.events.filter(event => event.headline === rows[0].title).length, 1);
  assert(announcementFeed.events.some(event => event.headline === 'Corrected filing with the same source ID'),
    'independent source content sharing an ID survives normalization');
  const loaded = await prepareSources({ feedIds: ['announcements'] });
  assert.equal(loaded[0].status, 'fulfilled', 'loading prepares announcement rows before reading their metadata');
  const clock = performance.now;
  let elapsed = 0;
  try {
    // Make every batch offer an input opportunity, independent of the test machine's speed.
    performance.now = () => elapsed += 13;
    onMeta = () => {
      onMeta = null;
      queueMicrotask(() => {
        publication = [...publication, { ...rows[1], newsId: 'new-revision', title: 'Arrived during normalization' }];
        for (const listener of sourceListeners) listener();
      });
    };
    await collect({ load: false, holdings: [], day: '2026-09-29', includeHistory: true });
    const latest = await collect({ load: false, holdings: [], day: '2026-09-29', includeHistory: true });
    assert(latest.events.some(event => event.headline === 'Arrived during normalization'),
      'a sliced read cannot cache its older source snapshot after an in-flight invalidation');
  } finally { performance.now = clock; }
} finally { Object.assign(announcements, original); }
console.log('PASS announcement preparation: complete merge parity, bounded batches, stable scopes, concurrent arrivals and failure retention');
