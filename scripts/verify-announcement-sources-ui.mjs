#!/usr/bin/env node
// Real AI ranking and card rendering; every feed and API stays local.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const filing = { id: 'kalp:announcement', ticker: 'KPIL', company: 'Kalpataru Projects International', feed: 'announcements',
  feedLabel: 'Corporate Announcements', day: '2026-09-28', time: '10:00', importance: 'high', direction: 'neutral', aiEligible: true,
  headline: 'Receipt of an order', filingSubject: 'General Updates',
  filingDescription: 'Received a letter of acceptance for Rs 2,500 crore from Metro Rail in Mumbai',
  detail: 'BSE · Orders', url: 'https://www.bseindia.com/kalpataru-order.pdf' };
const report = { ...filing, id: 'kalp:news', feed: 'news', feedLabel: 'Company news', time: '11:00',
  headline: 'Kalpataru bags a ₹25 billion contract from Metro Rail in Mumbai',
  filingSubject: null, filingDescription: null, namesCompany: true,
  attribution: { version: ATTRIBUTION_VERSION, status: 'confirmed', companyTicker: 'KPIL' },
  detail: 'Published by Mint', url: 'https://mint.example/kalpataru' };
const copy = { ...filing, id: 'kalp:nse', feed: 'nse-filings', feedLabel: 'NSE Filings', time: '10:05', detail: 'NSE · Orders',
  url: 'https://nsearchives.nseindia.com/kalpataru-order.pdf' };
