#!/usr/bin/env node
// Synthetic contract fixtures only. No upstream sync, backfill or authenticated production calls.
import assert from 'node:assert/strict';
import { handleDrhpFilings } from '../worker/drhp-filings.mjs';
import { normaliseDrhpFilings, validateDrhpCompany } from '../public/js/data/drhp-shared.js';
import worker from '../worker/index.js';

let checks = 0;
const check = async (label, fn) => { await fn(); console.log(`PASS ${label}`); checks++; };
const company = 'Example Alternative Asset Advisors Limited';
const sample = [{ symbol: null, company_name: company, form_type: 'DRHP', filing_date: '2026-09-03', source: 'IND', documents: [
  { title: 'Draft prospectus', url: 'https://example.test/draft.pdf' },
  { name: 'Addendum', document_url: 'https://example.test/addendum.pdf' },
] }];
const request = (name = company, headers = {}, extra = {}) => new Request('https://dashboard.example/api/drhp-filings', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer fixture.reader.session', ...headers }, body: JSON.stringify({ company: name }), ...extra });

await check('exact names and tickers do not require membership in the listed universe', () => {
  for (const value of ['PAYTM', company, 'A & B (India) Limited', "O’Connor & Sons", 'भारत लिमिटेड']) assert.equal(validateDrhpCompany(value), value);
  assert.equal(validateDrhpCompany('  PAYTM  '), 'PAYTM');
});
await check('path injection and every published sync/admin path are blocked', () => {
  for (const value of ['', null, {}, 'a'.repeat(201), '.', '..', '../sync_us', 'sync_us', 'SYNC_US', 'sync_all', 'sync', 'sync_indian', 'sync/tickers', 'PAYTM?x=y', '%73ync_us', 'A/B', 'A\\B', 'PAYTM\nInjected: yes', 'https://evil.test']) assert.throws(() => validateDrhpCompany(value));
});
await check('nested documents preserve filing metadata and issuers without a symbol', () => {
  const result = normaliseDrhpFilings(sample);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].company, company); assert.equal(result.rows[0].symbol, null);
  assert.equal(result.rows[0].date, '2026-09-03'); assert.equal(result.rows[0].source, 'IND'); assert.equal(result.rows[0].form, 'DRHP');
  assert.equal(result.rows[0].documents.length, 2); assert.equal(result.rows[0].documents[1].label, 'Addendum');
  assert.equal(result.rows[0].isRead, undefined); assert.equal(result.rows[0].ipoDate, undefined);
});
await check('duplicate document links dedupe only within their filing and unsafe links are flagged', () => {
  const result = normaliseDrhpFilings([{ ...sample[0], documents: [...sample[0].documents, 'https://example.test/draft.pdf', { url: 'javascript:alert(1)' }, { url: 'https://user:secret@example.test/a' }, { other: true }] }, { ...sample[0], filing_date: '2026-09-02' }]);
  assert.equal(result.rows.length, 2); assert.equal(result.rows[0].documents.length, 2); assert.equal(result.rows[0].documents[0].label, 'Draft prospectus');
  assert.equal(result.unmappedDocuments, 3); assert.equal(result.rows[1].documents.length, 2);
});
await check('unknown fields, missing documents and invalid dates are never fabricated', () => {
  const result = normaliseDrhpFilings([null, { unexpected: true }, { company_name: company, filing_date: '2026-02-30', documents: { unexpected: true } }]);
  assert.equal(result.unmapped, 2); assert.equal(result.unmappedDocuments, 1); assert.equal(result.rows[0].date, null);
  assert.deepEqual(result.rows[0].documents, []); assert.equal(result.rows[0].source, null);
  assert.equal(normaliseDrhpFilings([]).rows.length, 0); assert.throws(() => normaliseDrhpFilings({ error: 'not an array' }));
});
await check('the service limit is visible and excess records cannot silently disappear', () => {
  const result = normaliseDrhpFilings(Array.from({ length: 51 }, () => sample[0]));
  assert.equal(result.rows.length, 50); assert.equal(result.limitReached, true); assert.equal(result.omittedRows, 1); assert.equal(result.returnedCount, 51);
  assert.equal(normaliseDrhpFilings(Array.from({ length: 50 }, () => sample[0])).limitReached, true);
});
await check('missing sessions, cross-origin, wrong method and reserved names never fetch', async () => {
  let calls = 0; const options = { fetcher: async () => { calls++; return Response.json([]); } };
  assert.equal((await handleDrhpFilings(request(company, { authorization: '' }), options)).status, 401);
  assert.equal((await handleDrhpFilings(request(company, { origin: 'https://evil.test' }), options)).status, 403);
  assert.equal((await handleDrhpFilings(request(company, { 'sec-fetch-site': 'cross-site' }), options)).status, 403);
  assert.equal((await handleDrhpFilings(new Request('https://dashboard.example/api/drhp-filings'), options)).status, 405);
  assert.equal((await handleDrhpFilings(request('sync_us'), options)).status, 400); assert.equal(calls, 0);
});
await check('the proxy calls only the fixed read-only GET with an encoded exact name and caller token', async () => {
  const name = 'A & B (India) Limited';
  const response = await handleDrhpFilings(request(name), { fetcher: async (url, init) => {
    assert.equal(url, `https://devde.muns.io/filings/drhp/${encodeURIComponent(name)}`); assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined); assert.equal(init.headers.authorization, 'Bearer fixture.reader.session');
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); return Response.json(sample);
  } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Authorization'); assert.equal(response.headers.get('etag'), null); assert.equal((await response.json()).query, name);
});
await check('upstream auth, rate limits and failures never look like an empty IPO history', async () => {
  for (const [status, reason] of [[401, 'unauthorised'], [403, 'unauthorised'], [429, 'rate-limited'], [404, 'upstream'], [503, 'upstream']]) {
    const result = await (await handleDrhpFilings(request(), { fetcher: async () => Response.json({ secret: 'not for the browser' }, { status }) })).json();
    assert.equal(result.ok, false); assert.equal(result.reason, reason); assert.equal(result.rows, undefined); assert.ok(!JSON.stringify(result).includes('secret'));
  }
});
await check('malformed, oversized and stalled bodies fail within bounds', async () => {
  const malformed = await (await handleDrhpFilings(request(), { fetcher: async () => new Response('not json') })).json();
  assert.equal(malformed.reason, 'shape-or-upstream');
  assert.equal((await handleDrhpFilings(request('x'.repeat(9000)))).status, 413);
  const large = await (await handleDrhpFilings(request(), { fetcher: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) })).json();
  assert.equal(large.reason, 'too-large');
  const aborter = new AbortController();
  const stalled = await handleDrhpFilings(request(company, {}, { signal: aborter.signal }), { fetcher: async () => {
    setTimeout(() => aborter.abort(), 10); return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('[')); } }));
  } });
  assert.equal((await stalled.json()).reason, 'timeout');
});
await check('actual Worker routing ignores deployment identity and never shares caller responses', async () => {
  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_, init) => { tokens.push(init.headers.authorization); return Response.json(sample); };
  try {
    const env = { MUNS_TOKEN: 'fixture.deployment.token' };
    await worker.fetch(request(), env, {});
    await worker.fetch(request(company, { authorization: 'Bearer fixture.other.session' }), env, {});
    assert.equal((await worker.fetch(request(company, { authorization: '' }), env, {})).status, 401);
    assert.deepEqual(tokens, ['Bearer fixture.reader.session', 'Bearer fixture.other.session']);
  } finally { globalThis.fetch = originalFetch; }
});
console.log(`\n${checks} DRHP checks passed.`);
