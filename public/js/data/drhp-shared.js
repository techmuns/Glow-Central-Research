// Dedicated DRHP contract: each filing owns its nested documents. No IPO status is inferred.
import { documentUrl, validDay } from './combined-filings-shared.js';
import { isoDate } from './filings-shared.js';

const clean = (value) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
export function validateDrhpCompany(value) {
  const company = typeof value === 'string' ? value.trim() : '';
  // The upstream also has administrative /drhp/sync* routes, including a mutating GET.
  // Only one ordinary company path segment may ever reach it, never those reserved names.
  if (!company || company.length > 200 || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'’()_\-]*$/u.test(company) || /^sync(?:_|$)/i.test(company)) {
    throw new Error('Enter a ticker or exact company name (up to 200 characters).');
  }
  return company;
}

export function normaliseDrhpFilings(payload) {
  if (!Array.isArray(payload)) throw new Error('The DRHP service did not return an array.');
  const rows = [];
  let unmapped = 0;
  let unmappedDocuments = 0;
  for (const [index, item] of payload.slice(0, 50).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { unmapped++; continue; }
    const company = clean(item.company_name);
    const symbol = clean(item.symbol);
    const form = clean(item.form_type);
    const candidateDate = isoDate(item.filing_date);
    const date = validDay(candidateDate) ? candidateDate : null;
    const source = clean(item.source);
    const documents = new Map();
    if (item.documents != null && !Array.isArray(item.documents)) unmappedDocuments++;
    for (const doc of Array.isArray(item.documents) ? item.documents : []) {
      const object = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
      const url = documentUrl(typeof doc === 'string' ? doc : object?.url || object?.link || object?.document_url || object?.filing_url);
      if (!url) { unmappedDocuments++; continue; }
      const label = clean(object?.title || object?.name || object?.document_name || object?.document_type);
      const prior = documents.get(url);
      documents.set(url, { url, label: prior?.label || label || '' });
    }
    if (!company && !symbol && !form && !date && !source && !documents.size) { unmapped++; continue; }
    rows.push({ key: `drhp:${index}`, company: company || null, symbol: symbol || null, form: form || null,
      date, source: source || null, documents: [...documents.values()].map((doc, i) => ({ ...doc, label: doc.label || `Document ${i + 1}` })) });
  }
  return { rows: rows.sort((a, b) => (b.date || '').localeCompare(a.date || '')), unmapped, unmappedDocuments,
    returnedCount: payload.length, limitReached: payload.length >= 50, omittedRows: Math.max(0, payload.length - 50) };
}
