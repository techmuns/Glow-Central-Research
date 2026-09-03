#!/usr/bin/env node
// scripts/import-mf-weekly.mjs — the weekly mutual-fund performance workbook into the Mutual Funds tab.
//
//   node scripts/import-mf-weekly.mjs
//
// Reads scripts/fixtures/mf-weekly.xlsx and writes public/data/mf-weekly.json: one entry per
// category sheet, each carrying its scheme rows, the sheet's own published MEDIAN row and the
// BENCHMARK index rows printed underneath it — plus the workbook's separate 36-index benchmark
// master sheet.
//
// WHY THIS IS A SECOND MUTUAL-FUND SOURCE AND NOT A REPLACEMENT FOR THE FIRST
//   The AmfiBeas feed (js/data/fund-returns.js) is DAILY, covers ~3,400 schemes and gives each a
//   rank inside its own cohort. It carries no benchmark and no category median, because AMFI's NAV
//   snapshot has neither. This workbook is WEEKLY, covers ~600 curated direct-plan schemes, and is
//   the only source here that states, for each category, what the index did and where the middle of
//   the category sat. They answer different questions and they are dated DIFFERENT DAYS, so the two
//   never share a row, a total or a comparison. See CLAUDE.md: a close is a claim about a session.
//
// THE MEDIANS AND THE BENCHMARK RETURNS ARE THE WORKBOOK'S — REPRODUCED, NEVER RECOMPUTED.
//   Same rule as the con-call scores and the Trendlyne values. What this script does compute is a
//   CHECK: it recomputes each published median from the scheme rows it parsed and refuses to write
//   the file if any of them disagrees. That is the scrape-institution-holdings.mjs guard applied
//   here — a parse that silently dropped a scheme would move the median, so a median that still
//   reconciles is evidence the rows are all present. On the shipped workbook all 208 published
//   period-medians reconcile exactly.
//
// THE AS-ON DATE COMES FROM THE SHEET'S OWN TEXT, NOT FROM THE SERIAL BESIDE IT.
//   Row 1 of every sheet reads "( As on 14-08-26 )" and carries a number in column M. That number
//   is NOT that date — it is 46082 on twenty-five sheets and 46174 on one, which decode to 1 Mar
//   2026 and 1 Jun 2026, neither of which is 14 Aug 2026. Whatever it measures, it is not the as-on
//   date, so it is recorded verbatim under `serial` and never interpreted. Inventing a date
//   interpretation for a column that has none is exactly the silent transformation xlsx-read.mjs
//   refuses to do for us.
//
// THE OUTPUT IS DETERMINISTIC, so a diff means a real change.
//   No build timestamp is stamped into the file — the same convention import-amc-portfolio.mjs and
//   build-book.mjs already follow. It is tempting to record when the workbook was read, but the
//   figures are as on the date the SHEETS state, which is already in the file and already on the
//   tab's face; a second date would add nothing a reader needs and would put a diff on every re-run
//   whether or not anything moved.
//
// "--" IS NOT ZERO. A scheme younger than the period prints "--", which becomes null and renders an
// em dash. A zero would claim the fund was measured over that period and returned nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from './lib/xlsx-read.mjs';
// ONE TAXONOMY, TWO CONSUMERS — the browser files the live feed's 3,400 schemes with the same
// module this script files the workbook's 26 sheets with. Same arrangement as finology-shared.js
// and filings-shared.js: a second copy would be a second taxonomy the day either gained a category.
import { WORKBOOK_TAXONOMY, workbookCoverage, slugify } from '../public/js/data/mf-taxonomy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, 'fixtures', process.env.MF_FIXTURE || 'mf-weekly.xlsx');
const OUT = resolve(__dirname, '../public/data/mf-weekly.json');

// ---------------------------------------------------------------------------------------
// The workbook's shape
// ---------------------------------------------------------------------------------------

