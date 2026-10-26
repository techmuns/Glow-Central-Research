// Exact readings and original links from the customer's 202-page PDF. No network,
// model requests, email or provider credentials, including Munshot stock search.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {clusterStories,briefStats,aiItemsFor} from '../worker/newsletter-brief.mjs';
import {explicitEvent,eventDate,financialPeriod} from '../worker/newsletter-event-identity.mjs';
import {scheduledBoardMeetingSummary} from '../worker/newsletter-filing-events.mjs';
import {editorialEvents,referenceReason} from '../worker/newsletter-editorial.mjs';
import {investorSourceSummary} from '../worker/newsletter-source-notes.mjs';
import {pdfFixture} from './verify-newsletter-pdf.mjs';
import {renderInvestorEmails} from '../worker/newsletter-email.mjs';
import {renderBriefPdf} from '../worker/newsletter-pdf.mjs';
const input=JSON.parse(readFileSync(new URL('./fixtures/newsletter/output-2026-10-26.json',import.meta.url)));
const tickers={'Aurobindo Pharma Ltd':'AUROPHARMA','Varroc Engineering Limited':'VARROC','Bharat Parenteral':'BPLPHARMA','Lupin Ltd':'LUPIN','Tech Mahindra Ltd':'TECHM'};
const rows=input.events.map((x,i)=>{
 const clock=/(\d+) Oct, (\d\d):(\d\d) IST/.exec(x.status);
 return {kind:x.kind==='Corporate announcement'?'filing':'news',ticker:tickers[x.company],company:x.company,
  headline:x.description,url:x.url,at:Date.parse(`2026-10-${clock[1]}T${clock[2]}:${clock[3]}:00+05:30`),
  score:1,source:'Captured source',keys:[`pdf:${i}`],content:{state:'pending'}};
});
const company=name=>rows.filter(r=>r.company===name);
for(const name of ['Aurobindo Pharma Ltd','Varroc Engineering Limited']) {
 const notices=company(name).filter(r=>/board (?:meeting|of directors)/i.test(r.headline));
 assert.equal(notices.length,2);
 assert.equal(clusterStories(notices).length,1,`${name}: NSE/BSE date/period normalization`);
 const textNotice=notices[0],numeric={...textNotice,url:'https://fixture.test/numeric-period',headline:textNotice.headline.replace('September 2026','30/09/2026')};
 assert.equal(clusterStories([textNotice,numeric]).length,1,'Month name and quarter-end numeric date identify the same period');
 assert.equal(clusterStories([textNotice,{...numeric,headline:textNotice.headline.replace('September 2026','2026-09-30')}]).length,1,'ISO financial periods identify the same quarter');
 assert.equal(clusterStories([textNotice,{...numeric,headline:textNotice.headline.replace('September 2026','2026-06-30')}]).length,2,'Different ISO financial periods cannot merge');
 assert.equal(clusterStories([textNotice,{...numeric,headline:numeric.headline.replace('30/09/2026','30/06/2026')}]).length,2,'Different financial periods stay separate');
}
assert.equal(eventDate('31 November 2026'),null);assert.equal(eventDate('November 4, 2026'),'2026-11-04');
assert.equal(financialPeriod('30th September 2026'),'2026-09');
const b=company('Bharat Parenteral'),voting=b.filter(r=>/EGM held|Extraordinary General Meeting/i.test(r.headline));
const votingGroups=clusterStories(voting);
assert.equal(votingGroups.length,1,'The dated original, revised and scrutinizer reports share one EGM event');
assert.equal(votingGroups[0].items,5,'Every original source row survives consolidation');
assert(explicitEvent(votingGroups[0].main).revised,'The correction leads, not the superseded original');
assert.equal(new Set(votingGroups[0].documents.map(d=>d.main.url)).size,3);
assert.equal(clusterStories([...voting,{...voting[4],url:'https://fixture.test/other-egm',headline:'Voting Results of EGM held on October 24, 2026'}]).length,2);
// Source equality wins before conflicting paraphrased extraction fields.
const exact=structuredClone(voting.slice(0,2));
exact.forEach((r,i)=>r.content={state:'ready',hash:'verified-identical-bytes',facts:[{field:'conditions',value:i?'Revision only relates to shareholder classification/category, not votes cast or outcome':'Revision is limited to shareholder classification and does not change votes cast or resolution outcomes'}]});
assert.equal(clusterStories(exact).length,1);
assert.equal(clusterStories(exact)[0].documents.length,1);
const changed=structuredClone(exact[1]);changed.content.hash='new-version';changed.content.facts[0].value='Voting outcome corrected; resolution rejected';
const changedGroup=clusterStories([exact[0],changed]);assert.equal(changedGroup.length,1);
assert.equal(changedGroup[0].documents.length,2,'A correction is a retained document version, never discarded as a copy');
const lupin=company('Lupin Ltd'),inspection=lupin.filter(r=>/FDA|Form-483/.test(r.headline));
assert.equal(inspection.length,3);assert.equal(clusterStories(inspection).length,1,'Filing and publisher accounts of the Goa inspection share one event');
assert.equal(clusterStories([...inspection,{...inspection[1],url:'https://fixture.test/changed-observations',headline:inspection[1].headline.replace('one observation','two observations')}]).length,2,'A changed FDA observation count stays visible');
assert.equal(clusterStories([inspection[1],{...inspection[1],url:'https://fixture.test/other-site',headline:inspection[1].headline.replace('Goa','Nagpur')}]).length,2);
assert.equal(clusterStories([inspection[1],{...inspection[1],url:'https://fixture.test/cleared',headline:'US FDA clears Goa facility following inspection'}]).length,2,'A later regulatory clearance remains a genuine new development');
const appointments=lupin.filter(r=>/Brian Savage/.test(r.headline));assert.equal(clusterStories(appointments).length,1,'The identical person/role is one appointment');
assert.equal(clusterStories([appointments[0],{...appointments[1],headline:appointments[1].headline.replace('Brian Savage','Brian Jones')}]).length,2);
assert.equal(clusterStories([{...appointments[0],eventId:'checked-event-1'},{...appointments[1],eventId:'checked-event-2'}]).length,2,'A checked distinct news development overrides an unverified headline profile');
const tech=company('Tech Mahindra Ltd'),acquisition=tech.filter(r=>/buys Finastra suite/.test(r.headline));
assert.equal(clusterStories(acquisition).length,1,'The identical named acquisition object is not repeated by discovery route');
const partnership=tech.filter(r=>/SpaceXSI/.test(r.headline));assert.equal(clusterStories(partnership).length,1);
for(const r of tech.filter(r=>/stock price, news|slides Friday/.test(r.headline)))assert(referenceReason(r));
for(const headline of ['Smartworks Coworking Spaces Ltd Downgraded to Sell Amid Technical and Valuation Concerns','Fusion Finance Ltd Downgraded to Sell Amid Mixed Financials and Bearish Technicals','Time Technoplast Ltd. Forms Death Cross, Signalling Potential Bearish Trend','Ather Energy Share Price Today, Ather Energy Stock Price Live NSE/BSE Updates'])assert(referenceReason({kind:'news',headline}));
assert.equal(referenceReason({kind:'news',headline:'CRISIL downgraded Company credit rating following a debt default'}),null);
assert(referenceReason({kind:'news',headline:'Q2 results this week: Ather Energy, IndiGo, L&T, Paytm, Maruti, Mazagon Dock, Adani Enterprises, Vedanta, among others in focus'}),'The repeated weekly calendar roundup stays in the full source register');
assert.equal(scheduledBoardMeetingSummary(b.find(r=>/standalone and/.test(r.headline))),'Board meeting 29 Oct 2026; captured agenda is incomplete.');
const facts=[{field:'event',value:'Submission of revised voting results of EGM held on 23 October 2026, correcting shareholder categorisation error'},
 {field:'conditions',value:'Revision is limited to shareholder classification and does not change votes cast or resolution outcomes'},
 ...Array.from({length:25},(_,i)=>({field:'date',value:`Administrative date ${i}`}))];
