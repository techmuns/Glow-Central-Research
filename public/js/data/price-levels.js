// data/price-levels.js — THE FAMILY'S PRICE LEVELS, AS ALL ALERTS AND AI ALERTS READ THEM.
//
// The levels are set in the Glow Ventures dashboard and sent to this Worker, which checks each one
// against the live price once a minute while the market is open and records the minute it was first
// reached (see `price-levels-shared.js` for the contract and `worker/price-levels-schedule.mjs` for
// the check). This module reads that record — `GET /api/price-levels` — and turns every level reached
// into an alert row. It decides nothing about prices itself: a page that re-judged a level against
// whatever price it happened to hold would disagree with the Worker, and with another reader.

import { revalidatedJson } from '../core/store.js';
import { record } from './alert-records.js';
import { PRICE_LEVEL, PRICE_LEVEL_SOURCE, hitEvidence } from './price-levels-shared.js';

export const PRICE_LEVELS_FEED = 'price-levels';

let snapshot = null;
const subscribers = new Set();
export const onChange = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach((fn) => fn());

/** Read the list. A failed read keeps the last good one — a failure is never an empty list. */
export async function load() {
  const value = await revalidatedJson('api/price-levels');
  if (!value?.ok || !Array.isArray(value.hits) || !Array.isArray(value.companies)) {
    throw new Error(value?.reason ? `price levels unavailable (${value.reason})` : 'price levels unavailable');
  }
  const changed = !snapshot || snapshot.revision !== value.revision || JSON.stringify(snapshot.check) !== JSON.stringify(value.check);
  snapshot = value;
  if (changed) emit();
}

export const meta = () => snapshot;

const IST_DAY = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const IST_TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const rupees = (value) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value)}`;
const onDay = (value) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? IST_DAY.format(at) : null; };
const atTime = (value) => { const at = new Date(value); return Number.isFinite(at.getTime()) ? IST_TIME.format(at) : null; };

/**
 * WHICH WAY THE SIGNAL POINTS, AND WHY A BUY LEVEL POINTS NOWHERE.
 *   A price rising to a Target, a Sell at or an Alert above level is good news for the holding; a
 *   price falling through the family's Stop loss is bad news. A price falling to their BUY level is
 *   neither on its own — it is the entry point they chose — so it reads neutral, and its importance
 *   is still high because they asked to be told.
 */
export function signalOf(level) {
  if (level === 'buyAt') return { direction: 'neutral', signalReason: 'The price fell to the level the family set to buy at — their own entry point, neither good nor bad news on its own.' };
  if (PRICE_LEVEL[level]?.direction === 'down') return { direction: 'negative', signalReason: 'The price fell through the Stop loss the family set to protect this holding.' };
  return { direction: 'positive', signalReason: `The price rose to the ${PRICE_LEVEL[level]?.label || 'level'} the family set to act at.` };
}

/** One reached level as an alert row. Its identity is stable, so a reload never makes it new again. */
export function priceLevelRecord(hit) {
  const def = PRICE_LEVEL[hit.level];
  const when = hit.basis === 'last-price' && atTime(hit.quoteAt) ? `at ${atTime(hit.quoteAt)} IST` : `in the ${onDay(`${hit.session}T12:00:00+05:30`)} session`;
  return record({
    // Already namespaced and content-derived by the Worker: company, level, value and when it was set.
    id: hit.id,
    row: hit,
    at: hit.reachedAt,
    ticker: hit.ticker,
    company: hit.name || hit.ticker,
    headline: `${def.reached} — ${rupees(hit.value)}`,
    detail: `${def.label} ${rupees(hit.value)}, set in ${PRICE_LEVEL_SOURCE} on ${onDay(hit.setAt) || 'an unrecorded date'}. `
      + `Reached on ${hitEvidence(hit.basis)}, ${rupees(hit.price)} ${when}.`,
    kind: 'price-level',
    ...signalOf(hit.level),
    importance: 'high',
    severity: hit.level === 'stopLoss' ? 'alert' : 'update',
    importanceReason: `A level the family set themselves in ${PRICE_LEVEL_SOURCE}, to be told the moment it was reached.`,
    aiEligible: true,
    entityId: hit.isin ? `isin:${hit.isin}` : null,
    priceLevel: hit.level,
    levelValue: hit.value,
    reachedPrice: hit.price,
    reachedBasis: hit.basis,
  });
}

const FAILURE_WORDS = {
  'not-configured': 'the live price feed is not configured on this dashboard',
  authentication: 'the live price feed refused this dashboard’s credential',
  'rate-limited': 'the live price feed asked this dashboard to slow down',
  unavailable: 'the live price feed did not answer',
  overdue: 'the minute check has not run on time',
};

/** The feed row: every level reached, and an honest account of whether the check is keeping up. */
export function readFeed() {
  if (!snapshot) return { events: [], status: 'pending', asOf: null, reachesToday: null, note: 'The family’s price levels have not been read yet.' };
  const check = snapshot.check || {};
  const waiting = snapshot.pending || 0;
  const unchecked = (check.failures || []).filter((f) => f.reason === 'no-isin').map((f) => f.ticker);
  const parts = [`${snapshot.count} ${snapshot.count === 1 ? 'company carries' : 'companies carry'} a level; ${waiting} ${waiting === 1 ? 'level is' : 'levels are'} still waiting for the price.`];
  if (check.failed) parts.push(`Levels are not being checked right now: ${FAILURE_WORDS[check.state] || 'the price check failed'}. A level reached meanwhile is recorded at the next check that sees it.`);
  else if (check.checkedAt) parts.push(`Last checked against the live price at ${atTime(check.checkedAt)} IST on ${onDay(check.checkedAt)}.`);
  else if (waiting) parts.push('Not checked against a live price yet — the first check runs while the market is open.');
  if (unchecked.length) parts.push(`Not checked: ${unchecked.join(', ')} — no exchange identity (ISIN) arrived with the level; it is checked once one does.`);
  return {
    events: snapshot.hits.map(priceLevelRecord),
    status: check.failed ? 'failed' : 'ok',
    asOf: check.checkedAt || snapshot.updatedAt || null,
    reachesToday: check.current === true,
    revision: `${snapshot.revision}:${check.checkedAt || ''}:${check.state || ''}`,
    note: parts.join(' '),
  };
}
