import { dealCategory, bulkDealKey as key } from '../../public/js/data/investor-changes.js';

/** Retain the shared public deal history alongside this dashboard's existing insider rows. */
export function mergeBulkDeals(current, source, { capturedAt, sourceUrl, error = null } = {}) {
  const byTicker = structuredClone(current.byTicker || {});
  const seen = new Set(Object.values(byTicker).flat().filter(dealCategory).map(key));
  const sourceRows = Object.values(source?.byTicker || {}).flat().filter(dealCategory);
  for (const row of sourceRows) {
    if (!row.ticker || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') || seen.has(key(row))) continue;
    seen.add(key(row));
    (byTicker[row.ticker] ||= []).push(row);
  }
  const rows = Object.values(byTicker).flat(), deals = rows.filter(dealCategory);
  const dates = deals.map((r) => r.date).filter(Boolean).sort();
  const prior = current.bulkDeals || source?.bulkDeals;
  const empty = (current.empty || []).filter((t) => !byTicker[typeof t === 'string' ? t : t.ticker]?.length);
  return { ...current, byTicker, empty, emptyCount: empty.length,
    headers: [...new Set([...(current.headers || []), ...deals.flatMap((r) => Object.keys(r.cells || {}))])],
    rowCount: rows.length, withRows: Object.keys(byTicker).length,
    bulkDeals: { source: 'Screener.in bulk and block listings via the shared Sattva capture',
      sourceUrl: sourceUrl || prior?.sourceUrl || null, capturedAt: capturedAt || prior?.capturedAt || null,
      from: dates[0] || null, to: dates.at(-1) || null, rows: deals.length, error },
  };
}
