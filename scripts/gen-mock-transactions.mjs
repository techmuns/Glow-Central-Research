#!/usr/bin/env node
// gen-mock-transactions.mjs — the ILLUSTRATIVE trade ledger behind the portfolio.
//
//   node scripts/gen-mock-transactions.mjs
//
// Writes public/data/mock/transactions.json and rewrites the derived fields of
// public/data/portfolio.json.
//
// WHAT IS REAL AND WHAT IS NOT
//   Real:      the tickers, the company names, the sectors — and every EXECUTION PRICE, which
//              is the actual Yahoo close for that ticker on that trading day (from
//              public/data/portfolio-history.json) nudged by a few basis points of slippage.
//              Trade dates are snapped to real trading days. Charges are computed with the real
//              Indian delivery-equity rate card (STT, exchange txn, GST, SEBI, stamp, DP).
//   Synthetic: which shares were bought, when, and how many. Also the dividend-per-share
//              amounts — plausible for the company, but not looked up.
//
// WHY THE PRICES ARE REAL EVEN THOUGH THE TRADES ARE NOT
//   The Drawdown view values this ledger against the same price history day by day. If a buy
//   were recorded at a price the stock never traded at, the equity curve would step at the
//   trade date — a visible artefact in a risk chart. Pricing the synthetic trades off the real
//   series keeps the curve continuous and means the only invented thing in it is position size.
//
// CORPORATE ACTIONS CANNOT BE PLACED FREELY, AND THAT IS NOT A DETAIL
//   Yahoo's `close` is BACK-ADJUSTED: the price it reports for a day in 2024 is restated in
//   today's share terms, with every split and bonus since already divided out. Two rules fall
//   out of that, and getting either wrong bends the equity curve on a day nothing happened.
//
//   1. NO ACTION ROW MAY SIT ON A TICKER PRICED FROM THE REAL SERIES.
//      Yahoo has already divided every real split and bonus out of that ticker's whole history.
//      Quantities that simply never change are therefore already in current share terms, and
//      the valuation comes out right with no help at all. Adding an action row on top would
//      double the quantity while the price series stayed put, and the curve would jump 100% on
//      a day nothing happened — in the one chart where an artefact reads as risk.
//
//      This is why HDFCBANK's average cost reads ~₹890 and not ~₹1,780. Both feeds are in
//      adjusted space (portfolio-history's last HDFCBANK close is ₹731.00; technicals.json's
//      live cmp is ₹731.90), so the basis is the post-action restated one — exactly what a
//      broker shows you after a bonus.
//
//      So BOTH corporate actions live on TATAMOTORS, the single holding Yahoo would not serve.
//      Its prices are generated here, its exclusion from the curve is recorded in
//      portfolio-history.json `failures[]` and named in the UI, and it has no live quote either
//      — so it is the one place a synthetic action cannot contradict a measured number.
//      Contrived? A little. The alternative is a risk chart with an invented step in it.
//
//      An earlier draft mirrored a "real" CDSL 1:1 bonus here. Checking the series rather than
//      trusting the recollection killed it: CDSL closes ₹1,718 → ₹1,948 across the supposed
//      ex-date with no step and no restatement, so no such action is in this window. Had it
//      shipped, CDSL would have been counted twice.
//
//   2. WHERE AN ACTION ROW DOES EXIST, THE TRADE PRICE IS THE PRE-ACTION ONE.
//      A ledger records what was actually paid. TATAMOTORS's synthetic walk is generated in
//      pre-action terms and divided by the ratios applied so far, so the path steps down at the
//      bonus and again at the split the way a quoted price does: ~₹700 in 2023, ~₹375 after the
//      1:1, ~₹190 after the 1:2. `ratioAfter()` below applies the same un-adjustment to any
//      real-series ticker that ever acquires an action row, so the rule survives the mock data.
//
//   `dailyPositions()` in js/portfolio/lots.js carries the matching half: for valuation it
//   expresses a historical holding in current share terms, multiplying by every ratio still
//   ahead of that date. Against a back-adjusted series the two corrections cancel exactly.
//
// EVERY CODE PATH IS EXERCISED ON PURPOSE
//   partial sells (9 tickers) · a full exit that is never re-entered (ASIANPAINT) · an exit
//   followed by a re-entry (PERSISTENT) · dividends, including ones correctly skipped while the
//   position was flat · one bonus · one split · three financial years.
//
// PORTFOLIO.JSON IS DERIVED FROM THIS FILE, NOT THE OTHER WAY AROUND. `qty` and `avgPrice` are
// whatever the FIFO replay produces, so `sum of open lots === holdings[].qty` holds by
// construction rather than by luck. The placeholder `lastPrice` / `high52w` are dropped — those
// are marked to market from the live technicals feed now.
//
// Determinism: mulberry32, same as the other generators. Same seed, byte-identical output.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replay } from '../public/js/portfolio/lots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, '../public/data/portfolio-history.json');
const PORTFOLIO_PATH = resolve(__dirname, '../public/data/portfolio.json');
const OUT_PATH = resolve(__dirname, '../public/data/mock/transactions.json');

