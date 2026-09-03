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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.GLOWVENTURES_DIR || '/tmp/glowventures';
const OUT = process.env.BOOK_OUT || join(ROOT, 'public/data/book.json');
// THE PORTFOLIO SCOPE'S BOOK — what every research tab's Portfolio toggle filters by — is written
// here too, from the same positions. Upstream (Sattva) derives its copy from techmuns/Sattva-Family
// through scripts/sync-family-book.mjs and the ISIN-keyed resolver; that is the SATTVA family's
// book, and only twenty of its tickers are in this one. See "The Portfolio book" below.
const COMPANIES_OUT = process.env.BOOK_COMPANIES_OUT || join(ROOT, 'public/data/portfolio-companies.json');

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
try {
  builtFrom = execSync('git rev-parse --short HEAD', { cwd: SRC_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  /* not a checkout — leave null */
}

const accountById = new Map(accounts.map((a) => [a.accountId, a]));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] === undefined ? null : o[k]]));

const out = {
  _provenance:
    'THE FAMILY OFFICE BOOK, as the wealth platforms’ statements print it. Built by scripts/build-book.mjs from src/data/glowData.ts in techmuns/GlowVentures, itself generated from the PDF statements in that repository’s archive. Every figure traces to one document; a null is a figure the statements do not carry, never a zero. Market values are the statements’ own marks on each account’s report date (summary.asOf is the newest); the dashboard adds a live mark only for listed symbols and labels it.',
  source: 'techmuns/GlowVentures src/data/glowData.ts',
  builtFrom,
  asOf: asOfMatch ? asOfMatch[1] : summary.asOf,
  summary: pick(summary, ['asOf', 'listedValue', 'privateValue', 'totalValue', 'positionsCount', 'entitiesCount', 'startupsCount', 'accountsCount']),
  owners: owners.map((o) => ({ ownerId: o.ownerId ?? null, name: o.displayName ?? o.name ?? null })),
  accounts: accounts.map((a) => pick(a, ['accountId', 'provider', 'accountNo', 'ownerId', 'owner', 'strategy', 'engagement', 'providerEngagement', 'asOf', 'inceptionDate', 'custodian', 'members', 'noPositionsReason'])),
  positions: positions.map((p) => {
    const a = accountById.get(p.accountId) || {};
    return {
      ...pick(p, ['securityKey', 'security', 'symbol', 'isin', 'accountId', 'memberId', 'sector', 'providerSector', 'assetClass', 'quantity', 'marketValue', 'costBasis', 'unrealizedPnL', 'returnPct', 'avgCost', 'currentPrice', 'costBasisSource', 'stCostBasis', 'ltCostBasis', 'daysToLT', 'heldSince', 'accruedIncome', 'dividendReceived', 'positionIrrPct', 'dedupeGroup', 'alsoReportedUnder']),
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
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
const listed = out.positions.filter((p) => p.symbol).length;
console.log(`book.json: ${out.positions.length} positions (${listed} with an NSE symbol) across ${out.accounts.length} accounts, ₹${(out.summary.totalValue / 1e7).toFixed(1)} Cr as of ${out.asOf}, from ${out.source}@${builtFrom || '?'} → ${OUT}`);

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

const companies = {
  _provenance:
    'THE PORTFOLIO BOOK — what the Portfolio toggle means on every research tab: the companies the family holds DIRECTLY as listed equity, one line per NSE symbol, read from the same GlowVentures book as book.json by scripts/build-book.mjs. Names and sectors only, no quantity, cost or value. A line with no symbol is kept with the reason; fund units, ETFs, AIFs, cash and the ring-fenced promoter holding are counted under excluded, never listed as companies.',
  asOf: out.asOf,
  source: 'techmuns/GlowVentures · src/data/glowData.ts',
  sourceCommit: builtFrom ? { sha: builtFrom, date: null } : null,
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
