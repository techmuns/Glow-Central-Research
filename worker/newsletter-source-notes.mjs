// Presentation over saved source facts. Never rewrite the retained extraction or
// turn identifiers, enum values and bare XBRL booleans into an investor summary.
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const material = new Set(['event','counterparty','amount','status','date','conditions','ownership']);

export function investorSourceFacts(item) {
  const facts = (item.content?.facts || []).filter(fact => material.has(fact.field) && clean(fact.value));
  if (!facts.some(fact => fact.field !== 'date')) return [];
  const order = ['event','amount','status','conditions','ownership','counterparty','date'];
  return [...facts].sort((a,b) => order.indexOf(a.field)-order.indexOf(b.field)).map(fact =>
    /^(?:true|false)$/i.test(clean(fact.value)) ? { ...fact, value: `${fact.name || fact.field}: ${/^true$/i.test(clean(fact.value)) ? 'Yes' : 'No'}` } : fact);
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
