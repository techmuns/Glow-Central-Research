// Replay the customer's 26 October failures without network, model credits or email delivery.
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pdfFixture } from './verify-newsletter-pdf.mjs';
import { briefStats,briefStoryKeys,renderBriefHtml,aiItemsFor,clusterStories,NEWSLETTER_STYLE } from '../worker/newsletter-brief.mjs';
import { editorialEvents,referenceReason,annotateEditorialHistory,EDITORIAL_EMAIL_PARTS } from '../worker/newsletter-editorial.mjs';
import { renderInvestorEmails } from '../worker/newsletter-email.mjs';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';
import { NewsletterContentStore } from '../worker/newsletter-content-store.mjs';
import { NewsletterStore } from '../worker/newsletter-store.mjs';
import { fetchContent,readDocumentFacts } from '../worker/newsletter-content.mjs';
import { reviewNewsEvents } from '../worker/newsletter-events.mjs';

const excluded=[
 ['INDIANB','South Indian Bank Leveraging Digital Technology For Biz Growth'],
 ['INDIANB','HDFC Bank Q2 Results Good Or Bad: Largest Indian Bank Earns Rs 19,510 Crore Profit'],
 ['LUPIN',"'Nobody Wants This' Season 3 and 'Lupin' Lead Netflix UK's 43 New Releases This Week"],
 ['CUB','GUEST APPEARANCE: Time for Town-City union'],
 ['MOTILALOFS','Upgrade to Buy BSE Ltd For Target Rs.4,000 by Motilal Oswal Financial Services Ltd'],
 ['LXCHEM','Laxmi Organic Industries Ltd. Estimates - NSE:LXCHEM'],
 ['SAGILITY','SAGILITY LIMITED Option Chain'],
];
for(const [ticker,headline] of excluded)assert(referenceReason({ticker,headline,kind:'news'}),headline);
for(const [ticker,headline] of [
 ['INDIANB','ICICI Bank and Indian Bank increase FD interest rates'],
 ['LUPIN',"Lupin's Goa facility receives Form-483 with one observation from U.S. FDA"],
 ['MOTILALOFS','Motilal Oswal Financial Services reports its quarterly results'],
 ['LXCHEM','Laxmi Organic analyst profit estimates revised upward - NSE:LXCHEM'],
])assert.equal(referenceReason({ticker,headline,kind:'news'}),null,headline);

const brief=pdfFixture(),at=brief.at;
brief.book.listed=170;brief.calendar.rows=brief.calendar.rows.slice(0,3);brief.performance.rows=brief.performance.rows.slice(0,5);
brief.news.groups=excluded.map(([ticker,headline],i)=>({ticker,company:ticker,items:[{headline,at:at-i*1000,url:`https://fixture.test/reference/${i}`,publisher:'Captured publisher',keywords:[],keys:[`reference:${i}`]}]}));
const official=brief.announcements.groups[0].items[0];
official.keys=['official:NSE'];official.content={state:'ready',hash:'same-source-bytes',version:1,facts:[
 {field:'event',value:'A customer contract was approved subject to final conditions',quote:'A customer contract was approved subject to final conditions',location:'page 1'},
 {field:'amount',value:'INR 100 crore',quote:'INR 100 crore',location:'page 1'},
]};
brief.announcements.groups[0].items.push({...structuredClone(official),at:at-2*86400000,keys:['official:BSE'],url:'https://fixture.test/cross-exchange-copy.pdf'});
let stats=briefStats(brief),reading=editorialEvents(brief,stats.companies);
assert.equal(reading.events.length,1,'The economic disclosure appears once, even if its exchange copy arrives two days later');
assert.equal(reading.events[0].sourceCount,2);assert.equal(reading.reference.length,excluded.length);
brief.ai={ok:true,items:{[reading.events[0].id]:{summary:'A customer contract worth INR 100 crore was approved, subject to final conditions.',impact:'It could support future revenue if the conditions are satisfied.',unknowns:'Completion is conditional.'}}};
const pdfUrl='https://example.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001';
const options={dashboardUrl:'https://example.test',brand:'Glow Ventures',pdfUrl};
const messages=renderInvestorEmails(brief,options);
assert.equal(messages.length,1);assert(messages[0].html.includes('INR 100 crore'));assert(messages[0].html.includes('Watch next:'));
const inbox=messages[0].html;
for(const token of [NEWSLETTER_STYLE.CREAM,NEWSLETTER_STYLE.INK,NEWSLETTER_STYLE.GOLD,NEWSLETTER_STYLE.GOLD_LIGHT,NEWSLETTER_STYLE.SERIF])assert(inbox.includes(token),'The original newsletter palette and serif design must remain');
assert(inbox.includes('border-top:3px double')&&inbox.includes('max-width:640px')&&inbox.includes('Evening Portfolio Brief'),'Retain the original masthead, paper width and edition format');
assert(!inbox.includes(official.headline),'A grounded summary replaces the repetitive source headline in the inbox');
assert(!inbox.includes('Descriptions are abbreviated')&&!inbox.includes('reference/calendar groups'),'Detailed diagnostics belong in the complete report');
const incomplete=structuredClone(brief);incomplete.announcements.nseHistory={ok:true,missingDays:['2026-10-06']};
assert(renderInvestorEmails(incomplete,options)[0].html.includes('Partial coverage: NSE'),'A successful subset cannot conceal missing source days');
for(const [,headline]of excluded)assert(!messages[0].html.includes(headline),'Reference records must not become investor developments');
assert.deepEqual(messages.flatMap(m=>m.keys).sort(),briefStoryKeys(brief).sort(),'The verified report retains every source identity, including reference records');
const before=JSON.stringify(brief),pdf=Buffer.from(renderBriefPdf(brief)).toString('latin1');
assert.equal(JSON.stringify(brief),before,'Reading and rendering never mutate the retained facts');
for(let i=0;i<excluded.length;i++)assert(pdf.includes(`https://fixture.test/reference/${i}`));
assert(pdf.includes('https://fixture.test/cross-exchange-copy.pdf'));

