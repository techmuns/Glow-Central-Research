// data/peer-list-shared.js — THE ONE DEFINITION OF A SHARED PEER / COMPETITOR LINK (#312).
//
// Pure and dependency-free, so `worker/peer-list-store.mjs` imports the identical rules the browser
// applies — the same arrangement, and the same reason, as `watchlist-shared.js`: the edge and the
// page must not be able to drift about what a company is, what a peer is, or which of two
// conflicting edits happened last.
//
// WHAT THIS IS
//   The desk's editable map of who each company's peers / competitors are. The curated themes in
//   `theme-exposures.js` connect companies through a market they both sell into; this connects them
//   as direct rivals, and — unlike that reviewed, committed map — the family edits it at runtime.
//   The list is the data layer; a later phase (#313) reads it to surface a peer's news beside a
//   company, under the same "indirect is never direct" honesty rules the themes follow.
//
// WHY IT IS SHARED, NOT PER-BROWSER
//   The same reason the watchlist is: "who are this company's competitors" is one desk's answer, not
//   one laptop's. A device-local list would give two people at one desk two different maps and say
//   so to neither. So the shared list is the truth and each device keeps a copy that never pretends
//   to be it (`core/peer-list.js` reports live / store / pending, never one "connected").
//
// WHY AN EDIT IS AN INTENT, NOT A LIST
//   PUT-the-whole-array silently deletes: a device that loaded a company's peers an hour ago and
//   adds one would write its stale set over everything anyone else added since. So a device sends
//   what it DID — add this peer for this company, remove that one — and the server applies it to
//   whatever the list is now. Two people editing different companies', or different peers of one
//   company, never lose each other's edit.

import { SYMBOL_RE, normTicker, companyName } from './watchlist-shared.js';

export { SYMBOL_RE, normTicker, companyName } from './watchlist-shared.js';
export const isSymbolShaped = (value) => SYMBOL_RE.test(normTicker(value));

// Bounds — every one a ceiling on what a request may cost, never an editorial judgement. A peer set
// is a handful of rivals; the per-company cap is generous and the request cap is small.
export const PEER_PER_COMPANY_LIMIT = 40;
export const PEER_COMPANY_LIMIT = 3000;
export const PEER_INTENT_BATCH = 50;
export const PEER_TOMBSTONE_LIMIT = 2000;
export const PEER_REQUEST_BYTES = 16384;
export const PEER_NAME_MAX = 200;

/** The dedupe key for one directed link, so a batch cannot carry the same edit twice. */
export const peerLinkKey = (company, peer) => `${normTicker(company)}|${normTicker(peer)}`;

/**
 * One edit, validated. Throws rather than silently dropping a field the caller meant to send.
 * `add` attaches a peer to a company; `remove` detaches it. A company is never its own peer, and
 * a peer carries a display NAME so the list can name it where a feed does not (printing the symbol
 * where a name belongs would be inventing one — the error this codebase is built to avoid).
 */
export function peerIntent(input) {
  const op = String(input?.op ?? '');
  if (!['add', 'remove'].includes(op)) throw new Error('Invalid peer operation');
  const company = normTicker(input?.company);
  const peer = normTicker(input?.peer);
  if (!SYMBOL_RE.test(company)) throw new Error('Invalid peer company');
  if (!SYMBOL_RE.test(peer)) throw new Error('Invalid peer');
  if (company === peer) throw new Error('A company cannot be its own peer');
  return { op, company, peer, name: companyName(input?.name) };
}

/** Validate a whole batch, rejecting one that is empty, oversized or self-contradictory. */
export function peerIntents(input) {
  if (!Array.isArray(input) || !input.length || input.length > PEER_INTENT_BATCH) throw new Error('Invalid peer batch');
  const intents = input.map(peerIntent);
  const seen = new Set();
  for (const intent of intents) {
    const key = peerLinkKey(intent.company, intent.peer);
    // Two edits to one (company, peer) link in one batch cannot be ordered by anything the wire
    // carries, so the batch is refused rather than resolved by arrival order.
    if (seen.has(key)) throw new Error('Duplicate link in peer batch');
    seen.add(key);
  }
  return intents;
}

/** Reader-facing shape of one peer of a company. */
export function peerEntry(row) {
  return {
    peer: normTicker(row?.peer),
    name: companyName(row?.name),
    addedAt: row?.addedAt || row?.added_at || null,
  };
}

/**
 * Is a snapshot newer than the one already held? `revision` is the server's own counter, so this
 * orders two readings of the SAME shared list without trusting any device's clock. An unnumbered
 * snapshot cannot be ordered and is taken as given.
 */
export function isNewerPeerList(incoming, held) {
  if (!Number.isFinite(incoming?.revision) || !Number.isFinite(held?.revision)) return true;
  return incoming.revision >= held.revision;
}
