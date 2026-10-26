// Presentation over saved source facts. Never rewrite the retained extraction or
// turn identifiers, enum values and bare XBRL booleans into an investor summary.
import { explicitEvent, eventDate, eventDates } from './newsletter-event-identity.mjs';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const material = new Set(['event','counterparty','amount','status','date','conditions','ownership']);
const administrative = fact => {
  const value=clean(fact.value);
  if(fact.field==='amount'||/\b(?:acquisition|buyback|merger|fundraising|stake|contract|profit|revenue|default|penalty|resignation|INR|USD|EUR|crore|million|billion|subject to)\b|₹/i.test(value))return false;
  if(fact.field==='ownership'&&/\b(?:shares?|stake|ownership|holding|held|acquired|sold)\b/i.test(value))return false;
  if(/^Trading window (?:closure|closed|will be closed|remains closed|to remain closed)\b/i.test(value)&&
    !/\b(?:acquisition|merger|buyback|dividend|fundraising|stake|order|contract|profit|revenue|default|penalty|resignation)\b/i.test(value))return true;
  return /^(?:Recipients? of (?:the )?intimation\b|(?:Filed with|Addressed to) (?:National Stock Exchange|BSE|NSE)\b|BSE Limited \(recipient of intimation\)|Scrip Code and ISIN identifiers\b|Call timing also noted in other time zones\b|Call proceedings (?:will be )?recorded\b|Disclosures on stock exchanges including invite)/i.test(value)||
    /^Disclosure made pursuant to Regulation \d+ of SEBI LODR Regulations,? \d{4}[.!]?$/i.test(value);
};
const dateLabel=date=>{const d=new Date(date+'T00:00:00Z');return `${d.getUTCDate()} ${months[d.getUTCMonth()].slice(0,3)} ${d.getUTCFullYear()}`;};

export function investorSourceFacts(item) {
  const facts = (item.content?.facts || []).filter(fact => material.has(fact.field) && clean(fact.value));
  if (!facts.some(fact => fact.field !== 'date')) return [];
  const order = ['event','amount','status','conditions','ownership','counterparty','date'];
  return [...facts].sort((a,b) => order.indexOf(a.field)-order.indexOf(b.field)).map(fact =>
    /^(?:true|false)$/i.test(clean(fact.value)) ? { ...fact, value: `${fact.name || fact.field}: ${/^true$/i.test(clean(fact.value)) ? 'Yes' : 'No'}` } : fact);
}

/** A reading, not a dump of 32 extraction fields. Whole supported statements only;
 * exact/contained statements collapse, while amounts and qualifications keep labels.
 * Original facts/passages are retained unchanged in the complete source register. */
