const normal = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const datePattern = '(\\d{1,2})[ /-]+(\\d{1,2}|[A-Za-z]{3,9})[ /,-]+(20\\d{2})';

/** This identifies an explicitly scheduled board meeting, never a board outcome.
 * Publication time is not its event date. Unknown agendas cannot invent decisions. */
export function scheduledBoardMeeting(item) {
  if (item.kind !== 'filing') return null;
  const title = normal(item.headline);
  if (!/\b(?:board meeting|meeting of (?:the )?board)\b/i.test(title) ||
      /\b(?:outcome|reschedul\w*|postpon\w*|cancel\w*|revis\w*|corrigend\w*|withdraw\w*|approved|declared)\b/i.test(title)) return null;
  const match = new RegExp('(?:scheduled(?: to be held)? on|to be held on)\\s*' + datePattern, 'i').exec(title);
  if (!match) return null;
  const day = Number(match[1]), month = /^\d+$/.test(match[2]) ? Number(match[2]) : months.indexOf(match[2].slice(0,3).toLowerCase()) + 1;
  const year = Number(match[3]), at = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  const period = /\bperiod ended\s+((?:\d{1,2}[ /-]+)?(?:[A-Za-z]+|\d{1,2})[ /,-]+20\d{2})/i.exec(title)?.[1] || null;
  const agendas = [
    ['results', /\b(?:financial results|quarterly results|half yearly.*results)\b/i],
    ['dividend', /\bdividend\b/i], ['fundraising', /\bfund.?rais\w*\b/i], ['QIP', /\bQIP\b/i],
    ['rights issue', /\brights issue\b/i], ['preferential issue', /\bpreferential issue\b/i],
    ['buyback', /\bbuyback\b/i], ['acquisition', /\bacquisition\b/i], ['merger', /\bmerger\b/i], ['divestment', /\bdivest\w*\b/i],
    ['appointment', /\bappointment\b/i], ['resignation', /\bresignation\b/i],
  ].filter(([, pattern]) => pattern.test(title)).map(([name]) => name);
  const purpose = /\bto consider(?: and approve)?\s+(.+)$/i.exec(title)?.[1];
  const generic = !agendas.length && (purpose ? /^(?:intimation of )?(?:the )?board meeting[ .…]*$/i.test(purpose)
    : /^[ .…]*$/.test(title.slice(match.index + match[0].length)));
  return { date: at.toISOString().slice(0,10), label: `${day} ${months[month - 1][0].toUpperCase() + months[month - 1].slice(1)} ${year}`, period, agendas, generic, purpose };
}

export function sameScheduledBoardMeeting(a, b) {
  const x = scheduledBoardMeeting(a), y = scheduledBoardMeeting(b);
  if (!x || !y || a.ticker !== b.ticker || x.date !== y.date || Math.abs(a.at - b.at) > 3600000) return false;
  if (x.period && y.period && x.period.toLowerCase() !== y.period.toLowerCase()) return false;
  // The exact generic exchange wrapper may accompany a detailed notice. Unknown
  // prose is not generic, and two capital-action proposals can share a meeting date.
  if (x.generic || y.generic) return true;
  return !!x.period && !!y.period && x.agendas.length > 0 &&
    x.agendas.every(value => value === 'results' || value === 'dividend') &&
    JSON.stringify(x.agendas) === JSON.stringify(y.agendas);
}

export function scheduledBoardMeetingSummary(item) {
  const meeting = scheduledBoardMeeting(item);
  if (!meeting) return null;
  if (meeting.generic) return `Board meeting ${meeting.label}; agenda not specified in the captured notice.`;
  if (!meeting.purpose) return null;
  // Retain the stated purpose, including counterparties, amounts and qualifications.
  // Removing exchange boilerplate must not replace it with an inferred agenda label.
  const purpose = meeting.purpose.replace(/^the\s+/i, '').replace(/\bof the Company\b/gi, '')
    .replace(/\bHalf Yearly\b/gi, 'half-year').replace(/\bUnaudited Financial results\b/gi, 'unaudited financial results')
    .replace(/\bDividend\b/gi, 'dividend').replace(/\s+/g, ' ').replace(/[ .…]+$/, '');
  return `Board meeting ${meeting.label}: to consider ${purpose}.`;
}
