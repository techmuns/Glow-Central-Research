// Shared by capture publication and the browser; changing this shape requires a new version.
import { newsPublicationDay, newsDay } from './news-window.js';
import { canonicalArticleUrl } from './filings-shared.js';
export const NEWS_QUERY_INDEX_VERSION = 2;
// A compact candidate fingerprint, NEVER a record/deduplication identity. A collision can only
// fetch extra companions: final canonicalization still compares the complete original URLs.
// This keeps the index much smaller than repeating long publisher URLs beside every version.
export function newsQueryIdentity(row) {
  const value = row?.url ? `url:${canonicalArticleUrl(row.url)}` : row?.tradingViewId ? `tv:${row.tradingViewId}` : '';
  if (!value) return '';
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function newsQueryIndexRow(row) {
  const day = newsPublicationDay(row), instantDay = row?.publishedAt ? newsDay(row.publishedAt) : null;
  return [day, instantDay === day ? null : instantDay, newsQueryIdentity(row)];
}
export const validNewsQueryIndex = (rows, count) => Array.isArray(rows) && rows.length === count && rows.every(row =>
  Array.isArray(row) && row.length === 3 && row.slice(0, 2).every(day => day === null || /^\d{4}-\d{2}-\d{2}$/.test(day)) && typeof row[2] === 'string');
