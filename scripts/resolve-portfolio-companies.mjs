#!/usr/bin/env node
// Resolve the active Family Office snapshot with the SAME resolver as the live API.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolvePortfolio } from '../worker/portfolio-resolver.mjs';
const root = new URL('../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const fixture = read('scripts/fixtures/family-book.json');
if (!fixture.lines?.length || fixture.lines.some(l => !/^INE[A-Z0-9]{9}$/.test(l.isin || '') || !l.name)) throw new Error('Invalid family book fixture');
const sources = { scans: read('public/data/concall-scans.json'), mc: read('public/data/mc-ticker-map.json'), universe: read('public/data/universe.json') };
const squash = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(limited|ltd|the|company|co|corporation|corp|inc|plc)\b/g, '').replace(/[^a-z0-9]/g, '');
async function yahooLookup(name) {
  const q = encodeURIComponent(name.replace(/\s*—\s*warrants$/i, ''));
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${q}&quotesCount=8&newsCount=0`;
  let body;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const b = squash(name);
  for (const qt of body?.quotes || []) {
    if (!/\.NS$/.test(qt.symbol || '')) continue; // NSE only — the feeds here are NSE-keyed
    const yn = squash(qt.shortname || qt.longname || '');
    if (!yn || yn.length < 6) continue;
    if (b.startsWith(yn) || yn.startsWith(b)) {
      return { ticker: qt.symbol.replace(/\.NS$/, '').toUpperCase(), name: qt.shortname || qt.longname, source: 'yahoo-search' };
    }
  }
  return null;
}


const payload = await resolvePortfolio(fixture, sources, process.argv.includes('--net') ? yahooLookup : null);
console.log(JSON.stringify({ count: payload.count, resolved: payload.resolved, unresolved: payload.unresolved, source: payload.source, asOf: payload.asOf }));
if (!process.argv.includes('--dry')) writeFileSync(new URL('public/data/portfolio-companies.json', root), JSON.stringify(payload, null, 2) + '\n');
