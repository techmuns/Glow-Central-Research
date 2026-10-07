// One read-only stream over the existing BSE/company captures and live NSE feed.
import { announcements } from './filings.js';
import * as nseFilings from './nse-filings.js';
<<<<<<< HEAD
import { announcementUrl, mergeAnnouncements, mergeAnnouncementsAsync } from './announcements-shared.js';
=======
import { announcementUrl, mergeAnnouncementSteps } from './announcements-shared.js';
>>>>>>> sattva/main
import { createAnnouncementIdentity, filingTicker, mergeExchangeIdentities } from './announcement-identity.js';
import { capturedJson } from './company-captures.js';
import { filterByScope } from './scope.js';
import * as watchlist from '../core/watchlist.js';
<<<<<<< HEAD
import { mapSteps, runSteps, runStepsInSlices } from '../core/slices.js';
=======
import { runSteps, runStepsInSlices, yieldToInput } from '../core/slices.js';
>>>>>>> sattva/main

export const LIVE_ID = 'corporate-announcements';
export const POLL_MS = 90_000;

export function nseAnnouncement(row) {
  const time = Date.parse(row.publishedAt || '');
  const ist = Number.isFinite(time) ? new Date(time + 19800000).toISOString() : null;
  return { ...row, title: row.subject || row.description || null, summary: row.description || null,
    date: ist?.slice(0, 10) || null, time: ist?.slice(11, 19) || null,
    url: announcementUrl(row.url), source: 'NSE', sources: ['NSE'], providers: ['NSE announcements RSS'] };
}

