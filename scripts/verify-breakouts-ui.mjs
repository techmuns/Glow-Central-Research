// Actual dashboard, local-only capture fixture, including a returning service-worker session.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public'), AT=Date.parse('2026-09-15T06:30:00Z');
const original=JSON.parse(readFileSync(`${root}/data/technicals.json`)), seed=original.companies.find(row=>!row.error);
const daily={...original,generated_at:'2026-09-15T01:30:00Z',price_date:'2026-09-10',companies:[
 {...seed,ticker:'TEST',name:'Test Company',cmp:105,bar_date:'2026-09-10',price_date:undefined,sma200:90,high_52w:120,consolidation_breakout:{...seed.consolidation_breakout,quality:'strong'}},
 // Graded weak_base at its own daily close; today's quote for it carries NO base (Yahoo had not
 // published the previous session's bar). It must stay on the view, dated, not vanish.
 {...seed,ticker:'NOBASE',name:'No Base Today',cmp:50,bar_date:'2026-09-10',price_date:undefined,sma200:40,high_52w:60,consolidation_breakout:{...seed.consolidation_breakout,quality:'weak_base',breaks_out:true,base_max:48,base_range_pct:15,today_volume_ratio:1.8}},
],company_count:2,failures:0};
const deployedDaily=structuredClone(daily);
let price=106,volume=2000,at=AT,fail=false,revision=1,reads=0,muns=0,historyReads=0,noTrades=false,provider='Upstox',dailyFail=false,companionFail=false,dailySha='a'.repeat(40),noBase=true;
const snapshot=()=>({version:1,state:'complete',targets:['TEST','FUTURE','WATCHONLY','NOBASE'],startedAt:new Date(at-1000).toISOString(),completedAt:new Date(at).toISOString(),captureStartedAt:'2026-09-15T03:45:00Z',failures:[],gaps:[{count:1,reason:'candles-unavailable',since:AT-3600000,until:AT}],rows:[
 ...['TEST','FUTURE','WATCHONLY'].map(ticker=>({ticker,name:ticker==='TEST'?'Test Company':'Future Holding',price,volume:noTrades?0:volume,prevClose:98,quoteAt:new Date(noTrades?AT-4*86400000:at).toISOString(),...(noTrades?{feedAt:new Date(at).toISOString()}:{}),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider,base:{high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-09-11'}})),
 {ticker:'NOBASE',name:'No Base Today',price:52,volume:500,prevClose:50,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-09-15',provider,base:noBase?null:{high:55,low:45,average:50,averageVolume:1000,count:30,to:'2026-09-11'}},
]});
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 res.setHeader('cache-control','no-cache');
 const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
 // Portfolio membership is injected below; the separate Glow parity suite tests its statement bridge.
 if(path==='/glow-bridge.html'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Local portfolio fixture</title>');return;}
 if(path==='/api/breakouts/history'){historyReads++;return json({rows:[],nextCursor:null});}
 if(path==='/api/breakouts'){reads++;if(fail){res.writeHead(503).end();return;}return json(snapshot());}
 if(path==='/api/technicals') { if(dailyFail){res.writeHead(503).end();return;} res.setHeader('x-sattva-revision',dailySha);return json(daily); }
 if(path==='/api/technicals/atr-history'||path==='/api/technicals/source') {
  assert.equal(new URL(req.url,'http://localhost').searchParams.get('revision'),dailySha);
  if(companionFail){res.writeHead(503).end();return;}
  res.setHeader('x-sattva-revision',dailySha);return json(path.endsWith('atr-history')?{TEST:[{date:daily.price_date,atr_pct:1.23}]}:{});
 }
 if(path==='/data/universe.json')return json(['TEST','FUTURE'].map(ticker=>({Company:ticker,'Screener URL':`https://www.screener.in/company/${ticker}/`})));
 if(path==='/api/watchlist')return json({ok:true,revision:1,updatedAt:new Date(AT).toISOString(),companies:[{ticker:'WATCHONLY',name:'Watchlist only'}]});
 if(path==='/data/technicals.json')return json(deployedDaily);
 if(path==='/data/atr-history.json')return json({TEST:[{date:'2026-09-10',atr_pct:9.99}]});
 if(path==='/api/live-prices'){muns++;res.writeHead(503).end();return;}
 if(path.startsWith('/api/'))return json({ok:false});
 const file=resolve(root,`.${path==='/'?'/index.html':path}`);
 if(!file.startsWith(root+sep)){res.writeHead(404).end();return;}
 try{
 let body=readFileSync(file);
 if(path==='/sw.js')body=body.toString().replace(/const CACHE_NAME = [^;]+;/, `const CACHE_NAME = 'sattva-dashboard-breakout-test-${revision}';`);
 if(['/js/data/breakout-live.js','/js/tabs/ai-alerts.js'].includes(path))body=`export const testRelease=${revision};\n`+body.toString();
 res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream');res.end(body);
 }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.fulfill({contentType:'text/javascript',body:''}));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install({time:AT});
 await page.goto(`${origin}/#/research/breakouts/strong-breakouts?scope=universe`);
 const cell=page.locator('[data-cmp="TEST"]');await cell.waitFor();
 assert.equal(await cell.textContent(),'₹106.00');
 assert((await cell.locator('..').innerText()).includes('Muns API'));
 assert(!(await cell.locator('..').innerText()).match(/Yahoo|Upstox/));
 assert.equal(await page.evaluate(async()=>(await import('/js/data/breakout-live.js')).snapshot().rows[0].provider),'Upstox','retain underlying provider');
 assert.equal(await page.evaluate(async()=>(await import('/js/data/technicals.js')).byTicker('TEST').company.atr_history[0].atr_pct),1.23);
 await page.locator('[data-row-key="FUTURE"]').waitFor();
 assert.equal(await page.locator('[data-row-key="WATCHONLY"]').count(),0);
 // A quote without a base keeps the company on the view under its dated daily grade, with today's
 // price beside it; the line under the chips accounts for it and the workbook carries the basis.
 const noBaseRow=page.locator('[data-row-key="NOBASE"]');await noBaseRow.waitFor();
 assert.equal(await page.locator('[data-cmp="NOBASE"]').textContent(),'₹52.00');
 assert.equal(await noBaseRow.locator('[data-grade-source="daily"]').innerText(),'Graded at 2026-09-10 close');
 assert.equal(await page.locator('[data-row-key="TEST"] [data-grade-source]').count(),0,'a capture-graded row carries no dated note');
 assert.equal(await page.locator('[data-daily-graded]').innerText(),'1 of them is graded at the 2026-09-10 close because today\'s price capture carries no 30-session base for it.');
 assert.equal(await page.locator('[data-ungraded]').count(),0);
 await page.evaluate(()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe&bo=weak_base';});
 await page.waitForFunction(()=>document.querySelector('[data-row-key="NOBASE"]')&&!document.querySelector('[data-row-key="TEST"]'));
 await page.evaluate(()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe&bo=strong';});
 await page.waitForFunction(()=>document.querySelector('[data-row-key="TEST"]')&&!document.querySelector('[data-row-key="NOBASE"]'));
 await page.evaluate(()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe';});
 await noBaseRow.waitFor();await cell.waitFor();
 assert.equal(await page.locator('[data-live-info]').innerText(),'Partial update · 2/3','a quote with no base is not covered, and the pill says so');
 // Once the source publishes the missing bar the capture grades NOBASE itself: ₹52 under a ₹55 base
 // high is no breakout, so the row leaves this view and the dated-grade sentence goes with it.
 noBase=false;await page.evaluate(async()=>{await (await import('/js/data/breakout-live.js')).refresh();});
 await page.waitForFunction(()=>!document.querySelector('[data-row-key="NOBASE"]')&&!document.querySelector('[data-daily-graded]'));
 await page.evaluate(async()=>{await (await import('/js/core/watchlist.js')).syncNow({force:true});location.hash='#/research/breakouts/strong-breakouts?scope=watchlist';});
 await page.locator('[data-row-key="WATCHONLY"]').waitFor();
 assert.equal(await page.locator('[data-row-key="FUTURE"]').count(),0);
 await page.evaluate(()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe';});
 await cell.waitFor();assert.equal(await page.locator('[data-row-key="WATCHONLY"]').count(),0);
 await page.evaluate(async()=>{(await import('/js/core/scope-lists.js')).add('universe',{ticker:'WATCHONLY',name:'Explicit addition'});await (await import('/js/data/breakout-live.js')).refresh();});
 await page.locator('[data-row-key="WATCHONLY"]').waitFor();
 await page.evaluate(async()=>{(await import('/js/core/scope-lists.js')).remove('universe',{ticker:'WATCHONLY'});await (await import('/js/data/breakout-live.js')).refresh();});
 await page.waitForFunction(()=>!document.querySelector('[data-row-key="WATCHONLY"]'));
 assert.equal(await page.locator('[data-capture-note]').count(),0);
 const sourceState=()=>page.evaluate(async()=>(await import('/js/ui/sources.js')).sourceGroups().flatMap(group=>group.items).find(item=>item.name.startsWith('Saved price and volume capture')).readState);
 assert.equal(await sourceState(),'partial');
 // Both quote tables must update for every scope, with a shared service label.
 await page.evaluate(async()=>{
  (await import('/js/data/coverage.js')).useFamilyBook([{ticker:'TEST',name:'Test Company'},{ticker:'FUTURE',name:'Future Holding'}],'2026-09-15',Date.now());
 });
 for (const view of ['strong-breakouts','technical-scanner']) {
  for (const scope of ['portfolio','watchlist','universe']) {
   await page.evaluate(hash=>{location.hash=hash;},`#/research/breakouts/${view}?scope=${scope}`);
   const expected=scope==='watchlist'?['WATCHONLY']:['TEST','FUTURE'];
   for (const ticker of expected) await page.locator(`[data-row-key="${ticker}"]`).waitFor();
   for (const ticker of (scope==='watchlist'?['TEST','FUTURE']:['WATCHONLY'])) assert.equal(await page.locator(`[data-row-key="${ticker}"]`).count(),0);
   price+=1;at+=60000;
   await page.clock.runFor(61000);
   for (const ticker of expected) {
    await page.waitForFunction(({ticker,price})=>document.querySelector(`[data-cmp="${ticker}"]`)?.textContent===`₹${price.toFixed(2)}`,{ticker,price});
    assert((await page.locator(`[data-cmp="${ticker}"]`).locator('..').innerText()).includes('Muns API'),`${view}/${scope}/${ticker}: ${await page.locator(`[data-cmp="${ticker}"]`).locator('..').innerText()}`);
   }
   await page.locator(`[data-row-key="${expected[0]}"]`).click();
   await page.locator('[data-stat="breakout-price"]').waitFor();
   assert((await page.locator('[data-stat="breakout-price"]').innerText()).includes(`₹${price}`));
   await page.locator('[data-drill-close]').click();
   console.log(`PASS ${scope}: ${view} prices, service label and matching detail`);
  }
 }
 price=106;at=AT;
 await page.evaluate(async()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe';await (await import('/js/data/breakout-live.js')).refresh();});
 await cell.waitFor();

 await page.locator('[data-table-search]').fill('Test Company');
 await page.locator('[data-table-search]').evaluate(input=>input.setSelectionRange(0,input.value.length));
 await page.evaluate(async()=>{await (await import('/js/data/breakout-live.js')).refresh();});
 assert.deepEqual(await page.locator('[data-table-search]').evaluate(input=>[input.selectionStart,input.selectionEnd]),[0,'Test Company'.length]);
 await page.locator('[data-row-key="TEST"]').click();
 const popup=page.locator('[data-stat="breakout-price"]');await popup.waitFor();
 assert((await popup.innerText()).includes('₹106'));
 price=108;at=await page.evaluate(()=>Date.now());
 // A visible automatic interval updates the open popup and table from one shared read.
 await page.clock.runFor(16000);
 await page.waitForFunction(()=>document.querySelector('[data-cmp="TEST"]')?.textContent==='₹108.00');
 assert((await popup.innerText()).includes('₹108'));assert((await popup.innerText()).includes('+10.20%'));
 assert.equal((await page.locator('[data-table-search]').inputValue()).toLowerCase(),'test company');
 assert((await page.locator('#drill-content').innerText()).includes('2026-09-10'));
 dailySha='b'.repeat(40);daily.generated_at='2026-09-15T06:31:00Z';daily.price_date=daily.companies[0].bar_date='2026-09-11';daily.companies[0].ema50=999;
 await page.clock.runFor(16*60000);
 await page.waitForFunction(()=>document.querySelector('#drill-content')?.textContent.includes('close 2026-09-11'));
 assert((await page.locator('#drill-content').innerText()).includes('999'));
 assert((await popup.innerText()).includes('₹108'));
 await page.locator('[data-drill-close]').click();
 const refreshDaily=()=>page.evaluate(async()=>{const r=await import('/js/core/refresh.js');const result=await r.refreshOne('technicals-view');return {result,lastAt:r.lastRefreshAt('technicals-view')};});
 const goodDaily=await refreshDaily();assert.equal(goodDaily.result.partial,false);
 dailyFail=true;await page.clock.runFor(1000);
 const failedDaily=await refreshDaily();assert.equal(failedDaily.result.partial,true);assert.equal(failedDaily.lastAt,goodDaily.lastAt);
 dailyFail=false;companionFail=true;dailySha='c'.repeat(40);daily.generated_at='2026-09-15T06:45:00Z';daily.companies[0].ema50=888;
 assert.equal((await refreshDaily()).result.partial,true);
 assert.equal(await page.evaluate(async()=>(await import('/js/data/technicals.js')).byTicker('TEST').company.ema50),999);
 companionFail=false;
 fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>document.querySelector('[data-live-info]')?.textContent.includes('Partial update'));
 assert.equal(await cell.textContent(),'₹108.00');assert((await cell.locator('..').innerText()).includes('Saved'));
 assert.equal(await sourceState(),'unavailable');
 fail=false;price=99;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(()=>!document.querySelector('[data-cmp="TEST"]'));
 assert.equal((await page.locator('[data-table-search]').inputValue()).toLowerCase(),'test company');
 price=110;volume=2200;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(()=>document.querySelector('[data-cmp="TEST"]')?.textContent==='₹110.00');
 assert.equal(muns,0);assert(reads>=4);
 // Returning readers must actually replace their cached module graph after the release changes.
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await page.reload();await cell.waitFor();
 assert.equal(await page.evaluate(async()=>(await import('/js/data/breakout-live.js')).testRelease),1);
 assert.equal(await page.evaluate(async()=>(await import('/js/tabs/ai-alerts.js')).testRelease),1);
 revision=2;
 const upgraded=page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame(),timeout:30000});
 await page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
 await upgraded;await cell.waitFor();
 assert.equal(await page.evaluate(async()=>(await import('/js/data/breakout-live.js')).testRelease),2);
 assert.equal(await page.evaluate(async()=>(await import('/js/tabs/ai-alerts.js')).testRelease),2,
  'the returning session also adopts the AI Alerts module and its new reconciliation dependency');
 await cell.waitFor();assert.equal(await cell.textContent(),'₹110.00');await page.clock.runFor(1000);
 if(process.env.BREAKOUT_SCREENSHOTS){mkdirSync(process.env.BREAKOUT_SCREENSHOTS,{recursive:true});await page.screenshot({path:`${process.env.BREAKOUT_SCREENSHOTS}/breakouts-desktop.png`});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${process.env.BREAKOUT_SCREENSHOTS}/breakouts-mobile.png`});}
 // Same-date daily close replaces an obsolete intraday quote in filtering and popup.
 dailySha='d'.repeat(40);daily.generated_at='2026-09-15T14:00:00Z';daily.price_date=daily.companies[0].bar_date='2026-09-15';daily.companies[0].cmp=99;
 daily.companies[0].consolidation_breakout={...daily.companies[0].consolidation_breakout,quality:'no_breakout',breaks_out:false,today_close:99};
 await page.clock.setFixedTime(Date.parse('2026-09-15T14:00:00Z'));
 await refreshDaily();await page.waitForFunction(()=>!document.querySelector('[data-cmp="TEST"]'));
 await page.evaluate(()=>{location.hash='#/research/breakouts/technical-scanner?scope=universe';});
 await cell.waitFor();assert.equal(await cell.textContent(),'₹99.00');
 assert.equal(await page.locator('[data-capture-note]').count(),0);
 await page.locator('[data-row-key="TEST"]').click();await popup.waitFor();
 assert((await popup.innerText()).includes('₹99'));assert((await popup.innerText()).includes('Daily close'));
 await page.locator('[data-drill-close]').click();
 noTrades=true;at=Date.parse('2026-09-15T14:00:00Z');
 await page.evaluate(async()=>{await (await import('/js/data/breakout-live.js')).refresh();});
 const quietCell=page.locator('[data-cmp="FUTURE"]');
 assert((await quietCell.locator('..').innerText()).includes('Last trade'));
 assert((await quietCell.locator('..').innerText()).includes('11 Sept'));
 assert.equal(await cell.textContent(),'₹99.00','old trade cannot replace a newer daily close');
 await page.evaluate(()=>{location.hash='#/research/breakouts/strong-breakouts?scope=universe';});
 await page.waitForFunction(()=>!document.querySelector('[data-cmp="FUTURE"]'));
 // Fallback remains honestly dated under the same customer-facing service brand.
 noTrades=false;provider='Yahoo Finance';at=Date.parse('2026-09-15T10:00:00Z');
 await page.evaluate(async()=>{location.hash='#/research/breakouts/technical-scanner?scope=universe';await (await import('/js/data/breakout-live.js')).refresh();});
 await quietCell.waitFor();
 assert((await quietCell.locator('..').innerText()).includes('Muns API'));
 assert(!(await quietCell.locator('..').innerText()).match(/Yahoo|Upstox/));
 assert.equal(await page.evaluate(async()=>(await import('/js/data/breakout-live.js')).snapshot().rows[0].provider),'Yahoo Finance');
 assert.equal(historyReads,0,'normal dashboard use must not download minute archives');
 assert.deepEqual(errors,[]);
 console.log('PASS breakout dashboard: automatic price/volume changes, matching open popup, daily score date, new holding, failure retention, filter/search preservation, no Muns calls, returning session release upgrade');
}finally{await browser.close();await new Promise(done=>server.close(done));}
