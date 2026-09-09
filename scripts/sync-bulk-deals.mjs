// The same public market capture behind Sattva's Bulk/Block Deal tab. No family data is copied.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mergeBulkDeals } from './lib/bulk-deals-snapshot.mjs';

const sourceUrl = 'https://raw.githubusercontent.com/techmuns/Sattva-Central-Research/main/public/data/insider-trades.json';
export async function syncBulkDeals(file = new URL('../public/data/insider-trades.json', import.meta.url)) {
const current = JSON.parse(readFileSync(file, 'utf8'));
try {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Shared deal capture returned HTTP ${response.status}`);
  const source = await response.json();
  if (!source.byTicker || !Number.isFinite(Date.parse(source.capturedAt)) ||
      !Object.values(source.byTicker).flat().some((r) => /^Bulk deal$|^Block deal$/.test(r.cells?.['Trade Category'] || ''))) {
    throw new Error('Shared capture contains no identifiable bulk/block records');
  }
  const sources = (source.sources || []).filter((s) => ['bulk', 'block'].includes(s.id));
  if (sources.length !== 2 || sources.some((s) => s.ok !== true || !Number.isFinite(Date.parse(s.capturedAt)))) {
    throw new Error('Bulk/block source checks are incomplete or failed');
  }
  const capturedAt = sources.map((s) => s.capturedAt).sort()[0];
  if (Date.parse(capturedAt) < Date.parse(current.bulkDeals?.capturedAt || '')) throw new Error('Shared capture is older than the retained bulk/block source');
  const merged = mergeBulkDeals(current, source, { capturedAt, sourceUrl });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`Retained ${merged.bulkDeals.rows} bulk/block deals (${merged.bulkDeals.from} – ${merged.bulkDeals.to}); source captured ${source.capturedAt}`);
  return true;
} catch (error) {
  const retained = mergeBulkDeals(current, null, { error: `Bulk/block refresh failed: ${error.message}. Previously captured records retained.` });
  writeFileSync(file, `${JSON.stringify(retained, null, 2)}\n`);
  console.error(retained.bulkDeals.error);
  return false;
}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await syncBulkDeals() ? 0 : 1;
