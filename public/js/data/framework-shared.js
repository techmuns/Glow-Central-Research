// data/framework-shared.js — THE ONE DEFINITION OF THE DESK'S FRAMEWORK SCORING FIELDS. GLOW-OWNED.
//
// The Framework worksheet scores each company on the desk's rubric: five criteria at 0/1/2 with a
// one-line rationale each, plus a Governance Pass/Fail GATE. Those judgements are typed by the desk
// and shared across it, exactly like the Portfolio/Watchlist research sheet — so this store follows
// that contract (data/research-sheet-shared.js): an edit is an INTENT applied to the record as it is
// now, never a whole record written back (which would silently delete a colleague's edit); a missing
// value is never a zero; times and the revision counter are the server's.
//
// The field model is CRITERION-AGNOSTIC on purpose: the rubric lives in public/data/framework.json
// (built from the workbook), so the five criteria are DATA, not hardcoded here. A field id is
// `score:<criterion>` (0/1/2), `why:<criterion>` (its rationale), `gate` (pass/fail) or a small set
// of typed text columns. The store validates the VALUE by kind and the criterion only as a safe
// slug; which criteria exist is the tab's business, read from framework.json.
//
// Pure and dependency-free apart from the watchlist contract it shares its symbol and person rules
// with, so worker/framework-store.mjs applies the identical validation the browser does.

import { SYMBOL_RE, normTicker, personName } from './watchlist-shared.js';

export const FRAMEWORK_OBJECT = 'framework:v1';

// Bounds — ceilings on what one request or deployment may cost, never a judgement about how many
// companies a desk should score.
export const FW_REQUEST_BYTES = 32768;
export const FW_INTENT_BATCH = 60;
export const FW_COMPANY_LIMIT = 1200; // 338 today, room to grow
export const FW_FIELDS_PER_COMPANY = 48; // 5 criteria × (score+why) + gate + a few text columns

// A company key is its NSE symbol (the identity the watchlist star uses) or, for a line no feed
// places, `name:<slug>` — the exact keys framework.json emits, so a key is stable across rebuilds.
const NAME_KEY_RE = /^name:[a-z0-9-]{1,48}$/;
export function frameworkKey(value) {
  const text = String(value ?? '').trim();
  if (NAME_KEY_RE.test(text)) return text;
  const up = normTicker(text);
  return SYMBOL_RE.test(up) ? up : null;
}

// Field ids. `score:` and `why:` carry the criterion slug; `gate` is the one Pass/Fail; the three
// text columns mirror the workbook's output template (Industry, Summary, and a free note).
const SCORE_RE = /^score:[a-z0-9][a-z0-9-]{0,47}$/;
const WHY_RE = /^why:[a-z0-9][a-z0-9-]{0,47}$/;
const TEXT_MAX = { industry: 120, summary: 400, note: 600 };
const WHY_MAX = 600;

export const isField = (field) => {
  const f = String(field ?? '');
  return f === 'gate' || SCORE_RE.test(f) || WHY_RE.test(f) || Object.hasOwn(TEXT_MAX, f);
};

// Strip control characters by code point (same rule as the watchlist/research contracts), so this
// file carries none itself. Every text value arriving here is somebody's typing.
const printable = (value) =>
  String(value ?? '')
    .split('')
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('');

const text = (raw, max) => {
  const out = printable(raw).replace(/\s+/g, ' ').trim();
  if (!out) throw new Error('Invalid framework value');
  return out.slice(0, max);
};

/**
 * One field's value as the wire carries it, validated. Throws rather than storing something the
 * caller did not mean: a score that silently became 0 would read as a deliberate "weak" judgement.
 */
export function fieldValue(field, raw) {
  const f = String(field ?? '');
  if (f === 'gate') {
    const v = String(raw ?? '').toLowerCase().trim();
    if (v !== 'pass' && v !== 'fail') throw new Error('Invalid framework value');
    return v;
  }
  if (SCORE_RE.test(f)) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 2) throw new Error('Invalid framework value');
    return raw;
  }
  if (WHY_RE.test(f)) return text(raw, WHY_MAX);
  if (Object.hasOwn(TEXT_MAX, f)) return text(raw, TEXT_MAX[f]);
  throw new Error('Invalid framework field');
}

/**
 * One edit, validated.
 *   { op: 'set',   key, field, value, by? }   type a score / rationale / gate / text into a cell
 *   { op: 'clear', key, field, by? }          remove what was typed, so the cell is unscored again
 *
 * No row ops: the company list is the workbook (framework.json), not something a device adds to. `by`
 * is optional exactly as on the research sheet — a cell edit is a small act, recorded with a name
 * when the device has one and never attributed to somebody else when it does not.
 */
export function frameworkIntent(input) {
  const op = String(input?.op ?? '');
  if (!['set', 'clear'].includes(op)) throw new Error('Invalid framework operation');
  const key = frameworkKey(input?.key);
  if (!key) throw new Error('Invalid framework company');
  const field = String(input?.field ?? '');
  if (!isField(field)) throw new Error('Invalid framework field');
  const by = personName(input?.by) || null;
  if (op === 'clear') return { op, key, field, by };
  return { op, key, field, value: fieldValue(field, input?.value), by };
}

/** A whole batch, refusing one that is empty, oversized or self-contradictory. */
export function frameworkIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > FW_INTENT_BATCH) throw new Error('Invalid framework batch');
  const intents = input.map(frameworkIntent);
  const seen = new Set();
  for (const intent of intents) {
    // Two edits to one cell in one batch cannot be ordered by anything the wire carries, so the
    // batch is refused rather than resolved by array position.
    const slot = `${intent.key}\u0000${intent.field}`;
    if (seen.has(slot)) throw new Error('Duplicate framework edit in batch');
    seen.add(slot);
  }
  return intents;
}

/** Two values are the same cell content — so re-saving what is there is not an edit. */
export const sameValue = (a, b) => a === b;

/**
 * Is a snapshot newer than the one held? `revision` is the server's own counter, so two readings of
 * one record are ordered without trusting any device's clock. An unnumbered snapshot cannot be
 * ordered and is taken as given.
 */
export function isNewerFramework(incoming, held) {
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
