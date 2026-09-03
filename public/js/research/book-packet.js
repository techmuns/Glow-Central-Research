// research/book-packet.js — the Ask Research evidence for THE FAMILY OFFICE BOOK. GLOW-OWNED.
//
// Ask Research's `portfolio` source used to read the illustrative FIFO ledger — twelve invented
// positions marked at real closes — and answered "how is my portfolio doing" with a figure nobody
// holds. It now reads `public/data/book.json`, the family's consolidated book as the wealth
// platforms' statements print it, synced daily from techmuns/GlowVentures. This module builds
// everything that packet carries except the two helpers that stay in estate.js (`sourcePacket`
// wraps it, `chooseRows` ranks the rows), so the upstream file changes by one small hunk.
//
// Rules the packet keeps, because the model repeats what it is handed:
//   • CONSOLIDATED figures count each dedupeGroup once; the rows say when a holding is also
//     reported under another member, so a per-owner question can still be answered honestly.
//   • A NULL STAYS NULL. A cost the depository does not know is `null` in the packet, and the
//     definition says so — the model must never read a missing cost as a 100% gain.
//   • THE RING-FENCED PROMOTER HOLDING IS NAMED AND KEPT OUT of the total, as upstream keeps it.
//   • THE LIVE MARK IS LABELLED. The statements' marks are the figures; an EOD close from the
//     technicals feed is offered beside them for listed symbols only, as a separate, derived field.
//
// AND THE PACKET IS SMALL, BECAUSE THE SKELETON IS BUDGETED. estate.js gives the fifteen sources'
// rowless skeleton at most 60% of a 13,000-character budget and drops `summary`, then `coverage`,
// from the largest sources first when it does not fit — silently, recorded as `trimmed`. The first
// version of this summary carried a per-class list, a sentence about the ring-fenced holding and
// two spellings of every value; it was the largest skeleton on the page and the trimmer dropped it
// whole, so the model was handed 369 rows and no total. Every field below is one number or one
// short string, and `definition` fits the 240 characters `boundedMetadata` keeps.

import * as book from '../data/book.js';
import * as technicals from '../data/technicals.js';

