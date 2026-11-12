import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { emptyCapture } from './lib/private-market-news.mjs';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');
const output=resolve('.cache/private-market');mkdirSync(output,{recursive:true});
const sourceUrl='https://inc42.com/buzz/fixture-funding-this-week/';
let capture=emptyCapture(), unavailable=false, reads=0, legacy=true;
// The family's private companies, as build-book.mjs publishes them: one named as the deal is, one
// matched through its legal name, one with no captured round.
const privateCompanies=[{id:'private:fixturecompany3',name:'Fixture Company 3',legalName:null,aliases:[],categories:['private-investment'],isins:[],securityKeys:['fixture-company-3-a-person'],bookNames:['Fixture Company 3 - A Person']},
  {id:'private:fixturebrand',name:'Fixture Brand',legalName:'Fixture Company 7 Private Limited',aliases:[],categories:['unlisted'],isins:[],securityKeys:['fixture-brand'],bookNames:['Fixture Brand']},
  {id:'private:unfunded',name:'Unfunded Holding',legalName:null,aliases:[],categories:['private-investment'],isins:[],securityKeys:['unfunded'],bookNames:['Unfunded Holding']}];
capture.generatedAt=new Date().toISOString();capture.sourceCheckedAt=capture.generatedAt;capture.archive.complete=true;
capture.articles=[{url:sourceUrl,title:'Fixture funding this week',status:'ok',publishedAt:'2026-10-17T09:00:00+05:30',notes:['* Mix of equity and debt']}];
const variants=['Series A1','series A','Series A**','Seed funding','Seed Round','$1 Mn','bp Ventures','Pre-Series A','pre–Series A','Credit','Debt'];
const row=(i,round=variants[i]||'Series A')=>({id:i.toString(16).padStart(24,'0'),company:`Fixture Company ${i}`,date:i===499?'01 Jan 2020':'16 Oct 2026',dateISO:i===499?'2020-01-01':'2026-10-16',sector:i%2?'AI':'Health Tech',subsector:'Software',businessModel:'B2B',amount:'$11.4 Mn *',round,investors:i===499?'Older History Investor':'Fixture Investor',leadInvestor:'Fixture Investor',sourceFields:{Date:'16 Oct 2026',Name:`Fixture Company ${i}`,'Funding Round Type':round},sourceUrl:i===499?'https://inc42.com/buzz/older-funding-this-week/':sourceUrl,sourceTitle:'Fixture funding this week',publishedAt:i===499?'2020-01-04T09:00:00+05:30':'2026-10-17T09:00:00+05:30',firstSeenAt:capture.generatedAt,updatedAt:capture.generatedAt,revisions:[]});
capture.deals=Array.from({length:500},(_,i)=>row(i));
// Company descriptions as the runner writes them: one found on the company's own site, one checked
// and not found; every other company has not been looked up yet.
let profilesUnavailable=false;
const profileFile={version:1,generatedAt:capture.generatedAt,companies:500,looked:2,found:1,profiles:{
  fixturecompany0:{name:'Fixture Company 0',status:'found',website:'https://fixture0.in/',checkedAt:capture.generatedAt,foundAt:capture.generatedAt,sources:[{kind:'website',text:'Fixture Company 0 builds <b>software</b> for clinics across India.',url:'https://fixture0.in/'},{kind:'wikidata',text:'Indian health-tech company',url:'https://www.wikidata.org/wiki/Q42'}]},
  fixturecompany2:{name:'Fixture Company 2',status:'not-found',website:null,checkedAt:capture.generatedAt,sources:[]}}};
// The other publishers' capture: one report of Fixture Company 5's round, from a less credible desk
// printing a different size. It must fold into the Inc42 row (no new row) and show the disagreement.
let dealDispatches=0;
// Two hours old: an open tab must start a fresh read on its own.
const newsDeals={version:1,generatedAt:new Date(Date.parse(capture.generatedAt)-2*3600000).toISOString(),feeds:[{id:'entrackr',publisher:'Entrackr',ok:true,items:10,deals:1,checkedAt:capture.generatedAt,lastOkAt:capture.generatedAt}],
  observations:[{id:'f'.repeat(24),kind:'funding',status:'announced',company:'Fixture Company 5',acquirer:'',round:'Series A',amount:'$12.5 Mn',currency:'USD',amountValue:12.5,investors:'Fixture Investor',leadInvestor:'',date:'2026-10-15',publisher:'Entrackr',credibility:90,sourceId:'entrackr',url:'https://entrackr.com/2026/10/fixture-company-5-raises/',title:'Fixture Company 5 raises $12.5 Mn',publishedAt:'2026-10-15T10:00:00Z',feed:'entrackr',origin:'news',firstSeenAt:capture.generatedAt}]};
