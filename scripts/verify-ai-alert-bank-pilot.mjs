#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildBankPilot, bankPilotFirstDay, bankPilotMarkdown, bankingTopic } from '../public/js/data/ai-alert-bank-pilot.js';
import { bankPilotMarkup } from '../public/js/ui/ai-alert-bank-pilot.js';
import { ATTRIBUTION_VERSION } from '../public/js/data/company-news-attribution.js';
import { aiPoolKeep, compactAiEvent } from '../public/js/data/alert-pool-format.js';
const universe = [{ ticker:'J&KBANK', name:'J & K Bank', industry:'Banks' },
  { ticker:'HDFCBANK', name:'HDFC Bank', industry:'Banks' }, { ticker:'SBIN', name:'SBI', industry:'Banks' },
  { ticker:'KOTAKBANK', name:'Kotak Mah. Bank', industry:'Banks' },
  { ticker:'FINANCE', name:'Finance Company', industry:'Capital Markets', sector:'Financial Services' }];
const event = (id, extra = {}) => ({ id, day:'2026-11-02', feed:'market-news', headline:'RBI updates bank liquidity rules',
  url:`https://example.test/${id}`, detail:'', importance:'low', direction:'neutral', ...extra });
const confirmed = { version:ATTRIBUTION_VERSION, status:'confirmed' };
const company = event('company', { ticker:'J&KBANK', feed:'news', headline:'J&K Bank reports results', attribution:confirmed });
const peer = event('peer', { ticker:'HDFCBANK', feed:'news', headline:'HDFC Bank deposit growth rises', attribution:confirmed });
const sector = event('industry');
const feeds = [{ id:'news', label:'Company news', status:'failed', reachesToday:false, asOf:'2026-11-02T04:00:00Z', note:'One company query failed' },
  { id:'market-news', status:'ok', reachesToday:true, asOf:'2026-11-02T05:00:00Z' }];
const report = { scope:'universe', day:'2026-11-02', pending:0, feeds, events:[company,peer,sector,
  event('boundary', {day:'2026-10-27'}), event('old', {day:'2026-10-26'}), event('future', {day:'2026-11-03'}),
  event('undated',{day:null}), event('bad-date',{day:'2026-02-30'}), event('private',{familyPrivate:true}),
  event('private-flag',{private:true}), event('portfolio-only',{portfolioOnly:true}),
  event('wrong-industry',{ticker:'FINANCE',feed:'announcements',headline:'Capital raising'}),
  event('unsafe',{headline:'Bank lending rules',url:'javascript:alert(1)'}),
  event('alias',{headline:'Kotak Bank reports growth'}), event('unassigned-anchor',{headline:'Jammu and Kashmir Bank signs MoU'}),
  event('misattributed-peer',{ticker:'FINANCE',feed:'news',headline:'State Bank of India files a presentation',attribution:{version:ATTRIBUTION_VERSION,status:'uncertain'}}),
] };
assert.equal(bankPilotFirstDay('2026-11-02'),'2026-10-27');
assert.equal(bankPilotFirstDay('2027-01-02'),'2026-12-27');
assert.equal(bankPilotFirstDay('2026-02-30'),null);
assert.equal(buildBankPilot({...report,scope:'portfolio'},universe),null);
assert.equal(buildBankPilot({...report,scope:'watchlist'},universe),null);
const uncertainPeer=event('pool-peer',{day:'2026-10-27',feed:'news',ticker:'FINANCE',headline:'State Bank of India files a presentation',storyText:'State Bank of India bank news',attribution:{version:ATTRIBUTION_VERSION,status:'uncertain'}});
assert(aiPoolKeep(uncertainPeer,report.day),'published AI pool must retain the pilot’s peer-misattributed source news');
assert.equal(compactAiEvent('news',uncertainPeer).storyText,uncertainPeer.storyText);
assert(!aiPoolKeep({...uncertainPeer,day:'2026-10-26'},report.day),'the additional transport window is bounded to the pilot');
const pilot = buildBankPilot(report,universe);
assert.deepEqual(pilot.peers.map(row=>row.ticker),['HDFCBANK','SBIN','KOTAKBANK']);
assert.deepEqual(pilot.groups.company.map(row=>row.event.id).sort(),['company','unassigned-anchor']);
assert.deepEqual(pilot.groups.peers.map(row=>row.event.id).sort(),['alias','misattributed-peer','peer']);
assert.deepEqual(pilot.groups.industry.map(row=>row.event.id).sort(),['boundary','industry','unsafe']);
assert.equal(pilot.groups.industry.find(row=>row.event.id==='unsafe').url,null);
assert.equal(pilot.undated,2);
assert(pilot.feeds.some(feed=>feed.status==='failed'&&feed.asOf==='2026-11-02T04:00:00Z'));
assert.equal(buildBankPilot(report,[]).metadataUnavailable,true);
for(const headline of ['Trump banks on a rally','Goldman Sachs raises oil price forecasts','China stocks rise as banks rally','World Bank approves a climate project','River bank collapses'])
  assert.equal(bankingTopic({headline}),null,headline);
