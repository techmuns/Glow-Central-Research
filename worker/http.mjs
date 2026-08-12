// worker/http.mjs — conditional responses, shared by the Worker and anything that stands in for it.
//
// Pure and dependency-free: `Response` and `Headers` only, both of which Node 22 and the Workers
// runtime provide. Same reason mc.mjs is written this way — a second copy of these rules living in
// a local dev shim would drift from the deployed Worker, and the drift would show up as a caching
// bug that reproduces in exactly one of the two places.
//
//   const { body, tag } = withTag(payload);            // stamps meta.contentTag, serialises once
//   return revalidate(request, tagged(body, tag, 30), 'miss');
//
// WHY ANY OF THIS EXISTS
// The results feed is 1.1MB of JSON and the con-call scan is 450KB, and the dashboard polls both
// every 30 seconds. Re-sending them to say "nothing changed" — which is the truthful answer to
// 119 polls out of 120 — is the single largest waste this system is capable of. A content-derived
// ETag plus a bodyless 304 removes it.

// The dashboard is same-origin with the Worker, so CORS is not needed for our own page. It is here
// so the feed can be pulled from a local `python3 -m http.server` during development without
// standing up wrangler — and `expose-headers` is what lets such a caller read the ETag back.
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag, x-sattva-cache, x-sattva-list-source',
};

/**
 * Answer a CORS preflight.
 *
 * A conditional GET carries `If-None-Match`, which is not a CORS-safelisted request header, so a
 * cross-origin caller preflights it. Production is same-origin and never sees this; local
 * development, where the static site and the Worker sit on different ports, does.
 */
export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'if-none-match, content-type, accept',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * A stable 64-bit content tag, hex.
 *
 * Not a cryptographic digest, and deliberately not `crypto.subtle.digest`: a cache validator only
 * has to change when the content changes, and making every response path await a promise to get
 * one would buy nothing. Two 32-bit lanes with different mixing constants, concatenated.
 *
 * A collision would mean one missed update until the next real change — the same risk the client's
 * own row fingerprint already accepts, at odds no cheaper machinery would improve on.
 */
export function contentTag(str) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619) >>> 0;
    b = (Math.imul(b + c, 2654435761) ^ (b >>> 13)) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

// Fields that describe the DELIVERY rather than the content. They change on every request while
// the payload does not, so hashing them would mean the tag never matched and the 304 this whole
// file exists for would never fire. `contentTag` is in here so a tag can be embedded in the very
// body it describes without changing that body's tag.
export const VOLATILE_KEYS = new Set(['fetchedAt', 'servedAt', 'resolvedOnTheFly', 'unresolved', 'headFresh', 'contentTag', 'receivedAt']);

/**
 * Serialise a payload for hashing, dropping the volatile keys at every depth. A replacer rather
 * than a hand-written field list on purpose: a field added to a payload next month is covered
 * automatically, where a hand-written list would quietly stop noticing it.
 */
export function stableJson(obj) {
  return JSON.stringify(obj, (k, v) => (VOLATILE_KEYS.has(k) ? undefined : v));
}

/**
 * Compute a payload's tag, stamp it into `meta.contentTag`, and serialise once.
 *
 * The stamp matters: a cross-origin caller that cannot read the ETag response header still finds
 * the tag in the body, and that is the shape of the local development setup.
 */
export function withTag(payload) {
  const tag = contentTag(stableJson(payload));
  if (payload && typeof payload === 'object') {
    if (payload.meta && typeof payload.meta === 'object') payload.meta.contentTag = tag;
    else payload.contentTag = tag;
  }
  return { body: JSON.stringify(payload), tag };
}

/** A cacheable JSON response carrying its validator. `body` is a string, so this is repeatable. */
export function tagged(body, tag, ttl, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${ttl}`,
      etag: `"${tag}"`,
      ...CORS,
      ...extra,
    },
  });
}

/** `If-None-Match: "a", W/"b"` against our own strong tag. `*` matches anything we hold. */
export function etagMatches(header, etag) {
  if (!header || !etag) return false;
  if (header.trim() === '*') return true;
  const norm = (s) => s.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => norm(candidate) === norm(etag));
}

/**
 * Turn a prepared 200 into a 304 when the caller already holds it.
 *
 * The 304 carries the validator and the caching headers and nothing else — no body, which is the
 * entire point. `x-sattva-cache` still travels, so the state stays visible in devtools either way.
 */
export function revalidate(request, res, state) {
  const etag = res.headers.get('etag');
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    const headers = new Headers(CORS);
    for (const k of ['etag', 'cache-control', 'x-sattva-list-source', 'x-sattva-head']) {
      const v = res.headers.get(k);
      if (v) headers.set(k, v);
    }
    headers.set('x-sattva-cache', `${state}-304`);
    return new Response(null, { status: 304, headers });
  }
  const out = new Response(res.body, res);
  out.headers.set('x-sattva-cache', state);
  return out;
}
