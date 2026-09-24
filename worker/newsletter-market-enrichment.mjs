import { boundedJson } from '../public/js/data/family-book-contract.js';
import { marketDay } from './newsletter-markets.mjs';

// The public COMP history table's read-only EOD request. Never use NDX (Nasdaq-100).
export const NASDAQ_HISTORY_URL = 'https://indexes.nasdaq.com/Index/HistoryData';
const positive = n => Number.isFinite(n) && n > 0;
const differs = (a, b) => Math.abs(a - b) > 0.011;
const invalid = reason => { throw Object.assign(new Error(`Nasdaq history ${reason}`), { reason }); };
const eligible = row => row?.id === 'nasdaq' && row.symbol === '^IXIC' && row.origin === 'yahoo' &&
  row.currency === 'USD' && row.timezone === 'America/New_York' && row.state === 'close' && positive(row.last) &&
  row.prev == null && row.change == null && row.changePct == null && row.changeReason === 'previous-close-unverified' &&
  row.verification !== 'conflict' && /^\d{4}-\d{2}-\d{2}$/.test(row.previousSession || '');

/** Enrich only an already dated closing quote, never replace its observation or
 * infer a session from today's clock. Both providers must identify the same pair
 * of sessions and agree on the current close; the publisher's own net change
 * must also agree with its adjacent unadjusted EOD values.
 */
export function enrichNasdaqClose(row, body, now) {
  if (!eligible(row)) invalid('ineligible');
  if (!positive(row.asOf) || row.asOf > now + 60000 || now - row.asOf > 4 * 86400000 ||
      marketDay(row.asOf, row.timezone) !== row.sessionDate) invalid('timestamp');
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: row.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(row.asOf);
  if (clock < '16:00') invalid('not-closing-observation');
  const records = body?.aaData;
  if (!Array.isArray(records) || records.length < 2 || records.length > 8 ||
      body.iTotalRecords !== records.length || body.iTotalDisplayRecords !== records.length) invalid('incomplete');
  const startDay = new Date(Date.parse(row.sessionDate) - 7 * 86400000).toISOString().slice(0, 10);
  const dates = records.map(r => {
    const m = /^\/Date\((\d{13})\)\/$/.exec(r?.TimeStamp || '');
    if (!m || r.TradeDate !== r.TimeStamp || r.Currency !== 'USD') invalid('identity-or-date');
    const at = Number(m[1]), day = marketDay(at, 'America/New_York');
    // These are date markers, not market observation timestamps.
    if (!day || day < startDay || day > row.sessionDate ||
        new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at) !== '00:00:00') invalid('timestamp');
    return day;
  });
  if (!dates.every((day, i) => !i || day < dates[i - 1])) invalid('session-order');
  if (dates[0] !== row.sessionDate || dates[1] !== row.previousSession) invalid('session-mismatch');
  const [current, previous] = records;
  if (!positive(current.Value) || !positive(previous.Value) || !Number.isFinite(current.NetChange) ||
      !positive(current.High) || !positive(current.Low) || current.High < current.Low ||
      current.Value > current.High + 0.011 || current.Value < current.Low - 0.011) invalid('shape');
  if (differs(current.Value - previous.Value, current.NetChange) ||
      (current.PreviousClose != null && (!positive(current.PreviousClose) || differs(current.PreviousClose, previous.Value)))) invalid('history-conflict');
  if (Math.round(current.Value * 100) !== Math.round(row.last * 100)) invalid('close-conflict');
  if (positive(row.reportedPreviousClose) && differs(row.reportedPreviousClose, previous.Value)) invalid('previous-close-conflict');
  // Cash indices are displayed to two decimals. Keep the quote's level and clock;
  // normalize the reference to the same published precision before subtraction.
  const prev = Math.round(previous.Value * 100) / 100;
  return { ...row, prev, change: row.last - prev, changePct: (row.last / prev - 1) * 100,
    changeReason: null, changeOrigin: 'nasdaq-history', verification: 'level-cross-checked',
    enrichment: { source: 'nasdaq-history', symbol: 'COMP', sessionDate: dates[0], previousSession: dates[1],
      checkedAt: now, url: 'https://indexes.nasdaq.com/Index/History/COMP' } };
}

export async function readNasdaqEnrichment(row, { fetcher, now, timeout = 8000 }) {
  if (!eligible(row)) return { row, attempted: false, reason: null };
  const start = new Date(Date.parse(row.sessionDate) - 7 * 86400000).toISOString().slice(0, 10);
  try {
    const res = await fetcher(NASDAQ_HISTORY_URL, { method: 'POST', headers: {
      accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'GlowCentralResearch/1.0',
    }, body: new URLSearchParams({ id: 'COMP', startDate: `${start}T00:00:00`, endDate: `${row.sessionDate}T00:00:00`, timeOfDay: 'EOD' }).toString(),
    redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (!res.ok) {
      await res.body?.cancel();
      return { row, attempted: true, reason: [401, 403].includes(res.status) ? 'blocked' : res.status === 429 ? 'rate-limited' : 'unavailable' };
    }
    return { row: enrichNasdaqClose(row, await boundedJson(res, 64 * 1024), now), attempted: true, reason: null };
  } catch (e) {
    const reason = /abort|timeout/i.test(e?.name) ? 'timeout' : e.reason || 'unavailable';
    // Preserve the existing quote on outages. A known same-session closing-level
    // disagreement is different: it must not survive as an apparently good level.
    return { row: reason === 'close-conflict' ? { ...row, last: null, prev: null, change: null, changePct: null,
      state: 'unavailable', reason: 'source-conflict', verification: 'conflict' }
      : reason === 'previous-close-conflict' ? { ...row, changeReason: reason, verification: 'conflict' } : row, attempted: true, reason };
  }
}
