import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const seed = JSON.parse(readFileSync(new URL('../public/data/exchange-deals.json', import.meta.url)));
const managers = JSON.parse(readFileSync(new URL('../public/data/managers.json', import.meta.url))).managers;
const root = fileURLToPath(new URL('../public/', import.meta.url));
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false}'); return; }
  try {
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' })[extname(path)] || 'text/html');
    res.end(readFileSync(resolve(root, `.${path === '/' ? '/index.html' : path}`)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  let payload = structuredClone(seed), calls = 0;
  await page.route('**/api/bulk-block-deals', async (route) => { calls++; await route.fulfill({ json: payload }); });
  await page.route('**/api/bulk-block-deals/refresh*', (route) => route.fulfill({ json: { ok: true, dispatched: false } }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
  await page.goto(`${base}/#/research/super-investors/superstar-investors?scope=portfolio`);
  await page.waitForSelector('[data-investor-changes][data-changes-ready=true]');
  assert.match(await page.locator('[data-exchange-status]').innerText(), /NSE \+ BSE/);
  const before = Number(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'));
  const date = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  payload = { ...seed, checkedAt: new Date(Date.now() + 60000).toISOString(), records: [...seed.records, ['nse-bulk', date, 'TESTPOLL', 'Polling fixture', managers[0].name, 'Buy', 12345, 50, '']] };
  await page.clock.fastForward(61000);
  await page.waitForFunction((before) => Number(document.querySelector('[data-changes-panel]')?.dataset.activityTotal) === before + 1, before);
  await page.locator('[data-changes-sources] summary').click();
  assert.match(await page.locator('[data-changes-sources]').innerText(), /BSE-BLOCK.*read successfully/s);
  const callsBefore = calls;
  await page.goto(`${base}/#/research/insider-trades?scope=universe`);
  await page.waitForSelector('[data-exchange-status]');
  await page.waitForFunction(() => document.querySelector('[data-exchange-status]')?.textContent.includes('48,423'));
  assert(await page.getByRole('columnheader', { name: 'Exchange', exact: true }).count() > 0);
  assert(await page.locator('[data-insider-source-link]').count() > 0);
  await page.screenshot({ path: '/tmp/glow-exchange-deals-desktop.png', fullPage: true });
  payload = { ...payload, checkedAt: new Date(Date.now() + 120000).toISOString(), sources: payload.sources.map((s) => s.id === 'bse-bulk' ? { ...s, ok: false, error: 'Test outage' } : s) };
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => document.querySelector('[data-exchange-status]')?.textContent.includes('Test outage'));
  assert(calls > callsBefore, 'Bulk/Block tab polls the shared exchange feed');
  assert(await page.locator('[data-insider-source-link]').count() > 0, 'partial failure retains rows');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: '/tmp/glow-exchange-deals-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS exchange UI: timed update reaches Changes and Bulk/Block, exchange column, evidence links, failure visibility, history retention and mobile overflow');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