const read={...voting[0],content:{state:'ready',hash:'verified-revision',facts}};
const concise=investorSourceSummary(read);assert(concise.length<330&&concise.includes('does not change votes cast'));
assert(!concise.includes('Administrative date'));
const brief=pdfFixture();brief.edition='morning';brief.day='2026-10-26';brief.at=Date.parse('2026-10-26T08:00:00+05:30');
brief.builtAt=Date.parse('2026-10-26T12:24:00+05:30');brief.window={from:Date.parse('2026-10-23T16:00:00+05:30'),to:brief.builtAt};brief.onDemand=true;
brief.news.groups=[];brief.announcements.groups=[{ticker:read.ticker,company:read.company,items:[read,...voting.slice(1)].map(r=>({...r,exchanges:['BSE'],keywords:[],subject:'Voting results',direction:'neutral'}))}];
brief.ai={ok:false,items:{}};
const before=JSON.stringify(brief),stats=briefStats(brief),events=editorialEvents(brief,stats.companies).events;
assert.equal(events.length,1);assert.equal(events[0].sources.length,3);
const ai=aiItemsFor(stats.companies);assert.equal(ai.length,1,'Summary writer sees one consolidated event');
assert.equal(ai[0].SOURCE_EVIDENCE.length,3,'Repeated document is supplied once to the writer, with all distinct versions retained');
const email=renderInvestorEmails(brief,{dashboardUrl:'https://fixture.test',pdfUrl:'https://fixture.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'})[0];
for(const url of events[0].sources)assert(email.html.includes(url),'Every constituent report has an exact source link in the email');
assert(!email.html.includes('Administrative date'));
assert.equal(JSON.stringify(brief),before,'Consolidation and render cannot rewrite source history');
const metadataOnly=structuredClone(brief);
metadataOnly.announcements.groups[0].items=[{...metadataOnly.announcements.groups[0].items[0],headline:'Captured corporate notice',content:{state:'ready',facts:[{field:'conditions',name:'Administrative approval field',value:'true'}]}}];
const metadataEmail=renderInvestorEmails(metadataOnly,{dashboardUrl:'https://fixture.test',pdfUrl:'https://fixture.test/api/newsletter/pdf/00000000-0000-0000-0000-000000000001'})[0].html;
assert(!metadataEmail.includes('Administrative approval field'),'No raw metadata array can become the final email fallback');
assert(metadataEmail.includes('factual summary unavailable'),'A read without a substantive event does not masquerade as source prose');
mkdirSync('.cache/newsletter-audit/full-pdf-review',{recursive:true});
writeFileSync('.cache/newsletter-audit/full-pdf-review/corrected-example.html',email.html);
writeFileSync('.cache/newsletter-audit/full-pdf-review/corrected-example.pdf',renderBriefPdf(brief));
console.log(`PASS full-output PDF: ${input.events.length} exact readings, issuer/date/period/event grouping, document-first evidence, corrections, concise prose, all report links; network/model/mail calls=0`);
