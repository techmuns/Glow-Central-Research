#!/usr/bin/env node
// scripts/build-managers.mjs — public/data/managers.json, THE FAMILY'S MANAGERS, from a GlowVentures
// checkout. GLOW-OWNED.
//
//   GLOWVENTURES_DIR=/path/to/glowventures node scripts/build-managers.mjs
//
// WHAT A "MANAGER" IS HERE. The Superstar Investors tab tracks ninety public investors the family
// has no relationship with. This file is the other list — the managers the family actually pays:
//
//   pms   a discretionary PMS mandate, one per (manager, strategy). The manager's statement lists
//         every share it holds for the family, so what the manager IS DOING can be read straight
//         off two consecutive statements and the trades between them.
//   aif   an alternative fund the family holds units of. SEBI requires no monthly portfolio from a
//         Category II or III AIF, so there is nothing to look through — what the manager reports
//         is a NAV, its returns, the capital drawn against a commitment and any distribution, and
//         that is what is carried. Where the fund also files >1% stakes with the exchanges it is on
//         Ticker Finology's superstar list, and `finologySlug` says so.
//   mf    a mutual fund house, grouped by AMC across every scheme the family holds. The AMC's own
//         monthly SEBI portfolio disclosure (via the family's AmfiBeas store, copied into
//         GlowVentures' look-through) says what each scheme holds.
//
// Direct holdings — shares and cash in the family's own depository accounts — are NOT a manager and
// are not in this file beyond a summary figure that lets the total reconcile. They are on the
// Family Book tab.
//
// THREE SOURCES, ONE CHECKOUT, and every figure names which:
//   • src/data/glowData.ts — accounts, current positions, per-account returns, bridges,
//     commitments, corporate actions and NAV history, exactly as build-book.mjs reads them;
//   • public/audit/<docKey>/document.json — the STATEMENTS themselves. Holdings are read from the
//     report type precedence names authoritative per account (appraisal, else the SEBI investor
//     report, else the holdings statement), newest issue first; trades from the transaction
//     statement, else the investor report — the same order src/lib/ledger.ts reads them in, so the
//     two dashboards cannot disagree about which document a figure came from;
//   • public/lookthrough/*.json — the AMC disclosures, resolved per scheme by ISIN there.
//
// RULES, each one already a rule of this repository:
//   • A NULL IS NOT ZERO. A statement that prints no cost, no settlement amount or no weight leaves
//     the field null; nothing is defaulted. A return is derived only where every counted row
//     carries a cost, and it is labelled derived.
//   • COUNT EACH dedupeGroup ONCE — the same AIF folio is on two members' statements.
//   • A MOVE IS A CHANGE IN QUANTITY, never in value. Value moves with the price on a day the
//     manager did nothing; the quantity on the statement is the primitive. "No longer on the
//     statement" is worded exactly so — a PMS statement lists every holding, so this is a sale or a
//     corporate action, and the trades and corporate actions in the same window are joined to
//     each move to say which.
//   • NOTHING IS SCORED. Counts of managers who moved the same way are counts.
//   • IT IS IDEMPOTENT: built from the input alone, key order fixed, `builtFrom` the upstream
//     commit, so the daily copy commits only when something changed.
//   • IT REFUSES TO WRITE when the managed and direct values do not add back to the book's own
//     headline, when a hand-checked cross-link names an investor the superstar snapshot does not
//     carry, or when an account cannot be placed.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openGlowData } from './lib/glowdata.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.GLOWVENTURES_DIR || '/tmp/glowventures';
const OUT = process.env.MANAGERS_OUT || join(ROOT, 'public/data/managers.json');
// This repository's own superstar snapshot — the list a Finology cross-link must be found in.
const SUPERSTAR_SNAPSHOT = process.env.SUPERSTAR_SNAPSHOT || join(ROOT, 'public/data/super-investors.json');

/**
 * Statements kept per account, newest first. Two is a comparison, and two is what is kept: a third
 * costs ~65KB per mandate for a trend the moves already state, on a file every visitor downloads.
 */
const STATEMENTS_KEPT = 2;

// Which engagement is which kind of manager. Direct and Execution are the family's own hands and
// place nothing here (their fund units are placed by the look-through below); an engagement this
// table does not name is reported, never guessed into a bucket.
const KIND_OF_ENGAGEMENT = { PMS: 'pms', AIF: 'aif', Distribution: 'aif', Advisory: 'aif' };
const KIND_ORDER = { pms: 0, aif: 1, mf: 2 };

// HAND-CHECKED. Two provider names that are one fund on the family's side: the AIF's own folio
// statements (income and distributions only — no valuation) arrive under the manager's name, and
// the units are valued on the distributor's client report. Without the fold one fund is two
// cards, one of them worth nothing.
const SAME_MANAGER = { '360 ONE Alternates Asset Management': '360 ONE Private Wealth' };

