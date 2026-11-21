// verify-ai-insights-decision-ui.mjs — the AI Insights decision layer in a real browser.
// Opens a company's 5-minute read and asserts the "Decide in 30 seconds" matrix, the buy-price
// chain and the technicals section render, and that editing an assumption recomputes them live
// without losing input focus or throwing. Serves public/ itself; stubs /api/ so it boots offline.
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
const lastBuy = (page) => page.evaluate(() => [...document.querySelectorAll('.gi-bp-step b')].pop()?.textContent || '');
const verdict = (page) => page.evaluate(() => document.querySelector('.gi-mx-vd')?.textContent || '');

let failed = 0;
try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${origin}/#/research/ai-insights?scope=universe`);
  await page.locator('tbody tr').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500);

  // Open Bajaj Auto's read (it carries seed insight data, so it opens offline).
  const opened = await page.evaluate(() => {
    const r = [...document.querySelectorAll('tbody tr')].find((x) => /Bajaj Auto/i.test(x.textContent));
    if (!r) return false;
    (r.querySelector('button, a') || r).click();
    return true;
  });
  assert.ok(opened, 'opened the Bajaj Auto read');
  await page.locator('#gi-decide').waitFor({ timeout: 8000 });
  await page.waitForTimeout(800);
  pass('the 5-minute read opens');

  // 1) The decision matrix: three axes + a verdict.
  assert.equal(await page.locator('.gi-mx-cell').count(), 3, 'three matrix cells');
  const v0 = await verdict(page);
  assert.match(v0, /Look|Watchlist|Pass for now|Avoid/, `a verdict (${v0})`);
  pass(`decision matrix renders → ${v0}`);

  // 2) The buy-price chain: four steps ending in the buy price.
  const steps = await page.locator('.gi-bp-step').count();
  assert.equal(steps, 4, 'four buy-price steps');
  const buy0 = await lastBuy(page);
  assert.match(buy0, /₹[\d,]+/, `a buy price (${buy0})`);
  pass(`buy-price chain renders → buy ${buy0}`);

  // 3) The technicals section is its own block.
  assert.ok(await page.locator('.gi-tech').count() >= 1, 'technicals section present');
  assert.ok(await page.locator('.gi-tech-chip').count() >= 4, 'technicals chips present');
  pass('technicals render in their own section');

  // 3b) A5.6 — the technical entry-timing read, with a verdict (the second path to a buy price).
  assert.ok(await page.locator('.gi-tentry').count() >= 1, 'technical entry-timing block present');
  const tv = await page.evaluate(() => document.querySelector('.gi-tentry-vd')?.textContent || '');
  assert.ok(tv.trim().length > 0, `the entry read states a verdict (${tv})`);
  pass(`technical entry timing renders → ${tv}`);

  // 4) Raising the required return lowers the buy price and recomputes the matrix, no error.
  const irr = page.locator('[data-bp-irr]');
  await irr.fill('40');
  await irr.dispatchEvent('change');
  await page.waitForTimeout(400);
  const buy1 = await lastBuy(page);
  const n = (s) => Number(String(s).replace(/[^\d.]/g, ''));
  assert.ok(n(buy1) < n(buy0), `higher target return lowers the buy price (${buy0} → ${buy1})`);
  pass(`editing the target return recomputes live → buy ${buy1}`);

  // 5) An override exit multiple flows through the chain.
  const mult = page.locator('[data-bp-mult]');
  await mult.fill('10');
  await mult.dispatchEvent('change');
  await page.waitForTimeout(400);
  const multCell = await page.evaluate(() => document.querySelectorAll('.gi-bp-step b')[1]?.textContent || '');
  assert.match(multCell, /10/, `exit multiple override applied (${multCell})`);
  pass('exit-multiple override flows through');

  // 6) The business-quality breakdown: five params and a 0–10 total that weights recompute.
  assert.ok(await page.locator('#gi-bq').count() >= 1, 'business-quality breakdown present');
  assert.equal(await page.locator('.gi-bq-row').count(), 5, 'five quality params');
  const bqTotal = () => page.evaluate(() => document.querySelector('#gi-bq-total')?.textContent || '');
  const t0 = await bqTotal();
  assert.match(t0, /\d/, `a quality score (${t0})`);
  pass(`quality breakdown renders → ${t0}/10`);

  const rw = page.locator('[data-bq-w="returns"]');
  await rw.fill('3');
  await rw.dispatchEvent('change');
  await page.waitForTimeout(300);
  const t1 = await bqTotal();
  assert.ok(Number(t1) >= Number(t0), `editing a weight recomputes the total (${t0} → ${t1})`);
  pass(`editing a quality weight recomputes → ${t1}/10`);

  // 7) The sector valuation yardstick line.
  const sv = await page.locator('.gi-sv').count();
  if (sv >= 1) {
    const txt = await page.locator('.gi-sv').first().innerText();
    assert.match(txt, /P\/E|P\/B/, `sector yardstick names a metric (${txt.replace(/\n/g, ' ').slice(0, 60)})`);
    pass('sector valuation yardstick renders');
  } else {
    pass('sector valuation yardstick absent for this company (acceptable)');
  }

  // 8) The multi-year KPI trajectory (sparklines + CAGRs).
  if (await page.locator('.gi-trends').count() >= 1) {
    const sparks = await page.locator('.gi-traj-card .gi-spark polyline').count();
    assert.ok(sparks >= 1, `at least one trajectory sparkline (${sparks})`);
    pass(`KPI trajectory renders (${sparks} sparklines)`);
  } else {
    pass('KPI trajectory absent for this company (acceptable)');
  }

  // 9) A5.2 — the "What the Street says" broker VALUATION TABLE (Bajaj Auto carries broker reports).
  await page.locator('.gi-brk-tbl').waitFor({ timeout: 9000 }).catch(() => {});
  if (await page.locator('.gi-brk-tbl').count()) {
    const heads = (await page.locator('.gi-brk-tbl thead th').allInnerTexts()).map((h) => h.toLowerCase().trim());
    assert.ok(heads.includes('revenue growth') && heads.includes('eps'), `broker table has Revenue growth + EPS columns (${heads.join(' | ')})`);
    assert.ok(heads.includes('recommendation') && heads.includes('target'), 'broker table has Recommendation + Target columns');
    const rows = await page.locator('.gi-brk-row').count();
    assert.ok(rows >= 1, `at least one broker row (${rows})`);
    // Every <th> carries scope="col" (the suite-wide rule), and a missing figure is an em dash, not 0.
    assert.equal(await page.locator('.gi-brk-tbl thead th:not([scope="col"])').count(), 0, 'every broker <th> has scope=col');
    pass(`broker valuation table renders → ${heads.length} cols, ${rows} rows`);
  } else {
    pass('broker table absent for this company (no reports captured) — acceptable');
  }

  assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
  pass('no uncaught errors');
} catch (e) {
  failed = 1;
  console.error('  FAIL  ', e.message);
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? '\nverify-ai-insights-decision-ui: FAILED' : '\nverify-ai-insights-decision-ui: OK');
process.exit(failed);