const SEED = 20260811;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------
// The plans. Quantities are chosen so the FIFO end state lands exactly on `target`; the script
// asserts it and exits non-zero if a plan drifts, so an edit here cannot silently break the
// reconciliation the Overview depends on.
// ---------------------------------------------------------------------------------------
const B = (date, qty) => ({ date, type: 'Buy', qty });
const S = (date, qty) => ({ date, type: 'Sell', qty });
const CA = (date, type, ratio) => ({ date, type, ratio });

const PLANS = [
  {
    ticker: 'HDFCBANK', name: 'HDFC Bank Ltd', sector: 'Financials', tier: 'Core', target: 300,
    trades: [B('2023-09-12', 80), B('2024-02-20', 60), B('2024-07-30', 40), B('2024-11-14', 50), S('2025-04-08', 30), B('2025-06-10', 70), B('2025-10-21', 80), S('2026-01-22', 50)],
    dividends: [['2024-06-20', 19.5], ['2025-06-19', 22], ['2026-06-18', 24]],
  },
  {
    ticker: 'ICICIBANK', name: 'ICICI Bank Ltd', sector: 'Financials', tier: 'Core', target: 250,
    trades: [B('2023-10-17', 100), B('2024-06-25', 60), B('2024-12-10', 40), S('2025-02-04', 25), B('2025-03-11', 70), B('2025-09-09', 45), S('2025-11-18', 40)],
    dividends: [['2024-08-12', 10], ['2025-08-11', 11], ['2026-08-06', 12]],
  },
  {
    ticker: 'INFY', name: 'Infosys Ltd', sector: 'IT', tier: 'Core', target: 180,
    trades: [B('2023-11-07', 70), B('2024-04-18', 40), B('2024-08-06', 50), S('2024-12-19', 30), B('2025-05-20', 60), B('2025-08-26', 30), S('2026-02-17', 40)],
    dividends: [['2023-11-13', 18], ['2024-06-05', 20], ['2024-11-12', 18], ['2025-06-04', 21], ['2025-11-11', 19], ['2026-06-03', 22]],
  },
  {
    ticker: 'BHARTIARTL', name: 'Bharti Airtel Ltd', sector: 'Telecom', tier: 'High Conviction', target: 200,
    trades: [B('2023-12-05', 90), B('2024-05-21', 50), B('2024-09-17', 40), B('2025-07-01', 45), S('2026-03-17', 25)],
    dividends: [['2024-08-21', 8], ['2025-08-19', 16], ['2026-08-04', 18]],
  },
  {
    ticker: 'LT', name: 'Larsen & Toubro Ltd', sector: 'Industrials', tier: 'Core', target: 60,
    trades: [B('2024-01-16', 25), B('2024-08-13', 15), B('2025-01-28', 20), B('2025-11-25', 10), S('2026-06-09', 10)],
    dividends: [['2024-06-26', 28], ['2025-06-24', 34], ['2026-06-23', 36]],
  },
  {
    ticker: 'BAJFINANCE', name: 'Bajaj Finance Ltd', sector: 'Financials', tier: 'High Conviction', target: 40,
    trades: [B('2024-03-12', 18), B('2024-10-15', 10), B('2025-07-15', 14), S('2026-03-10', 2)],
    dividends: [['2024-07-30', 36], ['2025-07-29', 44]],
  },
  {
    ticker: 'TITAN', name: 'Titan Company Ltd', sector: 'Consumer Discretionary', tier: 'High Conviction', target: 70,
    trades: [B('2023-08-22', 30), B('2024-03-26', 20), B('2024-10-08', 25), S('2025-09-16', 15), B('2026-01-13', 10)],
    dividends: [['2024-07-16', 11], ['2025-07-15', 11], ['2026-07-14', 12]],
  },
  {
    ticker: 'ULTRACEMCO', name: 'UltraTech Cement Ltd', sector: 'Materials', tier: 'Core', target: 25,
    trades: [B('2024-04-23', 10), B('2024-11-19', 8), B('2025-08-12', 9), S('2026-05-05', 2)],
    dividends: [['2024-07-23', 70], ['2025-07-22', 77], ['2026-07-21', 80]],
  },
  {
    // The one holding with no price series, so the only one where a synthetic corporate action
    // cannot contradict a measured number. Both actions live here: a 1:1 bonus and a 1:2 split.
    // The 2025 dividend is ₹1.50 against the 2024 ₹6.00 — a quarter, because four times as many
    // shares now exist. A per-share amount that survived a 4× unchanged would be the tell.
    ticker: 'TATAMOTORS', name: 'Tata Motors Ltd', sector: 'Auto', tier: 'Tracking', target: 400,
    trades: [B('2023-09-26', 60), B('2024-01-23', 30), B('2024-05-14', 20), CA('2024-08-06', 'Bonus', 2), S('2024-12-17', 70), CA('2025-02-11', 'Split', 2), B('2025-10-07', 60), B('2026-02-24', 40)],
    dividends: [['2024-07-09', 6], ['2025-07-08', 1.5], ['2026-07-07', 1.6]],
    // Band is in PRE-action terms — ~₹700 in 2023, which is where Tata Motors actually traded.
    // The walk is divided by the ratios applied so far, so it steps at each action.
    syntheticPrice: { from: 700, to: 810, vol: 0.09 },
  },
  {
    ticker: 'DIVISLAB', name: "Divi's Laboratories Ltd", sector: 'Healthcare', tier: 'High Conviction', target: 45,
    trades: [B('2024-02-06', 20), B('2024-09-03', 12), B('2025-04-15', 18), S('2026-04-21', 5)],
    dividends: [['2024-07-02', 30], ['2025-07-01', 30]],
  },
  {
    // Full exit in Jan 2025, flat for ten months, re-entered Dec 2025. The two dividends that
    // fall inside the flat stretch are dropped by the generator, not by hand.
    ticker: 'PERSISTENT', name: 'Persistent Systems Ltd', sector: 'IT', tier: 'Tracking', target: 55,
    trades: [B('2023-10-03', 25), B('2024-02-13', 15), B('2024-07-09', 20), S('2024-11-26', 20), S('2025-01-14', 40), B('2025-12-02', 35), B('2026-06-16', 20)],
    dividends: [['2024-05-07', 20], ['2024-11-05', 20], ['2025-05-06', 20], ['2025-11-04', 20], ['2026-05-05', 22]],
  },
  {
    // No corporate action, deliberately — its prices come from the real series. See rule 1.
    ticker: 'CDSL', name: 'Central Depository Services Ltd', sector: 'Financials', tier: 'Tracking', target: 150,
    trades: [B('2024-03-19', 40), B('2024-08-27', 25), B('2025-06-24', 55), B('2026-02-03', 45), S('2026-05-19', 15)],
    dividends: [['2024-07-24', 19], ['2025-07-23', 21], ['2026-07-22', 23]],
  },
  {
    // Never appears in portfolio.json — it is the fully-exited position, and the point is that
    // the Overview still shows its realised P&L.
    ticker: 'ASIANPAINT', name: 'Asian Paints Ltd', sector: 'Materials', tier: 'Exited', target: 0,
    trades: [B('2023-08-29', 50), B('2024-04-09', 30), B('2024-09-24', 20), S('2025-02-25', 40), S('2025-08-20', 60)],
    dividends: [['2024-06-27', 28], ['2025-06-26', 20]],
  },
];

