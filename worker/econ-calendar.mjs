// worker/econ-calendar.mjs — GET /api/econ-calendar, the ECONOMIC RELEASE CALENDAR. GLOW-OWNED.
//
// A proxy for TradingView's calendar endpoint, ported from `functions/api/econ-calendar.js` in
// techmuns/GlowVentures, where it was measured against five sources: Bloomberg 403s,
// TradingEconomics' free API is discontinued (HTTP 410), moneycontrol and Sensibull expose no JSON,
// Nasdaq's answers but with an off-by-one date and no unit, and TradingView's answers freely with
// the field this dashboard cares most about — `source`, the AGENCY that published each figure.
//
// FOUR THINGS A NAIVE CLIENT WOULD GET WRONG, all measured there:
//   1. THE ORIGIN AND REFERER HEADERS ARE MANDATORY — without them the upstream answers 403. That is
//      why this is a Worker route and not a fetch from the browser, which could not set them.
//   2. THE RESPONSE IS CAPPED AT 2000 EVENTS AND THE CAP IS SILENT. A month in one request returns
//      exactly 2000 rows; the same month as four sub-windows returns 2180 distinct ids. So every
//      window is SPLIT into ≤7-day slices, merged on the event id, and a slice still at the cap is
//      reported in `truncated` rather than presented as a complete answer.
//   3. THE FORWARD HORIZON IS ABOUT A MONTH, and that is the upstream's. History runs back years.
//   4. `importance` IS -1 / 0 / 1 (low / medium / high), verified against known-high events. It is
//      passed through as the upstream's number; the label is applied once, on the client.
//
// It needs no token. Cached at the edge as one bundle per host — `caches.default` is shared by every
// Worker on the account, so the key names the deployment, the same rule as `edgeKey` in index.js —
// held six hours, served without a re-fetch for fifteen minutes (an `actual` lands the moment the
// agency publishes), and a total upstream failure serves the last held copy marked `stale`.

import { CORS } from './http.mjs';

