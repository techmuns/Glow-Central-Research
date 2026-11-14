import { boundedJson } from '../public/js/data/family-book-contract.js';
import { AI_RUNS_OBJECT, AI_RUNS_REQUEST_BYTES } from '../public/js/data/ai-runs-shared.js';
import { revalidate, tagged, withTag } from './http.mjs';

// GET  /api/ai-runs  -> every AI "Our view" the desk has run, newest first, conditionally (ETag/304)
// POST /api/ai-runs  -> { intents: [{ op: 'set'|'clear', key, name?, sector?, idea?, rawText?, by? }] }
//
// GLOW-OWNED. A run is the dashboard's own generated view, shared desk-wide so a company one person
// ran is not re-run (and re-paid for) by another. It is held the way the shared watchlist and the
// research sheet are:
//   • never at the edge — `private` keeps one desk's runs out of every shared cache, while the
//     browser may still keep a copy to revalidate against, so an unchanged poll costs only headers;
//   • a failure is never an empty record — `ok: false` travels with no `runs` at all, so a failed
//     read cannot be painted as a desk that has run nothing;
//   • a write is same-origin only and bounded by a rate limit, because the route is unauthenticated
//     as every write here is. It shares the shared watchlist's limiter under its own key prefix,
//     exactly as /api/research-sheet and /api/price-levels do.

const fail = (reason, status, headers = {}) =>
  Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store', ...headers } });

const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

export async function handleAiRuns(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  if (!env.CAPTURE_REGISTRY) return fail('ai-runs-unavailable', 503);
  const store = env.CAPTURE_REGISTRY.getByName(AI_RUNS_OBJECT);

  if (request.method === 'GET') {
    let snapshot;
    try {
      snapshot = await store.aiRunsSnapshot();
    } catch {
      return fail('ai-runs-unavailable', 503);
    }
    // No `checkedAt` in the tagged body: a stamped clock would give every response a new tag while
    // the record was identical, and the 304 this route exists to serve could never fire.
    const { body, tag } = withTag({ ok: true, ...snapshot });
    return revalidate(request, tagged(body, tag, 0, { 'cache-control': 'private, max-age=0, must-revalidate' }), 'shared');
  }

  if (!sameOrigin(request, url)) return fail('origin', 403);
  if (!env.SHARED_WATCHLIST_LIMITER) return fail('ai-runs-unavailable', 503);
  const limit = await env.SHARED_WATCHLIST_LIMITER.limit({ key: `ai-runs:${request.headers.get('cf-connecting-ip') || 'unknown'}` });
  if (!limit.success) return fail('rate-limit', 429, { 'retry-after': '60' });
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);

  let input;
  try {
    input = await boundedJson(new Response(request.body), AI_RUNS_REQUEST_BYTES);
  } catch {
    return fail('invalid-request', 400);
  }

  let result;
  try {
    result = await store.aiRunsApply(input?.intents);
  } catch (error) {
    // A rejected BATCH is the caller's mistake and says so; a failed OBJECT is ours and retryable.
    if (/^Invalid AI run|Duplicate AI run/.test(String(error?.message || ''))) return fail('invalid-request', 400);
    return fail('ai-runs-unavailable', 503);
  }
  return Response.json(
    { ok: true, ...result.snapshot, outcomes: result.outcomes, checkedAt: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
