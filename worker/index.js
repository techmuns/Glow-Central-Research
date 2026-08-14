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
import { CORS, preflight, contentTag, withTag, tagged, revalidate } from './http.mjs';

const MUNSHOT_API = 'https://fastapi.muns.io/stock-data';
const MAX_TICKERS = 60;

// THE QUOTE UPSTREAM IS CACHE-BACKED, AND EVERY NUMBER BELOW COMES FROM MEASURING THAT.
// The same twenty tickers, the same concurrency, the same timeout, three times in a row:
// 8/20 with a p50 of 15s, then 20/20 with a p50 of 3.3s, then 20/20 with a p50 of 1.1s.
// A ticker they have warm answers in about a second; a cold one takes 8-15s and sometimes
// longer. That single fact explains the failure this route used to produce reliably:
//
//   - REQ_TIMEOUT_MS was 8000, which sits UNDER the cold path. Cold reads could not win.
//   - Nothing was cached here, so every refresh was a cold refresh. The slow path was not
//     the unlucky case, it was the only case.
//   - All 60 fetches were fired in one Promise.all, each with its own AbortSignal.timeout.
//     The runtime runs about six connections at a time, so the other fifty-four burned their
//     entire budget waiting for a socket. Measured: 24 fired together returned 0 of 24, all
//     aborting at exactly 8s, while the same tickers walked a few at a time returned 24 of 24.
//
// So the fix is not a better timeout. It is: cache each ticker here so the expensive read is
// paid once for every reader rather than once per click, give the cold path room to finish,
// bound the fan-out so a timer cannot expire in a queue, and — because some cold reads will
// still overrun — return what landed and NAME what did not, instead of failing the batch.
//
// The four constants below are ONE SETTING, NOT FOUR, and they have to stay consistent: a batch of MAX_TICKERS
// needs ceil(60 / POOL) waves, and a wave can cost a full TIMEOUT, so a POOL too small simply
// cannot reach the end of the batch before the BUDGET expires however healthy the upstream is.
// A first draft ran POOL 6 against a 22s budget and returned 6 of 60 with 48 never started —
// worse than the bug it replaced. Measured on disjoint cold batches of 60, at a 25s budget:
// POOL 12 -> 48/60, POOL 20 -> 31/60, POOL 30 -> 46/60. Higher fan-out does not buy throughput
// because the upstream slows under it, so 12 is both the best result and the politest of the three.
const QUOTE_TTL_S = 45; // one quote at the edge. Long enough to serve a burst, short enough to be a quote.
const QUOTE_TIMEOUT_MS = 15000; // per attempt, above the measured cold path
const QUOTE_POOL = 12; // in flight at once
const QUOTE_BUDGET_MS = 25000; // whole-route deadline; whatever has landed by then is returned
const QUOTE_ATTEMPTS = 2;

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
      return handleLivePrices(request, env, ctx);
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


  let days = stripOut.status === 'fulfilled' ? stripOut.value : [];

  // The list has two possible origins and the payload must say which. Live is preferred; the
  // committed capture is the fallback, because Akamai answers a Cloudflare Worker's request for
  // the calendar page with a 200 carrying no app payload.
  let day = dayOut.status === 'fulfilled' ? dayOut.value : null;
  let listSource = day ? 'live' : null;
  let listCapturedAt = null;
  let listNote = null;
  const snapshot = await loadCalendarSnapshot(env, request);

  if (!day) {
    const hit = snapshot?.byDate?.[date];
    if (hit) {
      day = { rows: hit.rows || [], asOnDate: hit.asOnDate || null, capped: !!hit.capped };
      listSource = 'snapshot';
      listCapturedAt = snapshot.capturedAt || null;
    } else {
      day = { rows: [], asOnDate: null, capped: false };
      listNote = snapshot
        ? `The committed capture covers ${snapshot.from} to ${snapshot.to} and does not include this date.`
        : 'No committed capture is available.';
    }
  }

  // A COUNT OF ZERO ON A DATE WE CAN NAME TWENTY COMPANIES FOR IS NOT A MEASUREMENT.
  //
  // `indexId=N` — the NSE index this route asks for — went flat on 14 Aug 2026 and began answering
  // 0 for every date in a 25-day window. It is the endpoint's failure mode, not a quiet fortnight:
  // the same request with `indexId=B` returned 239/342/451/417 for the same four dates, and the
  // capture taken hours earlier holds 171/225/258/235 plus twenty named companies per date. A live
  // zero that the committed capture contradicts is a broken read, and rendering it turned the whole
  // strip into em dashes on a day 235 companies were reporting.
  //
  // The test is EVIDENCE, not a threshold: the live strip carries no non-zero count anywhere, and
  // the capture — which overlaps it — does. A genuinely empty window fails that test, because the
  // capture would be empty too. What is deliberately NOT done is switching to `indexId=B`: BSE is a
  // different universe (451 against 258 on the same date), so quietly serving it would answer a
  // question nobody asked, under the previous question's label.
  let countSource = days.length ? 'live' : null;
  let countsCapturedAt = null;
  const liveHasCounts = days.some((d) => d.count > 0);
  const snapDays = snapshot?.days || [];
  const overlap = snapDays.filter((d) => d.date >= from && d.date <= to);

  if (!liveHasCounts && overlap.some((d) => d.count > 0)) {
    // Keep the live strip's dates so the window is unchanged, and take the counts from the capture.
    const captured = new Map(overlap.map((d) => [d.date, d.count]));
    days = (days.length ? days : overlap).map((d) => ({ ...d, count: captured.get(d.date) ?? d.count }));
    countSource = 'snapshot';
    countsCapturedAt = snapshot.capturedAt || null;
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
    // Counts and the company list fail independently, so they carry their provenance separately.
    // Freezing them together would hide a schedule that has moved since the capture.
    countSource,
    countsCapturedAt,
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
// THERE IS NO /api/chatter, AND THERE CANNOT BE. Read this before adding one.
//
// The retail-chatter upstream is another Cloudflare Worker on this same account,
// `sentimentdash-api.<subdomain>.workers.dev`. A route here that proxied it was written, deployed,
// and returned 404 in production while `curl` got 200 from the identical URL.
//
// The cause is a platform rule: **Cloudflare refuses a subrequest from one Worker to another
// Worker's `*.workers.dev` hostname on the same zone** — error 1042, "Worker tried to fetch from
// another Worker on the same zone, which is not allowed" — and surfaces it as a 404. That is
// indistinguishable from the upstream being absent, which is exactly how it was first misread.
//
// Every other upstream here is off-zone (moneycontrol.com, stockscans.in, devde.muns.io), so this
// is the only route that could ever have hit it, and no amount of fixing the client would help.
//
// The browser calls that API directly instead — see js/data/chatter-live.js. It is public,
// CORS-open, exposes its ETag and answers `If-None-Match` with a 304, so nothing is lost. The
// Concall Deep Dive Worker is called from the browser for the same reason.
//
// If it ever needs to be proxied — to hold a credential, say — the options are a Cloudflare
// SERVICE BINDING (`"services"` in wrangler.jsonc, which is the supported same-account path) or
// giving that Worker a custom domain so it leaves the workers.dev zone. Not another fetch.
// ---------------------------------------------------------------------------------------

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

/**
 * POST /api/live-prices — on-demand intraday quotes for the Breakouts tab.
 *
 * A PARTIAL RESULT IS A SUCCESS, AND IT SAYS WHICH NAMES IT IS MISSING.
 * Some cold reads will overrun the budget however it is set — that is the upstream's shape, not
 * a bug to tune away. Failing all sixty because eight were slow throws away fifty-two good quotes
 * and tells the reader nothing. So the response carries `requested`, `ticker_count` and a
 * `missing[]` naming every ticker that did not land AND why, and the caller renders that instead
 * of a bare "failed". The names that did land are also now warm at the edge and upstream, so
 * clicking again genuinely completes the set — which is a thing the UI can only offer honestly
 * because the response says what is outstanding.
 *
 * Only a refresh that retrieved NOTHING is an error. That distinction is the same one the rest of
 * this dashboard makes everywhere: an empty result and a failed read must never render alike.
 */
async function handleLivePrices(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  let tickers;
  try {
    const body = await request.json();
    tickers = Array.isArray(body?.tickers) ? body.tickers : [];
  } catch {
    return json({ error: 'bad request body' }, 400);
  }
  const requested = [...new Set(tickers.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
  const capped = requested.slice(0, MAX_TICKERS);
  if (!capped.length) return json({ error: 'no tickers' }, 400);

  const started = Date.now();
  const deadline = started + QUOTE_BUDGET_MS;
  const prices = {};
  const missing = [];

  // 1. The edge first. These are local lookups, not subrequests, so asking for all of them at
  //    once costs nothing — and on a second click within the TTL this answers the whole batch
  //    without touching the upstream at all.
  const cache = await openCache();
  const cold = [];
  await Promise.all(
    capped.map(async (t) => {
      const hit = await cacheGetQuote(cache, t);
      if (hit) prices[t] = hit;
      else cold.push(t);
    })
  );
  const fromCache = capped.length - cold.length;

  // 2. Everything still cold, a few at a time, each timer starting when its request does.
  await pooled(cold, QUOTE_POOL, async (ticker) => {
    if (Date.now() >= deadline) {
      missing.push({ ticker, reason: 'deadline' });
      return;
    }
    const res = await fetchQuote(ticker, deadline);
    if (res.quote) {
      prices[ticker] = res.quote;
      // Written back so the next reader — and the next click — gets it for free. `waitUntil`
      // keeps the write off the response's critical path.
      ctx?.waitUntil?.(cachePutQuote(cache, ticker, res.quote));
    } else {
      missing.push({ ticker, reason: res.reason });
    }
  });

  for (const t of requested.slice(MAX_TICKERS)) missing.push({ ticker: t, reason: 'over-cap' });

  const count = Object.keys(prices).length;
  const elapsedMs = Date.now() - started;

  // A refresh that fetched nothing is a failure, not an empty "fresh" feed — the caller keeps its
  // last-known prices rather than blanking the display. It carries the upstream it asked and what
  // went wrong: a bare status code is unfalsifiable, and diagnosing this route once already cost
  // an investigation that a named reason would have ended immediately.
  if (!count) {
    return json(
      {
        error: 'no quotes retrieved',
        upstream: MUNSHOT_API,
        requested: capped.length,
        elapsed_ms: elapsedMs,
        reasons: tallyReasons(missing),
        missing,
      },
      502
    );
  }

  return json(
    {
      generated_at: new Date().toISOString(),
      source: 'Munshot quote API (on-demand refresh)',
      upstream: MUNSHOT_API,
      // The FULL deduped ask, not the capped slice, so `ticker_count + missing.length` always
      // reconciles against it. Reporting the cap as the ask would hide the over-cap names inside
      // a total that never counted them — a silent truncation wearing an honest-looking number.
      requested: requested.length,
      ticker_count: count,
      cached_count: fromCache,
      partial: count < capped.length,
      elapsed_ms: elapsedMs,
      missing,
      prices,
    },
    200
  );
}

/**
 * Run `job` over `items` with at most `limit` in flight.
 *
 * The point is not politeness. `Promise.all` over sixty fetches starts sixty
 * `AbortSignal.timeout` clocks at once while the runtime runs about six connections, so the
 * queued requests spend their whole budget waiting for a socket and abort before they are ever
 * sent. Here a timer only starts when its request does. `job` is expected to absorb its own
 * failures; one rejection must not cancel the pool.
 */
async function pooled(items, limit, job) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await job(item);
      } catch {
        /* job records its own failures */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One quote from Munshot. Never throws — returns `{ quote }` or `{ reason }`, because the caller
 * needs to tell the reader WHY a name is missing, and "null" cannot.
 *
 * The per-attempt timeout is clamped to whatever is left of the route's budget, so a slow read
 * cannot push the whole response past the deadline it is supposed to respect.
 */
async function fetchQuote(ticker, deadline) {
  let reason = 'unreachable';
  for (let attempt = 0; attempt < QUOTE_ATTEMPTS; attempt++) {
    const budget = Math.min(QUOTE_TIMEOUT_MS, deadline - Date.now());
    if (budget <= 0) return { reason: attempt ? reason : 'deadline' };
    try {
      const r = await fetch(MUNSHOT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker_symbol: ticker, type: 'stockquote', country: 'india' }),
        signal: AbortSignal.timeout(budget),
      });
      if (!r.ok) {
        reason = `http-${r.status}`;
        // A 4xx is an answer about this ticker — retrying just asks the same question again and
        // spends budget a cold name behind it in the queue could have used.
        if (r.status >= 400 && r.status < 500) return { reason };
        throw new Error(reason);
      }
      const body = await r.json(); // the API returns a quoted CSV-ish string
      if (typeof body !== 'string') return { reason: 'shape' };
      const quote = parseQuote(body);
      return quote ? { quote } : { reason: 'unparseable' };
    } catch (e) {
      if (!String(reason).startsWith('http-')) {
        reason = /timeout|abort/i.test(String(e?.name || e?.message || '')) ? 'timeout' : 'unreachable';
      }
      // A timeout here means the upstream had this ticker cold, and a cold read costs 8-15s.
      // Immediately asking the same cold question again spends another 15s of a 25s budget on
      // one name while a dozen others have not been started at all — so a timeout ends this
      // ticker's turn. The attempt was not wasted: it left the ticker warming upstream, which is
      // exactly why the caller is told to click again rather than told it failed.
      if (reason === 'timeout' || attempt === QUOTE_ATTEMPTS - 1) return { reason };
      await new Promise((res) => setTimeout(res, 300)); // brief pause before the single retry
    }
  }
  return { reason };
}