// Column index -> period key, from the header row the workbook prints on every sheet:
//   A Scheme Name │ B 1 Week │ C 1 Month │ D 3 Months │ E 6 Months │ F 1 Year │ G 3 Years
//   H 5 Years │ I Since Inception │ J ─ │ K AUM ( June 26) │ L ─ │ M Direct │ N Regular
const PERIOD_COLUMNS = [
  ['1W', 1, '1 Week'],
  ['1M', 2, '1 Month'],
  ['3M', 3, '3 Months'],
  ['6M', 4, '6 Months'],
  ['1Y', 5, '1 Year'],
  ['3Y', 6, '3 Years'],
  ['5Y', 7, '5 Years'],
  ['SI', 8, 'Since Inception'],
];
export const PERIODS = PERIOD_COLUMNS.map(([k]) => k);
// The index rows stop at 5 Years — an index has no inception return in this workbook, so `SI` is
// absent on a benchmark rather than nil. A period a benchmark cannot answer stays missing.
const BENCHMARK_PERIODS = PERIODS.filter((p) => p !== 'SI');

const COL_AUM = 10;
const COL_EXPENSE_DIRECT = 12;
const COL_EXPENSE_REGULAR = 13;

const BENCHMARK_SHEET = 'BenchMark Returns';
const HEADER_CELL = 'Scheme Name';
const MEDIAN_CELL = 'median';
const INDEX_CELL = 'index';

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/** A numeric cell, or null. "--", "", and anything unparseable are ABSENT, never zero. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  if (!s || s === '--' || s === '-' || s === 'NA' || s === 'N.A.') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const text = (v) => String(v ?? '').trim();
const slug = slugify;

/** Is `a` the same index as `b`, ignoring a trailing "TRI"? "Nifty 500 TRI" and "Nifty 500" are. */
function sameIndex(a, b) {
  const bare = (n) => text(n).replace(/\s*TRI\s*$/i, '').replace(/\s+/g, ' ').toLowerCase();
  return bare(a) === bare(b);
}

/** The period readings on a row, as `{ '1M': 2.35, … }`. A period the row does not answer is absent. */
function readReturns(row, periods = PERIODS) {
  const out = {};
  for (const [key, col] of PERIOD_COLUMNS) {
    if (!periods.includes(key)) continue;
    const v = num(row[col]);
    if (v != null) out[key] = v;
  }
  return out;
}

/**
 * "( As on 14-08-26 )" -> "2026-08-14".
 *
 * Two-digit years are read as 2000+yy, which is safe for a fund-performance workbook and is stated
 * rather than guessed at read time. A cell that does not match returns null and the run fails: a
 * snapshot whose date we cannot read is a snapshot we must not label.
 */