// ---------------------------------------------------------------------------------------
// Charges — the real Indian delivery-equity rate card. Discount brokers charge zero brokerage
// on delivery, so what is left is statutory, and it is not negligible: it moves the cost basis
// by roughly 12 bps a round trip, which is why lots.js folds buy charges INTO the basis rather
// than reporting a cost that was never actually paid.
// ---------------------------------------------------------------------------------------
function chargesFor(side, turnover) {
  const stt = turnover * 0.001; // 0.1% both sides, delivery
  const txn = turnover * 0.0000297; // NSE exchange transaction charge
  const sebi = turnover * 0.000001;
  const stamp = side === 'buy' ? turnover * 0.00015 : 0; // buyer pays stamp duty
  const dp = side === 'sell' ? 15.93 : 0; // CDSL debit charge, per scrip per day
  const gst = (txn + sebi + dp) * 0.18;
  return round2(stt + txn + sebi + stamp + dp + gst);
}

// ---------------------------------------------------------------------------------------
// Price lookup: the actual close on the last trading day at or before the requested date.
// ---------------------------------------------------------------------------------------
const history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
const seriesIndex = new Map();
for (const [ticker, points] of Object.entries(history.series)) {
  const map = new Map();
  for (const p of points) map.set(p.d, p.c);
  seriesIndex.set(ticker, { map, dates: points.map((p) => p.d) });
}

