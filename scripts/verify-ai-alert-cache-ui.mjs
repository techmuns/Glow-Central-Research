#!/usr/bin/env node
// Returning reader, real service worker and real Glow statement bridge. Local only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glowPortfolio, glowPositionReply } from '../public/js/data/glow-book-contract.js';
import { noteContent, noteItem } from '../public/js/data/alert-notes-shared.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const companies = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json')));
const book = JSON.parse(readFileSync(resolve(root, 'data/book.json')));
const expected = glowPositionReply(await glowPortfolio(companies, book), book);
const tickers = expected.holdings.filter(h => h.ticker).sort((a, b) => b.weightPct - a.weightPct).slice(0, 10).map(h => h.ticker);
if (!tickers.includes('INDIANB')) tickers.push('INDIANB');
const html = `<!doctype html><html><head><title>Alert filter fixture</title><link rel="stylesheet" href="/css/tailwind.css"></head>
<body><main id="root"></main><script type="module">
if (sessionStorage.getItem('start-alerts')) {
  const coverage = await import('/js/data/coverage.js');
  coverage.prime(await (await fetch('/data/portfolio-companies.json')).json());
  await (await import('/js/data/technicals.js')).load();
  const tab = await import('/js/tabs/ai-alerts.js');
  window.showScope = (scope) => {
    sessionStorage.setItem('alert-scope', scope);
    tab.destroy(); tab.render({root: document.querySelector('#root'), scope, params:{}});
  };
  window.showScope(sessionStorage.getItem('alert-scope') || 'portfolio');
}
</script></body></html>`;
const feedModule = `
import { currentDay } from '../ui/ai-alert-utils.js';
export { currentDay as today } from '../ui/ai-alert-utils.js';
export const onChange = () => () => {};
export async function readCachedAlertWindow() { return null; }
export async function collect({scope,holdings,onPartial}) {
  const day=currentDay();
  const feeds=['earnings','announcements','insider'].map(id=>({id,status:'ok',reachesToday:true}));
  const events=holdings.filter(h=>${JSON.stringify(tickers)}.includes(h.ticker)).flatMap(h=>feeds.filter(({id})=>id==='announcements').map(({id})=>({
    id:h.ticker+'-'+id,ticker:h.ticker,company:h.name,day,time:h.ticker==='INDIANB'?'15:00':'10:00',
    feed:id,feedLabel:id,importance:'high',direction:'negative',headline:id==='announcements'?'Dividend recommendation':h.name+': material risk',tab:'daily-alerts',
    ...(id==='announcements'?{time:h.ticker==='INDIANB'?'15:01':'10:01',filingSubject:'Dividend recommendation',filingSubCategory:'Dividend',
      filingDescription:'The board recommended a dividend of Rs 5 per share for FY26. The record date is 1 October 2026 and payment is proposed for 15 October 2026. Shareholder approval is required before payment; the proposal covers all fully paid equity shares.'}:{})
  })));
  if (scope !== 'portfolio') events.push({...events[0], id:'outside-book', ticker:'OUTSIDE', company:'Outside the book'});
  const report={scope,day,feeds,events,pending:0}; onPartial?.({...report,pending:1}); return report;
}`;
let legacy = true, releaseBook, holdBook = false, bookReads = 0, unavailable = false, incompleteBook = false;
let notePosts = 0;
const savedNotes = new Map();
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
  if (pathname === '/' || pathname === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (pathname === '/sdk-fixture') { res.setHeader('content-type', 'text/javascript'); res.end('// Local public SDK'); return; }
  if (pathname === '/api/alert-notes') {
    notePosts++;
    let body = ''; for await (const chunk of req) body += chunk;
    const notes = {};
    for (const raw of JSON.parse(body).items) {
      const item = noteItem(raw), key = noteContent(item), stored = savedNotes.has(key);
      if (!stored) savedNotes.set(key, 'The dividend is proposed, with shareholder approval still required.');
      notes[item.id] = { note: savedNotes.get(key), stored, model: 'offline-fixture' };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, notes, missing: {} })); return;
  }
  if (pathname.startsWith('/api/')) { res.writeHead(503); res.end('{}'); return; }
  if (pathname === '/data/book.json') {
    bookReads++;
    if (holdBook) await new Promise(done => { releaseBook = done; });
    if (unavailable) { res.writeHead(503); res.end('{}'); return; }
  }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.css':'text/css', '.svg':'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    let body = readFileSync(file);
    if (pathname === '/data/book.json' && incompleteBook) {
      const partial = structuredClone(book);
      partial.positions.find(position => position.assetClass === 'Equity').marketValue = null;
      body = JSON.stringify(partial);
    }
    if (pathname === '/js/data/daily-alerts.js') body = feedModule;
    if (pathname === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = '[^']+';/, `const MUNSHOT_SDK = '${origin}/sdk-fixture';`);
      if (legacy) body = body.replace(/(const CACHE_NAME = `\$\{CACHE_PREFIX\})[^`]+(`;)/, '$1legacy-alert-fixture$2')
        .replace('if (shellNavigation(request, url))', "if (request.mode === 'navigate')");
    }
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({status:503,body:'{}'}));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => { const frame=document.createElement('iframe'); frame.src='/glow-bridge.html'; document.body.append(frame); });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.title === 'Alert filter fixture');
  assert.equal(await page.locator('iframe').count(), 1, 'legacy navigation serves the wrong dashboard document to the portfolio reader');
  await page.evaluate(async () => {
    document.querySelector('iframe').remove();
    localStorage.setItem('sattva:ai-alerts:sort:v1','holdings');
    sessionStorage.setItem('start-alerts','1');
    const { watchWorkerChanges } = await import('/js/core/app-updates.js');
    watchWorkerChanges(navigator.serviceWorker, () => { sessionStorage.setItem('upgraded','1'); location.reload(); });
  });
  legacy = false; holdBook = true;
  await page.evaluate(() => { navigator.serviceWorker.getRegistration().then(registration => registration.update()); });
  await page.waitForFunction(() => sessionStorage.getItem('upgraded') === '1' && !!document.querySelector('[data-ai-card]'));
  const sort = page.locator('[data-ai-sort]');
  assert.equal(await sort.inputValue(), 'newest', 'pending saved size sort displays the actual fallback');
  assert.equal(await sort.locator('[value="holdings"]').evaluate(option => option.disabled), true);
  assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), 'INDIANB', 'newest fixture signal is deliberately a small holding');
  assert.match(await page.locator('[data-ai-position-status]').innerText(), /Loading portfolio sizes/);
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.title === 'Glow portfolio reader');
  const deadline = Date.now() + 10000;
  while (!releaseBook) { assert(Date.now() < deadline); await new Promise(done => setTimeout(done, 20)); }
  holdBook = false; releaseBook(); releaseBook = null;
  await page.waitForFunction(() => document.querySelector('[data-ai-sort]')?.value === 'holdings');
  const top = expected.holdings.filter(h => tickers.includes(h.ticker)).sort((a,b) => b.weightPct-a.weightPct)[0];
  assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), top.ticker);
  const shownWeights = await page.locator('[data-ai-holding-size]').allTextContents();
  assert(shownWeights.map(parseFloat).every((weight,i,values) => !i || values[i-1] >= weight), 'visible cards descend by actual statement weights');
  const search = page.locator('[data-ai-search]');
  await search.fill('Indian Bank');
  assert.equal(await page.locator('[data-ai-card]').count(), 1);
  // `textContent`, NOT `innerText`, BECAUSE A CARD OFF THE FOLD IS DELIBERATELY NOT RENDERED.
  // Every card carries `content-visibility: auto` for the embedded frame, so a card the
  // reader has not scrolled to skips its own layout and `innerText` — which reads what is
  // rendered — answers with an empty string over a card whose markup holds the sector all
  // along. What is asserted here is what the card SAYS, so the reader has to be the one
  // that does not depend on where the page happens to be scrolled.
  const card = () => page.locator('[data-ai-card]').textContent();
  assert.match(await card(), /Financial Services/i);
  assert(!/Unclassified/i.test(await card()));
  await search.fill('');
  await sort.selectOption('priority');
  const scores = await page.locator('[data-ai-card]').evaluateAll(cards => cards.map(card => +card.dataset.score));
  assert(scores.every((score,i) => !i || scores[i-1] >= score));
  await sort.selectOption('newest');
  assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), 'INDIANB');
  await sort.selectOption('holdings');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-note]')].every(node => node.querySelector('[data-note-state="ready"]')));
  assert(await page.locator('[data-ai-summary]').count() > 0, 'substantive filings have an AI summary after the returning-session upgrade');
  assert(!/So what\?|AI reading/.test(await page.locator('#root').textContent()));
  assert(await page.locator('[data-ai-insight] [data-ai-source-id]').count() > 0, 'returning sessions receive inline source citations');
  assert.equal(await page.locator('details[data-ai-development-sources]').count(), 0);
  const beforeRefresh = notePosts, savedBeforeRefresh = savedNotes.size;
  await page.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  await page.waitForTimeout(300);
  assert.equal(notePosts, beforeRefresh, 'unchanged source refresh does not request the AI summary again');
  assert.equal(savedNotes.size, savedBeforeRefresh);
  for (const scope of ['watchlist', 'universe']) {
    await page.evaluate(scope => window.showScope(scope), scope);
    await page.waitForFunction(() => document.querySelector('[data-ai-sort]')?.value === 'holdings');
    assert.equal(await sort.locator('option').count(), 3, 'all three sorts remain available after changing scope');
    assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), top.ticker);
    await page.locator('[data-ai-more]').click();
    assert.equal(await page.locator('[data-ai-card]').last().getAttribute('data-ticker'), 'OUTSIDE', 'non-holdings stay in the view, after verified holdings');
    assert.equal(await page.locator('[data-ai-card][data-ticker="OUTSIDE"] [data-ai-holding-size]').count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-note]')].every(node => node.querySelector('[data-note-state="ready"]')));
    await page.locator('[data-ai-types-menu] summary').click();
    await page.locator('[data-ai-type="corporate-action"]').check();
    assert.equal(await sort.inputValue(), 'holdings', 'event filters preserve Largest holdings');
    assert.equal(await page.locator('[data-ai-card]').first().getAttribute('data-ticker'), top.ticker);
    await page.locator('[data-ai-type="corporate-action"]').uncheck();
    await page.locator('[data-ai-types-menu] summary').click();
  }
  const beforeReload = bookReads, savedBeforeReload = savedNotes.size;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-ai-sort]')?.value === 'holdings');
  assert.equal(await page.title(), 'Alert filter fixture', 'the reader cannot overwrite the main dashboard cache');
  assert(bookReads > beforeReload, 'a returning session rechecks the statement book');
  assert.equal(page.frames().length, 2, 'only one portfolio reader exists after reload');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ai-note]')].every(node => node.querySelector('[data-note-state="ready"]')));
  assert(notePosts > beforeRefresh, 'reload checks the server for saved readings');
  assert.equal(savedNotes.size, savedBeforeReload, 'reload uses identical evidence keys and reuses saved readings');
  unavailable = true;
  await page.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  assert.equal(await sort.inputValue(), 'newest', 'failed statement refresh cannot claim a holdings ordering');
  assert.equal(await sort.locator('[value="holdings"]').evaluate(option => option.disabled), true);
  assert.match(await page.locator('[data-ai-position-status]').innerText(), /Portfolio sizes unavailable/);
  unavailable = false;
  await page.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  await page.waitForFunction(() => document.querySelector('[data-ai-sort]')?.value === 'holdings');
  incompleteBook = true;
  await page.evaluate(async () => (await import('/js/core/refresh.js')).refreshAll());
  assert.equal(await sort.inputValue(), 'newest');
  assert.equal(await page.locator('[data-ai-holding-size]').count(), 0, 'partial marks never produce partial-denominator weights');
  assert.match(await page.locator('[data-ai-position-status]').innerText(), /could not be fully reconciled/);
  await sort.selectOption('priority');
  assert.match(await page.locator('[data-ai-position-status]').innerText(), /Showing highest priority/);
  assert.deepEqual(errors, []);
  console.log('PASS returning-session upgrade, independent reader HTML, real Glow holding order in all scopes, event filters, Indian Bank sector, pending/failure recovery and all three sorts.');
} finally {
  holdBook = false; releaseBook?.();
  await browser.close(); await new Promise(done => server.close(done));
}
