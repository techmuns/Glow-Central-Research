// Cloudflare Worker entry point.
//
// The dashboard is static assets (./public), served through the ASSETS binding. This Worker
// adds two routes on top:
//
//   POST /api/live-prices  { tickers: [...] }  ->  { generated_at, source, ticker_count, prices }
//   GET  /api/earnings                         ->  the live Moneycontrol results feed
//   GET  /api/earnings?fields=prices           ->  just the traded prices, for the poll
//   GET  /api/earnings-calendar                ->  who is SCHEDULED to report, and when
//   GET  /api/concalls                         ->  the live StockScans con-call scan
//   GET  /api/super-investors                  ->  the tracked super-investor list (Finology)
//   GET  /api/super-investors/{slug}           ->  one investor's book, quarter by quarter
//
// None writes anything back to the repo; all are read-through overlays on committed data.
//
// THE SUPER-INVESTOR ROUTES EXIST TO HOLD A CREDENTIAL. Unlike every other upstream here, that
// API needs `Authorization: Bearer …`. A token in front-end code is a token published, so the
// browser calls this Worker and the Worker adds the header from `env.MUNS_TOKEN` — the same
// reason /api/live-prices is proxied. Set it with `npx wrangler secret put MUNS_TOKEN`.
//
// EVERY GET ROUTE HERE IS CONDITIONAL — see `withTag` / `revalidate` at the foot of this file.
// The two big feeds are polled every 30 seconds and are 1.1MB and 450KB of JSON. Answering
// "nothing has changed" by re-sending the whole thing, 120 times an hour, is the single largest
// waste in the system. So each response carries a content-derived ETag, and a request that
// arrives with a matching `If-None-Match` gets a 304 with no body at all.