export function createCorporateAnnouncementsFeed({ base = announcements, nse = nseFilings,
  readIdentities = () => capturedJson('data/announcement-identities.json'),
  readNseIdentities = () => capturedJson('data/filing-capture/nse-identities.json') } = {}) {
  let pending = null, historyPending = null, held = [], nseError = null;
  let identity = createAnnouncementIdentity(), identityError = null, identityRevision = null;
  let bseIdentities = [], nseIdentityError = null;
  let identityKey = '', rowInputs = null, heldText = [];
<<<<<<< HEAD
=======
  let preparingRows = null;
>>>>>>> sattva/main
  let identityGeneration = 0;
  const nseDirectories = { sme: [], equity: [] };
  async function loadBseIdentities() {
    try {
      const { value, stale } = await readIdentities();
      if (value?.version !== 1 || !Array.isArray(value.entries) || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error('Exchange company identities could not be read.');
      if (identityRevision !== value.capturedAt) {
        bseIdentities = value.entries;
        identityRevision = value.capturedAt;
      }
      identityError = stale ? 'Using saved exchange company identities.' : null;
    } catch (error) { identityError = error.message; }
  }
  async function loadNseIdentities() {
    try {
      const { value, stale } = await readNseIdentities();
      if (value?.version !== 1 || !value.directories) throw new Error('NSE company identities could not be read.');
      nseIdentityError = stale ? 'Using saved NSE company identities.' : null;
      for (const kind of ['sme', 'equity']) {
        const directory = value.directories[kind];
        if (Array.isArray(directory?.entries)) nseDirectories[kind] = directory.entries;
        if (!Array.isArray(directory?.entries) || directory.error) nseIdentityError = 'Some NSE company identities could not be checked; verified mappings are retained.';
      }
    } catch (error) { nseIdentityError = error.message; }
  }
  async function loadIdentities() {
    await Promise.all([loadBseIdentities(), loadNseIdentities()]);
    const entries = mergeExchangeIdentities(bseIdentities, nseDirectories.sme, nseDirectories.equity);
    const nextKey = JSON.stringify(entries);
    if (nextKey !== identityKey) { identity = createAnnouncementIdentity(entries); identityKey = nextKey; identityGeneration++; }
  }
  const listeners = new Set();
  let cachedBase = { input: null, output: null, identity: null };
  let cachedNse = { input: null, output: null, identity: null };
  let cachedHeld = { input: null, output: null, identity: null };

<<<<<<< HEAD
  function projectedInputs(baseRows, nseRows) {
    if (cachedBase.input !== baseRows || cachedBase.identity !== identity) {
      cachedBase = { input: baseRows, identity, output: baseRows.map(identity.row) };
    }
    if (cachedNse.input !== nseRows || cachedNse.identity !== identity) {
      cachedNse = { input: nseRows, identity, output: nseRows.map(nseAnnouncement).map(identity.row) };
    }
    if (cachedHeld.input !== held || cachedHeld.identity !== identity) {
      cachedHeld = { input: held, identity, output: held.map(identity.row) };
    }
    return [cachedHeld.output, cachedBase.output, cachedNse.output];
  }
  async function projectedInputsAsync(baseRows, nseRows, directory, previous) {
    if (cachedBase.input !== baseRows || cachedBase.identity !== directory) {
      cachedBase = { input: baseRows, identity: directory, output: await runStepsInSlices(mapSteps(baseRows, directory.row)) };
    }
    if (cachedNse.input !== nseRows || cachedNse.identity !== directory) {
      cachedNse = { input: nseRows, identity: directory,
        output: await runStepsInSlices(mapSteps(nseRows, row => directory.row(nseAnnouncement(row)))) };
    }
    if (cachedHeld.input !== previous || cachedHeld.identity !== directory) {
      cachedHeld = { input: previous, identity: directory, output: await runStepsInSlices(mapSteps(previous, directory.row)) };
    }
    return [cachedHeld.output, cachedBase.output, cachedNse.output];
  }
  const rowText = row => JSON.stringify(row);
  function publish(next, baseRows, nseRows, nextText = runSteps(mapSteps(next, rowText))) {
    if (nextText.length !== heldText.length || nextText.some((text, i) => text !== heldText[i])) { held = next; heldText = nextText; }
    rowInputs = { base: baseRows, nse: nseRows, identity };
    return held;
  }

  const rows = () => {
    const baseRows = base.rows(), nseRows = nse.retainedRows();
    if (rowInputs?.identity === identity && rowInputs.base === baseRows && rowInputs.nse === nseRows) return held;

    // Some readers expose a new array over the same immutable records. Check that
    // before projecting every record: meta()/scope reads must not repeat the work.
    if (rowInputs?.identity === identity && rowInputs.base.length === baseRows.length &&
        rowInputs.base.every((r, i) => r === baseRows[i]) && rowInputs.nse.length === nseRows.length &&
        rowInputs.nse.every((r, i) => r === nseRows[i])) {
      rowInputs = { base: baseRows, nse: nseRows, identity };
      return held;
    }

    const next = mergeAnnouncements(...projectedInputs(baseRows, nseRows));
    // A successful response can replace objects without changing any filing.
    // Compare once per source arrival; ordinary rows/meta reads keep the fast
    // reference path above and unchanged responses keep the reader's controls.
    return publish(next, baseRows, nseRows);
  };
  let preparing = null;
  function prepareRows() {
    if (preparing) return preparing;
    preparing = (async () => {
      for (;;) {
        await base.prepareRows?.();
        const baseRows = base.rows(), nseRows = nse.retainedRows(), directory = identity, previous = held;
        if (rowInputs?.identity === identity && rowInputs.base === baseRows && rowInputs.nse === nseRows) return;
        const projected = await projectedInputsAsync(baseRows, nseRows, directory, previous);
        const next = await mergeAnnouncementsAsync(projected);
        const text = await runStepsInSlices(mapSteps(next, rowText));
        const currentNse = nse.retainedRows();
        if (directory !== identity || previous !== held || baseRows !== base.rows() ||
            currentNse.length !== nseRows.length || currentNse.some((r, i) => r !== nseRows[i])) continue;
        publish(next, baseRows, currentNse, text);
        return;
      }
    })().finally(() => { preparing = null; });
    return preparing;
=======
  const inputs = () => ({ base: base.rows(), nse: nse.retainedRows(), identity, held });
  const sameArray = (a, b) => a === b || !!a && a.length === b.length && a.every((row, i) => row === b[i]);
  const sameInputs = (a, b) => !!a && a.identity === b.identity && sameArray(a.base, b.base) && sameArray(a.nse, b.nse);
  function* mappedRows(input, cached, map, currentIdentity) {
    if (sameArray(cached.input, input) && cached.identity === currentIdentity) return cached;
    const output = [];
    for (const row of input) {
      output.push(map(row));
      if (output.length % 128 === 0) yield;
    }
    return { input, output, identity: currentIdentity };
  }
  function* buildRows(input) {
    // A synchronous reader can advance held while an earlier rebuild yields.
    // Keep that earlier observation ahead of the newer snapshot in the merge.
    const prior = input.prior
      ? (yield* mappedRows(input.prior, { input: null }, input.identity.row, input.identity)).output : [];
    const fromBase = yield* mappedRows(input.base, cachedBase, input.identity.row, input.identity);
    const fromNse = yield* mappedRows(input.nse, cachedNse, row => input.identity.row(nseAnnouncement(row)), input.identity);
    const fromHeld = yield* mappedRows(input.held, cachedHeld, input.identity.row, input.identity);
    const next = yield* mergeAnnouncementSteps(prior, fromHeld.output, fromBase.output, fromNse.output);
    // Compare identical bytes one row at a time. A whole-history stringify itself blocks
    // input and duplicates the complete payload; per-row checks can yield between batches.
    const text = [];
    let changed = next.length !== input.held.length;
    for (let i = 0; i < next.length; i++) {
      text.push(JSON.stringify(next[i]));
      if (text[i] !== heldText[i]) changed = true;
      if ((i + 1) % 128 === 0) yield;
    }
    return { next, text, changed, fromBase, fromNse, fromHeld };
  }
  function adopt(input, result) {
    cachedBase = result.fromBase; cachedNse = result.fromNse; cachedHeld = result.fromHeld;
    if (result.changed) { held = result.next; heldText = result.text; }
    rowInputs = { base: input.base, nse: input.nse, identity: input.identity };
    return held;
  }
  const rows = () => {
    const input = inputs();
    if (sameInputs(rowInputs, input)) return held;
    return adopt(input, runSteps(buildRows(input)));
  };
  async function prepareRows(yieldForInput = yieldToInput, { sliceMs } = {}) {
    // The underlying retained BSE stream has its own sliced merge; warm that first.
    await base.warm?.(yieldForInput);
    if (preparingRows) return preparingRows;
    preparingRows = (async () => {
      let prior = null;
      for (;;) {
        const input = { ...inputs(), prior };
        if (!prior && sameInputs(rowInputs, input)) return held;
        const result = await runStepsInSlices(buildRows(input), { yieldForInput, sliceMs });
        // Retain every fully observed snapshot, even if the source rolled over during a yield.
        // Notify readers only after the latest inputs (including identity corrections) are ready.
        if (held === input.held) {
          adopt(input, result);
          prior = null;
          if (sameInputs(input, inputs())) return held;
        } else {
          // Merge this older observation with the synchronous reader's newer answer next;
          // neither may overwrite the other or disappear because a snapshot was replaced.
          prior = result.next;
        }
      }
    })().finally(() => { preparingRows = null; });
    return preparingRows;
>>>>>>> sattva/main
  }
  const emit = () => listeners.forEach((fn) => fn());
  function loadHistory() {
    if (historyPending) return historyPending;
    historyPending = Promise.allSettled([
      base.loadArchive({ onlyChanged: true }),
      nse.loadHistory(90, { updateWindow: false }),
<<<<<<< HEAD
    ]).then(prepareRows).finally(() => { historyPending = null; emit(); });
=======
    ]).finally(async () => {
      try { await prepareRows(); } finally { historyPending = null; emit(); }
    });
>>>>>>> sattva/main
    return historyPending;
  }
  function read(initial, items) {
    if (pending) return pending;
    pending = (async () => {
<<<<<<< HEAD
      const before = held.length;
=======
      const before = (await prepareRows()).length;
>>>>>>> sattva/main
      const results = await Promise.allSettled([
        initial ? base.load(items) : base.refreshSnapshot(),
        initial ? nse.load() : nse.refresh(),
        loadIdentities(),
      ]);
      nseError = results[1].status === 'rejected' ? results[1].reason.message : null;
      await prepareRows();
      emit(); // Latest announcements appear before older files finish loading.
      // A slow historical download must never hold up the next live-source check.
      void loadHistory();
      return { added: Math.max(0, held.length - before), failed: nseError ? 1 : 0 };
    })().finally(() => { pending = null; emit(); });
    return pending;
  }
  return {
    ...base, rows, prepareRows,
    companyKey: company => identity.key(company),
    companyIdentity: company => ({ ...company, ...identity.find(company) }),
    forTicker: (ticker) => {
      const wanted = identity.key({ ticker: filingTicker(ticker) });
      return wanted ? rows().filter(row => identity.key(row) === wanted) : [];
    },
    filterByScope(list, scope, holdings) {
      if (scope === 'universe') return filterByScope(list, scope, holdings);
      const companies = scope === 'portfolio' ? holdings : watchlist.all();
      const wanted = new Set(companies.map(identity.key).filter(Boolean));
      return list.filter(row => wanted.has(identity.key(row)));
    },
    meta() {
      const m = base.meta(), list = rows();
      return { ...m, rowCount: list.length, covered: new Set(list.map((row) => row.ticker).filter(Boolean)).size,
        reason: list.length ? null : m.reason, identity: { capturedAt: identityRevision, revision: identityGeneration, error: identityError || nseIdentityError },
        nse: { ...nse.meta(), error: nseError } };
    },
    load: (items) => read(true, items),
    loadArchive: loadHistory,
    refresh: () => read(false),
    onChange(fn) {
      listeners.add(fn);
      let active = true;
      const notify = () => { if (active) fn(); };
      const prepared = () => { void prepareRows().then(notify, notify); };
      const offBase = base.onChange(prepared), offNse = nse.onChange(prepared);
      return () => { active = false; listeners.delete(fn); offBase(); offNse(); };
    },
    startLive(live) {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: () => read(false) });
      live.start(LIVE_ID, { fresh: true });
    },
    stopLive: (live) => live.stop(LIVE_ID),
  };
}

export const corporateAnnouncements = createCorporateAnnouncementsFeed();
