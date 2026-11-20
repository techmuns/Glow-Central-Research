// verify-funnel-ui.mjs — the Screening Funnel, driven in a real browser against the committed site.
//
// Asserts the two-pane funnel renders, the stages narrow, clicking a stage filters the table, a live
// threshold edit moves the counts without a reload, Match ANY loosens the quantitative cut, and the
// page runs with no uncaught error. Serves public/ itself and stubs /api/ so it boots offline.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const root = resolve('public');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  res.setHeader('cache-control', 'no-cache');
  if (path.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  try {
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (file !== resolve(root, 'index.html') && !file.startsWith(root + sep)) throw Error('bad path');
    const body = readFileSync(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const pass = (m) => console.log('  PASS ', m);
const count = (page, id) => page.evaluate((i) => Number(document.querySelector(`[data-fnl-count="${i}"]`)?.textContent || '0'), id);

let failed = 0;
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${origin}/#/research/funnel?scope=universe`);
  await page.locator('.fnl-grid').waitFor({ timeout: 30000 });
  await page.locator('.fnl-bar').first().waitFor();
  await page.waitForTimeout(1500);

  // 1) Six stages, and the funnel narrows.
  const bars = await page.locator('.fnl-bar').count();
  assert.equal(bars, 6, 'six funnel stages');
  const universe = await count(page, 'universe');
  const mcap = await count(page, 'marketCap');
  const quant = await count(page, 'quant');
  assert.ok(universe > 200, `universe populated (${universe})`);
  assert.ok(mcap > 0 && mcap < universe, `market cap narrows (${universe} -> ${mcap})`);
  assert.ok(quant > 0 && quant <= mcap, `quantitative narrows (${mcap} -> ${quant})`);
  pass(`funnel narrows ${universe} -> ${mcap} -> ${quant}`);

  // 2) The table shows the selected stage's companies.
  const rows = await page.locator('.fnl-right tbody tr:not([aria-hidden="true"])').count();
  assert.ok(rows > 0, 'table has rows');
  pass(`table shows ${rows} rows`);

  // 3) Clicking a stage selects it and shows its editor.
  await page.click('[data-fnl-stage="sector"]');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.fnl-bar-active .fnl-bar-label').textContent(), 'Sector exclude', 'sector stage active');
  assert.match(await page.locator('.fnl-ed-head h4').first().textContent(), /Exclude sectors/, 'sector editor shown');
  pass('stage click selects the stage and its editor');

  // 4) A live threshold edit moves the quantitative count without a reload.
  await page.click('[data-fnl-stage="quant"]');
  await page.waitForTimeout(400);
  const before = await count(page, 'quant');
  const min = page.locator('.fnl-crit[data-fnl-idx="0"] [data-fnl-field="min"]').first();
  await min.fill('45');
  await page.waitForTimeout(400);
  const after = await count(page, 'quant');
  assert.ok(after < before, `raising a threshold shrinks the cut (${before} -> ${after})`);
  pass(`live threshold edit: quant ${before} -> ${after}`);

  // 5) Match ANY is looser than Match ALL.
  await page.click('[data-fnl-match="any"]');
  await page.waitForTimeout(400);
  const anyCount = await count(page, 'quant');
  assert.ok(anyCount >= after, `Match ANY loosens (${after} -> ${anyCount})`);
  pass(`Match ANY loosens to ${anyCount}`);

  // 6) No uncaught errors.
  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  pass('no uncaught errors');
} catch (e) {
  failed = 1;
  console.error('  FAIL  ', e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nverify-funnel-ui: FAILED' : '\nverify-funnel-ui: OK');
process.exit(failed);
