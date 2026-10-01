// UPSTOX NEWS. Free with the owner's Upstox account: GET https://api.upstox.com/v2/news returns each
// requested instrument's news from the last 7 days, up to 30 instrument keys per request. The
// read-only Analytics Token lasts a year and needs no static IP for News, so a scheduled job can
// use it unattended. It covers listed instruments only; Google News still searches every company
// by name. Without UPSTOX_ANALYTICS_TOKEN this source is skipped and reported as not configured.

const ENDPOINT = 'https://api.upstox.com/v2/news';
export const UPSTOX_KEYS_PER_REQUEST = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const DEADLINE_MS = 20_000;

/**
 * The Upstox instrument key for each active ISIN of an entity: BSE for a numeric (scrip-code) or
 * missing ticker, NSE otherwise.
 */
export function upstoxInstrumentKeys(entity) {
  const exchange = !entity?.ticker || /^\d+$/.test(String(entity.ticker)) ? 'BSE_EQ' : 'NSE_EQ';
  return [...new Set((entity?.portfolioIsins || []).filter((isin) => /^IN[A-Z0-9]{10}$/.test(isin))
    .map((isin) => `${exchange}|${isin}`))];
}

const outlet = (link) => {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return null; }
};

/** One Upstox item as the row shape `observedCompanyArticles` takes. */
export function upstoxArticle(item) {
  const at = Number(item?.published_time);
  const publishedAt = Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
  const url = typeof item?.article_link === 'string' && /^https:\/\//.test(item.article_link) ? item.article_link : null;
  const title = String(item?.heading || '').trim();
  if (!title || !url) return null;
  return { title, url, summary: String(item?.summary || '').trim() || null, publishedAt,
    date: publishedAt ? publishedAt.slice(0, 10) : null, source: outlet(url), discoverySource: 'upstox-news' };
}

/**
 * Every entity's Upstox news. One failed batch is recorded and the rest continue, so a single bad
 * instrument key cannot hide the others' news.
 */
export async function fetchUpstoxNews({ entities, token, fetcher = fetch }) {
  const owners = new Map();
  for (const entity of entities || []) {
    for (const key of upstoxInstrumentKeys(entity)) if (!owners.has(key)) owners.set(key, entity);
  }
  const keys = [...owners.keys()];
  const rows = [], errors = [];
  let requests = 0;
  for (let i = 0; i < keys.length; i += UPSTOX_KEYS_PER_REQUEST) {
    const batch = keys.slice(i, i + UPSTOX_KEYS_PER_REQUEST);
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${ENDPOINT}?category=instrument_keys&instrument_keys=${encodeURIComponent(batch.join(','))}&page_number=${page}&page_size=${PAGE_SIZE}`;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), DEADLINE_MS);
      let body;
      requests++;
      try {
        const res = await fetcher(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: abort.signal });
        body = await res.json().catch(() => null);
        if (!res.ok || body?.status !== 'success') {
          throw Error(body?.errors?.[0]?.errorCode || body?.errors?.[0]?.message || `HTTP ${res.status}`);
        }
      } catch (err) {
        errors.push({ batch: i / UPSTOX_KEYS_PER_REQUEST, page, error: abort.signal.aborted ? 'timeout' : String(err?.message || err).slice(0, 120) });
        break;
      } finally {
        clearTimeout(timer);
      }
      const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
      for (const [key, items] of Object.entries(data)) {
        const entity = owners.get(key);
        if (!entity || !Array.isArray(items)) continue;
        for (const item of items) {
          const row = upstoxArticle(item);
          if (row) rows.push({ entity, row });
        }
      }
      const pages = Number(body?.metadata?.page?.total_pages);
      if (!Number.isFinite(pages) || page >= pages) break;
    }
  }
  return { rows, requests, instruments: keys.length, errors };
}
