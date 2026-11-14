// data/ai-runs-shared.js — THE ONE DEFINITION OF A SHARED AI-INSIGHTS RUN. GLOW-OWNED.
//
// When a reader runs the AI "Our view" for a company on the AI Insights tab, that write costs a
// metered model step. Until now the result lived in that one browser's localStorage, so a colleague
// on another laptop saw the company as un-run and paid for the same view again. This file is the one
// definition of what a shared run is, so the desk can keep ONE record of each company it has run and
// nobody re-spends on a view somebody already wrote.
//
// WHY AN EDIT IS AN INTENT, NOT "THE WHOLE LIST"
//   The same reason as the shared watchlist and the research sheet: a device that loaded the list an
//   hour ago and saved its whole copy would silently drop every run anyone else added since. So a
//   device sends what it DID — set this company's run, clear that one — and the server applies it to
//   the record as it now stands. The server stamps the time, so two devices are ordered without
//   trusting either one's clock.
//
// WHAT A RUN CARRIES, AND WHAT IT NEVER DOES
//   A run carries the dashboard's OWN generated view (`idea`, the structured "Our view"; `rawText`,
//   the model's text) plus the company's name and sector. It is the dashboard's own output, shared
//   desk-wide over a PRIVATE store, never put on a public surface and never attributed to a real
//   person as something they said. A run with neither an idea nor rawText is refused: there is
//   nothing to share, and an empty run would read as a company that was researched and found blank.
//
// Pure and dependency-free apart from the watchlist contract it shares its symbol and person rules
// with, so worker/ai-runs-store.mjs applies the identical validation the browser does.

import { SYMBOL_RE, normTicker, companyName, personName } from './watchlist-shared.js';

export const AI_RUNS_OBJECT = 'ai-runs:v1';

// Bounds. Each is a ceiling on what one request or one deployment may cost, never a judgement about
// how many companies a desk should research.
export const AI_RUNS_REQUEST_BYTES = 262144;   // one POST (a batch of runs, each carrying model prose)
export const AI_RUNS_INTENT_BATCH = 20;
export const AI_RUNS_LIMIT = 300;              // runs kept desk-wide; the oldest fall off beyond this
export const AI_RUN_BYTES = 60000;             // the serialized view (idea + rawText) of ONE run

/** A run is identified by its NSE symbol — the identity the watchlist star and the sheet already use. */
export function runKey(value) {
  const ticker = normTicker(value);
  return SYMBOL_RE.test(ticker) ? ticker : null;
}

// Control characters are stripped by code point, as in the watchlist and sheet contracts, so this
// file carries none of them itself.
const text = (value, max) =>
  String(value ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * One run's shareable content, validated. Throws rather than storing something the caller did not
 * mean: a run that silently lost its view would read as a company researched and found empty.
 */
export function runContent(input) {
  const key = runKey(input?.key ?? input?.ticker);
  if (!key) throw new Error('Invalid AI run ticker');
  const name = companyName(input?.name) || key;
  const sector = text(input?.sector, 80) || null;
  const idea = input?.idea == null ? null : input.idea;
  const rawText = typeof input?.rawText === 'string' ? text(input.rawText, AI_RUN_BYTES) || null : null;
  if (idea == null && !rawText) throw new Error('Invalid AI run: no view to share');
  let serialized;
  try { serialized = JSON.stringify({ idea, rawText }); }
  catch { throw new Error('Invalid AI run: view is not serialisable'); }
  if (serialized == null || serialized.length > AI_RUN_BYTES) throw new Error('Invalid AI run: view too large');
  return { key, name, sector, idea, rawText, by: personName(input?.by) || null };
}

/**
 * One edit, validated.
 *   { op: 'set',   key|ticker, name?, sector?, idea?, rawText?, by? }   keep a company's run on the shared record
 *   { op: 'clear', key,        by? }                                    take a run off the shared record
 */
export function runIntent(input) {
  const op = String(input?.op ?? '');
  if (!['set', 'clear'].includes(op)) throw new Error('Invalid AI run operation');
  if (op === 'clear') {
    const key = runKey(input?.key ?? input?.ticker);
    if (!key) throw new Error('Invalid AI run ticker');
    return { op, key, by: personName(input?.by) || null };
  }
  return { op, ...runContent(input) };
}

/** A whole batch, refusing one that is empty, oversized or self-contradictory. */
export function runIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > AI_RUNS_INTENT_BATCH) throw new Error('Invalid AI run batch');
  const intents = input.map(runIntent);
  const seen = new Set();
  for (const intent of intents) {
    // Two edits to one company in one batch cannot be ordered by anything the wire carries, so the
    // batch is refused rather than resolved by array position.
    if (seen.has(intent.key)) throw new Error('Duplicate AI run edit in batch');
    seen.add(intent.key);
  }
  return intents;
}

/**
 * Is a snapshot newer than the one held? `revision` is the server's own counter, so two readings of
 * the record are ordered without trusting any device's clock. An unnumbered snapshot cannot be
 * ordered and is taken as given, as `isNewerSheet` / `isNewerWatchlist` do.
 */
export function isNewerRuns(incoming, held) {
  if (!Number.isFinite(incoming?.revision) || !Number.isFinite(held?.revision)) return true;
  return incoming.revision >= held.revision;
}
