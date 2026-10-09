// Actual viewport observer and summary presentation over local fixtures, with no provider traffic.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { noteContent, noteItem } from '../public/js/data/alert-notes-shared.js';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public'), saved = new Map();
let requests = 0, generated = 0;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"></head><body><main id="root" style="padding:24px"></main><script type="module">
import {alertReadingHtml,watchAlertReadings} from '/js/ui/alert-reading.js';
import {noteRequestFor} from '/js/data/alert-notes.js';
import {developmentOfRow} from '/js/data/alert-developments.js';
import {noteExportText} from '/js/ui/alert-note.js';
const detail='The board recommended a dividend of Rs 5 per share for FY26. The record date is 1 October 2026 and payment is proposed for 15 October 2026. Shareholder approval is required before payment.';
const event=(id,extra={})=>({id,feed:'announcements',ticker:id,company:id,day:'2026-10-01',importance:'high',headline:'Dividend recommendation',filingSubject:'Dividend recommendation',filingDescription:detail,...extra});
const events=[event('DETAIL'),event('SKIP'),event('NEWS',{feed:'news'}),event('ROUTINE',{headline:'Trading window closure',filingSubject:'Trading window closure',filingDescription:'Trading window closure'}),event('HEADLINE',{filingDescription:'Dividend recommendation'}),event('PRIVATE',{private:true})];
window.paint=()=>document.querySelector('#root').innerHTML='<div style="height:1800px">Scroll to read the captured filing</div>'+events.map(e=>'<section data-case="'+e.id+'">'+alertReadingHtml(e)+'</section>').join('');
window.exportFirst=()=>noteExportText(noteRequestFor(developmentOfRow(events[0])));
window.dispose=watchAlertReadings(document.querySelector('#root'));window.paint();window.ready=true;
</script></body></html>`;
const server = createServer(async (req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/'){res.setHeader('content-type','text/html');res.end(html);return;}
 if(path==='/api/alert-notes'){
  requests++;let raw='';for await(const chunk of req)raw+=chunk;
  const notes={},missing={},retryAt={};
  for(const rawItem of JSON.parse(raw).items){
   const item=noteItem(rawItem);assert(item,'only eligible details reach the route');
   const key=noteContent(item);if(!saved.has(key)){generated++;saved.set(key,item.company==='SKIP'?null:'The proposed dividend requires shareholder approval before payment.');}
   if(saved.get(key)===null){missing[item.id]='not-needed';retryAt[item.id]=null;}
   else notes[item.id]={note:saved.get(key),model:'fixture',stored:true};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,notes,missing,retryAt}));return;
 }
 try{const file=resolve(root,'.'+path);if(!file.startsWith(root+sep))throw Error();res.setHeader('content-type',{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(file)]||'text/plain');res.end(readFileSync(file));}
 catch{res.writeHead(404);res.end('{}');}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.fulfill({status:503,body:'{}'}));
 await page.goto(origin);await page.waitForFunction(()=>window.ready);
 assert.equal(await page.locator('[data-alert-reading]').count(),2,'only substantive public filings can carry a summary');
 assert.equal(await page.evaluate(()=>window.exportFirst()),'','export does not start inference');
 await page.waitForTimeout(350);assert.equal(requests,0,'paint and offscreen content do not start inference');
 await page.locator('[data-case="DETAIL"]').scrollIntoViewIfNeeded();
 await page.locator('[data-note-state="ready"]').waitFor();
 await page.waitForFunction(()=>!document.querySelector('[data-case="SKIP"] [data-alert-reading]'));
 assert.equal(generated,2);assert.equal(await page.locator('[data-alert-reading]').count(),1,'explicit no-summary removes the entire section');
 assert.match(await page.locator('[data-alert-reading]').innerText(),/^AI summary/);
 assert.match(await page.locator('[data-alert-reading]').getAttribute('title'),/Linked documents have not been read/);
 const before=requests;await page.evaluate(()=>window.paint());await page.locator('[data-case="DETAIL"]').scrollIntoViewIfNeeded();
 await page.waitForTimeout(350);assert.equal(requests,before,'repainting answered or skipped content makes no request');
 assert.match(await page.evaluate(()=>window.exportFirst()),/shareholder approval/);
 await page.reload();await page.waitForFunction(()=>window.ready);await page.locator('[data-case="DETAIL"]').scrollIntoViewIfNeeded();
 await page.locator('[data-note-state="ready"]').waitFor();assert.equal(generated,2,'a new reader reuses the durable content keys');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('PASS: visible-only summaries, no news/routine/headline/private calls, complete omission on skip, no export/paint charges, reload reuse and mobile layout.');
}finally{await browser.close();await new Promise(done=>server.close(done));}
