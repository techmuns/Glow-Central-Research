<<<<<<< HEAD
=======
import { boundedJson } from '../public/js/data/family-book-contract.js';
import { openaiConfigured } from './newsletter-openai.mjs';
>>>>>>> sattva/main
// OPTIONAL AI SUMMARIES — one fixed object (alert-notes:v1) on the provisioned CaptureRegistry class.
//
// A successful note is written once per content version and retained. Failed attempts have durable
// receipts and bounded retries, never a fresh allowance per paint, reader or object restart.
//
// 1. A NOTE IS STORED UNDER THE HASH OF EVERYTHING THE MODEL WAS GIVEN (`noteContent`), never under
//    an id the caller chose. The route is unauthenticated, so an id-keyed store would let anybody
//    file a note against somebody else's development; a content-keyed one can only ever answer the
//    text it was written from.
// 2. TWO READERS ASKING AT ONCE PAY ONCE. A request in flight is shared by key inside the object,
//    which is single-threaded, so the second asker waits on the first answer instead of a second call.
// 3. SPEND IS BOUNDED BY DAY AND BY CONTENT. Attempts are reserved before provider I/O; rejected
//    output is not purchased again. Temporary failures share a backoff and a three-attempt ceiling.
<<<<<<< HEAD
import { noteContent, noteItem, noteRequest, parseNotes, acceptNote, NOTE_REQUEST_ITEMS } from '../public/js/data/alert-notes-shared.js';
=======
import { noteContent, noteItem, noteRequest, noteOpenAIRequest, parseNotes, acceptNote, NOTE_REQUEST_ITEMS } from '../public/js/data/alert-notes-shared.js';
>>>>>>> sattva/main
import { bedrockConfig, bedrockConfigured, claudeCredential } from './research-claude.mjs';

export const ALERT_NOTES_OBJECT = 'alert-notes:v1';
export const NOTE_DAILY_LIMIT = 1200;
export const NOTE_TIMEOUT_MS = 30_000;
// All Alerts can reopen retained history. Neither a saved note nor its attempt receipt expires.
export const NOTE_MAX_ATTEMPTS = 3;
<<<<<<< HEAD
const RETRY_MS = { upstream: 120_000, timeout: 120_000, 'rate-limited': 60_000, refused: 600_000 };
=======
export const NOTE_OPENAI_MODEL = 'gpt-6-luna';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const statusReason = status => status === 401 || status === 403 ? 'refused' : status === 429 ? 'rate-limited' : 'upstream';
const RETRY_MS = { quota: 600_000, upstream: 120_000, timeout: 120_000, 'rate-limited': 60_000, refused: 600_000 };
>>>>>>> sattva/main

const istDay = (at) => new Date(at + 5.5 * 3_600_000).toISOString().slice(0, 10);

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const failureOf = (error) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'upstream');

<<<<<<< HEAD
=======
export function noteProvider(env = {}) {
  const pinned = String(env?.ALERT_NOTES_AI_PROVIDER ?? '').trim().toLowerCase();
  const openai = openaiConfigured(env) ? { id: 'openai', model: NOTE_OPENAI_MODEL } : null;
  const bedrock = bedrockConfigured(env) ? { id: 'bedrock', model: bedrockConfig(env).model } : null;
  if (!pinned) return openai || bedrock;
  if (pinned === 'openai') return openai;
  if (pinned === 'bedrock') return bedrock;
  return null;
}

