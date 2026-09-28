// Local browser acceptance: automatic updates, retained search, offline reload and manager scope.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
let payload = JSON.parse(readFileSync(`${root}/data/public-holdings.json`)), unavailable = false, reads = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/data/public-holdings.json') {
    reads++; res.writeHead(unavailable ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(unavailable ? {} : payload)); return;
  }
  if (path.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
  try {
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(path)] || 'text/html');
    res.end(readFileSync(resolve(root, `.${path === '/' ? '/index.html' : path}`)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.clock.install();
  await page.goto(`${origin}/#/research/super-investors/superstar-investors?scope=universe`);
  await page.waitForSelector('[data-changes-ready=true]');
  const open = async () => {
    await page.evaluate(async () => (await import('/js/investors/live.js')).openInvestor('madhusudan-kela'));
    await page.locator('[data-ws-tab=exchange]').click();
    await page.locator('[data-public-search]').fill('TIL LIMITED');
  };
  await open();
  const retained = payload.holdings.filter(h => h.personId === 'madhusudan-kela' && h.kind === 'investor' && h.company === 'TIL LIMITED');
  const source = retained.find(h => h.state === 'latest-disclosure');
  assert(source, 'the fixture includes a latest TIL disclosure');
  assert.equal(await page.locator('[data-public-row]:visible').count(), retained.length);
  payload = structuredClone(payload);
  payload.checkedAt = new Date(Date.now() + 600000).toISOString();
  const nextDay = new Date(Date.parse(`${source.asOf}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  payload.holdings.find(h => h.id === source.id).state = 'historical-disclosure';
  payload.holdings.push({ ...source, id: 'local-new-til-filing', asOf: nextDay, shares: 1200000, stakePct: 1.46 });
  const expectedRows = retained.length + 1;
  const before = reads;
  await page.clock.fastForward(300100);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-public-row]')].some(row => row.textContent.includes('12,00,000')));
  assert(reads > before, 'visible polling reads the published capture automatically');
  assert.equal(await page.locator('[data-public-search]').inputValue(), 'TIL LIMITED');
  assert.equal(await page.locator('[data-public-row]:visible').count(), expectedRows);
  for (const prior of retained) assert((await page.locator('[data-public-disclosures]').innerText()).includes(prior.asOf), `retains the ${prior.asOf} disclosure`);
  assert(await page.evaluate(async () => (await import('/js/data/public-holdings.js')).newArrivals().some(r => r.id.includes('local-new-til'))));
  unavailable = true;
  await page.clock.fastForward(300100);
  await page.waitForFunction(() => document.querySelector('[data-public-disclosures]')?.textContent.includes('Latest check failed'));
  assert.equal(await page.locator('[data-public-row]:visible').count(), expectedRows, 'outage retains visible evidence');
  // readEntry can answer from memory while the async disk write is still pending. Wait for
  // the actual saved record before exercising a reload; do not manufacture a write in the test.
  await page.waitForFunction(() => new Promise(resolve => {
    const request = indexedDB.open('sattva-cache', 1);
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('payloads', 'readonly').objectStore('payloads').get('holdings:public');
      read.onsuccess = () => { db.close(); resolve(read.result?.value.holdings.some(h => h.id === 'local-new-til-filing')); };
      read.onerror = () => { db.close(); resolve(false); };
    };
  }));
  await page.reload();
  await page.waitForSelector('[data-changes-ready=true]');
  await open();
  assert.equal(await page.locator('[data-public-row]:visible').count(), expectedRows, 'offline reload restores the last successful public capture');
  assert.match(await page.locator('[data-public-disclosures]').innerText(), /Latest check failed/);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const managers = await import('/js/data/managers.js'); await managers.load(); await (await import('/js/investors/my-managers.js')).openManager('3p-investment-managers'); });
  await page.locator('[data-ws-tab=exchange]').click();
  assert(await page.locator('[data-public-row]').count() > 0);
  assert.match(await page.locator('[data-public-disclosures]').innerText(), /3P INDIA EQUITY FUND/i);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const firstVisit = await browser.newPage({ serviceWorkers: 'block' });
  firstVisit.on('pageerror', e => errors.push(e.message));
  await firstVisit.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await firstVisit.clock.install();
  await firstVisit.goto(`${origin}/#/research/super-investors/superstar-investors?scope=universe`);
  await firstVisit.waitForSelector('[data-changes-ready=true]');
  await firstVisit.evaluate(async () => (await import('/js/investors/live.js')).openInvestor('madhusudan-kela'));
  await firstVisit.locator('[data-ws-tab=exchange]').click();
  assert.match(await firstVisit.locator('[data-public-disclosures]').innerText(), /temporarily unavailable/);
  unavailable = false;
  await firstVisit.clock.fastForward(300100);
  await firstVisit.waitForSelector('[data-public-row]');
  assert(await firstVisit.locator('[data-public-search]').isVisible(), 'a first visit during an outage recovers in the open view without navigation');
  assert.deepEqual(errors, []);
  console.log('PASS public holdings UI: automatic new evidence, search retention, associated-fund alerts, failed refresh, offline reload, first-visit recovery, manager scope and mobile layout');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
