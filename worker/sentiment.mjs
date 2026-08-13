// worker/sentiment.mjs — the network layer for the SentimentDash chatter API.
//
// The vocabulary, the shape guards and the slug→NSE resolver live in
// public/js/data/sentiment-shared.js, because the browser needs them too. This file adds only
// the fetching, with `fetch` injected so the Worker passes its own and Node passes the global —
// the same contract worker/mc.mjs and worker/stockscans.mjs use.
//
//   const out = await fetchDashboard(fetch, base);   // { ok, reason?, ... }
//
// THE UPSTREAM
//   GET {base}/dashboard?limit=all   overview + the full ranked list in one request
//   GET {base}/health                status + `ageSeconds` since the last scrape
//
//   Read-only, public, CORS-open, no auth, no rate limit. Re-scraped twice daily at 01:30 and
//   13:30 UTC, so polling faster than hourly asks a question whose answer cannot have changed.
//
// WHY IT IS PROXIED AT ALL, GIVEN CORS IS OPEN
//   The same two reasons /api/concalls is: politeness and a place to stand. A thousand readers
//   cost the upstream one fetch per cache window instead of a thousand, and the Worker is where
//   a failure can be turned into a named state instead of an empty table.
//
// THE BASE URL IS CONFIGURATION, AND ITS ABSENCE IS A STATE
//   `env.SENTIMENT_BASE`, e.g. https://sentimentdash-api.<subdomain>.workers.dev/v1. There is no
//   default and no guess: a wrong base would 404 for reasons that look exactly like an outage,
//   and diagnosis would start in the wrong place. Unset is reported as `no-base`, which is a
//   thing an operator fixes in one command, and the view says which command. Same rule as
//   `no-token` in worker/finology.mjs — collapsing "not configured" into "could not load" throws
//   away the only information that makes the failure actionable.

export {
  normaliseDashboard,
  normalisePosts,
  buildResolverIndex,
  resolveAll,
  fingerprint,
  SOURCES,
  SOURCE_LABEL,
} from '../public/js/data/sentiment-shared.js';

import { normaliseDashboard, normalisePosts } from '../public/js/data/sentiment-shared.js';

const TIMEOUT_MS = 12000;
const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

// Worth retrying: the upstream was not reached, or reached something that is transiently unwell.
// A 404 or a 400 is an answer — retrying it just asks the same wrong question again.
const TRANSIENT = new Set(['unreachable', 'timeout']);
const TRANSIENT_STATUS = new Set([502, 503, 504]);

const trimBase = (b) => String(b || '').trim().replace(/\/+$/, '');

/**
 * One GET against the API, with every failure mode named rather than thrown.
 *
 * Returns `{ ok: true, body }` or `{ ok: false, reason, status? }`. The reasons are the whole
 * point of this function: `no-base` and `not-found` are things somebody fixes, `unreachable`,
 * `timeout` and `upstream` are things to wait for, and a view that can tell them apart can say
 * something useful instead of shrugging.
 */
async function call(fetchImpl, base, path) {
  const root = trimBase(base);
  if (!root) return { ok: false, reason: 'no-base' };
  if (!/^https?:\/\//i.test(root)) return { ok: false, reason: 'bad-base' };

  let last = { ok: false, reason: 'unreachable' };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 1200));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 404) return { ok: false, reason: 'not-found', status: 404 };
      if (!res.ok) {
        last = { ok: false, reason: 'upstream', status: res.status };
        if (!TRANSIENT_STATUS.has(res.status)) return last;
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!body || typeof body !== 'object') return { ok: false, reason: 'shape' };
      return { ok: true, body };
    } catch (err) {
      clearTimeout(timer);
      last = { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
      if (!TRANSIENT.has(last.reason)) return last;
    }
  }
  return last;
}

/**
 * The ranked list plus the overview, in one request.
 *
 * `limit=all` is theirs and is the right call here: the whole point of the second section is that
 * the entries we cannot resolve are still shown, so paginating would mean deciding which
 * unresolved rows to hide before anyone has looked at them.
 *
 * A FAILED READ IS NEVER AN EMPTY RESULT. `entries: []` only ever travels with `ok: false` and a
 * reason beside it. An upstream with nothing to say and an upstream we could not reach must not
 * render the same, which is the same rule the super-investor route follows.
 */
export async function fetchDashboard(fetchImpl, base) {
  const out = await call(fetchImpl, base, '/dashboard?limit=all');
  if (!out.ok) return { ok: false, reason: out.reason, status: out.status ?? null, entries: [], overview: null };
  const shaped = normaliseDashboard(out.body);
  if (!shaped.entries.length && !shaped.overview) return { ok: false, reason: 'shape', entries: [], overview: null };
  return { ok: true, ...shaped };
}

/** The posts behind one entry. `slug` is theirs — a forum-topic key, not an NSE symbol. */
export async function fetchEntryPosts(fetchImpl, base, slug, { limit = 50 } = {}) {
  if (!isSlug(slug)) return { ok: false, reason: 'bad-slug', posts: [] };
  const out = await call(fetchImpl, base, `/stocks/${encodeURIComponent(slug)}/posts?limit=${limit}&sort=newest`);
  if (!out.ok) return { ok: false, reason: out.reason, status: out.status ?? null, posts: [] };
  return { ok: true, ...normalisePosts(out.body) };
}

/**
 * Their health route, which hands back `ageSeconds` directly — how stale the scrape is, from the
 * only party that knows. Cheaper and more honest than inferring it from `generatedAt` and our own
 * clock, which are two different clocks.
 */
export async function fetchHealth(fetchImpl, base) {
  const out = await call(fetchImpl, base, '/health');
  if (!out.ok) return { ok: false, reason: out.reason, status: out.status ?? null };
  // `ageSeconds` is nested under `data`, not at the top level — the integration spec describes it
  // as "/health gives ageSeconds directly" and reading it that way silently produced null. Found
  // by calling the real endpoint; the top-level fallback stays in case they flatten it later.
  const d = out.body?.data || {};
  const age = Number(d.ageSeconds ?? out.body?.ageSeconds);
  return {
    ok: true,
    status: out.body?.status ?? null,
    ageSeconds: Number.isFinite(age) ? age : null,
    generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : null,
  };
}

/** Their slugs are `[a-z0-9-]`; anything else is a 400 there, so it is rejected here. */
export const isSlug = (s) => typeof s === 'string' && /^[a-z0-9-]+$/.test(s) && s.length <= 120;
