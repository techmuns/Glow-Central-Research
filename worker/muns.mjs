// worker/muns.mjs — the authenticated Muns clients: news, corporate announcements, insider trades.
//
//   fetchNews({ query, country, fromDate, toDate }, env)
//   fetchAnnouncements({ ticker, fromDate, toDate }, env)
//   fetchInsiderTrades({ ticker, country, fromDate, toDate }, env)
//
// THE TOKEN LIVES HERE AND NEVER REACHES THE BROWSER. All three endpoints want
// `Authorization: Bearer …`, so all three are proxied, exactly as worker/finology.mjs already
// proxies the super-investor API on the same host. A token shipped to the client is a token
// published; there is no obfuscated version of that which is not that.
//
//   npx wrangler secret put MUNS_TOKEN     production
//   .dev.vars                              local, gitignored
//
// TWO HOSTS, AND POSSIBLY TWO CREDENTIALS. `devde.muns.io` (nestjs) is the host the Finology feed
// already authenticates against, so MUNS_TOKEN covers announcements and insider trades.
// `fastapi.muns.io` is a different service; if it needs its own token, set MUNS_NEWS_TOKEN and this
// will prefer it. Falling back to MUNS_TOKEN means one secret works when one secret is enough.
//
// THE CREDENTIAL IS A SESSION JWT, NOT AN API KEY. The datasource registry types it `bearer_jwt`,
// which means it EXPIRES — unlike a static key, a working deployment will start returning 401 on a
// day nobody changed anything. That is why `unauthorised` is its own named failure state all the
// way to the screen, and why the message names the command that fixes it. Do not treat a 401 here
// as a bug in the request.
//
// EVERY RESPONSE SHAPE HERE IS UNVERIFIED. None of these three could be probed while this was
// written — the only token available locally was a placeholder — so nothing downstream reads a
// guessed field name directly. Parsing goes through js/data/filings-shared.js, which reads by shape
// and by a list of candidate keys, and carries the untouched record alongside. See its header.

import { normaliseAnnouncement, normaliseArticle, normaliseInsiderTrades, collectRecords } from '../public/js/data/filings-shared.js';

export const FASTAPI_BASE = 'https://fastapi.muns.io';
export const NESTJS_BASE = 'https://devde.muns.io';

// The registry's own numbers: 30s timeout, 3 attempts, backoff factor 2.
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
const BACKOFF_MS = 1_000;

const newsBase = (env) => (env?.MUNS_NEWS_BASE || FASTAPI_BASE).replace(/\/+$/, '');
const filingsBase = (env) => (env?.MUNS_BASE || NESTJS_BASE).replace(/\/+$/, '');
const tokenFor = (env, kind) => (kind === 'news' ? env?.MUNS_NEWS_TOKEN || env?.MUNS_TOKEN : env?.MUNS_TOKEN) || null;

/** A failure that names itself, so the UI can say which of them an operator has to fix. */
export class MunsError extends Error {
  constructor(reason, message, { status = null, url = null } = {}) {
    super(message);
    this.reason = reason; // 'no-token' | 'unauthorised' | 'rate-limited' | 'not-found' | 'timeout' | 'unreachable' | 'upstream' | 'shape'
    this.status = status;
    this.url = url;
  }
}

/**
 * One authenticated request, retried on the failures that are worth retrying.
 *
 * 401/403 and 404 are NOT retried: a refused token is refused three times just as fast, and three
 * attempts only delays the moment the operator is told what to fix. 429 is not retried either —
 * the registry caps these at 60 requests a minute and hammering a rate limit is how you earn a
 * longer one. Timeouts and 5xx are the retryable cases.
 *
 * CARRIES THE REQUESTED URL INTO EVERY FAILURE. A bare status code is unfalsifiable; the last time
 * that rule was broken here it cost a long investigation during which the upstream was healthy and
 * answering the whole time (see "an upstream you CANNOT proxy" in CLAUDE.md).
 */
async function request(url, { method = 'GET', body = null, token, label }) {
  if (!token) {
    throw new MunsError('no-token', `No API token is configured for ${label}. An operator sets it with \`npx wrangler secret put MUNS_TOKEN\`.`, { url });
  }

  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        throw new MunsError(
          'unauthorised',
          `${label} refused the token (HTTP ${res.status}). These are session JWTs and they expire; renewing it is \`npx wrangler secret put MUNS_TOKEN\`.`,
          { status: res.status, url }
        );
      }
      if (res.status === 404) throw new MunsError('not-found', `${label} has no record at this address (HTTP 404).`, { status: 404, url });
      if (res.status === 429) throw new MunsError('rate-limited', `${label} is rate limiting this deployment (HTTP 429). The registry allows 60 requests a minute.`, { status: 429, url });
      if (!res.ok) {
        last = new MunsError('upstream', `${label} answered HTTP ${res.status}.`, { status: res.status, url });
        if (res.status < 500) throw last;
      } else {
        // The insider-trades endpoint is documented as returning a markdown TABLE, so a non-JSON
        // body is expected there rather than a failure. Read text and let the caller decide.
        const text = await res.text();
        try {
          return { json: JSON.parse(text), text, status: res.status };
        } catch {
          return { json: null, text, status: res.status };
        }
      }
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof MunsError && err.reason !== 'upstream') throw err;
      last =
        err.name === 'AbortError'
          ? new MunsError('timeout', `${label} did not answer within ${TIMEOUT_MS / 1000}s.`, { url })
          : last || new MunsError('unreachable', `${label} could not be reached: ${String(err?.message || err)}`, { url });
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** (attempt - 1)));
  }
  throw last || new MunsError('unreachable', `${label} could not be reached.`, { url });
}

