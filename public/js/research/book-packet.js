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

function bookRow(row) {
  const mark = eodMark(row);
  return {
    ticker: row.symbol || null,
    company: clipped(row.security, 60),
    assetClass: row.assetClass || null,
    sector: row.sector && row.sector !== 'Unclassified' ? row.sector : row.providerSector || null,
    owner: row.owner || null,
    provider: row.provider || null,
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
  const rows = book.forScope(scope, tickers);
  const isWatchlist = scope === 'watchlist';
  const value = book.valueOf(rows);
  const ring = book.ringFenced();
  const ringNames = ring.map((row) => row.symbol || row.security).join(', ');

  const summary = m
    ? {
        consolidatedValueRupees: isWatchlist ? value : m.totalValue,
        consolidatedValueCrore: crore(isWatchlist ? value : m.totalValue),
        listedValueCrore: isWatchlist ? null : crore(m.listedValue),
        privateValueCrore: isWatchlist ? null : crore(m.privateValue),
        positions: rows.length,
        withNseSymbol: rows.filter((row) => row.symbol).length,
        accounts: isWatchlist ? new Set(rows.map((row) => row.accountId)).size : m.accounts,
        owners: isWatchlist ? new Set(rows.map((row) => row.ownerId)).size : m.owners,
        byAssetClassCrore: classSplitCrore(rows),
        duplicateReportsCollapsedRupees: isWatchlist ? null : m.doubleCounted,
        withoutCostBasis: rows.filter((row) => row.costBasis == null).length,
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
        'REAL statement marks on each account’s report date, each duplicate report counted once; null cost/P&L is never zero; ' +
        'eodMarkRupees is derived (quantity × EOD close, listed symbols only); the ring-fenced promoter holding is outside the total.' +
        (isWatchlist ? ' Watchlist figures come from the starred rows only.' : ''),
      dataQuality: 'real statement marks, consolidated once, with nulls preserved',
    },
    rows,
    mapRow: bookRow,
    compare: (a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0),
  };
}
