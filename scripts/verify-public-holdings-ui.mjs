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
  assert.equal(await page.locator('[data-public-row]:visible').count(), 1);
  const source = payload.holdings.find(h => h.personId === 'madhusudan-kela' && h.ticker === 'TIL');
  payload = structuredClone(payload);
  payload.checkedAt = new Date(Date.now() + 600000).toISOString();
  payload.holdings.push({ ...source, id: 'local-new-til-filing', asOf: '2026-09-09', shares: 1200000, stakePct: 1.46 });
  const before = reads;
  await page.clock.fastForward(300100);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-public-row]')].some(row => row.textContent.includes('12,00,000')));
  assert(reads > before, 'visible polling reads the published capture automatically');
  assert.equal(await page.locator('[data-public-search]').inputValue(), 'TIL LIMITED');
  assert.equal(await page.locator('[data-public-row]:visible').count(), 2);
  assert(await page.evaluate(async () => (await import('/js/data/public-holdings.js')).newArrivals().some(r => r.id.includes('local-new-til'))));
  unavailable = true;
  await page.clock.fastForward(300100);
  await page.waitForFunction(() => document.querySelector('[data-public-disclosures]')?.textContent.includes('Latest check failed'));
  assert.equal(await page.locator('[data-public-row]:visible').count(), 2, 'outage retains visible evidence');
  await page.waitForFunction(async () => (await (await import('/js/core/store.js')).readEntry('holdings:public'))?.value.holdings.some(h => h.id === 'local-new-til-filing'));
  await page.reload();
  await page.waitForSelector('[data-changes-ready=true]');
  await open();
  assert.equal(await page.locator('[data-public-row]:visible').count(), 2, 'offline reload restores the last successful public capture');
  assert.match(await page.locator('[data-public-disclosures]').innerText(), /Latest check failed/);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const managers = await import('/js/data/managers.js'); await managers.load(); await (await import('/js/investors/my-managers.js')).openManager('3p-investment-managers'); });
  await page.locator('[data-ws-tab=exchange]').click();
  assert(await page.locator('[data-public-row]').count() > 0);
  assert.match(await page.locator('[data-public-disclosures]').innerText(), /3P INDIA EQUITY FUND/i);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  console.log('PASS public holdings UI: automatic new evidence, search retention, associated-fund alerts, failed refresh, offline reload, manager scope and mobile layout');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
