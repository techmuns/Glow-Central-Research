import { boundedJson } from '../public/js/data/family-book-contract.js';
import { expectedSession, marketWindow } from '../public/js/data/breakout-live-shared.js';

// Exact index identities checked against Upstox's NSE/BSE instrument masters, 24 Sep 2026.
// These are cash indices, never similarly named futures, ETFs or other index families.
export const INDIA_INSTRUMENTS = {
  nifty: ['NSE_INDEX|Nifty 50', 'NIFTY'],
  sensex: ['BSE_INDEX|SENSEX', 'SENSEX'],
  niftybank: ['NSE_INDEX|Nifty Bank', 'BANKNIFTY'],
  niftymid100: ['NSE_INDEX|NIFTY MIDCAP 100', 'NIFTY MIDCAP 100'],
  niftysmall100: ['NSE_INDEX|NIFTY SMLCAP 100', 'NIFTY SMLCAP 100'],
  nifty500: ['NSE_INDEX|Nifty 500', 'NIFTY 500'],
  niftyit: ['NSE_INDEX|Nifty IT', 'NIFTY IT'],
  indiavix: ['NSE_INDEX|India VIX', 'INDIA VIX'],
};
const positive = n => Number.isFinite(n) && n > 0;
const fail = reason => { throw Object.assign(new Error(`Market quote ${reason}`), { reason }); };
const differs = (a, b) => Math.abs(a - b) > Math.max(0.011, Math.abs(b) * 0.000001);
export function marketDay(at, timezone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at); }
  catch { return null; }
}
const delta = (last, prev) => ({ prev, change: prev == null ? null : last - prev, changePct: prev == null ? null : (last / prev - 1) * 100 });

/** chartPreviousClose is the RANGE's starting reference, not yesterday's close.
 * Use the immediately preceding dated, unadjusted daily bar. Never skip a null bar.
 */
export function quoteFromChart(body, row, now) {
  const result = body?.chart?.result?.[0], meta = result?.meta;
  if (!meta || body.chart.error || !positive(meta.regularMarketPrice)) fail('shape');
  const aliases = row.symbol === 'JPY=X' ? ['JPY=X', 'USDJPY=X'] : [row.symbol];
  if (!aliases.includes(meta.symbol)) fail('identity');
  if (row.group === 'india' && (meta.exchangeTimezoneName !== 'Asia/Kolkata' || (meta.currency && meta.currency !== 'INR'))) fail('identity');
  const asOf = meta.regularMarketTime * 1000, timezone = meta.exchangeTimezoneName;
  if (!positive(meta.regularMarketTime) || asOf > now + 60000 || !timezone || !marketDay(asOf, timezone)) fail('timestamp');
  const sessionDate = marketDay(asOf, timezone), last = meta.regularMarketPrice;
  const times = result.timestamp, closes = result.indicators?.quote?.[0]?.close;
  let prev = null, previousSession = null, changeReason = 'previous-close-unverified';
  if (meta.dataGranularity === '1d' && Array.isArray(times) && Array.isArray(closes) && times.length === closes.length) {
    const days = times.map(t => positive(t) ? marketDay(t * 1000, timezone) : null);
    // Out-of-order / duplicate sessions cannot establish the preceding session.
    if (days.every((day, i) => day && (!i || day > days[i - 1]))) {
      const current = days.indexOf(sessionDate);
      const previous = current - 1;
      if (previous >= 0 && positive(closes[previous]) && Date.parse(sessionDate) - Date.parse(days[previous]) <= 7 * 86400000) {
        prev = closes[previous]; previousSession = days[previous]; changeReason = null;
      }
    }
  }
  if (prev != null && row.group === 'india' && marketWindow(asOf).calendarKnown &&
      previousSession !== expectedSession(Date.parse(`${sessionDate}T09:14:00+05:30`))) {
    prev = null; changeReason = 'previous-close-unverified';
  }
  if (prev != null && positive(meta.previousClose) && differs(meta.previousClose, prev)) {
    prev = null; changeReason = 'previous-close-conflict';
  }
  const regular = meta.currentTradingPeriod?.regular;
  const start = regular?.start * 1000, end = regular?.end * 1000;
  const inSession = Number.isFinite(start) && end > start && now >= start && now < end && asOf >= start;
  let state = inSession ? (now - asOf <= 20 * 60000 ? 'live' : 'delayed') : 'close';
  // A mid-session observation cannot become a close merely because the clock advanced.
  if (!inSession && asOf >= start && asOf < end - 60000) state = 'delayed';
  // Provider session bounds detect a missed open; a long gap remains visibly dated
  // even when a provider advances its next-session bounds during an outage.
  if (now - asOf > 4 * 86400000 || (Number.isFinite(start) && now >= start + 20 * 60000 && asOf < start)) state = 'stale';
  if (row.group === 'india') {
    if (sessionDate !== expectedSession(now)) state = 'stale';
    else if (!marketWindow(now).open && asOf < Date.parse(`${sessionDate}T15:30:00+05:30`)) state = 'delayed';
  }
  return { ...row, last, ...delta(last, prev), asOf, sessionDate, previousSession, state,
    timezone, currency: meta.currency || null, origin: 'yahoo', checkedAt: now, changeReason };
}

