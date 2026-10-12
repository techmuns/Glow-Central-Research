// data/research-sheets.js — THE ROWS OF THE PORTFOLIO AND WATCHLIST TABS. GLOW-OWNED.
//
// Each row joins three things and keeps them visibly apart:
//
//   THE STATEMENTS'   what the family's book (data/book.js) says is held — quantity, cost, the date
//                     the oldest unit was bought where a lot register prints it. These are DEFAULTS:
//                     a depository statement does not know what shares cost, so most of them are
//                     empty, and the desk types the rest.
//   THE DESK'S        whatever has been typed into a cell (core/research-sheet.js), which always
//                     wins over a default and says who typed it.
//   THE MARKET'S      price, market cap, returns (data/sheet-market.js) — never typed, never stored.
//
// WHICH HOLDINGS ARE "PUBLIC DIRECT". The family's listed equity held OUTSIDE every PMS mandate:
// book rows whose asset class is Equity and whose engagement is not PMS (today: the ICICI and
// Motilal Oswal demat accounts and the LKP execution account), less the lines the book marks as not
// listed (warrants and preference shares). A PMS manager decides its own trades, so a target or an
// intrinsic value set here would describe nothing the desk does — and the desk asked for the weight
// to exclude PMS, which only holds if the rows do. Holdings added by hand join them, for a purchase
// made after the latest statement.
//
// EVERY DERIVED FIGURE SAYS HOW IT WAS REACHED, in a `title` the cell prints on hover, and every
// figure that cannot be reached is null with the missing input named — "needs Date bought" — never
// a zero that would read as a measured result.

import * as book from './book.js';
import * as coverage from './coverage.js';
import * as watchlist from '../core/watchlist.js';
import * as sheet from '../core/research-sheet.js';
import * as market from './sheet-market.js';
import { isinKey } from './research-sheet-shared.js';
import {
  istToday, splitFactorAfter, dividendsReceived, xirr, daysBetween, pctChange, formatSheetDate,
} from './sheet-math.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct1 = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const cr2 = (v) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Cr`;
const rupees = (v) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * One editable cell: the typed value if there is one, else its default. `edited` and `pending`
 * travel so the cell can say which it is showing, and `fallbackLabel` says where a default came from.
 */
function cell(key, field, fallback = null, fallbackLabel = '') {
  const entry = sheet.entry(key, field);
  if (entry) return { field, value: entry.value, edited: true, pending: !!entry.pending, entry, fallback, fallbackLabel };
  return { field, value: fallback ?? null, edited: false, pending: false, entry: null, fallback: fallback ?? null, fallbackLabel };
}

/** A derived (read-only) figure with the sentence that explains it. */
const derived = (value, title, extra = {}) => ({ value: num(value), title, ...extra });

function sectorCell(key, ticker, fallbackText = null) {
  const found = market.sector(ticker);
  const value = found?.value || (fallbackText && fallbackText !== 'Unclassified' ? fallbackText : null);
  return cell(key, 'sector', value, found?.source || (value ? "The family's statements" : ''));
}

// ---- the book's public-direct holdings ---------------------------------------------------------

/**
 * The public-direct holdings, one per company. Each carries the statement figures and their dates;
 * nothing here is priced.
 */
export function bookHoldings() {
  // WHETHER A LINE IS LISTED EQUITY is read from the committed company file (`baseHoldings()`),
  // which `scripts/build-book.mjs` writes in the same run as book.json and which carries the
  // `listed` flag. The Family session's names-only projection (`holdings()`) does not carry it,
  // and reading the flag there let the warrant and preference-share lines into the table — measured
  // by verify-research-sheet-ui.mjs, 37 rows against 35. Names prefer the session's, which is newer.
  const committed = new Map(coverage.baseHoldings().map((h) => [h.isin, h]));
  const current = new Map(coverage.holdings().map((h) => [h.isin, h]));
  const rows = book.counted().filter((p) => p.assetClass === 'Equity' && p.engagement !== 'PMS' && committed.get(p.isin)?.listed !== false);
  return book.directEquity(rows).map((company) => {
    const listed = current.get(company.isin) || committed.get(company.isin) || null;
    const ticker = (company.symbol || listed?.ticker || '').toUpperCase() || null;
    return {
      key: ticker || isinKey(company.isin),
      ticker,
      isin: company.isin,
      kind: 'book',
      name: listed?.name || company.name,
      bookSector: company.sector || listed?.sector || null,
      company,
    };
  }).filter((h) => h.key);
}