>>>>>>> sattva/main
export class AlertNotesStore {
  constructor(storage, env = {}, { fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetcher = fetcher;
    this.now = now;
    this.inflight = new Map();
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alert_notes (
      key TEXT PRIMARY KEY, note TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL)`);
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS alert_notes_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alert_note_attempts (
      key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reason TEXT NOT NULL, retry_at INTEGER)`);
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  budget() {
    const found = this.rows("SELECT value FROM alert_notes_meta WHERE key = 'budget'")[0];
    const today = istDay(this.now());
    const value = found ? JSON.parse(found.value) : null;
    return value?.day === today ? value : { day: today, used: 0 };
  }

  spend(count) {
    const value = this.budget();
    value.used += count;
    this.rows("INSERT INTO alert_notes_meta(key,value) VALUES ('budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
    return value;
  }

  attempt(key) {
    return this.rows('SELECT attempts, reason, retry_at FROM alert_note_attempts WHERE key = ?', key)[0];
  }

  failure(entry, reason) {
    const attempts = this.attempt(entry.key)?.attempts || NOTE_MAX_ATTEMPTS;
    const delay = RETRY_MS[reason];
    const exhausted = delay && attempts >= NOTE_MAX_ATTEMPTS;
    const retryAt = delay && !exhausted ? this.now() + delay * attempts : null;
    const savedReason = exhausted ? 'retry-exhausted' : reason;
    this.rows('UPDATE alert_note_attempts SET reason = ?, retry_at = ? WHERE key = ?', savedReason, retryAt, entry.key);
    return { reason: savedReason, retryAt };
  }

  status() {
    this.init();
    const stored = this.rows('SELECT COUNT(*) AS count FROM alert_notes')[0]?.count || 0;
    const { day, used } = this.budget();
<<<<<<< HEAD
    return { stored, day, used, limit: NOTE_DAILY_LIMIT, configured: bedrockConfigured(this.env) };
=======
    const provider = noteProvider(this.env);
    return { stored, day, used, limit: NOTE_DAILY_LIMIT, configured: !!provider, provider: provider?.id ?? null, model: provider?.model ?? null };
>>>>>>> sattva/main
  }

  /**
   * Notes for up to `NOTE_REQUEST_ITEMS` items: `{ notes: { id: { note, model, stored } },
   * missing: { id: reason } }`. Valid but ineligible items are `not-needed`; malformed items are `invalid`.
   */
  async read(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length > NOTE_REQUEST_ITEMS) throw new Error('Invalid notes request');
<<<<<<< HEAD
    const notes = {};
    const missing = {};
    const retryAt = {};
=======
    const notes = Object.create(null);
    const missing = Object.create(null);
    const retryAt = Object.create(null);
>>>>>>> sattva/main
    const wanted = [];
    const seenIds = new Set();
    for (const raw of rawItems) {
      const item = noteItem(raw);
      if (!item || seenIds.has(item.id)) {
        if (raw?.id) {
          const id = String(raw.id).slice(0, 120);
          const recognized = ['filing', 'result', 'news', 'insider', 'investor'].includes(raw.kind)
            && typeof raw.company === 'string' && raw.company.trim() && typeof raw.line === 'string' && raw.line.trim();
          missing[id] = !item && recognized ? 'not-needed' : 'invalid';
          retryAt[id] = null;
        }
        continue;
      }
      seenIds.add(item.id);
      wanted.push({ item, key: await sha256(noteContent(item)) });
    }
    const pending = [];
    for (const entry of wanted) {
      const found = this.rows('SELECT note, model, created_at FROM alert_notes WHERE key = ?', entry.key)[0];
      if (found) notes[entry.item.id] = { note: found.note, model: found.model, generatedAt: found.created_at, stored: true };
      else {
        const attempt = this.attempt(entry.key);
        // An active caller shares the actual answer. After eviction/restart the durable receipt
        // still prevents an immediate second paid call, including an interrupted third attempt.
        if (!this.inflight.has(entry.key) && attempt && (attempt.retry_at === null || attempt.retry_at > this.now() || attempt.attempts >= NOTE_MAX_ATTEMPTS)) {
          missing[entry.item.id] = attempt.retry_at !== null && attempt.attempts >= NOTE_MAX_ATTEMPTS ? 'retry-exhausted' : attempt.reason;
          retryAt[entry.item.id] = attempt.attempts >= NOTE_MAX_ATTEMPTS ? null : attempt.retry_at;
        } else pending.push(entry);
      }
    }
<<<<<<< HEAD
    if (!pending.length) return { notes, missing, retryAt };
=======
    if (!pending.length) return { notes: { ...notes }, missing: { ...missing }, retryAt: { ...retryAt } };
>>>>>>> sattva/main

    // Somebody else's identical question is already with the model: wait for their answer. Nothing
    // between this check and the `set` below awaits, so two requests cannot both miss it.
    const fresh = [...new Map(pending.filter((entry) => !this.inflight.has(entry.key)).map(entry => [entry.key, entry])).values()];
    if (fresh.length) {
      const batch = this.generate(fresh);
      for (const entry of fresh) this.inflight.set(entry.key, batch.then((result) => result[entry.key]));
      batch.catch(() => {}).finally(() => { for (const entry of fresh) this.inflight.delete(entry.key); });
    }
    const answers = await Promise.all(pending.map((entry) => this.inflight.get(entry.key)));
    pending.forEach((entry, index) => {
      const answer = answers[index] || { reason: 'error' };
      if (answer.note) notes[entry.item.id] = { note: answer.note, model: answer.model, generatedAt: answer.generatedAt, stored: false };
      else {
        missing[entry.item.id] = answer.reason || 'error';
        if (Object.hasOwn(answer, 'retryAt')) retryAt[entry.item.id] = answer.retryAt;
      }
    });
<<<<<<< HEAD
    return { notes, missing, retryAt };
=======
    return { notes: { ...notes }, missing: { ...missing }, retryAt: { ...retryAt } };
>>>>>>> sattva/main
  }

  /** One model request for every fresh item; resolves to `{ [key]: { note, model } | { reason } }`. */
  async generate(entries) {
    const out = {};
    const refuse = (reason) => { for (const entry of entries) out[entry.key] = { reason }; return out; };
<<<<<<< HEAD
    if (!bedrockConfigured(this.env)) return refuse('no-key');
=======
    const provider = noteProvider(this.env);
    if (!provider) return refuse('no-key');
>>>>>>> sattva/main
    const { used } = this.budget();
    const room = Math.max(0, NOTE_DAILY_LIMIT - used);
    const asked = entries.slice(0, room);
    for (const entry of entries.slice(room)) out[entry.key] = { reason: 'budget' };
    if (!asked.length) return out;
    // Reserve both budget and per-content attempts before any provider I/O. A lost response or
    // object restart must not erase a charge. No network work occurs inside the transaction.
    this.storage.transactionSync(() => {
      this.spend(asked.length);
      for (const entry of asked) {
        const attempts = (this.attempt(entry.key)?.attempts || 0) + 1;
        this.rows(`INSERT INTO alert_note_attempts(key, attempts, reason, retry_at) VALUES (?, ?, 'timeout', ?)
          ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts, reason=excluded.reason, retry_at=excluded.retry_at`,
        entry.key, attempts, this.now() + NOTE_TIMEOUT_MS + RETRY_MS.timeout * attempts);
      }
    });
    const failed = (reason) => { for (const entry of asked) out[entry.key] = this.failure(entry, reason); return out; };
<<<<<<< HEAD
    const config = bedrockConfig(this.env);
    const createdAt = new Date(this.now()).toISOString();
    let reply;
    try {
      const response = await this.fetcher(config.url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'x-api-key': claudeCredential(this.env), 'anthropic-version': '2023-06-01', accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(noteRequest(asked.map((entry) => entry.item), config.model)),
        signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
      });
      if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? 'refused' : response.status === 429 ? 'rate-limited' : 'upstream';
        return failed(reason);
      }
      // A reply that is not the provider's JSON is unreadable, not an outage.
      const body = await response.json().catch(() => null);
      reply = (Array.isArray(body?.content) ? body.content : []).filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
    } catch (error) {
      return failed(failureOf(error));
    }
    const parsed = parseNotes(reply, new Set(asked.map((entry) => entry.item.id)));
=======
    const createdAt = new Date(this.now()).toISOString();
    const items = asked.map(entry => entry.item);
    let reply;
    try {
      reply = provider.id === 'openai' ? await this.askOpenAI(items, provider.model) : await this.askBedrock(items, provider.model);
    } catch (error) { return failed(failureOf(error)); }
    if (reply.reason) return failed(reply.reason);
    const parsed = parseNotes(reply.text, new Set(items.map(item => item.id)));
>>>>>>> sattva/main
    if (!parsed) {
      return failed('unreadable');
    }
    for (const entry of asked) {
      const raw = parsed[entry.item.id];
      if (raw === null) { out[entry.key] = this.failure(entry, 'not-needed'); continue; }
      if (!raw) { out[entry.key] = this.failure(entry, 'empty'); continue; }
      const checked = acceptNote(raw, entry.item);
      if (!checked.ok) { out[entry.key] = this.failure(entry, checked.reason); continue; }
      this.rows('INSERT INTO alert_notes(key, note, model, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
<<<<<<< HEAD
        entry.key, checked.note, config.model, createdAt);
      out[entry.key] = { note: checked.note, model: config.model, generatedAt: createdAt };
    }
    return out;
  }
