// core/research-sheet.js — THIS BROWSER'S COPY OF THE DESK'S RESEARCH SHEET. GLOW-OWNED.
//
//   sheet.entry(key, field)      { value, at, by, pending } or null — what the cell shows
//   sheet.value(key, field)      the value alone, or null
//   sheet.set(key, field, v, by) type a value (validated by the shared contract first)
//   sheet.clear(key, field, by)  remove it, so the cell shows its default again
//   sheet.editMany(intents)      validate and queue a fill or Undo as one local action
//   sheet.manualRows()           holdings added by hand on the Portfolio tab
//   sheet.addRow / removeRow
//   sheet.meta()                 where the copy came from and what has been confirmed about it
//   sheet.start() -> stop        keep in step with the desk while a sheet tab is open
//   sheet.freshen()              re-check now unless a check started in the last few seconds
//
// The truth is the shared sheet on the Worker (worker/research-sheet-store.mjs); this module keeps
// a copy so a cell can be painted synchronously during a render, and an OUTBOX of edits not yet
// accepted, so a value appears the moment it is typed and is never lost to a dropped connection.
// It is the shared watchlist's arrangement (core/watchlist.js) and keeps its three rules:
//
//   1. AN EDIT IS SENT AS WHAT IT WAS, never as the sheet it produced. One pending edit per cell:
//      typing 120, then 125, then clearing it is one state to send, not three to replay.
//   2. A FAILED READ IS NEVER AN EMPTY SHEET. Only a response carrying `values` is adopted; an
//      outage leaves the last copy on screen and says the copy is not confirmed.
//   3. `origin` IS DERIVED, never assigned — `live` only once a read in THIS session vouched for
//      what is painted, `pending` while the reader's own edit is unsent, `store` for bytes kept
//      from an earlier visit, `local` on a deployment with no shared sheet at all.
//
// A COLLEAGUE'S EDIT ARRIVES WITHIN TWENTY SECONDS, AND AT ONCE WHEN IT MATTERS. A sheet several
// people type into is read while they type, so it is re-checked every twenty seconds while one of
// its tabs is open and the page is visible — a third of the watchlist's minute, because a list
// changes when somebody adds a company and a sheet changes while the desk is working in it. It is
// also re-checked the moment the page is shown again or the window regains focus, and when a cell
// editor opens, so the value being edited is the desk's latest rather than this browser's last
// poll. An unchanged check is a bodyless 304 from a copy the sheet's object holds in memory, which
// is what makes the shorter interval affordable on the account's free plan.
//
// A STATIC ORIGIN IS SUPPORTED, AND IT IS SAID. Served as plain files (how the verification suite
// runs) there is no Worker: the route answers 404/405/501. Then every edit lives in this browser's
// outbox, the tab says "saved on this device only", and the first time a shared sheet answers, the
// outbox is sent to it — nothing typed offline or on a static origin is thrown away.

import { conditionalJson } from './store.js';
import { isNewerSheet, sheetIntent, SHEET_INTENT_BATCH, SHEET_REQUEST_BYTES } from '../data/research-sheet-shared.js';

const ROUTE = '/api/research-sheet';
// The device-store entry that pairs the server's bytes with its ETag (core/store.js), so an
// unchanged poll is a bodyless 304. Not in `KEYS` there: this is a Glow-owned feature and the
// shared store module stays byte-identical to the template.
const STORE_KEY = 'research-sheet:shared';
const MIRROR_KEY = 'sattva:research-sheet:v1';
const OUTBOX_KEY = 'sattva:research-sheet:outbox:v1';
const POLL_MS = 20_000;
// Focus, a cell editor opening and a returning page all ask at once; one check serves them all.
const FRESHEN_GAP_MS = 5_000;
const RETRY_MS = 30_000;
const WRITE_DELAY_MS = 600;
const NO_WORKER = new Set([404, 405, 501]);

export const UNREACHABLE = 'The shared sheet could not be reached. Your edits are kept in this browser and will be sent when it is back.';

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => { try { fn(); } catch (error) { console.error('[research-sheet] subscriber failed', error); } });

