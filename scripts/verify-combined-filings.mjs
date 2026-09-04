#!/usr/bin/env node
// Synthetic fixtures based on the public DTOs; no authenticated production requests.
import assert from 'node:assert/strict';
import { handleCombinedFilings, validateCombinedRequest } from '../worker/combined-filings.mjs';
import worker from '../worker/index.js';
import { normaliseCombinedFilings, documentUrl } from '../public/js/data/combined-filings-shared.js';

let checks = 0;
const check = async (label, fn) => { await fn(); console.log(`PASS ${label}`); checks++; };
const now = () => Date.parse('2026-09-04T07:00:00Z');
const query = { ticker: 'STLTECH', country: 'India', form: ['all'], start_date: '2026-09-01', end_date: '2026-09-04' };
const tokenA = 'fixture.reader-a.session';
const request = (body = query, headers = {}, extra = {}) => new Request('https://dashboard.example/api/combined-filings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}`, ...headers }, body: JSON.stringify(body), ...extra });
const sample = [
  { source: 'NSE', data: [{ symbol: 'STLTECH', title: 'Analyst day', desc: 'Presentation', date: '2026-09-03', attachment: 'https://nsearchives.nseindia.com/corporate/stl.pdf', isRead: false }] },
  { ticker: 'STLTECH', title: 'Annual report', date: '2026-08-15', form: 'annual_report', filing_url: 'https://www.screener.in/report.pdf', isRead: true },
  { ticker: 'STLTECH', title: 'Draft prospectus', date: '2026-09-02', source: 'DRHP', filing_url: 'https://example.test/draft.pdf', isRead: false },
];

await check('document DTOs and grouped announcements retain identity, dates, source and read flags', () => {
  const result = normaliseCombinedFilings(sample, query);
  assert.equal(result.rows.length, 3); assert.equal(result.unmapped, 0);
  assert.equal(result.rows[0].title, 'Analyst day'); assert.equal(result.rows[0].isRead, false);
  assert.deepEqual(result.rows[0].sourceTags, ['NSE']);
  assert.equal(result.rows[2].isRead, true); assert.ok(result.rows[2].sourceTags.includes('Screener'));
});
await check('identical URLs dedupe without losing sources or fabricating conflicting read status', () => {
  const rows = normaliseCombinedFilings([{ title: 'A', url: 'https://example.test/a', source: 'NSE', isRead: true }, { title: 'A', url: 'https://example.test/a', source: 'BSE', isRead: false }], query).rows;
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].sourceTags, ['NSE', 'BSE']); assert.equal(rows[0].isRead, null);
});
await check('a sparse duplicate cannot erase the known subject, date or report type', () => {
  const rows = normaliseCombinedFilings([{ title: 'Annual report', date: '2026-09-02', form: 'annual_report', url: 'https://example.test/a' }, { url: 'https://example.test/a' }], query).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].title, 'Annual report'); assert.equal(rows[0].date, '2026-09-02'); assert.equal(rows[0].form, 'annual_report');
});
await check('unknown sources and dates stay unknown; spoofed source domains are not NSE', () => {
  const result = normaliseCombinedFilings([{ title: 'A', date: '2026-02-30', url: 'https://nseindia.com.evil.test/a', isRead: 'false' }], query);
  assert.equal(result.rows[0].date, null); assert.equal(result.rows[0].isRead, null); assert.deepEqual(result.rows[0].sourceTags, []);
  assert.equal(documentUrl('javascript:alert(1)'), null); assert.equal(documentUrl('https://user:secret@example.test/a'), null);
});
await check('unrecognised records are flagged, while a genuine empty array is valid', () => {
  assert.equal(normaliseCombinedFilings([{ unexpected: 'value' }, null], query).unmapped, 2);
  assert.deepEqual(normaliseCombinedFilings([], query), { rows: [], unmapped: 0 });
  assert.throws(() => normaliseCombinedFilings({ error: 'unauthorized' }, query));
});
await check('request validation rejects bad dates, ranges, forms and ticker injection', () => {
  for (const body of [{ ...query, end_date: '2026-02-30' }, { ...query, ticker: '../secret' }, { ...query, start_date: '2020-01-01' }, { ...query, end_date: '2027-01-01' }, { ...query, form: ['all', 'concalls'] }, { ...query, form: ['invented'] }]) assert.throws(() => validateCombinedRequest(body, now()));
  const clean = validateCombinedRequest({ ...query, user_index: 42, url: 'https://evil.test' }, now());
  assert.deepEqual(clean, query);
});
await check('all supported Indian form requests and USA-only metadata are passed correctly', () => {
  for (const form of ['all', 'concalls', 'annual_report', 'earnings_report']) assert.deepEqual(validateCombinedRequest({ ...query, form: [form] }, now()).form, [form]);
  const us = validateCombinedRequest({ ...query, country: 'USA', email: 'fixture@example.test', company_name: 'Fixture' }, now());
  assert.equal(us.form, undefined); assert.equal(us.email, 'fixture@example.test');
  assert.equal(validateCombinedRequest({ ticker: 'STLTECH', country: 'India' }, now()).end_date, '2026-09-04');
});
await check('missing session, cross-origin and method failures never call the upstream', async () => {
  let calls = 0; const options = { now, fetcher: async () => { calls++; return Response.json([]); } };
  assert.equal((await handleCombinedFilings(request(query, { authorization: '' }), options)).status, 401);
  assert.equal((await handleCombinedFilings(request(query, { origin: 'https://evil.test' }), options)).status, 403);
  assert.equal((await handleCombinedFilings(new Request('https://dashboard.example/api/combined-filings'), options)).status, 405);
  assert.equal(calls, 0);
});
await check('success uses the exact documented POST and caller token, with private no-store delivery', async () => {
  const response = await handleCombinedFilings(request(), { now, fetcher: async (url, init) => {
    assert.equal(url, 'https://devde.muns.io/filings/combined_filings_announcements'); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), query); assert.equal(init.headers.authorization, `Bearer ${tokenA}`);
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store'); return Response.json(sample);
  } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vary'), 'Authorization'); assert.equal(response.headers.get('etag'), null);
  assert.equal((await response.json()).rows.length, 3);
});
await check('auth, rate limits and service failures stay failures, not empty histories', async () => {
  for (const [code, reason] of [[302, 'upstream'], [307, 'upstream'], [401, 'unauthorised'], [403, 'unauthorised'], [429, 'rate-limited'], [503, 'upstream']]) {
    const response = await handleCombinedFilings(request(), { now, fetcher: async () => Response.json({ secret: 'never echo upstream errors' }, { status: code }) });
    const data = await response.json(); assert.equal(data.ok, false); assert.equal(data.reason, reason); assert.ok(!JSON.stringify(data).includes('secret'));
  }
});
await check('request and response limits hold without Content-Length', async () => {
  assert.equal((await handleCombinedFilings(request({ ...query, padding: 'x'.repeat(9000) }), { now })).status, 413);
  const response = await handleCombinedFilings(request(), { now, fetcher: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) });
  assert.equal((await response.json()).reason, 'too-large');
});
await check('aborting a stalled response body finishes without leaking its records', async () => {
  const controller = new AbortController();
  const pending = handleCombinedFilings(request(query, {}, { signal: controller.signal }), { now, fetcher: async () => {
    setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('[')); } }));
  } });
  assert.equal((await (await pending).json()).reason, 'timeout');
});
await check('Worker routing never substitutes deployment credentials or caches another readers flags', async () => {
  const originalFetch = globalThis.fetch;
  const tokens = [];
  globalThis.fetch = async (_, init) => { tokens.push(init.headers.authorization); return Response.json([{ ...sample[1], isRead: init.headers.authorization.endsWith(tokenA) }]); };
  try {
    const env = { MUNS_TOKEN: 'fixture.deployment.token' };
    const a = await worker.fetch(request(), env, {});
    const b = await worker.fetch(request(query, { authorization: 'Bearer fixture.reader-b.session' }), env, {});
    assert.equal((await a.json()).rows[0].isRead, true); assert.equal((await b.json()).rows[0].isRead, false);
    assert.deepEqual(tokens, [`Bearer ${tokenA}`, 'Bearer fixture.reader-b.session']);
    assert.equal((await worker.fetch(request(query, { authorization: '' }), env, {})).status, 401);
  } finally { globalThis.fetch = originalFetch; }
});
console.log(`\n${checks} combined filings checks passed.`);
