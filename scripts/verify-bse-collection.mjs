#!/usr/bin/env node
import assert from 'node:assert/strict';
import { bseIndiaDay, bseCollectionWindows, bseCaptureCoverage, bseLastCompleteTo, collectBseAnnouncements, collectBseCompanyAnnouncements } from './lib/bse-collection.mjs';
import { checkBseAccess } from './check-bse-access.mjs';
import { BSE_MASTER_URL } from './lib/announcement-identities.mjs';
import { CATEGORIES } from '../worker/bse-ann.mjs';
import { assessFilingsHealth } from '../public/js/data/filings-health-shared.js';
import { createFeed } from '../public/js/data/filings.js';

const range = { from: '2026-09-01', to: '2026-09-01' };
const row = (id, category = 'Company Update') => ({ NEWSID: `filing-${id}`, SCRIP_CD: 522287,
  SLONGNAME: 'Kalpataru Projects International', HEADLINE: `Filing ${id}`, NEWSSUB: `Filing ${id}`,
  CATEGORYNAME: category, DissemDT: '2026-09-01T10:00:00', ATTACHMENTNAME: `${id}.pdf` });
const page = (rows, count = rows.length) => Response.json({ Table: rows, Table1: [{ ROWCNT: count }] });
const batch = (offset = 0) => Array.from({ length: 50 }, (_, i) => row(offset + i));
const opts = { gapMs: 0, retryDelayMs: 0 };

assert.equal(bseIndiaDay(Date.parse('2026-09-27T18:29:59Z')), '2026-09-27');
assert.equal(bseIndiaDay(Date.parse('2026-09-27T18:30:00Z')), '2026-09-28', 'collection dates turn over at Indian midnight');

assert.deepEqual(bseCollectionWindows({ from: '2026-08-30', to: '2026-09-01' }, '2026-09-01'),
  [{ from: '2026-08-30', to: '2026-08-31' }, { from: '2026-09-01', to: '2026-09-01' }]);
assert.deepEqual(bseCollectionWindows(range, '2026-09-01'), [range], 'today alone needs no historical read');
assert.deepEqual(bseCollectionWindows(range, '2026-09-02'), [range], 'a closed interval stays one walk');
assert.throws(() => bseCollectionWindows({ from: '2026-09-02', to: '2026-09-01' }, '2026-09-01'), /ordered, valid/);
assert.throws(() => bseCollectionWindows({ from: '2026-02-30', to: '2026-09-01' }, '2026-09-01'), /ordered, valid/);

for (const collect of [
  options => collectBseAnnouncements({ from: '2026-08-31', to: '2026-09-01', categories: ['Company Update'] }, options),
  options => collectBseCompanyAnnouncements({ from: '2026-08-31', to: '2026-09-01', scripCode: '522287' }, options),
]) {
  const dates = [];
  let liveAttempt = 0;
  const result = await collect({ ...opts, today: '2026-09-01', fetchImpl: async url => {
    const params = new URL(url).searchParams;
    const from = params.get('strPrevDate'), to = params.get('strToDate'), number = params.get('pageno');
    dates.push([from, to, number]);
    if (to === '20260831') return page([{ ...row(900), DissemDT: '2026-08-31T10:00:00' }]);
    if (number === '1') { liveAttempt++; return page(batch(liveAttempt === 1 ? 1000 : 0), 51); }
    return page([row(50)], liveAttempt === 1 ? 52 : 51);
  } });
  assert.deepEqual(dates, [['20260831', '20260831', '1'], ['20260901', '20260901', '1'],
    ['20260901', '20260901', '2'], ['20260901', '20260901', '1'], ['20260901', '20260901', '2']],
  'live drift never restarts the already validated history');
  assert.equal(result.rows.length, 52); assert.equal(result.requests, 5);
  const counts = result.byCategory?.['Company Update'] || result;
  assert.equal(counts.declared, 52); assert.equal(counts.collected, 52); assert.equal(counts.pages, 3);
  assert.equal(result.rows.filter(item => item.newsId === 'filing-900').length, 1);
  assert(!result.rows.some(item => item.newsId === 'filing-1000'));

  await assert.rejects(() => collect({ ...opts, today: '2026-09-01', fetchImpl: async url => {
    const closed = new URL(url).searchParams.get('strToDate') === '20260831';
    return page([{ ...row(900), DissemDT: closed ? '2026-08-31T10:00:00' : '2026-09-01T10:00:00' }]);
  } }), /repeated an announcement across capture windows/, 'moving a NEWSID between windows cannot inflate completeness');

  let reads = 0;
  await assert.rejects(() => collect({ ...opts, today: '2026-09-01', fetchImpl: async url => {
    reads++;
    const params = new URL(url).searchParams;
    if (params.get('strToDate') === '20260831') return page([{ ...row(900), DissemDT: '2026-08-31T10:00:00' }]);
    return params.get('pageno') === '1' ? page(batch(), 51) : page([row(50)], 52);
  } }), /changed the declared count/, 'successful historical rows cannot turn a failed live window into a complete result');
  assert.equal(reads, 7, 'one historical read plus three bounded live attempts');
}

