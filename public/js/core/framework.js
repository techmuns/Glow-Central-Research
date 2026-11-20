// core/framework.js — THE BROWSER HALF OF THE SHARED FRAMEWORK SCORES. GLOW-OWNED.
//
// The desk's 0/1/2 scores, rationales and Governance gate live on the shared store (/api/framework);
// this module is the transport and the device's own working copy. It follows the shared watchlist /
// research-sheet rules so the Framework tab inherits their honesty:
//   • an EDIT is an intent, applied optimistically here and POSTed for the server to apply to the
//     record as it now is — never a whole record written back, which would delete a colleague's edit;
//   • a FAILED read is never an empty record — it keeps whatever the device already holds, and the
//     `origin` says whether what is shown was confirmed this session (`live`), kept from an earlier
//     visit (`store`) or only typed here and not yet shared (`local`);
//   • it never throws: a static origin (no Worker) or an outage degrades to the device copy.
//
// Validation is the shared contract's (frameworkIntent), so the browser cannot queue something the
// server would refuse.

import { frameworkIntent, isNewerFramework } from '../data/framework-shared.js';

const API = '/api/framework';
const MIRROR = 'glow:framework:v1';
const OUTBOX = 'glow:framework:outbox:v1';

let server = { values: {}, revision: 0, updatedAt: null }; // last snapshot we trust
let outbox = []; // intents typed here but not yet confirmed by the server
let origin = 'empty'; // 'live' | 'store' | 'local' | 'empty'
let confirmed = false; // a GET succeeded this session
let started = false;

const listeners = new Set();
export const onFrameworkChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.error('[framework] listener failed', err); } } };

const readLS = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const writeLS = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off; the choice still holds for this visit */ } };

function deriveOrigin() {
  if (confirmed) origin = 'live';
  else if (Object.keys(server.values).length) origin = 'store';
  else if (outbox.length) origin = 'local';
  else origin = 'empty';
}

function adopt(snapshot) {
  if (!snapshot || !isNewerFramework(snapshot, server)) return;
  server = { values: snapshot.values || {}, revision: snapshot.revision || 0, updatedAt: snapshot.updatedAt || null };
  writeLS(MIRROR, server);
}

// Drop outbox intents the server has now accounted for: once a GET/POST returns a revision at or
// past the one an intent was sent under, the shared record carries it (or deliberately does not, if a
// colleague overwrote it), and keeping it would re-apply a stale edit over newer truth.
function pruneOutbox() {
  outbox = outbox.filter((i) => !Number.isFinite(i.sentRevision) || i.sentRevision > server.revision);
  writeLS(OUTBOX, outbox);
}

export async function loadFramework() {
  if (!started) {
    started = true;
    const mirror = readLS(MIRROR);
    if (mirror && mirror.values) server = { values: mirror.values, revision: mirror.revision || 0, updatedAt: mirror.updatedAt || null };
    const saved = readLS(OUTBOX);
    if (Array.isArray(saved)) outbox = saved.filter((i) => i && i.op);
  }
  try {
    const res = await fetch(API, { headers: { accept: 'application/json' }, cache: 'no-cache' });
    if (res.ok && /application\/json/i.test(res.headers.get('content-type') || '')) {
      const data = await res.json();
      if (data && data.ok === true && data.values) { confirmed = true; adopt(data); pruneOutbox(); await flush(); }
    }
  } catch { /* keep the device copy; a failed read is never an empty record */ }
  deriveOrigin();
  emit();
  return record();
}

// Push any queued edits the server has not confirmed. Fire-and-forget; a failure keeps them queued.
async function flush() {
  if (!outbox.length) return;
  const batch = outbox.slice(0, 60).map(({ op, key, field, value, by }) => ({ op, key, field, ...(value !== undefined ? { value } : {}), by }));
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intents: batch }) });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (data && data.ok === true) { confirmed = true; adopt(data); pruneOutbox(); }
  } catch { /* stays queued for the next load/refresh */ }
}

/**
 * Apply a batch of edits: optimistic here at once, then shared. Each input is validated by the
 * shared contract (so the queue can never hold something the server would refuse) and tagged with
 * the revision it was sent under. Returns true when the shared store accepted them this call.
 */
export async function editFramework(intents) {
  const parsed = (Array.isArray(intents) ? intents : [intents]).map(frameworkIntent);
  const at = new Date().toISOString();
  for (const intent of parsed) {
    // One pending edit per (key,field): a newer edit replaces an older unsent one.
    outbox = outbox.filter((i) => !(i.key === intent.key && i.field === intent.field));
    outbox.push({ ...intent, at, sentRevision: server.revision + 1 });
  }
  writeLS(OUTBOX, outbox);
  deriveOrigin();
  emit();
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intents: parsed }) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.ok === true) { confirmed = true; adopt(data); pruneOutbox(); deriveOrigin(); emit(); return true; }
    }
  } catch { /* stays queued */ }
  deriveOrigin();
  emit();
  return false;
}

export const refreshFramework = () => loadFramework();

// The effective cell: the newest pending edit for it, else the shared value. `pending` marks a value
// typed here that the server has not confirmed; `by`/`at` are the shared record's own.
function cell(key, field) {
  for (let i = outbox.length - 1; i >= 0; i--) {
    const o = outbox[i];
    if (o.key === key && o.field === field) {
      return o.op === 'clear' ? null : { value: o.value, by: o.by || null, at: o.at, pending: true };
    }
  }
  const entry = server.values?.[key]?.[field];
  return entry ? { value: entry.value, by: entry.by || null, at: entry.at || null, pending: false } : null;
}

export function record() {
  return {
    origin,
    revision: server.revision,
    updatedAt: server.updatedAt,
    /** The value in a cell, or null if unscored. */
    valueFor: (key, field) => cell(key, field)?.value ?? null,
    /** The whole cell ({ value, by, at, pending }) or null. */
    cellFor: (key, field) => cell(key, field),
  };
}
