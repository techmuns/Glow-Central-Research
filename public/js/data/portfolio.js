// data/portfolio.js — the portfolio, marked to market from the LIVE technicals feed.
//
//   prime(portfolio, transactions)   // seeded from app.js's bootstrap fetch
//   await load()                     // joins technicals + price history; idempotent
//   positions()                      // per-position, marked to market
//   summary()                        // portfolio totals, XIRR, realised/unrealised split
//   equityCurve()                    // daily portfolio value vs benchmark, from real closes
//   book()                           // the FIFO book (js/portfolio/lots.js)
//   meta()                           // provenance for every input, and what is missing
//
// WHAT IS LIVE HERE AND WHAT IS NOT
//   Live:  the mark. Every `lastPrice` is `cmp` from technicals.json, scraped weekday mornings.
//          Every point on the equity curve is a real Yahoo close from portfolio-history.json.
//   Mock:  which shares were bought and when — the ledger. Its execution prices are real closes
//          on real trading days (see scripts/gen-mock-transactions.mjs), so the curve does not
//          step at a trade.
//
//   That split is the whole point of this module and the UI states it: an invented drawdown is
//   the one number in this dashboard nobody could check.
//
// THE TWO IDENTITIES
//   1. sum(open lot quantities) === position qty
//   2. realised + unrealised === total P&L
//   Both are asserted numerically in scripts/verify-ui.mjs. `summary().reconciliation` carries
//   the residuals so the UI can show them rather than merely claim they hold.
//
// A POSITION WITH NO LIVE PRICE IS NOT A POSITION WORTH ZERO. TATAMOTORS is absent from the
// technicals feed (Yahoo 404s the symbol) and absent from the price history for the same
// reason. It is marked AT COST, flagged `priced: false`, excluded from the equity curve, and
// named in `meta().excluded` — every surface that shows a total says how many positions are in
// that state. Marking it at zero would invent a −100% position; marking it silently at cost
// would overstate how much of the portfolio the curve covers.

import * as technicals from './technicals.js';
import { replay, dailyPositions } from '../portfolio/lots.js';

const HISTORY_PATH = 'data/portfolio-history.json';

let raw = null; // { portfolio, transactions }
let loadPromise = null;
let cache = null;

/** Seed from app.js's bootstrap fetch so this module never refetches those two files. */
export function prime(portfolio, transactions) {
  raw = {
    portfolio: portfolio || { holdings: [] },
    transactions: Array.isArray(transactions) ? transactions : transactions?.transactions || [],
  };
  cache = null;
  loadPromise = null;
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // let a later mount retry rather than wedging the workspace
    throw err;
  });
  return loadPromise;
}

// Committed static files, so `no-cache` and not `no-store`: revalidate on each load, and reuse the
// bytes already on disk when the server says they have not changed. `no-store` forbids reuse
// outright, which meant a 2MB corpus was re-downloaded in full on every single visit.
async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return res.json();
}

async function build() {
  if (!raw) throw new Error('portfolio data not primed — call prime() from app.js first');

  // The technicals feed is the mark. If it cannot be reached the workspace still works: every
  // position falls back to cost, `meta().priced` says none are marked, and the UI shows the
  // fallback banner rather than a screen of zeroes.
  let techError = null;
  await technicals.load().catch((err) => {
    techError = err;
  });

  // The price history is only needed by the Drawdown view, but it is one 260KB file and the
  // Overview wants the benchmark line too, so it loads with the rest.
  let history = null;
  let historyError = null;
  try {
    history = await fetchJson(HISTORY_PATH);
  } catch (err) {
    historyError = err;
  }

  const book = replay(raw.transactions);
  const positions = buildPositions(book, techError);
  const curve = history ? buildCurve(book, history) : null;

  cache = {
    book,
    positions,
    curve,
    meta: buildMeta({ positions, history, historyError, techError, curve }),
  };
  cache.summary = buildSummary(cache);
  return cache;
}

