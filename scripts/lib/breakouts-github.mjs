import fs from 'node:fs';
import path from 'node:path';
import {githubBackgroundRelease} from './github-background-release.mjs';
import {openBackgroundState} from './github-background-seal.mjs';
import {breakoutMinuteJournal} from './breakout-minute-journal.mjs';
import {prepareBreakoutPublication} from './breakout-publication.mjs';
import {copyBackgroundStore} from './github-background-restore.mjs';
import {localBreakouts} from './breakout-local.mjs';
import {BREAKOUT_TABLES} from '../../worker/breakout-export.mjs';
import {backgroundContract} from '../../worker/github-background-contract.mjs';

export async function githubBreakouts({env=process.env,fetcher=fetch,legacyClient,recipient,file=path.resolve('.cache/breakouts/state.sqlite'),out=path.resolve('.cache/breakouts/publication'),transportOptions={},localOptions={}}={}) {
 const transport=githubBackgroundRelease('breakouts',{env,fetcher,...transportOptions}),signature=await backgroundContract('breakouts');let local,cycle=0;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.mkdirSync(out,{recursive:true});
 const latest=await transport.latest();
 if(latest){const sealed=file+'.sealed';try{await transport.download(latest,'state',sealed,{sourceSignature:signature});await openBackgroundState(sealed,file,'breakouts',{env});}finally{fs.rmSync(sealed,{force:true});}}
 else if(fs.existsSync(file))throw Error('Unverified local quote state cannot replace retained history');
 local=localBreakouts(file,{env,...localOptions});local.primary.config('upstox-inventory');
 const minute=breakoutMinuteJournal(local,{env,fetcher,recipient,out:path.join(out,'minutes'),transportOptions,now:localOptions.now||Date.now});
 try{
  if(!latest){
   if(!legacyClient)throw Error('Retained quote source unavailable');
   for(const [part,tables,keys] of [['capture',BREAKOUT_TABLES,['breakout-timer']],['primary',['upstox_config'],['upstox-minute-timer']]]){
    const copied=await copyBackgroundStore(local,input=>legacyClient({...input,part}),{tables,keys,onProgress:progress=>console.log('Retained breakout transfer:',part,JSON.stringify(progress))});
    console.log('Verified retained breakout transfer:',part,JSON.stringify(copied.tables));
   }
  }
  if(env.BREAKOUT_LIVE_RUNTIME==='github')await minute.restore();
  if(local.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Retained quote database invalid');
 }catch(error){await local.close();throw error;}
 async function publish(){
  const backup=path.join(out,'checkpoint.sqlite'),state=path.join(out,'state.bin'),views=path.join(out,'views.gz');fs.rmSync(backup,{force:true});
  await local.checkpoint(backup);
  // Normalization/compression must never run on the minute collector's event loop.
  const prepared=await prepareBreakoutPublication({backup,out,env,recipient,repo:transport.repo,signature,at:localOptions.now?.()??Date.now()});
  const saved=await transport.publish({cycle:++cycle,state,views,sourceSignature:signature});
  minute.acknowledgeFallback(prepared.fallback,prepared.schedule);
  return saved;
 }
 return {...local,publish,...(env.BREAKOUT_LIVE_RUNTIME==='github'?{publishLive:minute.publish}:{})};
}
