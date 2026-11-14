import { boundedJson } from '../public/js/data/family-book-contract.js';
import { PEER_REQUEST_BYTES } from '../public/js/data/peer-list-shared.js';
import { SHARED_PEER_LIST_OBJECT } from './peer-list-store.mjs';
import { revalidate, tagged, withTag } from './http.mjs';

// GET  /api/peer-lists  -> the shared per-company peer/competitor map, conditionally (#312)
// POST /api/peer-lists  -> { intents: [{ op, company, peer, name }] } -> the map as it now stands
//
// The same shape and the same reasons as /api/watchlist: this is SHARED STATE, so it is never held
// at the edge (a reader elsewhere seeing a 60-second-old copy would be editing a list that has
// moved on); the saving is the ETag, since `revision` only moves when a row actually changed. A
// failure travels with NO `links` key, so a browser can never read a failed read as "this company
// has no peers" — a read that did not happen is absent; only a successful read may be empty.

const fail = (reason, status) => Response.json({ ok: false, reason }, { status, headers: { 'cache-control': 'no-store' } });

// A write must carry our own origin — present and matching, not merely "not contradicting" — the
// same test the watchlist route applies, and for the same reason: this changes a list every reader
// sees, and `/api/*` answers an OPTIONS preflight with `access-control-allow-origin: *`, so a
// cross-site POST does reach this check and has to be refused by it.
const sameOrigin = (request, url) =>
  request.headers.get('origin') === url.origin &&
  (!request.headers.get('sec-fetch-site') || request.headers.get('sec-fetch-site') === 'same-origin');

export async function handlePeerList(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return fail('method', 405);
  if (!env.PEER_LISTS) return fail('peer-lists-unavailable', 503);
  const store = env.PEER_LISTS.getByName(SHARED_PEER_LIST_OBJECT);

  if (request.method === 'GET') {
    let snapshot;
    try {
      snapshot = await store.peerListSnapshot();
    } catch {
      return fail('peer-lists-unavailable', 503);
    }
    const { body, tag } = withTag({ ok: true, ...snapshot });
    return revalidate(request, tagged(body, tag, 0, { 'cache-control': 'private, max-age=0, must-revalidate' }), 'shared');
  }

  if (!sameOrigin(request, url)) return fail('origin', 403);
  if (!env.PEER_LIST_LIMITER) return fail('peer-lists-unavailable', 503);
  const limit = await env.PEER_LIST_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!limit.success) {
    return new Response(JSON.stringify({ ok: false, reason: 'rate-limit' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '60' },
    });
  }
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return fail('content-type', 415);

  let input;
  try {
    input = await boundedJson(new Response(request.body), PEER_REQUEST_BYTES);
  } catch {
    return fail('invalid-request', 400);
  }

  let result;
  try {
    result = await store.peerListApply(input?.intents);
  } catch (error) {
    // A rejected BATCH is the caller's mistake and says so; a failed OBJECT is ours and is
    // retryable. Collapsing them would send somebody to fix a request that was already correct.
    const message = String(error?.message || '');
    if (/Invalid peer|Duplicate link|its own peer/.test(message)) return fail('invalid-request', 400);
    return fail('peer-lists-unavailable', 503);
  }
  return Response.json(
    { ok: true, ...result.snapshot, outcomes: result.outcomes, checkedAt: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