import { fetchLatestResults, freshnessOf, resolveMissing, applyIdentity, fetchCalendarStrip, fetchCalendarDay, CALENDAR_LIST_CAP } from './mc.mjs';
import { fetchConcallScans, fetchUpcoming, fetchToday, mergeScans, PAGE_SIZE } from './stockscans.mjs';
import { fetchInvestorList, fetchInvestorPortfolio, isSlug } from './finology.mjs';
import { fetchDashboard as fetchChatter, fetchHealth as fetchChatterHealth } from './sentiment.mjs';
import { CORS, preflight, contentTag, withTag, tagged, revalidate } from './http.mjs';

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
    // A conditional GET carries `If-None-Match`, which is not a CORS-safelisted request header, so
    // a cross-origin caller preflights it. Production is same-origin and never sees this; local
    // development, where the static site and the Worker sit on different ports, does.
    if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
      return preflight();
    }
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
    if (url.pathname === '/api/chatter') {
      return handleChatter(request, env, ctx);
    }
    if (url.pathname === '/api/super-investors') {
      return handleInvestorList(request, env, ctx);
    }
    if (url.pathname.startsWith('/api/super-investors/')) {
      return handleInvestorPortfolio(request, env, ctx, url.pathname.slice('/api/super-investors/'.length));
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
//
// TWO REPRESENTATIONS, BECAUSE ONLY ONE FIELD MOVES ON A TICK.
// `?fields=prices` returns the traded price and day change per scID and nothing else — measured at
// 30KB against 1.1MB for the full feed. This exists because the results feed is the one place
// where a conditional GET alone buys nothing: `ltp` moves on every tick during market hours, so
// the full representation genuinely changes every 30 seconds even though not one reported figure
// has. Splitting the volatile field out means the poll carries only what actually moved.
//
// The projection carries `structureTag` — a tag over identity and the REPORTED FIGURES, price
// excluded. The client refetches the full feed exactly when that moves, which is when a company
// has filed or revised. So a filing still reaches the screen on the very next tick.
// ---------------------------------------------------------------------------------------
async function handleEarnings(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const url = new URL(request.url);
  const subType = url.searchParams.get('subType') === 'qoq' ? 'qoq' : 'yoy';
  const category = ['std', 'con'].includes(url.searchParams.get('category')) ? url.searchParams.get('category') : 'all';
  const fields = url.searchParams.get('fields') === 'prices' ? 'prices' : 'full';

  // Cache key is the normalised option set, not the raw URL — so a stray tracking param can't
  // fragment the cache and multiply upstream fetches. The two representations are cached
  // separately so the poll never has to parse the 1.1MB one to answer with 10KB.
  const cache = caches.default;
  const fullKey = edgeKey(`earnings?subType=${subType}&category=${category}`);
  const pricesKey = edgeKey(`earnings-prices?subType=${subType}&category=${category}`);

  const hit = await cache.match(fields === 'prices' ? pricesKey : fullKey);
  if (hit) return revalidate(request, hit, 'hit');

  // The other representation may still be warm. Deriving the projection from a cached full payload
  // is a parse rather than an upstream fetch, and the two keys can be evicted independently.
  if (fields === 'prices') {
    const warm = await cache.match(fullKey);
    if (warm) {
      const { body, tag } = withTag(pricesPayload(await warm.json()));
      ctx?.waitUntil?.(cache.put(pricesKey, tagged(body, tag, EARNINGS_TTL_S)));
      return revalidate(request, tagged(body, tag, EARNINGS_TTL_S), 'derived');
    }
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

    const joined = applyIdentity(rows, merged);
    payload = {
      ok: true,
      degraded: null,
      ...freshnessOf(rows),
      meta: { ...meta, resolvedOnTheFly: attempted, unresolved: failed, structureTag: structureTagOf(joined, `${subType}|${category}`) },
      rows: joined,
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
      meta: { ...(fallback.meta || {}), structureTag: structureTagOf(fallback.rows || [], `${subType}|${category}|snapshot`) },
    };
    // Retry the upstream sooner than usual, and do not poison the edge cache with the fallback —
    // a degraded answer must not be handed to the next reader for a full window.
    const { body, tag } = withTag(fields === 'prices' ? pricesPayload(payload) : payload);
    return revalidate(request, tagged(body, tag, 10), 'fallback');
  }

  const full = withTag(payload);
  const prices = withTag(pricesPayload(payload));
  ctx?.waitUntil?.(
    Promise.all([
      cache.put(fullKey, tagged(full.body, full.tag, EARNINGS_TTL_S)),
      cache.put(pricesKey, tagged(prices.body, prices.tag, EARNINGS_TTL_S)),
    ])
  );
  const out = fields === 'prices' ? prices : full;
  return revalidate(request, tagged(out.body, out.tag, EARNINGS_TTL_S), 'miss');
}

/**
 * The polling projection: scID -> [ltp, changePct], plus the structure tag that tells the client
 * whether it still holds the right rows underneath those prices.
 *
 * A two-element array rather than an object per row on purpose — `"CHC":[1191,6.43]` is 20 bytes
 * where `{"ltp":1191,"changePct":6.43}` is 44, and there are 1,384 of them.
 */
function pricesPayload(payload) {
  const prices = {};
  for (const r of payload.rows || []) {
    if (r.ltp == null && r.changePct == null) continue;
    prices[r.scId] = [r.ltp ?? null, r.changePct ?? null];
  }
  return {
    ok: true,
    fields: 'prices',
    structureTag: payload.meta?.structureTag || null,
    latestResultDate: payload.latestResultDate ?? null,
    count: (payload.rows || []).length,
    degraded: payload.degraded || null,
    prices,
    meta: {
      subType: payload.meta?.subType || null,
      category: payload.meta?.category || null,
      quarter: payload.meta?.quarter || null,
      currentPeriod: payload.meta?.currentPeriod || null,
      priorPeriod: payload.meta?.priorPeriod || null,
      source: payload.meta?.source || null,
      fetchedAt: payload.meta?.fetchedAt || null,
    },
  };
}

/**
 * A tag over identity and the reported figures, with the traded price DELIBERATELY EXCLUDED.
 *
 * This is the server-side twin of `hasStructuralChange` in js/data/earnings-live.js, and it exists
 * for the same reason: prices move constantly and results do not. A client polling the price
 * projection needs one number that tells it "the rows themselves changed, come and get them", and
 * that number must not move just because someone traded.
 */
function structureTagOf(rows, salt) {
  const fig = (m) => (m ? `${m.current ?? ''},${m.prior ?? ''},${m.reportedPct ?? ''},${m.kind ?? ''}` : '');
  let acc = `${salt}#${rows.length}#`;
  for (const r of rows) {
    acc += `${r.scId}|${r.resultDate}|${r.basis}|${r.ticker || ''}|${fig(r.revenue)}|${fig(r.netProfit)}|${fig(r.grossProfit)}\n`;
  }
  return contentTag(acc);
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

  const cacheKey = edgeKey(`earnings-calendar?date=${date}&from=${from}&to=${to}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return revalidate(request, hit, 'hit');

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

  const { body, tag } = withTag(payload);
  const extra = { 'x-sattva-list-source': listSource || 'none' };
  ctx?.waitUntil?.(cache.put(cacheKey, tagged(body, tag, CALENDAR_TTL_S, extra)));
  return revalidate(request, tagged(body, tag, CALENDAR_TTL_S, extra), 'miss');
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
//
// AND WHY THERE IS NO ?fields= PROJECTION HERE, UNLIKE /api/earnings.
// Nothing on a con-call row moves on a tick. A row appears when the call is held and changes once
// more when StockScans finishes analysing it — a handful of times an hour in season, never
// otherwise. So the conditional GET does the whole job: 119 of every 120 polls are answered with
// a 304 and no body, and the one that is not has to carry the changed rows anyway. Splitting the
// payload would save a few hundred KB an hour and add a merge path that could drift from the
// server's truth; the earnings feed pays that complexity only because its price field leaves it
// no choice.
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
    const cacheKey = edgeKey(`concalls/${key}`);
    const hit = await cache.match(cacheKey);
    if (hit) return { value: await hit.json(), fresh: false };
    const value = await load();
    // These three entries are internal scratch, never handed to a client, so the tag is only
    // there because `tagged` wants one — nothing revalidates against it. The client-facing
    // validator is computed once over the assembled payload below.
    ctx?.waitUntil?.(cache.put(cacheKey, tagged(JSON.stringify(value), contentTag(key), ttl)));
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
      },
    };
    // The body deliberately carries no "served at" stamp. It would differ on every request while
    // the content did not, so the ETag would never match and the 304 this route exists for would
    // never fire. `meta.fetchedAt` — when the upstream was actually read — is the honest freshness
    // signal, and the client stamps its own "last checked" on every poll, 304s included.
    const { body, tag } = withTag(payload);
    return revalidate(request, tagged(body, tag, CONCALL_HEAD_TTL_S, { 'x-sattva-head': head.fresh ? 'fresh' : 'cached' }), head.fresh ? 'miss' : 'hit');
  } catch (err) {
    const fallback = await loadConcallSnapshot(env, request);
    if (!fallback) {
      return json({ ok: false, degraded: `StockScans is unreachable and no snapshot is available: ${String(err.message || err)}`, rows: [] }, 502);
    }
    const { body, tag } = withTag({
      ...fallback,
      ok: true,
      degraded: `StockScans is unavailable (${String(err.message || err)}) — showing the last committed snapshot.`,
    });
    return revalidate(request, tagged(body, tag, 15), 'fallback'); // retry sooner than a normal window
  }
}

// ---------------------------------------------------------------------------------------
// GET /api/chatter — retail chatter across ValuePickr, TradingQnA and Google News
//
// A read-through proxy onto the SentimentDash API. That upstream is public and CORS-open, so the
// browser could call it directly; going through here buys the same two things /api/concalls buys.
// One fetch per cache window instead of one per reader, and a place to turn a failure into a
// named state rather than an empty table.
//
// THE CACHE WINDOW IS THIRTY MINUTES, WHICH IS ALREADY GENEROUS. The upstream re-scrapes twice a
// day, at 01:30 and 13:30 UTC. A shorter window would ask a question whose answer cannot have
// changed; a much longer one would delay the two moments a day when it has.
//
// THE BASE URL IS CONFIGURATION AND ITS ABSENCE IS A STATE. `env.SENTIMENT_BASE` — there is no
// default, because a guessed base 404s in a way that looks exactly like an outage and sends
// diagnosis in the wrong direction. `no-base` comes back named, and the view says which command
// fixes it. Same rule as `no-token` on the super-investor routes.
//
// A FAILED READ IS NOT AN EMPTY ONE. `entries: []` only ever travels with `ok: false` and a
// reason, and failures are cached for 15 seconds rather than the full window, so a corrected
// configuration takes effect at once instead of after half an hour.
// ---------------------------------------------------------------------------------------
const CHATTER_TTL_S = 30 * 60;
const CHATTER_FAIL_TTL_S = 15;

async function handleChatter(request, env, ctx) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  const base = env.SENTIMENT_BASE || '';
  const cacheKey = edgeKey('chatter/dashboard');
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  const payload = hit
    ? await hit.json()
    : await (async () => {
        // Their /health hands back `ageSeconds` directly — how stale the scrape is, according to
        // the only party whose clock is authoritative about it. Asked alongside, never instead:
        // a healthy /health with an unreadable /dashboard is still a failure.
        const [feed, health] = await Promise.all([fetchChatter(fetch, base), fetchChatterHealth(fetch, base)]);
        const out = feed.ok
          ? {
              ok: true,
              reason: null,
              generatedAt: feed.generatedAt,
              window: feed.window,
              overview: feed.overview,
              total: feed.total,
              entries: feed.entries,
              health: health.ok ? { status: health.status, ageSeconds: health.ageSeconds } : null,
            }
          : { ok: false, reason: feed.reason, status: feed.status ?? null, entries: [], overview: null, health: null };
        ctx?.waitUntil?.(
          cache.put(cacheKey, tagged(JSON.stringify(out), contentTag(out), out.ok ? CHATTER_TTL_S : CHATTER_FAIL_TTL_S)),
        );
        return out;
      })();

  const { body, tag } = withTag(payload);
  return revalidate(request, tagged(body, tag, payload.ok ? CHATTER_TTL_S : CHATTER_FAIL_TTL_S), hit ? 'hit' : 'miss');
}

// ---------------------------------------------------------------------------------------
// GET /api/super-investors  and  GET /api/super-investors/{slug}
//
// A THIN, AUTHENTICATED PROXY — and the edge cache is the point, not a nicety.
//
// The upstream scrapes finology.in on every call. Shareholding data moves ONCE A QUARTER, so
// serving a hundred readers a hundred fresh scrapes would be pure waste on somebody else's
// service. The edge holds each response for hours; the browser then revalidates against our
// ETag and gets a bodyless 304, so a repeat visit costs a header exchange.
//
// The fan-out is deliberately NOT here. One route returns one investor, and the client walks the
// list a few at a time — see js/data/super-investors.js. A `?full=1` that fetched sixty books in
// one request would turn a cold cache into sixty simultaneous scrapes upstream.
//
// FAILURE IS REPORTED BY KIND, because the fixes differ. A missing or expired token is a
// credential to renew; an unreachable host is a service to wait for. The UI says which.
// ---------------------------------------------------------------------------------------

// Six hours. Quarterly data with a generous margin: even at the very end of a window the figure
// on screen is the same figure the source would give.
const INVESTOR_TTL_S = 6 * 60 * 60;

async function handleInvestorList(request, env) {
  try {
    const list = await fetchInvestorList(fetch, env.MUNS_TOKEN, env.MUNS_BASE);
    const { body, tag } = withTag({ ok: true, source: 'Ticker Finology, via devde.muns.io', fetchedAt: new Date().toISOString(), ...list });
    return revalidate(request, tagged(body, tag, INVESTOR_TTL_S), 'live');
  } catch (err) {
    return investorError(request, err, { count: 0, investors: [] });
  }
}

async function handleInvestorPortfolio(request, env, ctx, slug) {
  if (!isSlug(slug)) {
    return json({ ok: false, error: 'bad-slug', message: 'An investor slug may only contain a-z, 0-9 and hyphens.' }, 400);
  }
  try {
    const portfolio = await fetchInvestorPortfolio(fetch, env.MUNS_TOKEN, slug, env.MUNS_BASE);
    const { body, tag } = withTag({ ok: true, source: 'Ticker Finology, via devde.muns.io', fetchedAt: new Date().toISOString(), ...portfolio });
    return revalidate(request, tagged(body, tag, INVESTOR_TTL_S), 'live');
  } catch (err) {
    return investorError(request, err, { slug, quarters: [], holdings: [] });
  }
}

/**
 * One shape for every failure, carrying the REASON rather than an empty success.
 *
 * A 200 with `ok: false`, the same shape `/api/concalls` uses for its degraded case. The request
 * to THIS Worker succeeded; what failed was the upstream, and the body says so by name so the
 * panel can tell a reader whose problem it is: `no-token` and `unauthorised` are a credential for
 * the operator to fix, everything else is a service to wait for. A bare 502 would collapse those
 * into one unreadable state, and the store layer would discard the body that explains it.
 *
 * `holdings: []` never travels without `ok: false` beside it — a book that failed to load must
 * not be able to read as an investor who holds nothing.
 *
 * FIFTEEN SECONDS, not six hours. An error must not be cached for the length of a success, or
 * pasting the right token would appear not to have worked until the afternoon.
 */
function investorError(request, err, extra = {}) {
  const reason = err?.code || 'upstream';
  // A bad slug is the caller's mistake and an unknown investor genuinely does not exist. Those
  // stay real HTTP errors; only upstream and credential conditions become a readable 200.
  if (reason === 'not-found') return json({ ok: false, reason, message: String(err?.message || err), ...extra }, 404);
  const { body, tag } = withTag({ ok: false, reason, message: String(err?.message || err), fetchedAt: new Date().toISOString(), ...extra });
  return revalidate(request, tagged(body, tag, ERROR_TTL_S), reason);
}
const ERROR_TTL_S = 15;

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
      ...CORS,
    },
  });
}

/** Cache keys live on a hostname that cannot resolve, so an entry can never be confused for a fetch. */
function edgeKey(path) {
  return new Request(`https://cache.invalid/${path}`, { method: 'GET' });
}
