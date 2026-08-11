// worker/stockscans.mjs — fetching for the StockScans con-call feed.
//
// The vocabulary, the row normalisers, the merge and the fingerprint live in
// public/js/data/stockscans-shared.js, because the browser needs them too and one definition
// beats two. This file adds only the network layer, with `fetch` injected so the Worker passes
// its own and Node passes the global — the same contract worker/mc.mjs uses.
//
//   const { rows, meta } = await fetchConcallScans({ pages: 'all' });
//
// THE UPSTREAM
//   POST https://www.stockscans.in/api/company/concall-scan          the quarter's calls, 50/page
//   POST https://www.stockscans.in/api/company/concall-scan/upcoming scheduled, not yet held
//   GET  https://www.stockscans.in/api/company/concall-scan/today    today's calls with times
//
//   No auth, no cookies, no bot wall, `robots.txt: Allow: /`.
//
// THE FEED IS STRICTLY NEWEST-FIRST, AND THAT IS LOAD-BEARING
//   Verified across all 877 rows of a full quarter: `when` descends monotonically from offset 0
//   to the last page. So **page 1 is both the newest data and the change signal** — a call that
//   has just been analysed can only appear there. That is what lets the Worker poll one cheap
//   request every 30s and refresh the 800-row tail only every few minutes, instead of re-pulling
//   eighteen pages a minute from someone else's server. See /api/concalls in worker/index.js.

export {
  SS_BASE,
  SCAN_URL,
  UPCOMING_URL,
  TODAY_URL,
  PAGE_SIZE,
  RESULT_TIERS,
  SENTIMENT_TIERS,
  resultTierOf,
  sentimentTierOf,
  normaliseScanRow,
  normaliseScheduleRow,
  docUrl,
  mergeScans,
  fingerprint,
} from '../public/js/data/stockscans-shared.js';

import { SCAN_URL, UPCOMING_URL, TODAY_URL, normaliseScanRow, normaliseScheduleRow } from '../public/js/data/stockscans-shared.js';

const HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  'user-agent': 'SattvaCentralResearch/1.0 (+dashboard)',
};

async function postJson(url, body, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error(`StockScans HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * One page of the scan. `offset` is a row offset, not a page number — StockScans returns `next`
 * as the offset to ask for, or null at the end.
 */
export async function fetchScanPage({ offset = 0 } = {}, fetchImpl = fetch) {
  const body = await postJson(SCAN_URL, { offset }, fetchImpl);
  return {
    rows: (body?.rows || []).map(normaliseScanRow).filter(Boolean),
    next: body?.next ?? null,
    total: body?.total ?? null,
    quarter: body?.quarter ?? null,
  };
}

/**
 * The scan. `pages: 1` fetches only the newest 50 — the hot path. `pages: 'all'` walks the cursor
 * to the end, bounded by `maxPages` so a cursor bug upstream cannot become an unbounded loop here.
 */
export async function fetchConcallScans({ pages = 'all', maxPages = 40, startOffset = 0 } = {}, fetchImpl = fetch) {
  const rows = [];
  let offset = startOffset;
  let total = null;
  let quarter = null;
  let fetched = 0;
  const limit = pages === 'all' ? maxPages : Math.max(1, Number(pages) || 1);

  while (fetched < limit) {
    const page = await fetchScanPage({ offset }, fetchImpl);
    if (page.total != null) total = page.total;
    if (page.quarter != null) quarter = page.quarter;
    rows.push(...page.rows);
    fetched++;
    if (page.next == null || !page.rows.length) break;
    offset = page.next;
  }

  return {
    rows,
    meta: {
      quarter,
      total,
      pagesFetched: fetched,
      // True when we stopped because of our own bound rather than because the feed ended. The
      // caller must not present a truncated list as the whole quarter.
      truncated: fetched >= limit && rows.length < (total ?? 0),
      source: 'StockScans — Concall Scans (stockscans.in/concall-scans)',
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** Calls scheduled but not yet held. */
export async function fetchUpcoming(fetchImpl = fetch) {
  const body = await postJson(UPCOMING_URL, {}, fetchImpl);
  return (body?.rows || []).map(normaliseScheduleRow).filter(Boolean);
}

/** Today's calls, with their scheduled times. */
export async function fetchToday(fetchImpl = fetch) {
  const res = await fetchImpl(TODAY_URL, { headers: { accept: 'application/json', 'user-agent': HEADERS['user-agent'] } });
  if (!res.ok) throw new Error(`StockScans HTTP ${res.status} for ${TODAY_URL}`);
  const body = await res.json();
  return { day: body?.day ?? null, rows: (body?.rows || []).map(normaliseScheduleRow).filter(Boolean) };
}

