// scripts/lib/glow-archive.mjs — THE DATED EVIDENCE BEHIND THE BOOK, read from GlowVentures' own
// statement archive. GLOW-OWNED. No npm dependency (hard rule 2): plain `node:fs` and JSON.
//
// `src/data/glowData.ts` is GlowVentures' GENERATED book — one row per holding, as the newest
// statement marks it. It carries no tape: a holding's value is a restatement, and a trade is an
// event, and that repository keeps the two apart. The events live one level down, in the archive
// its extractor writes under `public/audit/` — one directory per document, each with a
// `document.json` carrying that statement's parsed `transactions`, `capitalGains` and `income`
// rows. `src/lib/ledger.ts` reads them there at runtime for its own Transactions and Capital Gains
// pages; this file reads the same directories, with the same rules, so the two dashboards cannot
// disagree about what the family traded.
//
// THE TWO RULES ARE REPRODUCED, NOT REINVENTED, and both are load-bearing:
//
//   • AUTHORITATIVE PRECEDENCE, PER ACCOUNT. `AUTHORITATIVE.transactions` is in precedence order,
//     and for each account the FIRST type present wins — a manager publishing both a dedicated
//     transaction statement and an investor report is read from one of them, never both, which
//     would double every trade the two have in common. Lifted from `AUTHORITATIVE` in
//     GlowVentures' `src/lib/ledger.ts`.
//   • A REPEAT WITHIN ONE DOCUMENT IS DATA; A REPEAT ACROSS TWO IS A DUPLICATE. Green Lantern's
//     statement prints the same Anup Engineering buy twice consecutively because it happened
//     twice. So a row is keyed on the fields that distinguish two real events PLUS its ORDINAL
//     among identical rows on its own document, and the newest issue of a statement is read first
//     so a row printed on two issues keeps the newer document's copy. Lifted from `datedRows`
//     there and `datedRowsAcross` in its `scripts/build-book.mjs`.
//
// A SNAPSHOT SUPERSEDES; A DATED ROW DOES NOT. Both halves of that are why this file exists at
// all: a June statement replaces May's holdings and ADDS to May's trades, and reading the archive
// the same way for both is the bug GlowVentures already fixed once on its own read side.
//
// NOTHING HERE DERIVES A FIGURE. `settledAmount` picks whichever amount the row actually carries,
// in the upstream's own order, and a row that carries none keeps `null` — a settlement divided by
// a quantity would put a price on a trade nobody priced, and a null summed as zero would report a
// statement that printed nothing as a trade worth nothing.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Precedence order, per account — the first type present wins. From GlowVentures' `AUTHORITATIVE`. */
export const AUTHORITATIVE = {
  transactions: ['transaction-statement', 'investor-report'],
  capitalGains: ['capital-gain'],
  cashIncome: ['dividend-statement'],
  nonCashIncome: ['corporate-benefits', 'statement-of-earnings'],
};

const SEP = String.fromCharCode(1);

/**
 * Every field that distinguishes two real events, and nothing that does not — `source` is
 * deliberately absent, because the whole point is to recognise the same event printed twice.
 */
const ROW_FIELDS = [
  'date', 'saleDate', 'purchaseDate', 'exDate', 'receivedDate', 'settlementDate',
  'securityKey', 'side', 'kind', 'exchange', 'entitlement', 'quantity',
  'unitPrice', 'ratePerUnit', 'gross', 'charges', 'net', 'netAmount',
  'saleRate', 'saleAmount', 'purchaseRate', 'purchaseAmount',
  'daysHeld', 'shortTerm', 'longTerm', 'receivable', 'received', 'tds',
];

/** Read every `document.json` the archive's manifest names. Returns [] where there is no archive. */
export function loadArchive(glowDir) {
  const dir = join(glowDir, 'public/audit');
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(manifest)) return [];
  const docs = [];
  for (const entry of manifest) {
    const path = join(dir, String(entry.docKey || ''), 'document.json');
    if (!existsSync(path)) continue;
    try {
      docs.push(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      /* one unreadable document is not the archive — it is counted by the caller as a gap */
    }
  }
  return docs;
}

const accountKey = (d) => `${d.provider || ''}${SEP}${d.accountNo ?? ''}`;

function byAccount(docs) {
  const m = new Map();
  for (const d of docs) {
    const k = accountKey(d);
    m.set(k, [...(m.get(k) || []), d]);
  }
  return m;
}

/** Documents authoritative for one fact, per account — see the precedence rule above. */
export function authoritativeDocs(docs, types) {
  const out = [];
  for (const group of byAccount(docs).values()) {
    const winner = types.find((t) => group.some((d) => d.reportType === t));
    if (winner) out.push(...group.filter((d) => d.reportType === winner));
  }
  return out;
}

/**
 * Every dated row of one kind, across every issue an account published, each counted ONCE.
 * Newest issue first, so a row printed twice keeps the newer statement's copy and its `source`.
 */
export function datedRows(docs, types, kind) {
  const out = [];
  for (const group of byAccount(authoritativeDocs(docs, types)).values()) {
    const seen = new Set();
    const ordered = [...group].sort((a, b) => String(b.asOf || '').localeCompare(String(a.asOf || '')));
    for (const doc of ordered) {
      const ordinal = new Map();
      for (const row of doc[kind] || []) {
        const base = [kind, doc.accountNo, ...ROW_FIELDS.map((f) => String(row[f] ?? ''))].join(SEP);
        const n = (ordinal.get(base) || 0) + 1;
        ordinal.set(base, n);
        const key = `${base}${SEP}#${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ doc, row });
      }
    }
  }
  return out;
}

/**
 * THE STATEMENT'S OWN SETTLEMENT FIGURE, in the upstream's own order of preference, and `null`
 * where it printed none. Lifted verbatim from `settledAmount` in GlowVentures' `src/lib/ledger.ts`.
 */
export const settledAmount = (t) => t?.printed?.settlementAmount ?? t?.net ?? t?.gross ?? null;

/**
 * REALISED GAIN PER (ACCOUNT, SECURITY, SALE DATE), from the capital gain statements — and
 * attributed to ONE transaction row per sale.
 *
 * The capital gain statement settles a DAY'S sale of a name against however many purchase lots it
 * consumed and prints one figure per lot; the transaction statement prints the same sale as one
 * row, or occasionally two. Handing the day's whole realised figure to each row double-counts it —
 * GlowVentures measured Syngene's −₹1.4 Cr counted twice. So each (account, security, date) is
 * attributed once, to the first row of that sale, and the rest carry a note saying where it went.
 */
export function realisedIndex(docs) {
  const m = new Map();
  for (const { doc, row } of datedRows(docs, AUTHORITATIVE.capitalGains, 'capitalGains')) {
    if (!row.saleDate) continue;
    const k = `${doc.accountNo}${SEP}${row.securityKey}@${row.saleDate}`;
    m.set(k, (m.get(k) || 0) + (row.shortTerm || 0) + (row.longTerm || 0));
  }
  return m;
}

export const saleKey = (accountNo, securityKey, date) => `${accountNo}${SEP}${securityKey}@${date}`;
