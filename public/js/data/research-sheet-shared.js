// data/research-sheet-shared.js — THE ONE DEFINITION OF THE DESK'S EDITABLE RESEARCH FIELDS. GLOW-OWNED.
//
// The Portfolio and Watchlist tabs put two kinds of figure side by side. The MARKET's — price,
// market cap, returns, current value — are read live and are never typed. The DESK's — date bought,
// quantity, buy price, targets, intrinsic value, methodology, source — are typed by people, and this
// file is the only definition of what one of those may be.
//
// WHY ONE RECORD PER COMPANY, NOT ONE PER TABLE
//   An intrinsic value is a view about a COMPANY. When a watched company is bought it moves from the
//   Watchlist to the Portfolio, and the analyst's fair value, target and methodology have to move
//   with it rather than be typed again. So both tables read one record per company, and a field one
//   table does not show (Source on the Portfolio, Quantity on the Watchlist) is simply not drawn.
//   The single exception is the Watchlist's buy price for its Expected IRR (`entryPrice`): a planned
//   entry is not the price actually paid, and sharing one field would let an edit on the Watchlist
//   rewrite the Portfolio's cost.
//
// WHY AN EDIT IS AN INTENT AND NOT A SHEET
//   The same reason as the shared watchlist (data/watchlist-shared.js): "save the whole sheet"
//   silently deletes. A device that loaded the sheet an hour ago and types one intrinsic value would
//   write its stale copy of every other cell over whatever anyone else typed since. So a device sends
//   what it DID — set this field, clear that one — and the server applies it to the sheet as it is
//   now. Two people editing two different cells can never overwrite each other; two people editing
//   the SAME cell is decided by arrival, and the cell says who edited it last and when.
//
// Pure and dependency-free apart from the watchlist contract it shares its symbol and person rules
// with, so worker/research-sheet-store.mjs applies the identical validation the browser does.

import { SYMBOL_RE, normTicker, companyName, personName } from './watchlist-shared.js';

export const RESEARCH_SHEET_OBJECT = 'research-sheet:v1';

// Bounds. Each is a ceiling on what one request or one deployment may cost, never an editorial
// judgement about how many companies a desk should research.
export const SHEET_REQUEST_BYTES = 32768;
export const SHEET_INTENT_BATCH = 60;
export const SHEET_COMPANY_LIMIT = 800;
export const SHEET_ROW_LIMIT = 200;
export const SHEET_TOMBSTONE_LIMIT = 400;

// A company is its exchange symbol — the identity the watchlist star already uses — or, for a
// holding no feed here can place, its ISIN, written `ISIN:<code>` so it can never be read as a
// symbol. The ISIN check digit is not verified: the key only has to be stable and unambiguous.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const ISIN_KEY_RE = /^ISIN:([A-Z]{2}[A-Z0-9]{9}[0-9])$/;

export function sheetKey(value) {
  const text = normTicker(value);
  if (ISIN_KEY_RE.test(text)) return text;
  // A bare ISIN would also satisfy SYMBOL_RE (twelve letters and digits), and filing it as a symbol
  // is exactly the confusion the prefix exists to prevent — so it is refused rather than guessed at.
  if (ISIN_RE.test(text)) return null;
  return SYMBOL_RE.test(text) ? text : null;
}

export const isinKey = (isin) => {
  const code = normTicker(isin);
  return ISIN_RE.test(code) ? `ISIN:${code}` : null;
};

/** The ticker behind a key, or null for an ISIN key. */
export const keyTicker = (key) => (key && !String(key).startsWith('ISIN:') ? key : null);

// THE FIELDS. `kind` decides what the wire may carry; `unit` decides how a person types it and how
// a cell prints it. Rupee amounts in crore are entered and stored in crore, because that is the unit
// the column is headed in and the unit the desk thinks in — converting to rupees on the way in would
// be one more place for a factor of ten million to go missing.
export const FIELDS = {
  name: { kind: 'text', max: 200, label: 'Name of company' },
  sector: { kind: 'text', max: 80, label: 'Sector' },
  source: { kind: 'text', max: 120, label: 'Source' },
  dateBought: { kind: 'date', label: 'Date bought' },
  quantity: { kind: 'number', min: 0, exclusiveMin: true, max: 1e12, decimals: 4, label: 'Quantity bought (number of shares)' },
  buyPrice: { kind: 'number', unit: 'rupee', min: 0, exclusiveMin: true, max: 1e9, decimals: 4, label: 'Buy price (₹ per share)' },
  amountInvested: { kind: 'number', unit: 'crore', min: 0, max: 1e7, decimals: 6, label: 'Amount invested (₹ Cr)' },
  targetAmount: { kind: 'number', unit: 'crore', min: 0, max: 1e7, decimals: 6, label: 'Target amount to be invested (₹ Cr)' },
  targetWeight: { kind: 'number', unit: 'pct', min: 0, max: 100, decimals: 4, label: 'Target weight (% of public direct)' },
  pendingAmount: { kind: 'number', unit: 'crore', min: -1e7, max: 1e7, decimals: 6, label: 'Pending amount to be invested (₹ Cr)' },
  intrinsicValue: { kind: 'number', unit: 'rupee', min: 0, exclusiveMin: true, max: 1e9, decimals: 4, label: 'Intrinsic / fair value per share (₹)' },
  entryPrice: { kind: 'number', unit: 'rupee', min: 0, exclusiveMin: true, max: 1e9, decimals: 4, label: 'Buy price for the expected IRR (₹ per share)' },
  methodology: { kind: 'text', max: 60, label: 'Valuation methodology' },
  // Keep the text wire contract so earlier financial-year notes remain intact; new edits use dates.
  reference: { kind: 'text', input: 'date', max: 60, label: 'Reference year and date' },
};

