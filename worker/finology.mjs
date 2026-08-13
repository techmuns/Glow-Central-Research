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
export const REQ_TIMEOUT_MS = 20000;

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

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
export async function call(fetchImpl, token, path, base = BASE) {
  if (!token) throw fail('No API token is configured for the super-investor feed.', 'no-token');

  let res;
  try {
    res = await fetchImpl(`${base}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
  } catch (e) {
    throw fail(`Could not reach ${base}${path}: ${String(e.message || e)}`, 'unreachable');
  }

  if (res.status === 401 || res.status === 403) {
    throw fail(`The super-investor API rejected the token (HTTP ${res.status}). It may have expired.`, 'unauthorised');
  }
  if (res.status === 404) throw fail(`No such investor: ${path}`, 'not-found');
  if (!res.ok) throw fail(`${path} returned HTTP ${res.status}`, 'upstream');

  try {
    return await res.json();
  } catch {
    throw fail(`${path} did not return JSON`, 'shape');
  }
}

/** GET /super-investors -> { count, dropped, investors: [{ name, slug, bio, imageUrl }] } */
export async function fetchInvestorList(fetchImpl, token, base) {
  return normaliseList(await call(fetchImpl, token, '/super-investors', base));
}

/** GET /super-investors/{slug} -> one investor's book, quarter by quarter. */
export async function fetchInvestorPortfolio(fetchImpl, token, slug, base) {
  if (!isSlug(slug)) throw fail(`"${slug}" is not a valid investor slug.`, 'bad-slug');
  return normalisePortfolio(await call(fetchImpl, token, `/super-investors/${encodeURIComponent(slug)}`, base), slug);
}