let shared = { revision: null, updatedAt: null, values: {}, rows: [] };
let mode = 'unknown';
let confirmed = false;
let checkedAt = null;
let lastError = null;
let refused = [];
let syncing = null;
let retryAt = 0;
let lastAskedAt = 0;
let writeTimer = null;
let storageFailed = false;
let memoryOutbox = null;
let outboxRaw;
let outboxList = [];
let indexedOutbox = null;
let pendingBySlot = new Map();

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    storageFailed = true;
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Private windows and a full quota: the session keeps working from memory, and `meta()` says
    // so, because "kept until you close this tab" is a different promise from "kept".
    storageFailed = true;
    return false;
  }
}

function loadMirror() {
  const held = readJson(MIRROR_KEY, null);
  if (held && typeof held.values === 'object' && held.values && Array.isArray(held.rows)) {
    shared = { revision: Number.isFinite(held.revision) ? held.revision : null, updatedAt: held.updatedAt || null, values: held.values, rows: held.rows };
  }
}
loadMirror();

const slotOf = (intent) => `${intent.key}\u0000${intent.field || '#row'}`;

function outbox() {
  if (memoryOutbox) return memoryOutbox;
  try {
    // A fill can queue hundreds of cells. Parse once per stored revision, rather than
    // reparsing the whole range for every cell painted. Reading the raw key still sees
    // edits from another tab immediately, including before its storage event arrives.
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (raw !== outboxRaw) {
      const list = raw ? JSON.parse(raw) : [];
      outboxList = Array.isArray(list) ? list.filter((i) => i && i.id && i.op && i.key) : [];
      outboxRaw = raw;
    }
    return outboxList;
  } catch { storageFailed = true; return outboxList; }
}

function writeOutbox(list) {
  if (!writeJson(OUTBOX_KEY, list)) memoryOutbox = list;
  else memoryOutbox = null;
}

function queueMany(intents) {
  const next = new Map(outbox().map((i) => [slotOf(i), i]));
  const at = new Date().toISOString();
  for (const intent of intents) {
    const slot = slotOf(intent);
    next.delete(slot);
    next.set(slot, { ...intent, id: crypto.randomUUID(), at });
  }
  writeOutbox([...next.values()]);
}

// ---- reads, all synchronous: a table reads them while it renders ----------------------------

/** What a cell shows: this browser's unsent edit first, then the shared sheet. Null means empty. */
export function entry(key, field) {
  const list = outbox();
  if (list !== indexedOutbox) {
    pendingBySlot = new Map(list.map(i => [slotOf(i), i]));
    indexedOutbox = list;
  }
  const pending = pendingBySlot.get(`${key}\u0000${field}`);
  if (pending) return pending.op === 'clear' ? null : { value: pending.value, at: pending.at, by: pending.by || null, pending: true };
  const held = shared.values?.[key]?.[field];
  return held ? { value: held.value, at: held.at || null, by: held.by || null, pending: false } : null;
}

export const value = (key, field) => entry(key, field)?.value ?? null;

/** Every company the sheet holds a value for, by key — for search and for the export. */
export function keys() {
  const out = new Set(Object.keys(shared.values || {}));
  for (const i of outbox()) if (i.field && i.op === 'set') out.add(i.key);
  return out;
}

/** Holdings added by hand, oldest first, with this browser's unsent adds and removals applied. */
export function manualRows() {
  const byKey = new Map((shared.rows || []).map((r) => [r.key, { ...r, pending: false }]));
  for (const i of outbox()) {
    if (i.op === 'remove-row') byKey.delete(i.key);
    else if (i.op === 'add-row' && !byKey.has(i.key)) byKey.set(i.key, { key: i.key, name: i.name, addedAt: i.at, addedBy: i.by || null, pending: true });
  }
  return [...byKey.values()];
}

