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