// ---------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------
function buildPositions(book, techError) {
  const config = new Map((raw.portfolio.holdings || []).map((h) => [String(h.ticker).toUpperCase(), h]));

  const rows = [];
  for (const [ticker, info] of book.byTicker) {
    const cfg = config.get(ticker) || {};
    const scored = techError ? null : technicals.byTicker(ticker);
    const c = scored?.company || null;

    // `cmp` is the live mark. A position with no row in the feed is marked at cost and says so
    // — see the module header for why that is not the same as marking it at zero.
    const livePrice = Number.isFinite(c?.cmp) ? c.cmp : null;
    const priced = livePrice != null && info.qty > 0;
    const lastPrice = priced ? livePrice : info.avgCost;

    const invested = info.invested;
    const marketValue = info.qty * (lastPrice ?? 0);
    const unrealised = priced ? marketValue - invested : 0;
    const high52w = Number.isFinite(c?.high_52w) ? c.high_52w : null;

    rows.push({
      ticker,
      name: cfg.name || info.realisedRows[0]?.name || ticker,
      sector: cfg.sector || c?.sector || 'Unclassified',
      convictionTier: cfg.convictionTier || (info.qty > 0 ? 'Tracking' : 'Exited'),
      qty: info.qty,
      avgPrice: info.avgCost,
      lastPrice,
      priced,
      livePrice,
      high52w,
      invested,
      marketValue: priced ? marketValue : invested,
      unrealised,
      unrealisedPct: priced && invested ? (unrealised / invested) * 100 : null,
      realised: info.realisedPnl,
      realisedShort: info.realisedShort,
      realisedLong: info.realisedLong,
      realisedRows: info.realisedRows,
      dividends: info.dividends,
      charges: info.charges,
      lots: info.lots,
      events: info.events.filter((e) => e.kind !== 'dividend'),
      isClosed: info.isClosed,
      // Total P&L is the identity the Overview reports: price move + income, net of costs
      // already folded into the basis.
      totalPnl: unrealised + info.realisedPnl + info.dividends,
      inConfig: config.has(ticker),
      scored,
    });
  }

  // Open positions by market value, then closed ones by realised P&L. A fully-exited position
  // still belongs on the page — its realised P&L is part of the record.
  rows.sort((a, b) => Number(b.qty > 0) - Number(a.qty > 0) || b.marketValue - a.marketValue || b.realised - a.realised);

  const total = rows.filter((r) => r.qty > 0).reduce((s, r) => s + r.marketValue, 0);
  for (const r of rows) r.weight = total > 0 && r.qty > 0 ? (r.marketValue / total) * 100 : 0;
  return rows;
}

// ---------------------------------------------------------------------------------------
// Equity curve — real closes, real dates.
// ---------------------------------------------------------------------------------------
function buildCurve(book, history) {
  const series = history.series || {};
  const dates = new Set();
  for (const points of Object.values(series)) for (const p of points) dates.add(p.d);
  const all = [...dates].sort();
  if (!all.length) return null;

  // Forward-fill each ticker onto the union calendar: a stock that did not trade on a day the
  // rest of the market did is worth what it was worth yesterday, not zero. Leading gaps stay
  // null — before a ticker's first close there is no price to carry, and a zero there would
  // show up as a fake drawdown on the day it starts trading.
  const priceIndex = new Map();
  for (const [ticker, points] of Object.entries(series)) {
    const known = new Map(points.map((p) => [p.d, p.c]));
    const m = new Map();
    let last = null;
    for (const d of all) {
      if (known.has(d)) last = known.get(d);
      m.set(d, last);
    }
    priceIndex.set(ticker, m);
  }

  const { qtyByDate, valuationQtyByDate, cashByDate } = dailyPositions(raw.transactions, all);

  // Which tickers the curve cannot value. Named, never silently dropped.
  const traded = new Set(raw.transactions.map((t) => String(t.ticker).toUpperCase()));
  const excluded = [...traded].filter((t) => !series[t]).sort();

  const points = [];
  for (const d of all) {
    // `valuationQtyByDate` is the holding expressed in current share terms, which is what a
    // back-adjusted close must be multiplied by. See js/portfolio/lots.js.
    const held = valuationQtyByDate.get(d) || new Map();
    let holdingsValue = 0;
    let excludedCost = 0;
    for (const [ticker, qty] of held) {
      const px = priceIndex.get(ticker)?.get(d);
      if (px == null) continue;
      holdingsValue += qty * px;
    }
    // An excluded position is carried at its running cost so the curve does not pretend the
    // money was never spent — and `coverage` below reports how much of the book that is.
    for (const [ticker, qty] of qtyByDate.get(d) || new Map()) {
      if (series[ticker]) continue;
      excludedCost += qty * (avgCostOn(book, ticker) ?? 0);
    }
    const cash = cashByDate.get(d) || 0;
    points.push({
      d,
      holdings: round2(holdingsValue),
      excludedCost: round2(excludedCost),
      cash: round2(cash),
      value: round2(holdingsValue + excludedCost + cash),
    });
  }

  // Trim the leading stretch before the first trade — a flat zero line is not information.
  const firstLive = points.findIndex((p) => p.value > 0);
  const trimmed = firstLive > 0 ? points.slice(firstLive) : points;

  const benchmark = buildBenchmark(history.benchmark, trimmed);
  const dd = drawdownSeries(trimmed, (p) => p.value);
  // A second drawdown on the equities alone. Retained cash dampens the total-portfolio figure —
  // correctly, because the cash is really there — but "how far did the stocks fall" is the
  // other question a risk view is asked, and answering only one of them invites the wrong read.
  const ddHoldings = drawdownSeries(trimmed, (p) => p.holdings + p.excludedCost);

  return {
    points: trimmed,
    benchmark,
    drawdown: dd.series,
    maxDrawdown: dd.max,
    maxDrawdownPeak: dd.peakDate,
    maxDrawdownTrough: dd.troughDate,
    recoveryDate: dd.recoveryDate,
    holdingsDrawdown: ddHoldings.series,
    maxHoldingsDrawdown: ddHoldings.max,
    maxHoldingsDrawdownPeak: ddHoldings.peakDate,
    maxHoldingsDrawdownTrough: ddHoldings.troughDate,
    benchmarkDrawdown: benchmark ? drawdownSeries(benchmark.points, (p) => p.c) : null,
    twr: timeWeightedReturn(trimmed, raw.transactions),
    excluded,
    from: trimmed[0]?.d ?? null,
    to: trimmed.at(-1)?.d ?? null,
    // How much of today's book the curve actually prices. The Drawdown view leads with this.
    coverage: coverageOf(trimmed.at(-1)),
    source: history.source || 'Yahoo Finance',
    generatedAt: history.generated_at || null,
    tradingDays: trimmed.length,
    failures: history.failures || [],
  };
}

