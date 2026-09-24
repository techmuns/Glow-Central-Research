// A warm immutable module cache must upgrade an already-open dashboard session.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
const { chromium }=await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root=resolve('public'), worker=readFileSync(resolve(root,'sw.js'),'utf8');
let upgraded=false;
const server=createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  const send=(body,type='text/html',status=200)=>{res.writeHead(status,{'content-type':type,'cache-control':'no-cache'});res.end(body);};
  if(path==='/sdk-fixture')return send('// Local SDK fixture','text/javascript');
  if(path==='/upgrade-fixture')return send(`<!doctype html><title>MF upgrade</title><div id="views"></div><script type="module">
    import {meta} from '/js/tabs/mutual-funds.js';
    import {watchWorkerChanges} from '/js/core/app-updates.js';
    document.querySelector('#views').textContent=meta.subviews.map(v=>v.label).join(' | ');
    watchWorkerChanges(navigator.serviceWorker,()=>{sessionStorage.setItem('mf-upgraded','yes');location.reload();});
    navigator.serviceWorker.register('/sw.js');
  </script>`);
  if(path==='/sw.js')return send(worker.replace(/const MUNSHOT_SDK = '[^']+';/,`const MUNSHOT_SDK = '${origin}/sdk-fixture';`).replace('glow-mf-reliability-v2',upgraded?'glow-mf-reliability-v2':'glow-mf-before-upgrade'),'text/javascript');
  if(path.startsWith('/api/'))return send('{"error":"offline fixture"}','application/json',503);
  const file=resolve(root,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(root+sep))return send('Missing','text/plain',404);
  try {
    let body=readFileSync(file);
    if(path==='/js/tabs/mutual-funds.js'&&!upgraded)body=body.toString().replace("    { id: 'company-holdings', label: 'Company Holdings' },\n",'');
    return send(body,{'.js':'text/javascript','.html':'text/html','.json':'application/json','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream');
  } catch {return send('Missing','text/plain',404);}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
try {
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.fulfill({status:503,body:'External sources disabled'}));
  const page=await context.newPage();
  await page.goto(`${origin}/upgrade-fixture`);
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.reload();
  assert.equal(await page.locator('#views').innerText(),'All Schemes | Category Performance');
  assert((await page.evaluate(()=>caches.keys())).some(k=>k.includes('glow-mf-before-upgrade')));
  upgraded=true;
  await page.evaluate(()=>navigator.serviceWorker.getRegistration().then(r=>r.update()));
  await page.waitForFunction(()=>sessionStorage.getItem('mf-upgraded')==='yes'&&document.querySelector('#views').textContent.includes('Company Holdings'));
  const names=await page.evaluate(()=>caches.keys());
  assert(names.some(k=>k.includes('glow-mf-reliability-v2')));
  assert(!names.some(k=>k.includes('glow-mf-before-upgrade')));
  console.log('PASS existing session upgrades its immutable modules, retains both return views and exposes Company Holdings');
} finally {await browser.close();await new Promise(done=>server.close(done));}
