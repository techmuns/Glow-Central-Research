import {
  PRICE_LEVEL, PRICE_LEVEL_NAMES, PRICE_LEVELS_COMPANY_LIMIT, PRICE_LEVELS_HIT_WIRE, priceLevelIntents, levelHit, hitId,
} from '../public/js/data/price-levels-shared.js';

// THE FAMILY'S PRICE LEVELS, AS ONE DURABLE RECORD — AND EVERY TIME ONE WAS REACHED.
//
// One object, one list: `PRICE_LEVELS_OBJECT` in the shared contract. The class is the already
// provisioned `CaptureRegistry`, reused exactly as the shared watchlist and the team brief reuse it,
// so this needs no namespace migration; its tables are created the first time a price-level method
// is called and no other object ever touches them.
//
// THREE TABLES, BECAUSE THEY ANSWER THREE DIFFERENT QUESTIONS.
//   `price_level_companies` — which companies the family has levels on, and which they cleared. A
//     clear is a RECORD (state 'cleared'), never a deleted row, for the reason the shared watchlist
//     gives: deleting it would make "cleared here" and "never set anywhere" the same state, and a
//     stale device could then put a level back with a seed because nothing contradicted it.
//   `price_levels` — the levels themselves, one row per company and level, with the moment the
//     value was set (the Worker's clock) and, once the price got there, the moment it was reached.
//   `price_level_hits` — every level that was reached, kept as history. It outlives the level: a
//     family that clears a Stop loss after it fired has not un-happened the fall, and AI Alerts reads
//     historical windows. Reached records and deletion tombstones are never pruned.
//
// THE SERVER STAMPS EVERY TIME. `setAt` and `reachedAt` are the moments THIS object accepted the
// edit or saw the price — the one clock every device and every reader is actually talking to.

const iso = (at) => new Date(at).toISOString();

