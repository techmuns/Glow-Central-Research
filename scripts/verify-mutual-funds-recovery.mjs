import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sourceFreshness} from '../public/js/data/mutual-funds-freshness.js';
import {coverageState} from '../worker/mutual-funds-model.mjs';
import {reconcileSourceChecks} from './lib/mutual-funds-checks.mjs';
import {mutualFundsRecoveryDecision as decision,recoverMutualFunds,MF_RECOVERY_TARGETS} from './recover-mutual-funds.mjs';
const now=Date.parse('2026-10-22T06:00:00Z'),iso=ms=>new Date(ms).toISOString(),recent=iso(now-60000),old=iso(now-3*86400000);
const a={slug:'a',month:'2026-09',status:'ok',checkedAt:recent,lastAttemptAt:recent};
const b={slug:'b',month:'2026-09',status:'unavailable',checkedAt:old,lastCompleteCheckedAt:old,lastAttemptAt:recent};
const meta={state:'complete',checkedAt:old,amcs:[a,b]};
let health=sourceFreshness(meta,now);
assert.equal(health.state,'partial');assert.equal(health.checkedAmcs,2);assert.equal(health.freshAmcs,1);assert.equal(health.checkedAt,old);
assert.equal(health.lastAttemptAt,recent);assert.equal(health.overdueAmcs,0);
assert.deepEqual(coverageState(meta,now),health,'Server and browser use the same source clocks');
assert.equal(reconcileSourceChecks([b],[{...b,checkedAt:null}])[0].checkedAt,old,'The last successful check survives another failure');
for(const attempt of [null,'invalid',iso(now-46*60000),iso(now+120000)]) {
  health=sourceFreshness({...meta,amcs:[a,{...b,lastAttemptAt:attempt,checkedAt:null}]},now);
  assert.equal(health.state,'stale');assert.equal(health.overdueAmcs,1);
}
assert.equal(sourceFreshness({...meta,amcs:[a,{...a,checkedAt:old}]},now).state,'partial','A recent attempt cannot certify an old successful disclosure');
assert.equal(sourceFreshness({...meta,amcs:[a]},now).state,'current','Only a fresh successful whole inventory is current');
assert.equal(sourceFreshness({...meta,amcs:[{...a,month:'2026-08'}]},now).state,'partial');
assert.equal(sourceFreshness({...meta,state:'collecting',amcs:[a]},now).state,'partial');
assert.equal(sourceFreshness(null,now).state,'unavailable');
assert.equal(sourceFreshness({...meta,amcs:[a]},Date.parse('2026-11-01T00:00:00Z')).state,'stale');

const run=(age,{id=1,status='completed',conclusion='success',duration=0,title='AMC holdings · monthly'}={})=>({id,status,conclusion,title,createdAt:iso(now-age*60000-duration*60000),updatedAt:iso(now-age*60000)});
assert(decision([run(16)],{now}).due);assert(!decision([run(14)],{now}).due);
assert(decision([run(16,{conclusion:'failure'})],{now}).due,'Incomplete sources continue at the normal cadence');
for(const status of ['queued','in_progress','waiting','requested','pending'])assert.equal(decision([run(1),run(120,{id:2,status})],{now}).reason,'already-running');
assert(decision([],{now}).due);
assert.throws(()=>decision([{...run(16),updatedAt:'invalid'}],{now}));
assert.throws(()=>decision([{...run(16),createdAt:iso(now+120000)}],{now}));
assert(decision([run(1,{duration:20})],{now,importer:true,sourceRuns:[run(2,{conclusion:'failure'})]}).due,'Import a newly published partial source snapshot after an older import');
assert(!decision([run(1)],{now,importer:true,sourceRuns:[run(2)]}).due);
assert(decision([run(1,{title:'AMC holdings · scheme-benchmarks'}),run(20,{id:2})],{now,source:true}).due,'Benchmark jobs do not certify monthly source checks');