/** V3 prev_close_price explicitly identifies the previous trading session's close.
 * Check it against net_change; OHLC close can describe the current session.
 * Index last-trade time is required: a fresh HTTP/feed timestamp cannot date an old level.
 */
export function quoteFromUpstox(data, row, now) {
  const identity = INDIA_INSTRUMENTS[row.id];
  if (!identity || data?.instrument_token !== identity[0] ||
      ![identity[1], identity[0].split('|')[1].toUpperCase()].includes(String(data.symbol || '').toUpperCase())) fail('identity');
  if (!positive(data.last_price) || !Number.isFinite(data.net_change)) fail('shape');
  const asOf = typeof data.last_trade_time === 'string' && /^\d+$/.test(data.last_trade_time)
    ? Number(data.last_trade_time) : data.last_trade_time;
  if (!positive(asOf) || asOf < 1e12 || asOf > now + 60000) fail('timestamp');
  const sessionDate = marketDay(asOf, 'Asia/Kolkata'), last = data.last_price, prev = data.prev_close_price;
  if (!positive(prev)) fail('previous-close-unverified');
  // Do not adopt a freshly dated feed at midnight / before the cash session starts.
  if (asOf < Date.parse(`${sessionDate}T09:15:00+05:30`)) fail('timestamp');
  const current = sessionDate === expectedSession(now);
  const state = !current ? 'stale' : marketWindow(now).open
    ? (now - asOf <= 20 * 60000 ? 'live' : 'delayed')
    : asOf >= Date.parse(`${sessionDate}T15:30:00+05:30`) ? 'close' : 'delayed';
  const conflict = differs(last - data.net_change, prev);
  return { ...row, last, ...delta(last, conflict ? null : prev), asOf, sessionDate, state,
    timezone: 'Asia/Kolkata', currency: 'INR', origin: 'upstox', checkedAt: now,
    changeReason: conflict ? 'previous-close-conflict' : null };
}

export async function readUpstoxIndices(rows, { token, fetcher, now, timeout = 8000 }) {
  if (!token) return { rows: new Map(), reason: 'not-configured' };
  const url = new URL('https://api.upstox.com/v3/market-quote/quotes');
  url.searchParams.set('instrument_key', rows.map(r => INDIA_INSTRUMENTS[r.id][0]).join(','));
  try {
    const res = await fetcher(url.href, { headers: { authorization: `Bearer ${token}`, accept: 'application/json',
      'user-agent': 'GlowCentralResearch/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { await res.body?.cancel(); return { rows: new Map(), reason: [401, 403].includes(res.status) ? 'authentication' : res.status === 429 ? 'rate-limited' : 'unavailable' }; }
    const body = await boundedJson(res, 256 * 1024);
    if (body?.status !== 'success' || !body.data || typeof body.data !== 'object') fail('shape');
    const values = Object.values(body.data), found = new Map(), failures = {};
    for (const row of rows) {
      try {
        const matches = values.filter(q => q?.instrument_token === INDIA_INSTRUMENTS[row.id][0]);
        if (matches.length !== 1) fail('missing-or-duplicate');
        found.set(row.id, quoteFromUpstox(matches[0], row, now));
      } catch (e) { failures[row.id] = e.reason || 'shape'; }
    }
    return { rows: found, failures, reason: found.size === rows.length ? null : 'partial' };
  } catch (e) { return { rows: new Map(), reason: /abort|timeout/i.test(e?.name) ? 'timeout' : 'unavailable' }; }
}

export function reconcileIndex(yahoo, primary, primaryReason) {
  const usable = r => r && ['live', 'close'].includes(r.state) && r.last != null;
  if (!usable(primary)) return { ...yahoo, verification: 'single-source', primaryReason: primaryReason || primary?.state || 'unavailable' };
  const row = { ...primary, verification: 'single-source' };
  if (!usable(yahoo) || yahoo.sessionDate !== primary.sessionDate) return row;
  // Closing levels can be compared; intraday quotes from different seconds can legitimately differ.
  if (yahoo.state === 'close' && primary.state === 'close' && differs(yahoo.last, primary.last)) {
    return { ...row, last: null, ...delta(null, null), state: 'unavailable', reason: 'source-conflict', verification: 'conflict' };
  }
  if (yahoo.prev != null && primary.prev != null && differs(yahoo.prev, primary.prev)) {
    return { ...row, ...delta(row.last, null), changeReason: 'previous-close-conflict', verification: 'conflict' };
  }
  if (yahoo.prev != null && primary.prev != null) row.verification = 'cross-checked';
  return row;
}

export const marketIssue = row => row.reason === 'source-conflict' ? 'sources disagree'
  : row.changeReason === 'previous-close-conflict' ? 'daily change withheld: sources disagree'
  : row.last != null && row.changePct == null ? 'daily change unavailable' : null;
