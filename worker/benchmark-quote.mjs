import { readNseIndices, readUpstoxIndices } from './newsletter-markets.mjs';
import { tagged, withTag, revalidate } from './http.mjs';

// GET /api/benchmark-quote -> the Nifty 500's current level, for the Portfolio tab's alpha. GLOW-OWNED.
//
// The Portfolio tab measures each holding's return against the Nifty 500 over the same period, and
// the desk asked for that alpha to move with the market rather than with yesterday's close. The
// browser cannot read an exchange index itself (NSE answers a browser with no CORS header), so this
// route reads it with the two validated readers the team brief already uses for its Indian market
// table: Upstox's exact `NSE_INDEX|Nifty 500` cash index (the token the Worker already holds), then
// NSE's own allIndices snapshot. Nothing is computed here — the level and its timestamp are the
// source's, and `state` says whether that is a live print, a close, a delayed print or an earlier
// session, in the reader's own words (worker/newsletter-markets.mjs).
//
// A FAILED READ IS NEVER A LEVEL. `ok: false` carries the reason from each source and no `last`, so
// the tab falls back to the latest captured close and says it did — it never measures against a
// zero. One edge entry per deployment, 30 seconds: every reader polling the Portfolio tab shares one
// upstream read a half-minute, and a failure is cached for 15 seconds so an outage costs each
// reader one timeout, not one per poll.

const ROW = { id: 'nifty500', label: 'Nifty 500', group: 'india', symbol: '^CRSLDX' };
const TTL_S = 30;
const FAIL_TTL_S = 15;

export function quotePayload(quote, origin, reasons) {
  if (!quote) return { ok: false, id: ROW.id, name: ROW.label, reason: 'unavailable', sources: reasons };
  return {
    ok: true,
    id: ROW.id,
    name: ROW.label,
    last: quote.last,
    prev: quote.prev ?? null,
    changePct: quote.changePct ?? null,
    asOf: new Date(quote.asOf).toISOString(),
    sessionDate: quote.sessionDate,
    state: quote.state,
    origin,
    sources: reasons,
  };
}

export async function readBenchmark(env, { fetcher = fetch, now = Date.now() } = {}) {
  const [upstox, nse] = await Promise.all([
    readUpstoxIndices([ROW], { token: env?.UPSTOX_ACCESS_TOKEN, fetcher, now }),
    readNseIndices([ROW], { fetcher, now }),
  ]);
  const reasons = { upstox: upstox.reason || upstox.failures?.[ROW.id] || null, nse: nse.reason || nse.failures?.[ROW.id] || null };
  const fromUpstox = upstox.rows.get(ROW.id) || null;
  const fromNse = nse.rows.get(ROW.id) || null;
  // The exchange's own snapshot and the broker feed describe one index; the newer print wins, and
  // a tie goes to the exchange.
  const pick = [fromNse && ['nse', fromNse], fromUpstox && ['upstox', fromUpstox]].filter(Boolean)
    .sort((a, b) => b[1].asOf - a[1].asOf)[0] || null;
  return quotePayload(pick?.[1] || null, pick?.[0] || null, reasons);
}

export async function handleBenchmarkQuote(request, env, { fetcher = fetch, now = Date.now, edgeCache = globalThis.caches?.default, cacheKey = null } = {}) {
  if (request.method !== 'GET') return Response.json({ ok: false, reason: 'method' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  if (edgeCache && cacheKey) {
    const cached = await edgeCache.match(cacheKey).catch(() => null);
    if (cached) return revalidate(request, cached, 'edge');
  }
  let payload;
  try {
    payload = await readBenchmark(env, { fetcher, now: now() });
  } catch {
    payload = quotePayload(null, null, { upstox: 'unavailable', nse: 'unavailable' });
  }
  const { body, tag } = withTag(payload);
  const response = tagged(body, tag, payload.ok ? TTL_S : FAIL_TTL_S);
  if (edgeCache && cacheKey) await edgeCache.put(cacheKey, response.clone()).catch(() => {});
  return revalidate(request, response, 'live');
}
