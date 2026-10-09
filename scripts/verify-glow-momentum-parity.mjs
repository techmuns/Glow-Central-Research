// Adding the scanner must not change any pre-existing daily indicator or breakout grade.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {dayMove} from './lib/yahoo.mjs';
import {completedPeriods,wilderRsiState} from './lib/momentum.mjs';
import {istDay} from '../public/js/scoring/momentum-history.js';
const previous=readFileSync(new URL('./fixtures/glow-momentum-previous-indicators.txt',import.meta.url),'utf8');
const current=readFileSync(new URL('./scrape-technicals.mjs',import.meta.url),'utf8');
const source=current.slice(current.indexOf('function computeIndicators('),current.indexOf('// ---------- NSE delivery'));
const evaluate=text=>runInNewContext(text+'\ncomputeIndicators', {dayMove,completedPeriods,wilderRsiState,istDay});
const old=evaluate(previous),next=evaluate(source);
const all=Array.from({length:2600},(_,i)=>{const close=200+i*.2+Math.sin(i/11)*8;return {date:new Date(Date.UTC(2015,0,1+i)).toISOString().slice(0,10),open:close,close,high:close+3,low:close-3,volume:1000+i%17*200};});
for(const count of [70,150,280]) {
  const bars=all.slice(-count),index=bars.map(b=>({...b,close:b.close*2}));
  const returns=index.slice(1).map((b,i)=>({date:b.date,r:b.close/index[i].close-1}));
  const before=old(bars,index,returns,index.map(b=>b.close));
  const after=next(bars,index,returns,index.map(b=>b.close),all,'2022-02-14');
  for(const field of ['sma20','sma100','above_20dma','above_50dma','above_100dma','rsi_multi','avg_volume_10d','volume_ratio_10d'])delete after[field];
  for(const field of ['state','ema12','ema26'])delete after.macd[field];
  assert.deepEqual(JSON.parse(JSON.stringify(after)),JSON.parse(JSON.stringify(before)),`${count} bars: all existing indicators/grades must remain identical`);
}
console.log('PASS Glow momentum additions preserve every existing daily field and breakout grade for new and established listings');
