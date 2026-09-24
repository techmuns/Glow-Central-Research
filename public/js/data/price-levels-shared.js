// data/price-levels-shared.js — THE FAMILY'S PRICE LEVELS, AS ONE SHARED RECORD.
//
// Pure and dependency-free (bar the watchlist's own symbol and name rules), so the Worker's store,
// its route, its minute check and the alert source in the browser all read one definition of what a
// level is, which way it fires and when it counts as reached. Same arrangement, and the same reason,
// as `watchlist-shared.js`: the edge and the page must not be able to drift about any of it.
//
// WHERE THESE COME FROM
//   The family set a price level on a holding in the Glow Ventures dashboard — a separate app, on its
//   own server, whose store is the reader's own browser. *"When the user puts target price inside the
//   dashboard, it should automatically also go to the Glow Central Research dashboard. When the
//   target price is met, it should show in All Alerts as an alert, and automatically come to the AI
//   Alert section."* So every save there is sent here, to ONE shared list (`/api/price-levels`); this
//   Worker checks each level against its own live price once a minute while the market is open, and
//   records the moment one is reached. A reached level is an item in All Alerts and AI Alerts.
//
// FIVE LEVELS, UNDER AN INVESTOR'S WORDS, AND THE SAME WORDS AS THE APP THAT SET THEM
//   Buy at and Stop loss fire on the way DOWN; Sell at, Target and Alert above on the way UP. The
//   reached wording ("Stop loss hit", "Target reached") is Glow Ventures' own, so a reader who set a
//   level there reads the identical sentence here.
//
// WHY A REACHED LEVEL IS A DATED EVENT HERE, AND A LIVE STATE THERE
//   Glow Ventures shows a level as reached WHILE the price is past it, and as watched again if the
//   price comes back. An alert feed needs a moment instead: the minute this Worker first saw the price
//   reach the level. That moment is stamped by the Worker, never by a browser — two readers must see
//   the same time, and a reload must not move an alert to the top of the feed. One level fires once;
//   setting it to a NEW value is a new level and can fire again.

import { SYMBOL_RE, companyName, normTicker } from './watchlist-shared.js';

/** The one Durable Object that holds the list (same provisioned class, its own fixed name). */
export const PRICE_LEVELS_OBJECT = 'price-levels:v1';

/** Where the levels are set, named on every alert they raise. */
export const PRICE_LEVEL_SOURCE = 'Glow Ventures';

export const PRICE_LEVEL_NAMES = ['buyAt', 'sellAt', 'stopLoss', 'target', 'alertAbove'];

/**
 * Each level: what it is called, what it says when reached, and which way it fires.
 * `down` fires at or BELOW the level; `up` at or ABOVE. Reached is inclusive — a level the price
 * touches exactly must fire, or a Stop loss set at a round number could be missed by the one tick
 * that mattered.
 */
export const PRICE_LEVEL = {
  buyAt: { label: 'Buy at', reached: 'Buy level reached', direction: 'down' },
  sellAt: { label: 'Sell at', reached: 'Sell level reached', direction: 'up' },
  stopLoss: { label: 'Stop loss', reached: 'Stop loss hit', direction: 'down' },
  target: { label: 'Target', reached: 'Target reached', direction: 'up' },
  alertAbove: { label: 'Alert above', reached: 'Above your level', direction: 'up' },
};

// Bounds — each a ceiling on what one request or one object may cost, never an editorial judgement.
export const PRICE_LEVELS_COMPANY_LIMIT = 600;
export const PRICE_LEVELS_INTENT_BATCH = 40;
export const PRICE_LEVELS_TOMBSTONE_LIMIT = 400;
/** Reached levels kept as history — the feed's record, which outlives a level cleared after it fired. */
export const PRICE_LEVELS_HIT_LIMIT = 500;
/** How many of those the route returns, newest first. */
export const PRICE_LEVELS_HIT_WIRE = 200;
export const PRICE_LEVELS_REQUEST_BYTES = 32768;
/** ₹1 crore a share — above every listed Indian share; a larger figure is a typo, not a level. */
export const PRICE_LEVEL_MAX = 1e7;

/** An Indian ISIN, the shape Upstox keys a cash-market instrument on. */
export const ISIN_RE = /^IN[A-Z0-9]{10}$/;

/**
 * One level's value: a positive finite number, or null for "not set". Anything else THROWS rather
 * than being read as unset — a malformed figure silently dropped would erase a level somebody set.
 */
export function priceLevelValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > PRICE_LEVEL_MAX) {
    throw new Error('Invalid price level');
  }
  return value;
}

