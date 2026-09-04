// Shared, source-preserving adaptation for the Muns combined document index.
// Field aliases come from the existing announcement adapter and the published Filing DTO.
import { pickField, isoDate } from './filings-shared.js';

export const DOCUMENT_FORMS = ['all', 'concalls', 'annual_report', 'earnings_report'];
export const FORM_LABELS = { all: 'All filings & reports', concalls: 'Con-call documents', annual_report: 'Annual reports', earnings_report: 'Earnings reports' };
const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const clean = (value) => text(value).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
export function documentUrl(value) {
  try { const u = new URL(text(value)); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
export function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function sourcesFor(source, url) {
  const labels = [];
  const explicit = clean(source);
  if (explicit) labels.push(explicit);
  const host = url ? new URL(url).hostname.toLowerCase() : '';
  const tags = new Set();
  for (const [name, pattern] of [['NSE', /\bnse\b/i], ['BSE', /\bbse\b/i], ['DRHP', /\bdrhp\b/i], ['SEC', /\bsec\b/i], ['Screener', /\bscreener\b/i]]) {
    if (pattern.test(explicit)) tags.add(name);
  }
  for (const [name, domain] of [['NSE', 'nseindia.com'], ['BSE', 'bseindia.com'], ['SEC', 'sec.gov'], ['Screener', 'screener.in']]) {
    if (host === domain || host.endsWith(`.${domain}`)) tags.add(name);
  }
  for (const tag of tags) if (!labels.some((label) => label.toLowerCase() === tag.toLowerCase())) labels.push(tag);
  return { sources: labels, sourceTags: [...tags] };
}

export function normaliseCombinedFilings(payload, request) {
  if (!Array.isArray(payload)) throw new Error('The combined filings service did not return an array.');
  const records = [];
  let invalid = 0;
  for (const item of payload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { invalid++; continue; }
    // The announcements DTO groups records as { source, data: AnnouncementDto[] }.
    if (Array.isArray(item.data)) {
      for (const child of item.data) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) { invalid++; continue; }
        records.push({ ...child, source: child.source || item.source });
      }
    } else records.push(item);
  }
  const byKey = new Map();
  let unmapped = invalid;
  for (const [i, record] of records.entries()) {
    const title = clean(pickField(record, ['title', 'headline', 'subject', 'newsSub', 'attachmentName', 'name']));
    const url = documentUrl(pickField(record, ['filing_url', 'url', 'link', 'attachment', 'attachmentUrl', 'pdfUrl', 'fileUrl', 'href']));
    const candidateDate = isoDate(pickField(record, ['date', 'filingDate', 'announcementDate', 'submissionDate', 'publishedAt', 'timestamp']));
    const date = validDay(candidateDate) ? candidateDate : null;
    const form = clean(pickField(record, ['form', 'type', 'category']));
    const identity = sourcesFor(pickField(record, ['source', 'exchange', 'group']), url);
    const suppliedTicker = clean(pickField(record, ['ticker', 'symbol'])).toUpperCase();
    const ticker = suppliedTicker || request.ticker;
    const isRead = typeof record.isRead === 'boolean' ? record.isRead : null;
    const mapped = !!(title || url);
    if (!mapped) unmapped++;
    const key = `${ticker}|${url || (mapped ? `${date || ''}|${title}|${form}|${identity.sources.join(',')}` : `unknown:${i}`)}`;
    const row = { key, ticker, title: title || 'Untitled filing', date, form: form || null, url, isRead,
      summary: clean(pickField(record, ['desc', 'description', 'summary'])), ...identity, mapped };
    const prior = byKey.get(key);
    if (prior) {
      // A less detailed duplicate must not erase a known date, subject or document form.
      row.title = title || prior.title;
      row.date = prior.date || row.date;
      row.form = row.form || prior.form;
      row.summary = row.summary || prior.summary;
      row.sources = [...new Set([...prior.sources, ...row.sources])];
      row.sourceTags = [...new Set([...prior.sourceTags, ...row.sourceTags])];
      row.isRead = prior.isRead === row.isRead ? row.isRead : null;
    }
    byKey.set(key, row);
  }
  return { rows: [...byKey.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.key.localeCompare(b.key)), unmapped };
}