// HAND-CHECKED. Managers that are ALSO tracked as superstar investors on Ticker Finology, keyed by
// the product id below → the Finology slug. A fund that files >1% stakes with the exchanges gets
// its public book on the Superstar Investors tab; the link is what lets a reader see what that
// manager is doing from the filings when the fund itself publishes no portfolio. Verified against
// the superstar snapshot at build time — a slug the list does not carry fails the build.
const FINOLOGY_INVESTORS = { '3p-investment-managers': '3p-india-equity-fund-1' };

// Holdings and trades: the report type authoritative per account, first present wins — the read-
// side order src/lib/ledger.ts uses. `unknown` (the AIF account statements) is deliberately not a
// holdings source here: those carry units of one fund, not a portfolio.
const HOLDINGS_TYPES = ['appraisal', 'investor-report', 'holdings'];
const TXN_TYPES = ['transaction-statement', 'investor-report'];
// The fields that identify one dated row — the ledger's ROW_FIELDS, so a row printed on two issues
// of a statement is counted once and a row printed twice on one issue (two real trades) twice.
const ROW_FIELDS = ['date', 'settlementDate', 'securityKey', 'side', 'exchange', 'quantity', 'unitPrice', 'gross', 'charges', 'net'];

const CASH_KEYS = new Set(['cash', 'cash-rec-payable']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const accountIdOf = (provider, accountNo) => `${slug(provider)}-${accountNo}`;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] === undefined ? null : o[k]]));
const uniq = (xs) => [...new Set(xs)];

// ---- the book, as build-book.mjs reads it -------------------------------------------------------
const gd = openGlowData(SRC_DIR);
const accounts = gd.arr('BOOK_ACCOUNTS');
const positions = gd.arr('BOOK_POSITIONS');
const summary = gd.obj('BOOK_SUMMARY');
const owners = gd.arr('BOOK_OWNERS');
const returnsByAccount = gd.has('BOOK_ACCOUNT_RETURNS') ? gd.obj('BOOK_ACCOUNT_RETURNS') : {};
const bridgesByAccount = gd.has('BOOK_ACCOUNT_BRIDGES') ? gd.obj('BOOK_ACCOUNT_BRIDGES') : {};
const commitments = gd.has('BOOK_COMMITMENTS') ? gd.arr('BOOK_COMMITMENTS') : [];
const corporateActions = gd.has('BOOK_CORPORATE_ACTIONS') ? gd.arr('BOOK_CORPORATE_ACTIONS') : [];
const navByAccount = gd.has('BOOK_ACCOUNT_NAV_HISTORY') ? gd.obj('BOOK_ACCOUNT_NAV_HISTORY') : {};
const asOf = gd.str('BOOK_AS_OF') || summary.asOf;
const builtFrom = gd.commit();

const ownerName = new Map(owners.map((o) => [o.ownerId, o.displayName ?? o.name ?? o.ownerId]));
const accountById = new Map(accounts.map((a) => [a.accountId, a]));
const positionsByAccount = new Map();
for (const p of positions) {
  if (!positionsByAccount.has(p.accountId)) positionsByAccount.set(p.accountId, []);
  positionsByAccount.get(p.accountId).push(p);
}
// The book's own identity for a line — symbol, ISIN, sector — joined onto statement rows by the
// key both were built with. A line no longer in the book (an exit, a trade in a name since sold)
// falls back to GlowVentures' own key → NSE symbol map, which is hand-maintained there and never
// inferred from a name here.
const bookRow = new Map(positions.map((p) => [`${p.accountId}|${p.securityKey}`, p]));
const symbolsPath = join(SRC_DIR, 'src/data/nseSymbols.json');
const symbolOf = existsSync(symbolsPath) ? readJson(symbolsPath) : {};
const symbolFor = (accountId, securityKey) => bookRow.get(`${accountId}|${securityKey}`)?.symbol ?? symbolOf[securityKey] ?? null;

/** Consolidated figures over a row set, each dedupeGroup counted once. Nulls stay null. */
function consolidate(rows) {
  const seen = new Set();
  let mv = 0;
  let cost = 0;
  let pnl = 0;
  let costRows = 0;
  let pnlRows = 0;
  let n = 0;
  for (const p of rows) {
    if (p.dedupeGroup) {
      if (seen.has(p.dedupeGroup)) continue;
      seen.add(p.dedupeGroup);
    }
    n++;
    mv += num(p.marketValue) ?? 0;
    if (num(p.costBasis) != null) {
      cost += p.costBasis;
      costRows++;
    }
    if (num(p.unrealizedPnL) != null) {
      pnl += p.unrealizedPnL;
      pnlRows++;
    }
  }
  return {
    marketValue: r2(mv),
    costBasis: costRows ? r2(cost) : null,
    costRows,
    unrealizedPnL: pnlRows ? r2(pnl) : null,
    pnlRows,
    positions: n,
    rows: rows.length,
    // Derived, and only where the cost side covers every counted row — a return over part of a
    // book is a different number that looks the same on screen.
    returnPct: costRows && costRows === n && cost > 0 ? r2(((mv - cost) / cost) * 100) : null,
  };
}

