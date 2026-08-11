// portfolio/lots.js — FIFO lot matching.
//
// Replays a transaction ledger in date order and maintains open lots per ticker. A sell
// consumes the oldest lots first, producing a realised-P&L record carrying the buy date, the
// sell date, the holding period and whether the gain is short or long term.
//
//   const book = replay(transactions);
//   book.openLots.get('INFY')   // [{ date, qty, costPerShare, ... }] oldest first
//   book.realised               // [{ ticker, buyDate, sellDate, qty, ..., term }]
//   book.byTicker.get('INFY')   // { qty, invested, avgCost, realisedPnl, lots, events }
//
// THE RECONCILIATION IS THE POINT. Two identities must hold exactly, and the verification
// suite asserts both numerically:
//
//   1. sum of open lot quantities  ===  current quantity held
//   2. realised P&L + unrealised P&L  ===  total P&L
//
// If either drifts, the position table and the ledger are telling different stories about the
// same money, and neither can be trusted.
//
// CORPORATE ACTIONS ADJUST LOTS, THEY DO NOT CREATE TRANSACTIONS. A 1:1 bonus doubles every
// open lot's quantity and halves its cost per share; a 1:5 split multiplies quantity by 5 and
// divides cost by 5. Inventing a zero-price "buy" for the bonus shares would corrupt both the
// average cost and the holding-period clock — bonus shares inherit the original lot's
// acquisition date for tax purposes, which is exactly what adjusting in place preserves.

const LONG_TERM_DAYS = 365; // listed equity in India: >12 months is long term

const round2 = (n) => Math.round(n * 100) / 100;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/**
 * Replay the whole ledger.
 *
 * @param {Array} transactions rows shaped as documented in DATA-CONTRACTS.md
 * @returns {{ openLots: Map, realised: Array, byTicker: Map, events: Array, errors: Array }}
 */
