// core/peer-list.js — WHO EACH COMPANY'S PEERS / COMPETITORS ARE. ONE MAP, EVERY DEVICE.
//
//   peerList.peersOf(company)        [{ peer, name, addedAt }] for one company, newest first
//   peerList.companies()             Set of companies that have at least one peer
//   peerList.isPeer(company, peer)   is this link set?
//   peerList.countFor(company)       how many peers that company has
//   peerList.allLinks()              every active link, flat
//   peerList.addPeer(c, p, name)     attach a peer to a company, returns whether it is now set
//   peerList.removePeer(c, p)        detach one, returns whether anything changed
//   peerList.meta()                  where the map on screen came from, and whether it is confirmed
//   peerList.onChange(fn)            fires on every mutation, in this tab
//   peerList.syncNow()               revalidate against the shared map and flush queued edits
//
// This is the editable twin of `data/theme-exposures.js`. That map is a reviewed, committed set of
// markets two companies both sell into; this one is the desk's own list of DIRECT rivals, edited at
// runtime. A later phase (#313/#314) reads it to surface a peer's news beside a company, under the
// same "indirect is never direct" honesty the themes follow.
//
// IT IS THE WATCHLIST'S ARRANGEMENT, DELIBERATELY LIGHTER.
//   The shared map lives on the Worker (`/api/peer-lists`, `worker/peer-list-store.mjs`); this file
//   keeps a device copy that paints while the network is asked and survives an outage. Three things
//   are carried over from `core/watchlist.js` because they are the honesty of a shared list, and
//   they are not negotiable:
//     * `meta().origin` is DERIVED — `live` only once the server confirmed what is on screen IN THIS
//       SESSION, `store` for bytes kept from an earlier visit, `pending` while this device's own edit
//       has not been accepted. Never one "connected" over a map nobody checked.
//     * an edit is sent as an INTENT (add this, remove that), never as the whole list — a stale whole
//       list would silently delete everything anyone else added since this tab last read.
//     * a FAILED READ IS NEVER AN EMPTY MAP — `adopt()` runs only on a response that carried links; a
//       503, an aborted fetch and a static origin with no Worker all leave the map as it was.
//   What is NOT carried over, because this feature has no history to protect: the contributor roster
//   (a peer has a display name, not an "added by"), the legacy row-key migration, and the `seed` that
//   walks a pre-existing device list onto the server. A first-run peer map is simply empty.

import { conditionalJson, KEYS } from './store.js';
import {
  PEER_INTENT_BATCH, PEER_PER_COMPANY_LIMIT, SYMBOL_RE,
  companyName, isNewerPeerList, isSymbolShaped, normTicker, peerIntent, peerLinkKey,
} from '../data/peer-list-shared.js';

const STORAGE_KEY = 'sattva:peer-lists';
const OUTBOX_KEY = 'sattva:peer-lists:outbox';
const REJECTED_KEY = 'sattva:peer-lists:rejected';
const ROUTE = 'api/peer-lists';

// The map changes when a person curates a company's rivals — rarely, and never in a burst the way a
// screener produces stars. So the poll is the safety net for what somebody else did on another
// device, the write-through is the mechanism, and the debounce only folds a flurry of edits to one
// company into a single request.
const POLL_MS = 60000;
const RETRY_MS = 15000;
const WRITE_DEBOUNCE_MS = 400;

const UNREACHABLE =
  'The shared peer lists could not be reached. Your changes are saved on this device and will be sent when it is.';

export { SYMBOL_RE, isSymbolShaped, PEER_PER_COMPANY_LIMIT };

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

let shared = { revision: null, updatedAt: null };
let checkedAt = null;   // when the server last confirmed what is on screen, in this session
let confirmed = false;  // has a read in THIS session vouched for the painted map?
let lastError = null;
let syncing = null;
let retryAt = 0;
let writeTimer = null;

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void syncNow({ force: true });
  }, WRITE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------------------------
// Storage, with a session fallback. A denied or full localStorage must never cost an edit or make
// the next read fall back to an empty map: when a write cannot reach disk the session copy becomes
// authoritative and `meta()` says storage is unavailable. This is lighter than the watchlist's
// cross-tab merge — a second tab's edit is picked up by the poll and a `storage` event re-emits —
// which is enough for a map the desk curates occasionally rather than clicks through.

