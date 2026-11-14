import { AI_RUNS_LIMIT, runIntents } from '../public/js/data/ai-runs-shared.js';

// THE DESK'S SHARED AI-INSIGHTS RUNS, AS ONE DURABLE RECORD. GLOW-OWNED.
//
// One row per company a reader has run the AI "Our view" for, on one fixed object (`ai-runs:v1`) of
// the provisioned CaptureRegistry class — the same arrangement as the shared watchlist and the
// research sheet: no namespace migration, and the table is created the first time a run method runs
// on this object and on no other.
//
// THE SERVER STAMPS THE TIME, for the reason the watchlist and sheet stores give: ordering two
// devices' writes by a clock either device filled in means trusting whichever clock is furthest wrong.
//
// A SET ALWAYS WRITES. Re-running a company produces a fresh, metered view, so a `set` is a real
// update, not a no-op to fold away. Only a run whose content is byte-for-byte what is already stored
// is reported `unchanged`, so an honest retry of the same POST does not move the revision and spill a
// needless re-read onto every other open page.

export { AI_RUNS_OBJECT } from '../public/js/data/ai-runs-shared.js';

const iso = (at) => new Date(at).toISOString();

export class AiRunsStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
    this.cached = null;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS airun_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS airun_rows (
      ticker TEXT PRIMARY KEY, name TEXT, sector TEXT, idea TEXT, raw_text TEXT,
      updated_at TEXT NOT NULL, updated_by TEXT, seq INTEGER NOT NULL)`);
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM airun_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO airun_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /**
   * The whole record. `revision` moves only when a run actually changed, so an unchanged poll
   * produces a byte-identical body and the route's ETag answers it with a bodyless 304. Held in
   * memory between edits, as the sheet's snapshot is, because every open page asks for it and a
   * fresh read scans every stored run; one live instance owns this object and `apply()` is the only
   * writer, so the held copy can only be stale if this instance made it stale. Frozen, so no caller
   * can edit what the next reader is handed.
   */
  snapshot() {
    return (this.cached ||= this.read());
  }

  read() {
    const meta = this.meta();
    const runs = this.rows(
      'SELECT ticker, name, sector, idea, raw_text, updated_at, updated_by FROM airun_rows ORDER BY seq DESC',
    ).map((row) => {
      let idea = null;
      if (row.idea != null) { try { idea = JSON.parse(row.idea); } catch { idea = null; } }
      return {
        ticker: row.ticker,
        name: row.name || null,
        sector: row.sector || null,
        idea,
        rawText: row.raw_text || null,
        at: row.updated_at,
        by: row.updated_by || null,
      };
    });
    return deepFreeze({ version: 1, revision: meta.revision, updatedAt: meta.updatedAt, runs, limit: AI_RUNS_LIMIT });
  }

  count() {
    return this.rows('SELECT COUNT(*) AS count FROM airun_rows')[0].count;
  }

  // Keep the newest AI_RUNS_LIMIT runs; the oldest by sequence fall off. A run that fell off is not a
  // run that never happened — the reader who made it still holds it in their own browser — so this is
  // a size ceiling, not a deletion of anyone's work.
  prune() {
    const total = this.count();
    if (total <= AI_RUNS_LIMIT) return;
    this.rows(
      'DELETE FROM airun_rows WHERE ticker IN (SELECT ticker FROM airun_rows ORDER BY seq ASC LIMIT ?)',
      total - AI_RUNS_LIMIT,
    );
  }

  apply(input) {
    const intents = runIntents(input);
    const at = iso(this.now());
    this.init();
    // Drop the held copy before the edit; replace it only once the transaction has committed, so a
    // batch that throws and rolls back can never leave a copy of what it undid.
    this.cached = null;
    const result = this.storage.transactionSync(() => this.applyIntents(intents, at));
    this.cached = result.snapshot;
    return result;
  }

  applyIntents(intents, at) {
    const meta = this.meta();
    let seq = meta.seq;
    let changed = 0;
    const outcomes = [];

    for (const intent of intents) {
      const base = { key: intent.key, op: intent.op };

      if (intent.op === 'set') {
        const idea = intent.idea == null ? null : JSON.stringify(intent.idea);
        const existing = this.rows('SELECT idea, raw_text FROM airun_rows WHERE ticker = ?', intent.key)[0];
        if (existing && (existing.idea ?? null) === idea && (existing.raw_text ?? null) === (intent.rawText ?? null)) {
          // The same view already stored — an honest retry, not a new run. Reassign nothing.
          outcomes.push({ ...base, outcome: 'unchanged' });
          continue;
        }
        seq++;
        this.rows(
          `INSERT INTO airun_rows (ticker, name, sector, idea, raw_text, updated_at, updated_by, seq)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, sector=excluded.sector, idea=excluded.idea,
             raw_text=excluded.raw_text, updated_at=excluded.updated_at, updated_by=excluded.updated_by, seq=excluded.seq`,
          intent.key, intent.name, intent.sector, idea, intent.rawText ?? null, at, intent.by, seq,
        );
        changed++;
        outcomes.push({ ...base, outcome: 'set' });
        continue;
      }

      // clear
      const existing = this.rows('SELECT 1 AS x FROM airun_rows WHERE ticker = ?', intent.key)[0];
      if (!existing) {
        outcomes.push({ ...base, outcome: 'unchanged' });
        continue;
      }
      this.rows('DELETE FROM airun_rows WHERE ticker = ?', intent.key);
      seq++;
      changed++;
      outcomes.push({ ...base, outcome: 'cleared' });
    }

    if (changed) {
      this.prune();
      this.putMeta({ revision: meta.revision + 1, updatedAt: at, seq });
    } else if (seq !== meta.seq) {
      this.putMeta({ ...meta, seq });
    }
    return { outcomes, snapshot: this.read() };
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