function coverageOf(point) {
  if (!point) return null;
  const invested = point.holdings + point.excludedCost;
  return invested > 0 ? (point.holdings / invested) * 100 : 100;
}

function avgCostOn(book, ticker) {
  const info = book.byTicker.get(ticker);
  return info ? info.avgCost : null;
}

function buildBenchmark(benchmark, points) {
  if (!benchmark?.points?.length || !points.length) return null;
  const byDate = new Map(benchmark.points.map((p) => [p.d, p.c]));
  const start = points.find((p) => byDate.has(p.d));
  if (!start) return null;
  const base = byDate.get(start.d);
  let last = base;
  const out = [];
  for (const p of points) {
    const v = byDate.get(p.d);
    if (v != null) last = v;
    out.push({ d: p.d, c: last, indexed: (last / base) * 100 });
  }
  return { name: benchmark.name || 'Benchmark', symbol: benchmark.symbol, points: out, base };
}

/**
 * Drawdown from the running peak. Reported as a negative percentage, which is the convention
 * everywhere else in the dashboard — a "drawdown of 18%" that renders as +18 invites the wrong
 * reading at a glance.
 */
function drawdownSeries(points, valueOf = (p) => p.value) {
  let peak = -Infinity;
  let peakDate = null;
  let max = 0;
  let maxPeak = null;
  let maxTrough = null;
  const series = [];
  for (const p of points) {
    const v = valueOf(p);
    if (v > peak) {
      peak = v;
      peakDate = p.d;
    }
    const dd = peak > 0 ? ((v - peak) / peak) * 100 : 0;
    series.push({ d: p.d, dd, peak });
    if (dd < max) {
      max = dd;
      maxPeak = peakDate;
      maxTrough = p.d;
    }
  }
  // Recovery: the first day after the trough that gets back to the old peak. Null means it has
  // not recovered yet, which is a different statement from "recovered on day one".
  let recoveryDate = null;
  if (maxTrough) {
    const peakValue = series.find((s) => s.d === maxTrough)?.peak ?? 0;
    const after = points.findIndex((p) => p.d === maxTrough);
    for (let i = after + 1; i < points.length; i++) {
      if (valueOf(points[i]) >= peakValue) {
        recoveryDate = points[i].d;
        break;
      }
    }
  }
  return { series, max, peakDate: maxPeak, troughDate: maxTrough, recoveryDate };
}

/**
 * Time-weighted return — the only return figure that may be compared to an index.
 *
 * The raw curve rises from ₹92k to ₹42.6L, which is not a 4,500% return: most of it is money
 * paid in over three years. TWR strips contributions out by chaining daily returns and removing
 * the day's external cashflow before comparing:  r = (V_today − contributions) / V_yesterday − 1.
 *
 * Only BUYS are external here. Sale proceeds and dividends stay inside the portfolio as the cash
 * line, so they are performance, not a withdrawal — netting them out too would flatter the
 * result by hiding every realised gain.
 */