function priceOn(ticker, date) {
  const s = seriesIndex.get(ticker);
  if (!s) return null;
  if (s.map.has(date)) return { close: s.map.get(date), tradeDate: date };
  // Walk back to the last trading day — a planned date can land on a weekend or a holiday.
  let lo = 0;
  let hi = s.dates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.dates[mid] <= date) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  return { close: s.map.get(s.dates[best]), tradeDate: s.dates[best] };
}

// Corporate actions this ledger carries, per ticker. Two uses: un-adjusting Yahoo's series back
// to what was actually paid, and stepping the synthetic path at its split.
const actionsOf = (plan) => plan.trades.filter((t) => t.type === 'Bonus' || t.type === 'Split');
// Ratios still AHEAD of `date` — divide the adjusted close by this to recover the traded price.
const ratioAfter = (plan, date) => actionsOf(plan).reduce((f, a) => (a.date > date ? f * a.ratio : f), 1);
const totalRatio = (plan) => actionsOf(plan).reduce((f, a) => f * a.ratio, 1);

// TATAMOTORS has no series. A seeded geometric walk over the window gives it plausible
// execution prices; the file records that they are invented, and the curve excludes it.
//
// The walk is written in PRE-action terms (the band is where the stock actually traded in 2023)
// and stored divided by the total ratio, i.e. in the same back-adjusted space Yahoo uses. That
// way there is ONE pricing path: every trade price, real series or synthetic, is
// `storedClose × ratioAfter(date)`. The step at each action falls out instead of being drawn in.
function syntheticPrices(plan) {
  const dates = history.series[Object.keys(history.series)[0]].map((p) => p.d);
  const { from, to, vol } = plan.syntheticPrice;
  const drift = Math.log(to / from) / dates.length;
  const total = totalRatio(plan);
  const out = new Map();
  let px = from;
  for (const d of dates) {
    px *= Math.exp(drift + (rng() - 0.5) * vol * 0.12);
    out.set(d, round2(px / total));
  }
  return { map: out, dates };
}