=======
        entry.key, checked.note, provider.model, createdAt);
      out[entry.key] = { note: checked.note, model: provider.model, generatedAt: createdAt };
    }
    return out;
  }
  async askOpenAI(items, model) {
    const response = await this.fetcher(OPENAI_RESPONSES_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Bearer ${String(this.env.OPENAI_API_KEY).trim()}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(noteOpenAIRequest(items, model)),
      signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // OpenAI answers an account with no credit as a 429 too; that is not a pause that lifts in a
      // minute, so it gets its own words.
      let code = null;
      if (response.status === 429) {
        const error = await boundedJson(new Response(response.body), 8000).catch(() => null);
        code = error?.error?.code || error?.error?.type || null;
      } else {
        await response.body?.cancel();
      }
      return { reason: code === 'insufficient_quota' ? 'quota' : statusReason(response.status) };
    }
    // A reply that is not the provider's JSON, or one that did not finish, is unreadable, not an outage.
    const body = await boundedJson(response, 100_000).catch(() => null);
    if (body?.status !== 'completed') return { reason: 'unreadable' };
    const parts = (Array.isArray(body.output) ? body.output : []).flatMap((entry) => (Array.isArray(entry?.content) ? entry.content : []));
    if (parts.some((part) => part?.type === 'refusal')) return { reason: 'declined' };
    return { text: parts.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('') };
  }
  async askBedrock(items, model) {
    const config = bedrockConfig(this.env);
    const response = await this.fetcher(config.url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-api-key': claudeCredential(this.env), 'anthropic-version': '2023-06-01', accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(noteRequest(items, model)),
      signal: AbortSignal.timeout(NOTE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { reason: statusReason(response.status) };
    }
    // A reply that is not the provider's JSON is unreadable, not an outage.
    const body = await boundedJson(response, 32000).catch(() => null);
    if (body?.stop_reason !== 'end_turn') return { reason: 'unreadable' };
    return { text: (Array.isArray(body?.content) ? body.content : []).filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') };
  }
>>>>>>> sattva/main
}
