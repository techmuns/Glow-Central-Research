#!/usr/bin/env node
// Fixed main-branch workflows only. Recovery never scrapes, cancels, reruns,
// deploys, or treats a successful import as a successful AMC source check.
import {appendFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {latestRun,isInFlight,dispatchWorkflow} from '../worker/github-actions.mjs';

const REPO='techmuns/Glow-Central-Research',INTERVAL=15*60000;
export const MF_RECOVERY_TARGETS=[
  {repo:'techmuns/AmfiBeas',file:'amc-factsheet-monthly.yml',inputs:{mode:'monthly',commit:'true'}},
  {repo:REPO,file:'mutual-funds-refresh.yml',inputs:{source:'automatic-recovery'}},
  {repo:REPO,file:'mutual-funds-scanner.yml',inputs:{source:'automatic-recovery'}}
];
function time(value,now) {
  const t=Date.parse(value);
  if(!Number.isFinite(t)||t>now+60000)throw Error('Invalid workflow time');
  return t;
}
export function mutualFundsRecoveryDecision(runs,{now=Date.now(),sourceRuns=[],importer=false,source=false}={}) {
  if(runs.some(isInFlight))return {due:false,reason:'already-running'};
  const latest=runs.filter(r=>!source||!r.title?.includes('scheme-benchmarks')).sort((a,b)=>time(b.createdAt,now)-time(a.createdAt,now))[0];
  if(!latest)return {due:true,reason:'no-run'};
  const completed=time(latest.updatedAt,now),created=time(latest.createdAt,now);
  // Even a failed upstream run publishes its verified partial snapshot before
  // reporting incomplete coverage. Import that progress as soon as it finishes.
  const published=importer&&sourceRuns.find(r=>r.status==='completed'&&!r.title?.includes('scheme-benchmarks'));
  if(published&&time(published.updatedAt,now)>created&&now-created>=INTERVAL)
    return {due:true,reason:'new-source-run',run:latest.id};
  // A partial disclosure is not a transport outage. The source collectors retain
  // their own refusal cooldowns; don't back off every other healthy source too.
  return {due:now-completed>=INTERVAL,reason:now-completed>=INTERVAL?'overdue':'recent-run',run:latest.id};
}
export async function recoverMutualFunds({repository=REPO,token,sourceToken,fetcher=fetch,now=Date.now(),apply=false}={}) {
  if(repository!==REPO)throw Error('Recovery is restricted to Glow');
  const results=[],inventories=new Map();
  // Inventory all targets before writes. A failed read must not mean an empty
  // queue. Collector workflow concurrency protects retained state across targets.
  for(const target of MF_RECOVERY_TARGETS) {
    const credential=target.repo===REPO?token:sourceToken;
    const result={repository:target.repo,workflow:target.file,due:false};results.push(result);
    if(!credential){result.reason='credential-unavailable';continue;}
    const [owner,repo]=target.repo.split('/'),cfg={owner,repo,token:credential,ref:'main'};
    try {
      const runs=await latestRun(fetcher,cfg,target.file,{perPage:20});
      inventories.set(target.file,{target,cfg,runs,result});
    }catch(error){result.reason='check-failed';result.error=error.code||'invalid-runs';}
  }
  for(const {target,cfg,runs,result} of inventories.values()) {
    try {
      Object.assign(result,mutualFundsRecoveryDecision(runs,{now,importer:target.file==='mutual-funds-refresh.yml',
        source:target.file==='amc-factsheet-monthly.yml',
        sourceRuns:inventories.get('amc-factsheet-monthly.yml')?.runs||[]}));
      if(!result.due)continue;
      if(!apply){result.reason='would-dispatch';continue;}
      // dispatchWorkflow rechecks every active status immediately before POST,
      // refuses failed queue reads and never retries an ambiguous POST response.
      const out=await dispatchWorkflow(fetcher,cfg,target.file,'main',target.inputs);
      result.reason=out.dispatched?'dispatched':'already-running';
    }catch(error){result.reason=result.due?'dispatch-failed':'check-failed';result.error=error.code||'invalid-runs';}
  }
  return {checkedAt:new Date(now).toISOString(),mode:apply?'automatic-recovery':'read-only',
    ok:!results.some(r=>['credential-unavailable','check-failed','dispatch-failed'].includes(r.reason)),results};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const apply=process.argv.includes('--apply');
  if(apply&&(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REF!=='refs/heads/main'))
    throw Error('Automatic recovery writes run only in the main-branch Actions watchdog');
  const report=await recoverMutualFunds({repository:process.env.GITHUB_REPOSITORY,token:process.env.GITHUB_TOKEN,
    sourceToken:process.env.AMFI_ACTIONS_TOKEN,apply});
  const lines=['## Mutual Fund automatic recovery','',...report.results.map(r=>`- ${r.repository}/${r.workflow}: ${r.reason}${r.error?` (${r.error})`:''}`)];
  console.log(lines.join('\n'));
  if(process.env.MF_RECOVERY_REPORT)writeFileSync(process.env.MF_RECOVERY_REPORT,JSON.stringify(report,null,2)+'\n');
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
  process.exitCode=report.ok?0:1;
}
