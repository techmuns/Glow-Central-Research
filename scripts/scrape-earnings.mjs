#!/usr/bin/env node
// scrape-earnings.mjs — the committed baseline for the live earnings feed.
//
//   node scripts/scrape-earnings.mjs
//   MAP_ONLY=1 node scripts/scrape-earnings.mjs     # refresh the ticker map, skip the snapshot
//   MAP_LIMIT=50 node scripts/scrape-earnings.mjs   # cap new lookups (smoke run)
//
// Writes:
//   public/data/earnings-live.json   the last-good snapshot — first paint, and the Worker's
//                                    fallback when Moneycontrol is unreachable
//   public/data/mc-ticker-map.json   scID -> NSE ticker, built incrementally
//
// WHY A SNAPSHOT EXISTS AT ALL WHEN THE FEED IS LIVE
//   The tab reads /api/earnings, which is genuinely live. But a static site whose first paint
//   depends on a third-party API is a static site that shows a spinner when that API is down.
//   The snapshot gives an instant first paint and a labelled fallback; the live poll overwrites
//   it within seconds. The UI always says which one it is showing.
//
// THE TICKER MAP IS THE WHOLE INTEGRATION
//   Moneycontrol identifies companies by its own `scID` (HDF01, DL03, CDS) and truncates display
//   names to 15 characters — "Jubilant Pharmo", "Embassy Develop". Neither is a join key, so
//   nothing can be matched to universe.json or the portfolio by name without silently mis-joining
//   look-alikes. priceapi.moneycontrol.com resolves scID -> NSEID exactly, so we resolve once and
//   cache forever: the map only grows, and a rerun costs one request per company we have never
//   seen. A company we cannot resolve is recorded in `unresolved` and rendered with no ticker
//   rather than guessed at.
//
// Node's built-in fetch ignores HTTPS_PROXY. Behind a proxy, run with NODE_USE_ENV_PROXY=1.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLatestResults, freshnessOf } from '../worker/mc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '../public/data/earnings-live.json');
const MAP_PATH = resolve(__dirname, '../public/data/mc-ticker-map.json');

const PRICE_API = 'https://priceapi.moneycontrol.com/pricefeed/nse/equitycash';
const MAP_LIMIT = Number(process.env.MAP_LIMIT || 4000);
const CONCURRENCY = 6;
const PAUSE_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Resolve one Moneycontrol scID to its NSE symbol. Returns null on any failure so a single dead
 * code never fails the run — the caller records it as unresolved.
 */
