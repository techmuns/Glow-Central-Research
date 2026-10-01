import { BseAnnError, CATEGORIES, annUrl, compact, fetchAnnouncements, fetchCompanyAnnouncements } from '../../worker/bse-ann.mjs';

export const bseIndiaDay = (now = Date.now()) => new Date(Number(now) + 330 * 60000).toISOString().slice(0, 10);

// A multi-day backlog must not keep restarting because today's total changes. Validate the
// original interval first, then keep closed history and the live day in disjoint windows.
export function bseCollectionWindows(range, today = bseIndiaDay()) {
  annUrl({ ...range, category: CATEGORIES[0] });
  annUrl({ from: today, to: today, category: CATEGORIES[0] });
  const current = compact(today);
  if (compact(range.from) >= current || compact(range.to) < current) return [range];
  const day = `${current.slice(0, 4)}-${current.slice(4, 6)}-${current.slice(6)}`;
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return [{ ...range, to: yesterday }, { ...range, from: day }];
}

function appendWindow(rows, observed, captured, context) {
  for (const row of captured.rows) {
    // Rows without NEWSID cannot duplicate across disjoint, adapter-validated dates. A NEWSID
    // moved to another date while reading must still fail, as it would in one paginated walk.
    if (row.newsId && observed.has(row.newsId)) {
      throw new BseAnnError('shape', 'BSE repeated an announcement across capture windows.', { ...context, newsId: row.newsId });
    }
    if (row.newsId) observed.add(row.newsId);
    rows.push(row);
  }
}

export function bseLastCompleteTo(capture) {
  return capture?.lastCompleteTo || (!capture?.shortfall?.length && !Object.keys(capture?.failed || {}).length
    && capture?.coversUniverse !== false ? capture?.to : null) || null;
}

export function bseCaptureCoverage(result, previous = null) {
  const failedWindows = result.failedWindows || [];
  return {
    coversUniverse: !failedWindows.length && !result.shortfall.length && !Object.keys(result.unknownCategories).length,
    lastCompleteTo: [bseLastCompleteTo(previous), result.completeTo].filter(Boolean).sort().at(-1) || null,
    failed: failedWindows.length ? { 'BSE collection': { reason: 'partial',
      message: 'Some BSE category/date windows could not be fully checked.', windows: failedWindows } } : [],
    failedWindows,
  };
}

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

export async function collectBseAnnouncements({ categories = CATEGORIES, ...range }, { today, allowPartial = false, ...options } = {}) {
  if (!Array.isArray(categories) || !categories.length) {
    throw new TypeError('BSE collection requires at least one named category.');
  }
  const windows = bseCollectionWindows(range, today);
  const result = { rows: [], byCategory: {}, unknownCategories: {}, requests: 0, shortfall: [], failedWindows: [], completeTo: null };
  const observed = new Map(categories.map(category => [category, new Set()]));
  let contiguous = true;
  // Finish every historical category before touching the live day. A live failure cannot undo
  // a closed, fully checked interval, and a historical gap cannot be skipped by a later success.
  for (const window of windows) {
    let complete = true;
    for (const category of categories) {
      const counts = result.byCategory[category] ||= { declared: 0, collected: 0, pages: 0 };
      const partial = new Map();
      let requests = 0, validatedPages = 0, captured;
      try {
        captured = await stableWalk(
          readOptions => fetchAnnouncements({ ...window, categories: [category] }, readOptions), {
            ...options,
            fetchImpl: (...args) => { requests++; return (options.fetchImpl || fetch)(...args); },
            onPage: value => {
              validatedPages++;
              if (allowPartial) for (const row of value.rows) partial.set(row.newsId || JSON.stringify(row), row);
              options.onPage?.(value);
            },
          },
        );
      } catch (error) {
        if (!allowPartial || !(error instanceof BseAnnError)) throw error;
        complete = false;
        result.failedWindows.push({ category, from: window.from, to: window.to, reason: error.reason, message: error.message });
        captured = { rows: [...partial.values()], byCategory: { [category]: {
          declared: null, collected: partial.size, pages: validatedPages,
        } }, unknownCategories: {}, shortfall: [] };
      }
      appendWindow(result.rows, observed.get(category), captured, { category });
      const current = captured.byCategory[category];
      counts.declared = counts.declared === null || current.declared === null ? null : counts.declared + current.declared;
      counts.collected += current.collected;
      counts.pages += current.pages;
      for (const [name, count] of Object.entries(captured.unknownCategories)) {
        result.unknownCategories[name] = (result.unknownCategories[name] || 0) + count;
      }
      result.shortfall.push(...captured.shortfall);
      result.requests += requests;
      if (captured.shortfall.length || Object.keys(captured.unknownCategories).length) complete = false;
    }
    contiguous &&= complete;
    if (contiguous) {
      const to = compact(window.to);
      result.completeTo = `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`;
    }
  }
  return result;
}

export async function collectBseCompanyAnnouncements(range, { today, ...options } = {}) {
  const windows = bseCollectionWindows(range, today), observed = new Set();
  const result = { rows: [], scripCode: String(range.scripCode || '').trim(), declared: 0, collected: 0, pages: 0, requests: 0 };
  for (const window of windows) {
    const captured = await stableWalk(readOptions => fetchCompanyAnnouncements(window, readOptions), options);
    appendWindow(result.rows, observed, captured, { scripCode: result.scripCode });
    for (const key of ['declared', 'collected', 'pages', 'requests']) result[key] += captured[key];
  }
  return result;
}
