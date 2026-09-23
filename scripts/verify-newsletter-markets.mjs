#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INDIA_INSTRUMENTS, quoteFromChart, quoteFromUpstox, readUpstoxIndices, reconcileIndex } from '../worker/newsletter-markets.mjs';
import { MARKET_ROWS, readMarkets, asOfLabel, formatPct, formatChange, buildBrief, renderBriefHtml, renderBriefText } from '../worker/newsletter-brief.mjs';
import { DEFAULT_SETTINGS } from '../public/js/data/newsletter-shared.js';
import { renderBriefPdf } from '../worker/newsletter-pdf.mjs';

const at = Date.parse('2026-09-23T16:00:00+05:30');
const time = (day, clock = '15:30') => Date.parse(`${day}T${clock}:00+05:30`);
const nifty = MARKET_ROWS.find(r => r.id === 'nifty');
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url)));
const chart = (row = nifty, last = 23446.8, prev = 23329) => ({ chart: { result: [{
  meta: { symbol: row.symbol, regularMarketPrice: last, regularMarketTime: time('2026-09-23') / 1000,
    chartPreviousClose: 23270.6, dataGranularity: '1d', range: '5d', exchangeTimezoneName: 'Asia/Kolkata',
    currentTradingPeriod: { regular: { start: time('2026-09-23', '09:15') / 1000, end: time('2026-09-23') / 1000 } } },
  timestamp: ['2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23'].map(day => time(day, '09:15') / 1000),
  indicators: { quote: [{ close: [23000, 23100, 23200, prev, last] }] },
}] } });
const primary = (row = nifty, last = 23446.8, prev = 23329) => ({
  instrument_token: INDIA_INSTRUMENTS[row.id][0], symbol: INDIA_INSTRUMENTS[row.id][1],
  last_price: last, net_change: last - prev, prev_close_price: prev, ohlc: { close: last }, last_trade_time: String(time('2026-09-23')),
});

test('23 September customer report: correct levels AND NSE daily changes, never the five-day reference', () => {
  for (const [id, last, prev, pct, change] of [
    ['nifty', 23446.8, 23329, '+0.50%', '+117.80'],
    ['niftybank', 56548.9, 56215.55, '+0.59%', '+333.35'],
    ['nifty500', 22935.1, 22794.2, '+0.62%', '+140.90'],
  ]) {
    const row = MARKET_ROWS.find(r => r.id === id);
    for (const q of [quoteFromChart(chart(row, last, prev), row, at), quoteFromUpstox(primary(row, last, prev), row, at)]) {
      assert.equal(formatPct(q), pct); assert.equal(formatChange(q), change);
      assert.equal(q.prev, prev); assert.equal(q.sessionDate, '2026-09-23');
    }
  }
});

test('captured global response uses prior daily bar and changes yields in basis points', () => {
  const row = MARKET_ROWS.find(r => r.id === 'sp500');
  const q = quoteFromChart(fixture('yahoo-sp500.json'), row, at);
  assert.equal(formatPct(q), '−0.45%'); assert.equal(formatChange(q), '−33.92');
  const yieldRow = MARKET_ROWS.find(r => r.id === 'us10y');
  assert.equal(formatChange(quoteFromChart(fixture('yahoo-us10y.json'), yieldRow, at)), '+1.0 bp');
});

test('actual Yahoo missing-close response cannot turn a two-day or five-day change into a daily gain', () => {
  const q = quoteFromChart(fixture('yahoo-nifty-missing-close.json'), nifty, at);
  assert.equal(q.last, 23446.8); assert.equal(q.prev, null); assert.equal(q.changePct, null);
  assert.match(asOfLabel(q), /daily change unavailable/);
});

test('null prior bars, intraday arrays, out-of-order dates and conflicting explicit close withhold changes', () => {
  for (const mutate of [
    r => { r.indicators.quote[0].close[3] = null; },
    r => { r.meta.dataGranularity = '1m'; },
    r => { r.timestamp[2] = r.timestamp[3]; },
    r => { r.timestamp.reverse(); },
    r => { r.meta.previousClose = 100; },
    r => { r.indicators.quote[0].close.pop(); },
  ]) {
    const body = chart(); mutate(body.chart.result[0]);
    const q = quoteFromChart(body, nifty, at);
    assert.equal(q.changePct, null); assert.equal(q.change, null);
  }
});