const UPSTREAM = 'https://economic-calendar.tradingview.com/events';
const ORIGIN = 'https://in.tradingview.com';
const UPSTREAM_ROW_CAP = 2000;
const SLICE_DAYS = 7;
const MAX_SPAN_DAYS = 120;
const CACHE_TTL_S = 6 * 3600;
const FRESH_S = 900;
const TIMEOUT_MS = 20000;
const dayMs = 864e5;

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra } });

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** One bundled cache entry per host: `{ [windowKey]: { at, v } }`. */
function bundleKey(request) {
  return new Request(`https://cache.invalid/${new URL(request.url).host}/econ-calendar/v2/bundle`, { method: 'GET' });
}
async function readBundle(request) {
  try {
    const hit = await caches.default.match(bundleKey(request));
    if (!hit) return {};
    const obj = await hit.json();
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}
async function writeBundle(request, bundle) {
  try {
    const now = Date.now();
    const kept = {};
    for (const [k, rec] of Object.entries(bundle || {})) if (rec && typeof rec.at === 'number' && now - rec.at < CACHE_TTL_S * 1000) kept[k] = rec;
    await caches.default.put(bundleKey(request), new Response(JSON.stringify(kept), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_TTL_S}` } }));
  } catch {
    /* a cache write that fails costs one re-fetch, nothing else */
  }
}
const ageS = (bundle, key, now = Date.now()) => (bundle?.[key] && typeof bundle[key].at === 'number' ? (now - bundle[key].at) / 1000 : Infinity);

function slices(fromISO, toISO) {
  const out = [];
  let t = Date.parse(fromISO);
  const end = Date.parse(toISO);
  while (t < end) {
    const next = Math.min(t + SLICE_DAYS * dayMs, end);
    out.push([new Date(t).toISOString(), new Date(next).toISOString()]);
    t = next;
  }
  return out;
}

async function fetchSlice(from, to, countries, signal) {
  const u = new URL(UPSTREAM);
  u.searchParams.set('from', from);
  u.searchParams.set('to', to);
  if (countries) u.searchParams.set('countries', countries);
  const r = await fetch(u.toString(), { headers: { accept: 'application/json', origin: ORIGIN, referer: `${ORIGIN}/`, 'user-agent': 'Mozilla/5.0' }, signal });
  if (!r.ok) return { ok: false, status: r.status };
  const d = await r.json().catch(() => null);
  if (!d || d.status !== 'ok' || !Array.isArray(d.result)) return { ok: false, status: r.status, shape: true };
  return { ok: true, rows: d.result };
}

/** Only the fields the dashboard renders, normalised. A missing number stays NULL — never 0. */
function shape(e) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    id: String(e.id ?? ''), date: str(e.date), country: str(e.country), title: typeof e.title === 'string' ? e.title : '',
    indicator: str(e.indicator), category: str(e.category), period: str(e.period), referenceDate: str(e.referenceDate),
    importance: num(e.importance), actual: num(e.actual), forecast: num(e.forecast), previous: num(e.previous),
    unit: str(e.unit), currency: str(e.currency), source: str(e.source), sourceUrl: str(e.source_url), comment: str(e.comment),
  };
}

export async function handleEconCalendar(request) {
  if (request.method !== 'GET') return json({ ok: false, failureCode: 'METHOD', detail: 'GET only.' }, 405);
  const started = Date.now();
  const u = new URL(request.url);
  const from = u.searchParams.get('from');
  const to = u.searchParams.get('to');
  const countries = (u.searchParams.get('countries') ?? '').replace(/[^A-Za-z,]/g, '').toUpperCase() || '';

  if (!isDate(from) || !isDate(to)) return json({ ok: false, failureCode: 'BAD_RANGE', detail: 'from and to must be YYYY-MM-DD' }, 400);
  const spanDays = (Date.parse(to) - Date.parse(from)) / dayMs;
  if (spanDays <= 0) return json({ ok: false, failureCode: 'BAD_RANGE', detail: 'to must be after from' }, 400);
  if (spanDays > MAX_SPAN_DAYS) return json({ ok: false, failureCode: 'RANGE_TOO_WIDE', detail: `at most ${MAX_SPAN_DAYS} days per request` }, 400);

  const key = `${from}..${to}|${countries || 'ALL'}`;
  const bundle = await readBundle(request);
  const now = Date.now();
  if (ageS(bundle, key, now) < FRESH_S && bundle[key]?.v) {
    return json({ ok: true, cached: true, stale: false, ...bundle[key].v, totalDurationMs: Date.now() - started }, 200, { 'x-sattva-cache': 'hit' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const windows = slices(`${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
    const results = await Promise.all(windows.map(([a, b]) => fetchSlice(a, b, countries, controller.signal).catch(() => ({ ok: false, status: null }))));
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length) {
      const held = bundle[key];
      if (held?.v) {
        return json({ ok: true, cached: true, stale: true, ageS: Math.round(ageS(bundle, key, now)), servedAt: new Date(held.at).toISOString(), upstreamFailure: { failureCode: 'UPSTREAM_ERROR', upstreamStatus: failed[0].status ?? null }, ...held.v, totalDurationMs: Date.now() - started }, 200, { 'x-sattva-cache': 'stale' });
      }
      return json({ ok: false, failureCode: failed[0].status ? 'UPSTREAM_ERROR' : 'UPSTREAM_NO_RESPONSE', upstreamStatus: failed[0].status ?? null, totalDurationMs: Date.now() - started });
    }
    const byId = new Map();
    let cappedSlices = 0;
    for (const r of results) {
      if (!r.ok) continue;
      if (r.rows.length >= UPSTREAM_ROW_CAP) cappedSlices += 1;
      for (const e of r.rows) {
        const s = shape(e);
        if (s.id && s.date) byId.set(s.id, s);
      }
    }
    const events = [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));
    const value = {
      from, to, countries: countries ? countries.split(',') : [], events, count: events.length,
      truncated: cappedSlices > 0, truncatedSlices: cappedSlices, slices: results.length, slicesFailed: failed.length,
      source: 'TradingView economic calendar', fetchedAt: new Date().toISOString(),
    };
    bundle[key] = { at: Date.now(), v: value };
    await writeBundle(request, bundle);
    return json({ ok: true, cached: false, stale: false, ...value, totalDurationMs: Date.now() - started }, 200, { 'x-sattva-cache': 'live' });
  } catch (e) {
    const held = bundle[key];
    if (held?.v) {
      return json({ ok: true, cached: true, stale: true, ageS: Math.round(ageS(bundle, key, now)), upstreamFailure: { failureCode: 'NETWORK', detail: String((e && e.message) || e) }, ...held.v, totalDurationMs: Date.now() - started }, 200, { 'x-sattva-cache': 'stale' });
    }
    return json({ ok: false, failureCode: 'NETWORK', detail: String((e && e.message) || e) });
  } finally {
    clearTimeout(timer);
  }
}
