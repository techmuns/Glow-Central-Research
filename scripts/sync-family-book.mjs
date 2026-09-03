#!/usr/bin/env node
// scripts/sync-family-book.mjs — the book, read from the family office's own repository.
//
//   node scripts/sync-family-book.mjs                    # fetch, write the fixture, re-resolve
//   FAMILY_REPO_TOKEN=… node scripts/sync-family-book.mjs
//   FAMILY_BOOK_PATH=../sattva-family/src/data/sattvaData.ts node scripts/sync-family-book.mjs
//   node scripts/sync-family-book.mjs --no-resolve       # write the fixture only
//   node scripts/sync-family-book.mjs --net              # let the resolver reach Yahoo for new names
//
// WHY THIS EXISTS. The Portfolio scope filters every research tab by the family's direct-equity
// book, and that book used to be a list of names typed into scripts/resolve-portfolio-companies.mjs
// from a statement. The family office keeps the same book in its own repository —
// techmuns/Sattva-Family, src/data/sattvaData.ts, generated from the custody workbooks — so the
// dashboard was carrying a second copy that could only drift. This script makes theirs the source:
// it reads that file, keeps ONE line per listed equity ISIN, and writes scripts/fixtures/family-book.json,
// which the resolver then turns into public/data/portfolio-companies.json.
//
// WHAT IT KEEPS AND WHAT IT REFUSES TO CARRY.
//   • Identity is the ISIN, never the name. Their names are the custodian's — upper-cased and cut at
//     twenty characters ("JUBILANT PHARMOVA LT") — and the same company is held under several
//     spellings across seventeen entities. One ISIN is one holding whatever it is called.
//   • Only equity ISINs (INE…) are book lines. INF… ISINs are mutual-fund units — gold, silver and
//     liquid ETFs — and no research feed here is keyed by them. They are counted under `excluded` so
//     the arithmetic is visible rather than the lines silently vanishing.
//   • No quantity, cost, value or account reaches the fixture. The book answers "is this company
//     one of ours?" and nothing else — see docs/DATA-CONTRACTS.md. Their file has every rupee figure
//     and none of it belongs beside a live price.
//
// A BAD READ NEVER OVERWRITES A GOOD FIXTURE. A regex that stops matching their file would parse to
// nothing, and an empty book would make "Portfolio" mean nothing on every tab at once. So the shape
// is asserted, and a result carrying fewer than 80% of the committed fixture's lines is refused.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'scripts/fixtures/family-book.json');
const RESOLVER = join(ROOT, 'scripts/resolve-portfolio-companies.mjs');

export const FAMILY_REPO = 'techmuns/Sattva-Family';
export const FAMILY_FILE = 'src/data/sattvaData.ts';
const FAMILY_REF = process.env.FAMILY_REPO_REF || 'main';
const MIN_KEEP_SHARE = 0.8;

const args = process.argv.slice(2);
const NO_RESOLVE = args.includes('--no-resolve');
const NET = args.includes('--net');

// ---------------------------------------------------------------------------------------
// Reading their file
// ---------------------------------------------------------------------------------------

/**
 * Pull the two literals out of their TypeScript module.
 *
 * The file is generated — one `export const` per line, each a JSON literal — so a regex over the
 * module is enough and a TypeScript parser is not. Both literals are parsed with JSON.parse, which
 * is what makes a change in their generator fail loudly here rather than read as a smaller book.
 */
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