function timeWeightedReturn(points, transactions) {
  const inflow = new Map();
  for (const t of transactions) {
    if (String(t.type || '').toLowerCase() !== 'buy') continue;
    const amt = (Number(t.value) || 0) + (Number(t.charges) || 0);
    inflow.set(t.date, (inflow.get(t.date) || 0) + amt);
  }
  let factor = 1;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].value;
    if (prev <= 0) continue;
    const flow = inflow.get(points[i].d) || 0;
    const r = (points[i].value - flow) / prev;
    if (Number.isFinite(r) && r > 0) factor *= r;
  }
  const years = (new Date(`${points.at(-1).d}T00:00:00Z`) - new Date(`${points[0].d}T00:00:00Z`)) / (365 * 86400000);
  return {
    total: (factor - 1) * 100,
    annualised: years > 0 ? (factor ** (1 / years) - 1) * 100 : null,
    years,
  };
}

// ---------------------------------------------------------------------------------------
// Summary + XIRR
// ---------------------------------------------------------------------------------------
function buildSummary({ book, positions, curve }) {
  const open = positions.filter((p) => p.qty > 0);
  const invested = sum(open.map((p) => p.invested));
  const marketValue = sum(open.map((p) => p.marketValue));
  const unrealised = sum(open.map((p) => p.unrealised));
  const realised = sum(positions.map((p) => p.realised));
  const dividends = sum(positions.map((p) => p.dividends));
  const charges = sum(positions.map((p) => p.charges));
  const totalPnl = unrealised + realised + dividends;

  const unpriced = open.filter((p) => !p.priced);
  const winners = open.filter((p) => p.priced && p.unrealised > 0);

  // IDENTITY 2, computed rather than asserted in prose. `residual` is what the UI shows.
  const reconciliation = {
    realised,
    unrealised,
    dividends,
    totalPnl,
    residual: round2(totalPnl - (realised + unrealised + dividends)),
    lotsBalance: positions.every((p) => p.lots.reduce((s, l) => s + l.openQty, 0) === p.qty),
    unpricedCount: unpriced.length,
    unpricedTickers: unpriced.map((p) => p.ticker),
  };

  return {
    invested,
    marketValue,
    unrealised,
    unrealisedPct: invested ? (unrealised / invested) * 100 : 0,
    realised,
    realisedShort: sum(positions.map((p) => p.realisedShort)),
    realisedLong: sum(positions.map((p) => p.realisedLong)),
    dividends,
    charges,
    totalPnl,
    totalPnlPct: invested ? (totalPnl / invested) * 100 : 0,
    positionCount: open.length,
    closedCount: positions.filter((p) => p.isClosed).length,
    winnerCount: winners.length,
    loserCount: open.filter((p) => p.priced && p.unrealised < 0).length,
    unpricedCount: unpriced.length,
    tradeCount: raw.transactions.length,
    lotCount: sum(open.map((p) => p.lots.length)),
    // Two return figures, because they answer different questions and neither is a substitute.
    // XIRR is money-weighted — what this investor earned, contributions and timing included.
    // TWR is time-weighted — what the strategy returned, and the only one comparable to an index.
    xirr: computeXirr(book, positions),
    twr: curve?.twr ?? null,
    benchmarkReturn: curve?.benchmark ? curve.benchmark.points.at(-1).indexed - 100 : null,
    maxDrawdown: curve?.maxDrawdown ?? null,
    maxHoldingsDrawdown: curve?.maxHoldingsDrawdown ?? null,
    reconciliation,
  };
}

/**
 * Money-weighted return (XIRR) over the actual cashflows: every buy is money out, every sell
 * and dividend is money in, and today's market value is a terminal inflow.
 *
 * Newton–Raphson with a bisection fallback. Newton alone diverges on ledgers with an early
 * large outflow and is not safe to ship unguarded; when it fails to converge this returns null
 * and the UI renders "—" rather than a number produced by a diverged solver.
 */
