import {boundedJson} from '../public/js/data/family-book-contract.js';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
import {mfRepo} from './mutual-funds-github.mjs';
import {hash} from './mutual-funds-seal.mjs';
import {backgroundContract} from './github-background-contract.mjs';
import {openBackgroundEnvelope} from './github-background-views.mjs';
import {selectPreparedBreakouts} from './breakouts-github.mjs';
const FEATURE='breakouts-live',MAX=8*1024*1024;
async function boundedBytes(response,max=MAX){
 if(!response.ok||Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('Prepared minute delivery unavailable');}
 const reader=response.body?.getReader();if(!reader)throw Error('Minute body missing');const chunks=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max)throw Error('Minute delivery budget exceeded');chunks.push(part.value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export async function minuteEnvelope(bytes,{repo,signature}){
 const text=new TextDecoder();
 if(bytes.length<9||text.decode(bytes.subarray(0,5))!=='GHRB1')throw Error('Invalid minute bundle');
 const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(5);
 if(size<1||size>16384||9+size>bytes.length)throw Error('Invalid minute manifest');
 const metadata=JSON.parse(text.decode(bytes.subarray(9,9+size))),state=metadata.files?.state,views=metadata.files?.views;
 if(metadata.version!==1||metadata.repo!==repo||metadata.feature!==FEATURE||metadata.sourceSignature!==signature||Object.keys(metadata.files||{}).sort().join(',')!=='state,views'||!state||!views||![state.size,views.size].every(n=>Number.isSafeInteger(n)&&n>0&&n<MAX)||9+size+state.size+views.size!==bytes.length)throw Error('Invalid minute bundle context');
 const stateBytes=bytes.subarray(9+size,9+size+state.size),viewBytes=bytes.subarray(9+size+state.size);
 if(await hash(stateBytes)!==state.hash||await hash(viewBytes)!==views.hash)throw Error('Minute bundle integrity failed');
 // The retained restart member is never decrypted by the website.
 const unpacked=await boundedBytes(new Response(new Response(viewBytes).body.pipeThrough(new DecompressionStream('gzip'))));
 const lines=text.decode(unpacked).trimEnd().split('\n');if(lines.length!==3)throw Error('Invalid minute reader inventory');
 const [header,record,footer]=lines.map(line=>JSON.parse(line));
 if(header.format!=='encrypted-static-views-v1'||header.repo!==repo||header.feature!==FEATURE||header.sourceSignature!==signature||record.name!=='head.json'||footer.format!=='complete'||footer.files!==1)throw Error('Invalid minute prepared package');
 return record.envelope;
}
export async function preparedMinuteBreakouts(request,env,{fetcher=fetch,edgeCache=globalThis.caches?.default,now=Date.now()}={}){
 const url=new URL(request.url);
 if(env.BREAKOUT_LIVE_RUNTIME!=='github'||url.origin!==BREAKOUT_ORIGIN)return null;
 const repo=mfRepo(env);if(repo!=='techmuns/Glow-Central-Research'||!env.GH_DISPATCH_TOKEN)return null;
 const day=new Date(now).toISOString().slice(0,10),tag=`breakout-live-${day}`,key=new Request(new URL(`/_prepared-minute/${day}`,url.origin));
 let envelope;
 try{const cached=await edgeCache?.match(key);if(cached)envelope=await boundedJson(cached,MAX);}catch{/* Read the fixed GitHub source. */}
 if(!envelope){
  const response=await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${tag}`,{headers:{authorization:`Bearer ${env.GH_DISPATCH_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchPreparedQuotes'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();throw Error('Minute publication metadata unavailable');}
  const release=await boundedJson(response,4*1024*1024),pointer=JSON.parse(release.body||'null'),asset=pointer?.asset;
  if(release.tag_name!==tag||pointer?.format!=='breakout-minute-head-v1'||!/^bq-\d+-\d+-\d+-\d{13}-bundle\.bin$/.test(asset?.name||'')||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<33||asset.size>MAX||asset.browser_download_url!==`https://github.com/${repo}/releases/download/${tag}/${asset.name}`)throw Error('Invalid minute publication pointer');
  // Public immutable asset request: no repository credential follows the CDN redirect.
  const bytes=await boundedBytes(await fetcher(asset.browser_download_url,{redirect:'follow',signal:AbortSignal.timeout(15000)}));
  if(bytes.length!==asset.size||asset.digest&&asset.digest!==`sha256:${await hash(bytes)}`)throw Error('Minute asset integrity failed');
  envelope=await minuteEnvelope(bytes,{repo,signature:await backgroundContract(FEATURE)});
  // Cache only ciphertext, on demand. No alarm, SQL state or collection runs here.
  if(edgeCache)await edgeCache.put(key,Response.json(envelope,{headers:{'cache-control':'public, max-age=20'}})).catch(()=>{});
 }
 const head=await openBackgroundEnvelope(env,FEATURE,'head.json',envelope);
 if(head.version!==1||head.repo!==repo||head.feature!==FEATURE||!Array.isArray(head.fallback?.rows)||head.primary&&!Array.isArray(head.primary.rows))throw Error('Invalid prepared minute snapshot');
 return selectPreparedBreakouts(head,head.fallback,head.primary,url.pathname,{now,delivery:'github-prepared'});
}