function parseAsOn(cell) {
  const m = /as\s*on\s*:?\s*(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/i.exec(text(cell));
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 4 ? Number(y) : 2000 + Number(y);
  const iso = `${year}-${String(Number(mo)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

// THE FUND HOUSES ARE A LIST, NOT A PATTERN.
//
// The first draft split each scheme name on the first "fund-ish" word and called the prefix the
// house. It produced "Bank of", "Franklin Build", "DSP Natural" and, for one scheme whose name has
// no such word in it, the whole name including "- Dir - Growth". A house filter offering "Bank of"
// beside "Bank of India" is a control that looks broken and silently splits one AMC's schemes
// across two options.
//
// So the houses are named, longest first so "Franklin Build India" cannot be swallowed by
// "Franklin India", and a name that matches NONE of them keeps `house: null` rather than a guess.
// This is the `CONFIRMED` table in resolve-portfolio-companies.mjs, for the same reason: a name
// resolved by hand and checked beats a pattern that fails quietly the day the naming changes.
// All 624 schemes in the shipped workbook match; the run reports any that do not.
const FUND_HOUSES = [
  '360 ONE', 'Abakkus', 'Aditya Birla Sun Life', 'Angel One', 'Axis', 'Bajaj Finserv', 'Bandhan',
  'Bank of India', 'Baroda BNP Paribas', 'Canara Robeco', 'Capitalmind', 'DSP', 'Edelweiss',
  'Franklin Build India', 'Franklin India', 'Groww', 'HDFC', 'Helios', 'HSBC', 'ICICI Prudential',
  'Invesco India', 'ITI', 'JioBlackRock', 'JM', 'Kotak', 'LIC MF', 'Mahindra Manulife',
  'Mirae Asset', 'Motilal Oswal', 'Navi', 'Nippon India', 'NJ', 'Old Bridge', 'Parag Parikh',
  'PGIM India', 'PPFAS', 'Quant', 'Quantum', 'Samco', 'SBI', 'Shriram', 'Sundaram', 'Tata',
  'Taurus', 'Templeton India', 'The Wealth Company', 'TRUSTMF', 'Unifi', 'Union', 'UTI',
  'WhiteOak Capital', 'Zerodha',
].sort((a, b) => b.length - a.length);

/**
 * The AMC a scheme belongs to, and the plan/option its name declares.
 *
 * Every scheme in this workbook is a DIRECT GROWTH plan and says so in its own name
 * ("… - Dir - Growth"). That is read rather than assumed: a row whose name does not declare it is
 * recorded as `unknown` instead of being filed under a plan nobody stated. The expense-ratio pair
 * beside it is the workbook's own Direct/Regular quote for the scheme, which is a different fact
 * from which plan the RETURN column measures — the returns are the direct plan's.
 */
function readIdentity(name) {
  const trimmed = text(name);
  const plan = /\bdir\b|\bdirect\b/i.test(trimmed) ? 'direct' : /\breg\b|\bregular\b/i.test(trimmed) ? 'regular' : 'unknown';
  const option = /\bgrowth\b/i.test(trimmed) ? 'growth' : /\bidcw\b|\bdividend\s+option\b/i.test(trimmed) ? 'idcw' : 'unknown';
  const lower = trimmed.toLowerCase();
  const house = FUND_HOUSES.find((h) => lower.startsWith(`${h.toLowerCase()} `)) || null;
  return { plan, option, house };
}

// ---------------------------------------------------------------------------------------
// Reading one category sheet
// ---------------------------------------------------------------------------------------

function readCategory(sheet, rows) {
  const taxonomy = WORKBOOK_TAXONOMY[sheet];
  if (!taxonomy) throw new Error(`sheet "${sheet}" has no WORKBOOK_TAXONOMY entry — add one in public/js/data/mf-taxonomy.js, or the category would vanish from every group`);

  const headerRow = rows.findIndex((r) => text(r[0]) === HEADER_CELL);
  if (headerRow < 0) throw new Error(`sheet "${sheet}": no "${HEADER_CELL}" header row`);

  const asOf = parseAsOn(rows[headerRow - 1]?.[0]) || parseAsOn(rows[0]?.[0]);
  if (!asOf) throw new Error(`sheet "${sheet}": could not read an "( As on … )" date`);

  const medianRow = rows.findIndex((r) => text(r[0]).toLowerCase() === MEDIAN_CELL);
  if (medianRow < 0) throw new Error(`sheet "${sheet}": no Median row — the category has no published middle`);

  // The "Index" row is a separator, not data; every row after it is a benchmark. A sheet may carry
  // none at all (Smart Beta does not), which is an absence to state rather than an error.
  const indexRow = rows.findIndex((r) => text(r[0]).toLowerCase() === INDEX_CELL);

  const funds = [];
  const seen = new Map();
  for (let i = headerRow + 1; i < medianRow; i++) {
    const scheme = text(rows[i][0]);
    if (!scheme) continue;
    const returns = readReturns(rows[i]);
    // A row with a name and not one readable return is a spacer, not a scheme.
    if (!Object.keys(returns).length) continue;
    // The id must be derived from CONTENT, never from the row's position — the table's repaint fast
    // path keys on it, and a positional id means a different row on the next paint (CLAUDE.md,
    // "Performance on large tables"). A counter is appended only for a genuine duplicate name.
    const base = `${slug(sheet)}--${slug(scheme)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const identity = readIdentity(scheme);
    funds.push({
      id: n === 1 ? base : `${base}--${n}`,
      scheme,
      house: identity.house,
      plan: identity.plan,
      option: identity.option,
      returns,
      // AUM as at the workbook's own stated month, in ₹ crore. Its column heading carries that
      // month and is kept whole in `aumLabel` — the figure is not as-on the return date.
      aumCr: num(rows[i][COL_AUM]),
      expense: {
        direct: num(rows[i][COL_EXPENSE_DIRECT]),
        regular: num(rows[i][COL_EXPENSE_REGULAR]),
      },
    });
  }
  if (!funds.length) throw new Error(`sheet "${sheet}": no scheme rows between the header and the Median`);

  const benchmarks = [];
  if (indexRow >= 0) {
    for (let i = indexRow + 1; i < rows.length; i++) {
      const name = text(rows[i][0]);
      if (!name) continue;
      const returns = readReturns(rows[i], BENCHMARK_PERIODS);
      if (!Object.keys(returns).length) continue;
      benchmarks.push({ id: slug(name), name, tri: /\bTRI\b/i.test(name), returns });
    }
  }

  // WHICH BENCHMARK IS "THE" BENCHMARK is a choice, so it is recorded as one — and the rule is
  // narrower than it first looks.
  //
  // The obvious rule, "prefer the TRI", is WRONG on half these sheets. Two shapes turn up:
  //
  //   a cap sheet   Nifty Smallcap 250, Nifty Smallcap 250 TRI       one index, twice
  //   a sector sheet  Nifty 500 TRI, Nifty Healthcare Index          two DIFFERENT indices
  //
  // A blanket TRI preference reads the first as intended and the second as "compare every
  // healthcare fund with the broad market", quietly demoting the sector index the workbook printed
  // for that sheet. Measured on the shipped file it did exactly that to seven sectoral categories.
  //
  // So: THE WORKBOOK'S OWN ORDER IS THE PREFERENCE IT EXPRESSES, with one upgrade — where the sheet
  // prints a price index AND ITS OWN TRI, the TRI wins, because that is not a different index, it
  // is the same index measured the way a fund's NAV is measured (dividends reinvested). Every index
  // the sheet printed stays in `benchmarks`, and the reader can compare against any of them.
  const first = benchmarks[0] || null;
  const ownTri = first ? benchmarks.find((b) => b.tri && sameIndex(b.name, first.name)) : null;
  const primary = ownTri || first;

  return {
    id: slug(taxonomy.label || sheet),
    sheet,
    label: taxonomy.label || sheet,
    assetClass: taxonomy.assetClass,
    group: taxonomy.group,
    asOf,
    // Column M of the title row. Recorded, never interpreted — see the header note.
    serial: num(rows[headerRow - 1]?.[12] ?? rows[0]?.[12]),
    aumLabel: text(rows[headerRow][COL_AUM]) || null,
    funds,
    // The sheet's own middle, reproduced. `basis: 'published'` says whose number it is; the
    // reconciliation below is what says we parsed every row that went into it.
    median: { basis: 'published', returns: readReturns(rows[medianRow]) },
    benchmarks,
    primaryBenchmarkId: primary ? primary.id : null,
    // Stated rather than left to be inferred from an empty array — the tab prints this sentence.
    benchmarkNote: benchmarks.length
      ? null
      : 'The workbook prints no index row under this sheet, so it states no benchmark for this category. None is substituted.',
  };
}

// ---------------------------------------------------------------------------------------
// THE GUARD: every published median must reconcile against the rows we parsed
// ---------------------------------------------------------------------------------------

function median(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Recompute each category's median from the scheme rows and compare it with the one the sheet
 * printed. This is NOT the number that ships — the published one is — it is the evidence that the
 * parse is complete. A dropped or duplicated scheme moves the middle, so a median that still agrees
 * to the paisa is a check on every row above it.
 *
 * A period the sheet publishes no median for is skipped rather than counted as agreement.
 */
function reconcileMedians(categories) {
  const failures = [];
  let checked = 0;
  for (const cat of categories) {
    for (const p of PERIODS) {
      const published = cat.median.returns[p];
      if (published == null) continue;
      const recomputed = median(cat.funds.map((f) => f.returns[p] ?? null));
      checked++;
      if (recomputed == null || Math.abs(published - recomputed) > 0.005) {
        failures.push(`${cat.sheet} ${p}: published ${published}, recomputed ${recomputed}`);
      }
    }
  }
  return { checked, failures };
}

// ---------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------

function main() {
  const wb = readWorkbook(readFileSync(FIXTURE));
  const sheets = Object.keys(wb);

  // A sheet the taxonomy does not know about is a category that would silently disappear from every
  // group, so the run stops and names it. This is the `unknownCategories` tripwire from the BSE
  // scrape, in the one place it can be checked.
  const unknown = sheets.filter((s) => s !== BENCHMARK_SHEET && !WORKBOOK_TAXONOMY[s]);
  if (unknown.length) {
    console.error(`✗ sheets with no WORKBOOK_TAXONOMY entry: ${unknown.join(', ')}`);
    console.error('  Add each to WORKBOOK_TAXONOMY in public/js/data/mf-taxonomy.js, or it would be dropped from the tab without a word.');
    process.exit(1);
  }
  const missing = Object.keys(WORKBOOK_TAXONOMY).filter((s) => !sheets.includes(s));
  if (missing.length) {
    console.error(`✗ WORKBOOK_TAXONOMY names sheets the workbook does not carry: ${missing.join(', ')}`);
    process.exit(1);
  }

  const categories = sheets.filter((s) => s !== BENCHMARK_SHEET).map((s) => readCategory(s, wb[s]));
  // Which asset classes this workbook reaches, and the reason for each it does not — computed from
  // the shared taxonomy so the tab cannot describe a coverage the import did not produce.
  const coverage = workbookCoverage();

  // The master index sheet: every benchmark the workbook publishes, whether or not a category cites
  // it. It is what lets a reader compare a category against an index the sheet did not pair it with
  // — a choice the READER makes, labelled as theirs, never applied on their behalf.
  const masterRows = wb[BENCHMARK_SHEET];
  if (!masterRows) throw new Error(`the workbook has no "${BENCHMARK_SHEET}" sheet`);
  const benchmarkIndex = masterRows
    .slice(1)
    .filter((r) => text(r[0]) && text(r[0]).toLowerCase() !== INDEX_CELL)
    .map((r) => ({ id: slug(r[0]), name: text(r[0]), tri: /\bTRI\b/i.test(text(r[0])), returns: readReturns(r, BENCHMARK_PERIODS) }))
    .filter((b) => Object.keys(b.returns).length);

  const { checked, failures } = reconcileMedians(categories);
  if (failures.length) {
    console.error(`✗ ${failures.length} of ${checked} published medians do not reconcile against the parsed scheme rows:`);
    failures.slice(0, 20).forEach((f) => console.error(`    ${f}`));
    console.error('  A median that has moved means a scheme row was dropped or double-counted. Not writing the file.');
    process.exit(1);
  }

  // Every category must be dated the same day, or "as on" on the tab would be one sheet's date over
  // another sheet's figures.
  const dates = [...new Set(categories.map((c) => c.asOf))];
  if (dates.length !== 1) {
    console.error(`✗ the sheets are not all as on one date: ${dates.join(', ')}`);
    process.exit(1);
  }

  const out = {
    asOf: dates[0],
    source: 'Weekly mutual fund performance workbook',
    sourceFile: `scripts/fixtures/${FIXTURE.split('/').pop()}`,
    periods: PERIODS,
    periodLabels: Object.fromEntries(PERIOD_COLUMNS.map(([k, , label]) => [k, label])),
    benchmarkPeriods: BENCHMARK_PERIODS,
    assetClasses: coverage,
    medianBasis: 'published by the workbook; reproduced unchanged. Recomputed here only as a parse check.',
    medianCheck: { checked, reconciled: checked - failures.length },
    categories,
    benchmarkIndex,
  };

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const funds = categories.reduce((n, c) => n + c.funds.length, 0);
  const noBench = categories.filter((c) => !c.benchmarks.length);
  // A scheme whose name matches no known house keeps `house: null` and is named here, so the list
  // can be extended deliberately rather than the filter quietly losing an AMC.
  const houseless = categories.flatMap((c) => c.funds.filter((f) => !f.house).map((f) => f.scheme));
  console.log(`✓ ${OUT.split('/').slice(-2).join('/')}`);
  console.log(`  as on ${out.asOf} · ${categories.length} categories · ${funds} schemes · ${benchmarkIndex.length} indices in the master sheet`);
  console.log(`  ${checked}/${checked} published medians reconcile against the parsed rows`);
  for (const cls of coverage) {
    const inClass = categories.filter((c) => c.assetClass === cls.label);
    if (cls.covered) console.log(`  ${cls.label}: ${inClass.length} categories, ${inClass.reduce((n, c) => n + c.funds.length, 0)} schemes`);
    else console.log(`  ${cls.label}: not covered by this workbook — stated on the tab, not hidden`);
  }
  console.log(`  ${new Set(categories.flatMap((c) => c.funds.map((f) => f.house)).filter(Boolean)).size} fund houses resolved from FUND_HOUSES`);
  if (houseless.length) console.log(`  ${houseless.length} schemes match no known house (left unattributed): ${houseless.slice(0, 5).join(' · ')}`);
  if (noBench.length) console.log(`  no index row published for: ${noBench.map((c) => c.sheet).join(', ')} — said in those words, never substituted`);
}

main();
