// data/sheet-math.js — THE ARITHMETIC BEHIND THE PORTFOLIO AND WATCHLIST TABS. GLOW-OWNED.
//
// Pure and dependency-free, so `scripts/verify-research-sheet.mjs` checks every figure the tabs
// derive without a browser: parsing what a person types, the one-month base, dividends received,
// a split after a statement date, and the money-weighted return (XIRR).
//
// NOTHING HERE INVENTS AN INPUT. Every function returns null when a fact it needs is missing, and
// the tab prints that null as a dash whose title says which fact — "needs Date bought", "needs Buy
// price" — because a zero would read as a measured result.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

/** Today's date in IST, as YYYY-MM-DD — the market's calendar, not the reader's. */
export const istToday = (now = Date.now()) => new Date(now + 19800000).toISOString().slice(0, 10);

const validDate = (y, m, d) => {
  if (!(y >= 1950 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** A two-digit year read the way a purchase date is meant: '24' is 2024, '98' is 1998. */
const fullYear = (yy, now = Date.now()) => {
  const pivot = Number(istToday(now).slice(2, 4)) + 1;
  return yy <= pivot ? 2000 + yy : 1900 + yy;
};

/**
 * A date as a person types it, read the Indian way — day first. Accepts 12-Mar-24, 12 Mar 2024,
 * 12/03/2024, 12.03.24 and 2024-03-12. Returns YYYY-MM-DD, or null for anything that is not a real
 * calendar date: 31-Apr is refused rather than rolled into May.
 */
export function parseDateInput(text, now = Date.now()) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2}|\d{4})$/.exec(raw);
  if (m) {
    const month = MONTHS.findIndex((name) => m[2].slice(0, 3).toLowerCase() === name.toLowerCase());
    if (month < 0) return null;
    const year = m[3].length === 2 ? fullYear(+m[3], now) : +m[3];
    return validDate(year, month + 1, +m[1]);
  }
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(raw);
  if (m) {
    const year = m[3].length === 2 ? fullYear(+m[3], now) : +m[3];
    return validDate(year, +m[2], +m[1]);
  }
  return null;
}

/** DD-MMM-YY, the format the desk's sheet uses: 2024-03-12 -> 12-Mar-24. */
export function formatSheetDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return '—';
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1].slice(2)}`;
}

/**
 * A number as a person types it. Grouping commas (Indian or Western), a rupee sign, "Rs", "Cr" and
 * a trailing % are tolerated because they are how the figure is written on paper; anything else
 * that is not a plain number is refused rather than half-read.
 */
export function parseNumberInput(text) {
  const raw = String(text ?? '')
    .replace(/[₹,\s]/g, '')
    .replace(/^(?:rs\.?|inr)/i, '')
    .replace(/(?:crores?|cr\.?|%)$/i, '');
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The close on or before a date, from rows of [date, close] sorted oldest first. */
export function closeOnOrBefore(rows, date) {
  if (!Array.isArray(rows) || !rows.length || !date) return null;
  let lo = 0;
  let hi = rows.length - 1;
  if (rows[0][0] > date) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][0] <= date) lo = mid;
    else hi = mid - 1;
  }
  return rows[lo];
}

/** The same calendar day one month earlier, clamped: 31 Mar -> 28/29 Feb. */
export function monthBefore(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return null;
  let y = +m[1];
  let mo = +m[2] - 1;
  if (mo === 0) { mo = 12; y--; }
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return validDate(y, mo, Math.min(+m[3], last));
}

/**
 * How many of today's shares one share on `date` became: the product of every split and bonus
 * strictly after `date` and on or before `today`. A statement dated before a 1:5 split carries
 * a fifth of today's share count, so its quantity is multiplied by this and its average cost
 * divided by it — the holding is unchanged, only its unit is.
 */
export function splitFactorAfter(splits, date, today) {
  if (!Array.isArray(splits) || !date) return 1;
  let factor = 1;
  for (const [day, numerator, denominator] of splits) {
    if (day > date && (!today || day <= today) && numerator > 0 && denominator > 0) factor *= numerator / denominator;
  }
  return factor;
}

/**
 * The dividends a holding of `quantity` shares received: every ex-date strictly AFTER the date it
 * was bought (a buyer on the ex-date is not entitled) and on or before today. Yahoo's amounts are
 * per current share, the basis `quantity` is on. Returns the dated cash flows, oldest first.
 */
export function dividendsReceived(dividends, bought, today, quantity) {
  if (!Array.isArray(dividends) || !bought || !(quantity > 0)) return [];
  return dividends
    .filter(([day, amount]) => day > bought && day <= today && amount > 0)
    // Rounded to the paisa: money, not a float artefact (17.35 × 100 is 1734.9999… in binary).
    .map(([day, amount]) => ({ date: day, perShare: amount, amount: Math.round(amount * quantity * 100) / 100 }));
}

const years = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (365 * DAY_MS);

/**
 * The money-weighted annual return of dated cash flows — Excel's XIRR, on a 365-day year.
 *
 * Newton's method from 10%, then bisection over (-99.99%, +10,000%) if Newton wanders. Returns
 * null where no rate exists: every flow one sign, fewer than two dates, or no root in range.
 */
export function xirr(flows) {
  const clean = (flows || []).filter((f) => f && Number.isFinite(f.amount) && /^\d{4}-\d{2}-\d{2}$/.test(f.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (clean.length < 2 || !clean.some((f) => f.amount > 0) || !clean.some((f) => f.amount < 0)) return null;
  const start = clean[0].date;
  if (clean.at(-1).date === start) return null;
  const t = clean.map((f) => years(start, f.date));
  const npv = (r) => clean.reduce((sum, f, i) => sum + f.amount / (1 + r) ** t[i], 0);
  const slope = (r) => clean.reduce((sum, f, i) => sum - (t[i] * f.amount) / (1 + r) ** (t[i] + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 60; i++) {
    const value = npv(r);
    const d = slope(r);
    if (!Number.isFinite(value) || !Number.isFinite(d) || d === 0) break;
    const next = r - value / d;
    if (!Number.isFinite(next) || next <= -0.9999) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || Math.sign(fLo) === Math.sign(fHi)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9 || hi - lo < 1e-12) return mid;
    if (Math.sign(fMid) === Math.sign(fLo)) { lo = mid; fLo = fMid; }
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Calendar days between two YYYY-MM-DD dates. */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** A ratio as a percentage change: 150 over 100 is +50. Null unless both sides are positive. */
export const pctChange = (now, base) => (now > 0 && base > 0 ? (now / base - 1) * 100 : null);