export const FIELD_IDS = Object.freeze(Object.keys(FIELDS));
export const isField = (field) => Object.hasOwn(FIELDS, String(field ?? ''));

// Control characters are stripped by code point, as in the watchlist contract, so this file carries
// none of them itself. Every text value arriving here is somebody's typing.
const printable = (value) =>
  String(value ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in 1950–2100, as YYYY-MM-DD, or null. 2026-02-30 is not a date. */
export function isoDate(value) {
  const match = DATE_RE.exec(String(value ?? ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (y < 1950 || y > 2100) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? match[0] : null;
}

const roundTo = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * One field's value as the wire carries it, validated. Throws rather than storing something the
 * caller did not mean: a cell that silently became empty would read as nobody having typed it.
 */
export function fieldValue(field, raw) {
  const spec = FIELDS[field];
  if (!spec) throw new Error('Invalid research field');
  if (spec.kind === 'text') {
    const text = printable(raw).replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Invalid research value');
    return text.slice(0, spec.max);
  }
  if (spec.kind === 'date') {
    const date = isoDate(raw);
    if (!date) throw new Error('Invalid research value');
    return date;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('Invalid research value');
  const value = roundTo(raw, spec.decimals ?? 4);
  if (value > spec.max || value < spec.min || (spec.exclusiveMin && value <= spec.min)) throw new Error('Invalid research value');
  // -0 and 0 are one value; JSON would print "0" for both anyway, and a comparison must agree.
  return Object.is(value, -0) ? 0 : value;
}

/**
 * One edit, validated.
 *
 *   { op: 'set',        key, field, value, by? }   type a value into a cell
 *   { op: 'clear',      key, field, by? }          remove what was typed, so the cell shows its default again
 *   { op: 'add-row',    key, name, by? }           a holding the statements do not carry yet
 *   { op: 'remove-row', key, by? }                 take that holding off again
 *
 * `by` is optional and that is deliberate. The watchlist requires a name on an ADD because the
 * desk asked to know who put a company on a shared list; a cell edit is a smaller act, and asking
 * for a name on every keystroke-and-Enter would be friction nobody asked for. A name is recorded
 * when the device has one, and an unattributed edit reads "edited — name not recorded", never as
 * somebody else's.
 */
export function sheetIntent(input) {
  const op = String(input?.op ?? '');
  if (!['set', 'clear', 'add-row', 'remove-row'].includes(op)) throw new Error('Invalid research operation');
  const key = sheetKey(input?.key);
  if (!key) throw new Error('Invalid research company');
  const by = personName(input?.by) || null;
  if (op === 'add-row') {
    const name = companyName(input?.name);
    if (!name) throw new Error('Invalid research company name');
    return { op, key, name, by };
  }
  if (op === 'remove-row') return { op, key, by };
  const field = String(input?.field ?? '');
  if (!isField(field)) throw new Error('Invalid research field');
  if (op === 'clear') return { op, key, field, by };
  return { op, key, field, value: fieldValue(field, input?.value), by };
}

/** A whole batch, refusing one that is empty, oversized or self-contradictory. */
export function sheetIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > SHEET_INTENT_BATCH) throw new Error('Invalid research batch');
  const intents = input.map(sheetIntent);
  const seen = new Set();
  for (const intent of intents) {
    // Two edits to one cell (or two row edits to one company) in one batch cannot be ordered by
    // anything the wire carries, so the batch is refused rather than resolved by array position.
    const slot = intent.field ? `${intent.key}\u0000${intent.field}` : `${intent.key}\u0000#row`;
    if (seen.has(slot)) throw new Error('Duplicate research edit in batch');
    seen.add(slot);
  }
  return intents;
}

/** Two values are the same cell content — so re-saving what is there is not an edit. */
export const sameValue = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

/**
 * Is a snapshot newer than the one held? `revision` is the server's own counter, so two readings
 * of one sheet are ordered without trusting any device's clock. An unnumbered snapshot cannot be
 * ordered and is taken as given, as `isNewerWatchlist` does.
 */
export function isNewerSheet(incoming, held) {
  if (!Number.isFinite(incoming?.revision) || !Number.isFinite(held?.revision)) return true;
  return incoming.revision >= held.revision;
}

/** How a cell's last edit reads to a human. One wording, so a cell and an export cannot disagree. */
export function editedLabel(entry) {
  if (!entry) return '';
  const by = personName(entry.by);
  const when = entry.at && Number.isFinite(Date.parse(entry.at))
    ? new Date(entry.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST'
    : null;
  if (entry.pending) return `${by ? `Edited by ${by}` : 'Edited on this device'} · not yet saved to the shared sheet`;
  return [by ? `Edited by ${by}` : 'Edited — name not recorded', when].filter(Boolean).join(' · ');
}