function tallyReasons(missing) {
  const out = {};
  for (const m of missing) out[m.reason] = (out[m.reason] || 0) + 1;
  return out;
}

// ---- the per-ticker quote cache -----------------------------------------------------------
// One entry per ticker rather than one per batch: two readers looking at different scopes ask
// for overlapping sets, and a batch-keyed entry would make each of them a full cold miss.

async function openCache() {
  try {
    return caches.default;
  } catch {
    return null; // no Cache API (a plain Node stand-in) — everything is simply a miss
  }
}

function quoteKey(ticker) {
  return edgeKey(`quote/${encodeURIComponent(ticker)}`);
}

async function cacheGetQuote(cache, ticker) {
  if (!cache) return null;
  try {
    const hit = await cache.match(quoteKey(ticker));
    if (!hit) return null;
    const q = await hit.json();
    return q && typeof q.current === 'number' ? q : null;
  } catch {
    return null; // a store miss is never an error; it means "fetch it"
  }
}

async function cachePutQuote(cache, ticker, quote) {
  if (!cache) return;
  try {
    await cache.put(
      quoteKey(ticker),
      new Response(JSON.stringify(quote), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${QUOTE_TTL_S}` },
      })
    );
  } catch {
    /* caching is an optimisation — never let it fail the request */
  }
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
