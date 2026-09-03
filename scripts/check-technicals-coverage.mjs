#!/usr/bin/env node
// scripts/check-technicals-coverage.mjs — does the technicals capture reach every listed holding?
//
//   node scripts/check-technicals-coverage.mjs        exit 0 covered · exit 3 gap · exit 1 broken
//   node scripts/check-technicals-coverage.mjs --json a machine-readable report on stdout
//
// THE HOLE THIS CLOSES, WHICH IS A SCHEDULING HOLE RATHER THAN A CODE ONE.
//
// `scrape-technicals.mjs` already scrapes the NSE 500 export PLUS the book — a holding is priced
// because it is HELD, whatever index it is or is not in, and its header says so. That is correct
// and it is not the problem.
//
// The problem is that the book and the capture are rebuilt by two DIFFERENT workflows on two
// different schedules. `series-refresh.yml` rebuilds `portfolio-companies.json` from GlowVentures
// every morning; `technicals-refresh.yml` scrapes prices on its own cron. So the day the book gains
// companies, the capture does not have them — and nothing anywhere says so. Measured when the book
// was rebuilt from the family's own statements: it went from 142 lines to 170, and **87 of them had
// no technicals row at all**. Every research tab that reads a price silently skipped them, the
// coverage label went on saying what it always had, and the only thing that noticed was one
// assertion in `verify-ui.mjs` — which is not CI and which a person has to remember to run.
//
// A GAP IS NOT A BROKEN FILE, AND THE EXIT CODES SAY WHICH.
//   0  every listed holding has a row. Nothing to do.
//   3  the capture is fine and simply does not reach some holdings yet. That is the expected state
//      the moment the book grows, and it is what the sync workflow acts on by running
//      `TECH_FILL_GAPS=1 scrape-technicals.mjs` — a few requests for the new names, not a
//      600-company re-fetch. It is deliberately NOT exit 1: a workflow that fails here would go red
//      every time somebody bought a share, which is the fastest way to teach people to ignore it.
//   1  a file is missing or does not carry the shape this reads. That is a real break.
//
// "LISTED HOLDING" IS THE BOOK'S OWN WORD, NOT OURS. A book line with no NSE symbol — an unlisted
// company, a warrant, a BSE-only line — cannot have a technicals row and is not counted against
// coverage; it is reported separately so the two absences are never added together. That is the
// same rule the Portfolio scope's denominator follows.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOK_PATH = resolve(__dirname, '../public/data/portfolio-companies.json');
const TECH_PATH = resolve(__dirname, '../public/data/technicals.json');

const JSON_OUT = process.argv.includes('--json');

function read(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`✗ ${label} could not be read: ${err.message}`);
    console.error(`  ${path}`);
    process.exit(1);
  }
}

/** Every symbol in an array of rows, upper-cased, whatever the file calls its symbol field. */
function symbolsOf(rows) {
  const out = new Set();
  for (const row of rows || []) {
    const raw = row?.ticker ?? row?.symbol ?? row?.company?.ticker ?? null;
    if (raw) out.add(String(raw).toUpperCase());
  }
  return out;
}

function rowsOf(payload, keys) {
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return Array.isArray(payload) ? payload : [];
}

const book = read(BOOK_PATH, 'the book (portfolio-companies.json)');
const tech = read(TECH_PATH, 'the technicals capture (technicals.json)');

const bookRows = rowsOf(book, ['companies', 'holdings', 'rows']);
const techRows = rowsOf(tech, ['companies', 'stocks', 'rows']);
if (!bookRows.length) {
  console.error('✗ the book carries no company rows — refusing to report coverage against an empty list');
  process.exit(1);
}
if (!techRows.length) {
  console.error('✗ the technicals capture carries no rows — that is a broken file, not a coverage gap');
  process.exit(1);
}

// A line with no NSE symbol cannot be priced and is not counted against coverage — see the header.
const unlisted = bookRows.filter((r) => !(r?.ticker ?? r?.symbol));
const listed = symbolsOf(bookRows);
const priced = symbolsOf(techRows);
const missing = [...listed].filter((t) => !priced.has(t)).sort();

const report = {
  book: bookRows.length,
  listed: listed.size,
  unlisted: unlisted.length,
  priced: priced.size,
  covered: listed.size - missing.length,
  missing,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Book: ${report.book} lines · ${report.listed} with an NSE symbol · ${report.unlisted} without one (cannot be priced)`);
  console.log(`Technicals capture: ${report.priced} rows`);
  if (!missing.length) {
    console.log(`✓ every one of the ${report.listed} listed holdings has a technicals row`);
  } else {
    console.log(`✗ ${missing.length} of ${report.listed} listed holdings have NO technicals row:`);
    console.log(`    ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? `, …and ${missing.length - 20} more` : ''}`);
    console.log('  Fill them without re-fetching the rest:  TECH_FILL_GAPS=1 node scripts/scrape-technicals.mjs');
  }
}

process.exit(missing.length ? 3 : 0);