export function replay(transactions = []) {
  // Sort by date, then by a stable tiebreak. Two trades on one day must resolve in ledger
  // order, not in whatever order the array happened to arrive in — a buy and a sell on the
  // same date produce different realised P&L depending on which is applied first.
  const rows = [...transactions].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));

  const openLots = new Map(); // ticker -> [{ lotId, date, qty, costPerShare, charges }]
  const realised = [];
  const events = []; // corporate actions, for the ledger's "what happened" column
  const errors = []; // rows that could not be applied, kept rather than silently dropped
  const dividends = new Map(); // ticker -> total received
  const charges = new Map(); // ticker -> total brokerage/taxes paid

  const lotsFor = (ticker) => {
    if (!openLots.has(ticker)) openLots.set(ticker, []);
    return openLots.get(ticker);
  };
  const addCharge = (ticker, amount) => charges.set(ticker, round2((charges.get(ticker) || 0) + (amount || 0)));

  for (const t of rows) {
    const ticker = String(t.ticker || '').toUpperCase();
    if (!ticker) {
      errors.push({ row: t, reason: 'no ticker' });
      continue;
    }
    const type = String(t.type || '').toLowerCase();
    const qty = Number(t.qty) || 0;
    const price = Number(t.price) || 0;
    const chg = Number(t.charges) || 0;

    if (type === 'buy') {
      // Charges on a buy are part of the cost basis.
      const costPerShare = qty > 0 ? (qty * price + chg) / qty : price;
      lotsFor(ticker).push({ lotId: t.id, date: t.date, qty, costPerShare: round2(costPerShare), openQty: qty, charges: chg });
      addCharge(ticker, chg);
      continue;
    }

    if (type === 'sell') {
      const lots = lotsFor(ticker);
      const held = lots.reduce((s, l) => s + l.openQty, 0);
      if (qty > held) {
        // A sell bigger than the holding is a broken ledger, not something to paper over.
        errors.push({ row: t, reason: `sell of ${qty} exceeds ${held} held` });
        continue;
      }
      let remaining = qty;
      // Charges on a sell reduce the proceeds, apportioned across the consumed lots.
      const chargePerShare = qty > 0 ? chg / qty : 0;

      while (remaining > 0) {
        const lot = lots.find((l) => l.openQty > 0);
        if (!lot) break;
        const take = Math.min(lot.openQty, remaining);
        const proceeds = take * price - take * chargePerShare;
        const cost = take * lot.costPerShare;
        const heldDays = daysBetween(lot.date, t.date);
        realised.push({
          ticker,
          name: t.name || ticker,
          sellId: t.id,
          buyLotId: lot.lotId,
          buyDate: lot.date,
          sellDate: t.date,
          qty: take,
          buyPrice: lot.costPerShare,
          sellPrice: price,
          cost: round2(cost),
          proceeds: round2(proceeds),
          pnl: round2(proceeds - cost),
          pnlPct: cost > 0 ? round2(((proceeds - cost) / cost) * 100) : null,
          heldDays,
          term: heldDays > LONG_TERM_DAYS ? 'long' : 'short',
        });
        lot.openQty -= take;
        remaining -= take;
      }
      // Fully consumed lots are dropped only after matching, so the records above keep their
      // original acquisition dates.
      openLots.set(
        ticker,
        lots.filter((l) => l.openQty > 0)
      );
      addCharge(ticker, chg);
      continue;
    }

    if (type === 'dividend') {
      // Dividends are income, not a change in cost basis. Tracked separately so the position's
      // P&L stays a price story and the total return can add them back explicitly.
      const amount = Number(t.value) || qty * price;
      dividends.set(ticker, round2((dividends.get(ticker) || 0) + amount));
      events.push({ ...t, ticker, kind: 'dividend', amount: round2(amount) });
      continue;
    }

    if (type === 'bonus' || type === 'split') {
      const lots = lotsFor(ticker);
      // `ratio` is the multiplier applied to quantity: 2 for a 1:1 bonus, 5 for a 1:5 split.
      const ratio = Number(t.ratio) || 1;
      if (ratio <= 0 || !lots.length) {
        errors.push({ row: t, reason: ratio <= 0 ? 'bad ratio' : 'no open lots to adjust' });
        continue;
      }
      const before = lots.reduce((s, l) => s + l.openQty, 0);
      for (const lot of lots) {
        lot.openQty = Math.round(lot.openQty * ratio);
        lot.qty = Math.round(lot.qty * ratio);
        // Total cost is unchanged — more shares, each cheaper. This is what keeps the
        // reconciliation exact, and what keeps the original acquisition date attached.
        lot.costPerShare = round2(lot.costPerShare / ratio);
      }
      const after = lots.reduce((s, l) => s + l.openQty, 0);
      events.push({ ...t, ticker, kind: type, ratio, qtyBefore: before, qtyAfter: after, lotsAdjusted: lots.length });
      continue;
    }

    errors.push({ row: t, reason: `unknown type "${t.type}"` });
  }

  // ---- per-ticker summary -------------------------------------------------------------
  const byTicker = new Map();
  const tickers = new Set([...openLots.keys(), ...realised.map((r) => r.ticker), ...dividends.keys()]);
  for (const ticker of tickers) {
    const lots = (openLots.get(ticker) || []).filter((l) => l.openQty > 0);
    const qty = lots.reduce((s, l) => s + l.openQty, 0);
    const invested = round2(lots.reduce((s, l) => s + l.openQty * l.costPerShare, 0));
    const rows_ = realised.filter((r) => r.ticker === ticker);
    byTicker.set(ticker, {
      ticker,
      qty,
      invested,
      avgCost: qty > 0 ? round2(invested / qty) : null,
      lots,
      realisedPnl: round2(rows_.reduce((s, r) => s + r.pnl, 0)),
      realisedShort: round2(rows_.filter((r) => r.term === 'short').reduce((s, r) => s + r.pnl, 0)),
      realisedLong: round2(rows_.filter((r) => r.term === 'long').reduce((s, r) => s + r.pnl, 0)),
      realisedRows: rows_,
      dividends: dividends.get(ticker) || 0,
      charges: charges.get(ticker) || 0,
      events: events.filter((e) => e.ticker === ticker),
      // A ticker with realised rows and no open lots was fully exited at some point. It may
      // have been re-entered since, which is why this is derived from the lots and not a flag.
      isClosed: qty === 0 && rows_.length > 0,
    });
  }

  return { openLots, realised, byTicker, events, errors, dividends, charges };
}

/**
 * Which lots a given sell transaction consumed — the FIFO working, for the ledger's expand row.
 */
export function lotsConsumedBy(book, sellId) {
  return book.realised.filter((r) => r.sellId === sellId);
}

