// worker/finology.mjs — the authenticated client for the Ticker Finology super-investor API.
//
//   fetchInvestorList(fetchImpl, token)              GET /super-investors
//   fetchInvestorPortfolio(fetchImpl, token, slug)   GET /super-investors/{slug}
//
// PURE AND DEPENDENCY-FREE. `fetch` is a parameter, exactly as worker/mc.mjs takes one, so the
// Worker, a Node script and a test can all use it without any of them disagreeing about shape.
// The shape guards themselves live in public/js/data/finology-shared.js and are imported here —
// same arrangement as stockscans-shared.js, so the browser and the Worker cannot drift about what
// a blank quarter means.
//
// THE UPSTREAM IS A LIVE SCRAPE OF finology.in, AND THAT SHAPES EVERY DECISION AROUND IT.
//   Each call makes their service go and read a page. So the route that uses this caches hard at
//   the edge (holdings move once a quarter, not once a minute), fetches one investor at a time
//   rather than fanning out over every investor on every visit, and degrades to "we could not
//   read this" rather than to a zero.
//
// FAILURES CARRY A `code`, because the fixes differ: `no-token` and `unauthorised` are a
// credential for the operator to renew, everything else is a service to wait for. The Worker
// route turns that code into something the panel can say out loud.

import { isSlug, normaliseList, normalisePortfolio } from '../public/js/data/finology-shared.js';

export { isSlug };

export const BASE = 'https://devde.muns.io';

// Per attempt, not per call. The service answers in about a second when healthy and fails fast
// when it is not, so a short ceiling plus retries beats one long wait: the common bad case costs
// a couple of seconds rather than twenty.
export const REQ_TIMEOUT_MS = 15000;
export const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Conditions worth trying again: the host was unreachable, the request timed out, or a gateway
// reported the app as briefly unavailable. A 401 and a 404 are answers, not blips — retrying
// either just delays the same result.
const TRANSIENT = new Set(['unreachable', 'timeout']);
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated GET against the API.
 *
 * The token never leaves the Worker — see the route in worker/index.js. It is read from
 * `env.MUNS_TOKEN` and injected here; nothing in `public/` has ever seen it.
 *
 * `base` exists so local development and the verification suite can point at a stand-in. A run
 * that verified this integration against the real service would be scraping somebody else's
 * production on every push, and would need a live credential to do it.
 */
export async function call(fetchImpl, token, path, base = BASE, { missing = 'not-found' } = {}) {
  if (!token) throw fail('No API token is configured for the super-investor feed.', 'no-token');

  let last;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await attemptCall(fetchImpl, token, path, base, missing);
    } catch (e) {
      last = e;
      const retryable = TRANSIENT.has(e.code) || (e.code === 'upstream' && TRANSIENT_STATUS.has(e.status));
      if (!retryable || attempt === ATTEMPTS - 1) throw e;
      await sleep(BACKOFF_MS[attempt] ?? 1200);
    }
  }
  throw last;
}

async function attemptCall(fetchImpl, token, path, base, missing) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = /timeout|abort/i.test(String(e?.name || e?.message || ''));
    throw fail(`Could not reach ${base}${path}: ${String(e.message || e)}`, timedOut ? 'timeout' : 'unreachable');
  }

  if (res.status === 401 || res.status === 403) {
    throw fail(`The super-investor API rejected the token (HTTP ${res.status}). It may have expired.`, 'unauthorised');
  }
  // A 404 means different things on the two routes, and conflating them sent a real diagnosis in
  // the wrong direction: the list route 404'd and the panel said "No such investor", which reads
  // as a data problem when in fact the endpoint was not deployed on that service at all. So the
  // caller says what a 404 means for the path it asked for.
  if (res.status === 404) {
    throw missing === 'route-missing'
      ? fail(`${base}${path} does not exist on that service — the endpoint is not deployed there.`, 'route-missing')
      : fail(`No such investor: ${path}`, 'not-found');
  }
  if (!res.ok) {
    const err = fail(`${path} returned HTTP ${res.status}`, 'upstream');
    err.status = res.status;
    throw err;
  }

  try {
    return await res.json();
  } catch {
    throw fail(`${path} did not return JSON`, 'shape');
  }
}

/**
 * GET /super-investors -> { count, dropped, investors: [{ name, slug, bio, imageUrl }] }
 *
 * A 404 here is `route-missing`, not `not-found`: there is no investor being looked up, so the
 * only thing a 404 can mean is that the endpoint is absent from the service being called.
 */
export async function fetchInvestorList(fetchImpl, token, base) {
  return normaliseList(await call(fetchImpl, token, '/super-investors', base, { missing: 'route-missing' }));
}

/** GET /super-investors/{slug} -> one investor's book, quarter by quarter. */
export async function fetchInvestorPortfolio(fetchImpl, token, slug, base) {
  if (!isSlug(slug)) throw fail(`"${slug}" is not a valid investor slug.`, 'bad-slug');
  return normalisePortfolio(await call(fetchImpl, token, `/super-investors/${encodeURIComponent(slug)}`, base), slug);
}
