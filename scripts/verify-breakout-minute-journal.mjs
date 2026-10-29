import {snapshotCapture} from '../public/js/data/breakout-snapshot.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {localBreakouts} from './lib/breakout-local.mjs';
import {breakoutMinuteJournal} from './lib/breakout-minute-journal.mjs';
import {readerKeys,encode64} from '../worker/mutual-funds-seal.mjs';
import {handleBreakouts} from '../worker/breakouts.mjs';
import {minuteEnvelope} from '../worker/breakout-minute-reader.mjs';
import {backgroundContract} from '../worker/github-background-contract.mjs';
import {packBackgroundViews} from './lib/github-background-package.mjs';
import {privateRecordViews} from './lib/github-private-records.mjs';
import {createBackgroundBundle} from './lib/github-background-bundle.mjs';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
const root=fs.mkdtempSync(path.resolve('.cache/minute-journal-')),repo='techmuns/Glow-Central-Research',secret='fixture-reader-only-123456789';
const env={GITHUB_REPOSITORY:repo,GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_TOKEN:'fixture-actions',BACKGROUND_STATE_KEY:'fixture-state-secret-only-123456789',UPSTOX_ACCESS_TOKEN:'fixture-provider'};
let at=Date.parse('2026-10-16T06:30:00Z'),price=110,sequence=1,releaseSequence=1,source,restored,duplicate,empty,reads=0,requests=0;
const releases=new Map(),assets=new Map(),apiReads=[];let rangeMode='ok';
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
  if(url.pathname.includes('/git/matching-refs/tags/breakout-live-'))return Response.json([...releases.keys()].map(tag=>({ref:`refs/tags/${tag}`})));
  if(url.pathname.endsWith('/assets')){const id=Number(url.pathname.split('/').at(-2)),release=[...releases.values()].find(r=>r.id===id);return Response.json(release.assets.map(metadata));}
  const release=releases.get(url.pathname.split('/').at(-1));return release?Response.json({...release,assets:release.assets.map(metadata)}):new Response(null,{status:404});
 }
 assert.equal(options.headers?.authorization,undefined,'No GitHub credential follows a public asset request');reads++;
 const asset=assets.get(url.pathname.split('/').at(-1));assert(asset);
 if(options.headers?.range){const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.range);assert(match);const start=Number(match[1]),end=Number(match[2]);assert(end<asset.size);
  if(rangeMode==='ignored')return new Response(asset.bytes);
  if(rangeMode==='redirect')return new Response(null,{status:302,headers:{location:'https://example.invalid/sink'}});
  const bytes=Buffer.from(asset.bytes.subarray(start,end+1));if(rangeMode==='corrupt'&&start>0)bytes[bytes.length-1]^=1;
  return new Response(rangeMode==='truncated'?bytes.subarray(0,-1):bytes,{status:206,headers:{'content-range':rangeMode==='mismatch'?`bytes 0-0/${asset.size}`:`bytes ${start}-${end}/${asset.size}`}});
 }
 return new Response(asset.bytes);
};
const base={high:100,low:95,average:97,averageVolume:1000,count:30,to:'2026-10-15'};
const row=()=>({ticker:'TEST',name:'Fixture',price,volume:2300,prevClose:100,quoteAt:new Date(at).toISOString(),checkedAt:new Date(at).toISOString(),sessionDate:'2026-10-16',provider:'Upstox',exchange:'NSE',kind:'quote',base});
let companies=[{ticker:'TEST',isin:'INE000000001'}];
const options={env,now:()=>at,instruments:async()=>companies.map(company=>({segment:'NSE_EQ',instrument_key:`NSE_EQ|${company.isin}`,trading_symbol:company.ticker})),quotes:async()=>{requests++;return {rows:companies.map(company=>({...row(),ticker:company.ticker}))};}};
try{
 source=localBreakouts(path.join(root,'source.sqlite'),options);source.beginCycle(1);await source.client({action:'begin',targets:['TEST']});await source.client({action:'checkpoint',rows:[row()]});await source.client({action:'finish'});await source.client({action:'inventory',targets:[{ticker:'TEST',isin:'INE000000001'}]});await source.primary.wake();
 const baseline=path.join(root,'baseline.sqlite'),older=path.join(root,'duplicate-baseline.sqlite');await source.checkpoint(baseline);await source.checkpoint(older);
 const keys=await readerKeys(secret),recipient={kid:keys.kid,publicKey:encode64(keys.publicKey)},journalOptions={env,fetcher,recipient,now:()=>at,transportOptions:{now:()=>at,sleep:async()=>{},head:()=>env.GITHUB_SHA}};
 const journal=breakoutMinuteJournal(source,{...journalOptions,out:path.join(root,'journal')});
 const committedSchedule={runtime:'github-actions',started:true,lastAttemptAt:at,publishedAt:at,overdue:false};
 await assert.rejects(journal.publish(),/acknowledged full checkpoint/);journal.acknowledgeFallback(source.store.readFallback(),committedSchedule);
 for(let minute=0;minute<3;minute++){at+=60000;price++;await source.primary.wake();await journal.publish();}
 const cache=new Map(),edgeCache={match:async key=>cache.get(key.url)?.clone(),put:async(key,value)=>{cache.set(key.url,value.clone());}};
 const worker={GH_REPO:repo,GH_DISPATCH_TOKEN:secret,BREAKOUT_LIVE_RUNTIME:'github',CAPTURE_REGISTRY:{getByName(){throw Error('Current quote delivery cannot query Cloudflare SQL');}},ASSETS:{fetch:async()=>{throw Error('Current quotes cannot wait for static deployment');}}};
 const read=()=>handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts'),worker,{fetcher,edgeCache,now:()=>at});
 let response=await read(),data=await response.json();assert.equal(response.status,200);assert.equal(data.delivery,'github-prepared');assert.equal(data.rows[0].price,113);assert.equal(data.primary.primaryUsed,1);assert.equal(data.primarySchedule.overdue,false);
 const NativeInflation=globalThis.DecompressionStream;let packet,packetTag;
 try {globalThis.DecompressionStream=class {constructor(){throw Error('The server must not inflate the current quote snapshot');}};
  const packed=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/snapshot'),worker,{fetcher,edgeCache,now:()=>at});
  assert.equal(packed.status,200);packetTag=packed.headers.get('etag');packet=await packed.json();assert.equal(packet.format,'gzip-json');
  const decrypt=crypto.subtle.decrypt;
  try{crypto.subtle.decrypt=()=>{throw Error('An unchanged quote must not repeat payload decryption');};
   const unchanged=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/snapshot',{headers:{'if-none-match':packetTag}}),worker,{fetcher,edgeCache,now:()=>at});assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
  }finally{crypto.subtle.decrypt=decrypt;}
 } finally {globalThis.DecompressionStream=NativeInflation;}
 assert.deepEqual((await snapshotCapture(packet,at)).rows,data.rows,'The authenticated compressed view preserves every selected quote');
 assert.equal((await snapshotCapture(packet,at+3*60000)).primarySchedule.overdue,true,'An unchanged transport still ages in the reader');
 const envelopes=await minuteEnvelope([...assets.values()].at(-1).bytes,{repo,signature:await backgroundContract('breakouts-live')});assert.deepEqual(Object.keys(envelopes),['head.json'],'Current delivery decrypts one compressed envelope, with no per-page fan-out');
 const calls=apiReads.length,downloads=reads;response=await read();assert.equal(response.status,200);assert.equal(apiReads.length,calls);assert.equal(reads,downloads,'On-demand cache retains ciphertext and avoids another network read');
 // A reader upgrade must still serve the preceding paged producer format.
 const priorAsset=[...assets.values()].at(-1),prior={...priorAsset},releaseBefore=[...releases.values()].at(-1),priorBody=releaseBefore.body;
 const primaryMeta=JSON.parse(source.db.prepare('SELECT payload FROM breakout_primary_current WHERE id=1').get().payload);
 const currentRows=source.db.prepare('SELECT payload FROM breakout_primary_latest').all().flatMap(row=>Object.values(JSON.parse(row.payload)));
 const legacyHead={version:1,repo,feature:'breakouts-live',createdAt:new Date(at).toISOString(),fallback:{...source.store.readFallback(),rows:undefined,pages:['fallback']},primary:{...primaryMeta,pages:['primary'],gaps:[]},schedule:committedSchedule,primarySchedule:{...await source.primary.status(),runtime:'github-actions',alarmAt:null}};
 const legacyViews=path.join(root,'legacy-views.gz'),legacyBundle=path.join(root,'legacy-bundle.bin'),signature=await backgroundContract('breakouts-live');
 await packBackgroundViews(privateRecordViews(['fallback','primary'],id=>({rows:id==='fallback'?source.store.readFallback().rows:currentRows}),legacyHead,{repo,feature:'breakouts-live',env}),recipient,legacyViews,{repo,feature:'breakouts-live',sourceSignature:signature});
 await createBackgroundBundle(path.join(root,'journal/state.bin'),legacyViews,legacyBundle,{repo,feature:'breakouts-live',createdAt:new Date(at).toISOString(),workflowRun:env.GITHUB_RUN_ID,sourceSha:env.GITHUB_SHA,sourceSignature:signature},{env});
 priorAsset.bytes=fs.readFileSync(legacyBundle);priorAsset.size=priorAsset.bytes.length;priorAsset.digest=`sha256:${createHash('sha256').update(priorAsset.bytes).digest('hex')}`;
 releaseBefore.body=JSON.stringify({...JSON.parse(priorBody),asset:metadata(priorAsset)});cache.clear();response=await read();assert.equal(response.status,200);assert.equal((await response.json()).rows[0].price,113,'Legacy encrypted quote pages remain readable during rollout');
 Object.assign(priorAsset,prior);releaseBefore.body=priorBody;
 for(const mode of ['ignored','redirect','corrupt','truncated','mismatch']){cache.clear();rangeMode=mode;response=await read();assert.equal(response.status,503,`An invalid ${mode} range cannot become a current observation`);}rangeMode='ok';cache.clear();
 at+=3*60000;response=await read();data=await response.json();assert.equal(data.primarySchedule.overdue,true,'A cached prepared envelope cannot invent source freshness');
 at-=3*60000;
 restored=localBreakouts(baseline,options);const recovered=breakoutMinuteJournal(restored,{...journalOptions,out:path.join(root,'restore')});assert.equal(await recovered.restore(),3);assert.deepEqual(restored.store.history('TEST'),source.store.history('TEST'),'Every acknowledged minute after the full checkpoint survives restart');assert.equal(await recovered.restore(),0,'Restoration is replay safe');
 recovered.acknowledgeFallback(restored.store.readFallback(),committedSchedule);
 assert.deepEqual(restored.primary.config('upstox-inventory'),source.primary.config('upstox-inventory'));const priorRequests=requests;await restored.primary.wake();assert.equal(requests,priorRequests,'A recovered minute keeps its next-check claim rather than resampling early');
 assert.equal((await restored.storage.get('github-primary-frame')).at,at,'A restored sample remains available to the next publication');
 // Reproduce a prior reader's duplicate null-frame publication after a claimed wake.
 await restored.storage.delete('github-primary-frame');await recovered.publish();
 duplicate=localBreakouts(older,options);assert.equal(await breakoutMinuteJournal(duplicate,{...journalOptions,out:path.join(root,'duplicate')}).restore(),3,'A duplicate missing replay frame cannot block valid acknowledged minutes');
 empty=localBreakouts(path.join(root,'empty.sqlite'),options);at+=86400000;
 assert.equal(await breakoutMinuteJournal(empty,{...journalOptions,out:path.join(root,'empty')}).restore(),3,'With no primary baseline, recovery discovers yesterday\'s retained release');assert.equal(empty.store.history('TEST').rows.length,3);at-=86400000;
 const asset=[...assets.values()].at(-1),damaged=Buffer.from(asset.bytes);damaged[damaged.length-10]^=1;await assert.rejects(minuteEnvelope(damaged,{repo,signature:await backgroundContract('breakouts-live')}),/integrity/);
 const release=[...releases.values()].at(-1),pointer=JSON.parse(release.body),before=reads;cache.clear();release.body=JSON.stringify({...pointer,asset:{...pointer.asset,browser_download_url:'https://example.invalid/credential-sink'}});
 response=await read();assert.equal(response.status,503);assert.equal(reads,before,'A substituted asset URL is rejected before fetching');
 release.body=JSON.stringify(pointer);
 companies=Array.from({length:501},(_,i)=>({ticker:i?`TEST${i}`:'TEST',isin:`INE${String(i+1).padStart(9,'0')}`}));
 at+=60000;await source.client({action:'inventory',targets:companies});await source.primary.wake();await journal.publish();cache.clear();response=await read();data=await response.json();
 assert.equal(response.status,200);assert.equal(data.rows.length,501);assert(data.rows.some(row=>row.ticker==='TEST500'),'Current quote pages retain companies beyond the first 500');
 const changed=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/snapshot',{headers:{'if-none-match':packetTag}}),worker,{fetcher,edgeCache,now:()=>at});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),packetTag);assert.equal((await snapshotCapture(await changed.json(),at)).rows.length,501,'An earlier generation validator cannot hide newly covered companies');
 assert.equal(await recovered.restore(),1);assert.deepEqual(restored.store.history('TEST500'),source.store.history('TEST500'));
 source.beginCycle(2);await source.client({action:'begin',targets:['TEST']});await source.client({action:'checkpoint',rows:[{...row(),price:999}]});await source.client({action:'finish'});await journal.publish();cache.clear();
 response=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/fallback'),worker,{fetcher,edgeCache,now:()=>at});data=await response.json();assert.equal(data.rows[0].price,110,'A fallback wave cannot become visible before its full restart checkpoint is acknowledged');
 journal.acknowledgeFallback(source.store.readFallback(),committedSchedule);await journal.publish();cache.clear();response=await handleBreakouts(new Request(BREAKOUT_ORIGIN+'/api/breakouts/fallback'),worker,{fetcher,edgeCache,now:()=>at});assert.equal((await response.json()).rows[0].price,999);
 console.log('PASS encrypted minute feed: fresh current prices without static deployment or SQL, ciphertext cache and honest expiry, exact journal restart/replay, integrity and fixed-source credential boundaries');
}finally{await empty?.close();await duplicate?.close();await restored?.close();await source?.close();}