// Busy live windows retain validated observations while every closed category establishes its
// own contiguous watermark. The capture remains visibly failed until a later complete read.
const partialDates = [];
let partialAttempt = 0;
const partialCapture = await collectBseAnnouncements({ from: '2026-08-31', to: '2026-09-01', categories: ['Company Update', 'Others'] }, {
  ...opts, today: '2026-09-01', allowPartial: true, fetchImpl: async url => {
    const params = new URL(url).searchParams, to = params.get('strToDate'), category = params.get('strCat');
    partialDates.push([to, category]);
    if (to === '20260831') return page([{ ...row(category === 'Others' ? 901 : 900, category), DissemDT: '2026-08-31T10:00:00' }]);
    if (category === 'Others') return page([row(902, 'Others')]);
    if (params.get('pageno') === '1') { partialAttempt++; return page(batch(partialAttempt * 1000), 51); }
    return page([row(50)], 52);
  },
});
assert.deepEqual(partialDates.slice(0, 2), [['20260831', 'Company Update'], ['20260831', 'Others']], 'all historical categories finish before any live read');
assert.equal(partialCapture.completeTo, '2026-08-31');
assert.equal(partialCapture.failedWindows.length, 1);
assert.equal(partialCapture.rows.length, 153, 'validated pages from all failed live attempts and other categories survive');
assert.equal(partialCapture.requests, 9);
assert.equal(partialCapture.byCategory['Company Update'].declared, null, 'an unstable result cannot advertise a complete declared count');
assert.equal(partialCapture.rows.filter(item => item.newsId === 'filing-50').length, 0, 'the unvalidated changed-count page is excluded');
const partialCoverage = bseCaptureCoverage(partialCapture, { lastCompleteTo: '2026-08-30' });
assert.equal(partialCoverage.lastCompleteTo, '2026-08-31');
assert.equal(partialCoverage.coversUniverse, false);
assert(partialCoverage.failed['BSE collection']);
assert.equal(bseLastCompleteTo({ to: '2026-09-01', ...partialCoverage, lastCompleteTo: null }), null,
  'a failed capture with no complete watermark must not fall back to its requested end date');
assert.equal(bseLastCompleteTo({ to: '2026-08-31', shortfall: [], failed: [] }), '2026-08-31', 'legacy complete captures keep their recovery date');

let snapshot = { byTicker: { KPIL: partialCapture.rows }, rowCount: partialCapture.rows.length,
  capturedAt: new Date(Date.now() - 1000).toISOString(), ...partialCoverage };
const health = assessFilingsHealth({ announcements: snapshot }, { sources: ['announcements'] });
assert.equal(health.ok, false);
assert(health.findings.some(finding => finding.code === 'source-read-failed'));
const reader = createFeed('announcements', { read: async () => ({ value: snapshot }), allowColdStart: false });
await reader.seed();
assert.equal(reader.rows().length, 153, 'the existing dashboard reader exposes verified partial records');
assert.equal(reader.meta().failed, 1, 'fresh rows cannot hide the source failure');
assert.equal(reader.meta().coversUniverse, false);
const recoveredCoverage = bseCaptureCoverage({ ...partialCapture, completeTo: '2026-09-01', failedWindows: [] }, snapshot);
snapshot = { ...snapshot, ...recoveredCoverage, capturedAt: new Date().toISOString() };
await reader.refreshSnapshot();
assert.equal(reader.meta().failed, 0, 'a later verified capture clears the previous source failure');
assert.equal(reader.rows().length, 153, 'previously captured partial records remain visible after recovery');
reader.dispose();

const historicalFailure = await collectBseAnnouncements({ from: '2026-08-31', to: '2026-09-01', categories: ['Company Update'] }, {
  ...opts, today: '2026-09-01', allowPartial: true, fetchImpl: async url => new URL(url).searchParams.get('strToDate') === '20260831'
    ? new Response('Denied', { status: 403 }) : page([row(1)]),
});
assert.equal(historicalFailure.completeTo, null, 'a successful live day cannot jump over an unverified historical interval');
assert.equal(historicalFailure.rows.length, 1);
assert.equal(historicalFailure.requests, 2, 'access denial is recorded once, without retries');
assert.equal(bseCaptureCoverage(historicalFailure, { lastCompleteTo: '2026-08-30' }).lastCompleteTo, '2026-08-30');

const invalidPage = await collectBseAnnouncements({ ...range, categories: ['Company Update'] }, {
  ...opts, allowPartial: true, fetchImpl: async () => page([row(1), row(2, 'Others')]),
});
assert.equal(invalidPage.rows.length, 0, 'a page with an invalid row exposes none of that page through the retention callback');
assert.equal(invalidPage.failedWindows.length, 1);
assert.equal(invalidPage.completeTo, null);

