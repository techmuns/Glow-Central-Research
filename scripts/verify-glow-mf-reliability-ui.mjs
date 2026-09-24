// Offline browser tests for saved public market data, failure retention and Glow scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { coverageRows } from '../public/js/data/mutual-funds-coverage.js';
import { comparisonStatus } from '../public/js/data/mutual-funds-status.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const browser = await chromium.launch();
const origin = 'https://glow-mf.test', source = 'https://sattva-central-research.tech-441.workers.dev';
const root = resolve('public'), errors = [], reads = [];
const isin = 'INE090A01021', other = 'INE040A01034';
const now = new Date(), monthDate = new Date(now); monthDate.setUTCDate(1); monthDate.setUTCMonth(monthDate.getUTCMonth()-1);
const month = monthDate.toISOString().slice(0,7);
const row = { isin, name:'Glow Fixture Company', ticker:'FIXTURE', month, totalShares:120, netChange:20, comparableFunds:1, addedFunds:1, reducedFunds:0, pendingFunds:0, direction:'Added', insight:'Saved comparison', revision:'one' };
const sourceMeta = { checkedAt:now.toISOString(), state:'complete', run:'one', amcs:[
  {name:'Current AMC',status:'ok',month,checkedAt:now.toISOString()},
  {name:'Unavailable AMC',status:'unavailable',month,checkedAt:null},
] };
const company = { ...row, months:[month], availableMonths:[month], funds:[{id:'fund-one', name:'Fixture Fund', amc:'fixture', change:20, changePct:20, action:'Added', current:{shares:120}, months:{}}] };
const fund = {schemecode:'one',fundName:'Fixture Direct Fund',classification:'Equity : Large Cap',plan:'direct',option:'growth',returns:{'1Y':{return:12,categoryMedian:10,rank:1,peerCount:4,excessVsMedian:2}}};
let summary = {rows:[row],meta:sourceMeta}, detail = {company,meta:sourceMeta};
let returns = {asOfDate:now.toISOString().slice(0,10),periods:['1Y'],funds:[fund]};
let holdGate=null, returnGate=null, failHoldings=false, failReturns=false, returnTag='one', detailGate=null;
const gate = () => {let release;const promise=new Promise(r=>release=r);return {promise,release};};
assert.equal(comparisonStatus({direction:'Pending',totalShares:null,pendingFunds:0}).label,'No disclosure');
assert.equal(comparisonStatus({totalShares:0,pendingFunds:0}).label,'Comparison unavailable');
assert.deepEqual(coverageRows(sourceMeta).map(r=>r.tone),['positive','caution']);
assert(!coverageRows({...sourceMeta,readFailed:true}).some(r=>r.tone==='positive'));
assert(!coverageRows(sourceMeta,now.getTime()+86400000).some(r=>r.tone==='positive'));
try {
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*', async route => {
    const request=route.request(),u=new URL(request.url());
    const send = (value,status=200,headers={}) => route.fulfill({status,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-expose-headers':'etag',...headers},body:JSON.stringify(value)});
    if (u.origin===source || u.origin==='https://returns.fixture') {
      assert.equal(request.headers().authorization,undefined,'private session credentials never cross to public market sources');
      reads.push(u.href);
      if(u.origin==='https://returns.fixture') {
        const value=structuredClone(returns),tag=returnTag,fail=failReturns;
        if(returnGate)await returnGate.promise;
        return send(value,fail?503:200,{etag:`"${tag}"`});
      }
      assert(!u.pathname.includes('private'),'no Sattva private scanner/book endpoint');
      if(u.pathname.endsWith('/company')) {if(detailGate)await detailGate.promise;return send(detail);}
      const value=structuredClone(typeof summary==='function'?summary(u):summary),fail=failHoldings;
      if(holdGate)await holdGate.promise;
      return send(value,fail?503:200);
    }
    if(u.origin!==origin)return route.fulfill({status:503,body:'External sources disabled'});
    if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/glow.css"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
      import * as feed from '/js/data/mutual-fund-holdings.js'; import * as funds from '/js/data/fund-returns.js';
      import * as tab from '/js/tabs/mutual-funds.js'; import * as coverage from '/js/data/coverage.js'; import * as store from '/js/core/store.js';
      localStorage.setItem('sattva:amfibeas-base','https://returns.fixture');
      coverage.prime({holdings:[{isin:'${isin}',ticker:'FIXTURE',name:'Glow Fixture Company'}]});
      Object.assign(window,{feed,funds,tab,store,coverage}); window.mount=(subview='company-holdings')=>tab.render({root:document.querySelector('#root'),scope:'portfolio',subview}); window.ready=true;
      </script>`});
    // Position sizes are a separate private feature; the fixture exercises newest ordering.
    if(u.pathname==='/js/research/portfolio-bridge.js')return route.fulfill({contentType:'text/javascript',body:'export const cachedPositionSizes=()=>null;export const readPositionSizes=async()=>null;export const onPortfolioReady=()=>()=>{};export const onPortfolioInvalidation=()=>()=>{};export const portfolioConnectionState=()=>"unavailable";export const unlockPortfolio=()=>{};'});
    const file=resolve(root,'.'+u.pathname);
    if(!file.startsWith(root+sep))return route.fulfill({status:404,body:'Missing'});
    try {return route.fulfill({contentType:{'.js':'text/javascript','.json':'application/json','.css':'text/css'}[extname(file)]||'text/plain',body:readFileSync(file)});}catch{return route.fulfill({status:404,body:'Missing'});}
  });
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(origin);await page.waitForFunction(()=>window.ready);};
  await open(); await page.evaluate(()=>feed.load());
  // New visit with a slow source: real IndexedDB supplies the table immediately.
  holdGate=gate();summary={rows:[{...row,totalShares:250,revision:'two'}],meta:{...sourceMeta,run:'two'}};
  await open(); await page.evaluate(()=>mount());
  await page.waitForFunction(()=>feed.all()[0]?.totalShares===120);
  assert.equal(await page.locator('#root tr[data-row-key]').count(),1);
  assert.equal(await page.evaluate(()=>feed.meta().revalidating),true);
  const before=reads.length; await page.evaluate(()=>{window.same=feed.load();});
  holdGate.release();holdGate=null;await page.evaluate(()=>same);
  assert.equal(reads.length,before,'concurrent summary requests coalesce');
  await page.waitForFunction(()=>feed.all()[0]?.totalShares===250);
  failHoldings=true;await page.evaluate(()=>feed.load());failHoldings=false;
  assert.equal(await page.evaluate(()=>feed.all()[0].totalShares),250);
  assert.equal(await page.evaluate(()=>feed.meta().readFailed),true);
  console.log('PASS saved holdings before network, corrections, request deduplication and failed-read retention');

  await page.evaluate(()=>feed.load());
  await page.locator('[data-mf-coverage]').click();
  assert.equal(await page.locator('.mf-coverage p').count(),0);
  assert.equal(await page.locator('.mf-coverage-table tbody tr').count(),2);
  assert.equal(await page.locator('.mf-coverage-status[data-tone="positive"]').count(),1);
  for(const scheme of ['light','dark']) {
    await page.evaluate(s=>document.documentElement.dataset.theme=s,scheme);
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.locator('.mf-coverage-table').isVisible());
      assert(await page.locator('.mf-detail-scroll').evaluate(el=>el.scrollWidth>=el.clientWidth));
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('.mf-coverage [data-modal-close]').click();
  await page.evaluate(()=>feed.detail('INE090A01021'));
  detailGate=gate();
  await page.locator('#root tr[data-row-key]').click();
  await page.locator('.mf-detail-table tbody tr').waitFor();
  assert.match(await page.locator('.mf-detail-table').innerText(),/Fixture Fund/);
  detailGate.release();detailGate=null;
  await page.locator('.mf-detail [data-modal-close]').click();
  console.log('PASS compact Coverage, honest green status, responsive themes and saved company drilldown');

  const many=Array.from({length:251},(_,i)=>({...row,isin:`INE${String(i).padStart(9,'0')}`,name:`Company ${i}`}));
  summary=u=>{const ids=u.searchParams.get('isins');return ids?{rows:many.filter(r=>ids.split(',').includes(r.isin)),meta:sourceMeta}:{rows:u.searchParams.get('cursor')?[many.at(-1)]:many.slice(0,250),meta:sourceMeta,nextCursor:u.searchParams.get('cursor')?null:'next'};};
  const start=reads.length;
  assert.equal((await page.evaluate(holdings=>feed.load('portfolio',{holdings}),many)).rows.length,251);
  assert.equal(reads.length-start,2,'large Glow portfolios are batched');
  assert.equal((await page.evaluate(()=>feed.load('universe'))).rows.length,251);
  summary=u=>({rows:[{...row,totalShares:999}],meta:sourceMeta,nextCursor:'repeat'});
  await page.evaluate(()=>feed.load('universe'));
  assert.equal(await page.evaluate(()=>feed.all().length),251,'a looping/failed page retains the whole last successful snapshot');
  assert.equal(await page.evaluate(()=>feed.meta().readFailed),true);
  summary={rows:[{...row,isin:other}],meta:sourceMeta};
  await page.evaluate(()=>feed.load());
  assert.equal(await page.evaluate(()=>feed.all()[0].totalShares),250,'a wrong-company response cannot poison the scoped cache');
  console.log('PASS large scope, full pagination, repeated cursor and wrong-company rejection');

  await page.evaluate(()=>{tab.destroy();return funds.load();});
  await page.evaluate(()=>{window.previous=funds.all();return funds.reload();});
  assert(await page.evaluate(()=>previous===funds.all()),'unchanged source retains normalised rows');
  returnGate=gate();returnTag='two';returns={...returns,funds:[{...fund,returns:{'1Y':{return:14,categoryMedian:11,rank:1,peerCount:4,excessVsMedian:3}}}]};
  await open();await page.evaluate(()=>mount('all-schemes'));
  await page.waitForFunction(()=>funds.all().length===1);
  assert.equal(await page.evaluate(()=>funds.all()[0].returns['1Y'].return),12);
  assert.equal(await page.evaluate(()=>funds.meta().origin),'saved');
  assert.equal(await page.evaluate(()=>funds.meta().checkedAt),null,'cache restoration cannot invent a successful source check');
  returnGate.release();returnGate=null;
  await page.waitForFunction(()=>funds.all()[0]?.returns['1Y'].return===14);
  failReturns=true;await page.evaluate(()=>funds.reload());failReturns=false;
  assert.equal(await page.evaluate(()=>funds.all()[0].returns['1Y'].return),14);
  assert.equal(await page.locator('#root tr[data-row-key]').count(),1);
  assert.match(await page.locator('[data-fund-returns-info]').innerText(),/Saved · check failed/);
  returnTag='bad';returns={funds:[{schemecode:'corrupt'}]};await page.evaluate(()=>funds.reload());
  assert.equal(await page.evaluate(()=>funds.all()[0].returns['1Y'].return),14);
  await open();returnGate=gate();await page.evaluate(()=>mount('all-schemes'));
  await page.waitForFunction(()=>funds.all().length===1);
  assert.equal(await page.evaluate(()=>funds.all()[0].returns['1Y'].return),14,'malformed 200 cannot replace durable last-good data');
  returnGate.release();returnGate=null;await page.waitForFunction(()=>!funds.meta().revalidating);
  // Real lifecycle listeners re-check after inactivity; leaving the view removes them.
  returns={asOfDate:now.toISOString().slice(0,10),periods:['1Y'],funds:[fund]};returnTag='three';
  await page.evaluate(()=>{const real=Date.now;Date.now=()=>real()+16*60000;window.dispatchEvent(new Event('focus'));});
  await page.waitForFunction(()=>funds.meta().origin==='live');
  const stopped=reads.length;await page.evaluate(()=>{tab.destroy();window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));});
  assert.equal(reads.length,stopped);
  assert.deepEqual(errors,[]);
  console.log('PASS returns cache-first reload, no repeated normalisation, failure/malformed retention, resume refresh and cleanup');
} finally {holdGate?.release();returnGate?.release();detailGate?.release();await browser.close();}
