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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.GLOWVENTURES_DIR || '/tmp/glowventures';
const OUT = process.env.BOOK_OUT || join(ROOT, 'public/data/book.json');

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
