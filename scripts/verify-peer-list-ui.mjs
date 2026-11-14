#!/usr/bin/env node
// THE SHARED PEER / COMPETITOR MAP, DRIVEN THROUGH THE REAL UI AGAINST THE REAL STORE (#312).
//
// The fixture server implements /api/peer-lists on top of `SharedPeerListStore` itself — the same
// class the Worker runs — so this exercises the whole path (edit -> intent -> route -> SQLite ->
// snapshot -> the other device's paint) without wrangler, without egress, and without a second copy
// of the rules that could drift from the deployed one. /api/stock-search is stubbed, because the add
// box's company search is the one thing that genuinely needs the Worker-held credential.
//
// Part A drives the client (/js/core/peer-list.js) across TWO browser contexts — two devices, one
// server — which is the only arrangement in which "one list, every device" is a claim about
// anything. Part B opens the real HAL one-pager and drives its peers editor: block, search, add,
// remove. HAL is authored AND in the family book, so its row renders on a static origin.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SharedPeerListStore } from '../worker/peer-list-store.mjs';
import { PEER_PER_COMPANY_LIMIT } from '../public/js/data/peer-list-shared.js';
import { contentTag, stableJson } from '../worker/http.mjs';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

let failures = 0;
let checks = 0;
const ok = (name, pass, detail = '') => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- the stand-in Worker -----------------------------------------------------------------
const db = new DatabaseSync(':memory:');
const store = new SharedPeerListStore({
  sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
  transactionSync: (fn) => {
    db.exec('BEGIN');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
});

let offline = false;   // the shared map is unreachable
const SEARCH_RESULTS = [
  { ticker: 'WIPRO', name: 'Wipro Ltd.' },
  { ticker: 'TCS', name: 'Tata Consultancy Services Ltd.' },
  { ticker: 'HAL', name: 'Hindustan Aeronautics' }, // the company itself — must be filtered out of its own results
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/peer-lists') {
    if (offline) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":false,"reason":"peer-lists-unavailable"}'); return; }
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = store.peerListApply(input.intents);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...result.snapshot, outcomes: result.outcomes, checkedAt: new Date().toISOString() }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"ok":false,"reason":"invalid-request"}');
      }
      return;
    }
    const payload = { ok: true, ...store.peerListSnapshot() };
    const tag = `"${contentTag(stableJson(payload))}"`;
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, { etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === '/api/stock-search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const results = SEARCH_RESULTS.filter((r) => !q || r.ticker.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, results }));
    return;
  }
  if (url.pathname === '/peer-fixture') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>Local peer-list regression fixture</title>');
    return;
  }
  // Every other /api/ route is absent here, exactly as on a static origin. The dashboard paints anyway.
  if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('{}'); return; }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(file);
    res.setHeader('content-type', {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
    }[extname(file)] || 'text/plain');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

const allErrors = [];
const newDevice = async (path) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => allErrors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort()));
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  return { context, page };
};

// Drive the client directly (Part A).
const peersOn = (page, company) => page.evaluate(async (c) => {
  const pl = await import('/js/core/peer-list.js');
  return { peers: pl.peersOf(c).map((p) => p.peer), count: pl.countFor(c), meta: pl.meta() };
}, company);
const syncOn = async (page) => { await page.evaluate(async () => (await import('/js/core/peer-list.js')).syncNow({ force: true })); await page.waitForTimeout(400); };
const addOn = async (page, c, peer, name) => {
  const result = await page.evaluate(async (a) => {
    const pl = await import('/js/core/peer-list.js');
    const accepted = pl.addPeer(a.c, a.peer, a.name);
    await pl.syncNow({ force: true });
    return accepted;
  }, { c, peer, name });
  await page.waitForTimeout(300);
  return result;
};
const removeOn = async (page, c, peer) => {
  await page.evaluate(async (a) => {
    const pl = await import('/js/core/peer-list.js');
    pl.removePeer(a.c, a.peer);
    await pl.syncNow({ force: true });
  }, { c, peer });
  await page.waitForTimeout(300);
};