const accountOut = (a) => ({
  ...pick(a, ['accountId', 'accountNo', 'ownerId', 'strategy', 'engagement', 'providerEngagement', 'asOf', 'inceptionDate', 'noPositionsReason']),
  provider: a.provider,
  owner: ownerName.get(a.ownerId) ?? a.owner ?? null,
});

const positionOut = (p) => ({
  ...pick(p, ['securityKey', 'security', 'symbol', 'isin', 'sector', 'providerSector', 'assetClass', 'quantity', 'marketValue', 'costBasis', 'unrealizedPnL', 'returnPct', 'avgCost', 'currentPrice', 'positionIrrPct', 'dividendReceived', 'dedupeGroup', 'alsoReportedUnder']),
  accountId: p.accountId,
  owner: ownerName.get(accountById.get(p.accountId)?.ownerId) ?? accountById.get(p.accountId)?.owner ?? null,
  accountAsOf: accountById.get(p.accountId)?.asOf ?? null,
});

// ---- the statements ---------------------------------------------------------------------------
const manifestPath = join(SRC_DIR, 'public/audit/manifest.json');
const manifest = existsSync(manifestPath) ? readJson(manifestPath) : [];
const docsByAccount = new Map();
for (const row of manifest) {
  if (!row.accountNo || !row.provider || row.status === 'failed') continue;
  const id = accountIdOf(row.provider, row.accountNo);
  if (!docsByAccount.has(id)) docsByAccount.set(id, []);
  docsByAccount.get(id).push(row);
}
const docCache = new Map();
function loadDoc(docKey) {
  if (!docCache.has(docKey)) {
    const p = join(SRC_DIR, 'public/audit', docKey, 'document.json');
    docCache.set(docKey, existsSync(p) ? readJson(p) : null);
  }
  return docCache.get(docKey);
}

/** The documents of the first report type present for an account, in precedence order. */
function authoritative(accountId, types) {
  const rows = docsByAccount.get(accountId) || [];
  const type = types.find((t) => rows.some((r) => r.reportType === t));
  if (!type) return [];
  return rows
    .filter((r) => r.reportType === type)
    .map((r) => loadDoc(r.docKey))
    .filter((d) => d && d.status !== 'failed');
}

const warningsOf = (d) => (d.warnings || []).map((w) => `${w.code}: ${w.detail}`);

const holdingOut = (accountId, h) => {
  const b = bookRow.get(`${accountId}|${h.securityKey}`);
  return {
    securityKey: h.securityKey,
    security: h.security,
    symbol: symbolFor(accountId, h.securityKey) ?? h.symbol ?? null,
    isin: b?.isin ?? h.isin ?? null,
    sector: b?.sector && b.sector !== 'Unclassified' ? b.sector : (b?.providerSector ?? h.providerSector ?? null),
    assetClass: h.assetClass ?? null,
    quantity: num(h.quantity),
    marketPrice: num(h.marketPrice),
    marketValue: num(h.marketValue),
    totalCost: num(h.totalCost),
    // Gain and its percentage on the same primitives the market value is struck on (GlowVentures'
    // extractor derives both from quantity, cost and price); null where the statement carries no
    // cost, never zero.
    gainLoss: num(h.gainLoss),
    pctGainLoss: num(h.pctGainLoss),
    // The weight on the statement's own market values (the extractor derives it consistently); the
    // manager's printed column rides beside it because on the SEBI investor report the two differ
    // — that column is of AUM, not of market value — and a reader may hold the PDF.
    weightPct: num(h.pctAssets),
    printedWeightPct: num(h.printed?.pctAssets),
  };
};

/** Holdings statements for one account: newest first, one per date, at most STATEMENTS_KEPT. */
function statementsFor(accountId) {
  const docs = authoritative(accountId, HOLDINGS_TYPES).filter((d) => Array.isArray(d.holdings) && d.holdings.length);
  const byDate = new Map();
  for (const d of docs.sort((a, b) => (b.asOf || '').localeCompare(a.asOf || '') || a.docKey.localeCompare(b.docKey))) {
    if (!d.asOf || byDate.has(d.asOf)) continue;
    byDate.set(d.asOf, d);
  }
  return [...byDate.values()].slice(0, STATEMENTS_KEPT).map((d) => ({
    accountId,
    asOf: d.asOf,
    reportType: d.reportType,
    docKey: d.docKey,
    status: d.status,
    periodFrom: d.periodFrom ?? null,
    periodTo: d.periodTo ?? null,
    warnings: warningsOf(d),
    totals: d.totals ? pick(d.totals, ['equityMarketValue', 'cashValue', 'totalMarketValue', 'equityCost', 'totalCost', 'gainLoss', 'pctGainLoss', 'positionCount']) : null,
    holdings: d.holdings.filter((h) => h.securityKey).map((h) => holdingOut(accountId, h)),
  }));
}

