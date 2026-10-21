import fs from 'node:fs';
import {privateMarketRelease} from './private-market-release.mjs';
import {validRoster} from './private-markets-intelligence.mjs';
export function glowFundRoster(managers,book,now=Date.now()) {
 if(!managers.source?.startsWith('techmuns/GlowVentures')||!managers.builtFrom||managers.builtFrom!==book.builtFrom||managers.asOf!==book.asOf||!Array.isArray(managers.managers))throw Error('Manager source mismatch');
 const rows=managers.managers,counts=managers.summary?.byKind;
 if(managers.summary?.managers!==rows.length||new Set(rows.map(m=>m.id)).size!==rows.length||rows.some(m=>!['pms','aif','mf'].includes(m.kind)))throw Error('Incomplete manager inventory');
 for(const kind of ['pms','aif','mf'])if(!Number.isSafeInteger(counts?.[kind]?.count)||counts[kind].count!==rows.filter(m=>m.kind===kind).length)throw Error('Incomplete manager inventory');
 return validRoster({ok:true,version:1,source:'GlowVentures manager statements',asOf:managers.asOf,revision:managers.builtFrom,checkedAt:new Date(now).toISOString(),funds:rows.filter(m=>m.kind==='aif').map(m=>({name:m.name,manager:m.house,asOf:m.asOf}))});
}
export async function privateMarketsSources({env=process.env,fetcher=fetch}={}) {
 const transport=privateMarketRelease({env,fetcher}),latest=await transport.latest();if(!latest)throw Error('Funding release unavailable');
 const capture=await transport.download(latest);let roster;
 try{
  const managers=JSON.parse(fs.readFileSync('public/data/managers.json','utf8')),book=JSON.parse(fs.readFileSync('public/data/book.json','utf8'));
  roster=glowFundRoster(managers,book);
 }catch{roster={ok:false,reason:'Glow invested fund statements could not be verified.'};}
 return {capture,roster};
}
