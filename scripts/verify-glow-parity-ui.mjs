// Exercise the real Glow bridge and extensions with local assets and no external APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChangesUI } from './verify-investor-changes-ui.mjs';
// The shared-chip fixture that runs INSIDE this suite's Glow server, so the chips are exercised
// against the real book rather than a standalone fixture. `verify-technical-filters-ui.mjs` is the
// template's own standalone version and serves itself; the two cover different ground and CI runs
// both. Keeping them in one file is what silently dropped this call in a template merge.
import { verifyTechnicalFiltersUI } from './verify-technical-filters-context.mjs';
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
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
try {
  // Ask Research is stood down by default here; this suite drives the live tab, so it says so.
  await page.goto(`${origin}/#/research/ask-research?scope=portfolio&enable_research=1`);
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
    // The owner's case: two trackers the source files under an ACTIVE category, beside one
    // actively managed fund in the same bucket. The trackers must leave Mid Cap; the fund must not.
    ['Foxtrot Nifty Midcap 150 Index Fund', 'Equity : Mid Cap'], ['Golf Nifty Midcap 150 ETF', 'Equity : Mid Cap'],
    ['Hotel Mid Cap Opportunities Fund', 'Equity : Mid Cap'],
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
  assert.equal(await fundRows.count(), 8);
  // ONE TOOLBAR OF FIXED SLOTS. Every control is present all the time, in one order, and picking
  // something moves nothing — the owner's complaint was that the old chip rows reflowed on every
  // press and the category strip scrolled sideways.
  const toolbar = page.locator('[data-mf-filters]');
  assert(await toolbar.isVisible());
  const slots = ['[data-mf-management-row]', '[data-mf-class-select]', '[data-mf-group-select]', '[data-mf-category-select]', '[data-mf-strategy-select]', '[data-mf-measures]', '[data-mf-clear]'];
  const boxes = async () => Promise.all(slots.map((sel) => page.locator(sel).boundingBox()));
  const before = await boxes();
  assert(before.every(Boolean), 'every slot is rendered before anything is chosen');
  for (let i = 1; i < before.length; i++) assert(before[i].x > before[i - 1].x || before[i].y > before[i - 1].y, `slot ${slots[i]} follows ${slots[i - 1]}`);
  assert.equal(await page.locator('[data-mf-categories], [data-mf-category-scroll-by], [data-mf-hierarchy]').count(), 0, 'no chip rows and no scrolling category strip remain');
  const classSelect = page.locator('[data-mf-class-select]');
  const groupSelect = page.locator('[data-mf-group-select]');
  const categorySelect = page.locator('[data-mf-category-select]');
  const optionText = async (select, value) => page.locator(`${select} option[value="${value}"]`).textContent();
  await categorySelect.selectOption('equity-large-cap');
  assert.equal(await fundRows.count(), 2, 'direct category selection works before classification/group selection');
  assert.equal(await classSelect.inputValue(), 'Equity', 'picking a category fills the class beside it');
  assert.equal(await groupSelect.inputValue(), 'Market cap', 'and the group');
  const after = await boxes();
  assert.deepEqual(after.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.width)]), before.map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.width)]), 'no slot moves or resizes when a choice is made');
  await categorySelect.selectOption('equity-flexi-cap');
  assert.equal(await fundRows.count(), 1, 'selecting another category replaces the choice');
  await page.locator('[data-mf-clear]').click();
  assert.equal(await fundRows.count(), 8);
  assert.equal(await classSelect.inputValue(), '', 'Clear empties every slot');

  // ACTIVE / PASSIVE IS THE FIRST CUT, and a tracker the source filed under Mid Cap is not a
  // mid-cap fund's peer: it is shown with the trackers, labelled, with the source's bucket kept.
  assert.match(await page.locator('[data-mf-management="active"]').innerText(), /Active\s*·\s*6/);
  assert.match(await page.locator('[data-mf-management="passive"]').innerText(), /Passive\s*·\s*2/);
  // With nothing chosen the Category list is the whole tree under class · group headings, and the
  // two moved categories carry their explanation there.
  assert.equal(await page.locator('[data-mf-category-select] option[data-mf-refiled="true"]').count(), 2, 'the two moved categories say so on their option');
  assert.match(await page.locator('[data-mf-category-select] option[value="equity-mid-cap-index"]').getAttribute('title'), /files as Equity : Mid Cap/);
  assert.equal(await page.locator('[data-mf-category-select] optgroup').count(), 4, 'the full list is headed by class · group');
  await categorySelect.selectOption('equity-mid-cap');
  assert.equal(await fundRows.count(), 1, 'the source’s Mid Cap category holds only the actively managed fund');
  assert.equal(await page.locator('[data-mf-category-select] option[value="equity-mid-cap-index"]').count(), 0, 'the list then cascades to the chosen group, where the moved category is not');
  await page.locator('[data-mf-management="passive"]').click();
  assert.equal(await fundRows.count(), 2, 'Passive lists the two name-stated trackers');
  assert.match(await page.locator('[data-mf-management="passive"]').innerText(), /Passive\s*·\s*2/, 'the cut’s own counts never move');
  assert.match(await optionText('[data-mf-class-select]', 'Equity'), /Equity \(2\)/, 'classification counts follow the cut above them');
  assert.equal(await page.locator('[data-mf-category-select] option[value="equity-mid-cap"]').count(), 0, 'no active category is offered under Passive');
  assert.equal(await fundRows.filter({ hasText: 'Equity : Mid Cap · shown under Index & smart beta' }).count(), 1, 'the row keeps the source’s bucket and says where it is shown');
  assert.equal(await fundRows.filter({ hasText: 'Equity : Mid Cap · shown under Exchange traded' }).count(), 1);
  assert.match(await fundRows.first().locator('td').nth(1).locator('[title]').first().getAttribute('title'), /source’s own, computed inside its Equity : Mid Cap cohort/, 'every figure of a moved row names the cohort it still belongs to');
  await classSelect.selectOption('Equity');
  await groupSelect.selectOption('Index & smart beta');
  assert.equal(await fundRows.count(), 1);
  await page.locator('[data-mf-management="active"]').click();
  assert.equal(await fundRows.count(), 6);
  assert.equal(await classSelect.inputValue(), '', 'the cut resets the classification beneath it');
  assert.equal(await page.locator('[data-mf-category-select] option[data-mf-refiled="true"]').count(), 0, 'no moved category is offered under Active');
  await page.locator('[data-mf-management=""]').click();
  assert.equal(await fundRows.count(), 8);
  // A group picked from the all-classes list fills the class beside it. (The taxonomy files the
  // fixture's "Debt : Short Duration" under the Duration group; the group is what the list offers.)
  await groupSelect.selectOption('Duration');
  assert.equal(await classSelect.inputValue(), 'Debt');
  assert.equal(await fundRows.count(), 2);
  await page.locator('[data-mf-clear]').click();
  // The search facet agrees with the dropdowns about which cohort a scheme is in.
  await fundInput.fill('mid cap');
  await page.locator('[data-fund-category="Equity : Mid Cap"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-fund-category="Equity : Index · Mid Cap"]').count(), 1, 'the moved category is a facet of its own');
  await page.locator('[data-fund-category="Equity : Mid Cap"]').click();
  assert.equal(await fundRows.count(), 1, 'the source’s Mid Cap facet holds only the actively managed fund');
  await page.locator('[data-fund-search-clear]').click();
  assert.equal(await fundRows.count(), 8);
  await fundInput.press('Escape');

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
  assert.equal(await fundRows.count(), 8);
  await fundInput.press('Escape');
  const strategySelect = page.locator('[data-mf-strategy-select]');
  await strategySelect.selectOption('momentum');
  assert.equal(await fundRows.count(), 1);
  await classSelect.selectOption('Debt');
  assert.match(await optionText('[data-mf-strategy-select]', 'momentum'), /Momentum \(0\)/);
  assert.equal(await fundRows.count(), 0, 'strategy counts respect the selected asset class');
  await strategySelect.selectOption('');
  assert.equal(await fundRows.count(), 2);
  assert.equal(await page.locator('[data-mf-strategy-select] option[value="momentum"]').count(), 0);
  await classSelect.selectOption('');
  await fundInput.fill('equal weight');
  assert.match(await optionText('[data-mf-strategy-select]', 'equal-weight'), /Equal weight \(1\)/i);
  await fundInput.press('Escape');
  await strategySelect.selectOption('equal-weight');
  assert.equal(await fundRows.count(), 1, 'a single matching strategy remains selectable');
  await fundInput.fill('');
  await fundInput.press('Escape');
  await strategySelect.selectOption('');
  assert.equal(await fundRows.count(), 8);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `fund search fits ${width}px`);
    if (process.env.GLOW_SCREENSHOT_PREFIX) await page.screenshot({ path: `${process.env.GLOW_SCREENSHOT_PREFIX}-fund-search-${width}.png` });
  }
  await page.evaluate(() => { location.hash = '#/research/ask-research?scope=portfolio&enable_research=1'; });
  await page.locator('.research-workspace').waitFor();
  assert.equal(await page.locator('[data-fund-search-menu]').count(), 0, 'leaving the table removes the category portal');
  assert.deepEqual(foreignPortfolio, []);
  await verifyChangesUI(page, { base: origin });
  await verifyTechnicalFiltersUI(browser, { base: origin });
  assert.deepEqual(errors, []);
  console.log(`PASS real Glow bridge: ${companies.holdings.length} identities, statement dates and weights, fresh detailed reads, Family Book, My Managers, fund category search, the fixed-slot filter toolbar, the active / passive cut and moved trackers, desktop/mobile, mismatch rejection and recovery.`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
