// Cloudflare Worker entry point.
//
// The dashboard is static assets (./public), served through the ASSETS binding. This Worker
// adds one small route on top:
//
//   POST /api/live-prices  { tickers: [...] }  ->  { generated_at, source, ticker_count, prices }
//
// so the Breakouts tab's "Refresh prices" button can pull the very latest quotes on demand,
// server-side. That keeps it fast (no rebuild) and token-free (no secret ever reaches the
// browser). It is session-only: nothing is written back to the repo.
//
// The committed public/data/technicals.json remains the EOD baseline the dashboard loads on
// first paint, refreshed by .github/workflows/technicals-refresh.yml. This endpoint is an
// on-demand overlay on top of that, not a replacement.

const MUNSHOT_API = 'https://fastapi.muns.io/stock-data';
const REQ_TIMEOUT_MS = 8000;
const MAX_TICKERS = 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------------------
    // API ROUTES
    // Add new handlers here and keep them in their own module once this grows past a
    // couple of routes. Everything not matched falls through to the static assets.
    // ---------------------------------------------------------------------------------
    if (url.pathname === '/api/live-prices') {
      return handleLivePrices(request);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not implemented', path: url.pathname }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

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
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
