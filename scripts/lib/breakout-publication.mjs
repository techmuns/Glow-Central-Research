import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import path from 'node:path';
import {localBreakouts} from './breakout-local.mjs';
import {preparedBreakoutHistory,breakoutRecordKey} from './breakout-prepared-history.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {sealBackgroundState} from './github-background-seal.mjs';

// Only an immutable checkpoint crosses into the publisher. The collector keeps
// its own SQLite connection and can save the next minute while this CPU work runs.
export function prepareBreakoutPublication({env,...options}) {
 const selected={GITHUB_RUN_ID:env.GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT:env.GITHUB_RUN_ATTEMPT,GITHUB_REPOSITORY:env.GITHUB_REPOSITORY,BACKGROUND_STATE_KEY:env.BACKGROUND_STATE_KEY,UPSTOX_ACCESS_TOKEN:env.UPSTOX_ACCESS_TOKEN?'configured':''};
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{...options,env:selected},env:{}});
  worker.once('error',reject);
  worker.once('exit',code=>code===0?resolve():reject(Error('Prepared quote publication failed')));
 });
}

async function prepare({backup,out,env,recipient,repo,signature,at}) {
 let copy,prepared;
 try{
  copy=localBreakouts(backup,{env,now:()=>at});
  prepared=preparedBreakoutHistory(copy,path.join(out,'history.sqlite'),{now:at});
  const fallback=copy.store.readFallback(),primaryRow=copy.db.prepare('SELECT payload FROM breakout_primary_current WHERE id=1').get();
  const current=primaryRow?{...JSON.parse(primaryRow.payload),rows:copy.db.prepare('SELECT payload FROM breakout_primary_latest').all().flatMap(row=>Object.values(JSON.parse(row.payload))),gaps:copy.store.archive.gaps()}:null;
  function currentPages(kind,value){const {rows,...metadata}=value,pages=[];for(let offset=0;offset<rows.length;offset+=500){const id=breakoutRecordKey(kind,String(offset));prepared.put(id,{rows:rows.slice(offset,offset+500)});pages.push(id);}return {...metadata,pages};}
  const primary=await copy.primary.status(),fallbackState=await copy.storage.get('github-breakout-fallback')||{},fallbackAt=fallbackState.lastAttemptAt||Date.parse(fallback.startedAt)||null;
  const schedule={...fallbackState,runtime:'github-actions',started:true,lastAttemptAt:fallbackAt,publishedAt:at,overdue:fallbackState.failed===true||!!fallbackAt&&at-fallbackAt>30*60000};
  const head={version:1,repo,feature:'breakouts',createdAt:new Date(at).toISOString(),primary:current?currentPages('primary',current):null,fallback:currentPages('fallback',fallback),schedule,primarySchedule:{...primary,runtime:'github-actions',alarmAt:null}};
  await packBackgroundViews(privateRecordViews(prepared.ids,prepared.read,head,{repo,feature:'breakouts',env}),recipient,path.join(out,'views.gz'),{repo,feature:'breakouts',sourceSignature:signature});
 }finally{prepared?.close();await copy?.close();}
 await sealBackgroundState(backup,path.join(out,'state.bin'),'breakouts',{env});
}

if(!isMainThread&&parentPort)await prepare(workerData);
