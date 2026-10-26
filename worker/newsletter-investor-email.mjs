import { editorialEvents, editorialText } from './newsletter-editorial.mjs';
import { istLabel, istDateLong } from '../public/js/data/newsletter-shared.js';
import { formatLast, formatPct, asOfLabel } from './newsletter-brief.mjs';
import { priceReasonText } from './newsletter-price-reasons.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// This is an explicitly abbreviated reading layer. Complete source text and all terms stay
// in the immutable report, never in a truncated source record or model input.
const short = (value, max) => { const s=editorialText(value); return s.length>max ? s.slice(0,max-1).replace(/\s+\S*$/,'')+'…' : s; };
const link = (url,label) => {
  try { if (!['https:','http:'].includes(new URL(url).protocol)) return esc(label); }
  catch { return esc(label); }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:#4f46e5;text-decoration:none">${esc(label)}</a>`;
};
const cell = (value, extra='') => `<td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;${extra}">${value}</td>`;
export const investorSubject = (brief, brand, stats) => {
  const reading=editorialEvents(brief,stats.companies);
  return `${brand} · ${reading.events.length} development${reading.events.length===1?'':'s'} · ${brief.day} · ${brief.edition === 'morning'?'Morning':'Evening'}`;
};

export function renderInvestorEmail(brief, {dashboardUrl,recipient,productName,brand,pdfUrl,part,preview,stats}) {
  const reading=editorialEvents(brief,stats.companies);
  const chosen=new Set(part.eventIds), events=reading.events.filter(e=>chosen.has(e.id));
  const compact=!!part.compact;
  const reportUrl=pdfUrl || `${dashboardUrl}/api/newsletter/preview?edition=${brief.edition}&format=pdf`;
  const cards=events.map(event=>{
    const s=event.lead;
    const summary=event.summary || (event.facts.length ? event.facts.map(f=>f.value).join(' ') : s.kind==='move'?`${s.headline}. Why it moved: ${priceReasonText(s.why)}`:s.headline);
    const title=event.summary || event.facts.length ? s.headline : null;
    const interpretation=event.summary && event.note?.impact;
    const unknowns=event.summary && event.note?.unknowns;
    const source=s.content?.sourceUrl || s.url;
    const type=s.related?'Related entity; exposure unconfirmed':s.kind==='filing'?'Corporate announcement':s.kind==='trade'?'Ownership disclosure':s.kind==='move'?'Price context':'Reported development';
    if(compact) {
      const direct=source&&source.length<=220;
      return `<tr><td colspan="2" style="padding:9px 6px;border-bottom:1px solid #e5e7eb"><strong>${esc(event.company)}</strong> · ${esc(short(summary,300))}<br><span style="font-size:11px;color:#64748b">${event.summary?'AI summary':event.facts.length?'Source facts':'Unverified lead'}${s.related?' · Related entity; exposure unconfirmed':''} · ${esc(istLabel(s.at))} · ${event.read}/${event.total} read · ${link(direct?source:reportUrl,direct?'Source':'Evidence in report')}</span></td></tr>`;
    }
    return `<tr>${cell(`<strong>${esc(event.company)}</strong><br><span style="font-size:11px;color:#64748b">${esc(event.ticker)} · ${type}<br>${esc(istLabel(s.at))}</span>`,'width:25%')}${cell(
      `${title?`<div style="font-weight:600;margin-bottom:4px">${esc(short(title,compact?130:220))}</div>`:''}`+
      `<div>${esc(short(summary,compact?220:460))}</div>`+
      (!compact&&interpretation?`<div style="margin-top:5px"><strong>Why it matters · AI:</strong> ${esc(short(interpretation,260))}</div>`:'')+
      (!compact&&unknowns?`<div style="margin-top:5px"><strong>Watch next:</strong> ${esc(short(unknowns,200))}</div>`:'')+
      `<div style="font-size:11px;color:#64748b;margin-top:5px">${event.summary?'AI summary · ':event.facts.length?'Source facts · ':''}${esc(event.evidence)} · ${event.read}/${event.total} sources read · ${source?link(source,'Primary / lead source'):'Source link unavailable'} · ${event.sourceCount} source item${event.sourceCount===1?'':'s'}</div>`
    )}</tr>`;
  }).join('');
  const pending=brief.content?.pending;
  const a=brief.announcements,n=brief.news;
  const gaps=[];
  if (!a.nse?.ok || !a.nseHistory?.ok) gaps.push('NSE coverage incomplete');
  if (!a.bse?.ok || a.bse?.partial) gaps.push('BSE coverage partial');
  if (!n.source?.ok || n.source?.archiveComplete===false) gaps.push('publisher coverage incomplete');
  if (n.company?.partial || n.company?.ok===false) gaps.push('company-news checks partial');
  if (n.tradingview?.partial) gaps.push('TradingView coverage partial');
  if (Number.isFinite(pending)&&pending) gaps.push(`${pending} source items unread`);
  if (!brief.ai?.ok) gaps.push('AI notes unavailable; source facts/headlines labelled below');
  const warning=gaps.length?`<div style="padding:10px 12px;background:#fff7ed;color:#9a3412;font-size:12px;margin:12px 0"><strong>Coverage:</strong> ${esc(gaps.join(' · '))}. Full check times are in the report.</div>`:'';
  const first=part.index===1;
  const calendar=first?(brief.calendar?.rows || []).map(r=>
    `<tr>${cell(esc(r.date)+(r.time?`<br>${esc(r.time)} IST`:''))}${cell(esc(r.company))}${cell(link(r.url,`${r.label}${r.sources?.length?' · '+r.sources.join(' / '):''}`))}</tr>`).join(''):'';
  const actionRows=first?(brief.actions?.rows || []).map(r=>`<tr>${cell(esc(r.dates.map(d=>`${d.label} ${d.date}`).join(' · ')))}${cell(esc(r.company))}${cell(link(r.url,r.purpose))}</tr>`).join(''):'';
  // Only the first part carries concise market context. Every instrument and all holdings
  // remain in the report with their individual verification and source clocks.
  const markets=first?brief.markets.rows.map(r=>
    `<tr>${cell(esc(r.label))}${cell(esc(formatLast(r)||'Unavailable'))}${cell(esc(formatPct(r)||'Unavailable'))}${cell(esc(asOfLabel(r)),'font-size:10px;color:#64748b')}</tr>`).join(''):'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(investorSubject(brief,brand,stats))}</title></head>
<body style="margin:0;background:#f3f4f6;color:#172033;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45"><table role="presentation" width="100%"><tr><td align="center" style="padding:16px 8px"><table role="presentation" width="700" style="width:100%;max-width:700px;background:white;border:1px solid #e5e7eb"><tr><td style="padding:22px 18px">
<div style="color:#4f46e5;font-size:12px;font-weight:bold;letter-spacing:1px">${esc(brand.toUpperCase())}</div><h1 style="font-size:24px;margin:8px 0">${brief.edition==='morning'?'Morning':'Evening'} investment brief</h1>
<div style="color:#64748b">${esc(istDateLong(brief.at))} · ${esc(istLabel(brief.window.from))} → ${esc(istLabel(brief.window.to))}</div>
<p><strong>${reading.events.length} distinct development${reading.events.length===1?'':'s'}</strong> · ${reading.sources} source items retained · ${reading.reference.length} reference/calendar groups · ${reading.repeated.length} previously covered groups</p>
${preview?'<p><strong>Preview:</strong> uses saved readings only; no email or AI request is made.</p>':''}
${part.total>1?`<p><strong>Part ${part.index} of ${part.total}</strong> · ${events.length} developments here. Other parts continue this edition.</p>`:''}
${warning}<p>${link(reportUrl,'Complete evidence report / Download PDF')} · ${link(dashboardUrl+'/#/research/daily-alerts?scope=portfolio','Open dashboard')}</p>
<p style="font-size:12px;color:#64748b">Descriptions are abbreviated. The complete report retains captured records, supporting links, reference records, company prices and source checks. Open original documents for full terms.${compact?' This busy edition uses shorter descriptions.':''}</p>
<h2 style="font-size:16px;margin:20px 0 6px">Developments to review</h2><table width="100%" style="border-collapse:collapse;table-layout:fixed;overflow-wrap:anywhere;font-size:13px">${cards||(part.packing?'':'<tr><td>No new material developments identified in the available readings. Check coverage above.</td></tr>')}</table>
${first&&part.supplements?`${calendar?`<h2 style="font-size:16px">Upcoming results and calls</h2><table width="100%" style="border-collapse:collapse;font-size:12px">${calendar}</table>`:''}${actionRows?`<h2 style="font-size:16px">Corporate action dates</h2><table width="100%" style="border-collapse:collapse;font-size:12px">${actionRows}</table>`:''}${markets?`<h2 style="font-size:16px">Market context</h2><table width="100%" style="border-collapse:collapse;font-size:12px">${markets}</table>`:''}`:''}
${first&&!part.supplements?`<p>${brief.calendar?.rows?.length||0} upcoming results/calls and ${brief.actions?.rows?.length||0} corporate actions: ${link(reportUrl,'all dates and market context in the report')}.</p>`:''}
<p style="font-size:11px;color:#64748b;margin-top:20px">${recipient?.test?'Requested test copy.':'Your scheduled portfolio brief.'} Potential impacts are interpretations, not established outcomes. ${link(dashboardUrl+'/#/research/ask-research?newsletter=manage','Unsubscribe')} · Automated by Munshot<br>Built ${esc(istLabel(brief.builtAt,{year:true}))} · ${esc(productName)}</p>
</td></tr></table></td></tr></table></body></html>`;
}
