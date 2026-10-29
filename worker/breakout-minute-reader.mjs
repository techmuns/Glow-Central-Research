import {boundedJson} from '../public/js/data/family-book-contract.js';
import {BREAKOUT_ORIGIN} from '../public/js/data/breakout-live-shared.js';
import {mfRepo} from './mutual-funds-github.mjs';
import {hash,openForReader} from './mutual-funds-seal.mjs';
import {backgroundContract} from './github-background-contract.mjs';
import {readBackgroundView} from './github-background-views.mjs';
import {packedBreakoutResponse,unchangedPackedBreakouts} from './breakout-packed-response.mjs';
import {readPrivateRecord} from './github-private-records.mjs';
import {selectPreparedBreakouts} from './breakouts-github.mjs';
const FEATURE='breakouts-live',MAX=8*1024*1024;
async function boundedBytes(response,max=MAX){
 if(!response.ok||Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw Error('Prepared minute delivery unavailable');}
 const reader=response.body?.getReader();if(!reader)throw Error('Minute body missing');const chunks=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max)throw Error('Minute delivery budget exceeded');chunks.push(part.value);}}
 finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function minuteManifest(header,size,{repo,signature}) {
 const text=new TextDecoder();
 if(header.length<9||text.decode(header.subarray(0,5))!=='GHRB1')throw Error('Invalid minute bundle');
 const length=new DataView(header.buffer,header.byteOffset,header.byteLength).getUint32(5);
 if(length<1||length>16384||9+length>header.length)throw Error('Invalid minute manifest');
 const metadata=JSON.parse(text.decode(header.subarray(9,9+length))),state=metadata.files?.state,views=metadata.files?.views;
 if(metadata.version!==1||metadata.repo!==repo||metadata.feature!==FEATURE||metadata.sourceSignature!==signature||Object.keys(metadata.files||{}).sort().join(',')!=='state,views'||!state||!views||![state.size,views.size].every(n=>Number.isSafeInteger(n)&&n>0&&n<MAX)||![state.hash,views.hash].every(h=>/^[a-f0-9]{64}$/.test(h||''))||9+length+state.size+views.size!==size)throw Error('Invalid minute bundle context');
 return {metadata,start:9+length,state,views};
}
async function minuteFiles(viewBytes,{repo,signature}) {
 const unpacked=await boundedBytes(new Response(new Response(viewBytes).body.pipeThrough(new DecompressionStream('gzip'))));
 const lines=new TextDecoder().decode(unpacked).trimEnd().split('\n');if(lines.length<3||lines.length>66)throw Error('Invalid minute reader inventory');
 const header=JSON.parse(lines.shift()),footer=JSON.parse(lines.pop()),files=Object.create(null);
 if(header.format!=='encrypted-static-views-v1'||header.repo!==repo||header.feature!==FEATURE||header.sourceSignature!==signature||footer.format!=='complete'||footer.files!==lines.length)throw Error('Invalid minute prepared package');
 for(const line of lines){const record=JSON.parse(line);if(!/^[a-z0-9-]{1,180}\.json$/.test(record.name)||Object.hasOwn(files,record.name))throw Error('Invalid minute reader filename');files[record.name]=record.envelope;}
 if(!files['head.json'])throw Error('Minute head missing');return files;
}
export async function minuteEnvelope(bytes,context){
 const {start,state,views}=minuteManifest(bytes,bytes.length,context),stateBytes=bytes.subarray(start,start+state.size),viewBytes=bytes.subarray(start+state.size);
 if(await hash(stateBytes)!==state.hash||await hash(viewBytes)!==views.hash)throw Error('Minute bundle integrity failed');
 return minuteFiles(viewBytes,context);
}
// The reader needs only the encrypted current view. Restart frames and mapping
// configuration stay on GitHub and never consume the request's transfer/CPU budget.
async function minuteRange(asset,start,end,fetcher,signal){
 let url=asset.browser_download_url;
 for(let redirects=0;redirects<3;redirects++){
  const response=await fetcher(url,{headers:{range:`bytes=${start}-${end}`,'user-agent':'GlowPreparedQuotes'},redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)){
   const next=new URL(response.headers.get('location'),url);await response.body?.cancel();
   if(next.protocol!=='https:'||next.username||next.password||next.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw Error('Invalid minute redirect');
   url=next.href;continue;
  }
  if(response.status!==206||response.headers.get('content-range')!==`bytes ${start}-${end}/${asset.size}`){await response.body?.cancel();throw Error('Minute range unavailable');}
  const bytes=await boundedBytes(response,end-start+1);if(bytes.length!==end-start+1)throw Error('Incomplete minute range');return bytes;
 }
 throw Error('Minute redirect limit');
}
export async function preparedMinuteBreakouts(request,env,{fetcher=fetch,edgeCache=globalThis.caches?.default,now=Date.now(),packed=false}={}){
 const url=new URL(request.url),signal=AbortSignal.timeout(12000);
 if(env.BREAKOUT_LIVE_RUNTIME!=='github'||url.origin!==BREAKOUT_ORIGIN)return null;
 const repo=mfRepo(env);if(repo!=='techmuns/Glow-Central-Research'||!env.GH_DISPATCH_TOKEN)return null;
 const day=new Date(now).toISOString().slice(0,10),tag=`breakout-live-${day}`;
 const headKey=new Request(new URL(`/_prepared-minute/head-${day}`,url.origin));
 let asset,loaded=false;
 try{const cached=await edgeCache?.match(headKey);if(cached)asset=await boundedJson(cached,16384);}catch{/* Read the fixed GitHub source. */}
 if(!asset){
  const response=await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${tag}`,{headers:{authorization:`Bearer ${env.GH_DISPATCH_TOKEN}`,accept:'application/vnd.github+json','user-agent':'ResearchPreparedQuotes'},redirect:'manual',signal});
  if(response.status===404){await response.body?.cancel();return null;}
  if(!response.ok){await response.body?.cancel();throw Error('Minute publication metadata unavailable');}
  const release=await boundedJson(response,4*1024*1024),pointer=JSON.parse(release.body||'null');
  if(release.tag_name!==tag||pointer?.format!=='breakout-minute-head-v1')throw Error('Invalid minute publication pointer');
  asset=pointer.asset;loaded=true;
 }
 if(!Number.isSafeInteger(asset?.id)||asset.id<1||!/^bq-\d+-\d+-\d+-\d{13}-bundle\.bin$/.test(asset?.name||'')||asset.state!=='uploaded'||!Number.isSafeInteger(asset.size)||asset.size<33||asset.size>MAX||asset.browser_download_url!==`https://github.com/${repo}/releases/download/${tag}/${asset.name}`)throw Error('Invalid minute publication pointer');
 if(loaded&&edgeCache)await edgeCache.put(headKey,Response.json(asset,{headers:{'cache-control':'public, max-age=20'}})).catch(()=>{});
 if(packed){const unchanged=unchangedPackedBreakouts(request,asset.id);if(unchanged)return unchanged;}
 const key=new Request(new URL(`/_prepared-minute/generation-${asset.id}`,url.origin));
 let files;
 try{const cached=await edgeCache?.match(key);if(cached)files=await boundedJson(cached,MAX);}catch{/* Reload this immutable generation. */}
 if(!files){
  // Public immutable asset request: no repository credential follows the CDN redirect.
  const context={repo,signature:await backgroundContract(FEATURE)};
  const header=await minuteRange(asset,0,Math.min(asset.size-1,16392),fetcher,signal);
  const {start,state,views}=minuteManifest(header,asset.size,context),from=start+state.size;
  const viewBytes=await minuteRange(asset,from,from+views.size-1,fetcher,signal);
  if(await hash(viewBytes)!==views.hash)throw Error('Minute view integrity failed');
  files=await minuteFiles(viewBytes,context);
  // Cache only ciphertext, on demand. No alarm, SQL state or collection runs here.
  if(edgeCache)await edgeCache.put(key,Response.json(files,{headers:{'cache-control':'public, max-age=86400'}})).catch(()=>{});
 }
 // The package is already parsed. Re-serializing its ciphertext through an
 // emulated ASSETS response spent the request CPU budget before decrypting it.
 if(packed){const bytes=await openForReader(files['head.json'],env.GH_DISPATCH_TOKEN,`${repo}:github-prepared:${FEATURE}:head.json:v1`);return packedBreakoutResponse(bytes,request,asset.id);}
 const preparedEnv={...env,ASSETS:{fetch:async request=>{const name=new URL(request.url).pathname.split('/').at(-1);return Object.hasOwn(files,name)?Response.json(files[name]):new Response(null,{status:404});}}};
 const head=await readBackgroundView(preparedEnv,request.url,FEATURE,'head.json');
 if(head?.version!==1||head.repo!==repo||head.feature!==FEATURE)throw Error('Invalid prepared minute snapshot');
 // New generations use one compressed envelope. Older paged publications stay readable.
 if(Array.isArray(head.fallback?.rows)&&Array.isArray(head.primary?.rows))return selectPreparedBreakouts(head,head.fallback,head.primary,url.pathname,{now,delivery:'github-prepared'});
 if(!head.parts)throw Error('Invalid prepared minute snapshot');
 const memo=new Map(),read=id=>readPrivateRecord(preparedEnv,request.url,FEATURE,head,id,{memo});
 const rowsFor=async value=>{if(!Array.isArray(value?.pages))throw Error('Invalid minute quote pages');const rows=[];for(const id of value.pages){const page=await read(id);if(!Array.isArray(page?.rows))throw Error('Minute page missing');rows.push(...page.rows);}const {pages,...metadata}=value;return {...metadata,rows};};
 return selectPreparedBreakouts(head,await rowsFor(head.fallback),await rowsFor(head.primary),url.pathname,{now,delivery:'github-prepared'});
}
