#!/usr/bin/env node
// scripts/import-amc-portfolio.mjs — AMC monthly portfolio disclosures into the Institutions view.
//
//   node scripts/import-amc-portfolio.mjs
//
// Reads the workbooks in scripts/fixtures/ and merges them into
// public/data/institution-holdings.json alongside the Trendlyne funds, leaving those untouched.
//
// THIS IS A DIFFERENT DISCLOSURE FROM THE ONE ALREADY IN THAT FILE, AND THE WHOLE IMPORT TURNS ON
// KEEPING THEM APART.
//
//   Trendlyne (`disclosure: 'shareholding'`)  the COMPANY files its shareholding pattern each
//     quarter and names every holder above 1%. The percentage is "how much of the company this
//     fund owns". Only positions above the threshold appear at all, and the rupee figure is
//     Trendlyne's derivation because a filing never states one.
//
//   An AMC portfolio (`disclosure: 'portfolio'`)  the FUND publishes its own book every month.
//     The percentage is "how much of this fund is in that company" — % to NAV. Every position
//     appears, however small, and the rupee figure is the AMC'S OWN, because a portfolio
//     disclosure does state the market value of each line.
//
// So 8.34 in one file and 8.34 in the other are not the same measurement, and nothing here writes
// an AMC weight into a field the shareholding funds use for a holding percentage. They get their
// own keys, their own `disclosure` tag, and their own column headings in the UI. Averaging or
// sorting the two together would be the single most misleading thing this file could do.
//
// WHAT IS DISCLOSED AND WHAT IS DERIVED
//   Disclosed by the AMC: the instrument, its asset class, its industry, its % to NAV and its
//   value in ₹ Cr, for each of the seven months in the export.
//   Derived here: exactly one figure — the month-over-month change in weight, which is subtraction
//   of two of their own percentages. It is labelled "derived" everywhere it surfaces.
//
// THE TICKER IS OURS AND IT CAN LEGITIMATELY BE MISSING. The export names instruments the way the
// AMC writes them ("LT Foods Limited"), not by exchange symbol, so a symbol is resolved here from
// the feeds this dashboard already has. A line that does not resolve KEEPS ITS ROW and carries a
// stated reason, the same rule the book follows in resolve-portfolio-companies.mjs — dropping it
// would quietly redefine "the portfolio" as "the part of it we could match".

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from './lib/xlsx-read.mjs';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = (f) => resolve(__dirname, '../public/data', f);
const FIXTURE = (f) => resolve(__dirname, 'fixtures', f);
const OUT = DATA('institution-holdings.json');

// ---------------------------------------------------------------------------------------
// The funds to import. Adding a third is one entry plus its workbook in scripts/fixtures/.
// ---------------------------------------------------------------------------------------

const FUNDS = [
  {
    investorId: 'bandhan-focused-fund',
    file: 'bandhan-focused-fund.xlsx',
    name: 'Bandhan Focused Fund',
    house: 'Bandhan Mutual Fund',
    category: 'Equity : Focused',
    sourceUrl: 'https://bandhanmutual.com/mutual-fund/equity-fund/bandhan-focused-equity-fund',
  },
  {
    investorId: 'bandhan-small-cap-fund',
    file: 'bandhan-small-cap-fund.xlsx',
    name: 'Bandhan Small Cap Fund',
    house: 'Bandhan Mutual Fund',
    category: 'Equity : Small Cap',
    sourceUrl: 'https://bandhanmutual.com/mutual-fund/equity-fund/bandhan-small-cap-fund',
  },
];

const SOURCE_LABEL = 'Bandhan Mutual Fund — monthly portfolio disclosure';

// Duplicate instrument lines the merge refused to fold together because their months overlap.
// Collected across every fund and printed at the end; see the merge in importFund().
const overlaps = [];

// ---------------------------------------------------------------------------------------
// Name -> NSE symbol
// ---------------------------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Names checked by hand, because no automated rule should reach them.
 *
 * Each is a company the feeds here know under a name that shares no usable prefix with the AMC's —
 * an abbreviation ("SBI" for "State Bank of India"), an initialism, or a company those feeds simply
 * do not carry, whose NSE symbol was looked up rather than guessed. Nothing goes in this table
 * without being checked: a wrong symbol gives one company another's weights, which is a far worse
 * outcome than the honest dash an unresolved line renders.
 */