const sessionValues = new Map();
const pendingStorage = new Set();
const failedStorageReads = new Set();

function storedValue(key) {
  if (pendingStorage.has(key)) return sessionValues.get(key) ?? null;
  try {
    const value = localStorage.getItem(key);
    sessionValues.set(key, value);
    failedStorageReads.delete(key);
    return value;
  } catch {
    failedStorageReads.add(key);
    return sessionValues.get(key) ?? null;
  }
}

function saveValue(key, value) {
  sessionValues.set(key, value);
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    pendingStorage.delete(key);
    failedStorageReads.delete(key);
  } catch {
    // Keep it in the session copy and mark it outstanding; the next write retries.
    pendingStorage.add(key);
  }
}

function parseArray(raw) {
  try {
    const parsed = JSON.parse(raw || 'null');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// The device copy of the map. Reads are synchronous because a view asks for a company's peers
// during its render.

function readLinks() {
  const out = [];
  const seen = new Set();
  for (const row of parseArray(storedValue(STORAGE_KEY))) {
    const company = normTicker(row?.company);
    const peer = normTicker(row?.peer);
    if (!SYMBOL_RE.test(company) || !SYMBOL_RE.test(peer) || company === peer) continue;
    const key = peerLinkKey(company, peer);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ company, peer, name: companyName(row?.name), addedAt: row?.addedAt || row?.added_at || null });
  }
  return out;
}

function writeLinks(links) {
  saveValue(STORAGE_KEY, links.length ? JSON.stringify(links) : null);
}

// ---------------------------------------------------------------------------------------------
// The outbox — edits this device has made and the shared map has not accepted yet. Persisted, so a
// closed tab or a dropped tunnel does not lose somebody's edit.

function outbox() {
  return parseArray(storedValue(OUTBOX_KEY)).filter((intent) => {
    try { peerIntent(intent); return true; } catch { return false; }
  });
}

function writeOutbox(list) {
  saveValue(OUTBOX_KEY, list.length ? JSON.stringify(list) : null);
}

function identifiedOutbox() {
  const list = outbox();
  if (list.some((intent) => !intent.id)) {
    const identified = list.map((intent) => (intent.id ? intent : { ...intent, id: crypto.randomUUID() }));
    writeOutbox(identified);
    return identified;
  }
  return list;
}

function queue(intent) {
  // One pending edit per link: add, remove, add again is one state to send, not three to replay.
  const key = peerLinkKey(intent.company, intent.peer);
  const next = outbox().filter((i) => peerLinkKey(i.company, i.peer) !== key);
  next.push({ ...intent, id: crypto.randomUUID(), at: new Date().toISOString() });
  writeOutbox(next);
}

const rejected = () => parseArray(storedValue(REJECTED_KEY));
function writeRejected(list) {
  saveValue(REJECTED_KEY, list.length ? JSON.stringify(list) : null);
}

// ---------------------------------------------------------------------------------------------
// Reads.

