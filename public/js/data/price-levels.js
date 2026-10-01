// Private in-memory projection. The authenticated Family bridge is the only reader;
// neither levels nor their reached history enter public stores or automatic model calls.
import * as bridge from '../research/portfolio-bridge.js';
import {record} from './alert-records.js';
import {PRICE_LEVEL,hitEvidence} from './price-levels-shared.js';
let snapshot=null,pending=null,generation=0,lastAttempt=0,failed=false;
const listeners=new Set();
export const onChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
const emit=()=>{for(const fn of listeners)fn();};
function clear(){generation++;snapshot=null;failed=false;lastAttempt=0;emit();}
bridge.onPortfolioInvalidation?.(clear);
bridge.onPortfolioConnection?.(connected=>{if(connected){void load();}else clear();});
export function load(){
  if(pending)return pending;
  if(!bridge.priceLevelsAvailable?.()){if(snapshot)clear();return Promise.resolve();}
  if(Date.now()-lastAttempt<55000)return Promise.resolve();
  const token=generation;lastAttempt=Date.now();
  pending=(async()=>{
    let cursor=null,first=null;const hits=new Map(),seen=new Set();
    do{
      const value=await bridge.readPriceLevels(cursor);
      if(token!==generation)return;
      if(!value?.ok||!Array.isArray(value.companies)||!Array.isArray(value.hits))throw Error('Private price alerts unavailable');
      first ||= value;
      for(const hit of value.hits){if(!PRICE_LEVEL[hit.level]||typeof hit.id!=='string'||!Number.isFinite(hit.value)||!Number.isFinite(hit.price)||!Number.isFinite(Date.parse(hit.reachedAt)))throw Error('Private price alert invalid');hits.set(hit.id,hit);}
      cursor=value.nextCursor;
      if(cursor){if(typeof cursor!=='string'||seen.has(cursor))throw Error('Private alert history incomplete');seen.add(cursor);}
    }while(cursor);
    if(token!==generation)return;
    snapshot={...first,hits:[...hits.values()]};failed=false;emit();
  })().catch(()=>{if(token===generation){snapshot=null;failed=true;emit();}}).finally(()=>{pending=null;if(token!==generation&&bridge.priceLevelsAvailable?.())queueMicrotask(()=>void load());});
  return pending;
}
const rupees=n=>`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export function priceLevelRecord(hit){
  const def=PRICE_LEVEL[hit.level];
  return record({id:hit.id,row:hit,at:hit.reachedAt,ticker:hit.ticker,company:hit.name||hit.ticker,
    headline:`${def.reached} — ${rupees(hit.value)}`,
    detail:`${def.label} ${rupees(hit.value)}, set in Sattva Family. Reached on ${hitEvidence(hit.basis)} at ${rupees(hit.price)}; exchange quote ${hit.quoteAt||'time unavailable'}. Observed at ${hit.reachedAt}.`,
    url:'https://sattva-family.pages.dev/',kind:'price-level',private:true,
    direction:hit.level==='buyAt'?'neutral':def.direction==='down'?'negative':'positive',importance:'high',aiEligible:true,
    importanceReason:'A price level explicitly set by the family was reached.',entityId:hit.isin?`isin:${hit.isin}`:null,
    priceLevel:hit.level,levelValue:hit.value,reachedPrice:hit.price,reachedBasis:hit.basis});
}
export function readFeed(){
  if(!snapshot)return {events:[],status:failed?'failed':'on-demand',asOf:null,reachesToday:false,note:failed?'Private price alerts could not be checked. Family access or the shared monitoring service is unavailable.':'Price alerts require the authenticated Sattva Family connection.'};
  const check=snapshot.check||{};
  return {events:snapshot.hits.map(priceLevelRecord),status:check.failed?'failed':check.current?'ok':'pending',asOf:check.checkedAt||null,reachesToday:check.current===true,
    note:`${snapshot.pending} levels pending. Background check: ${check.state||'not checked'}. Last complete check: ${check.checkedAt||'not yet checked'}. Reached history is retained from first capture; minute sampling cannot establish every intraday crossing.`,revision:`${snapshot.revision}:${check.checkedAt}:${check.state}`};
}
