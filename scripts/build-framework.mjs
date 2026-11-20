// build-framework.mjs — turn the desk's Framework workbook into the dashboard's data file.
//
// The Framework worksheet (scripts/fixtures/framework.xlsx) is the desk's own scoring rubric:
// five criteria scored 0-2, a Governance Pass/Fail GATE, and the list of companies to score. It
// carries NO scores — those are typed on the dashboard (shared, editable), exactly like the
// Portfolio/Watchlist sheets. This reads the rubric and the company list, resolves each company to
// an NSE symbol where the feeds carry one (so the tab can join live CMP / market cap / sector), and
// writes public/data/framework.json. Nothing is scored or invented here.
//
//   node scripts/build-framework.mjs            # rebuild from the committed workbook
//
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from './lib/xlsx-read.mjs';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '../public/data');
const read = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'));

// Hand-checked symbols for names the feeds only carry under a different / fuller spelling. The
// workbook truncates names at ~16 chars, so a few do not resolve automatically; add them here as
// they are confirmed (keyed by the lower-cased name exactly as the workbook prints it). Reviewed,
// never guessed — the same contract as resolve-portfolio-companies' CONFIRMED table.
const CONFIRMED = {
  'waaree renewab.': 'WAAREERTL',
  'wework india': 'WEWORKIND',
  'elpro internatio': 'ELPROINTL',
};

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const cell = (row, i) => {
  const c = Array.isArray(row) ? row[i] : null;
  return (c && typeof c === 'object') ? String(c.value ?? c.v ?? c.text ?? '').trim() : String(c ?? '').trim();
};

const wb = readWorkbook(readFileSync(resolve(here, 'fixtures/framework.xlsx')));
const sheet = wb.sheets ? wb.sheets[0] : wb.Sheet || Object.values(wb)[0];
const rows = sheet.rows || sheet.cells || sheet.data || sheet;

// r1..r5: the five scored criteria (label, 0/1/2 rubric, guiding question). r6: the Governance gate.
const CRITERIA_ROWS = [1, 2, 3, 4, 5];
const criteria = CRITERIA_ROWS.map((r) => {
  const row = rows[r];
  return { key: slug(cell(row, 0)), label: cell(row, 0), levels: [cell(row, 1), cell(row, 2), cell(row, 3)], question: cell(row, 4) };
});
const gate = { key: 'governance', label: cell(rows[6], 0) || 'Governance', type: cell(rows[6], 1) || 'Pass/Fail' };

const index = buildIndex({ mc: read('mc-ticker-map.json'), tech: read('technicals.json'), book: read('portfolio-companies.json') });

const seenKey = new Set();
const companies = [];
for (let r = 7; r < rows.length; r++) {
  const name = cell(rows[r], 0);
  if (!name) continue;
  const res = resolveTicker(index, name, { confirmed: CONFIRMED });
  // Stable key: the resolved ticker, else a slug of the name (never a position), de-duplicated.
  let key = res.ticker || `name:${slug(name)}`;
  while (seenKey.has(key)) key += '-x';
  seenKey.add(key);
  companies.push({ key, name, ticker: res.ticker, resolvedBy: res.resolvedBy, reason: res.reason });
}

const resolved = companies.filter((c) => c.ticker).length;
const out = {
  generatedAt: new Date().toISOString(),
  source: 'scripts/fixtures/framework.xlsx',
  note: 'Rubric and company list only; scores are typed on the dashboard. Nothing here is scored or invented.',
  criteria,
  gate,
  maxScore: criteria.length * 2,
  counts: { companies: companies.length, resolved, unresolved: companies.length - resolved },
  companies,
};
writeFileSync(resolve(dataDir, 'framework.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`framework.json: ${companies.length} companies, ${resolved} resolved to a ticker, ${companies.length - resolved} name-only.`);
console.log(`criteria: ${criteria.map((c) => c.label).join(' | ')} | gate: ${gate.label} (${gate.type}) | maxScore ${out.maxScore}`);
console.log('sample unresolved:', companies.filter((c) => !c.ticker).slice(0, 8).map((c) => c.name).join(', ') || 'none');