export function investorSourceSummary(item) {
  if(!['ready','partial'].includes(item.content?.state))return null;
  const facts=investorSourceFacts(item).filter(f=>!administrative(f)),selected=[];
  const key=value=>clean(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const add=(fact,label='')=>{
    const value=clean(fact?.value);if(!value)return;
    if(selected.some(s=>(' '+key(s)+' ').includes(' '+key(value)+' ')))return;
    selected.push(label?`${label}: ${value}`:value);
  };
  // Each distinct event is retained, rather than assuming the longest paraphrase
  // has more reliable facts. Redundant status/date/admin fields do not lead.
  for(const fact of facts.filter(f=>f.field==='event'))add(fact);
  if(!selected.length)return null;
  for(const field of ['amount','conditions','status','ownership','counterparty']) {
    const candidates=facts.filter(f=>f.field===field);
    for(const fact of candidates) {
      const value=clean(fact.value);
      if(field==='status'&&!/\b(?:subject to|conditional|pending|proposed|not |no |reject|cancel|revok|unchanged)\b/i.test(value))continue;
      // Dates and counts of voting participation are audit details, not a new
      // event. Actual capital amounts and conditions remain in the reading.
      if(field==='ownership'&&/votes?|voting|polled|attendance|shareholders? on record/i.test(value))continue;
      if(selected.join(' ').length+value.length>600)continue;
      add(fact,field==='conditions'?'Conditions':field==='amount'?'Amount':field==='ownership'?'Ownership':'');
    }
  }
  return selected.join('; ');
}

/** Short readings of explicit read notice fields. No inferred meeting date,
 * missing agenda or timezone. Administrative passages stay in the register. */
export function readNoticeNote(item) {
  if(item.kind!=='filing'||item.content?.state!=='ready')return null;
  const facts=investorSourceFacts(item).filter(f=>!administrative(f));
  const events=facts.filter(f=>f.field==='event').map(f=>clean(f.value));
  if(!events.length)return null;
  const callRoles=facts.filter(f=>f.field==='counterparty').every(f=>/\b(?:organizing|hosting)\b.*\bcall\b|^(?:Speaker for the call|Call leaders):/i.test(f.value));
  if(events.every(value=>/\bcall\b/i.test(value))&&callRoles&&!facts.some(f=>['amount','ownership','conditions'].includes(f.field))) {
    const states=facts.filter(f=>['event','status'].includes(f.field)).map(f=>f.value).join(' ').replace(/not yet completed/gi,'');
    if(/\b(?:cancel\w*|postpon\w*|reschedul\w*|withdraw\w*|terminat\w*|reject\w*|concluded|completed|not scheduled)\b/i.test(states))return null;
    if(/\b(?:appoint\w*|resign\w*|acquir\w*|merg\w*|buyback|dividend|guidance|profit|revenue|margin|fundrais\w*|preferential|allotment|contract)\b/i.test(states))return null;
    const calls=facts.filter(f=>['event','date'].includes(f.field)&&/\bcall\b/i.test(f.value)&&/20\d{2}/.test(f.value)&&
      /\b\d{1,2}:\d{2}|\b\d{1,2}\s*[ap]\.?m\.?/i.test(f.value));
    if(calls.length===1) {
      const dates=eventDates(calls[0].value),clock=/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?|\b(\d{1,2}):(\d{2})/i.exec(calls[0].value);
      if(!dates.length||dates.some(date=>!date||date!==dates[0])||!clock)return null;
      const hour=Number(clock[1]||clock[4]),minute=Number(clock[2]||clock[5]||0);
      if(minute>59||hour>(clock[3]?12:23)||clock[3]&&hour<1)return null;
      const period=/\bQ[1-4]\s*FY\s*\d{2,4}\b/i.exec(events.join(' '))?.[0].replace(/\s/g,'');
      const note=[period?period+':':null,clean(calls[0].value)].filter(Boolean).join(' ');
      return note.length<=400?note:null;
    }
  }
  const agendas=events.map(value=>/^Board meeting scheduled to consider(?: and approve)?\s+(.+?)[.!]?$/i.exec(value)?.[1]);
  if(agendas.some(value=>!value))return null;
  const dates=facts.filter(f=>f.field==='date'&&/^Board meeting date:/i.test(f.value)).map(f=>eventDate(clean(f.value).replace(/^Board meeting date:\s*/i,'')));
  if(!dates.length||dates.some(date=>!date||date!==dates[0]))return null;
  const extras=facts.filter(f=>['amount','conditions','ownership','counterparty'].includes(f.field));
  // A new substantive status cannot be removed as a repeated prospective label.
  if(facts.some(f=>f.field==='status'&&!/^(?:Proposed(?:\/scheduled)?|Scheduled)(?: for board consideration)?(?:, not yet approved)?[.!]?$/i.test(clean(f.value))))return null;
  const note=`Board meeting ${dateLabel(dates[0])}: to consider ${[...new Set(agendas)].join(' and ')}.`+
    extras.map(f=>` ${f.field[0].toUpperCase()+f.field.slice(1)}: ${clean(f.value)}`).join('');
  return note.length<=500?note:null;
}

/** A bounded correction reading from explicit saved facts, never the headline
 * alone. Keep the changed classification and unchanged vote outcome together. */
export function votingResultNote(item) {
  if(item.content?.state!=='ready')return null;
  const event=explicitEvent(item),facts=item.content.facts||[];
  if(event?.type!=='egm-voting'||!event.revised)return null;
  const qualification=facts.some(f=>{
    const value=clean(f.value).toLowerCase().replace(/[^a-z0-9]+/g,' ');
    return f.field==='conditions'&&/\bshareholder classification\b/.test(value)&&/\b(?:limited to|only relates to)\b/.test(value)&&
      /\b(?:does not change votes cast or resolution outcomes|not votes cast or outcome)\b/.test(value);
  });
  if(!qualification)return null;
  const approved=facts.filter(f=>f.field==='event'&&/\b(?:approved|passed)\b/i.test(f.value)).map(f=>f.value);
  const decisions=[];
  if(approved.some(v=>/\b(?:preferential (?:equity )?issue|equity shares on preferential basis)\b/i.test(v)))decisions.push('preferential equity issue');
  if(approved.some(v=>/\bsection\s*186\s*\(2\)/i.test(v)&&/investments?|loans?|guarantees?/i.test(v)))decisions.push('Section 186(2) investment/loan/guarantee limits');
  const date=new Date(event.date+'T00:00:00Z'),label=`${date.getUTCDate()} ${months[date.getUTCMonth()].slice(0,3)} ${date.getUTCFullYear()}`;
  return `EGM ${label}: ${decisions.length?decisions.join(' and ')+' approved. ':''}Shareholder classification revised only; votes and resolution outcomes unchanged.`;
}

/** NSE's saved PRIOR_INTIMATION fields already provide a factual short notice.
 * Names/ISINs/SME flags and trading-window boilerplate remain in the saved extraction.
 * The purpose stays prospective: a meeting is not an approval or a declaration. */
export function xbrlBoardMeetingNote(item) {
  const content = item.content;
  if (item.kind !== 'filing' || content?.state !== 'ready' || content.format !== 'xbrl') return null;
  const facts = new Map();
  for (const fact of content.facts || []) {
    const tag = String(fact.location || '').split('/').at(-1), value = clean(fact.value);
    if (facts.has(tag) && facts.get(tag) !== value) return null;
    facts.set(tag,value);
  }
  const get = name => facts.get(name) || '';
  if (!/^board meeting$/i.test(get('TypeOfMeeting')) || !/^(?:new|revised)$/i.test(get('TypeOfIntimation'))) return null;
  const date = get('DateOfProposedMeeting');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) return null;
  const instant = new Date(date+'T00:00:00Z');
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10) !== date) return null;
  const label = `${instant.getUTCDate()} ${months[instant.getUTCMonth()].slice(0,3)} ${instant.getUTCFullYear()}`;
  const audit = /^(?:unaudited|audited)$/i.test(get('WhetherResultsAreAuditedOrUnaudited')) ? get('WhetherResultsAreAuditedOrUnaudited').toLowerCase() : '';
  const scope = /^(?:standalone|consolidated|standalone and consolidated)$/i.test(get('NatureOfReportStandaloneConsolidated')) ? get('NatureOfReportStandaloneConsolidated').toLowerCase() : '';
  const period = ({'half yearly':'half-year','quarterly':'quarterly','yearly':'annual','annual':'annual'})[get('ReportingPeriodType').toLowerCase()] || '';
  const month = months.find(value => value.toLowerCase() === get('MonthOfPeriodEnded').toLowerCase());
  // Only the dimensionless calendar year loses its source-unit annotation.
  const year = /^(20\d{2})(?: \[source unit: pure\])?$/.exec(get('YearOfPeriodEnded'))?.[1];
  const dividend = /^(?:interim|final|special)$/i.test(get('TypeOfDividend')) ? get('TypeOfDividend').toLowerCase() : '';
  const agendas = [...facts.entries()].filter(([tag,value]) => /^Agenda\d+$/.test(tag) && value && !/^(?:true|false|none|not applicable|n\/?a)$/i.test(value))
    .map(([,value]) => /^financial results$/i.test(value)
      ? [audit,scope,period,'financial results'].filter(Boolean).join(' ')+(month&&year?` for the period ended ${month} ${year}`:'')
      : /^dividend$/i.test(value) ? [dividend,'dividend'].filter(Boolean).join(' ') : value);
  if (!agendas.length) return null;
  const prefix = /^revised$/i.test(get('TypeOfIntimation')) ? 'Revised board-meeting notice for' : 'Board meeting';
  return `${prefix} ${label}: to consider ${agendas.join(' and ')}.`;
}