try {
  console.log('\n— one map, two devices —');
  const laptop = await newDevice('/peer-fixture');
  const phone = await newDevice('/peer-fixture');
  await syncOn(laptop.page);
  await syncOn(phone.page);

  const accepted = await addOn(laptop.page, 'INFY', 'WIPRO', 'Wipro Ltd.');
  const laptopAfter = await peersOn(laptop.page, 'INFY');
  ok('a peer added on one device reaches the shared map and is confirmed',
    accepted && laptopAfter.peers.includes('WIPRO') && laptopAfter.meta.origin === 'live' && laptopAfter.meta.shared === true,
    `${JSON.stringify(laptopAfter.peers)} origin=${laptopAfter.meta.origin}`);

  await syncOn(phone.page);
  ok('a SECOND DEVICE that did nothing sees the same peer under the same company',
    (await peersOn(phone.page, 'INFY')).peers.includes('WIPRO'));

  await addOn(phone.page, 'INFY', 'TCS', 'TCS Ltd.');
  await syncOn(laptop.page);
  const bothSides = await peersOn(laptop.page, 'INFY');
  ok('both devices contribute to one company and neither loses the other\'s peer',
    bothSides.peers.includes('WIPRO') && bothSides.peers.includes('TCS'), JSON.stringify(bothSides.peers));
  ok('the newest peer reads first', bothSides.peers[0] === 'TCS', JSON.stringify(bothSides.peers));

  console.log('\n— removing —');
  await removeOn(laptop.page, 'INFY', 'WIPRO');
  await syncOn(phone.page);
  ok('a removal reaches the other device', !(await peersOn(phone.page, 'INFY')).peers.includes('WIPRO'));

  console.log('\n— an outage is not an empty map —');
  const before = (await peersOn(phone.page, 'INFY')).peers.length;
  offline = true;
  await syncOn(phone.page);
  const during = await peersOn(phone.page, 'INFY');
  ok('a failed read leaves every peer on screen', during.peers.length === before, `${before} → ${during.peers.length}`);
  ok('...and stops claiming the map is confirmed', during.meta.origin !== 'live', during.meta.origin);
  ok('...and says so in words', typeof during.meta.error === 'string' && during.meta.error.length > 0);

  const pendingAccepted = await addOn(phone.page, 'INFY', 'HCLTECH', 'HCL Technologies Ltd.');
  const queued = await peersOn(phone.page, 'INFY');
  ok('an edit made during the outage is kept and marked not yet sent',
    pendingAccepted && queued.peers.includes('HCLTECH') && queued.meta.pending >= 1 && queued.meta.origin === 'pending',
    `pending=${queued.meta.pending} origin=${queued.meta.origin}`);

  offline = false;
  await syncOn(phone.page);
  const recovered = await peersOn(phone.page, 'INFY');
  ok('...and lands on the shared map once it is reachable again',
    recovered.meta.pending === 0 && recovered.peers.includes('HCLTECH'));
  await syncOn(laptop.page);
  ok('...where the other device then sees it', (await peersOn(laptop.page, 'INFY')).peers.includes('HCLTECH'));

  console.log('\n— a full company list refuses, and says so —');
  // Pre-fill a company to its per-company cap straight on the store, from "another device".
  for (let i = 0; i < PEER_PER_COMPANY_LIMIT; i += 25) {
    store.peerListApply(Array.from({ length: Math.min(25, PEER_PER_COMPANY_LIMIT - i) }, (_, j) => ({ op: 'add', company: 'CAPCO', peer: `RIVAL${i + j}` })));
  }
  await syncOn(laptop.page);
  const full = await peersOn(laptop.page, 'CAPCO');
  const refusedLocally = await laptop.page.evaluate(async () => {
    const pl = await import('/js/core/peer-list.js');
    return pl.addPeer('CAPCO', 'ONEMORE', 'One More Ltd.');
  });
  ok('a company already at its cap refuses a further peer locally, before a round trip',
    full.count === PEER_PER_COMPANY_LIMIT && refusedLocally === false && !(await peersOn(laptop.page, 'CAPCO')).peers.includes('ONEMORE'),
    `count=${full.count} accepted=${refusedLocally}`);

  console.log('\n— the one-pager editor (HAL) —');
  const desk = await newDevice('/#/research/ai-insights');
  await desk.page.waitForSelector('[data-open="HAL"]', { timeout: 30000 });
  await desk.page.click('[data-open="HAL"]');
  await desk.page.waitForSelector('#gi-peers', { timeout: 10000 });
  ok('the one-pager carries a Peers & competitors block', await desk.page.locator('#gi-peers').count() === 1);
  ok('...which starts with an explicit empty state, not a blank',
    (await desk.page.locator('#gi-peers-list .gi-live-empty').count()) === 1);

  await desk.page.fill('#gi-peer-in', 'wip');
  await desk.page.waitForSelector('#gi-peer-results .gi-peer-res[data-add-peer="WIPRO"]', { timeout: 5000 });
  ok('the company search never offers the company itself as its own peer',
    (await desk.page.locator('#gi-peer-results [data-add-peer="HAL"]').count()) === 0);
  await desk.page.click('#gi-peer-results .gi-peer-res[data-add-peer="WIPRO"]');
  await desk.page.waitForSelector('#gi-peers-list .gi-peer[data-peer="WIPRO"]', { timeout: 5000 });
  ok('picking a search result adds the peer to the one-pager', true);
  ok('...and it reaches the shared store', store.peerListSnapshot().links.some((l) => l.company === 'HAL' && l.peer === 'WIPRO'));

  // A second device sees the peer added from the one-pager.
  await syncOn(phone.page);
  ok('...so another device sees HAL\'s new peer', (await peersOn(phone.page, 'HAL')).peers.includes('WIPRO'));

  await desk.page.click('#gi-peers-list .gi-peer[data-peer="WIPRO"] [data-rm-peer="WIPRO"]');
  await desk.page.waitForTimeout(400);
  ok('removing a peer from the one-pager clears the row',
    (await desk.page.locator('#gi-peers-list .gi-peer[data-peer="WIPRO"]').count()) === 0);
  ok('...and the removal reaches the store',
    !store.peerListSnapshot().links.some((l) => l.company === 'HAL' && l.peer === 'WIPRO'));

  ok('no uncaught page errors anywhere in the run', allErrors.length === 0, allErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'} — ${checks - failures}/${checks} checks\n`);
process.exit(failures ? 1 : 0);
