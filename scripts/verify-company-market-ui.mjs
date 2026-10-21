// Real shared tables, native service-worker upgrade and offline fixtures. No production calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), output = resolve('.cache/company-market');
mkdirSync(output, { recursive: true });
let legacy = true, updated = false, failed = false, missingDaily = false, malformed = false, fullCaptures = 0;
const stamp = '2026-10-21T10:00:00Z', isin = 'INE000000001';
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css">
<body><main id="root" style="padding:20px;max-width:1200px;margin:auto"></main><script type="module">
import { scoreTable } from '/js/ui/screener.js';
import { exportRows } from '/js/ui/export.js';
import * as market from '/js/data/company-market.js';
import * as live from '/js/data/breakout-live.js';
import { watchWorkerChanges } from '/js/core/app-updates.js';
window.market=market;window.live=live;window.marketClock=Date.parse('${stamp}');Date.now=()=>window.marketClock;
const rows=[{ticker:'ALPHA',isin:'${isin}',name:'Alpha',mcapCr:900},{scripCode:'500002',name:'BSE only'}, {name:'Unlisted issuer'}];
window.mount=(mode='cap')=>{
 window.dispose?.();
 const columns=mode==='cmp'?[{label:'CMP',get:()=>77}]:mode==='both'?[{label:'CMP',get:()=>77},{label:'Market cap',get:()=>88}]:mode==='price'?[{label:'Trade price',get:()=>15}]:[{label:'Subject',get:()=> 'Result filed'},{label:'Market cap',get:r=>r.mcapCr||'—',sortable:false,align:'right'}];
 window.table=scoreTable({rows,companyMarket:true,name:r=>r.name,key:r=>r.ticker||r.scripCode||r.name,
  watchKey:()=>null,showRank:false,showWatchFilter:false,showAvatar:false,columnLayoutKey:'company-market-fixture',
  columns,stickyHead:'400px',onExport:visible=>exportRows({companyMarket:true,rows:visible,columns:[{header:'Company',key:'name',get:r=>r.name},{header:'Market cap (₹ Cr)',key:'mcap',get:r=>r.mcapCr??''}]})});
 document.querySelector('#root').innerHTML=window.table.html;window.dispose=window.table.wire(document.querySelector('#root'));
};
window.mount();
watchWorkerChanges(navigator.serviceWorker,()=>location.reload());
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;window.ready=true;
</script>`;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
  if (path === '/sdk-fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end('/* fixture */'); return; }
  if (path === '/api/technicals' || path === '/data/technicals.json') fullCaptures++;
  if (path === '/api/technicals/prices' || path === '/data/company-quotes.json') {
    if (failed) { res.writeHead(503).end('{}'); return; }
    json({ version: 1, generated_at: updated ? '2026-10-21T10:01:00Z' : stamp,
      rows: malformed ? 'invalid rows' : [{ ticker: 'ALPHA', cmp: missingDaily ? null : updated ? 130 : 120, price_date: '2026-10-19' }] }); return;
  }
  if (path === '/data/market-caps.json') {
    json({ version: 1, entries: [{ ticker: 'ALPHA', isin, exchanges: ['NSE'], cr: 900, checkedAt: stamp },
      { ticker: 'BSEONLY', isin: 'INE000000002', bseCode: '500002', exchanges: ['BSE'], cr: 80, checkedAt: stamp, cmp: 23, cmpCheckedAt: stamp }] }); return;
  }
  if (path === '/data/mc-ticker-map.json') { json({ map: { A: { ticker: 'ALPHA', shares: 100_000_000 } } }); return; }
  if (path === '/api/breakouts') { json({ version: 1, rows: [], targets: ['ALPHA'], failures: [] }); return; }
  if (path.startsWith('/api/')) { res.writeHead(503).end('{}'); return; }
  try {
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error('path');
    let body = readFileSync(file);
    if (path === '/sw.js') {
      body = body.toString().replace(/const MUNSHOT_SDK = .*;/, "const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");
      if (legacy) body = body.replace(/const CACHE_NAME = .*;/, 'const CACHE_NAME = `${CACHE_PREFIX}before-company-market-columns`;');
    }
    if (legacy && path === '/js/ui/company-market-columns.js') body = 'export const marketColumns=columns=>columns;export const marketCells=()=>"";export const marketHeads="";export const wireMarketCells=()=>()=>{};';
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end('{}'); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }), page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.addInitScript(() => {
    if (!localStorage.getItem('dashboard:column-layout:v1:company-market-fixture')) localStorage.setItem('dashboard:column-layout:v1:company-market-fixture',
      JSON.stringify({ '$': ['$/Subject:0', '$/Market%20cap:0', '$/name:0'] }));
  });
  await page.goto(origin); await page.waitForFunction(() => window.ready && navigator.serviceWorker.controller);
  await page.reload(); await page.waitForFunction(() => window.ready);
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('thead th').filter({ hasText: /^CMP$/ }).count(), 0);
  legacy = false;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector('th[data-sort="CMP"]');
  await page.waitForFunction(() => window.market.read({ticker:'ALPHA'}).cmp === 120);
  const headings = await page.locator('thead th').allTextContents();
  const capIndex = headings.findIndex(text => text.trim() === 'Market cap');
  assert.equal(headings[capIndex - 1].trim(), 'CMP', 'returning saved layout places new CMP next to cap');
  assert(!(await page.evaluate(() => caches.keys())).some(key => key.includes('before-company-market-columns')));
  const row = page.locator('[data-row-key="ALPHA"]');
  assert.match(await row.textContent(), /120/); assert.match(await row.textContent(), /Daily close · 2026-10-19/);
  assert.match(await page.locator('[data-row-key="500002"]').textContent(), /23/);
  assert.match(await page.locator('[data-row-key="Unlisted issuer"]').textContent(), /—/);
  await page.locator('[data-table-search]').fill('Alpha');
  await page.waitForFunction(() => window.table.visibleRows().length === 1);
  updated = true;
  await page.evaluate(async () => { window.marketClock += 61_000; await window.market.load(); });
  await page.waitForFunction(() => document.querySelector('[data-row-key="ALPHA"]').textContent.includes('130'));
  assert.equal(await page.locator('[data-table-search]').inputValue(), 'Alpha');
  assert.equal(await page.locator('tbody [data-row-key]').count(), 1);
  missingDaily = true;
  await page.evaluate(async () => { window.marketClock += 61_000; await window.market.load(); });
  assert.equal(await page.evaluate(() => window.market.read({ticker:'ALPHA'}).cmp), 130, 'partial capture retains the prior dated close');
  assert.match(await row.textContent(), /Retained/);
  failed = true;
  await page.evaluate(async () => { window.marketClock += 61_000; await window.market.load(); });
  assert.equal(await page.evaluate(() => window.market.read({ticker:'ALPHA'}).cmp), 130, 'outage does not erase a usable quote');
  assert.match(await row.textContent(), /latest daily price check unavailable/);
  failed = false; malformed = true;
  await page.evaluate(async () => { window.marketClock += 61_000; await window.market.load(); });
  assert.equal(await page.evaluate(() => window.market.read({ticker:'ALPHA'}).cmp), 130, 'invalid successful JSON cannot erase the saved quote');
  assert.equal(fullCaptures, 0, 'company tables do not download full technicals to show CMP');

  // Exercise the real exporter boundary with an in-memory workbook sink, inspecting raw values.
  await page.evaluate(() => {
    window.exportedRows = [];
    window.ExcelJS = { Workbook: class {
      constructor() { this.xlsx = { writeBuffer: async () => new Uint8Array([1]) }; }
      addWorksheet() { const sheet = { columns: [], getRow: () => ({}), addRow: row => window.exportedRows.push(row) }; window.exportedSheet = sheet; return sheet; }
    } };
  });
  const downloading = page.waitForEvent('download');
  await page.locator('[data-export]').click(); await downloading;
  const exported = await page.evaluate(() => ({ columns: window.exportedSheet.columns, rows: window.exportedRows }));
  const exportCap = exported.columns.findIndex(column => column.header === 'Market cap (₹ Cr)');
  assert(exportCap > 0, JSON.stringify(exported.columns));
  assert.equal(exported.columns[exportCap - 1].header, 'CMP (₹)');
  assert.equal(exported.rows[0].company_market_cmp, 130); assert.equal(exported.rows[0].mcap, 900);
  assert.match(exported.rows[0].company_market_quote_source, /2026-10-19/);

  // Existing price and cap columns keep their own measurements; a trade price stays distinct.
  for (const mode of ['cmp', 'both', 'price']) {
    await page.evaluate(mode => window.mount(mode), mode);
    assert.equal(await page.locator('thead th').filter({hasText:/^CMP$/}).count(), 1);
    assert.equal(await page.locator('thead th').filter({hasText:/^Market cap$/}).count(), 1);
    if (mode === 'price') assert.equal(await page.locator('thead th').filter({hasText:/Trade price/}).count(), 1);
    if (mode !== 'price') assert.match(await page.locator('[data-row-key="ALPHA"]').textContent(), /77/);
  }
  await page.evaluate(() => window.mount());
  await page.screenshot({ path: resolve(output, 'company-market-light.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone overflow stays inside table');
  await page.screenshot({ path: resolve(output, 'company-market-mobile-dark.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS paired table columns, saved layout migration, existing-session upgrade, live repaint, search retention, partial/offline prices, exact BSE identity, no duplicates and mobile containment.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
