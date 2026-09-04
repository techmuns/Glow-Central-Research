#!/usr/bin/env node
// Headless local regression harness, not a connection to the user's browser or production APIs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleCombinedFilings } from '../worker/combined-filings.mjs';

const pwRoot = process.env.PLAYWRIGHT_ROOT;
if (!pwRoot) throw new Error('Set PLAYWRIGHT_ROOT to an installed Playwright directory.');
const { chromium } = await import(`${pwRoot}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const queries = [];
let fail = false;
const fixture = [
  { ticker: 'STLTECH', title: 'Analyst meeting', source: 'NSE', date: '2026-09-03', filing_url: 'https://nsearchives.nseindia.com/corporate/stl.pdf', isRead: false },
  { ticker: 'STLTECH', title: 'Board outcome', source: 'BSE', date: '2026-09-02', filing_url: 'https://www.bseindia.com/stl.pdf', isRead: true },
  { ticker: 'STLTECH', title: 'Annual report', source: 'Screener', form: 'annual_report', date: '2026-08-01', filing_url: 'https://www.screener.in/stl.pdf' },
  { ticker: 'STLTECH', title: 'Outside requested dates', source: 'NSE', date: '2027-01-01', filing_url: 'https://example.test/future.pdf' },
];
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/tailwind.css"></head><body class="bg-slate-50 p-6"><main id="root"></main>
<script>
let context = { session: { token: 'fixture.reader-a.session' } }; const listeners=[];
window.MunshotDashboardSDK={createDashboardClientSdk:()=>({getContext:()=>context,onMessage:fn=>{listeners.push(fn);return ()=>{};}})};
window.setTestSession=token=>{context={session:{token}};listeners.forEach(fn=>fn());};
window.clearTestSession=()=>{context={session:null};listeners.forEach(fn=>fn());};
</script><script type="module">
import {mountCompanyDocuments} from '/js/ui/company-documents.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({holdings:[{ticker:'STLTECH',name:'Sterlite Technologies'}]});
let dispose; let activeTab;
window.showDocuments=(form='all',source=null,scope='portfolio')=>{dispose?.();dispose=mountCompanyDocuments({root:document.querySelector('#root'),scope,data:{universe:[{ticker:'STLTECH',name:'Sterlite Technologies'}]}},{form,source,label:'Company filings & reports'});};
window.showTab=async(name)=>{dispose?.();activeTab?.destroy();activeTab=await import('/js/tabs/'+name+'.js');activeTab.render({root:document.querySelector('#root'),scope:'portfolio',data:{universe:[]},params:{},live:{register(){},start(){},stop(){},subscribe(){return ()=>{};}}});};
window.showDocuments();
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/stock-search') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ok:true,results:[{ticker:'STLTECH',name:'Sterlite Technologies',country:'India',validTicker:true}]})); return; }
    if (url.pathname === '/api/combined-filings') {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers); headers.delete('origin');
      const request = new Request('http://localhost/api/combined-filings', { method:'POST', headers, body:Buffer.concat(chunks) });
      const response = await handleCombinedFilings(request, { now:()=>Date.parse('2026-09-04T07:00:00Z'), fetcher:async (_,init)=> {
        const query=JSON.parse(init.body); queries.push(query);
        if (fail) return Response.json({}, {status:503});
        return Response.json(query.form[0] === 'all' ? fixture : fixture.filter(r=>r.form===query.form[0]));
      }});
      res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(await response.text()); return;
    }
    const path=resolve(root,`.${url.pathname}`);
    if (!path.startsWith(root+sep)) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
let checks=0;
const check=(label,value)=>{assert.ok(value,label);checks++;console.log(`PASS ${label}`);};
try {
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror',err=>errors.push(err.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await page.clock.install({time:new Date('2026-09-04T07:00:00Z')});
  await page.goto(origin); await page.locator('[data-doc-company]').waitFor();
  check('a page visit never fans out over the portfolio',queries.length===0);
  const load=async()=>{await page.locator('[data-doc-company]').fill('STLTECH');await page.locator('[data-doc-load]').click();await page.locator('[data-doc-load]:not([disabled])').waitFor();};
  await load();
  check('company documents have original source labels and caller read status',await page.locator('[data-doc-results] tbody tr').count()===3 && /Unread/.test(await page.locator('[data-doc-results]').innerText()) && /BSE/.test(await page.locator('[data-doc-results]').innerText()));
  check('records outside the selected dates are excluded with a visible count',!/Outside requested dates/.test(await page.locator('[data-doc-results]').innerText()) && /outside this company\/source\/date view/.test(await page.locator('[data-doc-status]').innerText()));
  check('duplicate/source lookup results never change portfolio membership',await page.evaluate(async()=>{const c=await import('/js/data/coverage.js');return c.holdings().length===1;}));
  await page.locator('[data-doc-results] [data-watch="STLTECH"]').first().click();
  check('starring a document watches the company, never the document id',await page.evaluate(async()=>{const w=await import('/js/core/watchlist.js');return w.all().length===1&&w.all()[0].ticker==='STLTECH';}));
  await page.evaluate(()=>window.showDocuments('all','NSE')); await load();
  check('NSE history excludes BSE and Screener-only documents',await page.locator('[data-doc-results] tbody tr').count()===1 && !/Board outcome|Annual report/.test(await page.locator('[data-doc-results]').innerText()));
  await page.evaluate(()=>window.showDocuments('concalls')); await load();
  check('Con-call requests only the documented concalls form',queries.at(-1).form[0]==='concalls');
  check('an empty document response is qualified, not proof of no filing',/does not prove no filing exists/.test(await page.locator('[data-doc-results]').innerText()));
  await page.evaluate(()=>window.showDocuments('earnings_report')); await load();
  check('Earnings Hub requests earnings reports, not fabricated earnings figures',queries.at(-1).form[0]==='earnings_report');
  await page.evaluate(()=>window.showDocuments());
  await page.locator('[data-doc-form-type]').selectOption('annual_report'); await load();
  check('annual reports are available from the corporate document view',queries.at(-1).form[0]==='annual_report' && /Annual report/.test(await page.locator('[data-doc-results]').innerText()));
  await page.locator('[data-doc-company]').fill('Sterlite'); await page.locator('[data-doc-load]').click();
  await page.locator('[data-doc-suggestions] button').waitFor();
  check('company-name lookup requires an explicit identity selection',/Select the intended company/.test(await page.locator('[data-doc-status]').innerText()));
  await page.locator('[data-doc-suggestions] button').click(); await page.locator('[data-doc-results] tbody').waitFor();
  fail=true; await page.locator('[data-doc-load]').click();
  await page.waitForFunction(()=>document.querySelector('[data-doc-status]').textContent.includes('could not be reached'));
  check('service failure is visible and never presented as no documents',!(await page.locator('[data-doc-results]').innerText()).includes('No matching documents'));
  fail=false; await load();
  await page.evaluate(()=>window.setTestSession(null));
  check('logout clears private document records immediately',await page.locator('[data-doc-results]').innerText()==='' && /Sign in/.test(await page.locator('[data-doc-status]').innerText()));
  const before=queries.length; await page.locator('[data-doc-load]').click();
  check('missing user session never sends the deployment identity',queries.length===before);
  await page.evaluate(()=>window.setTestSession('fixture.reader-b.session')); await load();
  check('new sessions require a fresh document request',queries.length===before+1);
  if(process.env.DOCUMENT_SCREENSHOT_PATH)await page.screenshot({path:process.env.DOCUMENT_SCREENSHOT_PATH,fullPage:true});
  await page.evaluate(()=>window.clearTestSession());
  check('an explicit null session also clears private records and the token',await page.locator('[data-doc-results]').innerText()==='' && await page.evaluate(async()=>!(await import('/js/core/host-context.js')).hostToken()));
  check('desktop layout fits the viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:390,height:844});
  check('mobile layout contains the lookup controls',await page.locator('[data-doc-load]').isVisible());
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.setTestSession('fixture.reader-a.session'));
  for (const [name,form] of [['corp-announcements','all'],['nse-filings','all'],['concall','concalls'],['earnings-hub','earnings_report']]) {
    await page.evaluate(name=>window.showTab(name),name);
    await page.locator('[data-doc-mode="documents"]').click();
    await page.locator('[data-doc-company]').waitFor();
    await load();
    check('the actual '+name+' tab reaches its assigned document form',queries.at(-1).form[0]===form);
  }
  check('the document view has no browser runtime errors',errors.length===0);
  console.log(`\n${checks} combined filings browser checks passed.`);
} finally { await browser?.close(); await new Promise(done=>server.close(done)); }