const CONFIRMED = {
  'state bank of india': 'SBIN',
  'cholamandalam financial holdings limited': 'CHOLAHLDNG',
  'the south indian bank limited': 'SOUTHBANK',
  'general insurance corporation of india': 'GICRE',
  'tata consultancy services limited': 'TCS',
  'steel authority of india limited': 'SAIL',
  'hindustan petroleum corporation limited': 'HINDPETRO',
  'icici lombard general insurance company limited': 'ICICIGI',
  'the great eastern shipping company limited': 'GESHIP',
  'one 97 communications limited': 'PAYTM',
  'awl agri business limited': 'AWL',
  'epl limited': 'EPL',
  'sis limited': 'SIS',
  'arvind fashions limited': 'ARVINDFASN',
  'p n gadgil jewellers limited': 'PNGJL',
  'computer age management services limited': 'CAMS',
  'amir chand jagdish kumar (exports) ltd': 'AEROPLANE',
  'jb chemicals & pharmaceuticals limited': 'JBCHEPHARM',
  'v2 retail limited': 'V2RETAIL',
  'efc (i) limited': 'EFCIL',
  'national aluminium company limited': 'NATIONALUM',
  'gujarat state petronet limited': 'GSPL',
  'ujjivan small finance bank limited': 'UJJIVANSFB',
  'star health and allied insurance company limited': 'STARHEALTH',
  'bombay burmah trading corporation limited': 'BBTC',
  'safari industries (india) limited': 'SAFARI',
  'butterfly gandhimathi appliances limited': 'BUTTERFLY',
  'horizon reclaim (india) limited': null,
  'citius transnet investment trust': null,
};

const index = buildIndex({
  mc: JSON.parse(readFileSync(DATA('mc-ticker-map.json'), 'utf8')),
  tech: JSON.parse(readFileSync(DATA('technicals.json'), 'utf8')),
  book: JSON.parse(readFileSync(DATA('portfolio-companies.json'), 'utf8')),
});

/** A symbol for one instrument line, or a stated reason there is none. */
function resolveForLine(name, assetClass) {
  // Gold, debt and cash lines are not equities and have no NSE symbol to find. Saying that is the
  // honest answer; running them through the matcher and reporting "not found" would imply we
  // looked for something that exists.
  if (assetClass && assetClass !== 'Equity') {
    return { ticker: null, resolvedBy: null, reason: `${assetClass.toLowerCase()} holding — not an equity, so it has no NSE symbol` };
  }
  const key = String(name || '').trim().toLowerCase();
  // An explicit null in CONFIRMED means "checked, and it genuinely has no NSE symbol" — an unlisted
  // line or a trust. That is a different answer from "we could not find one", and says so.
  if (key in CONFIRMED && CONFIRMED[key] == null) {
    return { ticker: null, resolvedBy: null, reason: 'checked by hand — this line is not an NSE-listed equity' };
  }
  return resolveTicker(index, name, { confirmed: CONFIRMED });
}

// ---------------------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------------------

