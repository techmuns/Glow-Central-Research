import {
  PEER_PER_COMPANY_LIMIT, PEER_COMPANY_LIMIT, PEER_TOMBSTONE_LIMIT,
  companyName, peerIntents,
} from '../public/js/data/peer-list-shared.js';

// THE SHARED PEER / COMPETITOR LISTS, AS ONE DURABLE RECORD (#312).
//
// One object, one desk, one map of who each company's rivals are — `SHARED_PEER_LIST_OBJECT` below.
// The class is the already provisioned `CaptureRegistry`, reused exactly as `SharedWatchlistStore`
// reuses it, so this needs no namespace migration; its table is created the first time a peer method
// is called and the other stores never touch it.
//
// THE SERVER STAMPS THE TIME, AND A REMOVAL IS A RECORD, NOT AN ABSENCE — both for the reasons the
// watchlist store gives: ordering two devices' edits by a field either filled in trusts whichever
// clock is furthest wrong, and deleting a row would let a stale device re-add a peer somebody
// deliberately dropped. So `added_at` is the moment THIS object accepted the edit, and a removed
// link stays with `state = 'removed'` so the removal is a fact the list can state.

export const SHARED_PEER_LIST_OBJECT = 'shared-peer-lists:v1';

const iso = (at) => new Date(at).toISOString();

export class SharedPeerListStore {
  constructor(storage, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
  }

  init() {
    if (this.initialised) return;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS peer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS peer_links (
      company TEXT NOT NULL, peer TEXT NOT NULL, name TEXT, state TEXT NOT NULL,
      added_at TEXT, removed_at TEXT, updated_at TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (company, peer))`);
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS peer_by_company ON peer_links(company, state, seq)');
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS peer_by_state ON peer_links(state, seq)');
    this.initialised = true;
  }

  rows(sql, ...args) {
    this.init();
    return this.storage.sql.exec(sql, ...args).toArray();
  }

  meta() {
    const found = this.rows("SELECT value FROM peer_meta WHERE key = 'state'")[0];
    return found ? JSON.parse(found.value) : { revision: 0, updatedAt: null, seq: 0 };
  }

  putMeta(value) {
    this.rows("INSERT INTO peer_meta(key,value) VALUES ('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  /**
   * The whole map of active peer links, flat, newest first within each company. The browser groups
   * it by company. `revision` only moves when a row actually changed, so an unchanged poll produces
   * a byte-identical body and the route's ETag answers it with a bodyless 304.
   */
  peerListSnapshot() {
    const meta = this.meta();
    const links = this.rows(
      "SELECT company, peer, name, added_at FROM peer_links WHERE state = 'active' ORDER BY company ASC, seq DESC",
    ).map((row) => ({ company: row.company, peer: row.peer, name: row.name || null, addedAt: row.added_at || null }));
    return {
      version: 1,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
      count: links.length,
      perCompanyLimit: PEER_PER_COMPANY_LIMIT,
      links,
    };
  }

  pruneTombstones() {
    const total = this.rows("SELECT COUNT(*) AS count FROM peer_links WHERE state = 'removed'")[0].count;
    if (total <= PEER_TOMBSTONE_LIMIT) return;
    this.rows(
      `DELETE FROM peer_links WHERE rowid IN (
         SELECT rowid FROM peer_links WHERE state = 'removed' ORDER BY seq ASC LIMIT ?)`,
      total - PEER_TOMBSTONE_LIMIT,
    );
  }

  /**
   * Apply a batch of edits and return the map as it now stands. Every intent gets a named outcome.
   * `full` is the one that matters: a peer refused for capacity must never read as one that was
   * added, or a device would show a rival it does not have. `unchanged` is not a failure either —
   * two people adding the same peer, or both removing it, is a race, not a mistake.
   */
  peerListApply(input) {
    const intents = peerIntents(input);
    const at = iso(this.now());
    this.init();
    return this.storage.transactionSync(() => {
      const meta = this.meta();
      let seq = meta.seq;
      let changed = 0;
      const outcomes = [];

      for (const intent of intents) {
        const existing = this.rows(
          'SELECT company, peer, name, state FROM peer_links WHERE company = ? AND peer = ?',
          intent.company, intent.peer,
        )[0];
        const isActive = existing?.state === 'active';

        if (intent.op === 'add') {
          if (isActive) {
            // Re-adding a rival somebody already added is not an event. A NAME arriving for a link
            // that had none is still worth keeping — that is how a link added from a feed with no
            // company name acquires one later.
            const name = existing.name || companyName(intent.name);
            if (name !== existing.name) {
              this.rows('UPDATE peer_links SET name = ?, updated_at = ? WHERE company = ? AND peer = ?', name, at, intent.company, intent.peer);
              changed++;
            }
            outcomes.push({ company: intent.company, peer: intent.peer, op: 'add', outcome: 'unchanged' });
            continue;
          }
          const peersOfCompany = this.rows(
            "SELECT COUNT(*) AS count FROM peer_links WHERE company = ? AND state = 'active'", intent.company,
          )[0].count;
          if (peersOfCompany >= PEER_PER_COMPANY_LIMIT) {
            outcomes.push({ company: intent.company, peer: intent.peer, op: 'add', outcome: 'full' });
            continue;
          }
          // The company-count ceiling only bites when this add would ENROL A NEW COMPANY — a company
          // that already has peers is free to gain another up to its own per-company cap.
          if (!existing && peersOfCompany === 0) {
            const companies = this.rows(
              "SELECT COUNT(DISTINCT company) AS count FROM peer_links WHERE state = 'active'",
            )[0].count;
            if (companies >= PEER_COMPANY_LIMIT) {
              outcomes.push({ company: intent.company, peer: intent.peer, op: 'add', outcome: 'full' });
              continue;
            }
          }
          seq++;
          this.rows(
            `INSERT INTO peer_links (company, peer, name, state, added_at, removed_at, updated_at, seq)
             VALUES (?,?,?,'active',?,NULL,?,?)
             ON CONFLICT(company, peer) DO UPDATE SET name=excluded.name, state='active',
               added_at=excluded.added_at, removed_at=NULL, updated_at=excluded.updated_at, seq=excluded.seq`,
            intent.company, intent.peer, companyName(intent.name), at, at, seq,
          );
          changed++;
          outcomes.push({ company: intent.company, peer: intent.peer, op: 'add', outcome: 'added' });
          continue;
        }

        // remove
        if (!isActive) {
          outcomes.push({ company: intent.company, peer: intent.peer, op: 'remove', outcome: 'unchanged' });
          continue;
        }
        seq++;
        this.rows(
          "UPDATE peer_links SET state = 'removed', removed_at = ?, updated_at = ?, seq = ? WHERE company = ? AND peer = ?",
          at, at, seq, intent.company, intent.peer,
        );
        changed++;
        outcomes.push({ company: intent.company, peer: intent.peer, op: 'remove', outcome: 'removed' });
      }

      if (changed) {
        this.pruneTombstones();
        this.putMeta({ revision: meta.revision + 1, updatedAt: at, seq });
      } else if (seq !== meta.seq) {
        this.putMeta({ ...meta, seq });
      }
      return { outcomes, snapshot: this.peerListSnapshot() };
    });
  }
}