const round = (value, places = 2) => {
  if (!Number.isFinite(value)) return value ?? null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clipped = (value, max = 80) => {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const crore = (rupees) => (Number.isFinite(rupees) ? round(rupees / 1e7, 2) : null);

function eodMark(row) {
  if (!row.symbol || !technicals.isLoaded()) return null;
  const t = technicals.byTicker(row.symbol);
  const cmp = Number(t?.cmp);
  if (!t || !Number.isFinite(cmp) || !Number.isFinite(row.quantity)) return null;
  return { close: cmp, closeDate: t.bar_date || null, valueRupees: round(row.quantity * cmp) };
}

/**
 * ONE ROW PER COMPANY, NOT ONE PER ACCOUNT. The tab shows every statement line — a symbol held in
 * four accounts is four rows there, deliberately. The model is better served by the consolidated
 * holding: "how much Bajaj Auto do we hold" is one number, and four near-identical rows crowd the
 * budgeted packet so that other sources' rows about the same company are refused (measured: the
 * General Alerts source landed one row where it had room for two). Rows are collapsed by symbol;
 * a line with no symbol stays its own row. Sums follow the null rule — a cost or P&L is summed only
 * when every collapsed line carries one, and is null otherwise, never a partial figure passed off
 * as the whole.
 */
export function collapseBySymbol(rows) {
  const bySymbol = new Map();
  const out = [];
  for (const row of rows) {
    if (!row.symbol) {
      out.push({ ...row, accounts: 1, owners: row.owner ? [row.owner] : [] });
      continue;
    }
    const key = String(row.symbol).toUpperCase();
    if (!bySymbol.has(key)) {
      const first = { ...row, symbol: key, accounts: 0, owners: [], providers: [], _lines: [] };
      bySymbol.set(key, first);
      out.push(first);
    }
    const acc = bySymbol.get(key);
    acc.accounts += 1;
    if (row.owner && !acc.owners.includes(row.owner)) acc.owners.push(row.owner);
    if (row.provider && !acc.providers.includes(row.provider)) acc.providers.push(row.provider);
    acc._lines.push(row);
  }
  for (const acc of bySymbol.values()) {
    const lines = acc._lines;
    const sum = (key) => (lines.every((l) => Number.isFinite(l[key])) ? round(lines.reduce((s, l) => s + l[key], 0)) : null);
    acc.quantity = sum('quantity');
    acc.marketValue = sum('marketValue');
    acc.costBasis = sum('costBasis');
    acc.unrealizedPnL = sum('unrealizedPnL');
    // The aggregate return on cost, only where every line's cost is known — otherwise null.
    acc.returnPct = acc.costBasis ? round(((acc.marketValue - acc.costBasis) / acc.costBasis) * 100) : null;
    acc.accountAsOf = lines.map((l) => l.accountAsOf).filter(Boolean).sort().at(-1) || null;
    acc.security = lines.map((l) => l.security).sort((a, b) => (/[a-z]/.test(b) ? 1 : 0) - (/[a-z]/.test(a) ? 1 : 0) || b.length - a.length)[0];
    acc.sector = lines.map((l) => (l.sector && l.sector !== 'Unclassified' ? l.sector : null)).find(Boolean) || lines[0].sector || null;
    acc.isin = lines.map((l) => l.isin).find(Boolean) || null;
    acc.alsoReportedUnder = null;
    delete acc._lines;
  }
  return out;
}

function bookRow(row) {
  const mark = eodMark(row);
  return {
    ticker: row.symbol || null,
    company: clipped(row.security, 60),
    assetClass: row.assetClass || null,
    sector: row.sector && row.sector !== 'Unclassified' ? row.sector : row.providerSector || null,
    owners: row.owners?.length ? row.owners.join(', ') : row.owner || null,
    accounts: row.accounts ?? 1,
    quantity: row.quantity ?? null,
    statementValueRupees: round(row.marketValue),
    weightPct: book.weightPct(row),
    costBasisRupees: row.costBasis == null ? null : round(row.costBasis),
    unrealisedPnlRupees: row.unrealizedPnL == null ? null : round(row.unrealizedPnL),
    returnPct: row.returnPct == null ? null : round(row.returnPct),
    statementAsOf: row.accountAsOf || null,
    // Derived, labelled, listed symbols only: the statement's mark is the figure above.
    eodMarkRupees: mark?.valueRupees ?? null,
    eodCloseDate: mark?.closeDate ?? null,
    alsoReportedUnder: Array.isArray(row.alsoReportedUnder) && row.alsoReportedUnder.length ? row.alsoReportedUnder.join(', ') : null,
  };
}

/** `{ AIF: 352.35, Equity: 222, … }` in crore, largest first — one object, not one string per class. */
function classSplitCrore(rows) {
  const by = new Map();
  for (const row of rows) {
    const key = row.assetClass || 'Unclassified';
    by.set(key, (by.get(key) || 0) + (Number.isFinite(row.marketValue) ? row.marketValue : 0));
  }
  return Object.fromEntries([...by.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, crore(v)]));
}

/**
 * Everything the `portfolio` packet carries, minus the estate.js wrappers. `scope` is the
 * dashboard scope; `tickers` is the watchlist's set when the scope is `watchlist`.
 */
export function bookEvidence({ scope, tickers = null }) {
  const m = book.meta();
  const lines = book.forScope(scope, tickers);
  const rows = collapseBySymbol(lines);
  const isWatchlist = scope === 'watchlist';
  const value = book.valueOf(lines);
  const ring = book.ringFenced();
  const ringNames = ring.map((row) => row.symbol || row.security).join(', ');

  const summary = m
    ? {
        consolidatedValueRupees: isWatchlist ? value : m.totalValue,
        consolidatedValueCrore: crore(isWatchlist ? value : m.totalValue),
        listedValueCrore: isWatchlist ? null : crore(m.listedValue),
        privateValueCrore: isWatchlist ? null : crore(m.privateValue),
        positions: rows.length,
        statementLines: lines.length,
        withNseSymbol: rows.filter((row) => row.symbol).length,
        accounts: isWatchlist ? new Set(lines.map((row) => row.accountId)).size : m.accounts,
        owners: isWatchlist ? new Set(lines.map((row) => row.ownerId)).size : m.owners,
        byAssetClassCrore: classSplitCrore(lines),
        duplicateReportsCollapsedRupees: isWatchlist ? null : m.doubleCounted,
        withoutCostBasis: lines.filter((row) => row.costBasis == null).length,
        ringFencedOutsideTotal: ring.length ? `${ringNames} ₹${crore(book.valueOf(ring))} Cr` : null,
        statementsAsOf: m.asOf,
        syncedFrom: m.builtFrom ? `GlowVentures@${m.builtFrom}` : 'GlowVentures',
      }
    : null;

  return {
    details: {
      source: 'Family office book — the wealth platforms’ own statements, consolidated by techmuns/GlowVentures, synced daily',
      asOf: m?.asOf || null,
      rowCount: rows.length,
      coverage: {
        bookPositions: m?.counted ?? null,
        accounts: m?.accounts ?? null,
        accountsWithoutValuation: m?.accountsWithoutPositions ?? null,
        reconciliationResidualRupees: m?.residual ?? null,
      },
      summary,
      // ≤ 240 characters, or boundedMetadata clips it: the null rule and the derived label must survive.
      definition:
        'REAL statement marks, one row per company (accounts = how many statements hold it), each duplicate report counted once; null cost/P&L is never zero; ' +
        'eodMarkRupees is derived (quantity × EOD close, listed symbols only); the ring-fenced promoter holding is outside the total.' +
        (isWatchlist ? ' Watchlist figures come from the starred rows only.' : ''),
      dataQuality: 'real statement marks, consolidated once, with nulls preserved',
    },
    rows,
    mapRow: bookRow,
    compare: (a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0),
  };
}
