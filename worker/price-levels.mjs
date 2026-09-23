import { boundedJson } from '../public/js/data/family-book-contract.js';
import { PRICE_LEVELS_OBJECT, PRICE_LEVELS_REQUEST_BYTES } from '../public/js/data/price-levels-shared.js';
import { revalidate, tagged, withTag } from './http.mjs';

// GET  /api/price-levels -> the family's price levels, every one reached, and the minute check's state
// POST /api/price-levels -> { intents: [{ op: 'set'|'seed'|'clear', ticker, isin, name, levels }] }
//
// THE ONE WRITE ROUTE HERE THAT ANOTHER SITE MAY CALL, AND ONLY ONE OTHER SITE.
//   The levels are set in the Glow Ventures dashboard, which is a different origin, so a browser on
//   that page posts here directly. Every other write in this Worker is same-origin only; this one
//   accepts its own origin plus exactly the origins named in `PRICE_LEVEL_ORIGINS` (wrangler.jsonc),
//   present and matching — a missing `Origin` is not evidence of anything, and a browser sends one
//   on every POST. The production Glow Ventures address is the only one named: a branch preview
//   there must not be able to write test levels into the family's real list.
//
//   The route is unauthenticated, as every write route here is — this dashboard has no account
//   system to key one on. So the bound on what one caller can do is a rate limit, and it shares the
//   shared watchlist's limiter under its own key prefix, which gives it its own counter without a
//   new namespace.
//
// WHY A FAILURE IS NEVER AN EMPTY LIST. `ok: false` travels with no `companies` and no `hits`, so a
// failed read can never read as "the family has no levels" or "nothing was reached".

const fail = (reason, status, headers = {}) =>
  Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store', ...headers } });

/** This dashboard's own origin plus the ones configured to write here. */
export function allowedOrigins(env, url) {
  return new Set([url.origin, ...String(env?.PRICE_LEVEL_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
}

export async function handlePriceLevels(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  if (!env.PRICE_LEVELS) return fail('price-levels-unavailable', 503);
  const store = env.PRICE_LEVELS.getByName(PRICE_LEVELS_OBJECT);

  if (request.method === 'GET') {
    let snapshot;
    try {
      snapshot = await store.priceLevelsSnapshot();
    } catch {
      return fail('price-levels-unavailable', 503);
    }
    const { body, tag } = withTag({ ok: true, ...snapshot });
    // `private`: the family's own levels stay out of every shared cache, while the browser may still
    // keep a copy to revalidate against — an unchanged poll then costs headers, not the list.
    return revalidate(request, tagged(body, tag, 0, { 'cache-control': 'private, max-age=0, must-revalidate' }), 'shared');
  }

  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env, url).has(origin)) return fail('origin', 403);
  // A same-origin caller must look same-origin; a named foreign origin is cross-site by definition.
  const site = request.headers.get('sec-fetch-site');
  if (origin === url.origin && site && site !== 'same-origin') return fail('origin', 403);
  // From here on the caller is allowed, so it may READ why a write failed — a Glow Ventures page told
  // only "the request failed" could not tell a rate limit from a malformed level.
  const cors = origin === url.origin ? {} : { 'access-control-allow-origin': origin, vary: 'origin' };

  if (!env.SHARED_WATCHLIST_LIMITER) return fail('price-levels-unavailable', 503, cors);
  const limit = await env.SHARED_WATCHLIST_LIMITER.limit({ key: `price-levels:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
  if (!limit.success) return fail('rate-limit', 429, { ...cors, 'retry-after': '60' });
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415, cors);

  let input;
  try {
    input = await boundedJson(new Response(request.body), PRICE_LEVELS_REQUEST_BYTES);
  } catch {
    return fail('invalid-request', 400, cors);
  }

  let result;
  try {
    result = await store.priceLevelsApply(input?.intents);
  } catch (error) {
    // A rejected BATCH is the caller's mistake and says so; a failed OBJECT is ours and retryable.
    if (/Invalid price level|Duplicate company/.test(String(error?.message || ''))) return fail('invalid-request', 400, cors);
    return fail('price-levels-unavailable', 503, cors);
  }
  return Response.json(
    { ok: true, ...result.snapshot, outcomes: result.outcomes },
    { headers: { 'cache-control': 'no-store', ...cors } },
  );
}
