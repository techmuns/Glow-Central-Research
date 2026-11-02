#!/usr/bin/env node
// Real tab and ranking, local source fixtures, no production or paid-provider calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve(import.meta.dirname,'../public');
const universe=[{ticker:'J&KBANK',name:'J & K Bank',industry:'Banks'},{ticker:'HDFCBANK',name:'HDFC Bank',industry:'Banks'}];
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/glow.css"><main id="root"></main><script type="module">
import*as tab from '/js/tabs/ai-alerts.js';import*as coverage from '/js/data/coverage.js';
coverage.prime({holdings:[{ticker:'J&KBANK',name:'Jammu & Kashmir Bank',isin:'INE168A01041',sector:'Financials'}]});
window.show=scope=>tab.render({root:document.querySelector('#root'),scope,params:{},data:{universe:${JSON.stringify(universe)}}});
window.show('universe');</script>`;
const source=`import{currentDay}from'../ui/ai-alert-utils.js';export{currentDay as today}from'../ui/ai-alert-utils.js';
const listeners=new Set();export const onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
window.arrive=()=>{window.extra=true;listeners.forEach(fn=>fn())};
export async function readCachedAlertWindow(){return null;}
export async function collect({scope,onPartial}){
const day=currentDay();const base={day,time:null,direction:'neutral',importance:'high',url:'https://example.test/source',tab:'news'};
const events=[{...base,id:'company',ticker:'J&KBANK',company:'Jammu & Kashmir Bank',feed:'announcements',feedLabel:'BSE',headline:'J&K Bank files a results presentation'},
{...base,id:'peer',ticker:'HDFCBANK',company:'HDFC Bank',feed:'announcements',feedLabel:'BSE',headline:'HDFC Bank files a presentation'},
...Array.from({length:8},(_,i)=>({...base,id:'sector-'+i,importance:'low',ticker:null,company:'Market-wide',feed:'market-news',headline:'RBI changes banking liquidity rule '+i,url:'https://example.test/rule-'+i}))];
if(window.extra)events.push({...base,id:'late',ticker:null,company:'Market-wide',feed:'market-news',headline:'RBI announces a new bank deposit rule',url:'https://example.test/late'});
const report={scope,day,pending:0,events:scope==='universe'?events:events.filter(e=>e.ticker==='J&KBANK'),feeds:[{id:'announcements',status:'ok',reachesToday:true,asOf:day},{id:'market-news',status:'failed',reachesToday:false,asOf:day,note:'One publisher failed'}]};
onPartial?.({...report,pending:1});return report;}`;
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  res.setHeader('cache-control','no-store');
  if(path==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
  if(path==='/js/data/daily-alerts.js'){res.setHeader('content-type','text/javascript');res.end(source);return;}
  if(path.startsWith('/api/')){res.writeHead(503);res.end('{}');return;}
  const file=resolve(root,'.'+path);
  if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  try{res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.json':'application/json','.html':'text/html'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));}
  catch{res.writeHead(404);res.end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/Los_Angeles'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:503,body:'{}'}));
  await page.goto(origin);
  const pilot=page.locator('[data-ai-bank-pilot-card]');
  await pilot.waitFor();
  await page.waitForFunction(()=>document.querySelector('[data-ai-bank-pilot-card]')?.textContent.includes('Partial or stale'));
  assert.equal(await pilot.locator('[data-ai-bank-group]').count(),3);
  assert.match(await pilot.locator('[data-ai-bank-group="peers"]').textContent(),/HDFC Bank/);
  assert.match(await pilot.locator('[data-ai-bank-group="industry"]').textContent(),/RBI changes banking/);
  await pilot.locator('[data-ai-bank-more="industry"] summary').click();
  assert.equal(await pilot.locator('[data-ai-bank-group="industry"] li').count(),8);
  const download=page.waitForEvent('download');await pilot.locator('[data-ai-bank-export]').click();
  const saved=await download;assert.match(saved.suggestedFilename(),/glow-jkbank-universe-pilot/);
  const content=readFileSync(await saved.path(),'utf8');assert(content.includes('banking liquidity rule 7'));assert.match(content,/reading brief/i);
  await page.evaluate(()=>window.arrive());
  await page.waitForFunction(()=>document.querySelector('[data-ai-bank-pilot-card]')?.textContent.includes('new bank deposit rule'));
  assert.equal(await pilot.locator('[data-ai-bank-more="industry"]').getAttribute('open'),'','expanded evidence survives arrivals');
  assert.equal(await pilot.locator('[data-ai-bank-group="industry"] li').count(),9);
  await page.evaluate(()=>window.show('portfolio'));await pilot.waitFor({state:'detached'});
  await page.evaluate(()=>window.show('watchlist'));assert.equal(await pilot.count(),0);
  await page.evaluate(()=>window.show('universe'));await pilot.waitFor();
  const output=resolve(root,'../.cache/bank-alert-pilot');mkdirSync(output,{recursive:true});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const light=await pilot.evaluate(node=>getComputedStyle(node).backgroundColor);
  assert.equal(light,'rgb(255, 255, 255)','light mode has an opaque shared white surface');
  await page.screenshot({path:resolve(output,'fixture-light.png')});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'pilot fits a narrow viewport');
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.notEqual(await pilot.evaluate(node=>getComputedStyle(node).backgroundColor),light,'pilot follows the actual shared dark-theme tokens');
  await page.screenshot({path:resolve(output,'fixture-dark-mobile.png')});
  assert.equal(await pilot.locator('h2').count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS: real AI Alerts tab, three linked groups, complete download, failed-source notice, automatic arrivals with expanded-state preservation, Universe-only scopes, narrow viewport and no JavaScript errors.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