// Same publisher / different ingestion routes is one copy; a real revised amount stays separate.
const story={kind:'news',ticker:'TEST',source:'NDTV Profit',headline:'Company secures INR 360 crore from anchor investors ahead of IPO',at,score:1};
assert.equal(clusterStories([story,{...story,url:'https://fixture.test/another-route'}]).length,1);
assert.equal(clusterStories([story,{...story,headline:story.headline.replace('360','460')}]).length,2);
const pending=Array.from({length:40},(_,i)=>({id:`pending${i}`,kind:'story',main:{kind:'filing',content:{state:'pending'}},others:[]}));
const ready={id:'readable41',kind:'story',main:{kind:'filing',content:official.content},others:[]};
assert.deepEqual(aiItemsFor([{company:'Test',ticker:'TEST',clusters:[...pending,ready]}],new Map(),{readableOnly:true}).map(i=>i.id),['readable41'],'Pending leaders cannot consume the summary allowance');

const db=new DatabaseSync(':memory:');
const storage={sql:{exec:(sql,...args)=>{const rows=db.prepare(sql).all(...args);return {toArray:()=>rows};}},transactionSync:fn=>{db.exec('BEGIN');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
const store=new NewsletterStore(storage,{now:()=>at});store.init();
await annotateEditorialHistory(brief,briefStats(brief).companies,store.reportedLookup());
const records=briefStats(brief).companies.flatMap(c=>c.stories.flatMap(s=>s.keys.map(key=>({key,publishedAt:s.at}))));
store.markReported(records,'acknowledged-edition',{windowFrom:brief.window.from});
const restarted=new NewsletterStore(storage,{now:()=>at+3600000});
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).repeated.length,1,'An acknowledged event stays covered after restart');
brief.news.groups.push({ticker:brief.announcements.groups[0].ticker,company:brief.announcements.groups[0].company,items:[{headline:'Customer contract',at,keys:['new-unknown-source'],url:'https://fixture.test/new-unknown',publisher:'New publisher',keywords:[]}]});
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).events.length,1,'A known member cannot suppress unknown new evidence without an event identity');
brief.news.groups.pop();
const sameTitle=structuredClone(brief);sameTitle.news.groups=[];
sameTitle.announcements.groups[0].items=[{...structuredClone(official),headline:'Lupin receives approval from the United States Food and Drug Administration',keys:['new-drug-approval'],content:{state:'pending'}}];
await annotateEditorialHistory(sameTitle,briefStats(sameTitle).companies,{has:()=>true,at:()=>at});
assert.equal(editorialEvents(sameTitle,briefStats(sameTitle).companies).events.length,1,'A later unread approval cannot be hidden just because an earlier event had the same specific-looking headline');
assert.deepEqual(sameTitle.announcements.groups[0].items[0].keys,['new-drug-approval'],'Headlines alone never supply durable delivered-version aliases');
for(const row of brief.announcements.groups[0].items){row.content.hash='corrected-document';row.content.facts[1].value='INR 110 crore';}
await annotateEditorialHistory(brief,briefStats(brief).companies,restarted.reportedLookup());
assert.equal(editorialEvents(brief,briefStats(brief).companies).events.length,1,'A changed document is a new material version');
const aged=new NewsletterStore(storage,{now:()=>at+20*86400000});
aged.markReported([{key:'recent-transport',publishedAt:at+20*86400000}],'later-edition');
assert.equal(aged.reportedLookup().has('official:NSE'),false,'Ordinary transport pruning remains bounded');
assert(aged.reportedLookup().has(records.find(r=>r.key.startsWith('newsletter-event:')).key),'Event versions survive transport/log retention');

