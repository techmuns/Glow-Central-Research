#!/usr/bin/env node
// scripts/build-book.mjs — public/data/book.json, THE FAMILY OFFICE BOOK, from a GlowVentures checkout.
//
//   GLOWVENTURES_DIR=/path/to/glowventures node scripts/build-book.mjs
//
// GlowVentures (techmuns/GlowVentures) assembles the family's consolidated book offline from the PDF
// statements its wealth platforms issue and bakes it into `src/data/glowData.ts` (`npm run
// build-book` there). That file is TypeScript, generated, and every figure in it traces to one
// document. This script reads the generated arrays out of it — they are JSON literals with a TS
// type annotation in front — and writes the subset this dashboard renders as plain JSON, with the
// same nulls in the same places: A NULL IS NOT ZERO. A depository does not know what shares cost,
// an AIF unit has no price per unit, and the book says so; rendering either as 0 would report the
// whole market value as profit.
//
// IT IS IDEMPOTENT. The output is built only from the input, key order is fixed, and `builtFrom`
// is the upstream commit — so the daily copy commits only when the book actually changed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, resolveTicker } from './lib/company-index.mjs';
import { AUTHORITATIVE, authoritativeDocs, datedRows, loadArchive, realisedIndex, saleKey, settledAmount } from './lib/glow-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.GLOWVENTURES_DIR || '/tmp/glowventures';
const OUT = process.env.BOOK_OUT || join(ROOT, 'public/data/book.json');
// THE PORTFOLIO SCOPE'S BOOK — what every research tab's Portfolio toggle filters by — is written
// here too, from the same positions. Upstream (Sattva) derives its copy from techmuns/Sattva-Family
// through scripts/sync-family-book.mjs and the ISIN-keyed resolver; that is the SATTVA family's
// book, and only twenty of its tickers are in this one. See "The Portfolio book" below.
const COMPANIES_OUT = process.env.BOOK_COMPANIES_OUT || join(ROOT, 'public/data/portfolio-companies.json');
// THE DATED EVIDENCE behind the direct-equity holdings — the trades, capital-gain lots and income
// rows the statements carry. Its own file because it is 630 KB that one sub-view reads; see the
// note above `equityLedgerMeta`.
const LEDGER_OUT = process.env.BOOK_LEDGER_OUT || join(ROOT, 'public/data/book-ledger.json');

const src = readFileSync(join(SRC_DIR, 'src/data/glowData.ts'), 'utf8');

/** A generated `export const NAME: T = <literal>;` — the literal is JSON. */
function literal(name, open, close) {
  const key = `export const ${name}`;
  const at = src.indexOf(key);
  if (at < 0) throw new Error(`glowData.ts has no ${name}`);
  const start = src.indexOf(`= ${open}`, at) + 2;
  let depth = 0;
  let i = start;
  let inStr = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return JSON.parse(src.slice(start, i + 1));
}
const arr = (name) => literal(name, '[', ']');
const obj = (name) => literal(name, '{', '}');

const summary = obj('BOOK_SUMMARY');
const accounts = arr('BOOK_ACCOUNTS');
const owners = arr('BOOK_OWNERS');
const positions = arr('BOOK_POSITIONS');
const navHistory = arr('BOOK_NAV_HISTORY');
const realisedByClass = arr('BOOK_REALISED_BY_CLASS');
const accountNav = obj('BOOK_ACCOUNT_NAV_HISTORY');
const accountCashFlows = obj('BOOK_ACCOUNT_CASH_FLOWS');
const asOfMatch = src.match(/export const BOOK_AS_OF = "([^"]+)"/);
// The ring-fenced promoter holding: GlowVentures keeps it OUT of BOOK_POSITIONS and out of every
// book-wide figure, on its own page. Carried here the same way — a separate array nothing sums —
// so the two dashboards cannot disagree about what the consolidated total is.
const ringFenced = src.includes('export const BOOK_POLYCAB') ? arr('BOOK_POLYCAB') : [];

