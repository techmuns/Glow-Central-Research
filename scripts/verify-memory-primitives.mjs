import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryCache } from '../public/js/core/memory-cache.js';
import { createAlertWindowCache } from '../public/js/data/alert-window-cache.js';
import { hydrateJsonShards, jsonShardCacheState } from '../public/js/core/json-shards.js';

const ram = createMemoryCache(100), dirty = { onlyCopy: true };
ram.set('dirty', dirty, 120, false); ram.set('saved', {}, 40, true);
assert.equal(ram.get('dirty'), dirty, 'unsaved data cannot be evicted to meet a budget');
assert.equal(ram.get('saved'), undefined, 'reconstructible entries can leave RAM');
ram.markEvictable('dirty', dirty);
assert.equal(ram.get('dirty'), undefined, 'oversized data leaves optional RAM only after durable commit');
ram.set('first', {}, 40); ram.set('second', {}, 40); ram.get('first'); ram.set('third', {}, 40);
assert.equal(ram.get('second'), undefined, 'coldest data is evicted first');
assert(ram.stats().bytes <= 100);

const disk = new Map(), writes = [];
let release, entered;
const gate = new Promise(resolve => { release = resolve; });
const started = new Promise(resolve => { entered = resolve; });
const cache = createAlertWindowCache({ cacheKey: 'fixture', read: key => disk.get(key), write: async (entries, deletes=[]) => {
  if (entries.has('fixture')) { writes.push(entries.get('fixture').value.revision); if(writes.length===1){entered();await gate;} }
  for (const key of deletes) disk.delete(key);
  for (const [key,value] of entries) disk.set(key,value);
  return { persistent:true };
}});
let serializations = 0;
const version = revision => ({ revision, events: [{ id:'original', headline:`Correction ${revision}`, toJSON(){serializations++;return {id:this.id,headline:this.headline}} },
  ...Array.from({length:revision},(_,i)=>({id:`arrival:${i}`}))] });
const first = cache.write(version(0)); await started;
const pending = Array.from({length:10},(_,i)=>cache.write(version(i+1)));
const superseded = await Promise.all(pending.slice(0,-1));
assert(superseded.every(result=>result.superseded && !result.persistent), 'superseded revisions never claim to be saved');
assert.equal(serializations,1,'waiting obsolete snapshots are never serialized');
release(); await first; assert.equal((await pending.at(-1)).persistent,true);
assert.deepEqual(writes,[0,10],'only the active and newest complete revision are published');
const saved = (await cache.read()).value;
assert.equal(saved.events.length,11);assert.equal(saved.events[0].headline,'Correction 10');
assert.equal(new Set(saved.events.map(event=>event.id)).size,11,'every distinct arrival survives');

const bytes = JSON.stringify({items:[{id:'one',nested:{value:'original'}}]});
const sha256 = createHash('sha256').update(bytes).digest('hex');
const part = {file:`news.parts/${sha256}.json`,sha256,rows:1,bytes:Buffer.byteLength(bytes)};
const manifest = {articles:[],_jsonShards:{version:1,field:'articles',rows:1,parts:[part]}};
let fetches=0, openRead;
const wait = new Promise(resolve=>{openRead=resolve});
const fetcher=async()=>{fetches++;await wait;return new Response(bytes)};
const cancelled = new AbortController();
const abandoned = hydrateJsonShards(manifest,'news.json',{fetcher,signal:cancelled.signal});
const retained = hydrateJsonShards(manifest,'news.json',{fetcher});
cancelled.abort();await assert.rejects(abandoned);openRead();
const a=await retained,b=await hydrateJsonShards({...manifest,revision:2},'news.json',{fetcher});
assert.equal(fetches,1,'overlapping and later unchanged reads share verified work');
assert.equal(a.articles[0],b.articles[0],'unchanged parts reuse the original verified record objects');
assert.throws(()=>{a.articles[0].nested.value='corruption'},TypeError,'shared verified bytes cannot be changed by a consumer');
assert.deepEqual(jsonShardCacheState(fetcher).decodes,1);
const bad = {...part,sha256:'a'.repeat(64),file:`news.parts/${'a'.repeat(64)}.json`};
await assert.rejects(hydrateJsonShards({...manifest,_jsonShards:{...manifest._jsonShards,parts:[bad]}},'news.json',{fetcher:async()=>new Response(bytes)}),/integrity/);
console.log('PASS durable-before-eviction, bounded snapshot backlog, every arrival/correction, cancellation isolation and immutable part reuse.');
