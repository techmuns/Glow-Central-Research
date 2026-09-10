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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
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
  await page.locator('[data-changes-sources] summary').click();
  assert(await page.locator('[data-changes-sources]').evaluate(el => el.open), 'source details open before the automatic update');
  const before = Number(await page.locator('[data-changes-panel]').getAttribute('data-activity-total'));
  const date = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  payload = { ...seed, checkedAt: new Date(Date.now() + 60000).toISOString(), records: [...seed.records, ['nse-bulk', date, 'TESTPOLL', 'Polling fixture', managers[0].name, 'Buy', 12345, 50, '']] };
  await page.clock.fastForward(61000);
  await page.waitForFunction((before) => Number(document.querySelector('[data-changes-panel]')?.dataset.activityTotal) === before + 1, before);
  assert(await page.locator('[data-changes-sources]').evaluate(el => el.open), 'automatic arrivals preserve expanded source details');
  assert.match(await page.locator('[data-changes-sources]').innerText(), /BSE-BLOCK.*read successfully/s);
  await page.locator('[data-changes-sources] summary').click();
  payload = { ...payload, checkedAt: new Date(Date.now() + 90000).toISOString() };
  await page.evaluate(async () => { const { insider } = await import('/js/data/filings.js'); await insider.refreshSnapshot(); });
  assert.equal(await page.locator('[data-changes-sources]').evaluate(el => el.open), false, 'automatic arrivals preserve a deliberately collapsed source panel');
  const callsBefore = calls;
  await page.goto(`${base}/#/research/insider-trades?scope=universe`);
  await page.waitForSelector('[data-insider-source-link]');
  await page.waitForFunction(async (count) => (await import('/js/data/filings.js')).insider.meta().exchanges?.rowCount === count, payload.records.length);
  assert.equal(await page.locator('[data-exchange-status]').count(), 0, 'Bulk/Block omits the customer-facing status line');
  assert(await page.getByRole('columnheader', { name: 'Exchange', exact: true }).count() > 0);
  assert(await page.locator('[data-insider-source-link]').count() > 0);
  for (const [id, value, label] of [['today', 'today', 'Today'], ['3d', '3', 'Last 3 days'], ['7d', '7', 'Last 7 days'], ['month', 'month', 'This month'], ['3m', '3m', 'Last 3 months'], ['6m', '6m', 'Last 6 months'], ['1y', '1y', 'Last year']]) {
    const select = page.getByRole('combobox', { name: 'Trade period', exact: true });
    assert.equal(await select.locator(`option[value="${value}"]`).innerText(), label);
    await select.selectOption(value);
    assert.equal(await select.inputValue(), value);
    assert(page.url().includes(`range=${id}`), 'date selection is linkable');
    const expected = await page.evaluate(async (id) => {
      const { insider } = await import('/js/data/filings.js');
      const { parseRange, applyRange } = await import('/js/data/date-range.js');
      return applyRange(insider.rows(), parseRange(id)).rows.length;
    }, id);
    const count = await page.locator('[data-row-count]').first().innerText();
    assert.equal(Number(count.replace(/,/g, '').match(/\d+/)?.[0]), expected, `Bulk/Block ${id}`);
    assert(await page.getByText('TESTPOLL', { exact: true }).count() > 0, 'today’s new deal remains in every short window');
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Trade period"]')?.value === '1y');
  await page.getByRole('combobox', { name: 'Trade period', exact: true }).selectOption('all');
  await page.screenshot({ path: '/tmp/glow-exchange-deals-desktop.png', fullPage: true });
  payload = { ...payload, checkedAt: new Date(Date.now() + 120000).toISOString(), sources: payload.sources.map((s) => s.id === 'bse-bulk' ? { ...s, ok: false, error: 'Test outage' } : s) };
  await page.clock.fastForward(61000);
  await page.waitForFunction(async () => (await import('/js/data/filings.js')).insider.meta().exchanges?.summary.includes('Test outage'));
  assert(calls > callsBefore, 'Bulk/Block tab polls the shared exchange feed');
  assert(await page.locator('[data-insider-source-link]').count() > 0, 'partial failure retains rows');
  assert.equal(await page.locator('[data-exchange-status]').count(), 0, 'automatic updates do not restore the status line');
  await page.locator('[data-filings-method]').click();
  assert.match(await page.locator('#modal-content').innerText(), /NSE \+ BSE.*Test outage/s, 'source details remain available in the help panel');
  await page.locator('[data-modal-close]').first().click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: '/tmp/glow-exchange-deals-mobile.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Trade period', exact: true }).selectOption('today');
  const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const afterMidnight = new Date(`${tomorrow}T00:01:00+05:30`);
  await page.clock.setSystemTime(afterMidnight);
  payload = { ...payload, checkedAt: afterMidnight.toISOString(), records: [...payload.records, ['nse-bulk', tomorrow, 'NEXTDAY', 'Midnight fixture', managers[0].name, 'Buy', 100, 50, '']] };
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => [...document.querySelectorAll('tr')].some((row) => row.textContent.includes('NEXTDAY')));
  assert.equal(await page.getByText('TESTPOLL', { exact: true }).count(), 0, 'a live update advances Today past yesterday’s deal');
  assert.equal(await page.getByRole('combobox', { name: 'Trade period', exact: true }).inputValue(), 'today');
  assert.deepEqual(errors, []);
  console.log('PASS exchange UI: short date filters, persisted window, timed update reaches Changes and Bulk/Block, clean Bulk/Block header, exchange column, evidence links, source failures in help, history retention and mobile overflow');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