/**
 * Quantity held of `ticker` on `onDate`, replaying only the rows up to that date.
 * Used to build the equity curve: every trading day needs the quantity held that day.
 *
 * Returns a Map of ticker -> qty, so one pass serves every ticker on that date.
 */
export function quantitiesOn(transactions, onDate) {
  const upto = transactions.filter((t) => String(t.date) <= onDate);
  const book = replay(upto);
  const out = new Map();
  for (const [ticker, info] of book.byTicker) if (info.qty > 0) out.set(ticker, info.qty);
  return out;
}

/**
 * The full daily quantity timeline in ONE pass, rather than replaying the whole ledger per
 * trading day. With 741 days and a 120-row ledger the naive version is ~90,000 row-applications
 * per render; this is one.
 *
 * Returns `{ dates, qtyByDate, valuationQtyByDate, cashByDate }`, where `qtyByDate` is the
 * shares actually held that day and `cashByDate` accumulates sale proceeds and dividends and is
 * never reinvested — holding it as a cash line is what keeps the curve honest about what the
 * portfolio actually did.
 *
 * WHY THERE ARE TWO QUANTITIES, AND WHY IT IS NOT PEDANTRY
 *   Yahoo back-adjusts its close series for splits and bonuses: the price it reports for a day
 *   in 2024 is restated in today's share terms. Multiplying a 2024 close by the shares actually
 *   held in 2024 therefore understates that position by the ratio of every action since. A 1:1
 *   bonus would halve the whole pre-bonus stretch of the equity curve — a step change on a day
 *   nothing happened, in the one chart where an artefact reads as risk.
 *
 *   `valuationQtyByDate` is the correct counterpart to an adjusted series: the holding expressed
 *   in CURRENT share terms, i.e. multiplied by every corporate-action ratio still ahead of it.
 *   Value it against the adjusted close and the curve is continuous through the action, which is
 *   what actually happened to the money.
 *
 *   The corollary binds the data too: a ledger may only carry action rows for actions the price
 *   series was adjusted for. An invented split on a real ticker breaks the correction in the
 *   other direction. See scripts/gen-mock-transactions.mjs.
 */
export function dailyPositions(transactions, dates) {
  const rows = [...transactions].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const qtyByDate = new Map();
  const valuationQtyByDate = new Map();
  const cashByDate = new Map();

  // Total corporate-action multiplier per ticker across the whole ledger. Dividing out the part
  // already applied leaves exactly the part still ahead — the factor that puts a historical
  // holding into current share terms.
  const totalRatio = new Map();
  for (const t of rows) {
    const type = String(t.type || '').toLowerCase();
    if (type !== 'bonus' && type !== 'split') continue;
    const ticker = String(t.ticker || '').toUpperCase();
    totalRatio.set(ticker, (totalRatio.get(ticker) || 1) * (Number(t.ratio) || 1));
  }

  const held = new Map(); // ticker -> qty
  const applied = new Map(); // ticker -> product of ratios applied so far
  let cash = 0;
  let i = 0;

  for (const d of dates) {
    while (i < rows.length && String(rows[i].date) <= d) {
      const t = rows[i++];
      const ticker = String(t.ticker || '').toUpperCase();
      const type = String(t.type || '').toLowerCase();
      const qty = Number(t.qty) || 0;
      const price = Number(t.price) || 0;
      const chg = Number(t.charges) || 0;

      if (type === 'buy') held.set(ticker, (held.get(ticker) || 0) + qty);
      else if (type === 'sell') {
        held.set(ticker, Math.max(0, (held.get(ticker) || 0) - qty));
        cash += qty * price - chg;
      } else if (type === 'dividend') cash += Number(t.value) || qty * price;
      else if (type === 'bonus' || type === 'split') {
        const ratio = Number(t.ratio) || 1;
        if (held.get(ticker)) held.set(ticker, Math.round(held.get(ticker) * ratio));
        applied.set(ticker, (applied.get(ticker) || 1) * ratio);
      }
    }
    const open = [...held].filter(([, q]) => q > 0);
    qtyByDate.set(d, new Map(open));
    valuationQtyByDate.set(
      d,
      new Map(open.map(([ticker, q]) => [ticker, q * ((totalRatio.get(ticker) || 1) / (applied.get(ticker) || 1))]))
    );
    cashByDate.set(d, round2(cash));
  }
  return { dates, qtyByDate, valuationQtyByDate, cashByDate };
}

export { LONG_TERM_DAYS };
