#!/usr/bin/env node
// Fixed main-branch workflows only. Recovery never scrapes, cancels, reruns,
// deploys, or treats a successful import as a successful AMC source check.
import {appendFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {latestRun,isInFlight,dispatchWorkflow} from '../worker/github-actions.mjs';
import {boundedJson} from '../public/js/data/family-book-contract.js';

const REPO='techmuns/Glow-Central-Research',INTERVAL=15*60000;
export const MF_RECOVERY_TARGETS=[
  {repo:REPO,file:'mutual-funds-refresh.yml',inputs:{source:'automatic-recovery'}},
  {repo:REPO,file:'mutual-funds-scanner.yml',inputs:{source:'automatic-recovery'}}
];
export const MF_SOURCE_MANIFEST='https://raw.githubusercontent.com/techmuns/AmfiBeas/main/public/amc-holdings/coverage.json';
function time(value,now) {
  const t=Date.parse(value);
  if(!Number.isFinite(t)||t>now+60000)throw Error('Invalid workflow time');
  return t;
}
export function mutualFundsRecoveryDecision(runs,{now=Date.now(),sourcePublishedAt=null,importer=false}={}) {
  if(runs.some(isInFlight))return {due:false,reason:'already-running'};
  const latest=[...runs].sort((a,b)=>time(b.createdAt,now)-time(a.createdAt,now))[0];
  if(!latest)return {due:true,reason:'no-run'};
  const completed=time(latest.updatedAt,now),created=time(latest.createdAt,now);
  // A published manifest can carry verified partial progress. The importer
  // validates the complete inventory/checksums; this clock only requests a read.
  if(importer&&sourcePublishedAt&&time(sourcePublishedAt,now)>created&&now-created>=INTERVAL)
    return {due:true,reason:'new-source-snapshot',run:latest.id};
  // A partial disclosure is not a transport outage. The source collectors retain
  // their own refusal cooldowns; don't back off every other healthy source too.
  return {due:now-completed>=INTERVAL,reason:now-completed>=INTERVAL?'overdue':'recent-run',run:latest.id};
}
export async function recoverMutualFunds({repository=REPO,token,fetcher=fetch,now=Date.now(),apply=false}={}) {
  if(repository!==REPO)throw Error('Recovery is restricted to Glow');
  const results=[],inventories=new Map();let source;
  try {
    // AmfiBeas recovers its collector with its own repository-scoped workflow
    // token. Glow observes only this fixed public file, without credentials.
    const manifest=await boundedJson(await fetcher(MF_SOURCE_MANIFEST,{headers:{accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)}),2*1024*1024);
    if(manifest.schemaVersion!==1||!['complete','interrupted'].includes(manifest.state)||!Array.isArray(manifest.amcs)||!manifest.amcs.length||manifest.amcs.length>500||!Array.isArray(manifest.files))throw Error('Invalid source manifest');
    time(manifest.generatedAt,now);
    source={repository:'techmuns/AmfiBeas',reason:'source-owned',publishedAt:manifest.generatedAt};
  }catch(error){source={repository:'techmuns/AmfiBeas',reason:'check-failed',error:error.code||'source-manifest-unavailable'};}
  // Inventory all targets before writes. A failed read must not mean an empty
  // queue. Collector workflow concurrency protects retained state across targets.
  for(const target of MF_RECOVERY_TARGETS) {
    const result={repository:target.repo,workflow:target.file,due:false};results.push(result);
    if(!token){result.reason='credential-unavailable';continue;}
    const [owner,repo]=target.repo.split('/'),cfg={owner,repo,token,ref:'main'};
    try {
      const runs=await latestRun(fetcher,cfg,target.file,{perPage:20});
      inventories.set(target.file,{target,cfg,runs,result});
    }catch(error){result.reason='check-failed';result.error=error.code||'invalid-runs';}
  }
  for(const {target,cfg,runs,result} of inventories.values()) {
    try {
      Object.assign(result,mutualFundsRecoveryDecision(runs,{now,importer:target.file==='mutual-funds-refresh.yml',
        sourcePublishedAt:source.publishedAt}));
      if(!result.due)continue;
      if(!apply){result.reason='would-dispatch';continue;}
      // dispatchWorkflow rechecks every active status immediately before POST,
      // refuses failed queue reads and never retries an ambiguous POST response.
      const out=await dispatchWorkflow(fetcher,cfg,target.file,'main',target.inputs);
      result.reason=out.dispatched?'dispatched':'already-running';
    }catch(error){result.reason=result.due?'dispatch-failed':'check-failed';result.error=error.code||'invalid-runs';}
  }
  return {checkedAt:new Date(now).toISOString(),mode:apply?'automatic-recovery':'read-only',
    ok:source.reason!=='check-failed'&&!results.some(r=>['credential-unavailable','check-failed','dispatch-failed'].includes(r.reason)),source,results};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const apply=process.argv.includes('--apply');
  if(apply&&(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main'))
    throw Error('Automatic recovery writes run only in the main-branch Actions watchdog');
  const report=await recoverMutualFunds({repository:process.env.GITHUB_REPOSITORY,token:process.env.GITHUB_TOKEN,apply});
  const lines=['## Mutual Fund automatic recovery','',`- ${report.source.repository}: ${report.source.reason}${report.source.publishedAt?` · published ${report.source.publishedAt}`:''}`,
    ...report.results.map(r=>`- ${r.repository}/${r.workflow}: ${r.reason}${r.error?` (${r.error})`:''}`)];
  console.log(lines.join('\n'));
  if(process.env.MF_RECOVERY_REPORT)writeFileSync(process.env.MF_RECOVERY_REPORT,JSON.stringify(report,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
  process.exitCode=report.ok?0:1;
}