export function meta() {
  const pending = outbox().length;
  return {
    mode,
    shared: confirmed,
    origin: mode === 'local' ? 'local' : pending ? 'pending' : confirmed ? 'live' : 'store',
    pending,
    checkedAt,
    revision: shared.revision,
    updatedAt: shared.updatedAt,
    error: [lastError, refused.length
      ? `The shared sheet is full, so ${refused.length === 1 ? 'one edit was' : `${refused.length} edits were`} not saved. Clear values the desk no longer needs and try again.`
      : null].filter(Boolean).join(' ') || null,
    storageAvailable: !storageFailed,
  };
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---- writes: local first, so the cell changes on Enter, then queued for the shared sheet -------

function edit(input) {
  return editMany([input])[0];
}

/** Validate the entire local action before queuing any cell; the existing bounded sender drains it. */
export function editMany(inputs) {
  if (!Array.isArray(inputs)) throw new Error('Invalid research edits');
  const intents = inputs.map(sheetIntent);
  if (!intents.length) return intents;
  if (new Set(intents.map(slotOf)).size !== intents.length) throw new Error('Duplicate research edit');
  queueMany(intents);
  emit();
  scheduleWrite();
  return intents;
}

// Excel uploads and drag-fill share one atomic validation and durable queue path.
export const applyEdits = editMany;

export const set = (key, field, val, by = null) => edit({ op: 'set', key, field, value: val, by });
export const clear = (key, field, by = null) => edit({ op: 'clear', key, field, by });
export const addRow = (key, name, by = null) => edit({ op: 'add-row', key, name, by });
export const removeRow = (key, by = null) => edit({ op: 'remove-row', key, by });

function scheduleWrite() {
  clearTimeout(writeTimer);
  // Several cells typed in quick succession travel together; one request, not one per Enter.
  writeTimer = setTimeout(() => { writeTimer = null; void syncNow({ force: true }); }, WRITE_DELAY_MS);
}

// ---- the shared sheet --------------------------------------------------------------------------

function adopt(snapshot) {
  if (!snapshot || typeof snapshot.values !== 'object' || !snapshot.values || !Array.isArray(snapshot.rows)) return false;
  if (!isNewerSheet(snapshot, shared)) return false;
  const changed = snapshot.revision !== shared.revision;
  shared = { revision: snapshot.revision ?? null, updatedAt: snapshot.updatedAt || null, values: snapshot.values, rows: snapshot.rows };
  if (changed) writeJson(MIRROR_KEY, shared);
  return true;
}

async function flush() {
  const attempted = new Set();
  let rejected = false;
  while (true) {
    const available = outbox().filter((i) => !attempted.has(i.id)).slice(0, SHEET_INTENT_BATCH);
    if (!available.length) return rejected;
    const encoder = new TextEncoder(), batch = [], intents = [];
    let bytes = encoder.encode(JSON.stringify({ intents: [] })).byteLength;
    for (const item of available) {
      const { op, key, field, value, name, by } = item;
      const intent = { op, key, field, value, name, by };
      const size = encoder.encode(JSON.stringify(intent)).byteLength + (intents.length ? 1 : 0);
      if (bytes + size > SHEET_REQUEST_BYTES) break;
      batch.push(item); intents.push(intent); bytes += size;
    }
    if (!batch.length) throw new Error('A saved research edit exceeds the request size.');
    for (const i of batch) attempted.add(i.id);
    const response = await fetch(ROUTE, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // `at` is this browser's note to itself for the optimistic paint; the server stamps the time
      // it accepted the edit, for the reason the watchlist gives.
      body: JSON.stringify({ intents }),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 400) {
      // A batch the server's contract refuses will be refused for ever; holding it would block
      // every later edit behind it. It is dropped and said, never silently.
      const ids = new Set(batch.map((i) => i.id));
      writeOutbox(outbox().filter((i) => !ids.has(i.id)));
      rejected = true;
      continue;
    }
    if (!response.ok) throw new Error(`research-sheet ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || typeof body.values !== 'object') throw new Error('Invalid research sheet response');
    // Re-read the CURRENT queue after the await: the reader may have typed again meanwhile, and
    // only the exact acknowledged edit leaves the queue — its replacement carries a new id.
    const done = new Set();
    const full = [];
    for (const outcome of body.outcomes || []) {
      const intent = batch.find((i) => slotOf(i) === slotOf(outcome));
      if (!intent) continue;
      done.add(intent.id);
      if (outcome.outcome === 'full') full.push(intent);
    }
    writeOutbox(outbox().filter((i) => !done.has(i.id)));
    refused = [...refused.filter((r) => !batch.some((i) => slotOf(i) === slotOf(r))), ...full];
    shared = { ...shared, revision: null }; // a write's answer always supersedes what we held
    adopt(body);
  }
}

/**
 * Revalidate against the shared sheet and send anything queued. One pass in flight at a time:
 * both tabs, the poller and a returning tab can all ask at once.
 */
export function syncNow({ force = false } = {}) {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (syncing) return syncing;
  if (!force && Date.now() < retryAt) return Promise.resolve(meta());
  lastAskedAt = Date.now();
  syncing = (async () => {
    try {
      const read = await conditionalJson(ROUTE, { key: STORE_KEY, optional: true });
      if (!read?.value) {
        confirmed = false;
        // THREE ABSENCES, AND ONLY ONE IS A FAULT. A route that is not there (404), a static server
        // refusing the method (405/501) — this deployment has no shared sheet, which is supported
        // and is said as "this device only" — and anything else, which is an outage to retry.
        if (NO_WORKER.has(read?.status)) {
          mode = 'local';
          lastError = null;
        } else {
          lastError = UNREACHABLE;
          retryAt = Date.now() + RETRY_MS;
        }
        return meta();
      }
      if (read.value.ok !== true) throw new Error(read.value.reason || 'sheet-unavailable');
      mode = 'shared';
      adopt(read.value);
      const rejected = outbox().length ? await flush() : false;
      checkedAt = read.checkedAt || Date.now();
      confirmed = true;
      lastError = rejected ? 'The shared sheet refused an edit as invalid, so it was not saved. Reload the page and type it again.' : null;
      retryAt = 0;
      return meta();
    } catch {
      // A failed re-check is not a failed read: the copy on screen is real and stays.
      confirmed = false;
      lastError = UNREACHABLE;
      retryAt = Date.now() + RETRY_MS;
      return meta();
    } finally {
      syncing = null;
      emit();
    }
  })();
  return syncing;
}

/**
 * Re-check the shared sheet now, unless a check began a moment ago — for the moments a reader is
 * about to look at a value (a cell editor opening, the window coming back into focus).
 */
export function freshen() {
  if (Date.now() - lastAskedAt < FRESHEN_GAP_MS) return syncing || Promise.resolve(meta());
  return syncNow();
}

let starts = 0;
let stopPoll = null;

/** Keep the copy in step with the desk while a sheet tab is open. Ref-counted: two tabs, one poll. */
export function start() {
  starts++;
  if (!stopPoll) {
    const tick = () => {
      if (document.hidden || navigator.onLine === false) return;
      void syncNow();
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => { if (!document.hidden) void syncNow({ force: true }); };
    // A window that was visible behind another app fires no visibilitychange when it comes back.
    const onFocus = () => { if (!document.hidden) void freshen(); };
    const onOnline = () => void syncNow({ force: true });
    // Another tab of this browser edited the sheet: re-read the copy it wrote, not the network.
    const onStorage = (event) => {
      if (event.key === MIRROR_KEY) { loadMirror(); emit(); }
      else if (event.key === OUTBOX_KEY) emit();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('storage', onStorage);
    stopPoll = () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('storage', onStorage);
      stopPoll = null;
    };
  }
  void syncNow({ force: true });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    starts = Math.max(0, starts - 1);
    // A pending edit is still sent after the tab closes: the write timer is module state and is
    // never cancelled here, so leaving the tab straight after Enter loses nothing.
    if (!starts) stopPoll?.();
  };
}

/** For the tests: forget everything this module holds in memory (storage is the caller's). */
export function resetForTests() {
  shared = { revision: null, updatedAt: null, values: {}, rows: [] };
  mode = 'unknown'; confirmed = false; checkedAt = null; lastError = null; refused = []; retryAt = 0; lastAskedAt = 0;
  memoryOutbox = null; storageFailed = false;
  outboxRaw = undefined; outboxList = []; indexedOutbox = null; pendingBySlot = new Map();
  loadMirror();
}
