// core/ai-mute.js — "I HAVE READ THIS ONE." A device-local mute for an AI Alerts card.
//
//   mute.hide(ticker, seenId)   stop showing this company's card
//   mute.show(ticker)           bring it back
//   mute.isHidden(ticker, id)   is it hidden RIGHT NOW, given the evidence on screen?
//   mute.count()                how many are hidden
//   mute.clear()                bring all of them back
//   mute.onChange(fn)           fires on every mutation, in this tab
//
// WHY A MUTE IS TIED TO THE EVIDENCE IT WAS GIVEN FOR, AND NOT JUST TO THE COMPANY
//   AI Alerts exists to say "this needs you today". A mute that simply hid a ticker would keep
//   hiding it after tomorrow's filing, tomorrow's block deal and tomorrow's result — the reader
//   would have silenced a company on Monday's evidence and stopped being told about Friday's, with
//   nothing on screen saying so. That is the same failure as rendering a missing value as zero:
//   an absence produced by our own bookkeeping, presented as an absence of events.
//
//   So a mute records WHICH evidence was dismissed (the card's strongest event id). The card stays
//   hidden while that is still the strongest thing the feeds hold for it, and comes back by itself
//   the moment something stronger arrives. Nothing is ever hidden for good, the count of hidden
//   cards is always on screen, and one click restores them.
//
// IT IS ALSO TIME-BOUNDED. Beyond the alert window itself the record is meaningless — the events
// it refers to have left the window — so it lapses rather than accumulating for ever.

const STORAGE_KEY = 'sattva:ai-muted:v1';
const LAPSE_MS = 7 * 24 * 60 * 60 * 1000;

const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

const normTicker = (t) => String(t ?? '').trim().toUpperCase();

let cache = null;

function read() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    raw = null;
  }
  const now = Date.now();
  const clean = {};
  for (const [ticker, entry] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!entry || typeof entry !== 'object') continue;
    const at = Date.parse(entry.at || '');
    if (!Number.isFinite(at) || now - at > LAPSE_MS) continue;
    clean[normTicker(ticker)] = { at: entry.at, seen: entry.seen == null ? null : String(entry.seen) };
  }
  cache = clean;
  return cache;
}

function write(next) {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private window or quota — the mute simply does not survive this session, which is the
    // honest degradation: nothing is hidden that the reader cannot see the count of.
  }
  emit();
}

/** Hide a company's card until its strongest evidence changes, or the window lapses. */
export function hide(ticker, seenId = null) {
  const key = normTicker(ticker);
  if (!key) return;
  write({ ...read(), [key]: { at: new Date().toISOString(), seen: seenId == null ? null : String(seenId) } });
}

/** Bring one company's card back. */
export function show(ticker) {
  const key = normTicker(ticker);
  const next = { ...read() };
  if (!(key in next)) return;
  delete next[key];
  write(next);
}

/**
 * Is this card hidden for the evidence it is currently carrying?
 *
 * `seenId` is the card's strongest event now. A different id means new evidence has overtaken what
 * the reader dismissed, so the card is shown again rather than silently suppressed.
 */
export function isHidden(ticker, seenId = null) {
  const entry = read()[normTicker(ticker)];
  if (!entry) return false;
  if (entry.seen == null) return true;
  return entry.seen === String(seenId ?? '');
}

export function count() {
  return Object.keys(read()).length;
}

export function clear() {
  if (!count()) return;
  write({});
}

export function onChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
