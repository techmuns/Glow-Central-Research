#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectBseAnnouncements, collectBseCompanyAnnouncements } from './lib/bse-collection.mjs';
import { checkBseAccess } from './check-bse-access.mjs';
import { BSE_MASTER_URL } from './lib/announcement-identities.mjs';
import { CATEGORIES } from '../worker/bse-ann.mjs';

const range = { from: '2026-09-01', to: '2026-09-01' };
const row = (id, category = 'Company Update') => ({ NEWSID: `filing-${id}`, SCRIP_CD: 522287,
  SLONGNAME: 'Kalpataru Projects International', HEADLINE: `Filing ${id}`, NEWSSUB: `Filing ${id}`,
  CATEGORYNAME: category, DissemDT: '2026-09-01T10:00:00', ATTACHMENTNAME: `${id}.pdf` });
const page = (rows, count = rows.length) => Response.json({ Table: rows, Table1: [{ ROWCNT: count }] });
const batch = (offset = 0) => Array.from({ length: 50 }, (_, i) => row(offset + i));
const opts = { gapMs: 0, retryDelayMs: 0 };

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
console.log('PASS BSE collection: bounded drift recovery, clean attempts, retained validation, truthful request counts and read-only host qualification.');
