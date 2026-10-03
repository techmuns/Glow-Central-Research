import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PriceLevelStore} from '../worker/price-levels-store.mjs';
import {PriceLevelSchedule,levelQuotes} from '../worker/price-levels-schedule.mjs';
import {levelHit} from '../public/js/data/price-levels-shared.js';
import {handlePriceLevels} from '../worker/price-levels.mjs';
const db=new DatabaseSync(':memory:'),kv=new Map();let alarm=null;
const storage={sql:{exec:(sql,...args)=>{const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};}},transactionSync:fn=>{db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}},get:async k=>kv.get(k),put:async(k,v)=>kv.set(k,v),getAlarm:async()=>alarm,setAlarm:async n=>{alarm=n;},deleteAlarm:async()=>{alarm=null;}};storage.transaction=fn=>fn(storage);
const day='2026-09-23';let at=Date.parse(`${day}T11:00:00+05:30`);const now=()=>at;
const store=new PriceLevelStore(storage,{now});
const edit=(levels,extra={})=>({op:'patch',ticker:'TEST',isin:'INE000000001',name:'Fixture',levels,...extra});
store.apply([edit({buyAt:100})]);store.apply([edit({sellAt:200})]);
assert.equal(store.snapshot().companies[0].levels.buyAt.value,100,'independent devices do not overwrite other level kinds');
store.apply([edit({buyAt:null})]);assert.equal(store.snapshot().companies[0].levels.buyAt,null);assert.equal(store.snapshot().companies[0].levels.sellAt.value,200);
assert.throws(()=>store.apply([edit({stopLoss:70},{isin:'INE000000002'})]),/identity/);
const quote={price:210,high:220,low:90,sessionDate:day,quoteAt:new Date(at-1).toISOString()};
assert.equal(levelHit({direction:'up',value:200,setAt:new Date(at).toISOString()},quote),null,'no quote preceding a newly set level');
at+=1000;quote.quoteAt=new Date(at).toISOString();assert.equal(store.recordCheck(at,new Map([['TEST',quote]])).reached.length,1);
assert.equal(store.recordCheck(at,new Map([['TEST',quote]])).reached.length,0);
store.apply([{op:'clear',ticker:'TEST'}]);store.apply([edit({sellAt:200},{op:'seed'})]);assert.equal(store.snapshot().companies.length,0,'old browser seed cannot undo deletion');assert.equal(store.snapshot().hits.length,1);
// More than the original history and tombstone limits survive, with lossless pages.
for(let i=0;i<505;i++){at++;store.apply([edit({sellAt:100+i})]);at++;store.recordCheck(at,new Map([['TEST',{...quote,price:1000,quoteAt:new Date(at).toISOString()}]]));}
let page=store.snapshot(),all=[];do{all.push(...page.hits);page=page.nextCursor?store.snapshot(page.nextCursor):null;}while(page);
assert.equal(all.length,506);assert.equal(new Set(all.map(h=>h.id)).size,506);
store.apply([{op:'clear',ticker:'TEST'}]);for(let i=0;i<405;i++)store.apply([{op:'clear',ticker:`X${i}`}]);store.apply([edit({sellAt:300},{op:'seed'})]);assert.equal(store.snapshot().companies.length,0);
const restarted=new PriceLevelStore(storage,{now});assert.equal(restarted.snapshot().retainedHits,506);
store.apply([edit({buyAt:1})]);
const schedule=new PriceLevelSchedule(storage,{UPSTOX_ACCESS_TOKEN:'fixture'},store,{now,fetcher:async()=>Response.json({status:'success',data:{}})});
await schedule.snapshot();assert.equal(alarm,null,'reads never activate monitoring');await schedule.arm();assert(alarm);await schedule.wake();assert.equal((await schedule.status()).current,false);assert.equal((await schedule.status()).state,'partial');assert.equal((await schedule.status()).checkedAt,null,'partial success is not a complete check');
const token='synthetic-private-service-token-00001',env={FAMILY_PRICE_LEVELS_TOKEN:token,CAPTURE_REGISTRY:{getByName:()=>({priceLevelsSnapshot:cursor=>schedule.snapshot(cursor),priceLevelsApply:input=>{const result=store.apply(input);return {...result.snapshot,outcomes:result.outcomes};}})}};
for(const headers of [{},{origin:'https://sattva-family.pages.dev'},{authorization:'Bearer names-only-holdings-token'}])assert.equal((await handlePriceLevels(new Request('https://central.test/api/price-levels',{headers}),env)).status,401);
const response=await handlePriceLevels(new Request('https://central.test/api/price-levels',{headers:{authorization:`Bearer ${token}`}}),env);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
const validQuote={instrument_token:'NSE_EQ|INE000000001',symbol:'TEST',last_price:110,last_trade_time:String(at),ohlc:{high:120,low:100}};
assert.equal(levelQuotes({status:'success',data:{one:validQuote}},[{ticker:'TEST',isin:'INE000000001'}],at).size,1);
for(const change of [{symbol:'OTHER'},{instrument_token:'NSE_EQ|INE000000002'},{last_trade_time:String(at-86400000)}])assert.equal(levelQuotes({status:'success',data:{one:{...validQuote,...change}}},[{ticker:'TEST',isin:'INE000000001'}],at).size,0);
console.log('PASS private service authentication, independent edits, identity refusal, no pre-set quote hit, once-only detection, 506 retained hits, pagination, tombstones, restart, read-only GET and incomplete quote checks');

// Edits during and after a successful source request revoke completeness immediately.
at+=60001;
const live=new PriceLevelSchedule(storage,{UPSTOX_ACCESS_TOKEN:'fixture'},store,{now,fetcher:async()=>Response.json({status:'success',data:{one:{...validQuote,last_trade_time:String(at)}}})});
await live.wake();assert.equal((await live.status()).current,true);const completeAt=(await live.status()).checkedAt;
store.apply([edit({stopLoss:2})]);assert.equal((await live.status()).current,false);
at+=60001;
const race=new PriceLevelSchedule(storage,{UPSTOX_ACCESS_TOKEN:'fixture'},store,{now,fetcher:async()=>{store.apply([edit({sellAt:400})]);return Response.json({status:'success',data:{one:{...validQuote,last_trade_time:String(at)}}});}});
await race.wake();assert.equal((await race.status()).current,false);assert.equal((await race.status()).checkedAt,completeAt);
store.apply([edit({sellAt:500})]);const first=store.snapshot().companies[0].levels.sellAt.setAt;store.apply([edit({sellAt:400})]);store.apply([edit({sellAt:500})]);assert.notEqual(store.snapshot().companies[0].levels.sellAt.setAt,first,'same-millisecond re-arms retain distinct hit identities');
const invalid=await handlePriceLevels(new Request('https://central.test/api/price-levels',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{'}),env);assert.equal(invalid.status,400);
console.log('PASS edits during checks never advance completeness; same-clock re-arms remain distinct; malformed bodies are rejected');