for(const headline of ['RBI updates liquidity rules','Banks report strong deposit growth','Indian banking sector faces higher credit costs'])
  assert(bankingTopic({headline}),headline);
const central=buildBankPilot({...report,events:[event('central',{headline:'Central bank considers changes to banking policy'})]},
  [...universe,{ticker:'CENTRALBK',name:'Central Bank',industry:'Banks'}]);
assert.equal(central.groups.peers.length,0,'a generic central bank mention is not Central Bank of India');
const syndicated = buildBankPilot({...report,events:[sector,{...sector,id:'duplicate',feed:'news',url:sector.url+'?utm_source=feed'},
  {...sector,id:'correction',headline:sector.headline+' corrected'}]},universe);
assert.equal(syndicated.groups.industry.length,2,'delivery copies combine, distinct headline corrections survive');
assert.deepEqual(syndicated.groups.industry.find(row=>row.event.id==='industry').eventIds,['industry','duplicate']);
const many = buildBankPilot({...report,events:Array.from({length:70},(_,i)=>event('sector-'+i))},universe);
const markdown=bankPilotMarkdown(many);
assert.equal(many.groups.industry.length,70);
for(let i=0;i<70;i++)assert(markdown.includes(`https://example.test/sector-${i})`),'every offscreen record exports');
assert(markdown.includes('Current factual AI summary prompt'));
assert(markdown.includes('Current story grouping prompt'));
assert(markdown.includes('without an additional model call'));
const html=bankPilotMarkup({...report,events:[event('xss',{headline:'RBI <script>alert(1)</script>'})]},universe);
assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('Partial or stale'));
assert.equal(bankPilotMarkup({...report,scope:'portfolio'},universe),'');
console.log('PASS: Universe-only bank pilot, exact bank peer set and aliases, companyless RBI news, IST boundaries, source failures, safe links, lossless dedupe/corrections and complete exports.');

globalThis.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
const {rankReport,mergePartialReport,narrowReport,withPositionSnapshot}=await import('../public/js/data/ai-alerts.js');
const options={holdings:[],insightCompanies:[]};
const ranked=rankReport({...report,events:[company,sector]},options);
assert(ranked.pilotEvents.some(e=>e.id===sector.id),'companyless news reaches pilot even though it cannot open a ranked card');
const baseline=rankReport({...report,events:[company]},options);
assert.deepEqual(ranked.allCards.map(c=>[c.key,c.score]),baseline.allCards.map(c=>[c.key,c.score]),'industry context cannot change priority');
const next=rankReport({...report,pending:1,feeds:feeds.map(f=>({...f,status:'pending'})),events:[{...company,headline:'J&K Bank corrected results'}]},options);
const merged=mergePartialReport(ranked,next);
assert(merged.pilotEvents.some(e=>e.id==='industry'),'unfinished refresh retains companyless context');
assert.equal(merged.pilotEvents.find(e=>e.id==='company').headline,'J&K Bank corrected results');
const complete=rankReport({...report,feeds:feeds.map(f=>({...f,status:'ok'})),events:[company]},options);
assert(!mergePartialReport(ranked,complete).pilotEvents.some(e=>e.id==='industry'),'completed source can supersede context');
assert.equal(narrowReport(ranked,'portfolio',options).pilotEvents.length,0);
assert.equal(withPositionSnapshot(ranked,{holdings:[],sizes:{complete:false}}).pilotEvents,ranked.pilotEvents);
const rollover=rankReport({...report,day:'2026-11-03',events:[event('aged',{day:'2026-10-27'}),sector]},options);
assert(!rollover.pilotEvents.some(e=>e.id==='aged'),'the pilot re-ages independently of the 14-day company ranking');
console.log('PASS: real ranking integration, unchanged company priority, pending/failure retention, correction precedence, scope narrowing and day rollover.');
