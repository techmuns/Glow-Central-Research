#!/usr/bin/env node
// scripts/scrape-concalls.mjs — commit the StockScans con-call scan to public/data/concall-scans.json
//
//   node scripts/scrape-concalls.mjs
//
// This file has the same two jobs the earnings snapshot has: FIRST PAINT (so the tab is populated
// before any network round-trip, and works on a plain `python3 -m http.server`) and the Worker's
// FALLBACK when StockScans is unreachable. It is not what makes the tab fresh — the tab is live
// off /api/concalls, which re-reads the newest page every 30 seconds. Refreshing this file more
// often would only shorten how stale the fallback can be.
//
// Unlike the calendar capture, there is no bot wall here: StockScans answers a Cloudflare Worker
// the same way it answers this script. So this really is a fallback, not the primary path.

import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchConcallScans, fetchUpcoming, fetchToday, resultTierOf, sentimentTierOf } from '../worker/stockscans.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/data/concall-scans.json');

async function main() {
  console.log('Fetching the con-call scan from StockScans…');
  const { rows, meta } = await fetchConcallScans({ pages: 'all' });
  if (!rows.length) throw new Error('StockScans returned no rows — refusing to write an empty snapshot');
  if (meta.truncated) console.warn(`  WARNING: stopped at our own page bound with ${rows.length} of ${meta.total} rows.`);

  const [upcoming, today] = await Promise.all([fetchUpcoming().catch(() => []), fetchToday().catch(() => ({ day: null, rows: [] }))]);

  const payload = { ok: true, degraded: null, rows, upcoming, today, meta };
  await writeFile(OUT, `${JSON.stringify(payload)}\n`);

  const scored = rows.filter((r) => r.resultScore != null);
  const pending = rows.length - scored.length;
  const byTier = {};
  for (const r of scored) {
    const t = resultTierOf(r.resultScore)?.label || '?';
    byTier[t] = (byTier[t] || 0) + 1;
  }
  const bySent = {};
  for (const r of rows) {
    const t = sentimentTierOf(r.sentimentTier)?.label || 'pending';
    bySent[t] = (bySent[t] || 0) + 1;
  }

  console.log(`Wrote ${OUT}`);
  console.log(`  ${rows.length} calls · quarter ${meta.quarter} · ${meta.pagesFetched} pages`);
  console.log(`  ${rows[rows.length - 1]?.date} .. ${rows[0]?.date}`);
  console.log(`  result tier: ${Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  sentiment:   ${Object.entries(bySent).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  ${pending} awaiting analysis · ${upcoming.length} upcoming · ${today.rows.length} today (${today.day})`);
}

main().catch((err) => {
  console.error('scrape-concalls failed:', err.message);
  process.exit(1);
});