// ---------------------------------------------------------------------------------------
// Build the ledger.
// ---------------------------------------------------------------------------------------
const rows = [];
const notes = [];
let seq = 0;
const nextId = () => `t-${String(++seq).padStart(3, '0')}`;

for (const plan of PLANS) {
  if (plan.syntheticPrice) {
    const synth = syntheticPrices(plan);
    seriesIndex.set(plan.ticker, { map: synth.map, dates: synth.dates });
    notes.push(`${plan.ticker}: execution prices are synthetic — Yahoo does not serve this symbol (see portfolio-history.json failures[]).`);
  }

  // Dividends need the quantity held on the pay date, so interleave everything in date order
  // and track the running quantity as we go.
  const timeline = [
    ...plan.trades.map((t) => ({ ...t, kind: 'trade' })),
    ...plan.dividends.map(([date, dps]) => ({ date, type: 'Dividend', dps, kind: 'dividend' })),
  ].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'trade' ? -1 : 1));

  let qty = 0;
  for (const ev of timeline) {
    if (ev.kind === 'dividend') {
      // Missing input is not zero: no shares on the record date means no dividend row at all,
      // not a row of zeroes. PERSISTENT loses two this way and that is correct.
      if (qty <= 0) continue;
      const value = round2(qty * ev.dps);
      rows.push({ id: nextId(), date: ev.date, ticker: plan.ticker, name: plan.name, type: 'Dividend', qty, price: ev.dps, value, charges: 0 });
      continue;
    }

    if (ev.type === 'Bonus' || ev.type === 'Split') {
      const added = Math.round(qty * ev.ratio) - qty;
      rows.push({ id: nextId(), date: ev.date, ticker: plan.ticker, name: plan.name, type: ev.type, qty: added, price: 0, value: 0, charges: 0, ratio: ev.ratio });
      qty = Math.round(qty * ev.ratio);
      continue;
    }

    const side = ev.type.toLowerCase();
    const found = priceOn(plan.ticker, ev.date);
    if (!found) throw new Error(`no price for ${plan.ticker} on ${ev.date}`);
    // A few bps of slippage so the ledger does not read as "every fill was exactly the close".
    const slip = 1 + (rng() - 0.5) * 0.007;
    // Un-adjust: Yahoo's close is restated in today's share terms, and a ledger records what was
    // actually paid. Only matters for the ticker carrying a bonus; everywhere else this is 1.
    const price = round2(found.close * ratioAfter(plan, found.tradeDate) * slip);
    const value = round2(ev.qty * price);
    rows.push({
      id: nextId(),
      date: found.tradeDate,
      ticker: plan.ticker,
      name: plan.name,
      type: ev.type,
      qty: ev.qty,
      price,
      value,
      charges: chargesFor(side, value),
    });
    qty += side === 'buy' ? ev.qty : -ev.qty;
    if (qty < 0) throw new Error(`${plan.ticker}: plan sells more than it holds on ${ev.date}`);
  }

  if (qty !== plan.target) throw new Error(`${plan.ticker}: plan ends at ${qty}, target is ${plan.target}`);
}

// Re-sort into a single chronological ledger and renumber, so ids run in date order.
rows.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker) || a.type.localeCompare(b.type));
rows.forEach((r, i) => {
  r.id = `t-${String(i + 1).padStart(3, '0')}`;
});

// ---------------------------------------------------------------------------------------
// Replay through the real engine and assert the identity the whole workspace rests on.
// ---------------------------------------------------------------------------------------
const book = replay(rows);
if (book.errors.length) {
  console.error('Replay produced errors:', book.errors);
  process.exit(1);
}