// Migrate the actual old queue schema. Fresh risk disclosures lead; the oldest pending source
// still receives a reserved slot. No historical job or completed extraction is discarded.
db.exec("CREATE TABLE newsletter_content (id TEXT PRIMARY KEY,input TEXT NOT NULL,state TEXT NOT NULL,first_seen INTEGER NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,result TEXT)");
const queue=new NewsletterContentStore(storage);
const old={id:'a'.repeat(64),ticker:'OLD',kind:'news',headline:'Old retained company source',at:at-86400000,url:'https://fixture.test/old'};
queue.enqueue([old],at-86400000);
const fresh=Array.from({length:7},(_,i)=>({id:String(i+1).repeat(64),ticker:`NEW${i}`,kind:'filing',headline:'FDA inspection disclosure',at,url:`https://nsearchives.nseindia.com/fresh-${i}.pdf`}));
queue.enqueue(fresh,at);
assert.equal(queue.claim(at).item.kind,'filing');
assert.equal(queue.claim(at,[],{oldest:true}).item.ticker,'OLD');
assert.equal(queue.status().pending,8,'Claims preserve the complete pending queue');
db.prepare('UPDATE newsletter_content SET next_at=?').run(at+86400000);
queue.enqueue([{...old,id:'c'.repeat(64),ticker:'STALE_RISK',kind:'filing',headline:'FDA warning letter',at:at-10*86400000},
 {...old,id:'d'.repeat(64),ticker:'CURRENT',kind:'filing',headline:'Corporate announcement',at}],at);
assert.equal(queue.claim(at).item.ticker,'CURRENT','A newly discovered old risk disclosure cannot crowd out a current filing');
const legacyLink={...old,id:'b'.repeat(64),url:'https://news.google.com/rss/articles/opaque'};
db.prepare("INSERT INTO newsletter_content(id,input,state,first_seen,next_at,result) VALUES (?,?,'pending',?,?,?)").run(legacyLink.id,JSON.stringify(legacyLink),at-86400000,at+86400000,JSON.stringify({state:'pending',reason:'unsupported-source'}));
queue.enqueue([legacyLink],at);
assert.equal(db.prepare('SELECT next_at FROM newsletter_content WHERE id=?').get(legacyLink.id).next_at,at,'A newly supported legacy link receives one normal retry instead of waiting another day');
db.prepare('UPDATE newsletter_content SET next_at=? WHERE id=?').run(at+86400000,legacyLink.id);
queue.enqueue([legacyLink],at);
assert.equal(db.prepare('SELECT next_at FROM newsletter_content WHERE id=?').get(legacyLink.id).next_at,at+86400000,'The link-policy upgrade cannot reset backoff on every discovery');
db.close();

// Free discovery wrappers may resolve only to explicitly supported public publishers.
const publisher='https://www.livemint.com/companies/fixture-report.html';
const wrapper='https://news.google.com/rss/articles/'+btoa('\x08\x13'+publisher+'\x00').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
let requests=0;
const resolved=await fetchContent({kind:'news',url:wrapper},async(url,options)=>{
 requests++;assert.equal(url,publisher);assert.equal(options.headers.authorization,undefined);
 return new Response('<article>Literal publisher content</article>',{headers:{'content-type':'text/html'}});
});
assert.equal(requests,1);assert.equal(resolved.url,publisher);
const opaque='https://news.google.com/rss/articles/opaque';
const redirected=await fetchContent({kind:'news',url:opaque},async url=>url===opaque?new Response(null,{status:302,headers:{location:publisher}}):new Response('Publisher body'));
assert.equal(redirected.url,publisher);
await assert.rejects(fetchContent({kind:'news',url:opaque},async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}})),/unsupported-redirect/);
await assert.rejects(fetchContent({kind:'news',url:opaque},async()=>new Response('<article>A Google interstitial is not the publisher article</article>')),/source-link-unresolved/);
const cached=await readDocumentFacts({item:{kind:'filing',ticker:'TEST',url:'https://www.bseindia.com/copy.pdf'},env:{},fetcher:async()=>new Response('%PDF-1.4 fixture'),cachedDocument:()=>({state:'ready',version:1,facts:official.content.facts})});
assert.equal(cached.state,'ready');assert.equal(cached.sourceUrl,'https://www.bseindia.com/copy.pdf');