const index=readFileSync('public/index.html','utf8');
const overlays=index.slice(index.indexOf('    <div id="drill-overlay"'),index.indexOf('    <!--',index.indexOf('id="workspace-content"')));
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><main id="root"></main>${overlays}<script type="module">
import * as tab from '/js/tabs/private-market-news.js';import * as feed from '/js/data/private-market-news.js';
import {watchWorkerChanges} from '/js/core/app-updates.js';import {enterView,captureTableReading} from '/js/core/view-reading.js';
const root=document.querySelector('#root'),saved=JSON.parse(sessionStorage.getItem('funding-reading')||'null');
enterView({root,key:'funding-fixture',preset:saved?{reading:saved}:null});
window.fixture={tab,feed};tab.render({root,scope:'universe'});
if(location.search.includes('worker-upgrade')){watchWorkerChanges(navigator.serviceWorker,()=>{sessionStorage.setItem('funding-reading',JSON.stringify(captureTableReading(root)));location.reload();});await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;}
window.fixtureReady=true;</script>`;
const server=createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('cache-control','no-cache');
  if(pathname==='/'||pathname==='/index.html'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(pathname==='/data/portfolio-companies.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({holdings:[],privateCompanies}));return;}
  if(pathname==='/sdk-fixture.js'){res.setHeader('content-type','text/javascript');res.end('/* fixture */');return;}
  if(pathname==='/data/private-company-profiles.json'){res.setHeader('content-type','application/json');if(profilesUnavailable){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify(profileFile));return;}
  if(pathname==='/api/private-deals/refresh'&&req.method==='POST'){dealDispatches++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,dispatched:true,reason:'dispatched'}));return;}
  if(pathname==='/data/private-deals.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify(newsDeals));return;}
  if(pathname==='/data/private-market-news.json'){reads++;res.setHeader('content-type','application/json');if(unavailable){res.writeHead(503);res.end('{}');}else res.end(JSON.stringify(capture));return;}
  const path=resolve(root,`.${pathname}`);if(!path.startsWith(root+sep)){res.writeHead(404);res.end();return;}
  try{let body=readFileSync(path);
    if(pathname==='/sw.js'){body=body.toString().replace(/const MUNSHOT_SDK = .*;/,"const MUNSHOT_SDK = new URL('/sdk-fixture.js', self.location).href;");if(legacy)body=body.replace(/const CACHE_NAME = .*;/,'const CACHE_NAME = `${CACHE_PREFIX}before-funding-round-types`;');}
    if(legacy&&pathname==='/js/tabs/private-market-news.js')body=body.toString().replace('fundingRoundFilter(rows)',"options('round','Round types')");
    res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'text/plain');res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({downloadsPath:output,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
try{
  const warm=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),returning=await warm.newPage(),warmErrors=[];
  returning.on('pageerror',error=>warmErrors.push(error.message));
  await warm.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  await returning.goto(origin+'/?worker-upgrade');await returning.waitForFunction(()=>window.fixtureReady&&navigator.serviceWorker.controller);
  await returning.reload();await returning.waitForFunction(()=>window.fixtureReady);
  const warmRounds=returning.getByRole('combobox',{name:'Round types',exact:true});
  await warmRounds.selectOption('Seed funding');assert((await warmRounds.locator('option').allTextContents()).includes('$1 Mn'),'Warm the actual prior dropdown with erroneous amount options');
  legacy=false;await returning.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration()).update();});
  try { await returning.waitForFunction(()=>document.querySelector('[aria-label="Round types"]')?.value==='Seed'); }
  catch(error) {
    const state=await returning.evaluate(async()=>({ready:window.fixtureReady,reading:sessionStorage.getItem('funding-reading'),selects:[...document.querySelectorAll('select')].map(s=>({label:s.getAttribute('aria-label'),value:s.value,options:[...s.options].map(o=>o.value)})),caches:await caches.keys(),workers:(await navigator.serviceWorker.getRegistrations()).map(r=>({active:r.active?.state,waiting:r.waiting?.state,installing:r.installing?.state}))}));
    writeFileSync(resolve(output,'upgrade-failure.json'),JSON.stringify({state,warmErrors},null,2));
    await returning.screenshot({path:resolve(output,'upgrade-failure.png'),fullPage:true});console.error(JSON.stringify({state,warmErrors}));throw error;
  }
  assert.equal(await returning.locator('tbody tr[data-row-key]').count(),2,'A returning raw Seed selection migrates to the whole Seed group');
  assert.deepEqual(await warmRounds.locator('option').allTextContents(),['All round types','Seed','Pre-Series A','Series A','Debt','Unspecified']);
  assert(!(await returning.evaluate(()=>caches.keys())).some(key=>key.includes('before-funding-round-types')));
  await returning.evaluate(()=>{window.exportedRows=[];window.ExcelJS={Workbook:class{constructor(){this.xlsx={writeBuffer:async()=>new Uint8Array([1])};}addWorksheet(){const records=new Map();return {getRow:i=>{if(!records.has(i))records.set(i,{});return records.get(i);},getColumn:()=>({}),addRow:row=>window.exportedRows.push(row)};}}};});
  await Promise.all([returning.waitForEvent('download'),returning.getByRole('button',{name:'Export Excel',exact:true}).click()]);
  const exported=await returning.evaluate(()=>window.exportedRows);assert.deepEqual(exported.map(row=>row.round).sort(),['Seed Round','Seed funding']);assert(exported.every(row=>row.amount==='$11.4 Mn *'),'Grouped export preserves original values and funding footnotes');
  await returning.screenshot({path:resolve(output,'round-types-upgrade.png'),fullPage:true});assert.deepEqual(warmErrors,[]);await warm.close();
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  dealDispatches=0; // earlier pages each start their own; this page must start exactly one
  await page.clock.install({time:new Date(capture.generatedAt)});
  await page.goto(origin);await page.getByRole('heading',{name:'Private Market',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-table-count]')?.textContent.includes('499')||document.querySelector('main')?.textContent.includes('499 of 500'));
  assert.equal(await page.locator('[data-watch-toggle]').count(),0);
  assert(await page.locator('tbody tr[data-row-key]').count()<100,'Shared table bounds mounted rows');
  const headers=(await page.locator('thead th').allTextContents()).map(text=>text.replace(/[▴▾]/g,'').trim());
  assert(!headers.includes('CMP')&&!headers.includes('Market cap'),'Private funding retains its funding fields without listed-equity market columns');
  assert(headers.includes('Round size')&&headers.includes('Round type'),'Funding size and round remain visible');
  assert.equal((await page.locator(`[data-row-key="${capture.deals[0].id}"] td`).nth(headers.indexOf('Round size')).innerText()).trim(),'$11.4 Mn *','Original funding amount and footnote marker remain intact');
  const folded=page.locator(`[data-row-key="${capture.deals[5].id}"]`);
  assert.match(await folded.innerText(),/Entrackr/,'A second publisher reporting the same round folds into the one row');
  assert.match(await folded.innerText(),/Sources differ/,'A disagreement between sources is shown, not hidden');
  assert.equal((await folded.locator('td').nth(headers.indexOf('Round size')).innerText()).trim(),'$11.4 Mn *','The more credible source (Inc42 table) supplies the shown size');
  await page.waitForFunction(()=>document.querySelector('main')?.textContent.includes('fetching the latest now'));
  assert.equal(dealDispatches,1,'A stale publisher capture starts exactly one collection from the open tab');
  newsDeals.generatedAt=capture.generatedAt;await page.clock.fastForward(61000);
  await page.waitForFunction(()=>!document.querySelector('main')?.textContent.includes('fetching the latest now'));
  assert.equal(dealDispatches,1,'A fresh capture lands and starts nothing more');
  const rounds=page.getByRole('combobox',{name:'Round types',exact:true});
  await rounds.selectOption('Seed');assert.equal(await page.locator('tbody tr[data-row-key]').count(),2);
  await rounds.selectOption('Unspecified');assert.equal(await page.locator('tbody tr[data-row-key]').count(),2,'Misplaced amount and investor text remain reachable without invalid options');
  await rounds.selectOption('Series A');assert.match(await page.locator('main').innerText(),/491 of 500/,'Series sub-rounds and footnotes match one canonical group');
  await rounds.selectOption('all');assert.match(await page.locator('main').innerText(),/499 of 500/,'All keeps every observation in the selected period');
  await page.getByText('Fixture Company 0',{exact:true}).click();assert((await page.locator('#drill-content').textContent()).includes('Mix of equity and debt'));
  // The company card: its own description (reproduced, escaped, sourced), sector and theme, every round.
  const card=page.locator('#drill-content');
  await card.getByText('Fixture Company 0 builds <b>software</b> for clinics across India.',{exact:true}).waitFor();
  assert.equal(await card.locator('b').count(),0,'A description is text, never markup');
  assert.match(await card.innerText(),/From fixture0\.in, the company’s own website description/);
  assert.equal(await card.locator('a[href="https://www.wikidata.org/wiki/Q42"]').count(),1,'Other sources are linked');
  assert.match(await card.textContent(),/Funding rounds · 1 captured/);assert.equal(await card.locator('[data-company-round]').count(),1);
  assert.match(await card.innerText(),/Health Tech/);assert.match(await card.innerText(),/the record you opened/);
  await page.screenshot({path:resolve(output,'company-card.png')});
  await page.keyboard.press('Escape');
  await page.getByText('Fixture Company 2',{exact:true}).click();
  await card.getByText(/^No description found\. Checked Wikidata and Wikipedia/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('Fixture Company 1',{exact:true}).click();
  await card.getByText(/^Not looked up yet\./).waitFor();
  await page.keyboard.press('Escape');
  const period=page.getByRole('combobox',{name:'Funding period',exact:true});await period.selectOption('all');
  const search=page.getByPlaceholder('Search company, investor, sector or round...');await search.fill('Older History Investor');
  await page.getByText('Fixture Company 499',{exact:true}).waitFor();
  assert.equal(await page.locator('tbody tr[data-row-key]').count(),1,'Search reaches retained history beyond mounted rows');
  await search.fill('');
  // From–To on the deal's own funding date: rows, the count and the export follow one value.
  assert.deepEqual(await period.locator('option').evaluateAll(o=>o.map(x=>x.value)),['latest','1m','3m','6m','12m','all'],'Quick picks replace the roundup-year list');
  const from=page.getByLabel('Funding from',{exact:true}),to=page.getByLabel('Funding to',{exact:true});
  await from.fill('2019-12-01');await to.fill('2020-02-01');
  assert.equal(await period.inputValue(),'range:2019-12-01:2020-02-01','A typed range becomes the period');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(),1);assert.match(await page.locator('main').innerText(),/1 of 500/,'The count follows the range');
  await page.evaluate(()=>{window.exportedRows=[];window.ExcelJS={Workbook:class{constructor(){this.xlsx={writeBuffer:async()=>new Uint8Array([1])};}addWorksheet(){const records=new Map();return {getRow:i=>{if(!records.has(i))records.set(i,{});return records.get(i);},getColumn:()=>({}),addRow:row=>window.exportedRows.push(row)};}}};});
  await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export Excel',exact:true}).click()]);
  assert.deepEqual(await page.evaluate(()=>window.exportedRows.map(r=>r.company)),['Fixture Company 499'],'The export follows the range');
  await page.evaluate(()=>window.fixture.tab.render({root:document.querySelector('#root'),scope:'universe'}));
  assert.equal(await period.inputValue(),'range:2019-12-01:2020-02-01','A repaint keeps the range');assert.equal(await from.inputValue(),'2019-12-01');
  await to.fill('2026-10-01');await from.fill('2026-10-20');
  assert.equal(await period.inputValue(),'range:2026-10-01:2026-10-20','Reversed ends are swapped');assert.equal(await from.inputValue(),'2026-10-01');
  assert.match(await page.locator('main').innerText(),/499 of 500/);
  await period.selectOption('12m');assert(await from.inputValue(),'A quick pick shows its own From date');assert.match(await page.locator('main').innerText(),/499 of 500/);
  await period.selectOption('all');assert.equal(await from.inputValue(),'');
  await period.selectOption('latest');
  await page.getByRole('combobox',{name:'Sectors',exact:true}).selectOption('AI');await rounds.selectOption('Series A');await search.fill('Fixture Investor');
  capture={...capture,generatedAt:new Date(Date.parse(capture.generatedAt)+60000).toISOString(),deals:[...capture.deals,{...row(500,'Series A2'),sector:'AI'}]};
  await page.clock.fastForward(5*60000);await page.waitForFunction(()=>window.fixture.feed.rows().length===501);
  assert.equal(await search.inputValue(),'Fixture Investor');assert.equal(await page.getByRole('combobox',{name:'Sectors',exact:true}).inputValue(),'AI');
  assert.equal(await rounds.inputValue(),'Series A','Grouped selection survives new source aliases');
  assert.equal(await search.evaluate(el=>document.activeElement===el),true,'Incoming captures retain active search focus');
  await page.clock.fastForward(13*3600000);await page.getByText('Source check overdue',{exact:true}).waitFor();
  assert.equal(await search.inputValue(),'Fixture Investor','An unchanged publication still ages its source freshness');
  unavailable=true;await page.clock.fastForward(5*60000);await page.waitForFunction(()=>!!window.fixture.feed.meta().readError);assert.equal(await search.inputValue(),'Fixture Investor');assert(await page.locator('tbody tr[data-row-key]').count()>0);
  await page.getByRole('button',{name:'Coverage & source notes'}).click();assert((await page.locator('#modal-content').textContent()).includes('Saved rows remain readable'));
  await page.keyboard.press('Escape');
  await page.reload();await page.waitForFunction(()=>window.fixture?.feed.rows().length===501 && !!window.fixture.feed.meta().readError);
  assert(await page.locator('tbody tr[data-row-key]').count()>0,'IndexedDB preserves captured history across an offline reload');
  unavailable=false;await page.evaluate(()=>window.fixture.feed.refresh());
  await page.getByPlaceholder('Search company, investor, sector or round...').fill('Fixture Investor');
  await page.evaluate(()=>{window.fixture.tab.destroy();window.fixture.tab.render({root:document.querySelector('#root'),scope:'portfolio'});});
  await page.getByRole('heading',{name:'Private Market',exact:true}).waitFor();assert.equal(await search.inputValue(),'Fixture Investor');
  // Portfolio is the family's own private companies, matched by exact name, labelled on the row.
  await page.getByText('Family holding',{exact:true}).waitFor();
  await page.getByText('Family holding · Fixture Brand').waitFor();
  assert.equal(await page.getByText('Family holding · Fixture Company 3').count(),0,'A row named as the holding is not named twice');
  assert.deepEqual((await page.locator('tbody tr[data-row-key]').evaluateAll(rows=>rows.map(r=>r.dataset.rowKey))).sort(),[capture.deals[3].id,capture.deals[7].id],'Portfolio keeps only the family companies, a legal-name match joining its brand');
  assert.equal(await page.getByRole('combobox',{name:'Funding period',exact:true}).inputValue(),'all','Portfolio opens on all captured history');
  assert.match(await page.locator('main').innerText(),/2 of 3 have a captured round/,'The denominator names every private company');
  await page.getByRole('combobox',{name:'Sectors',exact:true}).selectOption('all');await rounds.selectOption('all');await search.fill('');
  assert.equal(await page.locator('tbody tr[data-row-key]').count(),2,'Clearing every filter still shows only the family companies');
  assert(!(await page.locator('main').innerText()).includes('Fixture Company 30'),'Exact names only: no prefix match');
  await page.evaluate(()=>{window.fixture.tab.destroy();window.fixture.tab.render({root:document.querySelector('#root'),scope:'watchlist'});});
  await page.getByText('None of your watchlist companies appears in the captured funding records.').waitFor();
  await page.evaluate(()=>{window.fixture.tab.destroy();window.fixture.tab.render({root:document.querySelector('#root'),scope:'universe'});});
  await page.waitForFunction(()=>document.querySelectorAll('tbody tr[data-row-key]').length>2);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Wide funding columns stay inside their scroller');
  mkdirSync('.cache/private-market',{recursive:true});await page.screenshot({path:'.cache/private-market/reader-light.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'.cache/private-market/reader-dark.png',fullPage:true});
  assert.deepEqual(errors,[]);assert(reads>=4);console.log('PASS private funding browser: canonical round options, native warm-worker upgrade and saved-filter migration, exact grouped export, raw amount/footnotes, complete retained rows, filters/focus across arrivals and failures, source coverage and contained table.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
