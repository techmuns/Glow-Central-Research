// Isolated browser fixture: public source only, exact returns, scopes and cache.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {publishedCohorts} from '../public/js/data/fund-cohorts.js';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const origin='https://fund-returns.test',source='https://returns.fixture',root=resolve('public'),errors=[];
const style=readFileSync(root+'/index.html','utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
const base={schemecode:'d1',fundName:'Fixture Fund-Reg(G)',classification:'Equity : Large Cap',plan:'direct',option:'growth',cohortKey:'large-direct-growth',returns:{'1Y':{return:12.34,categoryMedian:10,categoryAverage:11,rank:1,peerCount:4,excessVsMedian:2.34}}};
let payload={asOfDate:new Date().toISOString().slice(0,10),periods:['1Y'],funds:[base,{...base,schemecode:'r1',plan:'regular',cohortKey:'large-regular-growth'},{...base,schemecode:'d2',fundName:'Second Fund',returns:{'1Y':{...base.returns['1Y'],return:null,rank:null}}},{...base,schemecode:'etf',fundName:'Nifty Index ETF',plan:'regular',classification:'ETFs',cohortKey:'etf'}]};
let gate=null,release=null,fail=false,tag=1,reads=0;
const cohorts=publishedCohorts([base,{...base,returns:{'1Y':{...base.returns['1Y'],categoryMedian:9}}},{...base,cohortKey:null}],['1Y']);
assert.equal(cohorts.length,1);assert.equal(cohorts[0].stats['1Y'].median,null);assert.equal(cohorts[0].stats['1Y'].average,11);assert(cohorts[0].stats['1Y'].conflict);
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin===source){reads++;assert.equal(route.request().headers().authorization,undefined);const snapshot=structuredClone(payload),failed=fail,t=tag;if(gate)await gate;return route.fulfill({status:failed?503:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-expose-headers':'etag',etag:`"${t}"`},body:JSON.stringify(snapshot)});}
  if(u.origin!==origin)return route.fulfill({status:503,body:'Offline fixture'});
  if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><style>${style}</style><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><main id="root" class="p-4"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">import * as tab from '/js/tabs/mutual-funds.js';import * as feed from '/js/data/fund-returns.js';localStorage.setItem('sattva:amfibeas-base','${source}');Object.assign(window,{tab,feed});window.mount=(subview='all-schemes',scope='portfolio')=>tab.render({root:document.querySelector('#root'),subview,scope});window.ready=true;</script>`});
  if(u.pathname==='/js/tabs/mutual-fund-holdings.js')return route.fulfill({contentType:'text/javascript',body:'export const render=()=>{};export const destroy=()=>{};'});
  if(u.pathname==='/js/ui/export.js')return route.fulfill({contentType:'text/javascript',body:'export const todayStamp=()=>"fixture";export const exportSheets=(...args)=>{window.exported=args};export const exportRows=()=>{};'});
  const path=resolve(root,'.'+u.pathname);assert(path.startsWith(root+sep));
  try{return route.fulfill({contentType:{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'text/plain',body:readFileSync(path)});}catch{return route.fulfill({status:404,body:'Missing'});}
 });
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
 const open=async()=>{await page.goto(origin);await page.waitForFunction(()=>window.ready);await page.evaluate(()=>mount());};
 await open();await page.waitForFunction(()=>feed.all().length===3);
 assert.equal(await page.evaluate(()=>feed.all()[0].fundName),'Fixture Fund(G)','option suffix retained');
 assert.equal(await page.locator('tr[data-row-key]').count(),3);
 assert.match(await page.locator('#root').innerText(),/12\.3/);
 await page.locator('[data-table-search]').fill('Second');await page.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length===1);
 assert.match(await page.locator('tr[data-row-key]').innerText(),/—/);
 await page.locator('[data-table-search]').fill('');await page.locator('[data-fund-management]').selectOption('passive');
 assert.equal(await page.locator('tr[data-row-key]').count(),1);assert.match(await page.locator('tr[data-row-key]').innerText(),/ETF/);
 await page.locator('[data-fund-management]').selectOption('all');
 await page.locator('[data-table-search]').click();const etfCategory=await page.evaluate(()=>feed.all().find(r=>r.schemecode==='etf').taxonomy.shownLabel);await page.locator('[data-fund-category]').filter({hasText:etfCategory}).click();
 await page.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length===1);
 await page.getByRole('button',{name:/Export Excel/}).click();
 assert.equal(await page.evaluate(()=>exported[0].sheets[0].rows.length),1);
 assert.equal(await page.evaluate(()=>exported[0].sheets[0].rows[0].schemecode),'etf');
 await page.locator('[data-fund-category-remove]').click();await page.keyboard.press('Escape');

 await page.locator('[data-fund-measure]').selectOption('excess');assert.match(await page.locator('#root').innerText(),/1Y PP/);
 await page.evaluate(()=>mount('category-performance','watchlist'));
 assert.equal(await page.locator('tr[data-row-key]').count(),3);assert.match(await page.locator('#root').innerText(),/11%/);
 await page.getByRole('button',{name:/Export Excel/}).click();assert.equal(await page.evaluate(()=>exported[0].sheets[0].rows.length),3);assert.match(await page.evaluate(()=>exported[0].banner),/NAV date/);
 // Fresh module graph must paint IndexedDB before the source is allowed to answer.
 gate=new Promise(r=>release=r);payload={...payload,funds:[...payload.funds,{...base,schemecode:'late',fundName:'New Arrival'}]};tag++;
 await open();await page.waitForFunction(()=>feed.all().length===3&&feed.meta().revalidating);
 assert.equal(await page.evaluate(()=>feed.meta().origin),'saved');assert(await page.evaluate(()=>feed.meta().checkedAt));
 const before=reads;await page.evaluate(()=>{window.again=feed.load();});assert.equal(reads,before);
 release();gate=null;await page.evaluate(()=>again);await page.waitForFunction(()=>feed.all().length===4);
 fail=true;await page.evaluate(()=>feed.reload());assert.equal(await page.evaluate(()=>feed.all().length),4);assert(await page.evaluate(()=>feed.meta().readFailed));
 assert.match(await page.locator('[data-fund-returns-info]').innerText(),/failed/i);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.setViewportSize({width:390,height:850});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/sattva-fund-returns-390-${theme}.png`});}
 await page.evaluate(()=>tab.destroy());assert.equal(await page.locator('[data-fund-search-menu]').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS exact returns, preserved option/ETF/cohorts, filters, missing values, cache-first reload, concurrent reads, arrivals, failure retention, 390px themes and cleanup');
}finally{release?.();await browser.close();}