// ---------------------------------------------------------------------------------------
// News — POST /tools/news-search
// ---------------------------------------------------------------------------------------

/**
 * Recent articles for a query.
 *
 * The registry names the response field `results`; `collectRecords` looks there first and then at
 * the other envelopes a service of this shape uses, so a rename costs nothing. Articles are
 * returned in the upstream's own order — relevance is theirs to decide, and re-sorting by date
 * would quietly replace their ranking with ours.
 */
export async function fetchNews({ query, country = null, fromDate = null, toDate = null }, env) {
  const url = `${newsBase(env)}/tools/news-search`;
  const body = { query: String(query || '').trim() };
  if (country) body.country = country;
  if (fromDate) body.from_date = fromDate;
  if (toDate) body.to_date = toDate;
  if (!body.query) throw new MunsError('shape', 'A news search needs a query.', { url });

  const { json, text } = await request(url, { method: 'POST', body, token: tokenFor(env, 'news'), label: 'The news API' });
  if (!json) throw new MunsError('shape', 'The news API answered with something that is not JSON.', { url });

  const records = collectRecords(json);
  return {
    query: body.query,
    count: records.length,
    articles: records.map((r) => normaliseArticle(r, body.query)),
    // Kept so a reader can see what came back when the normaliser found nothing to show — the
    // difference between "no articles" and "articles in a shape we did not recognise".
    rawSample: records.length ? null : String(text).slice(0, 400),
  };
}

// ---------------------------------------------------------------------------------------
// Corporate announcements — GET /filings/corp/announcements/{ticker}
// ---------------------------------------------------------------------------------------

/** `YYYY-MM-DD` or `YYYYMMDD` in, `YYYYMMDD` out — this endpoint wants the compact form. */
export const compactDate = (d) => String(d || '').replace(/-/g, '').slice(0, 8);

/**
 * Every announcement for one company, from BSE (primary), NSE (fallback) and DRHP documents.
 *
 * The documented response is "grouped by source" with the grouping unspecified, so
 * `collectRecords` walks the envelope and keeps the group name on each row. WHICH EXCHANGE SAID
 * THIS IS INFORMATION: flattening BSE, NSE and DRHP into one undifferentiated list would lose the
 * one field that lets a reader tell a filing from a prospectus.
 */
export async function fetchAnnouncements({ ticker, fromDate, toDate }, env) {
  const t = String(ticker || '').trim().toUpperCase();
  const from = compactDate(fromDate);
  const to = compactDate(toDate);
  const url = `${filingsBase(env)}/filings/corp/announcements/${encodeURIComponent(t)}?fromDate=${from}&toDate=${to}`;
  if (!t || !/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    throw new MunsError('shape', 'Announcements need a ticker and a YYYYMMDD date range.', { url });
  }

  const { json, text } = await request(url, { token: tokenFor(env), label: 'The announcements API' });
  if (!json) throw new MunsError('shape', 'The announcements API answered with something that is not JSON.', { url });

  const records = collectRecords(json, { groupKey: 'source' });
  return {
    ticker: t,
    from,
    to,
    count: records.length,
    announcements: records.map((r) => normaliseAnnouncement(r, t)),
    rawSample: records.length ? null : String(text).slice(0, 400),
  };
}

// ---------------------------------------------------------------------------------------
// Insider trades — POST /filings/data/insider_trades
// ---------------------------------------------------------------------------------------

/**
 * Insider trades for one company, as a table.
 *
 * THIS ONE ANSWERS WITH MARKDOWN, not JSON — the only upstream in this dashboard that does. The
 * parser lives in filings-shared.js and keeps the source's own column headings rather than mapping
 * them onto names of ours: this is somebody else's table and relabelling "Acq/Disp" as "Action"
 * would put our word on their data.
 *
 * `country: 'india'` routes them to NSE/BSE/Trendlyne; anything else goes to Finviz. India is the
 * default because every company in this dashboard is Indian, and the documented India path is
 * capped at 100 records when no date filter is given — so a date range is always sent.
 */
export async function fetchInsiderTrades({ ticker, country = 'india', fromDate = null, toDate = null }, env) {
  const t = String(ticker || '').trim().toUpperCase();
  const url = `${filingsBase(env)}/filings/data/insider_trades`;
  if (!t) throw new MunsError('shape', 'Insider trades need a ticker.', { url });

  const body = { ticker: t, country };
  if (fromDate) body.fromDate = fromDate;
  if (toDate) body.toDate = toDate;

  const { json, text } = await request(url, { method: 'POST', body, token: tokenFor(env), label: 'The insider-trades API' });
  const parsed = normaliseInsiderTrades(json ?? text, t);
  return {
    ticker: t,
    country,
    from: fromDate,
    to: toDate,
    format: parsed.format,
    headers: parsed.headers,
    count: parsed.rows.length,
    trades: parsed.rows,
    // The India path caps at 100 without date filters; with them it does not, but a run that comes
    // back at exactly the cap is worth flagging rather than presenting as a complete history.
    capped: parsed.rows.length >= 100 && !fromDate && !toDate,
    rawSample: parsed.rows.length ? null : String(text || '').slice(0, 400),
  };
}