async function readFamilyFile() {
  const local = process.env.FAMILY_BOOK_PATH;
  if (local) {
    console.log(`reading ${local}`);
    return { source: readFileSync(local, 'utf8'), commit: null, from: `local file ${local}` };
  }
  const token = process.env.FAMILY_REPO_TOKEN;
  if (!token) {
    console.error(
      `FAMILY_REPO_TOKEN is not set and FAMILY_BOOK_PATH names no local copy.\n` +
        `${FAMILY_REPO} is a private repository, so reading ${FAMILY_FILE} needs a token with read access to its contents.\n` +
        `Add it as a repository secret named FAMILY_REPO_TOKEN (Settings → Secrets and variables → Actions) for the scheduled sync,\n` +
        `or run locally with FAMILY_BOOK_PATH=/path/to/sattva-family/${FAMILY_FILE}.`,
    );
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${token}`, 'user-agent': 'sattva-central-research/sync-family-book', 'x-github-api-version': '2022-11-28' };
  const api = `https://api.github.com/repos/${FAMILY_REPO}`;
  const res = await fetch(`${api}/contents/${FAMILY_FILE}?ref=${encodeURIComponent(FAMILY_REF)}`, {
    headers: { ...headers, accept: 'application/vnd.github.raw+json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    console.error(`GitHub answered ${res.status} for ${FAMILY_REPO}/${FAMILY_FILE}@${FAMILY_REF}: ${body}`);
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      console.error('A 401/403/404 on a private repository means the token cannot read it — check FAMILY_REPO_TOKEN has Contents: read on that repository.');
    }
    process.exit(1);
  }
  const source = await res.text();

  // Which commit of theirs this is. Their `asOf` is the custody workbook's date; the commit is when
  // the book itself last moved, and that is the date a reader of the fixture actually wants.
  let commit = null;
  try {
    const c = await fetch(`${api}/commits?path=${encodeURIComponent(FAMILY_FILE)}&sha=${encodeURIComponent(FAMILY_REF)}&per_page=1`, {
      headers: { ...headers, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (c.ok) {
      const [latest] = await c.json();
      if (latest?.sha) commit = { sha: latest.sha, date: latest.commit?.committer?.date || latest.commit?.author?.date || null };
    }
  } catch {
    /* provenance only; the book itself was read */
  }
  return { source, commit, from: `${FAMILY_REPO}@${FAMILY_REF}` };
}

// ---------------------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { source, commit, from } = await readFamilyFile();
  const parsed = parseFamilyBook(source);

  const previous = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
  const floor = previous?.lines?.length ? Math.floor(previous.lines.length * MIN_KEEP_SHARE) : 1;
  if (parsed.lines.length < floor) {
    console.error(`refusing to write: ${parsed.lines.length} listed lines against ${previous.lines.length} committed — below ${MIN_KEEP_SHARE * 100}%. The read was bad, or the book really has shrunk that far; a human decides which.`);
    process.exit(1);
  }

  const prevIsins = new Set((previous?.lines || []).map((l) => l.isin));
  const nextIsins = new Set(parsed.lines.map((l) => l.isin));
  const added = parsed.lines.filter((l) => !prevIsins.has(l.isin));
  const removed = (previous?.lines || []).filter((l) => !nextIsins.has(l.isin));

  const fixture = {
    _provenance:
      `The family office's listed direct-equity book, read from ${FAMILY_REPO} (${FAMILY_FILE}) by scripts/sync-family-book.mjs. ` +
      'One line per equity ISIN across every holding entity; ETF and liquid-fund units are counted under excluded and not carried. ' +
      'Names are the custodian\'s own wording and may be truncated — the ISIN is the identity. No quantity, cost or value is carried on purpose. ' +
      'scripts/resolve-portfolio-companies.mjs reads this file and writes public/data/portfolio-companies.json.',
    source: `${FAMILY_REPO} · ${FAMILY_FILE}`,
    asOf: parsed.asOf,
    sourceCommit: commit,
    fetchedAt: new Date().toISOString(),
    positions: parsed.positions,
    excluded: parsed.excluded,
    count: parsed.lines.length,
    lines: parsed.lines,
  };

  // Byte-stable when nothing moved: `fetchedAt` alone must not make a commit.
  const unchanged =
    previous &&
    JSON.stringify(previous.lines) === JSON.stringify(fixture.lines) &&
    previous.asOf === fixture.asOf &&
    (previous.sourceCommit?.sha || null) === (fixture.sourceCommit?.sha || null);
  if (unchanged) {
    console.log(`${from}: ${fixture.count} listed lines (as of ${fixture.asOf || 'unknown'}) — identical to the committed fixture; nothing written.`);
  } else {
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${from}: ${fixture.positions} positions → ${fixture.count} listed lines (as of ${fixture.asOf || 'unknown'}); excluded ${fixture.excluded.etf} ETF, ${fixture.excluded.liquid} liquid, ${fixture.excluded.other} other.`);
    console.log(`wrote ${FIXTURE}${commit ? ` (their ${commit.sha.slice(0, 7)}, ${commit.date})` : ''}`);
  }
  const list = (lines) => lines.slice(0, 20).map((l) => `${l.isin} ${l.name}`).join(' · ') + (lines.length > 20 ? ` · +${lines.length - 20} more` : '');
  if (added.length) console.log(`  added (${added.length}):   ${list(added)}`);
  if (removed.length) console.log(`  removed (${removed.length}): ${list(removed)}`);

  if (NO_RESOLVE) process.exit(0);
  console.log('\nresolving…');
  const run = spawnSync(process.execPath, [RESOLVER, ...(NET ? ['--net'] : [])], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