let groupingCalls=0;
const manyCompanies={groups:Array.from({length:4},(_,i)=>({ticker:`ISSUER${i}`,company:`Issuer ${i}`,items:Array.from({length:60},(_,j)=>({headline:`Distinct business disclosure ${j}`,at,publisher:'Fixture',url:`https://fixture.test/source/${'x'.repeat(2000)}`,content:{facts:[{field:'event',value:'Source reading retained outside the grouping prompt'}]}}))}))};
const grouped=await reviewNewsEvents({news:manyCompanies,env:{CLAUDE_KEY:'ABSKfixture-only'},fetcher:async(_url,init)=>{
 groupingCalls++;const reports=JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS;
 return Response.json({content:[{type:'text',text:JSON.stringify(reports.map(r=>[r.id]))}]});
}});
assert.equal(grouped.reviewed,240);assert.equal(groupingCalls,4);assert.equal(grouped.partial,false,'A shared 80-report ceiling cannot exclude every later company');
let packedCalls=0;
const smallCompanies={groups:Array.from({length:16},(_,i)=>({ticker:`SMALL${i}`,company:`Small issuer ${i}`,items:Array.from({length:5},(_,j)=>({headline:`Distinct company disclosure ${j}`,at,publisher:'Fixture'}))}))};
const packed=await reviewNewsEvents({news:smallCompanies,env:{CLAUDE_KEY:'ABSKfixture-only'},fetcher:async(_url,init)=>{
 packedCalls++;const reports=JSON.parse(JSON.parse(init.body).messages[0].content).REPORTS;
 return Response.json({content:[{type:'text',text:JSON.stringify(reports.map(r=>[r.id]))}]});
}});
assert.equal(packed.reviewed,80);assert.equal(packedCalls,1,'Small companies share the existing request capacity rather than consuming one call each');

// A busy edition has a fixed inbox budget, all distinct developments, no repeated raw snippets,
// and stable rendering for every personalised footer. HTML is inert and byte bounded.
const busy=structuredClone(brief);busy.announcements.groups[0].items=Array.from({length:180},(_,i)=>({...structuredClone(official),
 headline:`Distinct contract ${i} with Customer ${i}`,url:`https://fixture.test/material/${i}`,keys:[`material:${i}`],content:{state:'pending'},editorialReported:false,at:at-i*1000}));
busy.ai={ok:false,items:{}};
const digest=renderInvestorEmails(busy,options);
assert(digest.length<=EDITORIAL_EMAIL_PARTS);assert(digest.every(m=>m.bytes<=90000));
assert.deepEqual(digest.flatMap(m=>m.part.eventIds).sort(),editorialEvents(busy,briefStats(busy).companies).events.map(e=>e.id).sort());
for(const message of digest)assert(message.html.includes('Document unread; facts unverified'));
const crowded=structuredClone(busy);
crowded.announcements.groups=Array.from({length:320},(_,i)=>({ticker:`CROWDED${i}`,company:`Material Issuer ${i}`,items:[{...structuredClone(busy.announcements.groups[0].items[0]),headline:`Distinct contract ${i} with Customer ${i}`,keys:[`crowded:${i}`],url:`https://fixture.test/material/${i}?discovery=${'x'.repeat(1000)}`}]}));
const compactDigest=renderInvestorEmails(crowded,options);
assert(compactDigest.length<=3&&compactDigest.every(m=>m.part.compact&&m.bytes<=90000),'A busy multi-company edition must use the genuinely compact branded rows');
assert.equal(compactDigest.flatMap(m=>m.part.eventIds).length,320);
assert.deepEqual(compactDigest.flatMap(m=>m.keys).sort(),briefStoryKeys(crowded).sort());
assert.throws(()=>renderInvestorEmails(brief,{...options,pdfUrl:'https://example.test/api/newsletter/preview'}),/immutable/);
if(process.env.NEWSLETTER_INVESTOR_OUTPUT){
 const dir=process.env.NEWSLETTER_INVESTOR_OUTPUT;mkdirSync(dir,{recursive:true});
 writeFileSync(`${dir}/investor-email.html`,messages[0].html);
 writeFileSync(`${dir}/investor-brief.pdf`,renderBriefPdf(brief));
 writeFileSync(`${dir}/busy-email.html`,digest[0].html);
}
console.log(`PASS investor replay: 7 actual attribution/noise cases, lossless source register, document copies, corrections, acknowledged restart, readable summary admission, queue priority/fairness, ${digest.length} email(s) for 180 distinct material disclosures`);