// A completed category is not fetched again, and an abandoned attempt contributes no rows.
const calls = [], retries = [];
let attempt = 0;
const captured = await collectBseAnnouncements({ ...range, categories: ['Others', 'Company Update'] }, {
  ...opts, onRetry: event => retries.push(event.nextAttempt), fetchImpl: async url => {
    const params = new URL(url).searchParams, category = params.get('strCat'), number = Number(params.get('pageno'));
    calls.push([category, number]);
    if (category === 'Others') return page([row(900, 'Others')]);
    if (number === 1) { attempt++; return page(batch(attempt === 1 ? 1000 : 0), 51); }
    return page([row(50)], attempt === 1 ? 52 : 51);
  },
});
assert.deepEqual(calls, [['Others', 1], ['Company Update', 1], ['Company Update', 2], ['Company Update', 1], ['Company Update', 2]]);
assert.deepEqual(retries, [2]);
assert.equal(captured.rows.length, 52);
assert(!captured.rows.some(item => item.newsId === 'filing-1000'));
assert.equal(captured.requests, 5);
assert.deepEqual(captured.byCategory['Company Update'], { declared: 51, collected: 51, pages: 2 });

let companyCalls = 0, companyAttempt = 0;
const company = await collectBseCompanyAnnouncements({ ...range, scripCode: '522287' }, {
  ...opts, fetchImpl: async url => {
    companyCalls++;
    if (new URL(url).searchParams.get('pageno') === '1') {
      companyAttempt++; return page(batch(companyAttempt < 3 ? 1000 : 0), 51);
    }
    return page([row(50)], companyAttempt < 3 ? 52 : 51);
  },
});
assert.equal(company.requests, 6); assert.equal(companyCalls, 6);
assert.equal(company.pages, 2); assert.equal(company.collected, 51);
assert(!company.rows.some(item => item.newsId === 'filing-1000'));

for (const collect of [
  options => collectBseAnnouncements({ ...range, categories: ['Company Update'] }, options),
  options => collectBseCompanyAnnouncements({ ...range, scripCode: '522287' }, options),
]) {
  let reads = 0;
  await assert.rejects(() => collect({ ...opts, fetchImpl: async url => {
    reads++;
    return new URL(url).searchParams.get('pageno') === '1' ? page(batch(), 51) : page([row(50)], 52);
  } }), /changed the declared count/);
  assert.equal(reads, 6, 'persistent instability exhausts exactly three attempts');

  for (const [response, message] of [
    [() => new Response('Denied', { status: 403 }), /HTTP 403/],
    [() => Response.json('No Record Found!'), /rather than a result set/],
    [() => page([row(1), row(1)]), /repeated an announcement/],
    [() => page([row(1)], 60), /before its declared count/],
  ]) {
    reads = 0;
    await assert.rejects(() => collect({ ...opts, fetchImpl: async () => { reads++; return response(); } }), message);
    assert.equal(reads, 1, 'access denial and invalid results must not trigger retry traffic');
  }
  await assert.rejects(() => collect({ ...opts, attempts: 4 }), /1–3 attempts/);
}

const master = Array.from({ length: 1000 }, (_, i) => ({ SCRIP_CD: 522287 + i,
  Status: ['Active', 'Suspended', 'Delisted'][i % 3], ISIN_NUMBER: 'INE220B01022', Scrip_Name: `Issuer ${i}` }));
const probeCalls = [];
const probeFetch = async url => {
  probeCalls.push(url);
  if (url === BSE_MASTER_URL) return Response.json(master);
  const params = new URL(url).searchParams;
  if (params.get('strScrip')) return params.get('pageno') === '1' ? page(batch(), 51) : page([row(50)], 51);
  return page([row(1, params.get('strCat'))]);
};
const probeOptions = { to: '2026-09-01', now: Date.parse('2026-09-02T06:00:00Z'), gapMs: 0,
  previousIdentities: { entries: [{ bseCode: '522287' }] }, fetchImpl: probeFetch };
const probe = await checkBseAccess(probeOptions);
assert.equal(probe.ok, true); assert.equal(probe.directoryRows, 1000);
assert.equal(probe.exchange.configuredCategories, CATEGORIES.length);
assert.equal(probe.exchange.rows, 10); assert.equal(probe.company.pages, 2);
assert.equal(probeCalls.length, 13);
for (const to of ['2026-09-02', '2026-02-30', 'invalid']) {
  await assert.rejects(() => checkBseAccess({ ...probeOptions, to }), /completed calendar day/);
}
await assert.rejects(() => checkBseAccess({ ...probeOptions, fetchImpl: async () => new Response('Denied', { status: 403 }) }), /HTTP 403/);
await assert.rejects(() => checkBseAccess({ ...probeOptions, fetchImpl: async url => url === BSE_MASTER_URL
  ? Response.json(master) : page([]) }), /no exchange records/);
await assert.rejects(() => checkBseAccess({ ...probeOptions, fetchImpl: async url =>
  url !== BSE_MASTER_URL && new URL(url).searchParams.get('strScrip') ? page([row(1)]) : probeFetch(url)
}), /multi-page company access/);
console.log('PASS BSE collection: closed-history recovery, bounded live drift, verified partial retention, honest reader/health status, request counts and read-only host qualification.');