const failures = [];
for (const plan of PLANS) {
  const info = book.byTicker.get(plan.ticker);
  const qty = info ? info.qty : 0;
  const lotSum = info ? info.lots.reduce((s, l) => s + l.openQty, 0) : 0;
  if (qty !== plan.target) failures.push(`${plan.ticker}: replay qty ${qty} !== target ${plan.target}`);
  if (lotSum !== qty) failures.push(`${plan.ticker}: open lots ${lotSum} !== qty ${qty}`);
}
if (failures.length) {
  console.error('RECONCILIATION FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}

// ---------------------------------------------------------------------------------------
// Write the ledger, then rewrite portfolio.json's derived fields from the replay.
// ---------------------------------------------------------------------------------------
writeFileSync(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);

const portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, 'utf8'));
const planByTicker = new Map(PLANS.map((p) => [p.ticker, p]));
const holdings = portfolio.holdings.map((h) => {
  const info = book.byTicker.get(h.ticker);
  const plan = planByTicker.get(h.ticker);
  if (!info) throw new Error(`${h.ticker} is in portfolio.json but has no transactions`);
  return {
    ticker: h.ticker,
    name: h.name,
    qty: info.qty,
    // Derived, not asserted: the FIFO cost of the lots still open, charges included.
    avgPrice: info.avgCost,
    sector: h.sector ?? plan?.sector ?? null,
    convictionTier: h.convictionTier ?? plan?.tier ?? 'Tracking',
  };
});
for (const plan of PLANS) {
  if (plan.target > 0 && !holdings.some((h) => h.ticker === plan.ticker)) {
    throw new Error(`${plan.ticker} ends with ${plan.target} shares but is not in portfolio.json`);
  }
}

writeFileSync(
  PORTFOLIO_PATH,
  `${JSON.stringify(
    {
      _provenance:
        'Holdings list (tickers, names, sectors, conviction tiers) is user config. `qty` and `avgPrice` are DERIVED ' +
        'from the FIFO replay of mock/transactions.json — never edit them by hand, run scripts/gen-mock-transactions.mjs. ' +
        'There is deliberately no lastPrice or high52w here: those are marked to market from the live technicals feed.',
      asOf: rows.at(-1).date,
      basis: 'FIFO, charges folded into cost',
      holdings,
    },
    null,
    2
  )}\n`
);

// ---------------------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------------------
const byType = rows.reduce((m, r) => ((m[r.type] = (m[r.type] || 0) + 1), m), {});
const realisedTotal = round2(book.realised.reduce((s, r) => s + r.pnl, 0));
const dividendTotal = round2([...book.dividends.values()].reduce((s, v) => s + v, 0));
const chargeTotal = round2([...book.charges.values()].reduce((s, v) => s + v, 0));
const invested = round2([...book.byTicker.values()].reduce((s, t) => s + t.invested, 0));

console.log(`Wrote ${rows.length} transactions  ${rows[0].date} → ${rows.at(-1).date}`);
console.log(`  ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`  ${book.byTicker.size} tickers, ${[...book.byTicker.values()].filter((t) => t.isClosed).length} fully exited`);
console.log(`  Realised P&L  ₹${realisedTotal.toLocaleString('en-IN')}  (${book.realised.length} lot matches: ${book.realised.filter((r) => r.term === 'long').length} long, ${book.realised.filter((r) => r.term === 'short').length} short)`);
console.log(`  Dividends     ₹${dividendTotal.toLocaleString('en-IN')}`);
console.log(`  Charges       ₹${chargeTotal.toLocaleString('en-IN')}`);
console.log(`  Open cost     ₹${invested.toLocaleString('en-IN')} across ${[...book.byTicker.values()].filter((t) => t.qty > 0).length} open positions`);
console.log('\nReconciliation: sum(open lots) === qty for every ticker  ✓');
console.log(`\nWrote ${OUT_PATH}`);
console.log(`Rewrote ${PORTFOLIO_PATH} (qty + avgPrice derived; lastPrice/high52w removed)`);
if (notes.length) console.log(`\nNotes:\n  ${notes.join('\n  ')}`);
