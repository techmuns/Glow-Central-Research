// Lossless records shared by source tabs and General Alerts. No network, disk or token storage.
import { onHostContext } from '../core/host-context.js';
import { documentUrl } from './combined-filings-shared.js';

const privateRows = new Map();
const privateReads = new Map();
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
export function clearPrivateRecords() {
  privateRows.clear(); privateReads.clear(); emit();
}
onHostContext((_, changed) => { if (changed?.session) clearPrivateRecords(); });

// Called only after the lookup's existing account/generation guard succeeds. Preserve ALL returned
// records, before source-specific table filters. Never initiate private per-company requests here.
export function recordDocuments(kind, payload, company = null) {
  const rows = privateRows.get(kind) || new Map();
  for (const row of payload.rows || []) {
    const key = row.key || row.id || JSON.stringify([row.symbol, row.company, row.form, row.date, row.documents]);
    rows.set(key, { ...row, company: row.company || company?.name || row.ticker || null });
  }
  privateRows.set(kind, rows);
  const reads = privateReads.get(kind) || new Map();
  reads.set(company?.ticker || payload.company || 'lookup', {
    incomplete: !!(payload.unmapped || payload.unmappedDocuments || payload.limitReached || payload.omittedRows),
    checkedAt: Date.now(),
  });
  privateReads.set(kind, reads);
  emit();
}
export function documentRecords(kind) {
  return { rows: [...(privateRows.get(kind)?.values() || [])], reads: [...(privateReads.get(kind)?.values() || [])] };
}

export const istDay = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(0, 10) : null;
};
export const istTime = (value) => {
  if (!value || /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms + 19800000).toISOString().slice(11, 16) : null;
};
export function record({ id, row, at = null, ticker = null, company, headline, detail, url = null, kind = 'record', ...extra }) {
  return {
    id, at, day: istDay(at), time: istTime(at), ticker: ticker || null,
    company: company || ticker || 'Unresolved company', headline, detail: detail || '', url: documentUrl(url), kind,
    direction: 'neutral', importance: 'low', severity: 'update',
    // Phase one expands collection, not AI policy. Raw snapshots/schedules must not accidentally
    // masquerade as independent corroborating signals in the existing priority model.
    aiEligible: false,
    signalReason: 'Source record retained without a directional inference.',
    importanceReason: 'Retained regardless of importance; prioritization belongs to AI Alerts.',
    // The full normalized source record survives table truncation and summary wording.
    sourceRecord: row, ...extra,
  };
}
