import { BseAnnError, CATEGORIES, fetchAnnouncements, fetchCompanyAnnouncements } from '../../worker/bse-ann.mjs';

// A new filing can shift every subsequent page. Restart the affected walk from page one;
// never join rows from different attempts or relax the adapter's completeness checks.
async function stableWalk(read, { fetchImpl = fetch, attempts = 3, retryDelayMs = 1000,
  onRetry = null, ...options } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3
    || !Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30000) {
    throw new TypeError('BSE collection allows 1–3 attempts and a retry delay of 0–30000ms.');
  }
  let requests = 0;
  const countedFetch = (...args) => { requests++; return fetchImpl(...args); };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await read({ ...options, fetchImpl: countedFetch });
      return { ...result, requests };
    } catch (error) {
      const detail = error?.detail;
      const changedCount = error instanceof BseAnnError && error.reason === 'shape'
        && Number.isSafeInteger(detail?.declared) && Number.isSafeInteger(detail?.pageDeclared)
        && detail.declared !== detail.pageDeclared;
      // Access denials, malformed data, repeated rows and ignored filters are not page drift.
      if (!changedCount || attempt === attempts) throw error;
      onRetry?.({ attempt, nextAttempt: attempt + 1, error });
      if (retryDelayMs) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function collectBseAnnouncements({ categories = CATEGORIES, ...range }, options = {}) {
  if (!Array.isArray(categories) || !categories.length) {
    throw new TypeError('BSE collection requires at least one named category.');
  }
  const result = { rows: [], byCategory: {}, unknownCategories: {}, requests: 0, shortfall: [] };
  for (const category of categories) {
    const captured = await stableWalk(
      readOptions => fetchAnnouncements({ ...range, categories: [category] }, readOptions), options,
    );
    result.rows.push(...captured.rows);
    Object.assign(result.byCategory, captured.byCategory);
    for (const [name, count] of Object.entries(captured.unknownCategories)) {
      result.unknownCategories[name] = (result.unknownCategories[name] || 0) + count;
    }
    result.shortfall.push(...captured.shortfall);
    result.requests += captured.requests;
  }
  return result;
}

export function collectBseCompanyAnnouncements(range, options = {}) {
  return stableWalk(readOptions => fetchCompanyAnnouncements(range, readOptions), options);
}
