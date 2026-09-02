// lib/muns-market-data.mjs — the Muns market-data endpoint as the ARBITER of a flagged day move.
//
// Yahoo is the price source for 603 companies × 280 bars, and it is right almost all of the time.
// Where it went wrong — a session bar published late, so the "previous close" was two sessions
// back — it produced exactly the number a ±5% alert is looking for. The dashboard's own endpoint
// (`GET https://fastapi.muns.io/market_data`) publishes the exchange closes, so every move that
// crosses the alert threshold is re-derived from ITS last two closes before it is written. It is
// not the source for the whole file: it rate-limits hard (a handful of requests in quick
// succession answers "Too Many Requests"), and a flagged move is a dozen names a day, not six
// hundred.
//
// TWO THINGS THE PARSER HAS TO SURVIVE, both measured against the live endpoint:
//   1. A refusal is an HTTP 200 whose body is the text `Error: Too Many Requests…`. Same trap as
//      BSE's `strCat=-1`: a 200 that is not the data is not evidence about the data.
//   2. The body is a text PREVIEW, not JSON — a `Date, Open, High, Low, Close, …` header line and
//      pipe-separated rows, with the middle of a long range elided as `...`. The last two rows are
//      always present, which is all a day move needs. A JSON body is handled too, by shape, in
//      case the service starts sending one.
//
// Pure functions here take the body as a string; `fetchDailyBars` is the only network call.

export const MARKET_DATA_BASE = 'https://fastapi.muns.io';
export const SOURCE_LABEL = 'fastapi.muns.io/market_data';

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

const num = (value) => {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** Parse the endpoint's body — text preview or JSON — into `{ ok, bars }` or `{ ok: false, reason }`. */
export function parseMarketData(body) {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, reason: 'empty body' };
  if (/^error\b/i.test(text)) {
    return { ok: false, reason: /too many requests|rate limit/i.test(text) ? 'rate-limited' : text.split('\n')[0].slice(0, 120) };
  }
  if (text.startsWith('{') || text.startsWith('[')) return parseJson(text);
  return parseTextPreview(text);
}

function parseJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unreadable JSON' };
  }
  const candidates = Array.isArray(parsed) ? [parsed] : [parsed?.data, parsed?.bars, parsed?.series, parsed?.rows, parsed?.results].filter(Array.isArray);
  const list = candidates.find((items) => items.length && typeof items[0] === 'object');
  if (!list) return { ok: false, reason: 'no series in JSON' };
  const bars = list
    .map((item) => {
      const date = String(item.Date ?? item.date ?? item.Datetime ?? item.timestamp ?? item.time ?? '').match(DATE_RE)?.[1] || null;
      const close = num(item.Close ?? item.close ?? item['Adj Close'] ?? item.adj_close);
      return date && close != null ? { date, open: num(item.Open ?? item.open), high: num(item.High ?? item.high), low: num(item.Low ?? item.low), close, volume: num(item.Volume ?? item.volume) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  return bars.length ? { ok: true, bars } : { ok: false, reason: 'no dated closes in JSON' };
}

function parseTextPreview(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const header = lines.find((line) => /^date\s*,/i.test(line));
  if (!header) return { ok: false, reason: 'no header line' };
  const columns = header.split(',').map((column) => column.trim().toLowerCase());
  const index = (name) => columns.indexOf(name);
  const closeAt = index('close');
  if (closeAt < 0) return { ok: false, reason: 'no close column' };
  const bars = [];
  for (const line of lines) {
    const date = line.match(DATE_RE)?.[1];
    if (!date || !line.includes('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const close = num(cells[closeAt]);
    if (close == null) continue;
    bars.push({ date, open: num(cells[index('open')]), high: num(cells[index('high')]), low: num(cells[index('low')]), close, volume: num(cells[index('volume')]) });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars.length ? { ok: true, bars } : { ok: false, reason: 'no dated rows' };
}

/**
 * The move the endpoint states for `date`: its close on that day against the close of the bar
 * immediately before it in the series. Null when the series does not carry `date` — an absent day
 * is "could not verify", never "no move".
 */
export function moveFromBars(bars, date) {
  const at = (bars || []).findIndex((bar) => bar.date === date);
  if (at < 1) return null;
  const last = bars[at];
  const prev = bars[at - 1];
  if (!(prev.close > 0)) return null;
  return { pct: ((last.close - prev.close) / prev.close) * 100, close: last.close, prevClose: prev.close, prevDate: prev.date };
}

const shiftDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);

/** One request. Never throws on a refusal: the caller decides what an unverified move means. */
export async function fetchDailyBars({ ticker, date, country = 'India', token = process.env.MUNS_TOKEN || '', base = MARKET_DATA_BASE, fetchImpl = fetch, lookbackDays = 14 } = {}) {
  const url = `${base}/market_data?ticker=${encodeURIComponent(ticker)}&start=${shiftDays(date, -lookbackDays)}&end=${shiftDays(date, 1)}&country=${encodeURIComponent(country)}`;
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(url, { headers });
    const body = await response.text();
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, url };
    return { ...parseMarketData(body), url };
  } catch (error) {
    return { ok: false, reason: error?.message || 'network error', url };
  }
}

/**
 * Re-derive every flagged move from the endpoint's own closes, in place.
 *
 * `rows` are the scrape's company rows; a row is flagged when |pct_change_today| reaches
 * `thresholdPct` — a margin BELOW the alert line, so a Yahoo 5.3% that is really 4.6% is
 * corrected and a Yahoo 4.8% that is really 5.2% is too. Each verified row records where its move
 * came from; each unverifiable one keeps Yahoo's figure and says it was not checked. Bounded by
 * `limit` and spaced by `spacingMs`; a rate-limit answer waits once and retries once.
 */
export async function verifyMoves(rows, { thresholdPct = 4, limit = 40, spacingMs = 3000, retryWaitMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fetchImpl = fetch, token, log = () => {} } = {}) {
  const flagged = rows.filter((row) => Number.isFinite(row.pct_change_today) && Math.abs(row.pct_change_today) >= thresholdPct && row.bar_date);
  const summary = { source: SOURCE_LABEL, threshold_pct: thresholdPct, flagged: flagged.length, checked: 0, confirmed: 0, corrected: 0, unavailable: 0, limit };
  let rateLimited = false;
  for (const row of flagged.slice(0, limit)) {
    let result = await fetchDailyBars({ ticker: row.ticker, date: row.bar_date, token, fetchImpl });
    if (!result.ok && result.reason === 'rate-limited' && !rateLimited) {
      rateLimited = true;
      await sleep(retryWaitMs);
      result = await fetchDailyBars({ ticker: row.ticker, date: row.bar_date, token, fetchImpl });
    }
    const move = result.ok ? moveFromBars(result.bars, row.bar_date) : null;
    if (!move) {
      row.move_check = 'unavailable';
      row.move_check_reason = result.ok ? `no close for ${row.bar_date}` : result.reason;
      summary.unavailable += 1;
      log(`  ${row.ticker}: not verified (${row.move_check_reason})`);
    } else {
      const before = row.pct_change_today;
      const pct = Math.round(move.pct * 100) / 100;
      const changed = Math.abs(pct - before) > 0.05;
      row.pct_change_today = pct;
      row.move_source = SOURCE_LABEL;
      row.move_prev_date = move.prevDate;
      row.move_close = move.close;
      row.move_prev_close = move.prevClose;
      row.move_check = changed ? 'corrected' : 'confirmed';
      summary.checked += 1;
      summary[changed ? 'corrected' : 'confirmed'] += 1;
      log(`  ${row.ticker}: ${changed ? `${before}% → ${pct}%` : `${pct}% confirmed`} (${move.prevDate} → ${row.bar_date})`);
    }
    await sleep(spacingMs);
  }
  summary.skipped = Math.max(0, flagged.length - limit);
  return summary;
}