/** All five levels, each a value or null. A key this contract does not know is refused, not dropped. */
export function priceLevels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid price levels');
  for (const key of Object.keys(input)) if (!PRICE_LEVEL_NAMES.includes(key)) throw new Error('Invalid price level name');
  return Object.fromEntries(PRICE_LEVEL_NAMES.map((name) => [name, priceLevelValue(input[name])]));
}

/**
 * One edit, validated. Throws rather than silently dropping a field the caller meant to send.
 *
 * THREE OPERATIONS, AND `seed` IS THE ONE THAT KEEPS TWO DEVICES FROM FIGHTING.
 *   `set` is the family's latest word on a company and replaces what the list holds. `seed` is a
 *   level a browser already held BEFORE it ever sent anything — it is added only where the shared
 *   list has never heard of the company, so a laptop opened for the first time in a month cannot
 *   overwrite a level set yesterday on another device. `clear` removes every level on a company and
 *   is kept as a record, so a stale device cannot quietly put one back with a seed.
 */
export function priceLevelIntent(input) {
  const op = String(input?.op ?? '');
  if (!['set', 'seed', 'clear'].includes(op)) throw new Error('Invalid price level operation');
  const ticker = normTicker(input?.ticker);
  if (!SYMBOL_RE.test(ticker)) throw new Error('Invalid price level company');
  if (op === 'clear') return { op, ticker };
  const isin = input?.isin == null || input.isin === '' ? null : String(input.isin).trim().toUpperCase();
  if (isin !== null && !ISIN_RE.test(isin)) throw new Error('Invalid price level ISIN');
  const levels = priceLevels(input?.levels);
  // A set with nothing in it is a clear spelt wrongly, and it is refused so the caller says which.
  if (!PRICE_LEVEL_NAMES.some((name) => levels[name] !== null)) throw new Error('Invalid price levels: none set');
  return { op, ticker, isin, name: companyName(input?.name), levels };
}

/** Validate a whole batch, rejecting one that is empty, oversized or names a company twice. */
export function priceLevelIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > PRICE_LEVELS_INTENT_BATCH) throw new Error('Invalid price level batch');
  const intents = input.map(priceLevelIntent);
  const seen = new Set();
  for (const intent of intents) {
    // Two edits to one company in one batch cannot be ordered by anything the wire carries.
    if (seen.has(intent.ticker)) throw new Error('Duplicate company in price level batch');
    seen.add(intent.ticker);
  }
  return intents;
}

/** Has a price reached a level? Inclusive, and false for anything that is not a real price. */
export function levelReached(direction, value, price) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(value) || value <= 0) return false;
  return direction === 'down' ? price <= value : price >= value;
}

/** When a session opens, 09:15 IST, as epoch milliseconds. */
export const sessionOpenAt = (day) => Date.parse(`${day}T09:15:00+05:30`);

/**
 * DID THIS QUOTE REACH THIS LEVEL, AND ON WHAT EVIDENCE?
 *
 * The last traded price first. Failing that, the day's HIGH (for a level that fires upward) or LOW
 * (downward) — because a check runs once a minute and a price can touch a level and leave between two
 * checks — BUT ONLY for a level that was set before this session opened. A level set at 14:00 must
 * not fire on a high the market made at 10:00: nothing reached it after it existed. That is the one
 * way a day's range could invent an alert, and it is refused here rather than in a caller.
 *
 * Returns `{ price, basis }` — the figure that did it and which one it was — or null.
 */
export function levelHit({ direction, value, setAt }, quote) {
  if (!quote) return null;
  if (levelReached(direction, value, quote.price)) return { price: quote.price, basis: 'last-price' };
  const extreme = direction === 'down' ? quote.low : quote.high;
  const setBeforeOpen = Number.isFinite(Date.parse(setAt)) && Date.parse(setAt) < sessionOpenAt(quote.sessionDate);
  if (setBeforeOpen && levelReached(direction, value, extreme)) {
    return { price: extreme, basis: direction === 'down' ? 'day-low' : 'day-high' };
  }
  return null;
}

/** A reached level's stable identity: the company, the level, its value and when that value was set. */
export const hitId = (hit) => `price-level|${hit.ticker}|${hit.level}|${hit.value}|${hit.setAt}`;

/** How a hit's evidence reads to a person. Kept here so the Worker and the feed cannot word it apart. */
export function hitEvidence(basis) {
  if (basis === 'day-high') return "the day's high";
  if (basis === 'day-low') return "the day's low";
  return 'the last traded price';
}
