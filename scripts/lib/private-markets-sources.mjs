import fs from 'node:fs';
import {privateMarketRelease} from './private-market-release.mjs';
import {validRoster} from './private-markets-intelligence.mjs';
export async function privateMarketsSources({env=process.env,fetcher=fetch}={}) {
 const transport=privateMarketRelease({env,fetcher}),latest=await transport.latest();if(!latest)throw Error('Funding release unavailable');
 const capture=await transport.download(latest);let roster;
 try{
  const managers=JSON.parse(fs.readFileSync('public/data/managers.json','utf8')),book=JSON.parse(fs.readFileSync('public/data/book.json','utf8'));
  if(!managers.source?.startsWith('techmuns/GlowVentures')||managers.builtFrom!==book.builtFrom||managers.asOf!==book.asOf||!Array.isArray(managers.managers))throw Error('Manager source mismatch');
  roster=validRoster({ok:true,version:1,source:'GlowVentures manager statements',asOf:managers.asOf,revision:managers.builtFrom,checkedAt:new Date().toISOString(),funds:managers.managers.filter(m=>m.kind==='aif').map(m=>({name:m.name,manager:m.house,asOf:m.asOf}))});
 }catch{roster={ok:false,reason:'Glow invested fund statements could not be verified.'};}
 return {capture,roster};
}
