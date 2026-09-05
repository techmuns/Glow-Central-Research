#!/usr/bin/env node
// Read the active, shared holdings — never the old generated TypeScript file.
// FAMILY_HOLDINGS_TOKEN is a read-only credential for Family Office's names-only API.
// FAMILY_BOOK_PATH may point to a names-only JSON response for local/offline tests.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchFamilyBook } from '../worker/family-portfolio.mjs';
import { validateFamilyBook, assertBookChange } from '../public/js/data/family-book-contract.js';
const FIXTURE = new URL('./fixtures/family-book.json', import.meta.url);
export const FAMILY_REPO = 'techmuns/Sattva-Family';
export const FAMILY_FILE = 'src/data/sattvaData.ts';
// Legacy parser retained only for migration/regression checks; never a sync source.
export function parseFamilyBook(source) {
  const positions = /SATTVA_POSITIONS\s*:\s*Position\[\]\s*=\s*(\[[\s\S]*?\]);/.exec(source);
  if (!positions) throw new Error(`shape: SATTVA_POSITIONS not found in ${FAMILY_FILE} — has the generator changed?`);
  const summary = /SATTVA_SUMMARY\s*:\s*SattvaSummary\s*=\s*(\{[\s\S]*?\});/.exec(source);

  const rows = JSON.parse(positions[1]);
  if (!Array.isArray(rows) || !rows.length) throw new Error('shape: SATTVA_POSITIONS parsed to an empty list');
  for (const r of rows.slice(0, 5)) {
    if (typeof r?.isin !== 'string' || typeof r?.security !== 'string') {
      throw new Error(`shape: a position lacks isin/security — keys are ${Object.keys(r || {}).join(', ')}`);
    }
  }
  const asOf = summary ? JSON.parse(summary[1])?.asOf : null;

  const byIsin = new Map();
  const excluded = { etf: new Set(), liquid: new Set(), other: new Set() };
  for (const r of rows) {
    const isin = String(r.isin || '').trim().toUpperCase();
    if (!isin) continue;
    if (!/^INE[A-Z0-9]{9}$/.test(isin)) {
      // Their assetClass is not the discriminator — the Liquid BeES line is filed as "Equity" — so the
      // ISIN prefix decides what is a fund unit, and the name/class only decide which bucket to count it in.
      const label = `${r.assetClass || ''} ${r.security || ''}`;
      const bucket = /liquid/i.test(label) ? 'liquid' : /etf|exchange traded/i.test(label) ? 'etf' : 'other';
      excluded[bucket].add(isin);
      continue;
    }
    if (!byIsin.has(isin)) byIsin.set(isin, { isin, name: String(r.security).trim(), sector: String(r.sector || 'Unclassified').trim() || 'Unclassified' });
  }
  const lines = [...byIsin.values()].sort((a, b) => a.isin.localeCompare(b.isin));
  return {
    asOf: typeof asOf === 'string' ? asOf : null,
    positions: rows.length,
    excluded: { etf: excluded.etf.size, liquid: excluded.liquid.size, other: excluded.other.size },
    lines,
  };
}


export async function syncFamilyBook({ token = process.env.FAMILY_HOLDINGS_TOKEN, local = process.env.FAMILY_BOOK_PATH, fixturePath = FIXTURE } = {}) {
  const book = local ? validateFamilyBook(JSON.parse(readFileSync(local, 'utf8'))) : await fetchFamilyBook(token);
  const previous = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null;
  assertBookChange(book, previous);
  const prev = new Set((previous?.lines || []).map(l => l.isin));
  const next = new Set(book.lines.map(l => l.isin));
  const fixture = { _provenance: 'Active shared Family Office holdings. Names and identifiers only; no quantities, values or accounts.', ...book, fetchedAt: book.checkedAt };
  const changed = previous?.revision !== book.revision || JSON.stringify(previous?.lines) !== JSON.stringify(book.lines);
  if (changed) writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ source: book.source, workbook: book.sourceWorkbook.label, checkedAt: book.checkedAt, count: book.count, changed, added: book.lines.filter(l => !prev.has(l.isin)).map(l => l.isin), removed: [...prev].filter(isin => !next.has(isin)) }));
  return fixture;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await syncFamilyBook();
    if (!process.argv.includes('--no-resolve')) {
      const run = spawnSync(process.execPath, [fileURLToPath(new URL('./resolve-portfolio-companies.mjs', import.meta.url)), ...(process.argv.includes('--net') ? ['--net'] : [])], { stdio: 'inherit' });
      process.exitCode = run.status ?? 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
