#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IPO_SOURCES, parseNseOffers, parseSebiOffers, parseBseOffers, captureIpoFilings, boundedIpoText } from '../worker/ipo-sources.mjs';
import { handleIpoFilings } from '../worker/ipo-filings.mjs';
import { ipoDay, filingType, mergeIpoFilings, validateIpoFilings, legacyIpoFilings } from '../public/js/data/ipo-filings-shared.js';
import { createIpoFilingsFeed } from '../public/js/data/ipo-filings.js';
const at = '2026-09-04T13:00:00.000Z', now = () => Date.parse(at);
const nse = JSON.stringify([{ company: 'Example & Co Limited', symbol: '-', isin: 'INE123456789', drhp: 'Draft Prospectus', drhpDate: '01-Sep-2026', drhpAttach: 'https://nsearchives.nseindia.com/a.pdf', rhp: 'Red Herring Prospectus', rhpDate: '04-Sep-2026', rhpAttach: 'https://nsearchives.nseindia.com/b.zip' }]);
const sebi = `<p>1 to 25 of 2193 records</p><table id="sample_1"><tr><td>Sep 04, 2026</td><td><a href="https://www.sebi.gov.in/filings/public-issues/sep-2026/example.html" title="Example &amp; Co Limited - Addendum to DRHP<br><a href='https://www.sebi.gov.in/dap.pdf'>Draft Abridged</a>">Example &amp; Co Limited - Addendum to DRHP<br><a href='https://www.sebi.gov.in/dap.pdf'>Draft Abridged</a></a></tr></table>`;
const bse = `<table id="ContentPlaceHolder1_gvData"><tr><td><a>SME &amp; Co Limited</a></td><td><a id="ContentPlaceHolder1_gvData_hyDRHP_0" href="/draft.pdf">03/09/2026</a></td><td><a id="ContentPlaceHolder1_gvData_hyRHP_0" href="/rhp_20260904010000.pdf"><img src="download.gif"></a></td></tr></table>`;
const source = (id) => IPO_SOURCES.find((s) => s.id === id);
const bodies = (url) => { const s = IPO_SOURCES.find((s) => s.url === url); assert(s, 'fixed official URLs only'); return s.kind === 'nse' ? nse : s.kind === 'bse' ? bse : sebi; };
let count = 0;
const test = async (name, fn) => { await fn(); console.log('PASS', name); count++; };
await test('calendar dates are strict, never inferred from URL/observation', () => {
  assert.equal(ipoDay('31-Feb-2026'), null); assert.equal(ipoDay('Sep 04, 2026'), '2026-09-04'); assert.equal(ipoDay('04/09/2026'), '2026-09-04'); assert.equal(ipoDay('-'), null);
  assert.equal(filingType('Example UDRHP'), 'UDRHP'); assert.equal(filingType('Example Red Herring Prospectus'), 'RHP');
});
await test('NSE becomes filing rows, not a company status tracker', () => {
  const r = parseNseOffers(nse, source('nse-equity'), at).rows;
  assert.equal(r.length, 2); assert.equal(r[0].filingDate, '2026-09-04'); assert.equal(r[0].ticker, null); assert.equal(r[0].board, 'Mainboard');
  assert(!('score' in r[0])); assert.equal(mergeIpoFilings(r, r).length, 2);
  assert.throws(() => parseNseOffers('{}', source('nse-equity'), at));
  assert.throws(() => parseNseOffers('[]', source('nse-equity'), at));
});
await test('SEBI malformed nested anchors preserve exact title, URL and window limit', () => {
  const p = parseSebiOffers(sebi, source('sebi-draft'), at);
  assert.equal(p.rows.length, 1); assert.equal(p.rows[0].company, 'Example & Co Limited'); assert.equal(p.rows[0].filingType, 'Addendum');
  assert(p.note.includes('2193')); assert(!p.rows[0].title.includes('<a')); assert(p.rows[0].url.endsWith('example.html'));
  assert.throws(() => parseSebiOffers('<html>Access Denied</html>', source('sebi-draft'), at));
});
await test('BSE dated drafts and undated RHP remain distinct', () => {
  const r = parseBseOffers(bse, source('bse-sme'), at).rows;
  assert.equal(r.length, 2); assert.equal(r[0].company, 'SME & Co Limited'); assert.equal(r[1].filingDate, null); assert.equal(r[1].filingType, 'RHP');
  assert.throws(() => parseBseOffers('<html>blocked</html>', source('bse-sme'), at));
});
const payload = await captureIpoFilings({ now, fetcher: async (url, init) => { assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.authorization, undefined); return new Response(bodies(url)); } });
await test('seven-source capture and payload validate', () => { assert(payload.ok); validateIpoFilings(payload); assert.equal(payload.sources.length, 7); assert.equal(payload.rows.length, 10); });
await test('schema rejects invalid links, dates and missing source status', () => {
  for (const change of [{ url: 'javascript:alert(1)' }, { filingDate: '2026-02-31' }, { observedAt: 'not-a-date' }]) assert.throws(() => validateIpoFilings({ ...payload, rows: [{ ...payload.rows[0], ...change }] }));
  assert.throws(() => validateIpoFilings({ ...payload, sources: payload.sources.slice(1) }));
});
await test('one source failure preserves the others with an explicit failed status', async () => {
  const p = await captureIpoFilings({ now, fetcher: async (url) => new Response(bodies(url), { status: url.includes('index=sme') ? 403 : 200 }) });
  assert(p.ok); assert.equal(p.sources.find((s) => s.id === 'nse-sme').status, 'failed'); assert(p.rows.length > 0);
});
await test('response reads enforce byte and cancellation limits', async () => {
  await assert.rejects(boundedIpoText(new Response('12345'), new AbortController().signal, 4));
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = boundedIpoText(response, controller.signal); controller.abort(); await assert.rejects(pending); assert(cancelled);
});
await test('read-only endpoint rejects arbitrary query, POST and redirects; cache preserves check time', async () => {
  let calls = 0, saved;
  const opts = { now, fetcher: async (url) => { calls++; return new Response(bodies(url)); }, cache: { match: async () => saved?.clone(), put: async (_, response) => { saved = response; } } };
  assert.equal((await handleIpoFilings(new Request('https://app.test/api/ipo-filings?url=https://evil.test'), opts)).status, 400);
  assert.equal((await handleIpoFilings(new Request('https://app.test/api/ipo-filings', { method: 'POST' }), opts)).status, 405); assert.equal(calls, 0);
  assert.equal((await handleIpoFilings(new Request('https://app.test/api/ipo-filings'), opts)).status, 200); assert.equal(calls, 7);
  const hit = await (await handleIpoFilings(new Request('https://app.test/api/ipo-filings'), opts)).json(); assert.equal(calls, 7); assert.equal(hit.checkedAt, at);
  const failed = await handleIpoFilings(new Request('https://app.test/api/ipo-filings'), { now, fetcher: async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }), cache: null });
  assert.equal(failed.status, 502); assert.equal(failed.headers.get('cache-control'), 'no-store');
});
await test('retained history survives shrink, outage and reload, without a fresh label', async () => {
  let live = payload, saved, clock = now();
  const build = () => createIpoFilingsFeed({ now: () => clock, readLive: async () => { if (!live) throw Error(); return live; }, readSnapshot: async () => payload, readSaved: async () => saved, save: async (value) => { saved = { value }; } });
  let f = build(); await f.load(); const oldCount = f.rows().length; assert(!f.meta().degraded);
  live = { ...payload, rows: [{ ...payload.rows[0], url: 'https://www.sebi.gov.in/new.pdf', observedAt: '2026-09-04T13:01:00Z' }] };
  await f.refresh(); assert.equal(f.rows().length, oldCount + 1);
  live = null; await f.refresh(); assert(f.meta().liveFailed); assert.equal(f.rows().length, oldCount + 1);
  f = build(); await f.load(); assert.equal(f.rows().length, oldCount + 1); assert(f.meta().degraded);
  live = payload; clock += 3600000; await f.refresh(); assert(f.meta().stale);
});
await test('missing bundled archive and partial live source reads cannot appear complete', async () => {
  const f = createIpoFilingsFeed({ now, readSnapshot: async () => { throw Error(); }, readLive: async () => payload, readSaved: async () => null, save: async () => {} });
  await f.load(); assert(f.meta().snapshotFailed); assert(f.meta().degraded); assert(f.rows().length);
  const p = { ...payload, sources: payload.sources.map((s, i) => i === 0 ? { ...s, status: 'failed', note: 'Source unavailable' } : s) };
  const partial = createIpoFilingsFeed({ now, readSnapshot: async () => payload, readLive: async () => p, readSaved: async () => null, save: async () => {} });
  await partial.load(); assert(partial.meta().degraded); assert(partial.rows().length);
});
await test('shipped capture retains EAAA and all imported dated filings without weekly scoring', () => {
  const capture = validateIpoFilings(JSON.parse(readFileSync(new URL('../public/data/ipo-filings.json', import.meta.url))));
  assert(capture.rows.length > 5000); assert(capture.rows.some((r) => r.company === 'EAAA India Alternatives Limited'));
  assert(capture.rows.some((r) => r.filingDate === '2026-09-04')); assert(capture.rows.every((r) => !('score' in r)));
  assert.equal(legacyIpoFilings([{ meta: { data_as_of: '2026-08-31' }, filings: [], ipo_market: { open_upcoming: [{ company_name: 'Not a filing' }] } }]).length, 0);
});
console.log(`${count} IPO filing checks passed`);
