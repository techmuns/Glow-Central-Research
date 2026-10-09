import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
const {chromium}=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public');
const bridge=`let available=true,listener,invalidated;export const onPortfolioConnection=fn=>{listener=fn;};export const onPortfolioInvalidation=fn=>{invalidated=fn;};export const priceLevelsAvailable=()=>available;export const readPriceLevels=cursor=>window.readFixture(cursor);window.disconnect=()=>{available=false;listener(false);};window.connect=()=>{available=true;listener(true);};window.invalidate=()=>invalidated();`;
const html=`<!doctype html><script type="module">
window.calls=[];window.readFixture=async cursor=>{window.calls.push(cursor);if(window.deny)throw Error('locked');if(window.hold)await new Promise(r=>window.release=r);const start=cursor?200:0;return {ok:true,revision:1,companies:[],hits:Array.from({length:cursor?5:200},(_,i)=>({id:'private-'+(start+i),ticker:'TEST',isin:'INE000000001',name:'Private fixture',level:'sellAt',value:200,price:210,reachedAt:'2026-10-01T05:35:00Z',setAt:'2026-10-01T05:30:00Z',quoteAt:'2026-10-01T05:35:00Z',basis:'last',session:'2026-10-01'})),nextCursor:cursor?null:'next',pending:0,check:{state:'idle',checkedAt:'2026-10-01T05:35:00Z',current:true}};};
window.price=await import('/js/data/price-levels.js');window.cache=await import('/js/data/all-alerts-cache.js');window.daily=await import('/js/data/daily-alerts.js');window.ai=await import('/js/data/ai-alerts.js');window.stories=await import('/js/data/alert-stories-shared.js');window.notes=await import('/js/data/alert-notes.js');window.dev=await import('/js/data/alert-developments.js');window.ready=true;
</script>`;
const server=createServer((req,res)=>{const p=new URL(req.url,'http://local').pathname;if(p==='/'){res.setHeader('content-type','text/html');return res.end(html);}if(p==='/js/research/portfolio-bridge.js'){res.setHeader('content-type','text/javascript');return res.end(bridge);}try{const f=resolve(root,'.'+p);if(!f.startsWith(root+sep))throw Error();res.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.css':'text/css'}[extname(f)]||'text/plain');res.end(readFileSync(f));}catch{res.writeHead(404);res.end('{}');}});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage(),errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external.push(r.request().url());return r.fulfill({status:503,body:'{}'});}return r.continue();});
 await page.goto(origin);await page.waitForFunction(()=>window.ready);await page.evaluate(()=>price.load());
 const result=await page.evaluate(()=>{
  const feed={id:'price-levels',...price.readFeed()},events=feed.events.map(e=>({...e,feed:'price-levels'}));feed.events=events;
  const report={day:'2026-10-01',scope:'portfolio',events,sourceFeeds:[feed],feeds:[feed],holdings:[{ticker:'TEST',name:'Private fixture',isin:'INE000000001'}],meta:{},pending:0};
  return {count:events.length,calls:window.calls,private:events.every(e=>e.private),publicAll:cache.materializeAllAlerts(report),publicAI:daily.materializePublicAlertWindow(report),retained:cache.retainAlertSource({id:'price-levels',status:'failed',events:[]},feed).events.length,story:stories.storyRecord(events[0]),note:notes.noteRequestFor(dev.developmentOfRow(events[0])),cards:ai.rankReport(report,{holdings:report.holdings,scope:'portfolio',day:report.day}).cards.length};
 });
 assert.equal(result.count,205);assert.deepEqual(result.calls,[null,'next']);assert(result.private);assert.equal(result.publicAll.events.length,0);assert.equal(result.publicAll.feeds.length,0);assert.equal(result.publicAI.events.length,0);assert.equal(result.publicAI.feeds.length,0);assert.equal(result.retained,0);assert.equal(result.story,null);assert.equal(result.note,null);assert(result.cards>0,'an explicitly reached personal level enters AI attention');
 await page.evaluate(()=>window.disconnect());assert.equal(await page.evaluate(()=>price.readFeed().events.length),0,'logout clears private history immediately');
 await page.evaluate(()=>{window.deny=true;window.connect();});await page.waitForFunction(()=>price.readFeed().status==='failed');assert.equal(await page.evaluate(()=>price.readFeed().events.length),0);
 await page.evaluate(()=>{window.deny=false;window.invalidate();window.hold=true;window.connect();});await page.waitForFunction(()=>window.release);await page.evaluate(()=>{window.disconnect();window.release();});await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>price.readFeed().events.length),0,'a late read cannot revive a logged-out history');
 await page.evaluate(()=>{window.hold=false;window.connect();});await page.waitForFunction(()=>price.readFeed().events.length===205);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('private-0'))),false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS private history pagination, AI admission, public-cache exclusion, no automatic model eligibility, session-loss clearing and late-result rejection');
}finally{await browser.close();await new Promise(done=>server.close(done));}
