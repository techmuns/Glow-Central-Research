import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {sealBackgroundState,openBackgroundState} from './github-background-seal.mjs';
import {packBackgroundViews} from './github-background-package.mjs';
import {privateRecordViews} from './github-private-records.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';
import {PRIMARY_TIMER} from '../../worker/breakout-primary.mjs';
import {boundedJson} from '../../public/js/data/family-book-contract.js';
const FEATURE='breakouts-live',DAY=86400000;
const observed=asset=>Number(/^bq-\d+-\d+-\d+-(\d{13})-bundle\.bin$/.exec(asset.name)?.[1]||0);

// The small immutable minute journal acknowledges each sampled primary quote
// independently of the full history rebuild. Its symmetric restart member stays
// on GitHub; the website only opens the prepared reader envelope.
export function breakoutMinuteJournal(local,{env=process.env,fetcher=fetch,recipient,out,transportOptions={},now=Date.now}={}) {
 let cycle=0;
 const transport=day=>githubBackgroundRelease(FEATURE,{env,fetcher,day,...transportOptions});
 async function restore(){
  local.primary.config('upstox-inventory');
  const baseline=local.db.prepare('SELECT at FROM breakout_primary_current WHERE id=1').get()?.at||0;
  const today=Math.floor(now()/DAY);let first=baseline?Math.floor(baseline/DAY):today;
  if(!baseline){
   // Release-created tags list the retained calendar without downloading every
   // release's embedded asset inventory. Never assume the first samples are today.
   const repo=transport().repo,response=await fetcher(`https://api.github.com/repos/${repo}/git/matching-refs/tags/breakout-live-`,{headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchMinuteRecovery'},redirect:'manual',signal:AbortSignal.timeout(20000)});
   if(response.headers.get('link')?.includes('rel="next"')){await response.body?.cancel();throw Error('Minute journal calendar is incomplete');}
   const refs=await boundedJson(response,4*1024*1024);if(!Array.isArray(refs))throw Error('Invalid minute journal calendar');
   for(const entry of refs){const day=/^refs\/tags\/breakout-live-(20\d{2}-\d{2}-\d{2})$/.exec(entry.ref||'')?.[1];if(!day||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw Error('Invalid minute journal day');first=Math.min(first,Date.parse(day)/DAY);}
  }
  if(today-first>31||first>today)throw Error('Minute journal recovery interval requires inspection');
  fs.mkdirSync(out,{recursive:true});let restored=0,last=baseline;
  for(let day=first;day<=today;day++){
   const dayName=new Date(day*DAY).toISOString().slice(0,10),source=transport(dayName),release=await source.release();
   if(!release)continue;
   const assets=release.assets.filter(asset=>asset.state==='uploaded'&&observed(asset)>baseline).sort((a,b)=>observed(a)-observed(b)||a.id-b.id);
   for(const asset of assets){
    const sealed=path.join(out,'restore.bin'),plain=path.join(out,'restore.json');
    await source.download({repo:source.repo,feature:FEATURE,asset},'state',sealed,{sourceSignature:await backgroundContract(FEATURE)});
    await openBackgroundState(sealed,plain,FEATURE,{env,maxPlainBytes:8*1024*1024});
    const value=JSON.parse(fs.readFileSync(plain,'utf8'));
    if(value.version!==1||value.repo!==source.repo||value.feature!==FEATURE||value.at!==observed(asset))throw Error('Invalid retained minute frame');
    if(value.at<=last)continue;
    if(!value.frame||value.frame.at!==value.at)throw Error('Retained minute frame missing');
    if(!Array.isArray(value.config)||value.config.some(row=>!['upstox-inventory','upstox-mappings'].includes(row.key)||!Number.isSafeInteger(row.part)||row.part<0||row.part>100||typeof row.payload!=='string'||row.payload.length>32000)||!Number.isSafeInteger(value.timer?.nextAt)||!Number.isSafeInteger(value.timer?.lastAttemptAt)||value.timer.lastAttemptAt<value.at||value.timer.nextAt<=value.timer.lastAttemptAt)throw Error('Invalid retained minute configuration');
    local.storage.transactionSync(()=>{
     local.store.primarySave(value.frame);
     local.db.exec('DELETE FROM upstox_config');
     for(const row of value.config)local.db.prepare('INSERT INTO upstox_config VALUES(?,?,?)').run(row.key,row.part,row.payload);
    });
    await local.storage.put(PRIMARY_TIMER,value.timer);
    await local.storage.put('github-primary-frame',value.frame);
    if(Number.isFinite(value.alarmAt))await local.storage.setAlarm(value.alarmAt);
    last=value.at;restored++;
   }
  }
  if(restored)console.log(`Restored ${restored} acknowledged minute frames after the full checkpoint.`);
  return restored;
 }
 async function publish(){
  const at=now(),source=transport(new Date(at).toISOString().slice(0,10)),signature=await backgroundContract(FEATURE);
  const frame=await local.storage.get('github-primary-frame')||null;
  const primaryRow=local.db.prepare('SELECT payload FROM breakout_primary_current WHERE id=1').get();
  if(!primaryRow)return null;
  const metadata=JSON.parse(primaryRow.payload),primary={...metadata,rows:local.db.prepare('SELECT payload FROM breakout_primary_latest').all().flatMap(row=>Object.values(JSON.parse(row.payload))),gaps:local.store.archive.gaps()};
  const fallback=local.store.readFallback(),primarySchedule=await local.primary.status(),state=await local.storage.get('github-breakout-fallback')||{};
  const fallbackAt=state.lastAttemptAt||Date.parse(fallback.startedAt)||null;
  const schedule={...state,runtime:'github-actions',started:true,lastAttemptAt:fallbackAt,publishedAt:at,overdue:state.failed===true||!!fallbackAt&&at-fallbackAt>30*60000};
  const records=new Map();
  const pages=(kind,value)=>{const {rows,...metadata}=value,ids=[];for(let offset=0;offset<rows.length;offset+=500){const id=`${kind}-${offset}`;records.set(id,{rows:rows.slice(offset,offset+500)});ids.push(id);}return {...metadata,pages:ids};};
  const head={version:1,repo:source.repo,feature:FEATURE,createdAt:new Date(at).toISOString(),fallback:pages('fallback',fallback),primary:pages('primary',primary),schedule,primarySchedule:{...primarySchedule,runtime:'github-actions',alarmAt:null}};
  // A legacy full checkpoint may predate the journal. It already retains that
  // minute; only newly sampled frames require replay after a restart.
  const value={version:1,repo:source.repo,feature:FEATURE,at:metadata.at,frame:frame?.at===metadata.at?frame:null,timer:await local.storage.get(PRIMARY_TIMER),alarmAt:await local.storage.getAlarm(),config:local.db.prepare('SELECT key,part,payload FROM upstox_config ORDER BY key,part').all()};
  const plain=path.join(out,'minute.json'),sealed=path.join(out,'state.bin'),views=path.join(out,'views.gz');
  fs.mkdirSync(out,{recursive:true});const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>8*1024*1024)throw Error('Minute frame exceeds restart budget');fs.writeFileSync(plain,bytes);
  await sealBackgroundState(plain,sealed,FEATURE,{env,maxPlainBytes:8*1024*1024});
  await packBackgroundViews(privateRecordViews([...records.keys()],id=>records.get(id),head,{repo:source.repo,feature:FEATURE,env}),recipient,views,{repo:source.repo,feature:FEATURE,sourceSignature:signature});
  return source.publish({cycle:++cycle,state:sealed,views,sourceSignature:signature,observedAt:metadata.at});
 }
 return {restore,publish};
}