test('null current candle and weekends do not shift the comparison to the wrong day', () => {
  const body = chart(); body.chart.result[0].indicators.quote[0].close[4] = null;
  assert.equal(quoteFromChart(body, nifty, at).prev, 23329);
  const r = body.chart.result[0];
  r.meta.regularMarketTime = time('2026-09-21') / 1000;
  r.timestamp = r.timestamp.slice(0, 3); r.indicators.quote[0].close = [23000, 23100, 23200];
  assert.equal(quoteFromChart(body, nifty, at).previousSession, '2026-09-18');
  assert.match(asOfLabel(quoteFromChart(body, nifty, at)), /Earlier quote.*21 Sept? 2026/);
});

test('wrong symbol, invalid zone, missing/future timestamps and non-finite prices are rejected', () => {
  for (const changes of [{ symbol: '^NSEBANK' }, { exchangeTimezoneName: 'America/New_York' }, { currency: 'USD' }, { exchangeTimezoneName: 'Mars' }, { regularMarketTime: null },
    { regularMarketTime: at / 1000 + 120 }, { regularMarketPrice: NaN }, { regularMarketPrice: 0 }]) {
    const body = chart(); Object.assign(body.chart.result[0].meta, changes);
    assert.throws(() => quoteFromChart(body, nifty, at));
  }
  for (const changes of [{ symbol: 'BANKNIFTY' }, { instrument_token: 'NSE_FO|123' }, { last_trade_time: '' },
    { last_trade_time: String(at + 120000) }, { last_trade_time: String(time('2026-09-23', '08:00')) }, { net_change: '117.8' }, { prev_close_price: null }]) {
    assert.throws(() => quoteFromUpstox({ ...primary(), ...changes }, nifty, at));
  }
});

test('intraday observations never become closing quotes after the market closes', () => {
  const body = chart(); body.chart.result[0].meta.regularMarketTime = time('2026-09-23', '11:00') / 1000;
  assert.equal(quoteFromChart(body, nifty, at).state, 'delayed');
  assert.equal(quoteFromUpstox({ ...primary(), last_trade_time: String(time('2026-09-23', '11:00')) }, nifty, at).state, 'delayed');
  assert.equal(quoteFromUpstox(primary(), nifty, time('2026-09-24', '08:00')).state, 'close');
  assert.equal(quoteFromUpstox(primary(), nifty, time('2026-09-24', '10:00')).state, 'stale');
});

test('Upstox cross-checks intact rows, withholds conflicting changes/levels, never mixes providers', () => {
  const yahoo = quoteFromChart(chart(), nifty, at), upstox = quoteFromUpstox(primary(), nifty, at);
  assert.equal(reconcileIndex(yahoo, upstox).verification, 'cross-checked');
  const conflict = reconcileIndex(yahoo, { ...upstox, prev: 23270.6 });
  assert.equal(conflict.last, upstox.last); assert.equal(conflict.changePct, null);
  assert.match(asOfLabel(conflict), /sources disagree/);
  const priceConflict = reconcileIndex(yahoo, { ...upstox, last: 23500 });
  assert.equal(priceConflict.last, null); assert.equal(priceConflict.state, 'unavailable');
  assert.equal(reconcileIndex(yahoo, { ...upstox, state: 'stale' }).origin, 'yahoo');
  assert.equal(reconcileIndex({ ...yahoo, state: 'unavailable', last: null }, upstox).origin, 'upstox');
  assert.equal(quoteFromUpstox({ ...primary(), net_change: 100 }, nifty, at).changePct, null);
});