async function resolveTicker(scId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${PRICE_API}/${encodeURIComponent(scId)}`, {
        headers: { accept: 'application/json', 'user-agent': 'SattvaCentralResearch/1.0' },
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      const d = body?.data || {};
      const nse = String(d.NSEID || '').trim().toUpperCase();
      if (!nse) return null;
      const shares = Number(d.SHRS);
      return {
        ticker: nse,
        bseId: String(d.BSEID || '').trim() || null,
        // The full company name, which Moneycontrol truncates to 15 chars in the results feed.
        fullName: String(d.company || d.SC_FULLNM || '').trim() || null,
        // Industry, so the column is populated for the ~69% of reporters that sit outside the
        // NSE-500 export. universe.json still wins where it has an entry — it is the curated one.
        industry: String(d.newSubsector || d.main_sector || '').replace(/\s+/g, ' ').trim() || null,
        // Share count, NOT market cap. Storing the count lets the browser compute
        // `shares × live price` on every poll, so the MCap column is live and never goes stale
        // between map refreshes. Verified against their own MKTCAP: 887,786,160 × 5,131.70 =
        // 455,585 Cr, which is exactly what they publish.
        shares: Number.isFinite(shares) && shares > 0 ? shares : null,
        mktCapAtBuild: Number(d.MKTCAP) || null, // sanity reference for the verification suite
      };
    } catch {
      if (attempt === 2) return null;
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

/** Resolve `scIds` with a small worker pool, reporting progress. */
async function buildMap(scIds, existing) {
  const map = { ...existing.map };
  const unresolved = new Set(existing.unresolved || []);
  // Re-resolve an entry that predates a field we now capture, so adding a field to the record
  // does not require anyone to remember to delete the file. `REFRESH_ALL=1` forces the lot,
  // which is how the weekly run refreshes share counts after a buyback or an issue.
  const stale = (s) => map[s] && (map[s].shares === undefined || map[s].industry === undefined);
  const todo = scIds.filter((s) => !map[s] || stale(s) || process.env.REFRESH_ALL).slice(0, MAP_LIMIT);

  if (!todo.length) {
    console.log(`Ticker map: ${Object.keys(map).length} known, nothing new to resolve.`);
    return { map, unresolved: [...unresolved], resolvedNow: 0, failedNow: 0 };
  }
  const fresh = todo.filter((s) => !map[s]).length;
  console.log(`Ticker map: ${Object.keys(map).length} known · resolving ${todo.length} (${fresh} new, ${todo.length - fresh} refreshed)…`);

  let done = 0;
  let ok = 0;
  let bad = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const scId = queue.shift();
        const hit = await resolveTicker(scId);
        if (hit) {
          map[scId] = hit;
          unresolved.delete(scId);
          ok++;
        } else {
          unresolved.add(scId);
          bad++;
        }
        done++;
        if (done % 100 === 0 || done === todo.length) {
          process.stdout.write(`\r  resolved ${done}/${todo.length}  (${ok} ok, ${bad} unresolved)`);
        }
        await sleep(PAUSE_MS);
      }
    })
  );
  process.stdout.write('\n');
  return { map, unresolved: [...unresolved].sort(), resolvedNow: ok, failedNow: bad };
}

async function main() {
  const existing = readJson(MAP_PATH, { map: {}, unresolved: [] });

  console.log('Fetching the full results universe from Moneycontrol…');
  const { rows, meta } = await fetchLatestResults({ limit: 5000, subType: 'yoy', category: 'all' });
  console.log(`  ${rows.length} companies · ${meta.quarter} (${meta.currentPeriod} vs ${meta.priorPeriod})`);

  const scIds = [...new Set(rows.map((r) => r.scId))].sort();
  const { map, unresolved, resolvedNow, failedNow } = await buildMap(scIds, existing);

  writeFileSync(
    MAP_PATH,
    `${JSON.stringify(
      {
        _provenance:
          'scID -> NSE ticker, resolved from priceapi.moneycontrol.com. Moneycontrol identifies companies by its own ' +
          'code and truncates display names to 15 characters, so neither is usable as a join key. This map is the join. ' +
          'It only grows: a rerun costs one request per never-before-seen company. Entries in `unresolved` had no NSEID ' +
          '(unlisted, BSE-only, or delisted) and are rendered without a ticker rather than guessed at.',
        generated_at: new Date().toISOString(),
        source: 'Moneycontrol price feed (priceapi.moneycontrol.com/pricefeed/nse/equitycash/<scID>)',
        count: Object.keys(map).length,
        unresolved_count: unresolved.length,
        unresolved,
        map,
      },
      null,
      0
    )}\n`
  );
  console.log(`Wrote ${MAP_PATH}`);
  console.log(`  ${Object.keys(map).length} mapped (+${resolvedNow} this run) · ${unresolved.length} unresolved (+${failedNow})`);

  if (process.env.MAP_ONLY) return;

  const withTickers = rows.map((r) => ({ ...r, ticker: map[r.scId]?.ticker || null, fullName: map[r.scId]?.fullName || null }));
  const mapped = withTickers.filter((r) => r.ticker).length;

  writeFileSync(
    SNAPSHOT_PATH,
    `${JSON.stringify({
      _provenance:
        'REAL DATA, point-in-time snapshot. Quarterly results as published by Moneycontrol Rapid Results. This file is the ' +
        'dashboard\'s FIRST PAINT and the Worker\'s FALLBACK when the live upstream is unreachable; the tab replaces it with ' +
        'live data from /api/earnings within seconds of mounting. Figures are Moneycontrol\'s, in Rs. crore, rounded as they ' +
        'publish them. Growth percentages where the sign flips between periods are classified, not shown as growth rates.',
      ok: true,
      degraded: null,
      ...freshnessOf(rows),
      meta: { ...meta, mapped_tickers: mapped, unmapped_tickers: rows.length - mapped },
      rows: withTickers,
    })}\n`
  );

  const kinds = {};
  for (const r of rows) kinds[r.netProfit?.kind || 'missing'] = (kinds[r.netProfit?.kind || 'missing'] || 0) + 1;

  console.log(`Wrote ${SNAPSHOT_PATH}`);
  console.log(`  ${rows.length} companies · ${mapped} with an NSE ticker · ${rows.length - mapped} without`);
  console.log(`  latest result date: ${freshnessOf(rows).latestResultDate}`);
  console.log(`  net-profit change kinds: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
}

main().catch((err) => {
  console.error('scrape-earnings failed:', err.message || err);
  // A failed run must not leave a half-written snapshot behind; we simply exit non-zero and the
  // previously committed file stays in place, which is exactly what the Worker falls back to.
  process.exit(1);
});
