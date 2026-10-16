import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {localBreakouts} from './lib/breakout-local.mjs';
import {breakoutMinuteJournal} from './lib/breakout-minute-journal.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleBreakouts} from '../worker/breakouts.mjs';
import {minuteEnvelope} from '../worker/breakout-minute-reader.mjs';
import {backgroundContract} from '../worker/github-background-contract.mjs';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
const root=fs.mkdtempSync(path.resolve('.cache/minute-journal-')),repo='techmuns/Glow-Central-Research',secret='fixture-reader-only-123456789';
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions',BACKGROUND_STATE_KEY:'fixture-state-secret-only-123456789',UPSTOX_ACCESS_TOKEN:'fixture-provider'};
let at=Date.parse('2026-10-16T06:30:00Z'),price=110,sequence=1,releaseSequence=1,source,restored,reads=0,requests=0;
const releases=new Map(),assets=new Map(),apiReads=[];
const metadata=asset=>Object.fromEntries(Object.entries(asset).filter(([key])=>key!=='bytes'));
const fetcher=async(raw,options={})=>{
 const url=new URL(raw),method=options.method||'GET';
 if(url.hostname==='api.github.com'||url.hostname==='uploads.github.com'){
  assert([`Bearer ${env.GITHUB_TOKEN}`,`Bearer ${secret}`].includes(options.headers.authorization));assert(url.pathname.startsWith(`/repos/${repo}/`));
  if(url.hostname==='uploads.github.com'){
   const id=Number(url.pathname.split('/').at(-2)),release=[...releases.values()].find(r=>r.id===id);assert(release);
   const chunks=[];for await(const chunk of options.body)chunks.push(chunk);const bytes=Buffer.concat(chunks),name=url.searchParams.get('name');
   const asset={id:sequence++,name,size:bytes.length,state:'uploaded',digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,created_at:new Date(at).toISOString(),browser_download_url:`https://github.com/${repo}/releases/download/${release.tag_name}/${name}`,bytes};
   assets.set(name,asset);release.assets.push(asset);return Response.json(metadata(asset));
  }
  if(method==='POST'){const body=JSON.parse(options.body),release={id:releaseSequence++,tag_name:body.tag_name,body:body.body,assets:[]};releases.set(body.tag_name,release);return Response.json({...release,assets:[]});}
  if(method==='PATCH'){const id=Number(url.pathname.split('/').at(-1)),release=[...releases.values()].find(r=>r.id===id);release.body=JSON.parse(options.body).body;return Response.json({...release,assets:release.assets.map(metadata)});}
  assert.notEqual(method,'DELETE','Acknowledged minute journals are never pruned before full-history delivery');apiReads.push(url.pathname);
  if(url.pathname.endsWith('/assets')){const id=Number(url.pathname.split('/').at(-2)),release=[...releases.values()].find(r=>r.id===id);return Response.json(release.assets.map(metadata));}
  const release=releases.get(url.pathname.split('/').at(-1));return release?Response.json({...release,assets:release.assets.map(metadata)}):new Response(null,{status:404});
 }
 assert.equal(options.headers?.authorization,undefined,'No GitHub credential follows a public asset request');reads++;
 const asset=assets.get(url.pathname.split('/').at(-1));assert(asset);return new Response(asset.bytes);
};
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-10-15'};
const row=()=>({ticker:'TEST',name:'Fixture',price,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-10-16',provider:'Upstox',exchange:'NSE',kind:'quote',base});
let companies=[{ticker:'TEST',isin:'INE000000001'}];
const options={env,now:()=>at,instruments:async()=>companies.map(company=>({segment:'NSE_EQ',instrument_key:`NSE_EQ|${company.isin}`,trading_symbol:company.ticker})),quotes:async()=>{requests++;return {rows:companies.map(company=>({...row(),ticker:company.ticker}))};}};
try{
 source=localBreakouts(path.join(root,'source.sqlite'),options);source.beginCycle(1);await source.client({action:'begin',targets:['TEST']});await source.client({action:'checkpoint',rows:[row()]});await source.client({action:'finish'});await source.client({action:'inventory',targets:[{ticker:'TEST',isin:'INE000000001'}]});await source.primary.wake();
 const baseline=path.join(root,'baseline.sqlite');await source.checkpoint(baseline);
 const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)},journalOptions={env,fetcher,recipient,now:()=>at,transportOptions:{now:()=>at,sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 const journal=breakoutMinuteJournal(source,{...journalOptions,out:path.join(root,'journal')});
 for(let minute=0;minute<3;minute++){at+=60000;price++;await source.primary.wake();await journal.publish();}
 const cache=new Map(),edgeCache={match:async key=>cache.get(key.url)?.clone(),put:async(key,value)=>{cache.set(key.url,value.clone());}};
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,BREAKOUT_LIVE_RUNTIME:'github',CAPTURE_REGISTRY:{getByName(){throw Error('Current quote delivery cannot query Cloudflare SQL');}},ASSETS:{fetch:async()=>{throw Error('Current quotes cannot wait for static deployment');}}};
 const read=()=>handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts'),worker,{fetcher,edgeCache,now:()=>at});
 let response=await read(),data=await response.json();assert.equal(response.status,200);assert.equal(data.delivery,'github-prepared');assert.equal(data.rows[0].price,113);assert.equal(data.primary.primaryUsed,1);assert.equal(data.primarySchedule.overdue,false);
 const calls=apiReads.length,downloads=reads;response=await read();assert.equal(response.status,200);assert.equal(apiReads.length,calls);assert.equal(reads,downloads,'On-demand cache retains ciphertext and avoids another network read');
 at+=3*60000;response=await read();data=await response.json();assert.equal(data.primarySchedule.overdue,true,'A cached prepared envelope cannot invent source freshness');
 at-=3*60000;
 restored=localBreakouts(baseline,options);const recovered=breakoutMinuteJournal(restored,{...journalOptions,out:path.join(root,'restore')});assert.equal(await recovered.restore(),3);assert.deepEqual(restored.store.history('TEST'),source.store.history('TEST'),'Every acknowledged minute after the full checkpoint survives restart');assert.equal(await recovered.restore(),0,'Restoration is replay safe');
 assert.deepEqual(restored.primary.config('upstox-inventory'),source.primary.config('upstox-inventory'));const priorRequests=requests;await restored.primary.wake();assert.equal(requests,priorRequests,'A recovered minute keeps its next-check claim rather than resampling early');
 const asset=[...assets.values()].at(-1),damaged=Buffer.from(asset.bytes);damaged[damaged.length-10]^=1;await assert.rejects(minuteEnvelope(damaged,{repo,signature:await backgroundContract('breakouts-live')}),/integrity/);
 const release=[...releases.values()].at(-1),pointer=JSON.parse(release.body),before=reads;cache.clear();release.body=JSON.stringify({...pointer,asset:{...pointer.asset,browser_download_url:'https://example.invalid/credential-sink'}});
 response=await read();assert.equal(response.status,503);assert.equal(reads,before,'A substituted asset URL is rejected before fetching');
 release.body=JSON.stringify(pointer);
 companies=Array.from({length:501},(_,i)=>({ticker:i?`TEST${i}`:'TEST',isin:`INE${String(i+1).padStart(9,'0')}`}));
 at+=60000;await source.client({action:'inventory',targets:companies});await source.primary.wake();await journal.publish();cache.clear();response=await read();data=await response.json();
 assert.equal(response.status,200);assert.equal(data.rows.length,501);assert(data.rows.some(row=>row.ticker==='TEST500'),'Current quote pages retain companies beyond the first 500');
 assert.equal(await recovered.restore(),1);assert.deepEqual(restored.store.history('TEST500'),source.store.history('TEST500'));
 console.log('PASS encrypted minute feed: fresh current prices without static deployment or SQL, ciphertext cache and honest expiry, exact journal restart/replay, integrity and fixed-source credential boundaries');
}finally{await restored?.close();await source?.close();}