let builtFrom = null;
let sourcePublishedAt = null;
try {
  sourcePublishedAt = execSync('git log -1 --format=%cI', { cwd: SRC_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  builtFrom = execSync('git rev-parse --short HEAD', { cwd: SRC_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a checkout — leave null */
}

const accountById = new Map(accounts.map((a) => [a.accountId, a]));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : o[k]]));

// ---------------------------------------------------------------------------------------
// THE DATED EVIDENCE — `equityLedger`
// ---------------------------------------------------------------------------------------
//
// The generated book above is a set of RESTATEMENTS: one row per holding, as the newest statement
// marks it. It carries no trade, no dividend and no realised gain, because GlowVentures keeps a
// value (which supersedes) apart from an event (which accumulates) — and rightly. Those events are
// one level down, in the statement archive its extractor writes under `public/audit/`, where its
// own Transactions and Capital Gains pages read them at runtime.
//
// This reads the same directories with the same rules (`scripts/lib/glow-archive.mjs`) and carries
// the DATED rows across, so the Direct Equity view can answer "when did we last trade this, what
// has it paid us, and what did the sells realise" from the family's own statements rather than
// from a model. Four rules, and each is a rule this repository already runs on:
//
//   • NOTHING IS DERIVED. Every figure is the statement's own — the price it printed, the
//     settlement it printed, the gain its capital gain statement determined. A row that printed no
//     amount keeps `null`; dividing a settlement by a quantity would price a trade nobody priced.
//   • THE WINDOW IS THE STATEMENTS', AND IT IS NOT THE HOLDING PERIOD. These statements cover one
//     financial year to date, so the earliest BUY on the tape is not when a holding was started —
//     `heldSince` on the position is the only field in this corpus that can say that, and it is
//     populated on three rows. `window` carries both the declared period and the dates actually
//     observed so no surface can present one as the other.
//   • AN ACCOUNT THAT ISSUED NO TRANSACTION STATEMENT IS NAMED, not left as a company that did not
//     trade. `accountsWithout` is the list, and the view says so rather than reading an absence as
//     a fact about the family's dealing.
//   • EVERY ROW IS FILED UNDER THE UPSTREAM'S OWN `securityKey`, which is what joins it to the
//     positions. The symbol is attached where a position carries one; a name that has been fully
//     exited has no position and therefore no symbol, and keeps its key and its printed name.
const archiveDocs = loadArchive(SRC_DIR);
const accountIdByStatement = new Map(accounts.map((a) => [`${a.provider}|${a.accountNo}`, a.accountId]));
const symbolByKey = new Map();
const classByKey = new Map();
for (const p of positions) {
  if (p.symbol && !symbolByKey.has(p.securityKey)) symbolByKey.set(p.securityKey, p.symbol);
  if (!classByKey.has(p.securityKey)) classByKey.set(p.securityKey, p.assetClass ?? null);
}
/** Where a row's account sits in the book. `null` is an account the book does not carry — said, never dropped. */
const placeAccount = (doc) => ({
  accountId: accountIdByStatement.get(`${doc.provider}|${doc.accountNo}`) ?? null,
  provider: doc.provider ?? null,
  accountNo: doc.accountNo ?? null,
  owner: doc.owner ?? null,
  ownerId: doc.ownerId ?? null,
  strategy: doc.strategy ?? null,
});
/**
 * What the statements say a row IS, and what the book says the holding is.
 *
 * `assetClass` is the statement's own word and `null` is "not stated" — never a guess. The Direct
 * Equity view narrows on it, so a row whose statement classified nothing must not silently vanish:
 * `bookAssetClass` is what the book files the same security under, and a view may use either, but
 * neither is invented from the other.
 */
const classify = (row) => ({
  assetClass: row.assetClass ?? null,
  bookAssetClass: classByKey.get(row.securityKey) ?? null,
});

const txnDocs = authoritativeDocs(archiveDocs, AUTHORITATIVE.transactions);
const realised = realisedIndex(archiveDocs);
const claimedSales = new Set();
const equityTransactions = datedRows(archiveDocs, AUTHORITATIVE.transactions, 'transactions')
  .filter(({ row }) => row.date)
  .map(({ doc, row }) => {
    // A SELL'S REALISED GAIN EXISTS ONLY WHERE THAT ACCOUNT'S MANAGER ISSUED A CAPITAL GAIN
    // STATEMENT, and it belongs to the DAY'S sale rather than to each printed row of it.
    let realizedGain = null;
    let realizedNote = null;
    if (row.side === 'sell') {
      const k = saleKey(doc.accountNo, row.securityKey, row.date);
      const v = realised.get(k);
      if (v === undefined) realizedNote = 'no capital gain lot in the statements matches this sale';
      else if (claimedSales.has(k)) realizedNote = "this sale's realised gain is shown on its first row for the day — the capital gain statement settles the day's sale, not each printed row";
      else { claimedSales.add(k); realizedGain = v; }
    }
    return {
      date: row.date,
      settlementDate: row.settlementDate ?? null,
      securityKey: row.securityKey ?? null,
      security: row.security ?? null,
      symbol: symbolByKey.get(row.securityKey) ?? null,
      isin: row.isin ?? null,
      ...classify(row),
      side: row.side === 'sell' ? 'Sell' : 'Buy',
      quantity: row.quantity ?? null,
      // The statement's own unit price. Never a settlement divided by a quantity.
      price: row.unitPrice ?? null,
      amount: settledAmount(row),
      charges: row.charges ?? null,
      exchange: row.exchange ?? null,
      realized: realizedGain,
      realizedNote,
      ...placeAccount(doc),
      source: row.source ?? doc.docKey ?? null,
    };
  })
  .sort((a, b) => (b.date === a.date ? String(a.securityKey).localeCompare(String(b.securityKey)) : b.date.localeCompare(a.date)));

const equityLots = datedRows(archiveDocs, AUTHORITATIVE.capitalGains, 'capitalGains').map(({ doc, row }) => ({
  ...pick(row, ['security', 'securityKey', 'isin', 'saleDate', 'purchaseDate', 'quantity', 'saleRate', 'saleAmount', 'purchaseRate', 'purchaseAmount', 'daysHeld', 'shortTerm', 'longTerm']),
  symbol: symbolByKey.get(row.securityKey) ?? null,
  bookAssetClass: classByKey.get(row.securityKey) ?? null,
  ...placeAccount(doc),
  source: row.source ?? doc.docKey ?? null,
}));

const equityIncome = [
  ...datedRows(archiveDocs, AUTHORITATIVE.cashIncome, 'income'),
  ...datedRows(archiveDocs, AUTHORITATIVE.nonCashIncome, 'income'),
].map(({ doc, row }) => ({
  ...pick(row, ['security', 'securityKey', 'isin', 'kind', 'exDate', 'receivedDate', 'quantity', 'ratePerUnit', 'receivable', 'received', 'tds', 'netAmount', 'entitlement']),
  symbol: symbolByKey.get(row.securityKey) ?? null,
  bookAssetClass: classByKey.get(row.securityKey) ?? null,
  ...placeAccount(doc),
  source: row.source ?? doc.docKey ?? null,
}));

const declaredFrom = txnDocs.map((d) => d.periodFrom).filter(Boolean).sort()[0] ?? null;
const declaredTo = txnDocs.map((d) => d.periodTo).filter(Boolean).sort().at(-1) ?? null;
const observed = equityTransactions.map((t) => t.date).sort();
const accountsWithStatement = [...new Set(txnDocs.map((d) => accountIdByStatement.get(`${d.provider}|${d.accountNo}`)).filter(Boolean))].sort();
const accountsWithoutStatement = accounts
  .filter((a) => !accountsWithStatement.includes(a.accountId))
  .map((a) => a.accountId)
  .sort();
// THE ROWS DO NOT RIDE IN `book.json`, AND THAT IS THE CACHING RULE THIS REPOSITORY ALREADY HAS.
//
// Measured: the tape, the lots and the income rows come to 630 KB — more than the whole of the rest
// of the book — and exactly one sub-view reads them. `book.json` is a bootstrap file every visitor
// fetches, and CLAUDE.md records what that costs ("a 347KB shareholdings file read by one sub-view"
// in front of the first pixel). So the META travels in the book, where every surface can state the
// coverage without downloading anything, and the ROWS go to their own file that the Direct Equity
// view fetches when it is opened. Counts live on the meta rather than being reached by loading the
// rows, so a coverage sentence can never be a reason to download 630 KB.
const equityLedgerMeta = {
  _provenance:
    'THE DATED EVIDENCE BEHIND THE BOOK — every trade, capital-gain lot and income row the family’s own statements carry, read from the statement archive in techmuns/GlowVentures (public/audit/) by scripts/lib/glow-archive.mjs with that repository’s own precedence and de-duplication rules. Nothing here is derived: each figure is the statement’s own, and a row that printed none keeps null. THE WINDOW IS THE STATEMENTS’ AND IS NOT A HOLDING PERIOD — the earliest buy on this tape is not when a holding was started. The rows are in book-ledger.json, fetched only by the view that reads them.',
  rowsFile: 'data/book-ledger.json',
  window: {
    // What the statements DECLARE they cover, and what was actually observed. Two different facts:
    // one account's statement declares no period at all, so a window taken from the rows alone
    // would read as a coverage claim nobody made.
    declaredFrom,
    declaredTo,
    observedFrom: observed[0] ?? null,
    observedTo: observed.at(-1) ?? null,
    statementsWithoutDeclaredPeriod: txnDocs.filter((d) => !d.periodFrom || !d.periodTo).length,
  },
  archiveDocuments: archiveDocs.length,
  accountsWithStatement,
  accountsWithoutStatement,
  transactionCount: equityTransactions.length,
  lotCount: equityLots.length,
  incomeCount: equityIncome.length,
  // THE TWO REALISED FIGURES, SIDE BY SIDE AND NEVER MERGED. The capital gain statements determine
  // the gain (`inLots`); the tape carries it on the sell row it belongs to (`onTape`). They differ
  // by the lots whose sale the transaction statements do not print — a real gap in the corpus, and
  // one GlowVentures reports too rather than letting a reader read either as the whole.
  realised: {
    inLots: equityLots.reduce((s, l) => s + (l.shortTerm || 0) + (l.longTerm || 0), 0),
    onTape: equityTransactions.reduce((s, t) => s + (t.realized || 0), 0),
    salesAttributed: claimedSales.size,
    sellsWithoutLot: equityTransactions.filter((t) => t.side === 'Sell' && t.realized == null && /no capital gain lot/.test(t.realizedNote || '')).length,
  },
  // Companies the tape and the income rows reach, so the view can say what share of the book has
  // dated evidence behind it without fetching a byte of it.
  securitiesTraded: [...new Set(equityTransactions.map((t) => t.securityKey).filter(Boolean))].sort(),
  securitiesWithIncome: [...new Set(equityIncome.map((i) => i.securityKey).filter(Boolean))].sort(),
  securitiesWithLots: [...new Set(equityLots.map((l) => l.securityKey).filter(Boolean))].sort(),
};

const out = {
  _provenance:
    'THE FAMILY OFFICE BOOK, as the wealth platforms’ statements print it. Built by scripts/build-book.mjs from src/data/glowData.ts in techmuns/GlowVentures, itself generated from the PDF statements in that repository’s archive. Every figure traces to one document; a null is a figure the statements do not carry, never a zero. Market values are the statements’ own marks on each account’s report date (summary.asOf is the newest); the dashboard adds a live mark only for listed symbols and labels it.',
  source: 'techmuns/GlowVentures src/data/glowData.ts',
  builtFrom,
  sourcePublishedAt,
  asOf: asOfMatch ? asOfMatch[1] : summary.asOf,
  summary: pick(summary, ['asOf', 'listedValue', 'privateValue', 'totalValue', 'positionsCount', 'entitiesCount', 'startupsCount', 'accountsCount']),
  owners: owners.map((o) => ({ ownerId: o.ownerId ?? null, name: o.displayName ?? o.name ?? null })),
  accounts: accounts.map((a) => pick(a, ['accountId', 'provider', 'accountNo', 'ownerId', 'owner', 'strategy', 'engagement', 'providerEngagement', 'asOf', 'inceptionDate', 'custodian', 'members', 'noPositionsReason'])),
  positions: positions.map((p) => {
    const a = accountById.get(p.accountId) || {};
    return {
      ...pick(p, ['securityKey', 'security', 'symbol', 'isin', 'accountId', 'memberId', 'sector', 'providerSector', 'assetClass', 'quantity', 'marketValue', 'costBasis', 'unrealizedPnL', 'returnPct', 'avgCost', 'currentPrice', 'costBasisSource', 'costUnavailable', 'stCostBasis', 'ltCostBasis', 'daysToLT', 'heldSince', 'accruedIncome', 'dividendReceived', 'positionIrrPct', 'dedupeGroup', 'alsoReportedUnder']),
      provider: a.provider ?? null,
      owner: a.owner ?? null,
      ownerId: a.ownerId ?? null,
      strategy: a.strategy ?? null,
      engagement: a.engagement ?? null,
      accountAsOf: a.asOf ?? null,
    };
  }),
  ringFenced: ringFenced.map((p) => {
    const a = accountById.get(p.accountId) || {};
    return {
      ...pick(p, ['securityKey', 'security', 'symbol', 'isin', 'accountId', 'assetClass', 'quantity', 'marketValue', 'costBasis', 'currentPrice', 'costBasisSource']),
      provider: a.provider ?? null,
      owner: a.owner ?? null,
      ownerId: a.ownerId ?? null,
      accountAsOf: a.asOf ?? null,
      reason: 'Ring-fenced promoter holding — kept out of every book-wide figure upstream (BOOK_POLYCAB), and out of summary.totalValue here.',
    };
  }),
  navHistory: navHistory.map((n) => pick(n, ['period', 'date', 'nav', 'accountsOnDate', 'accountsCarried', 'flowIn', 'unreportedFlowValue'])),
  accountNavHistory: accountNav,
  accountCashFlows,
  realisedByClass,
  equityLedger: equityLedgerMeta,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
const listed = out.positions.filter((p) => p.symbol).length;
console.log(`book.json: ${out.positions.length} positions (${listed} with an NSE symbol) across ${out.accounts.length} accounts, ₹${(out.summary.totalValue / 1e7).toFixed(1)} Cr as of ${out.asOf}, from ${out.source}@${builtFrom || '?'} → ${OUT}`);

// The rows themselves, in their own file — see the note above `equityLedgerMeta`. Same source, same
// commit, same asOf as the book it belongs to, so a reader can tell whether the two are in step.
const ledgerOut = {
  _provenance: equityLedgerMeta._provenance,
  source: out.source,
  builtFrom,
  asOf: out.asOf,
  window: equityLedgerMeta.window,
  transactions: equityTransactions,
  lots: equityLots,
  income: equityIncome,
};
writeFileSync(LEDGER_OUT, `${JSON.stringify(ledgerOut, null, 1)}\n`);
console.log(
  `book-ledger.json: ${equityTransactions.length} dated trades, ${equityLots.length} capital-gain lots, ${equityIncome.length} income rows ` +
    `from ${archiveDocs.length} archived statements · declared ${declaredFrom || '?'}..${declaredTo || '?'}, observed ${observed[0] || '—'}..${observed.at(-1) || '—'} · ` +
    `${accountsWithStatement.length} account(s) issued a transaction statement, ${accountsWithoutStatement.length} did not → ${LEDGER_OUT}`
);

// ---------------------------------------------------------------------------------------
// THE PORTFOLIO BOOK — public/data/portfolio-companies.json
// ---------------------------------------------------------------------------------------
//
// One line per company the family holds DIRECTLY as listed equity, in the shape js/data/coverage.js
// reads (docs/DATA-CONTRACTS.md, "public/data/portfolio-companies.json"). Four rules:
//
//   • IDENTITY IS THE NSE SYMBOL the statements resolve to, because that is what the feeds are keyed
//     by and what the family's book carries: most GlowVentures lines have a symbol and no ISIN (the
//     custodians print one or the other). The ISIN travels beside it where the statement had one.
//   • DIRECT EQUITY ONLY. Fund units, ETFs, AIF units, cash and the ring-fenced promoter holding are
//     not companies the research feeds can place, and they are counted under `excluded` so the
//     arithmetic is visible rather than the lines silently vanishing.
//   • A LINE WITHOUT A SYMBOL IS STILL A HOLDING. It is resolved by name against the feeds this
//     dashboard already carries (scripts/lib/company-index.mjs — collision-guarded), and a line that
//     still has no symbol stays in the file with `ticker: null` and a `reason`, so the scope pill can
//     print the denominator honestly. Warrants and preference shares are named as such.
//   • NO QUANTITY, COST OR VALUE reaches this file. It answers "is this company one of ours?" and
//     nothing else; the figures live in book.json.
//
// IDEMPOTENT LIKE THE BOOK: no timestamp, and the same input writes the same bytes, so the daily
// GlowVentures sync commits only when a holding actually moved.

const titleCase = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bLtd\b\.?/g, 'Ltd')
    .replace(/\bLimited\b/g, 'Limited');

/** The custodian's wording, minus the suffixes brokers append: "ICICI BANK-EQ", "SBI - EQ", "…-EQ NEW FV RS. 5/". */
const bareName = (security) =>
  String(security || '')
    .replace(/\s*-\s*EQ\b.*$/i, '')
    .replace(/\s*-\s*EQ1\/?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Pick the most readable of several spellings: mixed case beats upper case, longer beats shorter. */
function displayName(names) {
  const cleaned = [...names].map(bareName).filter(Boolean);
  const mixed = cleaned.filter((n) => /[a-z]/.test(n));
  const pool = mixed.length ? mixed : cleaned.map(titleCase);
  return pool.sort((a, b) => b.length - a.length)[0] || '';
}

// NAMES THE FEEDS DO NOT CARRY, CHECKED BY HAND — keyed by the custodian's wording, lower-cased.
// The company index resolves against Moneycontrol's ~1,300 names and the technicals universe;
// smaller listings and renamed companies are not in either, and a name that resolves nowhere would
// otherwise sit in the file as "unresolved" for ever. Each entry here was checked against the NSE
// symbol list once. A name NOT in this table and not in the feeds stays unresolved, with the reason.
const CONFIRMED = {
  'cosmo films ltd': 'COSMOFIRST', // renamed Cosmo First Ltd in 2022; the statement keeps the old name
  'credit access grameen limited': 'CREDITACC',
  'krishca strapping solutions': 'KRISHCA',
  'punjab chem & crop prot l': 'PUNJABCHEM', // "Punjab Chemicals & Crop Protection", cut at the custodian's width
  'sasken communication technologies': 'SASKEN', // renamed Sasken Technologies; the statement keeps the old name
};

const EQUITY = 'Equity';
const excluded = {};
const equityRows = [];
const seenGroups = new Set();
for (const p of positions) {
  if (p.dedupeGroup) {
    if (seenGroups.has(p.dedupeGroup)) continue;
    seenGroups.add(p.dedupeGroup);
  }
  if (p.assetClass === EQUITY) equityRows.push(p);
  else excluded[p.assetClass || 'Unclassified'] = (excluded[p.assetClass || 'Unclassified'] || 0) + 1;
}
if (ringFenced.length) excluded['Ring-fenced'] = ringFenced.length;

// Symbol-keyed lines first: every row that carries one.
const bySymbol = new Map();
for (const p of equityRows) {
  if (!p.symbol) continue;
  const sym = String(p.symbol).toUpperCase();
  if (!bySymbol.has(sym)) bySymbol.set(sym, { names: new Set(), sectors: new Set(), isin: null, rows: 0 });
  const e = bySymbol.get(sym);
  e.names.add(p.security);
  if (p.sector && p.sector !== 'Unclassified') e.sectors.add(p.sector);
  if (!e.isin && /^INE[A-Z0-9]{9}$/.test(p.isin || '')) e.isin = p.isin;
  e.rows += 1;
}

// Then the lines the statements carry with no symbol, one per distinct name, resolved against the
// feeds this dashboard already has — or kept with the reason they cannot be.
const readJson = (rel) => (existsSync(join(ROOT, rel)) ? JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) : null);
const index = buildIndex({ mc: readJson('public/data/mc-ticker-map.json'), tech: readJson('public/data/technicals.json'), book: null });
const noSymbol = new Map();
for (const p of equityRows) {
  if (p.symbol) continue;
  const key = bareName(p.security).toUpperCase();
  if (!noSymbol.has(key)) noSymbol.set(key, { names: new Set(), sectors: new Set(), isin: null });
  const e = noSymbol.get(key);
  e.names.add(p.security);
  if (p.sector && p.sector !== 'Unclassified') e.sectors.add(p.sector);
  if (!e.isin && /^INE[A-Z0-9]{9}$/.test(p.isin || '')) e.isin = p.isin;
}

const holdings = [];
for (const [sym, e] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  holdings.push({
    isin: e.isin,
    name: displayName(e.names),
    bookName: [...e.names][0],
    ticker: sym,
    sector: [...e.sectors][0] || 'Unclassified',
    listed: true,
    matchedBy: 'glowventures:symbol',
  });
}
const takenTickers = new Set(holdings.map((h) => h.ticker));
for (const [key, e] of [...noSymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const raw = [...e.names][0];
  const name = displayName(e.names);
  const base = { isin: e.isin, name, bookName: raw, sector: [...e.sectors][0] || 'Unclassified' };
  if (/\bWARRANTS?\b/i.test(raw)) {
    holdings.push({ ...base, ticker: null, listed: false, reason: 'warrant line — a right to subscribe, not a share any feed here is keyed by' });
    continue;
  }
  if (/\bPREF\b/i.test(raw)) {
    holdings.push({ ...base, ticker: null, listed: false, reason: 'preference shares — not the listed equity the research feeds carry' });
    continue;
  }
  const r = resolveTicker(index, bareName(raw), { confirmed: CONFIRMED });
  if (r.ticker && !takenTickers.has(r.ticker)) {
    takenTickers.add(r.ticker);
    holdings.push({ ...base, ticker: r.ticker, listed: true, matchedName: r.matchedName || null, matchedBy: `company-index:${r.resolvedBy || 'name'}` });
  } else if (r.ticker) {
    // The name resolves to a symbol the book already carries under another line: fold it in rather
    // than listing one company twice, and say so.
    holdings.push({ ...base, ticker: null, listed: true, reason: `same company as ${r.ticker}, filed under another wording — counted there` });
  } else {
    holdings.push({ ...base, ticker: null, listed: true, reason: `unresolved — ${r.reason || 'no NSE symbol on the statement and no confident match in the feeds this dashboard carries'}` });
  }
}

// Complete identities from the exchange's verified symbol directory, never fuzzy names.
// A statement ISIN always wins; contradictory exchange identities stop publication.
const directory = readJson('public/data/filing-capture/nse-identities.json');
const official = new Map();
for (const d of Object.values(directory?.directories || {})) for (const e of d.entries || []) {
  if (official.has(e.ticker) && official.get(e.ticker).isin !== e.isin) throw Error('Conflicting NSE directory identity');
  official.set(e.ticker, { ...e, checkedAt: d.checkedAt, url: d.url });
}
for (const holding of holdings) {
  const exact = official.get(holding.ticker);
  if (exact && holding.isin && exact.isin !== holding.isin) throw Error(`Statement/exchange ISIN conflict for ${holding.ticker}`);
  if (!holding.isin && exact) {
    holding.isin = exact.isin;
    holding.isinSource = { url: exact.url, checkedAt: exact.checkedAt, matchedBy: 'exact NSE symbol' };
  }
}
const companies = {
  _provenance:
    'THE PORTFOLIO BOOK — what the Portfolio toggle means on every research tab: the companies the family holds DIRECTLY as listed equity, one line per NSE symbol, read from the same GlowVentures book as book.json by scripts/build-book.mjs. Names and sectors only, no quantity, cost or value. A line with no symbol is kept with the reason; fund units, ETFs, AIFs, cash and the ring-fenced promoter holding are counted under excluded, never listed as companies.',
  asOf: out.asOf,
  source: 'techmuns/GlowVentures · src/data/glowData.ts',
  sourceCommit: builtFrom ? { sha: builtFrom, date: sourcePublishedAt } : null,
  count: holdings.length,
  resolved: holdings.filter((h) => h.ticker).length,
  unlisted: holdings.filter((h) => !h.ticker && h.listed === false).length,
  bseOnly: 0,
  unresolved: holdings.filter((h) => !h.ticker && h.listed !== false).length,
  excluded,
  holdings,
};
mkdirSync(dirname(COMPANIES_OUT), { recursive: true });
writeFileSync(COMPANIES_OUT, `${JSON.stringify(companies, null, 2)}\n`);
console.log(
  `portfolio-companies.json: ${companies.count} direct-equity lines (${companies.resolved} with an NSE symbol, ${companies.unresolved} unresolved, ${companies.unlisted} not listed equity) ` +
    `from ${equityRows.length} equity rows; excluded ${Object.entries(excluded).map(([k, v]) => `${k} ${v}`).join(', ')} → ${COMPANIES_OUT}`
);

// Portfolio metadata must follow a new Glow book even if external collectors are unavailable.
if (OUT === join(ROOT, 'public/data/book.json') && COMPANIES_OUT === join(ROOT, 'public/data/portfolio-companies.json')) {
  const { rebuildGlowCaptureIndex } = await import('./rebuild-glow-capture-index.mjs');
  await rebuildGlowCaptureIndex(join(ROOT, 'public/data'));
}