let mode='ok',posts=[],reads=[];
const fetcher=async(url,options={})=>{
  const u=new URL(url),file=decodeURIComponent(u.pathname.split('/workflows/')[1]?.split('/')[0]);
  assert.equal(u.origin,'https://api.github.com');assert.equal(options.redirect,'manual');
  assert.equal(options.headers.authorization,u.pathname.includes('/AmfiBeas/')?'Bearer fixture-amfi-token':'Bearer fixture-glow-token');
  assert.equal(u.searchParams.get('branch')||JSON.parse(options.body).ref,'main');
  if(options.method==='POST'){
    const body=JSON.parse(options.body);posts.push({file,body});
    assert(MF_RECOVERY_TARGETS.some(t=>u.pathname===`/repos/${t.repo}/actions/workflows/${t.file}/dispatches`));
    if(mode==='ambiguous')return new Response(null,{status:503});
    return new Response(null,{status:204});
  }
  reads.push(u.href);
  const status=u.searchParams.get('status');
  if(mode==='bad-source'&&file==='amc-factsheet-monthly.yml')return new Response(null,{status:403});
  if(mode==='bad-active'&&status==='waiting')return new Response(null,{status:403});
  const shape=r=>({...r,created_at:r.createdAt,updated_at:r.updatedAt,display_title:r.title,event:'schedule'});
  return Response.json({workflow_runs:status?mode==='old-waiting'&&status==='waiting'?[shape(run(120,{status}))]:[]:[shape(run(mode==='recent'?1:120))]});
};
const opts={token:'fixture-glow-token',sourceToken:'fixture-amfi-token',fetcher,now};
let report=await recoverMutualFunds(opts);assert.equal(posts.length,0);assert(report.results.every(r=>r.reason==='would-dispatch'));
report=await recoverMutualFunds({...opts,apply:true});assert.equal(posts.length,3);assert(report.ok);
assert.deepEqual(posts[0].body,{ref:'main',inputs:{mode:'monthly',commit:'true'}});
assert.deepEqual(posts[1].body,{ref:'main',inputs:{source:'automatic-recovery'}});
for(const test of ['recent','old-waiting','bad-active']){
  mode=test;posts=[];report=await recoverMutualFunds({...opts,apply:true});assert.equal(posts.length,0,test);
  assert.equal(report.ok,test!=='bad-active');
}
mode='bad-source';posts=[];report=await recoverMutualFunds({...opts,apply:true});assert.equal(posts.length,2);assert(!report.ok,'Failed upstream queue reads must not stop independent retained imports and supplement checks');
mode='ambiguous';posts=[];report=await recoverMutualFunds({...opts,apply:true});assert.equal(posts.length,3);assert(report.results.every(r=>r.error==='dispatch-uncertain'),'Each ambiguous POST is attempted exactly once');
mode='ok';posts=[];report=await recoverMutualFunds({...opts,sourceToken:null,apply:true});assert.equal(posts.length,2);assert.equal(report.results[0].reason,'credential-unavailable');assert(!report.ok);
await assert.rejects(recoverMutualFunds({...opts,repository:'fixture/other'}));
const workflow=readFileSync('.github/workflows/mutual-funds-recovery.yml','utf8');
assert.match(workflow,/ref: main/);assert.match(workflow,/head_repository.full_name == github.repository/);
assert.match(workflow,/actions: write/);assert.match(workflow,/Deploy/);assert.match(workflow,/SYNC_PUSH_TOKEN/);
assert(!/cancel-in-progress: true|cloudflare|wrangler/.test(workflow));
for(const file of ['mutual-funds-refresh.yml','mutual-funds-scanner.yml'])assert.match(readFileSync('.github/workflows/'+file,'utf8'),/ref: main/);
console.log('PASS MF recovery: missed schedules, partial source publication, all active statuses, failed/ambiguous dispatches, fixed repository/security boundaries and independent truthful source clocks');
