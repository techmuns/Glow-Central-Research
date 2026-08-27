// scripts/import-tracked-universe.mjs — the tracking universe for the filings feeds.
//
//   node scripts/import-tracked-universe.mjs                     floor 500 Cr (the default)
//   UNIVERSE_FLOOR_CR=1000 node scripts/import-tracked-universe.mjs
//
// WHAT THIS IS, AND WHY IT IS SEPARATE FROM universe.json
//   universe.json is the NSE-500 screener export the technicals pipeline joins on — 535 companies,
//   because that is the index the technical model was built for. The FILINGS feeds (Corporate
//   Announcements, Insider Trades) have no such ceiling: an announcement or an insider trade is worth
//   tracking for any listed company, not just an index constituent. So this reads a much broader
//   Screener export — every company above a market-cap floor — and writes the list the filings tabs
//   and scripts/scrape-filings.mjs walk, ORDERED BY MARKET CAP so the biggest companies are covered
//   first (a bounded walk cut short by the rate limit has then covered what matters most).
//
// THE INPUT IS COMMITTED, so the output regenerates byte-for-byte from a diffable source. To refresh
// the universe, re-export from Screener with the same columns, drop it over
// scripts/fixtures/tracked-universe.csv, and re-run this. Only three columns are read — Name, NSE
// Code, Market Capitalization — the rest of the export is ignored.
//
// NO npm DEPENDENCY for the CSV. The export quotes any field that contains a comma (an industry like
// "Residential, Commercial Projects"), so a naive split misaligns every column after it. The small
// RFC-4180 field splitter below handles quotes and escaped quotes, which is all this file needs.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IN = resolve(__dirname, 'fixtures/tracked-universe.csv');
const OUT = resolve(__dirname, '../public/data/tracked-universe.json');
const FLOOR_CR = Number(process.env.UNIVERSE_FLOOR_CR || 500);

/** One CSV line -> fields, honouring double-quoted fields and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const raw = readFileSync(IN, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.length);
const header = splitCsvLine(lines[0]).map((h) => h.trim());
const idx = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column not found in CSV header: "${name}"`);
  return i;
};
const iName = idx('Name');
const iNSE = idx('NSE Code');
const iMcap = idx('Market Capitalization');

// ticker -> { ticker, name, marketCapCr }. A Map is the collision guard: two rows resolving to one
// NSE code means one is a stale duplicate, and we keep the larger market cap and count the drop.
const byTicker = new Map();
let noNSE = 0;
let belowFloor = 0;
let unparseableMcap = 0;
let collisions = 0;

for (let r = 1; r < lines.length; r++) {
  const c = splitCsvLine(lines[r]);
  const ticker = (c[iNSE] || '').trim().toUpperCase();
  const name = (c[iName] || '').trim();
  const marketCapCr = Number((c[iMcap] || '').replace(/,/g, '').trim());
  if (!ticker) { noNSE++; continue; } // BSE-only — the per-ticker route keys on the NSE symbol
  if (!Number.isFinite(marketCapCr)) { unparseableMcap++; continue; }
  if (marketCapCr < FLOOR_CR) { belowFloor++; continue; }
  const prev = byTicker.get(ticker);
  if (prev) {
    collisions++;
    if (marketCapCr <= prev.marketCapCr) continue; // keep the larger; a smaller dupe is the stale one
  }
  byTicker.set(ticker, { ticker, name, marketCapCr });
}

// Biggest first — the walk order, and the priority the reader asked for.
const companies = [...byTicker.values()].sort((a, b) => b.marketCapCr - a.marketCapCr);

const payload = {
  source: `Screener export (scripts/fixtures/tracked-universe.csv), companies at or above ₹${FLOOR_CR} Cr market cap, ordered by market cap`,
  floorCr: FLOOR_CR,
  count: companies.length,
  generatedAt: new Date().toISOString(),
  companies,
};

writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');

console.log(`tracked-universe.json — ${companies.length} companies at or above ₹${FLOOR_CR} Cr, ordered by market cap`);
console.log(`  dropped: ${noNSE} BSE-only (no NSE code), ${belowFloor} below floor, ${unparseableMcap} unparseable market cap, ${collisions} duplicate NSE code(s)`);
console.log(`  top: ${companies.slice(0, 6).map((c) => `${c.ticker} (₹${Math.round(c.marketCapCr).toLocaleString('en-IN')} Cr)`).join(', ')}`);
console.log(`  -> ${OUT}`);