function computeXirr(book, positions) {
  const flows = [];
  for (const t of raw.transactions) {
    const type = String(t.type || '').toLowerCase();
    const value = Number(t.value) || 0;
    const charges = Number(t.charges) || 0;
    if (type === 'buy') flows.push({ date: t.date, amount: -(value + charges) });
    else if (type === 'sell') flows.push({ date: t.date, amount: value - charges });
    else if (type === 'dividend') flows.push({ date: t.date, amount: value });
  }
  const terminal = sum(positions.filter((p) => p.qty > 0).map((p) => p.marketValue));
  const asOf = raw.portfolio.asOf || raw.transactions.at(-1)?.date;
  if (!flows.length || !asOf) return null;
  flows.push({ date: asOf, amount: terminal });

  const t0 = new Date(`${flows[0].date}T00:00:00Z`).getTime();
  const years = flows.map((f) => (new Date(`${f.date}T00:00:00Z`).getTime() - t0) / (365 * 86400000));
  const amounts = flows.map((f) => f.amount);
  const npv = (rate) => amounts.reduce((s, a, i) => s + a / (1 + rate) ** years[i], 0);

  let rate = 0.1;
  for (let i = 0; i < 60; i++) {
    const f = npv(rate);
    const d = (npv(rate + 1e-6) - f) / 1e-6;
    if (!Number.isFinite(f) || !Number.isFinite(d) || Math.abs(d) < 1e-12) break;
    const next = rate - f / d;
    if (!Number.isFinite(next) || next <= -0.999) break;
    if (Math.abs(next - rate) < 1e-9) return next * 100;
    rate = next;
  }
  // Bisection over a wide but finite bracket. If the sign does not change across it there is no
  // rate to find, and saying so beats reporting the last iterate.
  let lo = -0.95;
  let hi = 10;
  let flo = npv(lo);
  if (!Number.isFinite(flo) || flo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if (flo * fm <= 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
    if (hi - lo < 1e-9) break;
  }
  return ((lo + hi) / 2) * 100;
}

// ---------------------------------------------------------------------------------------
// Meta — every input's provenance, and what is missing.
// ---------------------------------------------------------------------------------------
function buildMeta({ positions, history, historyError, techError, curve }) {
  const techMeta = techError ? null : technicals.meta();
  const unpriced = positions.filter((p) => p.qty > 0 && !p.priced);
  return {
    asOf: raw.portfolio.asOf || null,
    basis: raw.portfolio.basis || 'FIFO',
    ledgerIsMock: true,
    marksAreLive: !techError && positions.some((p) => p.priced),
    priceSource: techError ? null : techMeta?.source || 'technicals.json',
    pricedAt: techError ? null : techMeta?.generated_at || null,
    techError: techError ? techError.message : null,
    historyError: historyError ? historyError.message : null,
    historySource: history?.source || null,
    historyGeneratedAt: history?.generated_at || null,
    historyFrom: history?.from || null,
    historyTo: history?.to || null,
    tradingDays: history?.trading_days || 0,
    // Positions the equity curve cannot value, and why. Surfaced verbatim by the Drawdown view.
    excluded: (history?.failures || []).map((f) => ({
      ticker: f.ticker,
      reason: f.reason,
      qty: positions.find((p) => p.ticker === f.ticker)?.qty ?? 0,
    })),
    unpriced: unpriced.map((p) => ({ ticker: p.ticker, qty: p.qty, markedAt: p.avgPrice })),
    coverage: curve?.coverage ?? null,
  };
}

// ---- accessors (synchronous; call load() first) ------------------------------------------
export function positions() {
  return cache ? cache.positions : [];
}
export function summary() {
  return cache ? cache.summary : null;
}
export function equityCurve() {
  return cache ? cache.curve : null;
}
export function book() {
  return cache ? cache.book : null;
}
export function meta() {
  return cache ? cache.meta : null;
}
export function isLoaded() {
  return !!cache;
}
export function transactions() {
  return raw ? raw.transactions : [];
}
export function holdingsConfig() {
  return raw ? raw.portfolio.holdings || [] : [];
}
export function byTicker(ticker) {
  if (!cache || !ticker) return null;
  const t = String(ticker).toUpperCase();
  return cache.positions.find((p) => p.ticker === t) || null;
}

/**
 * forScope('portfolio') → open positions. forScope('universe') → open plus fully-exited, since
 * the wider scope is where the closed record belongs. Filtering the cached list, never
 * recomputing — the FIFO replay runs once per page load.
 */
export function forScope(scope) {
  const rows = positions();
  return scope === 'portfolio' ? rows.filter((p) => p.qty > 0) : rows;
}

const sum = (xs) => round2(xs.reduce((s, x) => s + (Number(x) || 0), 0));
const round2 = (n) => Math.round(n * 100) / 100;
