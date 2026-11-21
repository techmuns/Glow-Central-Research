// verify-nav-declutter-ui.mjs — the decluttered default navigation.
//
// The desk asked (20 Nov) to open on a short core set behind a "More" picker; the Screener (the funnel)
// joined the core on 21 Nov so it is never buried (the Framework stays optional — it is a manual grid,
// empty until scored). This drives the REAL app shell (not a component fixture): a fresh device shows
// the four core sections, the rest sit behind a visible "More" button, a hidden section
// a reader deep-links to still shows, the picker turns one on live and remembers it, Reset restores
// the three, and AI Recommendations is no longer an Alerts subtab. Presentation-only and device-local.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const root = resolve('public');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

// Serve the committed site; stub every /api/ call so the shell boots offline from its snapshots.
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
const navIds = (page) => page.locator('#tabbar-mount [data-tab-id]').evaluateAll((t) => t.map((x) => x.dataset.tabId));
const subIds = (page) => page.locator('#subview-mount [data-tab-id]').evaluateAll((t) => t.map((x) => x.dataset.tabId));

try {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/#/research/ai-alerts`);
  await page.locator('#tabbar-mount [data-tab-id="alerts"]').waitFor();
  await page.locator('#subview-mount [data-tab-id="ai-alerts"]').waitFor();

  // 1) A fresh device shows only the three core sections.
  assert.deepEqual((await navIds(page)).sort(), ['alerts', 'funnel', 'portfolio', 'watchlist'], 'fresh device shows the four core sections');
  assert.equal(await page.locator('#tabbar-mount [data-tab-id="earnings"]').count(), 0, 'Earnings is hidden by default');
  assert.equal(await page.locator('#tabbar-mount [data-tab-id="announcements"]').count(), 0, 'Announcements is hidden by default');
  pass('default nav is Alerts / Portfolio / Watchlist / Screener');

  // 2) The rest sit behind a visible "More" button carrying a hidden count; "+ Add tab" is untouched.
  const more = page.locator('[data-nav-more]');
  assert.equal(await more.isHidden(), false, 'the More button is shown while sections are hidden');
  assert.match((await page.locator('[data-nav-more] [data-nav-more-count]').textContent()).trim(), /\d+/, 'More carries a hidden-section count');
  assert.equal(await page.locator('[data-add-saved-tab]').count(), 1, 'the + Add tab control is unchanged');
  pass('hidden sections sit behind a counted More button; Add tab kept');

  // 3) AI Recommendations is deprioritised out of the Alerts subtabs (route still resolves elsewhere).
  assert.deepEqual(await subIds(page), ['ai-alerts', 'ai-insights', 'daily-alerts'], 'Recommendations is no longer an Alerts subtab');
  pass('Alerts subtabs are AI Alerts / AI Insights / All Alerts');

  // 4) A hidden section the reader deep-links to still shows and is selected — the page stays reachable.
  await page.evaluate(() => { location.hash = '#/research/super-investors'; });
  await page.locator('#tabbar-mount [data-tab-id="super-investors"][aria-selected="true"]').waitFor();
  assert((await navIds(page)).includes('super-investors'), 'a hidden section the reader is on still shows');
  pass('a deep link to a hidden section stays reachable and selected');
  await page.evaluate(() => { location.hash = '#/research/ai-alerts'; });
  await page.locator('#tabbar-mount [data-tab-id="alerts"][aria-selected="true"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#tabbar-mount [data-tab-id]').length === 4);

  // 5) The More picker turns a section on, live, and the choice persists across a reload.
  await more.click();
  await page.locator('.nav-more [data-nav-toggle="earnings"]').check();
  await page.locator('#tabbar-mount [data-tab-id="earnings"]').waitFor();
  pass('the More picker adds a section to the nav live');
  await page.reload();
  await page.locator('#tabbar-mount [data-tab-id="earnings"]').waitFor();
  assert((await navIds(page)).includes('earnings'), 'the chosen section persists across reload');
  pass('the choice is remembered on this device');

  // 6) Reset returns to the three core sections.
  await page.locator('[data-nav-more]').click();
  await page.locator('.nav-more [data-nav-reset]').click();
  await page.waitForFunction(() => document.querySelectorAll('#tabbar-mount [data-tab-id]').length === 4);
  assert.deepEqual((await navIds(page)).sort(), ['alerts', 'funnel', 'portfolio', 'watchlist'], 'Reset returns to the four core sections');
  pass('Reset to default restores the four core sections');

  assert.deepEqual(errors, [], `no uncaught page errors (saw: ${errors.join(' | ')})`);
  pass('zero page errors');
} finally {
  await browser.close();
  server.close();
}
console.log('\nAll nav-declutter checks passed');
