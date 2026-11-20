import {
  FW_COMPANY_LIMIT, FW_FIELDS_PER_COMPANY, sameValue, frameworkIntents,
} from '../public/js/data/framework-shared.js';

// THE DESK'S FRAMEWORK SCORES, AS ONE DURABLE RECORD. GLOW-OWNED.
//
// Every 0/1/2 a company is scored on a criterion, each rationale, each Governance Pass/Fail and the
// few typed text columns live here, one row per (company, field), on one fixed object
// (`framework:v1`) of the provisioned CaptureRegistry class — the same arrangement as the shared
// watchlist, the research sheet and the price levels: no namespace migration, tables created the
// first time a method runs on this object and on no other.
//
// THE SERVER STAMPS THE TIME, for the reason the watchlist store gives: ordering two devices' edits
// by a clock either device filled in means trusting whichever clock is furthest wrong.
//
// A CLEARED CELL IS DELETED. Nothing here seeds, so there is no stale-device resurrection to guard
// against (the research sheet's values table works the same way); a cleared score that is later set
// again is set again on purpose.

export { FRAMEWORK_OBJECT } from '../public/js/data/framework-shared.js';

const iso = (at) => new Date(at).toISOString();

export class FrameworkStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
    this.cached = null;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS fw_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS fw_values (
      company TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT, seq INTEGER NOT NULL,
      PRIMARY KEY (company, field))`);
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM fw_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO fw_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /**
   * The whole record. `revision` moves only when a cell actually changed, so an unchanged poll
   * produces a byte-identical body and the route's ETag answers it with a bodyless 304. Held in
   * memory between edits (one live instance owns this object and apply() is the only writer), so an
   * unchanged poll reads no SQLite rows — the research-sheet store explains why that matters on
   * Workers Free. Frozen, so no caller can edit what the next reader is handed.
   */
  snapshot() {
    return (this.cached ||= this.read());
  }

  read() {
    const meta = this.meta();
    const values = {};
    for (const row of this.rows('SELECT company, field, value, updated_at, updated_by FROM fw_values ORDER BY company, field')) {
      let value;
      try { value = JSON.parse(row.value); } catch { continue; }
      (values[row.company] ||= {})[row.field] = { value, at: row.updated_at, by: row.updated_by || null };
    }
    return deepFreeze({
      version: 1,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      values,
      limits: { companies: FW_COMPANY_LIMIT, fieldsPerCompany: FW_FIELDS_PER_COMPANY },
    });
  }

  companyCount() {
    return this.rows('SELECT COUNT(DISTINCT company) AS count FROM fw_values')[0].count;
  }

  /**
   * Apply a batch of edits and return the record as it now stands. Every intent gets a named
   * outcome; `full` (capacity refused) must never read as `set`, or a device would show a score
   * nobody else can see. `unchanged` is not a failure.
   */
  apply(input) {
    const intents = frameworkIntents(input);
    const at = iso(this.now());
    this.init();
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
    let companies = this.companyCount();

    for (const intent of intents) {
      const base = { key: intent.key, op: intent.op, field: intent.field };

      if (intent.op === 'set') {
        const existing = this.rows('SELECT value FROM fw_values WHERE company = ? AND field = ?', intent.key, intent.field)[0];
        if (existing) {
          let held;
          try { held = JSON.parse(existing.value); } catch { held = undefined; }
          if (sameValue(held, intent.value)) {
            outcomes.push({ ...base, outcome: 'unchanged' });
            continue;
          }
        } else {
          const known = this.rows('SELECT COUNT(*) AS count FROM fw_values WHERE company = ?', intent.key)[0].count;
          if (known === 0 && companies >= FW_COMPANY_LIMIT) {
            outcomes.push({ ...base, outcome: 'full' });
            continue;
          }
          if (known >= FW_FIELDS_PER_COMPANY) {
            outcomes.push({ ...base, outcome: 'full' });
            continue;
          }
          if (known === 0) companies++;
        }
        seq++;
        this.rows(
          `INSERT INTO fw_values (company, field, value, updated_at, updated_by, seq) VALUES (?,?,?,?,?,?)
           ON CONFLICT(company, field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at,
             updated_by=excluded.updated_by, seq=excluded.seq`,
          intent.key, intent.field, JSON.stringify(intent.value), at, intent.by, seq,
        );
        changed++;
        outcomes.push({ ...base, outcome: 'set' });
        continue;
      }

      // clear
      const existing = this.rows('SELECT 1 AS x FROM fw_values WHERE company = ? AND field = ?', intent.key, intent.field)[0];
      if (!existing) {
        outcomes.push({ ...base, outcome: 'unchanged' });
        continue;
      }
      this.rows('DELETE FROM fw_values WHERE company = ? AND field = ?', intent.key, intent.field);
      seq++;
      changed++;
      outcomes.push({ ...base, outcome: 'cleared' });
    }

    if (changed) {
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
