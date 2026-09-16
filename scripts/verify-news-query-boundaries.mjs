// Small adversarial captures: date grouping, correction companions and recovery. No egress.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeNewsJson, readNewsJson } from './lib/news-json-storage.mjs';
import { shardSpec, shardPath } from '../public/js/core/json-shards.js';
import { createNewsWorkingSet } from '../public/js/data/news-working-set.js';
import { newsQueryIndexRow, newsQueryIdentity } from '../public/js/data/news-query-index.js';
import { newsPeriodBounds } from '../public/js/data/news-window.js';
const dir = mkdtempSync(join(tmpdir(), 'sattva-query-boundaries-'));
const originalFetch = globalThis.fetch, originalNow = Date.now, originalDocument = globalThis.document, originalTimeout = globalThis.setTimeout;
const digest = data => createHash('sha256').update(data).digest('hex');
let now = Date.parse('2026-09-16T18:29:00Z');
Date.now = () => now;
try {
  const rows = Array.from({ length: 120 }, (_, i) => ({ title: `Alpha update ${i}`, ticker: 'ALPHA',
    company: 'Alpha Limited', date: i % 3 === 0 ? '2026-09-16' : '2026-08-01',
    url: `https://example.test/story/${i}`, description: 'Original detail. '.repeat(150) }));
  rows[3].tradingViewId = 'same-story';
  rows[4].tradingViewId = 'same-story';
  rows[1] = { ...rows[1], url: rows[0].url, lastSeenAt: '2026-09-16T17:00:00Z', title: 'Corrected publication day' };
  const value = { capturedAt: '2026-09-16T17:00:00Z', byTicker: { ALPHA: rows, EMPTY: [] }, failed: {}, empty: [] };
  const path = join(dir, 'news.json');
  writeNewsJson(path, value, { maxBytes: 32768 });
  const manifest = JSON.parse(readFileSync(path)), spec = shardSpec(manifest);
  assert.equal(spec.version, 2);
  assert.deepEqual(readNewsJson(path, null, { verifyIndexes: true }), value, 'date transport preserves every original field and order');
  assert(spec.parts.some((part, i) => part.order[0] !== spec.parts.slice(0,i).reduce((n,p)=>n+p.rows,0)), 'fixture really reorders transport');
  const duplicatedOrder = structuredClone(manifest);
  duplicatedOrder._jsonShards.parts[0].order[0] = duplicatedOrder._jsonShards.parts[0].order[1];
  assert.throws(() => shardSpec(duplicatedOrder), /order/, 'duplicate/missing original positions cannot pass');
  const index = spec.parts[0].queryIndex, indexPath = shardPath(path, index.file), originalIndex = readFileSync(indexPath);
  const wrongIndex = JSON.parse(originalIndex); wrongIndex.items[0][0] = '2020-01-01';
  const wrongBytes = Buffer.from(JSON.stringify(wrongIndex));
  const badManifest = structuredClone(manifest), badPart = badManifest._jsonShards.parts[0];
  badPart.queryIndex.sha256 = digest(wrongBytes); badPart.queryIndex.bytes = wrongBytes.length;
  badPart.queryIndex.file = `news.parts/${badPart.queryIndex.sha256}.json`;
  writeFileSync(shardPath(path, badPart.queryIndex.file), wrongBytes); writeFileSync(path, JSON.stringify(badManifest));
  assert.throws(() => readNewsJson(path, null, { verifyIndexes: true }), /dates or identities/, 'publication validates semantic index content, not only hashes');
  writeFileSync(path, JSON.stringify(manifest));

  let window = newsPeriodBounds('today', now), gate = null;
  const calls = [], disk = new Map();
  const read = async input => {
    if (input === 'data/tradingview-news/latest.json') return { value: { capturedAt: value.capturedAt, byTicker: {} } };
    if (input !== 'data/news.json') throw Error(`Unexpected fixture path ${input}`);
    if (gate) await gate;
    return { value: JSON.parse(readFileSync(path)), checkedAt: now };
  };
  const fetcher = async input => {
    calls.push(input);
    return new Response(readFileSync(join(dir, String(input).replace(/^data\//,''))));
  };
  const make = (fetcherOverride = fetcher) => createNewsWorkingSet({ window: () => window, read, fetcher: fetcherOverride,
    diskRead: key => disk.get(key), diskWrite: (key, value) => { disk.set(key, value); } });
  const working = make();
  await working.prepare();
  const projected = (await working.read('data/news.json')).value;
  const selected = rows.filter(row => row.date === '2026-09-16' || row.url === rows[0].url || row.tradingViewId === 'same-story');
  assert.deepEqual(projected.byTicker.ALPHA, selected, 'selected date includes corrected companions in their original order');
  const sourcePaths = new Set(spec.parts.map(part => 'data/'+part.file));
  assert(calls.filter(path => sourcePaths.has(path)).length < spec.parts.length, 'Today skips old source text');
  assert.equal(projected.byTicker.EMPTY.length, 0);
  const before = calls.length; await working.read('data/news.json');
  assert.equal(calls.length, before, 'unchanged verified parts are reused');
  working.release();
  writeFileSync(path, JSON.stringify({...manifest,archive:{index:'../invalid-index.json'}}));
  const partial = make();
  await partial.prepare();
  assert.deepEqual((await partial.read('data/news.json')).value.byTicker.ALPHA, selected,
    'malformed optional archive metadata cannot prevent independent head records from painting');
  partial.release(); writeFileSync(path, JSON.stringify(manifest));

  for (const failure of ['missing', 'corrupt']) {
    disk.clear();
    const fallback = make(async input => {
      if (String(input).endsWith(index.file)) return failure === 'missing' ? new Response('', { status: 404 }) : new Response('corrupt');
      return fetcher(input);
    });
    await fallback.prepare();
    assert.deepEqual((await fallback.read('data/news.json')).value.byTicker.ALPHA, selected, `${failure} optional index falls back without missing records`);
    fallback.release();
  }
  let open;
  gate = new Promise(resolve => { open = resolve; });
  const switching = make();
  const old = switching.prepare();
  window = { from: '2026-08-01', to: '2026-08-01', includeUndated: false };
  const latest = switching.read('data/news.json');
  open(); await old;
  const newValue = (await latest).value;
  assert.equal(newValue.queryWindow.from, window.from, 'in-flight old preparation cannot certify a new period');
  assert.deepEqual(newValue.byTicker.ALPHA, rows.filter(row => row.date === '2026-08-01' || row.url === rows[0].url || row.tradingViewId === 'same-story'));
  switching.release(); gate = null;

  // Exercise the real facade and explicit live searches in separate windows. Empty Today
  // must not trigger a company walk; the changing IST day is evaluated on every refresh.
  mkdirSync(join(dir, 'tradingview-news'), { recursive: true });
  writeFileSync(join(dir,'tradingview-news/latest.json'), JSON.stringify({capturedAt:value.capturedAt,byTicker:{}}));
  writeFileSync(join(dir,'market-news.json'), JSON.stringify({capturedAt:value.capturedAt,articles:[],sources:[]}));
  for (const row of rows) delete row.tradingViewId;
  writeNewsJson(path, value, {maxBytes:32768});
  let upstreamCalls = 0, failSourceParts = false;
  globalThis.fetch = async input => {
    const p = String(input);
    if (failSourceParts && p.startsWith('data/news.parts/')) return new Response('', {status:403});
    if (p.startsWith('data/')) {
      try { return new Response(readFileSync(join(dir,p.slice(5))), {headers:{'content-type':'application/json'}}); }
      catch { return new Response('{}',{status:404}); }
    }
    upstreamCalls++;
    return Response.json({ articles: [{ title:'Manual arrival',date:'2026-09-17',url:'https://example.test/manual' }], fetchedAt:new Date(now).toISOString() });
  };
  const { createQueryNews, createFeed } = await import('../public/js/data/filings.js');
  let poll = null, scheduled = 0;
  globalThis.document = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= 120000) { poll = fn; scheduled++; return 123456789; }
    return originalTimeout(fn, ms, ...args);
  };
  const current = createQueryNews(() => newsPeriodBounds('today'));
  const offCurrent = current.onChange(() => {});
  await current.load(['ALPHA']);
  assert(current.rows().some(row=>row.title==='Alpha update 3'));
  assert(!current.rows().some(row=>row.url===rows[2].url));
  writeFileSync(join(dir,'market-news.json'), JSON.stringify({capturedAt:'2026-09-16T18:00:00Z',sources:[],articles:[{
    id:'publisher:date-correction',title:'Publisher correction',url:rows[2].url,publishedAt:'2026-09-16T17:30:00Z'
  }]}));
  await current.refreshSnapshot();
  assert(current.rows().some(row=>row.url===rows[2].url), 'a new publisher date adds an older companion even when the company head timestamp is unchanged');
  failSourceParts = true;
  current.setWindow({from:'2026-08-01',to:'2026-09-16',includeUndated:false});
  await current.load(['ALPHA']);
  assert(current.rows().some(row=>row.title==='Alpha update 3'), 'a failed wider read keeps overlapping last-good stories visible');
  assert(current.meta().newsDelivery.core.error, 'failed widening is not reported as complete');
  failSourceParts = false;
  await current.refreshSnapshot();
  assert(current.rows().some(row=>row.url===rows[119].url), 'recovery reads the newly requested older records');
  current.setWindow(() => newsPeriodBounds('today'));
  await current.load(['ALPHA']);
  now = Date.parse('2026-09-16T18:31:00Z');
  assert.equal(current.isLoaded(), false, 'midnight invalidates the previous day without a manual filter change');
  assert.equal(typeof poll, 'function', 'visible query reader owns an automatic recheck');
  const priorScheduled = scheduled;
  await poll();
  assert(scheduled > priorScheduled, 'midnight replacement rearms the next automatic refresh');
  assert(current.isLoaded(), 'automatic rollover initializes the new reading period');
  assert.equal(current.rows().length, 0, 'the new empty day cannot retain yesterday in its working set');
  assert.equal(upstreamCalls, 0, 'an empty bounded date never starts unsolicited per-company requests');
  assert.equal((await current.refreshSnapshot()).available, true, 'a verified empty day is a successful read');
  const live = createFeed('news');
  await live.loadOne('ALPHA', { force: true });
  assert.equal(upstreamCalls, 1);
  assert(current.rows().some(row=>row.url==='https://example.test/manual'), 'manual arrival reaches another active window');
  offCurrent(); current.release();
  globalThis.setTimeout = originalTimeout; globalThis.document = originalDocument;
  const reopened = createQueryNews(() => newsPeriodBounds('today'));
  await reopened.load(['ALPHA']);
  assert(reopened.rows().some(row=>row.url==='https://example.test/manual'), 'releasing a reading window cannot lose an uncheckpointed manual arrival');
  reopened.release(); live.dispose();
  console.log('PASS date-part skipping, source order, correction companions, optional-index recovery, rapid switching, midnight and manual-arrival retention.');
} finally {
  Date.now = originalNow; globalThis.fetch = originalFetch; globalThis.document = originalDocument; globalThis.setTimeout = originalTimeout;
  rmSync(dir, {recursive:true,force:true});
}
