// Exercise the real Glow bridge and extensions with local assets and no external APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChangesUI } from './verify-investor-changes-ui.mjs';
import { handleGlowPortfolio } from '../worker/glow-portfolio.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const sourceBook = JSON.parse(readFileSync(resolve(root, 'data/book.json')));
const companies = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json')));
let mismatch = false, bookReads = 0, revision = null;
const readAsset = path => {
  if (path === '/data/book.json') {
    bookReads++;
    return JSON.stringify({ ...sourceBook,
      ...(revision ? { builtFrom: revision, sourcePublishedAt: new Date().toISOString() } : {}),
      ...(mismatch ? { builtFrom: 'mismatched' } : {}) });
  }
  if (path === '/data/portfolio-companies.json' && revision)
    return JSON.stringify({ ...companies, sourceCommit: { ...companies.sourceCommit, sha: revision } });
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) throw Error('Outside public assets');
  return readFileSync(file);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/family-portfolio') {
    const response = await handleGlowPortfolio(new Request(`http://${req.headers.host}${path}`), {
      ASSETS: { fetch: async request => new Response(readAsset(new URL(request.url).pathname)) },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  if (path.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"Offline fixture"}'); return; }
  try {
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] || (path === '/' ? 'text/html' : 'application/octet-stream'));
    res.end(readAsset(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const errors = [], foreignPortfolio = [];
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (/sattva-family|sattva-central-research/.test(url.hostname)) foreignPortfolio.push(url.origin);
  return url.origin === origin ? route.continue() : route.fulfill({ status: 503, body: 'External requests disabled' });
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${origin}/#/research/ask-research?scope=portfolio`);
  await page.locator('.research-workspace').waitFor();
  const result = await page.evaluate(async () => {
    const bridge = await import('/js/research/portfolio-bridge.js');
    const reply = await bridge.readResearchPortfolio('What are my largest holdings?');
    const coverage = await import('/js/data/coverage.js');
    return { reply, holdings: coverage.baseHoldings(), frames: [...document.querySelectorAll('iframe')].map(f => f.src) };
  });
  assert.equal(result.reply.holdings.length, companies.holdings.length);
  assert.deepEqual(result.reply.holdings.map(h => h.isin).sort(), companies.holdings.map(h => h.isin).sort());
  assert.equal(result.reply.sizes.basis, 'statement-equity-value');
  assert.equal(result.reply.sizes.bookAsOf, sourceBook.asOf);
  assert.equal(result.reply.sizes.complete, true);
  assert.match(result.reply.reading.answer, /equity statement-book weights/);
  assert(result.frames.includes(`${origin}/glow-bridge.html`));
  assert.equal(result.holdings.length, companies.holdings.length);
  await page.evaluate(async () => {
    const bridge = await import('/js/research/portfolio-bridge.js');
    window.glowBookEvents = [];
    bridge.onPortfolioInvalidation(version => window.glowBookEvents.push(['invalidated', version]));
    bridge.onPortfolioReady(version => window.glowBookEvents.push(['ready', version]));
  });
  revision = 'glow-next-source-fixture';
  await page.evaluate(async () => (await import('/js/data/family-session.js')).refreshFamilySession());
  await page.waitForFunction(() => window.glowBookEvents.some(([type]) => type === 'ready'));
  const transitions = await page.evaluate(() => window.glowBookEvents);
  assert.equal(transitions[0][0], 'invalidated');
  assert.deepEqual(transitions[1], ['ready', transitions[0][1]], 'a background revision change announces adoption so AI Alerts can resume');
  const readsBefore = bookReads;
  const detail = await page.evaluate(async () => (await import('/js/research/portfolio-bridge.js')).readResearchPortfolio('What is my cost basis?'));
  assert(bookReads > readsBefore, 'detailed questions re-read the real statement asset');
  assert.match(detail.reading.answer, /Null cost or P&L is unavailable, never zero/);
  assert.match(detail.reading.answer, /not a live broker/);
  for (const [tab, selector] of [['family-book', '[data-score-table]'], ['super-investors', '[data-managers-panel]:not([data-managers-loading])']]) {
    await page.evaluate(tab => { location.hash = `#/research/${tab}?scope=portfolio`; }, tab);
    if (tab === 'super-investors') {
      await page.locator('[data-live-section-tabs] [data-tab-id=my-managers]').waitFor();
      await page.locator('[data-live-section-tabs] [data-tab-id=my-managers]').click();
    }
    await page.locator(selector).waitFor();
    if (tab === 'super-investors') assert.equal(await page.locator('[data-live-panel]').getAttribute('data-live-panel'), 'my-managers');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(100);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${tab} page fits ${width}px`);
      if (tab === 'super-investors') assert(await page.locator('[data-open-manager]').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().right <= innerWidth)), 'manager cards remain inside the viewport without clipping');
      if (process.env.GLOW_SCREENSHOT_PREFIX) await page.screenshot({ path: `${process.env.GLOW_SCREENSHOT_PREFIX}-${tab}-${width}.png` });
    }
  }
  mismatch = true;
  const failed = await page.evaluate(async () => {
    const bridge = await import('/js/research/portfolio-bridge.js');
    try { await bridge.readResearchPortfolio('What are my largest holdings?'); return null; }
    catch (error) { return error.message; }
  });
  assert(failed, 'a mismatched source revision stops portfolio questions');
  mismatch = false;
  const recovered = await page.evaluate(async () => (await import('/js/research/portfolio-bridge.js')).readResearchPortfolio('What are my largest holdings?'));
  assert.equal(recovered.holdings.length, companies.holdings.length);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('weightPct')), false);
  // Keep the concurrently merged Glow category picker working with the upgraded
  // shared table (virtual rows, bookmarks and cached searches).
  const funds = [
    ['Alpha Large Cap Fund', 'Equity : Large Cap'], ['Bravo Momentum Fund', 'Equity : Large Cap'],
    ['Delta Debt Fund', 'Debt : Short Duration'], ['Echo Debt Fund', 'Debt : Short Duration'],
    ['Zeta Equal Weight Fund', 'Equity : Flexi Cap'],
  ].map(([fundName, classification], i) => ({ schemecode: `FIXTURE${i}`, fundName, classification,
    plan: 'direct', option: 'growth', cohortKey: `${classification} | direct | growth`,
    returns: { '1Y': { return: i + 1, rank: null, peerCount: null, statsAvailable: false } } }));
  await page.route('https://amfibeas.fixture/**', route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ asOfDate: '2026-09-08',
      generatedAt: new Date().toISOString(), source: 'AmfiBeas local fixture', periods: ['1Y'], total: funds.length, count: funds.length, funds }) }));
  await page.evaluate(() => {
    localStorage.setItem('sattva:amfibeas-base', 'https://amfibeas.fixture');
    location.hash = '#/research/mutual-funds/all-schemes?scope=universe';
  });
  const fundInput = page.locator('#content-host [data-fund-search] input');
  await fundInput.waitFor();
  const fundRows = page.locator('#content-host tr[data-row-key]');
  assert.equal(await fundRows.count(), 5);
  const categoryBar = page.locator('[data-mf-categories]');
  assert(await categoryBar.isVisible());
  await categoryBar.locator('[data-mf-category="equity-large-cap"]').click();
  assert.equal(await fundRows.count(), 2, 'direct category selection works before classification/group selection');
  await categoryBar.locator('[data-mf-category="equity-flexi-cap"]').click();
  assert.equal(await fundRows.count(), 1, 'selecting another category replaces the direct choice');
  await categoryBar.locator('[data-mf-category=""]').click();
  assert.equal(await fundRows.count(), 5);

  await fundInput.fill('debt short duration');
  await page.locator('[data-fund-category="Debt : Short Duration"]').waitFor({ state: 'visible' });
  await fundInput.press('Enter');
  assert.equal(await fundRows.count(), 2);
  await fundInput.fill('equity large cap');
  await page.locator('[data-fund-category="Equity : Large Cap"]').click();
  assert.equal(await fundRows.count(), 4, 'multiple fund categories combine by OR');
  assert.equal(await page.locator('[data-fund-category-remove]').count(), 2);
  await page.locator('[data-mf-measure]').last().click();
  assert.equal(await page.locator('[data-fund-category-remove]').count(), 2, 'category selections survive measure repaints');
  assert.equal(await fundRows.count(), 4);
  await fundInput.fill('alpha');
  assert.equal(await fundRows.count(), 1, 'scheme text narrows the selected categories');
  await fundInput.fill('');
  await page.locator('[data-fund-search-clear]').click();
  assert.equal(await fundRows.count(), 5);
  await fundInput.press('Escape');
  await page.locator('[data-mf-strategy="momentum"]').click();
  assert.equal(await fundRows.count(), 1);
  await page.locator('[data-mf-class="Debt"]').click();
  assert.match(await page.locator('[data-mf-strategy="momentum"]').innerText(), /Momentum\s*·\s*0/);
  assert.equal(await fundRows.count(), 0, 'strategy counts respect the selected asset class');
  await page.locator('[data-mf-strategy=""]').click();
  assert.equal(await fundRows.count(), 2);
  assert.equal(await page.locator('[data-mf-strategy="momentum"]').count(), 0);
  await page.locator('[data-mf-class=""]').click();
  await fundInput.fill('equal weight');
  assert.match(await page.locator('[data-mf-strategy="equal-weight"]').innerText(), /Equal weight\s*·\s*1/i);
  await fundInput.press('Escape');
  await page.locator('[data-mf-strategy="equal-weight"]').click();
  assert.equal(await fundRows.count(), 1, 'a single matching strategy remains selectable');
  await fundInput.fill('');
  await fundInput.press('Escape');
  await page.locator('[data-mf-strategy=""]').click();
  assert.equal(await fundRows.count(), 5);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `fund search fits ${width}px`);
    if (process.env.GLOW_SCREENSHOT_PREFIX) await page.screenshot({ path: `${process.env.GLOW_SCREENSHOT_PREFIX}-fund-search-${width}.png` });
  }
  await page.evaluate(() => { location.hash = '#/research/ask-research?scope=portfolio'; });
  await page.locator('.research-workspace').waitFor();
  assert.equal(await page.locator('[data-fund-search-menu]').count(), 0, 'leaving the table removes the category portal');
  assert.deepEqual(foreignPortfolio, []);
  await verifyChangesUI(page, { base: origin });
  assert.deepEqual(errors, []);
  console.log(`PASS real Glow bridge: ${companies.holdings.length} identities, statement dates and weights, fresh detailed reads, Family Book, My Managers, fund category search, desktop/mobile, mismatch rejection and recovery.`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
