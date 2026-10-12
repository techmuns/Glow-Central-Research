import {
  SHEET_COMPANY_LIMIT, SHEET_ROW_LIMIT, SHEET_TOMBSTONE_LIMIT, sameValue, sheetIntents,
} from '../public/js/data/research-sheet-shared.js';
import { companyName } from '../public/js/data/watchlist-shared.js';

// THE DESK'S RESEARCH SHEET, AS ONE DURABLE RECORD. GLOW-OWNED.
//
// Every value somebody types into the Portfolio or Watchlist tab — a date bought, a buy price, an
// intrinsic value, a target, a methodology, a source — lives here, one row per (company, field), on
// one fixed object (`research-sheet:v1`) of the provisioned CaptureRegistry class. Same arrangement
// as the shared watchlist and the relevance feedback: no namespace migration, and the tables are
// created the first time a sheet method runs on this object and on no other.
//
// THE SERVER STAMPS THE TIME, for the reason the watchlist store gives: ordering two devices' edits
// by a clock either device filled in means trusting whichever clock is furthest wrong.
//
// A CLEARED CELL IS DELETED, AND THAT IS NOT THE WATCHLIST'S TOMBSTONE RULE BROKEN. The watchlist
// keeps a removal as a record because a `seed` from a stale device must not resurrect a company
// somebody dropped. Nothing here seeds: every `set` is somebody's deliberate edit, so a cleared cell
// that is later set again is set again on purpose. Manual portfolio rows DO keep their removal,
// because a removed holding and one nobody ever added are different facts the sheet should state.

export { RESEARCH_SHEET_OBJECT } from '../public/js/data/research-sheet-shared.js';

const iso = (at) => new Date(at).toISOString();

