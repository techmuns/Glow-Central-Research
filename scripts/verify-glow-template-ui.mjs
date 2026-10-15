// Local integration: a warm returning session, shared navigation/scopes, and Glow-only data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SharedWatchlistStore } from '../worker/watchlist-store.mjs';
import { handleGlowPortfolio, handleGlowHoldingSizes } from '../worker/glow-portfolio.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), output = resolve('.cache/sattva-parity');
mkdirSync(output, { recursive: true });
const db = new DatabaseSync(':memory:');
const watchlist = new SharedWatchlistStore({
  sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
  transactionSync: fn => { db.exec('BEGIN'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } },
});
watchlist.watchlistApply([{ op: 'add', ticker: 'SBIN', name: 'State Bank of India', by: 'Glow fixture' }]);
let previous = true;
const send = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const assets = { fetch: async request => new Response(readFileSync(resolve(root, '.' + new URL(request.url).pathname))) };
const smallData = new Set(['/data/portfolio-companies.json', '/data/book.json', '/data/managers.json', '/data/sector-kpis.json']);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin), path = url.pathname;
  if (path === '/api/family-portfolio' || path === '/api/holding-sizes') {
    const response = await (path === '/api/holding-sizes' ? handleGlowHoldingSizes : handleGlowPortfolio)(new Request(url), { ASSETS: assets });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  if (path === '/api/watchlist') return send(res, { ok: true, ...watchlist.watchlistSnapshot() });
  if (path.startsWith('/api/') || path.startsWith('/data/') && !smallData.has(path)) return send(res, { ok: false }, 503);
  if (path === '/sdk-fixture') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('// Local SDK'); return; }
  const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root + sep)) return send(res, {}, 403);
  try {
    let bytes = readFileSync(file);
    if (path === '/sw.js') {
      bytes = bytes.toString().replace(/const MUNSHOT_SDK = .*;/, `const MUNSHOT_SDK = '${origin}/sdk-fixture';`);
      if (previous) bytes = bytes.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}previous-glow-hidden-scope`;');
    }
    if (previous && path === '/js/ui/shell.js') bytes = bytes.toString().replace(
      'scopeControls.hidden = tabModule.meta.scopeIndependent === true && !sheet;',
      'scopeControls.hidden = tabModule.meta.scopeIndependent === true;');
    // Warm the preceding sheet interface: no upload control and explanatory editor paragraphs.
    if (previous && path === '/js/ui/sheet-workbook.js') bytes = bytes.toString()
      .replace(/export const sheetUploadHtml = \(\) => `[\s\S]*?`;/, "export const sheetUploadHtml = () => ''; ")
      .replace("const button = host.querySelector('[data-sheet-upload]');", "const button = host.querySelector('[data-sheet-upload]'); if (!button) return () => {};");
    if (previous && path === '/js/ui/sheet-editor.js') bytes = bytes.toString()
      .replace('${isDate ? \'\' : \'<button type="submit" class="sheet-editor-primary">Save</button>\'}', '<button type="submit" class="sheet-editor-primary">Save</button>')
      .replace("if (isDate) input.addEventListener('change', onSubmit);", '').replace(
      '<p class="sheet-editor-error"', '<p class="sheet-editor-note">Nothing is shown when it is empty — this one is the desk’s to fill.</p><p class="sheet-editor-error"');
    res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(bytes);
  } catch { send(res, {}, 404); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [], foreign = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (/sattva-family|sattva-central-research/.test(url.hostname)) foreign.push(url.href);
    return url.origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/#/research/portfolio?scope=portfolio`);
  await page.locator('[data-sheet-table="portfolio"] tbody tr[data-row-key]').first().waitFor();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.reload();
  await page.locator('[data-sheet-table="portfolio"] tbody tr[data-row-key]').first().waitFor();
  assert.equal(await page.locator('[data-scope-controls]').isVisible(), false, 'reproduce the cached hidden scope selector');
  assert.equal(await page.locator('[data-sheet-upload]').count(), 0, 'warm the interface without Upload latest');
  await page.locator('[data-sheet-key="FRACTAL"][data-sheet-field="buyPrice"]').click();
  assert.equal(await page.locator('.sheet-editor-note').count(), 1, 'warm the preceding verbose editor');
  await page.locator('[data-sheet-input]').press('Escape');
  const before = await page.locator('[data-sheet-table="portfolio"] tbody tr[data-row-key]').evaluateAll(rows => rows.map(row => row.dataset.rowKey));
  const dateCell = page.locator('[data-sheet-table="portfolio"] [data-sheet-field="dateBought"]').first();
  await dateCell.click();
  assert.equal(await page.locator('[data-sheet-input]').getAttribute('type'), 'date', 'warm the preceding calendar editor');
  await page.locator('[data-sheet-input]').fill('2024-02-28');
  assert.equal(await page.locator('.sheet-editor button[type="submit"]').count(), 1, 'reproduce the calendar that still requires Save');
  await page.locator('[data-sheet-cancel]').click();
  previous = false;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.locator('[data-scope-controls]').waitFor({ timeout: 30000 });
  await page.locator('[data-sheet-table="portfolio"] tbody tr[data-row-key]').first().waitFor();
  assert(await page.locator('[data-sheet-upload]').isVisible(), 'returning session receives Upload latest');
  await page.locator('[data-sheet-key="FRACTAL"][data-sheet-field="buyPrice"]').click();
  assert.equal(await page.locator('.sheet-editor-note, .sheet-editor-hint').count(), 0, 'returning session receives the compact editor');
  await page.locator('[data-sheet-input]').press('Escape');
  assert(!(await page.evaluate(() => caches.keys())).some(key => key.includes('previous-glow-hidden-scope')));
  await dateCell.click();
  assert.equal(await page.locator('[data-sheet-input]').getAttribute('type'), 'date', 'the returning session receives the calendar editor');
  assert.equal(await page.locator('.sheet-editor button[type="submit"]').count(), 0, 'returning date editors no longer require Save');
  await page.screenshot({ path: resolve(output, 'glow-date-picker.png') });
  await page.locator('[data-sheet-input]').fill('2024-02-29');
  await page.locator('.sheet-editor').waitFor({ state: 'detached' });
  await dateCell.click();
  assert.equal(await page.locator('[data-sheet-input]').inputValue(), '2024-02-29', 'the selected date survives the table repaint');
  await page.locator('[data-sheet-cancel]').click();
  const referenceCell = page.locator('[data-sheet-table="portfolio"] [data-sheet-field="reference"]').first();
  await referenceCell.click();
  assert.equal(await page.locator('[data-sheet-input]').getAttribute('type'), 'date', 'the returning session also receives the reference calendar');
  await page.locator('[data-sheet-input]').fill('2030-03-31');
  await page.locator('.sheet-editor').waitFor({ state: 'detached' });
  await referenceCell.click();
  assert.equal(await page.locator('[data-sheet-input]').inputValue(), '2030-03-31', 'future reference years remain selectable');
  await page.locator('[data-sheet-cancel]').click();
  const labels = await page.locator('#tabbar-mount [data-tab-id]').evaluateAll(tabs => tabs.map(tab => tab.textContent.trim()));
  assert.deepEqual(labels, ['Alerts', 'Portfolio', 'Watchlist', 'Announcements', 'Earnings', 'Screens', 'Mutual Funds', 'News', 'Super Investors']);
  const scope = page.locator('[data-scope-controls]');
  for (const name of ['Portfolio', 'Watchlist', 'Universe']) assert(await scope.getByRole('button', { name, exact: true }).isVisible());
  await scope.getByRole('button', { name: 'Universe', exact: true }).click();
  await page.waitForURL(/scope=universe/);
  await page.waitForFunction(() => !document.querySelector('#content-host').inert);
  const after = await page.locator('[data-sheet-table="portfolio"] tbody tr[data-row-key]').evaluateAll(rows => rows.map(row => row.dataset.rowKey));
  assert.deepEqual(after, before, 'global research scope cannot change the Portfolio sheet membership');
  await page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await page.locator('[data-sheet-table="watchlist"] tbody tr[data-row-key="SBIN"]').waitFor();
  assert(await scope.isVisible());
  await scope.getByRole('button', { name: 'Portfolio', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#content-host').inert);
  assert.equal(await page.locator('[data-sheet-table="watchlist"] tbody tr[data-row-key]').count(), 1);
  const data = await page.evaluate(async () => {
    const coverage = await import('/js/data/coverage.js');
    const scope = await import('/js/data/scope.js');
    const own = coverage.holdings().find(h => h.ticker && h.ticker !== 'SBIN').ticker;
    const rows = [{ ticker: own }, { ticker: 'SBIN' }, { ticker: 'OUTSIDE' }];
    const bridge = await import('/js/research/portfolio-bridge.js');
    return { portfolio: scope.filterByScope(rows, 'portfolio').map(r => r.ticker), watchlist: scope.filterByScope(rows, 'watchlist').map(r => r.ticker),
      universe: scope.filterByScope(rows, 'universe').map(r => r.ticker), managers: await bridge.readManagerWorkbook(), own };
  });
  assert.deepEqual(data.portfolio, [data.own, 'SBIN']); assert.deepEqual(data.watchlist, ['SBIN']); assert.equal(data.universe.length, 3);
  assert.equal(data.managers.sourceKind, 'glow-statements'); assert(data.managers.managers.length > 0);
  assert.match(data.managers.coverage.note, /not current broker ownership/);
  const refusedForeign = await page.evaluate(async () => {
    const sizes = await import('/js/data/holding-sizes.js'), realFetch = window.fetch;
    const own = await (await realFetch('/api/holding-sizes')).json();
    try {
      window.fetch = async () => Response.json({ ...own, sizes: { ...own.sizes, sourceKind: 'other-family', valuation: 'workbook', basis: 'listed-market-value' } });
      try { await sizes.readHoldingSizes(undefined, { force: true }); return false; } catch { return true; }
    } finally { window.fetch = realFetch; await sizes.readHoldingSizes(undefined, { force: true }); }
  });
  assert(refusedForeign, 'a valid but foreign workbook cannot replace Glow statement holdings');
  await page.goto(`${origin}/#/research/portfolio?scope=portfolio`);
  await page.locator('[data-sheet-table="portfolio"] tbody tr').first().waitFor();
  await page.waitForFunction(() => !document.querySelector('#content-host').inert);
  await page.screenshot({ path: resolve(output, 'glow-parity-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert(await scope.getByRole('button', { name: 'Universe', exact: true }).isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const uploadBox = await page.locator('[data-sheet-upload]').boundingBox();
  assert(uploadBox.x >= 0 && uploadBox.x + uploadBox.width <= 390, 'the entire Portfolio upload button stays reachable on mobile');
  await page.screenshot({ path: resolve(output, 'glow-parity-mobile-dark.png'), fullPage: false });
  assert.deepEqual(foreign, []); assert.deepEqual(errors, []);
  console.log(`PASS warm-session scope restoration, Sattva navigation plus two unchanged sheets, three research scopes, Glow manager statements, responsive light/dark layout and no foreign family requests (${before.length} portfolio companies).`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); db.close(); }