/** Every dated trade an account's authoritative documents carry, each counted once. */
function transactionsFor(accountId) {
  const docs = authoritative(accountId, TXN_TYPES).sort((a, b) => (b.asOf || '').localeCompare(a.asOf || ''));
  const out = [];
  const seen = new Set();
  const account = accountById.get(accountId);
  for (const d of docs) {
    const ordinal = new Map();
    for (const t of d.transactions || []) {
      if (!t.date || !t.securityKey) continue;
      const base = ROW_FIELDS.map((f) => String(t[f] ?? '')).join(' ');
      const n = (ordinal.get(base) ?? 0) + 1;
      ordinal.set(base, n);
      const key = `${base}#${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date: t.date,
        side: t.side === 'sell' ? 'sell' : 'buy',
        security: t.security,
        securityKey: t.securityKey,
        symbol: symbolFor(accountId, t.securityKey),
        assetClass: t.assetClass ?? null,
        quantity: num(t.quantity),
        unitPrice: num(t.unitPrice),
        // The statement's own settlement figure first; the extractor's reconstruction only where
        // the statement printed none; null where nothing was reported — never a zero.
        amount: num(t.printed?.settlementAmount) ?? num(t.net) ?? num(t.gross) ?? null,
        accountId,
        owner: ownerName.get(account?.ownerId) ?? account?.owner ?? null,
        source: d.docKey,
      });
    }
  }
  const window = docs.reduce(
    (w, d) => ({
      from: d.periodFrom && (!w.from || d.periodFrom < w.from) ? d.periodFrom : w.from,
      to: d.periodTo && (!w.to || d.periodTo > w.to) ? d.periodTo : w.to,
    }),
    { from: null, to: null }
  );
  return {
    rows: out.sort((a, b) => b.date.localeCompare(a.date) || a.security.localeCompare(b.security)),
    window,
    reportType: docs[0]?.reportType ?? null,
    warnings: uniq(docs.flatMap(warningsOf)),
  };
}

/**
 * What a PMS manager DID between its two newest statements, per security, across the mandate's
 * accounts — and the trades and corporate actions in that window that account for it.
 */
function movesFor(accountIds, statements, transactions) {
  const byAccount = new Map(accountIds.map((id) => [id, statements.filter((s) => s.accountId === id)]));
  const comparable = accountIds.filter((id) => (byAccount.get(id) || []).length >= 2);
  const single = accountIds.filter((id) => (byAccount.get(id) || []).length === 1);
  const none = accountIds.filter((id) => !(byAccount.get(id) || []).length);
  if (!comparable.length) {
    return { window: null, comparableAccounts: [], singleStatementAccounts: single, noStatementAccounts: none, cash: null, moves: [] };
  }
  const latestOf = (id) => byAccount.get(id)[0];
  const priorOf = (id) => byAccount.get(id)[1];
  const totalOf = (s) => num(s.totals?.totalMarketValue) ?? s.holdings.reduce((a, h) => a + (h.marketValue ?? 0), 0);
  const totalNow = comparable.reduce((s, id) => s + totalOf(latestOf(id)), 0);
  const totalBefore = comparable.reduce((s, id) => s + totalOf(priorOf(id)), 0);
  const cashNow = comparable.reduce((s, id) => s + (num(latestOf(id).totals?.cashValue) ?? 0), 0);
  const cashBefore = comparable.reduce((s, id) => s + (num(priorOf(id).totals?.cashValue) ?? 0), 0);
  const window = {
    from: comparable.map((id) => priorOf(id).asOf).sort()[0],
    to: comparable.map((id) => latestOf(id).asOf).sort().at(-1),
    // One pair per account: the head can say when the windows differ between a mandate's accounts.
    pairs: uniq(comparable.map((id) => `${priorOf(id).asOf} → ${latestOf(id).asOf}`)),
  };

  const bySecurity = new Map();
  const add = (side, id, h) => {
    if (h.assetClass === 'Cash' || CASH_KEYS.has(h.securityKey)) return;
    if (!bySecurity.has(h.securityKey)) {
      bySecurity.set(h.securityKey, { securityKey: h.securityKey, security: h.security, symbol: h.symbol, isin: h.isin, sector: h.sector, before: null, now: null, mvBefore: null, mvNow: null, accounts: new Set() });
    }
    const m = bySecurity.get(h.securityKey);
    if (!m.symbol && h.symbol) m.symbol = h.symbol;
    m.accounts.add(id);
    if (side === 'now') {
      m.now = (m.now ?? 0) + (h.quantity ?? 0);
      m.mvNow = (m.mvNow ?? 0) + (h.marketValue ?? 0);
    } else {
      m.before = (m.before ?? 0) + (h.quantity ?? 0);
      m.mvBefore = (m.mvBefore ?? 0) + (h.marketValue ?? 0);
    }
  };
  for (const id of comparable) {
    for (const h of latestOf(id).holdings) add('now', id, h);
    for (const h of priorOf(id).holdings) add('before', id, h);
  }

  const inWindow = (date, id) => !!date && date > priorOf(id).asOf && date <= latestOf(id).asOf;
  const sum = (xs, f) => (xs.some((x) => num(f(x)) != null) ? r2(xs.reduce((s, x) => s + (num(f(x)) ?? 0), 0)) : null);
  const moves = [];
  for (const m of bySecurity.values()) {
    const weightBefore = m.mvBefore == null || !totalBefore ? null : r2((m.mvBefore / totalBefore) * 100);
    const weightNow = m.mvNow == null || !totalNow ? null : r2((m.mvNow / totalNow) * 100);
    let action;
    let deltaQty = null;
    if (m.before == null) action = 'new';
    else if (m.now == null) action = 'exited';
    else {
      deltaQty = m.now - m.before;
      action = deltaQty > 0 ? 'added' : deltaQty < 0 ? 'trimmed' : 'held';
    }
    const trades = transactions.filter((t) => t.securityKey === m.securityKey && m.accounts.has(t.accountId) && inWindow(t.date, t.accountId));
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');
    const via = uniq(
      corporateActions
        .filter((c) => c.securityKey === m.securityKey && m.accounts.has(c.accountId) && inWindow(c.exDate, c.accountId))
        .map((c) => c.kind)
        .filter(Boolean)
    );
    moves.push({
      securityKey: m.securityKey,
      security: m.security,
      symbol: m.symbol ?? null,
      isin: m.isin ?? null,
      sector: m.sector ?? null,
      action,
      qtyBefore: m.before,
      qtyNow: m.now,
      deltaQty,
      valueBefore: m.mvBefore == null ? null : r2(m.mvBefore),
      valueNow: m.mvNow == null ? null : r2(m.mvNow),
      weightBefore,
      weightNow,
      deltaPp: weightBefore == null || weightNow == null ? null : r2(weightNow - weightBefore),
      accounts: [...m.accounts].sort(),
      trades: {
        buys: buys.length,
        sells: sells.length,
        qtyBought: sum(buys, (t) => t.quantity),
        qtySold: sum(sells, (t) => t.quantity),
        bought: sum(buys, (t) => t.amount),
        sold: sum(sells, (t) => t.amount),
        first: trades.map((t) => t.date).sort()[0] ?? null,
        last: trades.map((t) => t.date).sort().at(-1) ?? null,
      },
      via,
    });
  }
  const order = { new: 0, added: 1, trimmed: 2, exited: 3, held: 4 };
  moves.sort((a, b) => order[a.action] - order[b.action] || Math.abs(b.deltaPp ?? 0) - Math.abs(a.deltaPp ?? 0) || (b.valueNow ?? 0) - (a.valueNow ?? 0));
  return {
    window,
    comparableAccounts: comparable,
    singleStatementAccounts: single,
    noStatementAccounts: none,
    cash: {
      before: r2(cashBefore),
      now: r2(cashNow),
      weightBefore: totalBefore ? r2((cashBefore / totalBefore) * 100) : null,
      weightNow: totalNow ? r2((cashNow / totalNow) * 100) : null,
      totalBefore: r2(totalBefore),
      totalNow: r2(totalNow),
    },
    moves,
  };
}

// ---- the products -----------------------------------------------------------------------------
const products = new Map();
const excludedAccounts = [];
const placed = new Set(); // accountIds placed under a PMS or AIF product

function productFor(account) {
  const kind = KIND_OF_ENGAGEMENT[account.engagement];
  if (!kind) return null;
  const provider = SAME_MANAGER[account.provider] || account.provider;
  const id = kind === 'pms' ? `${slug(provider)}--${slug(account.strategy || 'mandate')}` : slug(provider);
  if (!products.has(id)) {
    products.set(id, {
      id,
      kind,
      name: null, // resolved once every account is in
      house: provider,
      engagement: account.engagement,
      providerEngagement: account.providerEngagement ?? null,
      accounts: [],
    });
  }
  return products.get(id);
}

for (const a of accounts) {
  if (a.engagement === 'Direct' || a.engagement === 'Execution') continue; // the family's own hands
  const product = productFor(a);
  if (!product) {
    excludedAccounts.push({ accountId: a.accountId, provider: a.provider, engagement: a.engagement ?? null, reason: `engagement ${JSON.stringify(a.engagement ?? null)} is not one this file knows how to place` });
    continue;
  }
  product.accounts.push(accountOut(a));
  placed.add(a.accountId);
}

// ---- mutual funds: the look-through, grouped by AMC ----------------------------------------------
const ltIndexPath = join(SRC_DIR, 'public/lookthrough/index.json');
const ltIndex = existsSync(ltIndexPath) ? readJson(ltIndexPath) : { schemes: {}, unresolved: [], source: null };
const unresolvedSchemes = [];
const mfRows = positions.filter((p) => (p.assetClass === 'Mutual Fund' || p.assetClass === 'ETF') && !placed.has(p.accountId));
const schemeFiles = new Map();
const loadScheme = (code) => {
  if (!schemeFiles.has(code)) {
    const p = join(SRC_DIR, 'public/lookthrough', `${code}.json`);
    schemeFiles.set(code, existsSync(p) ? readJson(p) : null);
  }
  return schemeFiles.get(code);
};
const mfPlaced = new Set(); // `${accountId}|${securityKey}` rows placed under an AMC
for (const p of mfRows) {
  const match = ltIndex.schemes?.[p.securityKey];
  const file = match ? loadScheme(match.schemecode) : null;
  if (!match || !file) {
    const miss = (ltIndex.unresolved || []).find((u) => u.securityKey === p.securityKey);
    if (!unresolvedSchemes.some((u) => u.securityKey === p.securityKey)) {
      unresolvedSchemes.push({
        securityKey: p.securityKey,
        security: p.security,
        isin: p.isin ?? null,
        marketValue: consolidate(mfRows.filter((r) => r.securityKey === p.securityKey)).marketValue,
        reason: miss?.reason ?? (match ? `the look-through store has no file for scheme ${match.schemecode}` : 'not in the look-through index'),
      });
    }
    continue;
  }
  const amc = file.amc || 'AMC not stated';
  const id = `amc--${slug(amc)}`;
  if (!products.has(id)) {
    products.set(id, {
      id,
      kind: 'mf',
      name: amc,
      house: amc,
      engagement: 'Direct',
      providerEngagement: 'mutual-fund units held directly, in a folio or a depository account',
      accounts: [],
      funds: new Map(),
    });
  }
  const product = products.get(id);
  const fundKey = `${file.scheme || match.scheme}|${file.holdingsAsOf || ''}`;
  if (!product.funds.has(fundKey)) {
    product.funds.set(fundKey, {
      scheme: file.scheme || match.scheme,
      amc,
      classification: file.classification ?? null,
      holdingsAsOf: file.holdingsAsOf ?? null,
      holdingsSource: file.holdingsSource ?? null,
      section: file.section ?? null,
      fundAumCr: num(file.fundAumCr),
      equityCount: file.counts?.equity ?? (file.equity || []).length,
      // `pctAum` is the AMC's published weight — a share of the FUND. The fund's own share count is
      // not carried: it is the fund's, not the family's, and nothing here renders it.
      equity: (file.equity || []).map((h) => pick(h, ['name', 'isin', 'sector', 'pctAum'])),
      plans: new Map(),
    });
  }
  const fund = product.funds.get(fundKey);
  if (!fund.plans.has(match.schemecode)) {
    fund.plans.set(match.schemecode, {
      schemecode: match.schemecode,
      plan: file.plan ?? match.plan ?? null,
      option: file.option ?? null,
      isin: file.isin ?? match.isin ?? null,
      amfiSchemeName: file.amfiSchemeName ?? null,
      matchedVia: match.matchedVia ?? null,
      nav: file.nav ?? null,
      returns: file.returns ?? null,
      returnsAsOf: file.returnsAsOf ?? null,
      positions: [],
    });
  }
  fund.plans.get(match.schemecode).positions.push(positionOut(p));
  mfPlaced.add(`${p.accountId}|${p.securityKey}`);
  if (!product.accounts.some((a) => a.accountId === p.accountId)) product.accounts.push(accountOut(accountById.get(p.accountId)));
}

// ---- assemble ---------------------------------------------------------------------------------
const groupOwner = new Map(); // dedupeGroup → product id, so a group can never be counted twice
let managedValue = 0;
const out = [];
for (const product of products.values()) {
  const accountIds = product.accounts.map((a) => a.accountId);
  const rows =
    product.kind === 'mf'
      ? [...product.funds.values()].flatMap((f) => [...f.plans.values()].flatMap((pl) => pl.positions))
      : accountIds.flatMap((id) => positionsByAccount.get(id) || []);
  for (const p of rows) {
    if (!p.dedupeGroup) continue;
    const owner = groupOwner.get(p.dedupeGroup);
    if (owner && owner !== product.id) throw new Error(`dedupeGroup ${p.dedupeGroup} spans two products (${owner}, ${product.id}) and would be counted twice`);
    groupOwner.set(p.dedupeGroup, product.id);
  }
  const value = consolidate(rows);
  managedValue += value.marketValue;

  const strategies = uniq(product.accounts.map((a) => a.strategy).filter(Boolean));
  const name = product.kind === 'mf' ? product.name : product.kind === 'pms' ? product.house : strategies[0] || product.house;
  const entry = {
    id: product.id,
    kind: product.kind,
    name,
    house: product.house,
    strategy: product.kind === 'pms' ? strategies[0] ?? null : strategies.length ? strategies.join(' · ') : null,
    engagement: product.engagement,
    providerEngagement: product.providerEngagement,
    accounts: product.accounts.sort((a, b) => a.accountId.localeCompare(b.accountId)),
    owners: uniq(product.accounts.map((a) => a.owner).filter(Boolean)),
    asOf: product.accounts.map((a) => a.asOf).filter(Boolean).sort().at(-1) ?? null,
    value,
    // A PMS mandate's positions ARE its newest statement, carried under `statements` with the
    // manager's own cost, price and weight; a fund house's are under its look-through plans. Only
    // an alternative fund's units — which no statement itemises — are carried here as book rows.
    positions: product.kind === 'aif' ? rows.map(positionOut) : [],
    finologySlug: FINOLOGY_INVESTORS[product.id] ?? null,
  };

  if (product.kind === 'pms') {
    const statements = accountIds.flatMap(statementsFor).sort((a, b) => b.asOf.localeCompare(a.asOf) || a.accountId.localeCompare(b.accountId));
    const tapes = accountIds.map((id) => [id, transactionsFor(id)]);
    const transactions = tapes.flatMap(([, t]) => t.rows).sort((a, b) => b.date.localeCompare(a.date) || a.security.localeCompare(b.security));
    entry.statements = statements;
    entry.transactions = transactions;
    entry.tape = {
      from: tapes.map(([, t]) => t.window.from).filter(Boolean).sort()[0] ?? null,
      to: tapes.map(([, t]) => t.window.to).filter(Boolean).sort().at(-1) ?? null,
      accountsWith: tapes.filter(([, t]) => t.rows.length).map(([id]) => id),
      accountsWithout: tapes.filter(([, t]) => !t.rows.length).map(([id]) => id),
      reportTypes: uniq(tapes.map(([, t]) => t.reportType).filter(Boolean)),
      warnings: uniq(tapes.flatMap(([, t]) => t.warnings)),
    };
    Object.assign(entry, movesFor(accountIds, statements, transactions));
  }
  if (product.kind !== 'mf') {
    entry.returns = accountIds.flatMap((id) => (returnsByAccount[id] || []).map((b) => ({ accountId: id, reportType: b.reportType, source: b.source, series: b.series })));
    entry.bridges = accountIds.flatMap((id) => (bridgesByAccount[id] || []).map((b) => ({ accountId: id, ...b })));
    entry.navHistory = Object.fromEntries(accountIds.filter((id) => navByAccount[id]?.length).map((id) => [id, navByAccount[id].map((n) => pick(n, ['date', 'nav']))]));
    entry.commitments = commitments.filter((c) => accountIds.includes(c.accountId));
    entry.corporateActions = corporateActions.filter((c) => accountIds.includes(c.accountId)).sort((a, b) => (b.exDate || '').localeCompare(a.exDate || ''));
  }
  if (product.kind === 'mf') {
    entry.lookthrough = {
      source: ltIndex.source ?? null,
      funds: [...product.funds.values()]
        .map((f) => ({
          ...f,
          plans: [...f.plans.values()].map((pl) => ({ ...pl, value: consolidate(pl.positions) })).sort((a, b) => b.value.marketValue - a.value.marketValue),
          value: consolidate([...f.plans.values()].flatMap((pl) => pl.positions)),
        }))
        .sort((a, b) => b.value.marketValue - a.value.marketValue),
    };
  }
  out.push(entry);
}

// ---- the remainder, and the reconciliation -------------------------------------------------------
const directRows = positions.filter((p) => !placed.has(p.accountId) && !mfPlaced.has(`${p.accountId}|${p.securityKey}`));
const direct = consolidate(directRows);
const directAccounts = uniq(directRows.map((p) => p.accountId));
const problems = [];
const total = r2(managedValue + direct.marketValue);
if (num(summary.totalValue) == null) problems.push('BOOK_SUMMARY.totalValue is missing');
else if (r2(total - summary.totalValue) !== 0) problems.push(`managed ${managedValue} + direct ${direct.marketValue} = ${total}, not the book's ${summary.totalValue} (residual ${r2(total - summary.totalValue)})`);
for (const e of excludedAccounts) problems.push(`account ${e.accountId} could not be placed: ${e.reason}`);
if (existsSync(SUPERSTAR_SNAPSHOT)) {
  const snap = readJson(SUPERSTAR_SNAPSHOT);
  const slugs = new Set((snap.investors || []).map((i) => i.slug));
  for (const [id, s] of Object.entries(FINOLOGY_INVESTORS)) {
    if (!out.some((m) => m.id === id)) problems.push(`FINOLOGY_INVESTORS names product ${id}, which this book does not have`);
    if (!slugs.has(s)) problems.push(`FINOLOGY_INVESTORS maps ${id} to ${s}, and ${SUPERSTAR_SNAPSHOT} carries no such investor`);
  }
} else {
  console.warn(`warning: ${SUPERSTAR_SNAPSHOT} is absent, so the Finology cross-links were not verified`);
}
for (const m of out) {
  if (m.kind === 'pms' && !m.statements.length) problems.push(`${m.name} is a PMS mandate with no holdings statement in the archive`);
}
if (problems.length) {
  console.error(`managers.json does NOT reconcile — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.value.marketValue - a.value.marketValue || a.name.localeCompare(b.name));
const byKind = {};
for (const k of Object.keys(KIND_ORDER)) {
  const ms = out.filter((m) => m.kind === k);
  byKind[k] = {
    count: ms.length,
    marketValue: r2(ms.reduce((s, m) => s + m.value.marketValue, 0)),
    positions: ms.reduce((s, m) => s + m.value.positions, 0),
    accounts: uniq(ms.flatMap((m) => m.accounts.map((a) => a.accountId))).length,
  };
}

const file = {
  _provenance:
    'THE FAMILY’S MANAGERS — every PMS mandate, alternative fund and mutual fund house the family’s wealth-platform statements show it invested with, and what each is doing. Built by scripts/build-managers.mjs from techmuns/GlowVentures: the generated book (src/data/glowData.ts) for accounts, positions, returns, commitments and corporate actions; the statement archive (public/audit) for each PMS mandate’s newest holdings statements and its dated trades; the AmfiBeas look-through (public/lookthrough) for what each mutual fund scheme holds, from the AMC’s own monthly disclosure. A move is a change in QUANTITY between two statements, never in value; a null is a figure no statement printed, never a zero; nothing here is scored.',
  source: 'techmuns/GlowVentures — src/data/glowData.ts · public/audit/*/document.json · public/lookthrough/*.json',
  builtFrom,
  asOf,
  summary: {
    bookValue: num(summary.totalValue),
    managedValue: r2(managedValue),
    managers: out.length,
    byKind,
    direct: { marketValue: direct.marketValue, positions: direct.positions, accounts: directAccounts.length },
    unresolvedSchemes: unresolvedSchemes.sort((a, b) => b.marketValue - a.marketValue),
    excludedAccounts,
    statementsKept: STATEMENTS_KEPT,
  },
  managers: out,
};

mkdirSync(dirname(OUT), { recursive: true });
// Compact, unlike book.json: this file carries ~650 statement rows, ~440 trades and ~1,400 disclosed
// fund holdings, and every visitor who opens My Managers downloads it. Pretty-printing it costs
// 40% for a diff nobody reads.
writeFileSync(OUT, `${JSON.stringify(file)}\n`);

const cr = (v) => `₹${(v / 1e7).toFixed(2)} Cr`;
console.log(
  `managers.json: ${out.length} managers — ${byKind.pms.count} PMS mandates ${cr(byKind.pms.marketValue)}, ${byKind.aif.count} alternative funds ${cr(byKind.aif.marketValue)}, ` +
    `${byKind.mf.count} fund houses ${cr(byKind.mf.marketValue)}; direct ${cr(direct.marketValue)}; the sum is the book's ${cr(summary.totalValue)} · as of ${asOf} · GlowVentures@${builtFrom || '?'} → ${OUT}`
);
for (const m of out) {
  const extra =
    m.kind === 'pms'
      ? `${m.statements.length} statements (${m.window ? `${m.window.from} → ${m.window.to}` : 'not comparable'}) · ${['new', 'added', 'trimmed', 'exited', 'held'].map((a) => `${m.moves.filter((x) => x.action === a).length} ${a}`).join(', ')} · ${m.transactions.length} trades`
      : m.kind === 'mf'
        ? `${m.lookthrough.funds.length} funds, ${m.lookthrough.funds.reduce((s, f) => s + f.plans.length, 0)} plans, ${m.lookthrough.funds.reduce((s, f) => s + f.equityCount, 0)} disclosed equity rows`
        : `${m.returns.length} return blocks · ${m.commitments.length} commitments · ${m.corporateActions.length} corporate actions${m.finologySlug ? ` · Finology: ${m.finologySlug}` : ''}`;
  console.log(`  ${m.kind.padEnd(3)} ${m.name} — ${cr(m.value.marketValue)} across ${m.accounts.length} account(s) · ${extra}`);
}
if (unresolvedSchemes.length) console.log(`  unresolved schemes: ${unresolvedSchemes.map((u) => `${u.security} (${u.reason})`).join('; ')}`);