export class ResearchSheetStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS sheet_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_values (
      company TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT, seq INTEGER NOT NULL,
      PRIMARY KEY (company, field))`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_portfolio_rows (
      company TEXT PRIMARY KEY, name TEXT, state TEXT NOT NULL,
      added_at TEXT, added_by TEXT, removed_at TEXT, removed_by TEXT,
      updated_at TEXT NOT NULL, seq INTEGER NOT NULL)`);
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM sheet_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO sheet_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /**
   * The whole sheet. `revision` moves only when a cell or a row actually changed, so an unchanged
   * poll produces a byte-identical body and the route's ETag answers it with a bodyless 304.
   */
  snapshot() {
    const meta = this.meta();
    const values = {};
    for (const row of this.rows('SELECT company, field, value, updated_at, updated_by FROM sheet_values ORDER BY company, field')) {
      let value;
      try { value = JSON.parse(row.value); } catch { continue; }
      (values[row.company] ||= {})[row.field] = { value, at: row.updated_at, by: row.updated_by || null };
    }
    const rows = this.rows(
      "SELECT company, name, added_at, added_by FROM sheet_portfolio_rows WHERE state = 'added' ORDER BY seq ASC",
    ).map((row) => ({ key: row.company, name: row.name || null, addedAt: row.added_at || null, addedBy: row.added_by || null }));
    return {
      version: 1,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      values,
      rows,
      limits: { companies: SHEET_COMPANY_LIMIT, rows: SHEET_ROW_LIMIT },
    };
  }

  companyCount() {
    return this.rows('SELECT COUNT(DISTINCT company) AS count FROM sheet_values')[0].count;
  }

  pruneTombstones() {
    const total = this.rows("SELECT COUNT(*) AS count FROM sheet_portfolio_rows WHERE state = 'removed'")[0].count;
    if (total <= SHEET_TOMBSTONE_LIMIT) return;
    this.rows(
      `DELETE FROM sheet_portfolio_rows WHERE company IN (
         SELECT company FROM sheet_portfolio_rows WHERE state = 'removed' ORDER BY seq ASC LIMIT ?)`,
      total - SHEET_TOMBSTONE_LIMIT,
    );
  }

  /**
   * Apply a batch of edits and return the sheet as it now stands.
   *
   * Every intent gets a named outcome. `full` is the one that matters: an edit refused for capacity
   * must never read as one that was saved, or a device would show a value nobody else can see.
   * `unchanged` is not a failure — re-saving what is already there, or two people clearing one cell,
   * is ordinary, not a mistake either of them made.
   */
  apply(input) {
    const intents = sheetIntents(input);
    const at = iso(this.now());
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      let seq = meta.seq;
      let changed = 0;
      const outcomes = [];
      let companies = this.companyCount();
      let manual = this.rows("SELECT COUNT(*) AS count FROM sheet_portfolio_rows WHERE state = 'added'")[0].count;

      for (const intent of intents) {
        const base = { key: intent.key, op: intent.op, ...(intent.field ? { field: intent.field } : {}) };

        if (intent.op === 'set') {
          const existing = this.rows('SELECT value FROM sheet_values WHERE company = ? AND field = ?', intent.key, intent.field)[0];
          if (existing) {
            let held;
            try { held = JSON.parse(existing.value); } catch { held = undefined; }
            if (sameValue(held, intent.value)) {
              // Re-typing the value that is already there reassigns nothing: whoever set it set it.
              outcomes.push({ ...base, outcome: 'unchanged' });
              continue;
            }
          } else {
            const known = this.rows('SELECT 1 AS x FROM sheet_values WHERE company = ? LIMIT 1', intent.key).length > 0;
            if (!known && companies >= SHEET_COMPANY_LIMIT) {
              outcomes.push({ ...base, outcome: 'full' });
              continue;
            }
            if (!known) companies++;
          }
          seq++;
          this.rows(
            `INSERT INTO sheet_values (company, field, value, updated_at, updated_by, seq) VALUES (?,?,?,?,?,?)
             ON CONFLICT(company, field) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at,
               updated_by=excluded.updated_by, seq=excluded.seq`,
            intent.key, intent.field, JSON.stringify(intent.value), at, intent.by, seq,
          );
          changed++;
          outcomes.push({ ...base, outcome: 'set' });
          continue;
        }

        if (intent.op === 'clear') {
          const existing = this.rows('SELECT 1 AS x FROM sheet_values WHERE company = ? AND field = ?', intent.key, intent.field)[0];
          if (!existing) {
            outcomes.push({ ...base, outcome: 'unchanged' });
            continue;
          }
          this.rows('DELETE FROM sheet_values WHERE company = ? AND field = ?', intent.key, intent.field);
          if (!this.rows('SELECT 1 AS x FROM sheet_values WHERE company = ? LIMIT 1', intent.key).length) companies--;
          seq++;
          changed++;
          outcomes.push({ ...base, outcome: 'cleared' });
          continue;
        }

        const row = this.rows('SELECT name, state FROM sheet_portfolio_rows WHERE company = ?', intent.key)[0];
        if (intent.op === 'add-row') {
          if (row?.state === 'added') {
            // Adding a holding that is already on the sheet reassigns nothing; a NAME arriving for a
            // row that had none is still worth keeping, as the watchlist store does.
            const name = row.name || companyName(intent.name);
            if (name !== row.name) {
              this.rows('UPDATE sheet_portfolio_rows SET name = ?, updated_at = ? WHERE company = ?', name, at, intent.key);
              changed++;
            }
            outcomes.push({ ...base, outcome: 'unchanged' });
            continue;
          }
          if (manual >= SHEET_ROW_LIMIT) {
            outcomes.push({ ...base, outcome: 'full' });
            continue;
          }
          seq++;
          this.rows(
            `INSERT INTO sheet_portfolio_rows (company, name, state, added_at, added_by, removed_at, removed_by, updated_at, seq)
             VALUES (?,?,'added',?,?,NULL,NULL,?,?)
             ON CONFLICT(company) DO UPDATE SET name=excluded.name, state='added', added_at=excluded.added_at,
               added_by=excluded.added_by, removed_at=NULL, removed_by=NULL, updated_at=excluded.updated_at, seq=excluded.seq`,
            intent.key, companyName(intent.name), at, intent.by, at, seq,
          );
          manual++;
          changed++;
          outcomes.push({ ...base, outcome: 'added' });
          continue;
        }

        // remove-row
        if (row?.state !== 'added') {
          outcomes.push({ ...base, outcome: 'unchanged' });
          continue;
        }
        seq++;
        this.rows(
          "UPDATE sheet_portfolio_rows SET state = 'removed', removed_at = ?, removed_by = ?, updated_at = ?, seq = ? WHERE company = ?",
          at, intent.by, at, seq, intent.key,
        );
        manual--;
        changed++;
        outcomes.push({ ...base, outcome: 'removed' });
      }

      if (changed) {
        this.pruneTombstones();
        this.putMeta({ revision: meta.revision + 1, updatedAt: at, seq });
      } else if (seq !== meta.seq) {
        this.putMeta({ ...meta, seq });
      }
      return { outcomes, snapshot: this.snapshot() };
    });
  }
}