test('one bounded Upstox request uses only the existing secret and isolates missing/duplicate/bad index rows', async () => {
  const rows = MARKET_ROWS.filter(r => r.group === 'india'); let calls = 0;
  const fetcher = async (url, init) => {
    calls++; assert.equal(new URL(url).origin, 'https://api.upstox.com');
    assert.equal(new URL(url).pathname, '/v3/market-quote/quotes');
    assert.equal(init.headers.authorization, 'Bearer fixture-secret'); assert.equal(init.redirect, 'manual');
    assert.deepEqual(new URL(url).searchParams.get('instrument_key').split(','), rows.map(r => INDIA_INSTRUMENTS[r.id][0]));
    return Response.json({ status: 'success', data: Object.fromEntries(rows.slice(0, 7).map(r => [r.id, primary(r)])) });
  };
  const result = await readUpstoxIndices(rows, { token: 'fixture-secret', fetcher, now: at });
  assert.equal(calls, 1); assert.equal(result.rows.size, 7); assert.equal(result.reason, 'partial');
  assert.equal(result.failures.indiavix, 'missing-or-duplicate');
  const duplicate = await readUpstoxIndices([nifty], { token: 'fixture-secret', now: at,
    fetcher: async () => Response.json({ status: 'success', data: { a: primary(), b: primary() } }) });
  assert.equal(duplicate.rows.size, 0);
  assert.equal((await readUpstoxIndices(rows, { fetcher: () => assert.fail('no secret means no request'), now: at })).reason, 'not-configured');
  for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [503, 'unavailable'], [302, 'unavailable']]) {
    assert.equal((await readUpstoxIndices(rows, { token: 'fixture', now: at, fetcher: async () => new Response('', { status }) })).reason, reason);
  }
  assert.equal((await readUpstoxIndices(rows, { token: 'fixture', now: at, fetcher: async () => { throw { name: 'TimeoutError' }; } })).reason, 'timeout');
});

test('complete market reader and HTML/text/PDF preserve verified numbers, missing rows and source disagreements', async () => {
  let disagree = false, missing = false, tokenRejected = false;
  const fetcher = async (url, init) => {
    if (String(url).startsWith('https://api.upstox.com/')) {
      if (tokenRejected) return new Response('', { status: 401 });
      return Response.json({ status: 'success', data: Object.fromEntries(MARKET_ROWS.filter(r => r.group === 'india' && !(missing && r.id === 'nifty')).map(r => [r.id, primary(r, 23446.8, disagree && r.id === 'nifty' ? 23270.6 : 23329)])) });
    }
    assert.equal(init.headers?.authorization, undefined, 'no Upstox credential goes to another provider');
    if (String(url).includes('finance.yahoo.com')) {
      const symbol = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      return Response.json(chart(MARKET_ROWS.find(r => r.symbol === symbol)));
    }
    return new Response('', { status: 503 });
  };
  const env = { UPSTOX_ACCESS_TOKEN: 'fixture-secret', ASSETS: { fetch: async request => {
    try { return new Response(readFileSync(new URL(`../public${new URL(request.url).pathname}`, import.meta.url))); }
    catch { return new Response('', { status: 404 }); }
  } } };
  const markets = await readMarkets({ env, fetcher, now: at });
  assert.equal(markets.rows.length, MARKET_ROWS.length); assert.equal(markets.upstox.checked, 8);
  assert.equal(markets.rows.find(r => r.id === 'nifty').verification, 'cross-checked');
  disagree = true;
  const conflicted = await readMarkets({ env, fetcher, now: at });
  assert.deepEqual(conflicted.conflicts, ['nifty']);
  const brief = await buildBrief({ edition: 'evening', day: '2026-09-23', settings: DEFAULT_SETTINGS, env, fetcher, now: at });
  const html = renderBriefHtml(brief), text = renderBriefText(brief);
  assert.match(html, /daily change withheld: sources disagree/); assert.match(text, /daily change withheld: sources disagree/);
  assert(!html.includes("today&#39;s close")); assert(!text.includes('+0.76%'));
  assert.match(Buffer.from(renderBriefPdf(brief)).toString('latin1'), /daily change withheld/);
  disagree = false; missing = true;
  const partial = await readMarkets({ env, fetcher, now: at });
  assert.equal(partial.rows.find(r => r.id === 'nifty').origin, 'yahoo');
  assert.equal(partial.rows.find(r => r.id === 'niftybank').origin, 'upstox');
  tokenRejected = true;
  const fallback = await readMarkets({ env, fetcher, now: at });
  assert.equal(fallback.upstox.reason, 'authentication'); assert.equal(fallback.rows.find(r => r.id === 'nifty').verification, 'single-source');
});