export class PriceLevelStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS price_level_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS price_level_companies (
      ticker TEXT PRIMARY KEY, isin TEXT, name TEXT, state TEXT NOT NULL,
      updated_at TEXT NOT NULL, seq INTEGER NOT NULL)`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS price_levels (
      ticker TEXT NOT NULL, level TEXT NOT NULL, value REAL NOT NULL, set_at TEXT NOT NULL,
      reached_at TEXT, reached_price REAL, reached_basis TEXT, reached_session TEXT,
      PRIMARY KEY (ticker, level))`);
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS price_level_hits (
      id TEXT PRIMARY KEY, ticker TEXT NOT NULL, isin TEXT, name TEXT, level TEXT NOT NULL,
      value REAL NOT NULL, set_at TEXT NOT NULL, reached_at TEXT NOT NULL, price REAL NOT NULL,
      basis TEXT NOT NULL, session TEXT NOT NULL, quote_at TEXT)`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS price_level_hits_at ON price_level_hits(reached_at)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM price_level_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO price_level_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /** Levels still waiting for the price, per company — what the minute check asks the market about. */
  activeTargets() {
    const out = new Map();
    for (const row of this.rows(
      `SELECT l.ticker, c.isin, c.name, l.level, l.value, l.set_at FROM price_levels l
         JOIN price_level_companies c ON c.ticker = l.ticker
        WHERE c.state = 'set' AND l.reached_at IS NULL ORDER BY l.ticker, l.level`,
    )) {
      const target = out.get(row.ticker) || { ticker: row.ticker, isin: row.isin || null, name: row.name || null, levels: [] };
      target.levels.push({ level: row.level, value: row.value, setAt: row.set_at, direction: PRICE_LEVEL[row.level].direction });
      out.set(row.ticker, target);
    }
    return [...out.values()];
  }

  /**
   * The whole list and the reached history, newest first.
   *
   * `revision` moves only when a row changed — an edit, or a level reached. History uses
   * stable keyset pages; new hits arriving during a read are included on the next refresh.
   */
  snapshot(cursor = null) {
    const meta = this.meta();
    const levels = new Map();
    for (const row of this.rows('SELECT * FROM price_levels ORDER BY ticker, level')) {
      const byName = levels.get(row.ticker) || {};
      byName[row.level] = {
        value: row.value,
        setAt: row.set_at,
        reached: row.reached_at
          ? { at: row.reached_at, price: row.reached_price, basis: row.reached_basis, session: row.reached_session }
          : null,
      };
      levels.set(row.ticker, byName);
    }
    const companies = this.rows("SELECT ticker, isin, name, updated_at FROM price_level_companies WHERE state = 'set' ORDER BY seq DESC")
      .map((row) => ({
        ticker: row.ticker, isin: row.isin || null, name: row.name || null, updatedAt: row.updated_at,
        levels: Object.fromEntries(PRICE_LEVEL_NAMES.map((name) => [name, levels.get(row.ticker)?.[name] || null])),
      }));
    let before = null;
    if (cursor) {
      try { before = JSON.parse(cursor); } catch { throw Error('Invalid price level cursor'); }
      if (!Array.isArray(before) || before.length !== 2 || !before.every(v => typeof v === 'string' && v.length <= 300)) throw Error('Invalid price level cursor');
    }
    const rawHits = before ? this.rows('SELECT * FROM price_level_hits WHERE reached_at < ? OR (reached_at = ? AND id < ?) ORDER BY reached_at DESC, id DESC LIMIT ?', before[0], before[0], before[1], PRICE_LEVELS_HIT_WIRE + 1)
      : this.rows('SELECT * FROM price_level_hits ORDER BY reached_at DESC, id DESC LIMIT ?', PRICE_LEVELS_HIT_WIRE + 1);
    const hits = rawHits.slice(0, PRICE_LEVELS_HIT_WIRE)
      .map((row) => ({
        id: row.id, ticker: row.ticker, isin: row.isin || null, name: row.name || null, level: row.level,
        value: row.value, setAt: row.set_at, reachedAt: row.reached_at, price: row.price,
        basis: row.basis, session: row.session, quoteAt: row.quote_at || null,
      }));
    return {
      version: 1,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      count: companies.length,
      limit: PRICE_LEVELS_COMPANY_LIMIT,
      pending: this.activeTargets().reduce((sum, target) => sum + target.levels.length, 0),
      companies,
      hits,
      nextCursor: rawHits.length > PRICE_LEVELS_HIT_WIRE ? JSON.stringify([hits.at(-1).reachedAt, hits.at(-1).id]) : null,
      retainedHits: this.rows('SELECT COUNT(*) AS count FROM price_level_hits')[0].count,
      firstHitAt: this.rows('SELECT MIN(reached_at) AS first FROM price_level_hits')[0].first || null,
    };
  }

  /** Write one company's five levels; returns whether any row changed. */
  writeLevels(intent, at) {
    let changed = false;
    const existing = new Map(this.rows('SELECT level, value FROM price_levels WHERE ticker = ?', intent.ticker).map((row) => [row.level, row.value]));
    for (const name of PRICE_LEVEL_NAMES) {
      if (intent.op === 'patch' && !Object.hasOwn(intent.levels, name)) continue;
      const value = intent.levels[name];
      const had = existing.get(name);
      if (value === null) {
        if (had !== undefined) { this.rows('DELETE FROM price_levels WHERE ticker = ? AND level = ?', intent.ticker, name); changed = true; }
        continue;
      }
      // THE SAME VALUE IS THE SAME LEVEL — its set time and whether it already fired both stand. A
      // resend of an unchanged level must never re-arm an alert that has already been raised.
      if (had === value) continue;
      this.rows(
        `INSERT INTO price_levels (ticker, level, value, set_at, reached_at, reached_price, reached_basis, reached_session)
         VALUES (?,?,?,?,NULL,NULL,NULL,NULL)
         ON CONFLICT(ticker, level) DO UPDATE SET value=excluded.value, set_at=excluded.set_at,
           reached_at=NULL, reached_price=NULL, reached_basis=NULL, reached_session=NULL`,
        intent.ticker, name, value, at,
      );
      changed = true;
    }
    return changed;
  }

  /**
   * Apply a batch of edits and return the list as it now stands, with a named outcome per edit.
   *
   * `unchanged` on a seed is the rule doing its job, not a failure: the shared list had already heard
   * about that company, from this family on another device. `full` is capacity and must never read
   * as saved.
   */
  apply(input) {
    const intents = priceLevelIntents(input);
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      // Repeated re-arms in the same millisecond must retain distinct hit identities.
      const at = iso(Math.max(this.now(), (Date.parse(meta.lastEditAt) || 0) + 1));
      let seq = meta.seq;
      let changed = 0;
      const outcomes = [];
      let active = this.rows("SELECT COUNT(*) AS count FROM price_level_companies WHERE state = 'set'")[0].count;

      for (const intent of intents) {
        const existing = this.rows('SELECT ticker, isin, name, state FROM price_level_companies WHERE ticker = ?', intent.ticker)[0];
        const isSet = existing?.state === 'set';
        if (existing?.isin && intent.isin && existing.isin !== intent.isin) throw Error('Invalid price level identity');

        if (intent.op === 'clear') {
          if (existing?.state === 'cleared') { outcomes.push({ ticker: intent.ticker, op: 'clear', outcome: 'unchanged' }); continue; }
          seq++;
          this.rows('DELETE FROM price_levels WHERE ticker = ?', intent.ticker);
          this.rows("INSERT INTO price_level_companies(ticker,state,updated_at,seq) VALUES (?,'cleared',?,?) ON CONFLICT(ticker) DO UPDATE SET state='cleared',updated_at=excluded.updated_at,seq=excluded.seq",intent.ticker,at,seq);
          if(isSet)active--;
          changed++;
          outcomes.push({ ticker: intent.ticker, op: 'clear', outcome: 'cleared' });
          continue;
        }

        if (intent.op === 'seed' && existing) {
          // If a row exists at all — set or cleared — the shared list has already spoken. Seeding over
          // a clear would let a browser that has not been opened in a month bring back a level the
          // family deliberately removed; seeding over a set would overwrite yesterday's decision.
          outcomes.push({ ticker: intent.ticker, op: 'seed', outcome: 'unchanged' });
          continue;
        }
        if (!isSet && active >= PRICE_LEVELS_COMPANY_LIMIT && Object.values(intent.levels).some(v=>v!==null)) {
          throw Error('Invalid price level capacity');
        }

        const levelsChanged = this.writeLevels(intent, at);
        // The ISIN is the company's exchange identity and is kept once known; a later edit that sends
        // none does not erase it. A name arriving for a row that had none is kept likewise.
        const isin = intent.isin || existing?.isin || null;
        const name = intent.name || existing?.name || null;
        const rowChanged = !isSet || isin !== (existing?.isin || null) || name !== (existing?.name || null);
        if (rowChanged || levelsChanged) {
          seq++;
          this.rows(
            `INSERT INTO price_level_companies (ticker, isin, name, state, updated_at, seq) VALUES (?,?,?,'set',?,?)
             ON CONFLICT(ticker) DO UPDATE SET isin=excluded.isin, name=excluded.name, state='set',
               updated_at=excluded.updated_at, seq=excluded.seq`,
            intent.ticker, isin, name, at, seq,
          );
          if (!isSet) active++;
          changed++;
        }
        if (!this.rows('SELECT level FROM price_levels WHERE ticker = ?',intent.ticker).length) {
          this.rows("UPDATE price_level_companies SET state='cleared' WHERE ticker=?",intent.ticker);
          active--;
        }
        outcomes.push({
          ticker: intent.ticker, op: intent.op,
          outcome: intent.op === 'seed' ? 'seeded' : rowChanged || levelsChanged ? 'set' : 'unchanged',
        });
      }

      if (changed) {

        this.putMeta({ ...meta, revision: meta.revision + 1, updatedAt: at, lastEditAt: at, seq });
      } else if (seq !== meta.seq) {
        this.putMeta({ ...meta, seq });
      }
      return { outcomes, snapshot: this.snapshot() };
    });
  }

  /**
   * Compare every waiting level against this minute's quotes and record each one reached.
   *
   * `quotes` is a Map of ticker -> { price, high, low, sessionDate, quoteAt } — already gated on the
   * company's exchange identity by the caller. A company missing from it is simply not decided this
   * minute; nothing here reads an absent quote as a price.
   */
  recordCheck(at, quotes) {
    const stamp = iso(at);
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      const reached = [];
      for (const target of this.activeTargets()) {
        const quote = quotes.get(target.ticker);
        if (!quote) continue;
        for (const level of target.levels) {
          const hit = levelHit(level, quote);
          if (!hit) continue;
          this.rows(
            `UPDATE price_levels SET reached_at = ?, reached_price = ?, reached_basis = ?, reached_session = ?
              WHERE ticker = ? AND level = ? AND reached_at IS NULL`,
            stamp, hit.price, hit.basis, quote.sessionDate, target.ticker, level.level,
          );
          const row = {
            ticker: target.ticker, isin: target.isin, name: target.name, level: level.level, value: level.value,
            setAt: level.setAt, reachedAt: stamp, price: hit.price, basis: hit.basis, session: quote.sessionDate,
            quoteAt: quote.quoteAt || null,
          };
          this.rows(
            `INSERT INTO price_level_hits (id, ticker, isin, name, level, value, set_at, reached_at, price, basis, session, quote_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
            hitId(row), row.ticker, row.isin, row.name, row.level, row.value, row.setAt, row.reachedAt,
            row.price, row.basis, row.session, row.quoteAt,
          );
          reached.push(row);
        }
      }
      if (reached.length) {
        this.putMeta({ ...meta, revision: meta.revision + 1, updatedAt: stamp });
      }
      return { reached };
    });
  }
}
