#!/usr/bin/env node
// scripts/apply-client-statements.mjs — lay the statements the client sent over the book. GLOW-OWNED.
//
//   node scripts/apply-client-statements.mjs        # public/data/book.json + managers.json, in place
//
// Run by series-refresh.yml after build-book.mjs and build-managers.mjs have rebuilt both files from
// techmuns/GlowVentures, and safe to run by hand on the committed files (it is idempotent). It reads
// scripts/fixtures/client-statements.json and, for each statement newer than the upstream's own
// statement for that account, replaces that account's rows with the statement's — see
// scripts/lib/client-statements.mjs for the rules. Then run check-book.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyToBook, applyToManagers } from './lib/client-statements.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK = process.env.BOOK_OUT || join(ROOT, 'public/data/book.json');
const MANAGERS = process.env.MANAGERS_OUT || join(ROOT, 'public/data/managers.json');
const FIXTURE = process.env.CLIENT_STATEMENTS || join(ROOT, 'scripts/fixtures/client-statements.json');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const { statements = [] } = read(FIXTURE);
const book = read(BOOK);
const bookBefore = JSON.stringify(book);

const { report } = applyToBook(book, statements);
const managers = read(MANAGERS);
const managersBefore = JSON.stringify(managers);
applyToManagers(managers, book, statements, report);

// Same formatting as the builders: book.json pretty, managers.json compact.
if (JSON.stringify(book) !== bookBefore) writeFileSync(BOOK, `${JSON.stringify(book, null, 1)}\n`);
if (JSON.stringify(managers) !== managersBefore) writeFileSync(MANAGERS, `${JSON.stringify(managers)}\n`);

for (const r of report) {
  const cr = (v) => (v == null ? '—' : `₹${(v / 1e7).toFixed(2)} Cr`);
  console.log(r.status === 'applied'
    ? `${r.id}: applied — ${r.accountId} as of ${r.asOf} (upstream ${r.upstreamAsOf ?? '?'}): ${cr(r.valueBefore)} → ${cr(r.valueAfter)}`
    : `${r.id}: ${r.status} — ${r.reason}`);
}
console.log(`book.json total ₹${(book.summary.totalValue / 1e7).toFixed(2)} Cr · managers.json managed ₹${(managers.summary.managedValue / 1e7).toFixed(2)} Cr + direct ₹${(managers.summary.direct.marketValue / 1e7).toFixed(2)} Cr`);
