// Cloudflare Worker entry point.
//
// The dashboard is static assets (./public), served through the ASSETS binding. This Worker
// adds two routes on top:
//
//   POST /api/live-prices  { tickers: [...] }  ->  { generated_at, source, ticker_count, prices }
//   GET  /api/earnings                         ->  the live Moneycontrol results feed
//   GET  /api/earnings-calendar                ->  who is SCHEDULED to report, and when
//   GET  /api/concalls                         ->  the live StockScans con-call scan
//
// Neither writes anything back to the repo; both are read-through overlays on committed data.

import { fetchLatestResults, freshnessOf, resolveMissing, applyIdentity, fetchCalendarStrip, fetchCalendarDay, CALENDAR_LIST_CAP } from './mc.mjs';
import { fetchConcallScans, fetchUpcoming, fetchToday, mergeScans, PAGE_SIZE } from './stockscans.mjs';

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
    if (url.pathname === '/api/earnings-calendar') {
      return handleCalendar(request, env, ctx);
    }
    if (url.pathname === '/api/concalls') {
      return handleConcalls(request, env, ctx);
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

    // Identity from the committed map, plus on-the-fly resolution for anything it has never seen.
    // A company that reports today is not in a map built yesterday, and those are precisely the
    // rows at the top of a live results table — shipping them with no ticker, market cap or
    // industry would make the freshest data the least useful data on the page.
    const known = (await loadTickerMap(env, request)) || {};
    const { resolved, attempted, failed } = await resolveMissing(rows, known, { limit: 40 });
    const merged = Object.keys(resolved).length ? { ...known, ...resolved } : known;

    payload = {
      ok: true,
      degraded: null,
      ...freshnessOf(rows),
      meta: { ...meta, resolvedOnTheFly: attempted, unresolved: failed },
      rows: applyIdentity(rows, merged),
    };
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

// ---------------------------------------------------------------------------------------
// GET /api/earnings-calendar?date=YYYY-MM-DD&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The forward-looking half of the Earnings Hub. Two upstreams, because Moneycontrol splits it:
// a clean JSON date strip with the COMPLETE count per date, and the calendar page itself for the
// company list — which is the twenty largest by market cap and cannot be paged past. See the
// header of mc.mjs. Both numbers travel, so the UI can say "170 reporting, 20 shown".
//
// Cached longer than the results feed (CALENDAR_TTL_S vs 30s) because a schedule changes on the
// order of hours, not ticks. The strip is fetched even when the day list fails, so a reader always
// learns how many companies report — an empty list would read as "nobody reports that day".
// ---------------------------------------------------------------------------------------
const CALENDAR_TTL_S = 300;

async function handleCalendar(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const date = iso(url.searchParams.get('date'));
  if (!date) return json({ error: 'date=YYYY-MM-DD is required' }, 400);
  // Default window: a fortnight around the chosen date, which is what the strip is for — seeing
  // where the clusters are without asking for a date you cannot see the shape of.
  const from = iso(url.searchParams.get('from')) || shiftDays(date, -7);
  const to = iso(url.searchParams.get('to')) || shiftDays(date, 14);

  const cacheKey = new Request(`https://cache.invalid/earnings-calendar?date=${date}&from=${from}&to=${to}`, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('x-sattva-cache', 'hit');
    return r;
  }

  // Independent, and deliberately not Promise.all-with-rejection: the strip is the part that is
  // always available, and losing it because the page 403'd would be the wrong trade.
  const [stripOut, dayOut] = await Promise.allSettled([
    fetchCalendarStrip({ fromDate: from, toDate: to }),
    fetchCalendarDay({ date }),
  ]);


  const days = stripOut.status === 'fulfilled' ? stripOut.value : [];

  // The list has two possible origins and the payload must say which. Live is preferred; the
  // committed capture is the fallback, because Akamai answers a Cloudflare Worker's request for
  // the calendar page with a 200 carrying no app payload. Counts stay live either way, so a
  // schedule that has moved since the capture shows up as the count and the list disagreeing.
  let day = dayOut.status === 'fulfilled' ? dayOut.value : null;
  let listSource = day ? 'live' : null;
  let listCapturedAt = null;
  let listNote = null;

  if (!day) {
    const snap = await loadCalendarSnapshot(env, request);
    const hit = snap?.byDate?.[date];
    if (hit) {
      day = { rows: hit.rows || [], asOnDate: hit.asOnDate || null, capped: !!hit.capped };
      listSource = 'snapshot';
      listCapturedAt = snap.capturedAt || null;
    } else {
      day = { rows: [], asOnDate: null, capped: false };
      listNote = snap
        ? `The committed capture covers ${snap.from} to ${snap.to} and does not include this date.`
        : 'No committed capture is available.';
    }
  }
  // Scheduled-but-not-yet-reported companies are by definition absent from a map built from
  // companies that HAVE reported, so almost every calendar row would arrive with no ticker and no
  // industry. Resolving them here is bounded by the page's own 20-row cap.
  const known = (await loadTickerMap(env, request)) || {};
  const { resolved, attempted, failed } = await resolveMissing(day.rows, known, { limit: 25 });
  const merged = Object.keys(resolved).length ? { ...known, ...resolved } : known;

  const payload = {
    ok: true,
    resolvedOnTheFly: attempted,
    unresolved: failed,
    degraded:
      listSource === 'live'
        ? null
        : listSource === 'snapshot'
          ? null // not degraded — a labelled capture, and the UI prints how old it is
          : `The company list for this date is unavailable (${String(dayOut.reason?.message || dayOut.reason)}). ${listNote || ''} The per-date counts are live.`,
    date,
    from,
    to,
    asOnDate: day.asOnDate,
    listSource,
    listCapturedAt,
    listNote,
    // The two numbers that must never be conflated: how many report, and how many we can name.
    scheduledCount: days.find((d) => d.date === date)?.count ?? null,
    listCap: CALENDAR_LIST_CAP,
    capped: day.capped,
    days,
    rows: applyIdentity(day.rows, merged),
    meta: {
      source: 'Moneycontrol — Results Calendar (api…/earnings/result-calendar for the counts, the calendar page for the list)',
      fetchedAt: new Date().toISOString(),
    },
  };

  // Nothing at all: no counts and no list. That is a real outage, not a partial view.
  if (!days.length && !payload.rows.length) {
    return json({ ok: false, degraded: `calendar upstream unavailable: ${String(stripOut.reason?.message || stripOut.reason || 'no data')}`, days: [], rows: [] }, 502);
  }

  const res = json(payload, 200);
  res.headers.set('cache-control', `public, max-age=${CALENDAR_TTL_S}`);
  res.headers.set('x-sattva-cache', 'miss');
  res.headers.set('x-sattva-list-source', listSource || 'none');
  ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
  return res;
}

// ---------------------------------------------------------------------------------------
// GET /api/concalls — the live con-call scan, from StockScans.
//
// TWO CACHES, ONE ROUTE, BECAUSE THE FEED IS SORTED NEWEST-FIRST.
// A quarter is ~880 calls across 18 pages. Re-pulling all eighteen every 30 seconds to catch one
// new row would be both slow and rude to someone else's server. But the feed descends by call
// time from offset 0, verified across a full quarter, so a call that has just been analysed can
// only appear on page ONE. That makes the split safe:
//
//   HEAD  offset 0, 50 rows   — cached CONCALL_HEAD_TTL_S (30s). The freshness path.
//   TAIL  offset 50 onwards   — cached CONCALL_TAIL_TTL_S (10 min). It cannot change.
//
// The head is merged OVER the tail, so a row whose analysis landed between the two fetches is
// taken from the head with its score rather than from the tail without one.
//
// In steady state that is one upstream request per 30 seconds instead of eighteen.
// ---------------------------------------------------------------------------------------
const CONCALL_HEAD_TTL_S = 30;
const CONCALL_TAIL_TTL_S = 600;
const CONCALL_SCHEDULE_TTL_S = 120;
const CONCALL_SNAPSHOT = '/data/concall-scans.json';

async function handleConcalls(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
  const cache = caches.default;

  // A tiny helper so the three sub-fetches share one caching shape. Each caches its own JSON
  // under its own key and TTL; the route itself is never cached as a whole, because its parts
  // expire at very different rates.
  const cached = async (key, ttl, load) => {
    const cacheKey = new Request(`https://cache.invalid/concalls/${key}`, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return { value: await hit.json(), fresh: false };
    const value = await load();
    const res = json(value, 200);
    res.headers.set('cache-control', `public, max-age=${ttl}`);
    ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
    return { value, fresh: true };
  };

  try {
    const [head, tail, sched] = await Promise.all([
      cached('head', CONCALL_HEAD_TTL_S, () => fetchConcallScans({ pages: 1 })),
      cached('tail', CONCALL_TAIL_TTL_S, () => fetchConcallScans({ pages: 'all', startOffset: PAGE_SIZE })),
      cached('schedule', CONCALL_SCHEDULE_TTL_S, async () => {
        const [upcoming, today] = await Promise.all([fetchUpcoming(), fetchToday()]);
        return { upcoming, today };
      }),
    ]);

    const rows = mergeScans(head.value.rows, tail.value.rows);
    if (!rows.length) throw new Error('upstream returned no rows');

    const payload = {
      ok: true,
      degraded: null,
      rows,
      upcoming: sched.value.upcoming || [],
      today: sched.value.today || { day: null, rows: [] },
      meta: {
        ...head.value.meta,
        headRows: head.value.rows.length,
        tailRows: tail.value.rows.length,
        // True if OUR page bound stopped the walk, not the feed's own end. A truncated quarter
        // must not be presented as the whole quarter.
        truncated: !!tail.value.meta.truncated,
        headFresh: head.fresh,
        servedAt: new Date().toISOString(),
      },
    };
    const res = json(payload, 200);
    res.headers.set('cache-control', `public, max-age=${CONCALL_HEAD_TTL_S}`);
    res.headers.set('x-sattva-cache', head.fresh ? 'miss' : 'hit');
    return res;
  } catch (err) {
    const fallback = await loadConcallSnapshot(env, request);
    if (!fallback) {
      return json({ ok: false, degraded: `StockScans is unreachable and no snapshot is available: ${String(err.message || err)}`, rows: [] }, 502);
    }
    const res = json(
      { ...fallback, ok: true, degraded: `StockScans is unavailable (${String(err.message || err)}) — showing the last committed snapshot.` },
      200
    );
    res.headers.set('cache-control', 'public, max-age=15'); // retry sooner than a normal window
    res.headers.set('x-sattva-cache', 'fallback');
    return res;
  }
}

/** The committed con-call snapshot, read through the ASSETS binding. */
async function loadConcallSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(CONCALL_SNAPSHOT, request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The committed calendar capture, read through the ASSETS binding. Null if it isn't there. */
async function loadCalendarSnapshot(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/earnings-calendar.json', request.url)));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** "2026-08-11", -7 -> "2026-08-04". UTC arithmetic so a timezone can never move a date. */
function shiftDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The committed scID -> identity map, read through the ASSETS binding. */
async function loadTickerMap(env, request) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/data/mc-ticker-map.json', request.url)));
    if (!res.ok) return null;
    return (await res.json())?.map || null;
  } catch {
    return null;
  }
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