/** The peers of one company, most recently added first. */
export function peersOf(company) {
  const c = normTicker(company);
  if (!SYMBOL_RE.test(c)) return [];
  return readLinks()
    .filter((link) => link.company === c)
    .map((link) => ({ peer: link.peer, name: link.name, addedAt: link.addedAt }))
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

/** Every company that has at least one peer. */
export function companies() {
  return new Set(readLinks().map((link) => link.company));
}

export function isPeer(company, peer) {
  const c = normTicker(company);
  const p = normTicker(peer);
  return !!c && !!p && readLinks().some((link) => link.company === c && link.peer === p);
}

export function countFor(company) {
  return peersOf(company).length;
}

/** Every active link, flat — for anything that needs the whole map rather than one company's slice. */
export function allLinks() {
  return readLinks();
}

/**
 * Where the map on screen came from, and what has actually been confirmed about it. `origin` is
 * DERIVED, never assigned — the same rule, and the same reason, as the watchlist and the filings
 * feeds: a field several call sites can write is a field that reads `live` over bytes nobody checked.
 */
export function meta() {
  const count = readLinks().length;
  const pending = outbox().length;
  const refused = rejected();
  const storageUnavailable = pendingStorage.size > 0 || failedStorageReads.size > 0;
  const capacityError = refused.length
    ? `A company's peer list is full, so ${refused.map((e) => `${normTicker(e.peer)} (for ${normTicker(e.company)})`).join(', ')} could not be added. Remove a peer and try again.`
    : null;
  const storageError = storageUnavailable
    ? 'Browser storage is unavailable. This tab keeps a temporary copy; keep it open while changes are pending.'
    : null;
  return {
    shared: confirmed,
    origin: pending ? 'pending' : confirmed ? 'live' : 'store',
    checkedAt,
    revision: shared.revision,
    updatedAt: shared.updatedAt,
    pending,
    error: [lastError, capacityError, storageError].filter(Boolean).join(' ') || null,
    storageAvailable: !storageUnavailable,
    rejected: refused,
    count,
  };
}

// ---------------------------------------------------------------------------------------------
// Writes. Local first so the editor updates on the click, then queued for the shared map.

export function addPeer(company, peer, name = null) {
  let intent;
  try { intent = peerIntent({ op: 'add', company, peer, name }); } catch { return false; }
  const links = readLinks();
  const key = peerLinkKey(intent.company, intent.peer);
  const hit = links.find((link) => peerLinkKey(link.company, link.peer) === key);
  if (hit) {
    // Re-adding a rival already set is not an event, but a NAME arriving for a link that had none is
    // worth keeping — that is how a link added from a feed with no company name acquires one.
    const nextName = hit.name || companyName(name);
    if (nextName !== hit.name) {
      hit.name = nextName;
      queue(intent);
      writeLinks(links);
      emit();
      scheduleWrite();
    }
    return true;
  }
  // The per-company ceiling is mirrored here so the editor can refuse before a round trip; the
  // server enforces it too, and a refusal that slips through comes back as a `full` outcome.
  if (links.filter((link) => link.company === intent.company).length >= PEER_PER_COMPANY_LIMIT) return false;
  links.push({ company: intent.company, peer: intent.peer, name: intent.name, addedAt: new Date().toISOString() });
  queue(intent);
  writeLinks(links);
  emit();
  scheduleWrite();
  return true;
}

export function removePeer(company, peer) {
  let intent;
  try { intent = peerIntent({ op: 'remove', company, peer }); } catch { return false; }
  const links = readLinks();
  const key = peerLinkKey(intent.company, intent.peer);
  const next = links.filter((link) => peerLinkKey(link.company, link.peer) !== key);
  if (next.length === links.length) return false;
  queue(intent);
  writeLinks(next);
  emit();
  scheduleWrite();
  return true;
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ---------------------------------------------------------------------------------------------
// The shared map.

/**
 * Replace the device copy with the shared map, then re-apply this device's un-accepted edits — so a
 * peer added a moment ago does not flicker off while the server has not been told about it yet.
 */
function adopt(snapshot) {
  if (!Array.isArray(snapshot?.links)) return false;
  if (!isNewerPeerList(snapshot, shared)) return false;
  const byKey = new Map();
  for (const row of snapshot.links) {
    const company = normTicker(row?.company);
    const peer = normTicker(row?.peer);
    if (!SYMBOL_RE.test(company) || !SYMBOL_RE.test(peer) || company === peer) continue;
    byKey.set(peerLinkKey(company, peer), {
      company, peer, name: companyName(row?.name), addedAt: row?.addedAt || row?.added_at || null,
    });
  }
  const refused = rejected();
  const unresolved = refused.filter((e) => !byKey.has(peerLinkKey(e.company, e.peer)));
  if (unresolved.length !== refused.length) writeRejected(unresolved);
  for (const intent of outbox()) {
    const key = peerLinkKey(intent.company, intent.peer);
    if (intent.op === 'remove') byKey.delete(key);
    else if (!byKey.has(key)) {
      byKey.set(key, {
        company: intent.company, peer: intent.peer, name: companyName(intent.name), addedAt: intent.at || new Date().toISOString(),
      });
    }
  }
  shared = { revision: snapshot.revision ?? null, updatedAt: snapshot.updatedAt || null };
  writeLinks([...byKey.values()]);
  return true;
}

async function flush() {
  const attempted = new Set();
  while (true) {
    const batch = identifiedOutbox().filter((intent) => !attempted.has(intent.id)).slice(0, PEER_INTENT_BATCH);
    if (!batch.length) break;
    for (const intent of batch) attempted.add(intent.id);
    const response = await fetch(ROUTE, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ intents: batch.map(({ op, company, peer, name }) => ({ op, company, peer, name })) }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`peer-lists ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || !Array.isArray(body.links)) throw new Error('Invalid peer-lists response');
    // Re-read the CURRENT queue after the await; only the exact acknowledged edits leave it.
    const done = new Set((body.outcomes || []).map((o) => peerLinkKey(o.company, o.peer)));
    const acknowledged = new Set(batch.filter((intent) => done.has(peerLinkKey(intent.company, intent.peer))).map((intent) => intent.id));
    writeOutbox(outbox().filter((intent) => !acknowledged.has(intent.id)));
    const refusals = new Map(rejected().map((e) => [peerLinkKey(e.company, e.peer), e]));
    for (const outcome of body.outcomes || []) {
      const key = peerLinkKey(outcome.company, outcome.peer);
      const intent = batch.find((i) => peerLinkKey(i.company, i.peer) === key);
      if (!intent) continue;
      // A peer refused for capacity must read as refused, never as added — otherwise a device would
      // show a rival it does not have. `unchanged` is a race, not a refusal, and clears any mark.
      if (outcome.outcome === 'full') refusals.set(key, { company: intent.company, peer: intent.peer, name: intent.name });
      else refusals.delete(key);
    }
    writeRejected([...refusals.values()]);
    shared = { revision: null, updatedAt: null }; // a write always supersedes what we held
    adopt(body);
  }
  return true;
}

/**
 * Revalidate against the shared map and send anything queued. One in flight at a time: the editor,
 * the poller and a returning tab can all ask at once, and three reads of one small map races itself.
 */
export function syncNow({ force = false } = {}) {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (syncing) return syncing;
  if (!force && Date.now() < retryAt) return Promise.resolve(meta());
  syncing = Promise.resolve().then(async () => {
    try {
      await flush();
      const read0 = await conditionalJson(ROUTE, { key: KEYS.peerLists, optional: true });
      if (!read0 || !read0.value) {
        confirmed = false;
        // 404 is a deployment that serves no Worker — a supported way to run the dashboard, and not
        // a fault. Any other absence (0 = never completed, or a server that answered badly) is.
        lastError = read0?.status === 404 ? null : UNREACHABLE;
        retryAt = Date.now() + RETRY_MS;
        return meta();
      }
      if (read0.value.ok === false) throw new Error(read0.value.reason || 'peer-lists-unavailable');
      if (outbox().length) await flush();
      adopt(read0.value);
      checkedAt = read0.checkedAt || Date.now();
      confirmed = true;
      retryAt = 0;
      lastError = null;
      return meta();
    } catch {
      // A failed re-check is not a failed read: the map on screen is a real map and stays.
      confirmed = false;
      lastError = UNREACHABLE;
      retryAt = Date.now() + RETRY_MS;
      return meta();
    } finally {
      syncing = null;
      emit();
    }
  });
  return syncing;
}

let stopPoll = null;

/** Keep the map in step with whatever anyone else is doing, while this tab is visible. */
export function startPeerSync() {
  if (stopPoll) return stopPoll;
  const tick = () => {
    if (document.hidden || innerWidth === 0 || navigator.onLine === false) return;
    void syncNow();
  };
  const timer = setInterval(tick, POLL_MS);
  const onVisible = () => {
    if (!(document.hidden || innerWidth === 0)) void syncNow({ force: true });
  };
  const onOnline = () => void syncNow({ force: true });
  const onStorage = (event) => {
    if ([STORAGE_KEY, OUTBOX_KEY, REJECTED_KEY].includes(event.key)) emit();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('storage', onStorage);
  void syncNow({ force: true });
  stopPoll = () => {
    clearTimeout(writeTimer);
    writeTimer = null;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('storage', onStorage);
    stopPoll = null;
  };
  return stopPoll;
}
