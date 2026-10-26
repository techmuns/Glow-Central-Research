import {randomUUID} from 'node:crypto';
import {briefStats} from '../../worker/newsletter-brief.mjs';
import {editorialEvents} from '../../worker/newsletter-editorial.mjs';
import {newsletterSourceUrl} from '../../worker/newsletter-source-links.mjs';
import {sourceId,sourceTarget,SOURCE_LINK_FORMAT} from '../../worker/newsletter-source-shortcuts.mjs';

// This is retained alongside edition PDFs, never in the replaceable preview namespace.
// INSERT only: an emailed identifier must always resolve to the same captured source.
export function newsletterSourceShortcuts(db,origin,{now=Date.now}={}) {
  const links=new Map(),records=new Map();
  for(const row of db.prepare("SELECT id,payload FROM newsletter_views WHERE id LIKE 'source-%'").all()){
    const id=row.id.slice(7),record=JSON.parse(row.payload),target=sourceTarget(record);
    if(!sourceId(id)||!target)throw Error('Invalid retained source shortcut');
    records.set(id,record);if(!links.has(target))links.set(target,`${origin}/api/newsletter/s/${id}`);
  }
  const register=original=>{
    if(!original||original.length<=160||links.has(original))return links.get(original)||original;
    const record={format:SOURCE_LINK_FORMAT,url:original,createdAt:new Date(now()).toISOString()};
    if(!sourceTarget(record))throw Error('Invalid source shortcut destination');
    const id=randomUUID(),alias=`${origin}/api/newsletter/s/${id}`;
    if(alias.length>=original.length)return original;
    db.prepare('INSERT INTO newsletter_views(id,payload) VALUES(?,?)').run('source-'+id,JSON.stringify(record));
    records.set(id,record);links.set(original,alias);return alias;
  };
  return {links,register,record:id=>records.get(id),prepare(brief){
    for(const event of editorialEvents(brief,briefStats(brief).companies).events)register(newsletterSourceUrl(event.lead));
  }};
}

// Verify deployed routing and every exact immutable destination before provider I/O.
export function sourcePublicationVerifier(origin,{fetcher=fetch,now=Date.now,sleep=ms=>new Promise(done=>setTimeout(done,ms)),timeout=12*60000}={}) {
  const verified=new Map();
  return async links=>{
    const pending=links.filter(({id,url})=>verified.get(id)!==url),deadline=now()+timeout;
    for(let offset=0;offset<pending.length;offset+=20){
      const batch=pending.slice(offset,offset+20);
      for(;;){
        try{
          const response=await fetcher(`${origin}/api/newsletter/sources?ids=${batch.map(r=>r.id).join(',')}`,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(20000)});
          if(response.ok){
            const value=await response.json();
            if(value?.ok===true&&value.format===SOURCE_LINK_FORMAT&&Array.isArray(value.links)&&value.links.length===batch.length&&batch.every(expected=>value.links.some(actual=>actual.id===expected.id&&actual.url===expected.url))){
              for(const {id,url} of batch)verified.set(id,url);break;
            }
          }else await response.body?.cancel();
        }catch{/* A static deployment may still be publishing these immutable records. */}
        if(now()>=deadline)throw Error('Exact source links were not published; email was not sent');
        await sleep(Math.min(15000,Math.max(0,deadline-now())));
      }
    }
  };
}
