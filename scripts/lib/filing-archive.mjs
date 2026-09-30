import { join } from 'node:path';
import { readJson, writeJson } from './company-capture.mjs';
import { readNewsJson, writeNewsJson } from './news-json-storage.mjs';
import { mergeAnnouncements } from '../../public/js/data/announcements-shared.js';
import { mergeInsiderTrades } from '../../public/js/data/insider-history.js';

/** Preserve events before a recent snapshot applies its size/date window. No archive expiry. */
export function archiveFilings(dir, kind, rows, storageOptions = {}) {
  const indexPath = join(dir, 'index.json');
  const index = readJson(indexPath, { version: 1, months: {} });
  const buckets = new Map();
  for (const { raw, ...row } of rows) {
    const month = /^\d{4}-(0[1-9]|1[0-2])-/.test(row.date || '') ? row.date.slice(0, 7) : 'undated';
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(row);
  }
  for (const [month, incoming] of buckets) {
    const path = join(dir, `${month}.json`);
    const previous = readNewsJson(path, { rows: [] });
    const merged = kind === 'insider' ? mergeInsiderTrades(previous.rows, incoming) : mergeAnnouncements(previous.rows, incoming);
    // Reuse the verified lossless transport. Large filing months must remain deployable.
    if (kind === 'announcements') {
      // Match the existing JSON file contract: absent optional fields (e.g. no BSE code
      // for an NSE-only issuer) are omitted before verifying the lossless partition.
      const stored = merged.map(row => JSON.parse(JSON.stringify(row)));
      writeNewsJson(path, { kind, rows: stored }, storageOptions);
    }
    else writeJson(path, { kind, rows: merged });
    index.months[month] = merged.length;
  }
  index.rowCount = Object.values(index.months).reduce((a, b) => a + b, 0);
  index.updatedAt = new Date().toISOString();
  writeJson(indexPath, index);
  return index;
}
