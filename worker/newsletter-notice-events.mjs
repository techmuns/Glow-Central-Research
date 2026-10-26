// Explicit saved notice fields, shared by event identity and the concise reading.
import { eventDate, eventDates } from './newsletter-event-identity.mjs';
const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
export const administrativeNoticeFact = fact => {
  const value=clean(fact.value);
  if(fact.field==='event')return false;
  if(fact.field==='amount'||/\b(?:acquisition|buyback|merger|fundraising|stake|contract|profit|revenue|default|penalty|resignation|INR|USD|EUR|crore|million|billion|subject to)\b|₹/i.test(value))return false;
  if(fact.field==='ownership'&&/\b(?:shares?|stake|ownership|holding|held|acquired|sold)\b/i.test(value))return false;
  if(fact.field==='conditions'&&/^Trading window (?:closure|closed|will be closed|remains closed|to remain closed)\b/i.test(value))return true;
  if(fact.field==='counterparty')return /^(?:Recipients? of (?:the )?intimation\b|(?:Filed with|Addressed to) (?:National Stock Exchange|BSE|NSE)\b|BSE Limited \(recipient of intimation\))/i.test(value);
  if(fact.field==='ownership')return /^Scrip Code and ISIN identifiers\b/i.test(value);
  if(fact.field==='date')return /^Call timing also noted in other time zones[.!]?$/i.test(value);
  return fact.field==='conditions'&&(/^(?:Call proceedings (?:will be )?recorded\b|Disclosures on stock exchanges including invite|Call accessible via universal dial-in and international toll-free numbers)/i.test(value)||
    /^Disclosure made pursuant to Regulation \d+ of SEBI LODR Regulations,? \d{4}[.!]?$/i.test(value));
};
export function noticeTags(item) {
  const tags=new Map();
  if(item.content?.state!=='ready'||item.content.format!=='xbrl')return tags;
  for(const fact of item.content.facts||[]) {
    const tag=String(fact.location||'').split('/').at(-1),value=clean(fact.value);
    if(tags.has(tag)&&tags.get(tag)!==value)return new Map();
    tags.set(tag,value);
  }
  return tags;
}
const substantive=facts=>facts.filter(f=>['event','date','status','conditions','amount','ownership','counterparty'].includes(f.field)&&!administrativeNoticeFact(f));
export function readBoardNotice(item) {
  if(item.kind!=='filing'||item.content?.state!=='ready'||item.content.format==='xbrl')return null;
  const facts=substantive(item.content.facts||[]),events=facts.filter(f=>f.field==='event').map(f=>clean(f.value));
  const agendas=events.map(value=>/^Board meeting scheduled to consider(?: and approve)?\s+(.+?)[.!]?$/i.exec(value)?.[1]);
  if(!agendas.length||agendas.some(value=>!value))return null;
  const meetingDates=facts.filter(f=>f.field==='date'&&!/^Letter date:/i.test(clean(f.value)));
  if(meetingDates.some(f=>!/^Board meeting date:/i.test(clean(f.value))))return null;
  const dates=meetingDates.map(f=>eventDate(clean(f.value).replace(/^Board meeting date:\s*/i,'')));
  if(!dates.length||dates.some(date=>!date||date!==dates[0]))return null;
  if(facts.some(f=>f.field==='status'&&!/^(?:Proposed(?:\/scheduled)?|Scheduled)(?: for board consideration)?(?:, not yet approved)?[.!]?$/i.test(clean(f.value))))return null;
  return {date:dates[0],purpose:[...new Set(agendas)].join(' and '),extras:facts.filter(f=>['amount','conditions','ownership','counterparty'].includes(f.field))};
}
const callClock=value=>{
  const clocks=[...String(value||'').matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?|\b(\d{1,2}):(\d{2})(?::(\d{2}))?/ig)];
  if(clocks.length!==1)return null;
  const clock=clocks[0];
  let hour=Number(clock[1]||clock[4]),minute=Number(clock[2]||clock[5]||0);
  if(minute>59||hour>(clock[3]?12:23)||clock[3]&&hour<1||Number(clock[6]||0)!==0)return null;
  if(clock[3])hour=hour%12+(clock[3].toLowerCase()==='p'?12:0);
  return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
};
export function scheduledEarningsCall(item) {
  if(item.kind!=='filing'||item.content?.state!=='ready')return null;
  const tags=noticeTags(item),facts=substantive(item.content.facts||[]);
  let date,clock,period,reading,proposed=false,zone;
  if(item.content.format==='xbrl') {
    if(tags.get('TypeOfAnnouncement')!=='New'||tags.get('StageOfMeetingOrCallOrConferenceOrEvent')!=='Intimation'||tags.get('TypeOfMeetingForWhichIntimationIsGiven')!=='Earning/Quarterly Calls')return null;
    if(facts.some(f=>['amount','ownership','conditions','counterparty','event','status'].includes(f.field)))return null;
    const agenda=tags.get('AgendaOrReasonForMeetingOrCallOrConferenceOrEventForIntimation');
    if(agenda&&!/^Discuss the Unaudited Financial Results for Q[1-4]-FY\d{2,4}$/i.test(agenda))return null;
    date=eventDate(tags.get('DateOfMeetingOrCallOrConferenceOrEventForIntimation'));
    clock=callClock(tags.get('TimeOfCommencementOfMeetingOrCallOrConferenceOrEventForIntimation'));
    const name=tags.get('NameOfMeetingOrCallOrConferenceOrEventForIntimation')||'';
    if(!/^(?:Q[1-4](?:\/H[12])?[ -]*FY\d{2,4} )?Earnings Call$/i.test(name))return null;
    period=/Q[1-4](?:\/H[12])?[ -]*FY\d{2,4}/i.exec(name)?.[0];
    reading=`${name}: ${date} at ${clock} (timezone not stated in the captured fields)`;
  } else {
    const events=facts.filter(f=>f.field==='event').map(f=>clean(f.value));
    if(!events.length||events.some(value=>!(/^(?:Intimation|Invitation|Notice)(?: of| to)? (?:Q[1-4]\s*FY\s*\d{2,4}\s+)?(?:Earnings? (?:Conference )?Call|Conference Call|Analysts? Call)[.!]?$/i.test(value)||
      /^Intimation of proposed schedule of Earnings Conference Call for Investor\(s\)\/Analyst\(s\) under Regulation 30 of SEBI LODR Regulations, 2015$/i.test(value)||
      /^Conference call scheduled to discuss Unaudited Financial Results for Q[1-4]-FY\d{2,4}$/i.test(value)||/^Management representatives named for the call[.!]?$/i.test(value))))return null;
    if(facts.some(f=>['amount','ownership','conditions'].includes(f.field)))return null;
    if(facts.filter(f=>f.field==='counterparty').some(f=>!(/\b(?:organizing|hosting|inviting)\b.*\bcall\b|^(?:Speaker for the call|Call leaders):/i.test(f.value))))return null;
    if(facts.filter(f=>f.field==='status').some(f=>!/^Conference call scheduled(?: \(proposed\/upcoming event, not yet completed\))?[.!]?$|^(?:Proposed|Scheduled)(?:\/upcoming)?(?: event)?(?:, not yet completed)?[.!]?$|^Schedule is proposed and subject to change$/i.test(clean(f.value))))return null;
    const calls=facts.filter(f=>f.field==='date'&&/\b(?:conference|earnings?|analyst) call (?:is )?scheduled (?:for|on)\b/i.test(f.value));
    if(calls.length!==1||facts.some(f=>f.field==='date'&&f!==calls[0]&&!/^Letter(?: dated| date:)/i.test(clean(f.value))))return null;
    const dates=eventDates(calls[0].value);if(!dates.length||dates.some(d=>!d||d!==dates[0]))return null;
    date=dates[0];clock=callClock(calls[0].value);zone=/\b(IST|UTC|GMT|EST|EDT|CST|CDT|PST|PDT)\b/i.exec(calls[0].value)?.[1]?.toUpperCase();
    period=/\bQ[1-4][ -]*FY\s*\d{2,4}\b/i.exec(events.join(' '))?.[0];
    proposed=facts.some(f=>f.field==='status'&&/subject to change/i.test(f.value));
    reading=[period?period.replace(/[ -]/g,'')+':':null,clean(calls[0].value),proposed?'(proposed; subject to change)':null].filter(Boolean).join(' ');
  }
  if(!date||!clock||reading.length>400)return null;
  const p=period?/(Q[1-4])(?:\/H[12])?[ -]*FY\s*(\d{2,4})/i.exec(period):null;
  return {date,clock,zone,period:p?`${p[1].toUpperCase()}FY${p[2].slice(-2)}`:null,reading,proposed};
}
export function sameScheduledEarningsCall(a,b) {
  if(a.ticker!==b.ticker||!!a.related!==!!b.related||!Number.isFinite(a.at)||!Number.isFinite(b.at)||Math.abs(a.at-b.at)>3600000)return false;
  const x=scheduledEarningsCall(a),y=scheduledEarningsCall(b);
  return !!(x&&y&&x.date===y.date&&x.clock===y.clock&&(!x.zone||!y.zone||x.zone===y.zone)&&(!x.period||!y.period||x.period===y.period));
}
export function consolidatedEarningsCallNote(items) {
  const ready=items.filter(s=>s.content?.state==='ready');
  if(!ready.length||!ready.every(s=>scheduledEarningsCall(s))||!ready.every(a=>ready.every(b=>sameScheduledEarningsCall(a,b))))return null;
  const calls=ready.map(scheduledEarningsCall).sort((a,b)=>Number(!!b.zone)-Number(!!a.zone)||Number(b.proposed)-Number(a.proposed));
  let note=calls[0].reading;
  if(calls.some(c=>c.proposed)&&!calls[0].proposed)note+=' (proposed; subject to change)';
  return note.length<=500?note:null;
}