/** Statement defaults for one holding, each position moved onto today's share basis. */
function statementDefaults(holding, splits, today) {
  const c = holding.company;
  let quantity = 0;
  let costedQty = 0;
  let cost = 0;
  let costRows = 0;
  let adjusted = [];
  for (const p of c.rows) {
    const factor = splitFactorAfter(splits, p.accountAsOf, today);
    if (factor !== 1) adjusted.push(`${p.accountAsOf}: ×${+factor.toFixed(4)}`);
    const q = num(p.quantity) ?? 0;
    quantity += q * factor;
    if (num(p.costBasis) != null) { cost += p.costBasis; costedQty += q * factor; costRows++; }
  }
  const where = [...new Set(c.rows.map((p) => `${p.provider} · ${p.owner}`))].join('; ');
  const asOf = c.statementTo ? longDate(c.statementTo) : 'an undated statement';
  return {
    quantity: quantity > 0 ? quantity : null,
    buyPrice: costRows && costedQty > 0 ? cost / costedQty : null,
    dateBought: c.heldSince || null,
    marketValue: num(c.marketValue),
    split: adjusted.length ? `moved onto today's share basis for a split or bonus after the statement (${adjusted.join(', ')})` : '',
    where,
    asOf,
    costRows,
    rowCount: c.rows.length,
    statementTo: c.statementTo,
  };
}

// ---- the portfolio --------------------------------------------------------------------------

function portfolioHoldings() {
  const held = bookHoldings();
  const seen = new Set(held.map((h) => h.key));
  for (const row of sheet.manualRows()) {
    if (seen.has(row.key)) continue; // the statements caught up with it; one row, the book's
    seen.add(row.key);
    held.push({ key: row.key, ticker: row.key.startsWith('ISIN:') ? null : row.key, isin: null, kind: 'manual',
      name: row.name, bookSector: null, company: null, manual: row });
  }
  return held;
}

function priceCells(ticker, now) {
  const q = market.quote(ticker);
  const price = q?.price ?? null;
  const cmp = derived(price, q ? (q.label || 'Current market price') : (ticker ? 'No price is captured for this company yet — it joins the minute capture within 15 minutes of being added' : 'No exchange symbol, so no market price'),
    { stale: !!q?.stale, at: q?.at || null, source: q?.source || null });
  const day = derived(q?.change ?? null, q?.change != null ? `Change against the previous close · ${q.label}` : 'No previous close is captured for this company');
  const m = market.monthReturn(ticker, price, now);
  const month = derived(m?.value ?? null, m?.value != null
    ? `CMP ${rupees(price)} against the ${m.basis} of ${longDate(m.baseDate)} (${rupees(m.baseClose)}), one calendar month back`
    : (m?.reason || (price ? 'No daily history for this company' : 'Needs a current price')));
  const cap = market.marketCap(ticker, price);
  const mcap = derived(cap?.value ?? null, cap ? `Derived: ${cap.basis}` : 'No share count or market cap is captured for this company');
  return { q, price, cmp, day, month, mcap };
}

function targetCells(key, total, invested) {
  const ta = sheet.entry(key, 'targetAmount');
  const tw = sheet.entry(key, 'targetWeight');
  const base = total > 0 ? ` (public-direct value ${cr2(total)})` : '';
  const targetAmount = cell(key, 'targetAmount', tw && total > 0 ? (tw.value / 100) * total : null, tw ? `Target weight × public-direct value${base}` : '');
  const targetWeight = cell(key, 'targetWeight', ta && total > 0 ? (ta.value / total) * 100 : null, ta ? `Target amount ÷ public-direct value${base}` : '');
  const pendingAmount = invested === undefined
    ? null
    : cell(key, 'pendingAmount', targetAmount.value != null && invested != null ? targetAmount.value - invested : null,
      targetAmount.value != null && invested != null ? 'Target amount − amount invested' : '');
  return invested === undefined ? { targetAmount, targetWeight } : { targetAmount, targetWeight, pendingAmount };
}

function valuationCells(key, price) {
  const intrinsicValue = cell(key, 'intrinsicValue');
  const methodology = cell(key, 'methodology');
  const reference = cell(key, 'reference');
  const iv = num(intrinsicValue.value);
  const upside = derived(iv && price ? pctChange(iv, price) : null, iv && price
    ? `Intrinsic value ${rupees(iv)} ÷ CMP ${rupees(price)} − 1`
    : iv ? 'Needs a current price' : 'Needs an intrinsic value');
  return { intrinsicValue, methodology, reference, upside, iv };
}

/**
 * Every Portfolio row, priced now. `now` is a parameter so the verification can pin the clock.
 */
