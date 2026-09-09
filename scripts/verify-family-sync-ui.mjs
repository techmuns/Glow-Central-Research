// Real browser, real IndexedDB/lifecycle events; synthetic books and local I/O only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.PLAYWRIGHT_ROOT) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const initialTime = Date.now();
const oldHolding = { isin: 'INE532F01054', ticker: 'EDELWEISS', name: 'Edelweiss', listed: true };
const sterlite = { isin: 'INE089C01029', ticker: 'STLTECH', name: 'Sterlite Technologies', listed: true };
const snapshot = { holdings: [oldHolding], count: 1, resolved: 1, asOf: '2026-06-30' };
let holdings = [oldHolding, sterlite], unavailable = false, checkTime = initialTime;
let pendingReply = null;
const payload = () => ({ ok: true, syncStatus: 'live', storage: 'shared', sourceRevision: 'a'.repeat(64),
  sourceWorkbook: { fileKey: 'up-aug', label: 'Active shared workbook', uploadedAt: '2026-09-03T00:00:00Z' },
  syncedAt: new Date(checkTime).toISOString(), asOf: '2026-09-30',
  holdings, count: holdings.length, resolved: holdings.length });
const html = `<!doctype html><meta charset="utf-8"><title>Local holdings lifecycle test</title>
<p id="status" role="status"></p><ul id="holdings"></ul><script type="module">
import * as coverage from '/js/data/coverage.js';
import * as scope from '/js/core/scope-lists.js';
import { bindFamilySyncLifecycle } from '/js/data/family-sync-lifecycle.js';
const paint = () => {
  document.querySelector('#status').textContent = coverage.syncLabel();
  document.querySelector('#holdings').textContent = coverage.holdings().map(h => h.ticker).join(', ');
};
coverage.prime(${JSON.stringify(snapshot)});
await coverage.restoreLastGood();
coverage.onChange(paint); scope.onChange(paint);
bindFamilySyncLifecycle(); paint(); setInterval(paint, 1000);
window.testFamily = { coverage, scope }; window.ready = true;
void coverage.refresh();
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (path === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/api/family-portfolio') {
    const reply = () => { res.setHeader('content-type', 'application/json'); res.statusCode = unavailable ? 503 : 200; res.end(JSON.stringify(unavailable ? { ok: false } : payload())); };
    if (pendingReply) pendingReply(reply); else reply();
    return;
  }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json' }[extname(file)] || 'text/plain');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let checks = 0;
const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`PASS ${name}`); };
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date(initialTime) });
  await page.goto(origin);
  await page.waitForFunction(() => window.testFamily?.coverage.meta().syncStatus === 'live');
  check('the shared book adds Sterlite without manual edits', (await page.locator('#holdings').innerText()).includes('STLTECH'));
  check('source period and workbook-vs-trade distinction stay visible', /stated period end.*not live broker trades/.test(await page.locator('#status').innerText()));
  await page.evaluate(async () => { const { readEntry } = await import('/js/core/store.js'); await readEntry('family-portfolio:active:v1'); });
  // Give the real IndexedDB transaction its turn before a document reload.
  await page.waitForFunction(async () => {
    const db = await new Promise(resolve => { const r = indexedDB.open('sattva-cache'); r.onsuccess = () => resolve(r.result); });
    const saved = await new Promise(resolve => { const r = db.transaction('payloads').objectStore('payloads').get('family-portfolio:active:v1'); r.onsuccess = () => resolve(r.result); });
    db.close(); return !!saved;
  });
  unavailable = true;
  await page.reload();
  await page.waitForFunction(() => window.testFamily?.coverage.meta().syncStatus === 'unavailable');
  check('reload during outage retains the actual last-good IndexedDB holdings', (await page.locator('#holdings').innerText()).includes('STLTECH'));
  check('outage never paints old data as freshly checked', /may be out of date/.test(await page.locator('#status').innerText()));
  unavailable = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => window.testFamily.coverage.meta().syncStatus === 'live');
  check('reconnect recovers automatically', await page.evaluate(() => window.testFamily.coverage.has('STLTECH')));
  await page.clock.setSystemTime(new Date(initialTime + 180 * 86400000));
  await page.clock.fastForward(1001);
  check('a tab reopened six months later cannot retain the live label', /check expired/.test(await page.locator('#status').innerText()));
  let release;
  pendingReply = fn => { release = fn; };
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(() => window.testFamily.coverage.meta().syncStatus === 'snapshot');
  check('BFCache restoration shows checking before the network finishes', /saved snapshot/.test(await page.locator('#status').innerText()));
  checkTime += 180 * 86400000;
  // Release the server response only once the request has reached it.
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release); pendingReply = null; release();
  await page.waitForFunction(() => window.testFamily.coverage.meta().syncStatus === 'live');
  check('a new successful check recovers after months away', (await page.locator('#holdings').innerText()).includes('STLTECH'));
  await page.evaluate(() => window.testFamily.scope.remove('portfolio', { ticker: 'STLTECH', name: 'Sterlite Technologies' }, window.testFamily.coverage.baseHoldings()));
  check('browser edits cannot remove a Family Office holding', (await page.locator('#holdings').innerText()).includes('STLTECH'));
  await page.evaluate(() => window.testFamily.scope.reset('portfolio'));
  // A removal below the reconciliation threshold must fail with a warning.
  holdings = [oldHolding];
  await page.evaluate(() => window.testFamily.coverage.refresh());
  check('suspicious portfolio loss retains the previous book with a warning', /may be out of date/.test(await page.locator('#status').innerText()) && (await page.locator('#holdings').innerText()).includes('STLTECH'));
  check('no browser runtime errors', errors.length === 0);
  console.log(`\n${checks} Family sync browser checks passed.`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
