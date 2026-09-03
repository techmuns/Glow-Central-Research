#!/usr/bin/env node
// scripts/check-book.mjs — refuse a book.json that does not reconcile. GLOW-OWNED.
//
//   node scripts/check-book.mjs            # checks public/data/book.json
//   node scripts/check-book.mjs path.json
//
// Run by the daily GlowVentures copy after `build-book.mjs`, and by anyone about to commit the
// file by hand. It exits non-zero — and the workflow commits nothing — when:
//   • the consolidated sum of the positions, each dedupeGroup counted once, is not the upstream
//     headline `summary.totalValue` to the paisa (a duplicate the exporter dropped, or one it
//     double-counted, is exactly what this catches);
//   • the listed/private split does not reconcile the same way;
//   • a ring-fenced holding is also inside `positions` (it would then be in every total);
//   • a dedupeGroup has ONE member — a broken dedupe, not an absent duplicate;
//   • any position carries a market value that is not a finite number (a null there is an
//     unvalued line the upstream would have refused; a string is a parse that went wrong).
// It never rewrites the file. A residual is printed, not absorbed.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || join(ROOT, 'public/data/book.json');
const COMPANIES = process.env.BOOK_COMPANIES_OUT || join(ROOT, 'public/data/portfolio-companies.json');
const PRIVATE = new Set(['AIF', 'Unlisted', 'Structured Product']);
const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const problems = [];
const positions = Array.isArray(book.positions) ? book.positions : (problems.push('positions is not an array'), []);
const summary = book.summary || {};

const seen = new Set();
const groupSize = new Map();
let total = 0;
let listed = 0;
let priv = 0;
for (const p of positions) {
  if (!isNum(p.marketValue)) problems.push(`${p.security} in ${p.accountId}: marketValue is ${JSON.stringify(p.marketValue)}, not a number`);
  if (p.dedupeGroup) {
    groupSize.set(p.dedupeGroup, (groupSize.get(p.dedupeGroup) || 0) + 1);
    if (seen.has(p.dedupeGroup)) continue;
    seen.add(p.dedupeGroup);
  }
  const mv = isNum(p.marketValue) ? p.marketValue : 0;
  total += mv;
  if (PRIVATE.has(p.assetClass)) priv += mv; else listed += mv;
}
for (const [g, n] of groupSize) if (n < 2) problems.push(`dedupeGroup ${g} has ${n} member — a broken dedupe, not an absent duplicate`);

const residual = r2(r2(total) - (summary.totalValue ?? NaN));
if (!isNum(summary.totalValue)) problems.push('summary.totalValue is missing');
else if (residual !== 0) problems.push(`consolidated sum ${r2(total)} ≠ summary.totalValue ${summary.totalValue} (residual ${residual})`);
if (isNum(summary.listedValue) && r2(listed) !== summary.listedValue) problems.push(`listed sum ${r2(listed)} ≠ summary.listedValue ${summary.listedValue}`);
if (isNum(summary.privateValue) && r2(priv) !== summary.privateValue) problems.push(`private sum ${r2(priv)} ≠ summary.privateValue ${summary.privateValue}`);
if (isNum(summary.positionsCount) && summary.positionsCount !== positions.length) problems.push(`positionsCount ${summary.positionsCount} ≠ ${positions.length} rows`);

const inBook = new Set(positions.map((p) => p.securityKey));
for (const p of book.ringFenced || []) if (inBook.has(p.securityKey)) problems.push(`ring-fenced ${p.securityKey} is also inside positions`);

// THE PORTFOLIO BOOK written beside it: every ticker in it is a counted equity position, no two
// lines share a symbol, every line has a symbol or a reason, and the counts add up.
try {
  const c = JSON.parse(readFileSync(COMPANIES, 'utf8'));
  const hs = Array.isArray(c.holdings) ? c.holdings : (problems.push('portfolio-companies.json: holdings is not an array'), []);
  const tickers = hs.map((h) => h.ticker).filter(Boolean);
  if (new Set(tickers).size !== tickers.length) problems.push('portfolio-companies.json: two lines share one NSE symbol');
  for (const h of hs) {
    if (!h.name) problems.push(`portfolio-companies.json: a line has no name (${h.ticker || h.bookName || '?'})`);
    if (!h.ticker && !h.reason) problems.push(`portfolio-companies.json: ${h.name} has no symbol and no reason`);
  }
  const equitySymbols = new Set(positions.filter((p) => p.assetClass === 'Equity' && p.symbol).map((p) => String(p.symbol).toUpperCase()));
  for (const t of tickers) if (!equitySymbols.has(t) && !hs.find((h) => h.ticker === t && /company-index/.test(h.matchedBy || ''))) problems.push(`portfolio-companies.json: ${t} is not an equity symbol in book.json`);
  for (const sym of equitySymbols) if (!tickers.includes(sym)) problems.push(`portfolio-companies.json: equity symbol ${sym} from book.json is missing`);
  if (c.count !== hs.length) problems.push(`portfolio-companies.json: count ${c.count} ≠ ${hs.length} lines`);
  if ((c.resolved || 0) + (c.unlisted || 0) + (c.bseOnly || 0) + (c.unresolved || 0) !== c.count) problems.push('portfolio-companies.json: resolved + unlisted + bseOnly + unresolved ≠ count');
  if (!/GlowVentures/.test(c.source || '')) problems.push(`portfolio-companies.json: source is "${c.source}", not GlowVentures — was scripts/sync-family-book.mjs run here? It reads the SATTVA family's book`);
  if (c.asOf !== book.asOf) problems.push(`portfolio-companies.json: asOf ${c.asOf} ≠ book.json asOf ${book.asOf}`);
} catch (err) {
  problems.push(`portfolio-companies.json could not be read: ${err.message}`);
}

if (problems.length) {
  console.error(`book.json does NOT reconcile — ${problems.length} problem(s):`);
  for (const line of problems) console.error(`  • ${line}`);
  process.exit(1);
}
const countedRows = positions.length - [...groupSize.values()].reduce((s, n) => s + (n - 1), 0);
console.log(
  `book.json reconciles: ${positions.length} rows, ${countedRows} counted once, ` +
    `₹${(total / 1e7).toFixed(2)} Cr = summary.totalValue · listed ₹${(listed / 1e7).toFixed(2)} Cr · private ₹${(priv / 1e7).toFixed(2)} Cr · ` +
    `${(book.ringFenced || []).length} ring-fenced outside · as of ${book.asOf}`
);
{
  const c = JSON.parse(readFileSync(COMPANIES, 'utf8'));
  console.log(`portfolio-companies.json reconciles: ${c.count} lines, ${c.resolved} with an NSE symbol, ${c.unresolved} unresolved, ${c.unlisted} not listed equity · ${c.source} · as of ${c.asOf}`);
}