export function portfolioRows(now = Date.now()) {
  const today = istToday(now);
  const bench = market.benchmarkNow();
  const first = portfolioHoldings().map((h) => {
    const key = h.key;
    const ev = market.events(h.ticker);
    const defaults = h.company ? statementDefaults(h, ev.splits || [], today) : null;
    const { q, price, cmp, day, month, mcap } = priceCells(h.ticker, now);
    const name = cell(key, 'name', h.name || market.dailyName(h.ticker) || h.ticker || key,
      h.kind === 'manual' ? `Added by hand${h.manual?.addedBy ? ` by ${h.manual.addedBy}` : ''}` : "The family's statements");
    const sector = sectorCell(key, h.ticker, h.bookSector);
    const sourceLine = defaults ? `${defaults.where}, statement of ${defaults.asOf}` : '';

    const quantity = cell(key, 'quantity', defaults?.quantity ?? null,
      defaults?.quantity ? `Shares on the family's statements — ${sourceLine}${defaults.split ? `; ${defaults.split}` : ''}` : '');
    const buyPrice = cell(key, 'buyPrice', defaults?.buyPrice ?? null,
      defaults?.buyPrice ? `Average cost on the statements (${defaults.costRows} of ${defaults.rowCount} position${defaults.rowCount === 1 ? '' : 's'} print a cost) — ${sourceLine}` : '');
    const dateBought = cell(key, 'dateBought', defaults?.dateBought ?? null,
      defaults?.dateBought ? `Oldest unit still held, from the statement's lot register — ${sourceLine}` : '');
    const qty = num(quantity.value);
    const buy = num(buyPrice.value);
    const amountInvested = cell(key, 'amountInvested', qty && buy ? (qty * buy) / 1e7 : null, qty && buy ? 'Quantity × buy price' : '');
    const invested = num(amountInvested.value);
    const bought = dateBought.value && dateBought.value <= today ? dateBought.value : null;

    // Current value: shares × the price a reader can act on now. A holding with no price keeps the
    // statement's own value — but only while its quantity is the statement's, because a typed
    // quantity is not what that valuation was struck on.
    let currentValue;
    if (price && qty) currentValue = derived((price * qty) / 1e7, `Quantity × CMP (${q.label})`, { basis: q.stale ? 'saved' : 'live' });
    else if (!quantity.edited && defaults?.marketValue != null) {
      currentValue = derived(defaults.marketValue / 1e7, `No current price — the statement's own value (${defaults.asOf}). ${h.ticker ? '' : 'This line has no exchange symbol here.'}`.trim(), { basis: 'statement' });
    } else currentValue = derived(null, qty ? 'Needs a current price' : 'Needs Quantity');

    // Dividends: every ex-date after the purchase, on the shares held. Unknown — not zero — unless
    // the purchase date is known AND the company's dividend history was read.
    let dividends = null;
    let flows = [];
    let dividendNote;
    if (!bought) dividendNote = 'needs Date bought to count dividends';
    else if (!qty) dividendNote = 'needs Quantity to count dividends';
    else if (!['read', 'retained'].includes(ev.state)) dividendNote = `dividends not counted — ${ev.reason || 'no dividend history'}`;
    else {
      flows = dividendsReceived(ev.dividends, bought, today, qty);
      dividends = flows.reduce((s, f) => s + f.amount, 0);
      dividendNote = flows.length
        ? `${flows.length} dividend${flows.length === 1 ? '' : 's'} since ${formatSheetDate(bought)}: ${rupees(dividends)} (Yahoo Finance, per share × quantity)`
        : `no dividend with an ex-date after ${formatSheetDate(bought)} (Yahoo Finance)`;
      if (ev.state === 'retained') dividendNote += ` — history from an earlier capture (${ev.checkedAt?.slice(0, 10) || 'date unknown'})`;
    }
    const cv = currentValue.value;
    const included = dividends != null;
    const tsrValue = invested > 0 && cv != null ? ((cv * 1e7 + (dividends || 0) - invested * 1e7) / (invested * 1e7)) * 100 : null;
    const tsr = derived(tsrValue, tsrValue == null
      ? (invested > 0 ? 'Needs a current value' : 'Needs Amount invested (or Quantity and Buy price)')
      : `(Current value ${cr2(cv)} + dividends − invested ${cr2(invested)}) ÷ invested · ${dividendNote}`,
    { dividendsIncluded: included });

    let alpha;
    const at = bought ? market.benchmarkAt(bought) : null;
    if (tsrValue == null) alpha = derived(null, 'Needs TSR');
    else if (!bought) alpha = derived(null, 'Needs Date bought');
    else if (!at || !bench) alpha = derived(null, `No Nifty 500 level on or before ${formatSheetDate(bought)} in the captured history`);
    else {
      const indexReturn = pctChange(bench.level, at.level);
      alpha = derived(tsrValue - indexReturn, `TSR ${pct1(tsrValue)} − Nifty 500 ${pct1(indexReturn)} (${at.level.toLocaleString('en-IN')} on ${longDate(at.date)} to ${bench.level.toLocaleString('en-IN')}, ${bench.source}${bench.at ? ` at ${new Date(bench.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST` : ` on ${longDate(bench.date)}`}), in percentage points. The index is the price index, without dividends${included ? ', while the TSR includes them' : ''}.`,
      { indexReturn });
    }

    let xirrCell;
    if (!bought) xirrCell = derived(null, 'Needs Date bought');
    else if (!(invested > 0) || cv == null) xirrCell = derived(null, 'Needs Amount invested and a current value');
    else if (bought >= today) xirrCell = derived(null, 'Bought today — no period to annualise over');
    else {
      const rate = xirr([{ date: bought, amount: -invested * 1e7 }, ...flows.map((f) => ({ date: f.date, amount: f.amount })), { date: today, amount: cv * 1e7 }]);
      const days = daysBetween(bought, today);
      xirrCell = derived(rate == null ? null : rate * 100, rate == null
        ? 'No rate solves these cash flows'
        : `Money-weighted annual return of −${cr2(invested)} on ${formatSheetDate(bought)}${flows.length ? `, ${flows.length} dividend${flows.length === 1 ? '' : 's'}` : ''} and ${cr2(cv)} today, over ${days} days${days < 365 ? ' — under a year, so the figure annualises a short period' : ''}${included ? '' : `; ${dividendNote}`}`,
      { short: days < 365, dividendsIncluded: included });
    }

    const { intrinsicValue, methodology, reference, upside, iv } = valuationCells(key, price);
    const expectedIrr = derived(iv && buy ? pctChange(iv, buy) : null, iv && buy
      ? `Intrinsic value ${rupees(iv)} ÷ buy price ${rupees(buy)} − 1`
      : iv ? 'Needs Buy price' : 'Needs an intrinsic value');

    return {
      key, ticker: h.ticker, isin: h.isin, kind: h.kind, manual: h.manual || null, statement: defaults,
      name, sector, cmp, day, month, mcap, dateBought, quantity, buyPrice, amountInvested,
      currentValue, dividends: derived(dividends, dividendNote), tsr, alpha, xirr: xirrCell,
      intrinsicValue, methodology, reference, upside, expectedIrr,
    };
  });

  // The denominator every weight is read against: the public-direct value now, from the rows that
  // have one. Rows without a value are counted out by name rather than as zero.
  const priced = first.filter((r) => r.currentValue.value != null);
  const total = priced.reduce((s, r) => s + r.currentValue.value, 0);
  const missing = first.length - priced.length;
  for (const r of first) {
    r.weight = derived(r.currentValue.value != null && total > 0 ? (r.currentValue.value / total) * 100 : null,
      r.currentValue.value != null
        ? `Current value ÷ public-direct total ${cr2(total)} (${priced.length} holding${priced.length === 1 ? '' : 's'}, PMS excluded${missing ? `; ${missing} without a value left out` : ''})`
        : 'Needs a current value');
    Object.assign(r, targetCells(r.key, total, num(r.amountInvested.value)));
  }
  first.total = total;
  first.missingValue = missing;
  return first;
}

/** The public-direct total the Watchlist's target weights are measured against. */
export function publicDirectTotal(now = Date.now()) {
  const rows = portfolioRows(now);
  return { total: rows.total, holdings: rows.length };
}

// ---- the watchlist --------------------------------------------------------------------------

export function watchlistRows(now = Date.now()) {
  const { total } = publicDirectTotal(now);
  const names = new Map(coverage.holdings().filter((h) => h.ticker).map((h) => [h.ticker.toUpperCase(), h.name]));
  return watchlist.all().map((entry) => {
    const key = entry.ticker;
    const ticker = entry.ticker;
    const { price, cmp, day, month, mcap } = priceCells(ticker, now);
    const name = cell(key, 'name', entry.name || names.get(ticker) || market.dailyName(ticker) || ticker, 'The shared watchlist');
    const sector = sectorCell(key, ticker, null);
    const source = cell(key, 'source');
    const { targetAmount, targetWeight } = targetCells(key, total, undefined);
    const { intrinsicValue, methodology, reference, upside, iv } = valuationCells(key, price);
    const entryPrice = cell(key, 'entryPrice');
    const ep = num(entryPrice.value);
    const expectedIrr = derived(iv && ep ? pctChange(iv, ep) : null, iv && ep
      ? `Intrinsic value ${rupees(iv)} ÷ buy price ${rupees(ep)} − 1`
      : iv ? 'Set the buy price this IRR is measured from' : 'Needs an intrinsic value');
    return {
      key, ticker, isin: null, kind: 'watchlist', addedBy: entry.addedBy, addedAt: entry.addedAt,
      name, sector, source, cmp, day, month, mcap, targetAmount, targetWeight,
      intrinsicValue, methodology, reference, upside, entryPrice, expectedIrr,
    };
  });
}