const round2 = (n) => Math.round(n * 100) / 100;
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "Jul-26 % to NAV" -> { key: '2026-07', label: 'Jul 26', sort: 202607 }. */
function parsePeriod(heading) {
  const m = /^([A-Za-z]{3})-(\d{2})\b/.exec(String(heading || '').trim());
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const year = 2000 + Number(m[2]);
  return { key: `${year}-${String(month).padStart(2, '0')}`, label: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`, sort: year * 100 + month };
}

/** The header row's paired (% to NAV, Value ₹Cr) columns, newest first. */
function readPeriods(header) {
  const periods = [];
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '');
    if (!/%\s*to\s*NAV/i.test(h)) continue;
    const p = parsePeriod(h);
    if (!p) continue;
    const valueAt = /Value/i.test(String(header[i + 1] || '')) ? i + 1 : null;
    periods.push({ ...p, pctAt: i, valueAt });
  }
  // The export happens to be newest-first, but sorting on the parsed date rather than trusting
  // column order means a workbook that ever arrives the other way round still reads correctly —
  // and "latest" stays a fact about the calendar rather than about a spreadsheet's layout.
  periods.sort((a, b) => b.sort - a.sort);
  if (!periods.length) throw new Error('no "<Mon>-<YY> % to NAV" columns in the Holdings header');
  return periods;
}

/** The one line of context above the table: AUM, the NAV date and which month the book is. */
function readSummary(rows) {
  const line = rows.map((r) => String(r[0] || '')).find((s) => /AUM/i.test(s)) || '';
  const aum = /AUM\s*₹([\d,]+)\s*Cr/i.exec(line);
  const navDate = /NAV as of\s*([\w-]+)/i.exec(line);
  return {
    statedAumCr: aum ? Number(aum[1].replace(/,/g, '')) : null,
    navAsOf: navDate ? navDate[1] : null,
    summaryLine: line || null,
  };
}

/** "Asset mix · Jul-26:  Equity 96.3%   ·   Cash & equiv 3.7%" -> [{ label, pct }] */
function readAssetMix(rows) {
  const line = rows.map((r) => String(r[0] || '')).find((s) => /Asset mix/i.test(s));
  if (!line) return [];
  return [...line.matchAll(/([A-Za-z&\s]+?)\s+([\d.]+)%/g)]
    .map((m) => ({ label: m[1].replace(/^[\s·]+/, '').trim(), pct: Number(m[2]) }))
    .filter((x) => x.label && Number.isFinite(x.pct));
}

function importFund(cfg) {
  const wb = readWorkbook(readFileSync(FIXTURE(cfg.file)));
  const sheet = wb.Holdings;
  if (!sheet) throw new Error(`${cfg.file}: no "Holdings" sheet`);

  const headerAt = sheet.findIndex((r) => String(r[0] || '').trim() === 'Instrument');
  if (headerAt < 0) throw new Error(`${cfg.file}: no header row starting "Instrument"`);
  const header = sheet[headerAt];
  const periods = readPeriods(header);
  const [latest, prior] = periods;

  const summary = readSummary(wb.Summary || []);
  const assetMix = readAssetMix(sheet.slice(0, headerAt));

  const collisions = [];
  const lines = [];

  for (const row of sheet.slice(headerAt + 1)) {
    const name = String(row[0] || '').trim();
    if (!name) continue;
    const assetClass = String(row[1] || '').trim() || null;
    const industry = String(row[2] || '').trim() || null;

    const pctByPeriod = {};
    const valueByPeriod = {};
    for (const p of periods) {
      // A month with no cell means the fund did not hold this line then. That stays null all the
      // way to the em dash in the UI: a zero would assert a measured weight of nothing.
      pctByPeriod[p.key] = numOrNull(row[p.pctAt]);
      valueByPeriod[p.key] = p.valueAt == null ? null : numOrNull(row[p.valueAt]);
    }

    const resolved = resolveForLine(name, assetClass);
    lines.push({
      name,
      ticker: resolved.ticker,
      resolvedBy: resolved.resolvedBy,
      unresolvedReason: resolved.reason,
      assetClass,
      industry,
      pctByPeriod,
      valueByPeriod,
      spells: 1,
    });
  }

  // ONE COMPANY CAN ARRIVE ON SEVERAL LINES, because the export starts a new line each time the
  // fund exits a position and later buys it back. Angel One is on two lines in both funds: one
  // covering Feb–Jul, one covering January alone.
  //
  // Those lines are DISJOINT IN TIME, so folding them into one row loses nothing — no month has two
  // values to reconcile — and it is what makes one row per company, and therefore a ticker as the
  // row key, correct. Overlapping lines would be a different matter entirely: combining them would
  // mean summing or choosing, and both invent a number. So the merge only happens when the months
  // do not overlap, and lines that do overlap stay separate and are reported.
  const merged = [];
  const byName = new Map();
  for (const line of lines) {
    const prev = byName.get(line.name);
    if (!prev) {
      byName.set(line.name, line);
      merged.push(line);
      continue;
    }
    const overlap = periods.filter((p) => prev.pctByPeriod[p.key] != null && line.pctByPeriod[p.key] != null);
    if (overlap.length) {
      overlaps.push(`${cfg.name}: "${line.name}" is on two lines that both report ${overlap.map((p) => p.label).join(', ')}`);
      merged.push(line);
      continue;
    }
    for (const p of periods) {
      if (line.pctByPeriod[p.key] != null) prev.pctByPeriod[p.key] = line.pctByPeriod[p.key];
      if (line.valueByPeriod[p.key] != null) prev.valueByPeriod[p.key] = line.valueByPeriod[p.key];
    }
    prev.spells++;
  }

  const seenTicker = new Map();
  for (const h of merged) {
    const now = h.pctByPeriod[latest.key];
    const before = prior ? h.pctByPeriod[prior.key] : null;
    h.weightPct = now;
    h.valueCr = h.valueByPeriod[latest.key];
    h.changePp = null;
    h.changeNote = null;
    if (now == null && before == null) h.changeNote = null;
    else if (before == null) h.changeNote = 'New';
    else if (now == null) h.changeNote = 'Exited';
    else h.changePp = round2(now - before);

    if (!h.ticker) continue;
    const clash = seenTicker.get(h.ticker);
    // Two different companies that resolved to one symbol means at least one is wrong. Collected
    // rather than thrown on the spot, so one run reports every collision to fix instead of the
    // first — but the run still fails, because silently keeping both would give one company the
    // other's weights.
    if (clash && clash !== h.name) collisions.push(`${cfg.name}: "${h.name}" and "${clash}" both resolved to ${h.ticker}`);
    seenTicker.set(h.ticker, h.name);
  }

  if (collisions.length) throw new Error(`Name collisions — add the distinguishing names to CONFIRMED and re-run:\n  ${collisions.join('\n  ')}`);

  // Held now versus held earlier, split the way the Trendlyne funds already are, so the view's
  // "N holdings … M previously held" line means the same thing whichever fund is on screen. A line
  // with no weight in the latest month is not a holding of nil — the fund is out of it.
  const holdings = merged.filter((h) => h.weightPct != null);
  const former = merged.filter((h) => h.weightPct == null);

  const valued = holdings.filter((h) => h.valueCr != null);
  const portfolioValueCr = valued.length ? round2(valued.reduce((a, h) => a + h.valueCr, 0)) : null;
  const equity = holdings.filter((h) => h.assetClass === 'Equity');

  return {
    investorId: cfg.investorId,
    name: cfg.name,
    type: 'institution',
    house: cfg.house,
    category: cfg.category,
    // THE TAG EVERY CONSUMER BRANCHES ON. Without it a % to NAV would render under a heading that
    // means % of the company.
    disclosure: 'portfolio',
    source: SOURCE_LABEL,
    sourceUrl: cfg.sourceUrl,
    sourceFile: `scripts/fixtures/${cfg.file}`,
    generator: 'scripts/import-amc-portfolio.mjs',
    periods: periods.map((p) => p.key),
    periodLabels: periods.map((p) => p.label),
    latestPeriod: latest.key,
    latestPeriodLabel: latest.label,
    periodNoun: 'month',
    statedAumCr: summary.statedAumCr,
    navAsOf: summary.navAsOf,
    summaryLine: summary.summaryLine,
    assetMix,
    stocksHeld: holdings.length,
    equityCount: equity.length,
    resolvedCount: holdings.filter((h) => h.ticker).length,
    reboughtCount: merged.filter((h) => h.spells > 1).length,
    portfolioValueCr,
    valuedCount: valued.length,
    holdings,
    former,
  };
}

// ---------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------

const existing = JSON.parse(readFileSync(OUT, 'utf8'));

// Anything already in the file that this script does not own is preserved byte-for-byte. The
// Trendlyne funds are scraped by a different script on a different cadence and must not be
// rewritten by an import that knows nothing about them.
const mine = new Set(FUNDS.map((f) => f.investorId));
const kept = (existing.institutions || []).filter((f) => !mine.has(f.investorId));

const imported = FUNDS.map((cfg) => importFund(cfg));

for (const f of imported) {
  const unresolvedEquity = f.holdings.filter((h) => h.assetClass === 'Equity' && !h.ticker);
  console.log(
    `${f.name}: ${f.stocksHeld} lines (${f.equityCount} equity), ` +
      `${f.resolvedCount} resolved to an NSE symbol, ${unresolvedEquity.length} equity lines unresolved, ` +
      `₹${f.portfolioValueCr} Cr across ${f.valuedCount} valued lines, ${f.periods.length} months to ${f.latestPeriodLabel}` +
      `, ${f.former.length} no longer held, ${f.reboughtCount} re-entered after an exit`
  );
  if (unresolvedEquity.length) console.log(`  unresolved: ${unresolvedEquity.map((h) => h.name).join(' · ')}`);
}

if (overlaps.length) console.log(`\nKept apart rather than merged (their months overlap):\n  ${overlaps.join('\n  ')}`);

const out = {
  ...existing,
  _provenance:
    'REAL DATA, FROM TWO DIFFERENT DISCLOSURES THAT MUST NOT BE MIXED. ' +
    "Funds tagged disclosure:'shareholding' come from company shareholding filings aggregated by Trendlyne — the percentage is HOW MUCH OF THE COMPANY the fund owns, only holdings above the 1% naming threshold appear, and the rupee value is Trendlyne's derivation. " +
    "Funds tagged disclosure:'portfolio' come from the AMC's own monthly portfolio disclosure — the percentage is % TO NAV, HOW MUCH OF THE FUND is in that company, every position appears however small, and the rupee value is the AMC's own published figure. " +
    'The two percentages are not comparable and are never summed, averaged or ranked against each other. ' +
    'The only figure derived in either case is the period-over-period change, which is subtraction of two of the source\'s own percentages.',
  institution_count: kept.length + imported.length,
  institutions: [...kept, ...imported],
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote ${OUT} — ${out.institution_count} funds (${kept.length} shareholding, ${imported.length} portfolio).`);