const holdings = [{ ticker: 'KPIL', name: filing.company }];
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head>
<body style="padding:16px"><main id="root"></main><script type="module">
import * as coverage from '/js/data/coverage.js';
import * as tab from '/js/tabs/ai-alerts.js';
import * as refresh from '/js/core/refresh.js';
coverage.prime({holdings:${JSON.stringify(holdings)}});
window.events=${JSON.stringify([report, copy, filing])};
window.refreshAlerts=()=>refresh.refreshAll();
window.tab=tab;
tab.render({root:document.querySelector('#root'),scope:'universe',params:{}});
</script></body></html>`;
const feedModule = `
export const onChange=()=>()=>{};
export const today=()=> '2026-09-28';
export async function readCachedAlertWindow(){return null;}
export async function collect({scope,onPartial}){
 const report={scope,day:today(),events:window.events,feeds:['announcements','nse-filings','news'].map(id=>({id,status:window.failed?'failed':'ok',reachesToday:!window.failed})),pending:0};
 if(window.failed)onPartial?.({...report,events:[],pending:1});
 return report;
}`;
const summaryFiling = { ...filing, filingSubCategory: 'Award of Order / Receipt of Order',
  filingDescription: 'Received a letter of acceptance for Rs 2,500 crore from Metro Rail in Mumbai. The contract covers civil construction and station infrastructure, with completion scheduled in 36 months. The award remains subject to the customer issuing the final notice to proceed.' };
const routineFiling = { ...filing, headline: 'Trading window closure', filingSubject: 'Trading window closure',
  filingDescription: 'The trading window remains closed for designated persons and their immediate relatives from 1 October 2026 until publication of the quarterly results and completion of the required waiting period.' };
const noteRequests = [];
let skipSummary = false;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-store');
  if (pathname === '/') {
    const scenario = new URL(req.url, 'http://localhost').searchParams.get('case');
    const events = { news: [report], routine: [routineFiling], summary: [summaryFiling] }[scenario];
    res.setHeader('content-type','text/html');
    res.end(events ? html.replace(JSON.stringify([report, copy, filing]), JSON.stringify(events)) : html); return;
  }
  if (pathname === '/api/alert-notes') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { items } = JSON.parse(body); noteRequests.push(...items);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ ok: true,
      notes: skipSummary ? {} : Object.fromEntries(items.map(item => [item.id, { note: 'The contract covers civil construction and station infrastructure, with completion scheduled in 36 months.' }])),
      missing: skipSummary ? Object.fromEntries(items.map(item => [item.id, 'not-needed'])) : {},
      retryAt: skipSummary ? Object.fromEntries(items.map(item => [item.id, null])) : {},
    })); return;
  }
  if (pathname === '/js/data/daily-alerts.js') { res.setHeader('content-type','text/javascript'); res.end(feedModule); return; }
  if (pathname === '/js/data/capture-watchdog.js') { res.setHeader('content-type','text/javascript'); res.end('export const onCaptureLanded=()=>()=>{};'); return; }
  if (pathname.startsWith('/api/')) { res.setHeader('content-type','application/json'); res.end('{}'); return; }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', {'.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
const page = await browser.newPage({viewport:{width:1280,height:1000}});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({status:200,body:'{}'}));
try {
  await page.clock.install({time:'2026-09-28T08:00:00Z'});
  await page.goto(origin);
  const card = page.locator('[data-ai-card]');
  await card.waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-ai-feed-status]')?.dataset.state==='complete');
  assert.equal(await card.count(), 1);
  assert.equal(await card.locator('[data-ai-kind="filing"]').count(), 1);
  assert.equal(await card.locator('[data-ai-lead-link]').getAttribute('href'), filing.url);
  assert.equal(await card.locator('[data-ai-evidence] > li').count(), 1, 'one event row, not an announcement and two reports');
  assert.equal(await card.locator('[data-ai-summary]').count(), 0, 'a sufficient filing headline needs no summary');
  const sources = card.locator('[data-ai-development-sources]').first();
  const toggle = sources.locator('summary');
  assert.match(await toggle.textContent(), /1 exchange copy · 1 news report/);
  assert.equal(await sources.getAttribute('open'), null);
  await toggle.focus(); await page.keyboard.press('Enter');
  assert.equal(await sources.getAttribute('open'), '', 'keyboard click expands related coverage');
  assert.equal(await sources.locator('[data-ai-related-source]').count(), 3);
  assert((await sources.innerText()).includes('₹25 billion'), 'original Unicode source text is preserved');
  assert.equal(await sources.locator('[data-ai-related-source]').first().getAttribute('href'), filing.url);
  assert.match(await sources.locator('[data-ai-related-source]').last().innerText(), /Related news · Mint.*28 Sept 2026/s);
  for (const link of await sources.locator('a').all()) assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  const popupPromise = page.waitForEvent('popup');
  await sources.locator('a').last().click();
  const popup = await popupPromise; await popup.waitForLoadState();
  assert.equal(popup.url(), report.url, 'article opens its own original source'); await popup.close();
  await toggle.focus();
  await page.evaluate(async () => {
    window.originalSourceList=document.querySelector('[data-ai-development-sources]');
    const news=window.events.find(e=>e.feed==='news');
    window.events=[...window.events,{...news,id:'kalp:later-news',url:'https://news.example/kalpataru',detail:'Published by Business Standard',time:'12:00'}];
    await window.refreshAlerts();
  });
  await page.waitForFunction(()=>document.querySelector('[data-ai-development-sources] summary')?.textContent.includes('2 news reports'));
  assert(await page.evaluate(()=>document.querySelector('[data-ai-development-sources]')===window.originalSourceList));
  assert.equal(await sources.getAttribute('open'), '', 'refresh preserves expansion');
  assert(await toggle.evaluate(node=>document.activeElement===node), 'refresh preserves keyboard focus');
  assert.equal(await card.locator('[data-ai-evidence] > li').count(), 1, 'another publisher stays under the existing event');
  await page.evaluate(async () => { window.failed=true; await window.refreshAlerts(); });
  assert.equal(await sources.locator('a').count(),4,'partial source failure retains every captured link');
  assert.equal(await sources.getAttribute('open'),'');
  await page.evaluate(async () => {
    window.failed=false;
    const filing=window.events.find(e=>e.id==='kalp:announcement');
    window.events=[...window.events,{...filing,id:'kalp:other-order',time:'13:00',url:'https://www.bseindia.com/another-order.pdf',
      filingDescription:'Received a letter of acceptance for Rs 400 crore from Eastern Railway in Kolkata'}];
    await window.refreshAlerts();
  });
  await page.waitForFunction(()=>document.querySelectorAll('[data-ai-evidence] > li').length===2);
  assert.equal(await card.locator('[data-ai-evidence-link][href="https://www.bseindia.com/another-order.pdf"]').count(),1,
    'a separate announcement with the same subject remains visible');
  await card.locator('[data-ai-evidence] details summary').click();
  await page.mouse.move(0,0);
  for(const width of [1280,390,320]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${theme} at ${width}px fits`);
      if(process.env.ANNOUNCEMENT_SCREENSHOT && width!==320) await page.screenshot({path:`${process.env.ANNOUNCEMENT_SCREENSHOT}-${width}-${theme}.png`,fullPage:true});
    }
  }
  assert.equal(noteRequests.length, 0, 'headlines and related news make no model requests');
  for (const scenario of ['news', 'routine', 'summary', 'skipped']) {
    skipSummary = scenario === 'skipped';
    const reader = await browser.newPage({ viewport: { width: 390, height: 1000 } });
    await reader.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({status:200,body:'{}'}));
    reader.on('pageerror', error => errors.push(error.message));
    await reader.clock.install({time:'2026-09-28T08:00:00Z'});
    const before = noteRequests.length;
    await reader.goto(`${origin}/?case=${scenario === 'skipped' ? 'summary' : scenario}`);
    await reader.locator('[data-ai-card]').waitFor();
    if (scenario === 'summary') {
      await reader.locator('[data-note-state="ready"]').waitFor();
      assert.match(await reader.locator('[data-ai-summary]').innerText(), /AI summary.*36 months/is);
      assert.equal(noteRequests.length, before + 1);
      assert.equal(noteRequests.at(-1).documentType, 'orders');
      if (process.env.ANNOUNCEMENT_SCREENSHOT) await reader.screenshot({path:`${process.env.ANNOUNCEMENT_SCREENSHOT}-summary.png`,fullPage:true});
    } else {
      await reader.waitForTimeout(500);
      assert.equal(await reader.locator('[data-ai-summary]').count(), 0, `${scenario} omits the summary section`);
      assert.equal(noteRequests.length, before + (scenario === 'skipped' ? 1 : 0));
    }
    const content = await reader.locator('[data-ai-card]').textContent();
    assert.match(content, /Headline/);
    assert(!/So what\?|AI reading/.test(content));
    const after = noteRequests.length;
    await reader.evaluate(() => window.refreshAlerts());
    await reader.waitForTimeout(250);
    assert.equal(noteRequests.length, after, 'refresh does not retry a saved or unnecessary summary');
    await reader.close();
  }
  assert.deepEqual(errors,[]);
  console.log('PASS primary announcement, source retention, responsive UI and optional factual summaries; news/routine/headline-only cases make no AI request.');
} finally { await browser.close(); await new Promise(done=>server.close(done)); }
