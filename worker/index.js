// Cloudflare Worker entry point.
//
// The dashboard is static assets (./public), served through the ASSETS binding. This Worker
// adds two routes on top:
//
//   POST /api/live-prices  { tickers: [...] }  ->  { generated_at, source, ticker_count, prices }
//   GET  /api/earnings                         ->  the live Moneycontrol results feed
//
// Neither writes anything back to the repo; both are read-through overlays on committed data.

import { fetchLatestResults, freshnessOf } from './mc.mjs';

const MUNSHOT_API = 'https://fastapi.muns.io/stock-data';
const REQ_TIMEOUT_MS = 8000;
const MAX_TICKERS = 60;

// How long the edge holds one upstream response. This is the whole reason the browser polls us
// rather than Moneycontrol directly: a thousand readers on the tab cost Moneycontrol ONE fetch
// per window, not a thousand. Worst-case staleness is EARNINGS_TTL + the client's poll interval.
const EARNINGS_TTL_S = 30;
const EARNINGS_SNAPSHOT = '/data/earnings-live.json';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------------------
    // API ROUTES
    // Add new handlers here and keep them in their own module once this grows past a
    // couple of routes. Everything not matched falls through to the static assets.
    // ---------------------------------------------------------------------------------
    if (url.pathname === '/api/live-prices') {
      return handleLivePrices(request);
    }
    if (url.pathname === '/api/earnings') {
      return handleEarnings(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not implemented', path: url.pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------------------
// GET /api/earnings — the live results feed.
//
// Proxies Moneycontrol's Rapid Results API, normalises it (worker/mc.mjs), and caches the
// result at the edge for EARNINGS_TTL_S.
//
// WHY PROXY AT ALL, GIVEN MONEYCONTROL SENDS `access-control-allow-origin: *`?
// The browser could call them directly. Three reasons not to:
//   1. Politeness and cost. One upstream fetch per 30s window serves every reader.
//   2. A fallback. If the upstream 403s or changes shape, we serve the last committed snapshot
//      and SAY SO in `degraded`, instead of the tab going blank.
//   3. One place to normalise. The snapshot on disk and the live response come out of the same
//      code path (mc.mjs), so the fallback can never disagree with the live feed about shape.
//
// `?subType=qoq` and `?category=std|con` pass through; anything else is ignored rather than
// forwarded, so this cannot be used as an open proxy to arbitrary upstream paths.
// ---------------------------------------------------------------------------------------
async function handleEarnings(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const subType = url.searchParams.get('subType') === 'qoq' ? 'qoq' : 'yoy';
  const category = ['std', 'con'].includes(url.searchParams.get('category')) ? url.searchParams.get('category') : 'all';

  // Cache key is the normalised option set, not the raw URL — so a stray tracking param can't
  // fragment the cache and multiply upstream fetches.
  const cacheKey = new Request(`https://cache.invalid/earnings?subType=${subType}&category=${category}`, { method: 'GET' });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('x-sattva-cache', 'hit');
    return r;
  }

  let payload;
  try {
    const { rows, meta } = await fetchLatestResults({ limit: 5000, subType, category });
    if (!rows.length) throw new Error('upstream returned no rows');
    payload = { ok: true, degraded: null, ...freshnessOf(rows), meta, rows };
  } catch (err) {
    // Upstream is down, rate-limited, or has changed shape. Serve the committed snapshot and
    // label it, rather than an empty feed that would read as "no results reported".
    const fallback = await loadSnapshot(env, request);
    if (!fallback) {
      return json({ ok: false, degraded: `upstream failed and no snapshot is available: ${String(err.message || err)}`, rows: [] }, 502);
    }
    payload = {
      ...fallback,
      ok: true,
      degraded: `Live feed unavailable (${String(err.message || err)}) — showing the last committed snapshot.`,
    };
    const res = json(payload, 200);
    res.headers.set('cache-control', 'public, max-age=10'); // retry the upstream sooner than usual
    res.headers.set('x-sattva-cache', 'fallback');
    return res;
  }

  const res = json(payload, 200);
  res.headers.set('cache-control', `public, max-age=${EARNINGS_TTL_S}`);
  res.headers.set('x-sattva-cache', 'miss');
  // Store a clone; the response body can only be read once.
  ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
  return res;
}

/** The committed last-good file, read through the ASSETS binding. Null if it isn't there. */
async function loadSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(EARNINGS_SNAPSHOT, request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function handleLivePrices(request) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let tickers;
  try {
    const body = await request.json();
    tickers = Array.isArray(body?.tickers) ? body.tickers : [];
  } catch {
    return json({ error: 'bad request body' }, 400);
  }
  tickers = [...new Set(tickers.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))].slice(0, MAX_TICKERS);
  if (!tickers.length) return json({ error: 'no tickers' }, 400);

  const prices = {};
  let ok = 0;
  await Promise.all(
    tickers.map(async (t) => {
      const q = await fetchQuote(t);
      if (q) {
        prices[t] = q;
        ok++;
      }
    })
  );

  // A refresh that fetched nothing is a failure, not an empty "fresh" feed — the caller keeps
  // its last-known prices rather than blanking the display.
  if (!ok) return json({ error: 'no quotes retrieved' }, 502);

  return json(
    {
      generated_at: new Date().toISOString(),
      source: 'Munshot quote API (on-demand refresh)',
      ticker_count: ok,
      prices,
    },
    200
  );
}

// One quote from Munshot. Returns null on any error so a single bad ticker never fails the
// whole refresh.
async function fetchQuote(ticker) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(MUNSHOT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker_symbol: ticker, type: 'stockquote', country: 'india' }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json(); // API returns a quoted CSV-ish string
      if (typeof body !== 'string') throw new Error('unexpected shape');
      return parseQuote(body);
    } catch {
      if (attempt === 1) return null;
      await new Promise((res) => setTimeout(res, 300)); // brief pause before the single retry
    }
  }
  return null;
}

// "Current Price=1341.8,...,Day Range=1268.9 - 1359.0,..." -> structured quote.
function parseQuote(str) {
  const kv = {};
  for (const part of str.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    kv[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const num = (v) => {
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const range = (v) => {
    const m = String(v || '')
      .split('-')
      .map((s) => num(s));
    return m.length === 2 && m[0] != null && m[1] != null ? { lo: Math.min(m[0], m[1]), hi: Math.max(m[0], m[1]) } : null;
  };
  const day = range(kv['Day Range']);
  const wk = range(kv['52-Week Range']);
  const current = num(kv['Current Price']);
  if (current == null) return null;
  return {
    current,
    open: num(kv['Opening Price']),
    prevClose: num(kv['Previous Close']),
    dayHigh: day?.hi ?? null,
    dayLow: day?.lo ?? null,
    week52High: wk?.hi ?? null,
    week52Low: wk?.lo ?? null,
    ma50: num(kv['50-Day Moving Average']),
    ma200: num(kv['200-Day Moving Average']),
    vol10d: num(kv['10-Day Average Volume']),
    marketCap: num(kv['Market Cap']),
    yearlyChangePct: num(kv['Yearly Change (%)']),
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      // The dashboard is same-origin with this Worker, so CORS is not needed for our own page.
      // It is here so the feed can be pulled from a local `python3 -m http.server` during
      // development without standing up wrangler.
      'access-control-allow-origin': '*',
    },
  });
}
