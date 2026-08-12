// data/concalls.js — the con-call feed: load once, index, cache.
//
// Mirrors data/technicals.js and data/earnings.js so all three sit behind the same accessors:
//
//   await load();               // idempotent
//   companies()                 // [{ ticker, name, sector, latest, previous }] — one row per company
//   byTicker('TITAN')           // one company record
//   forScope(scope, holdings)   // narrowed to holdings, keeping "no call data" rows
//   catalystsFor(ticker)        // catalysts raised on a call or in the annual report
//   meta()                      // generated_at, counts, provenance, isMock
//
// UNLIKE earnings.json, concall-calls.json is ~2MB and is NOT loaded at bootstrap. It is
// fetched lazily the first time the Con-call tab mounts, the same treatment technicals.json
// gets — the other eight tabs should not pay for a transcript corpus they never read.
//
// PROVENANCE: transcripts, guidance and tone here are SYNTHETIC, and every person and firm
// named in them is fictional (see scripts/gen-mock-concalls.mjs). `meta().isMock` is derived
// from the payload's own `source` field; every marker on the tab reads that one flag, so
// swapping the file flips all of them at once.

const CALLS_PATH = 'data/mock/concall-calls.json';

export const LIVE_ID = 'concall-live';

let loadPromise = null;
let cache = null; // { meta, companies, byTicker, calls, catalysts }
let catalystPayload = null;

/** Seed the catalyst list from app.js's bootstrap fetch (it is small enough to load eagerly). */
export function primeCatalysts(payload) {
  catalystPayload = payload || null;
  if (cache) cache.catalysts = indexCatalysts(catalystPayload);
}

export function load() {
  if (cache) return Promise.resolve(cache);
  if (loadPromise) return loadPromise;
  loadPromise = build().catch((err) => {
    loadPromise = null; // let a later mount retry rather than wedging the tab
    throw err;
  });
  return loadPromise;
}

// Committed static files, so `no-cache` and not `no-store`: revalidate on each load, and reuse the
// bytes already on disk when the server says they have not changed. `no-store` forbids reuse
// outright, which meant a 2MB corpus was re-downloaded in full on every single visit.
async function build() {
  const res = await fetch(CALLS_PATH, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load ${CALLS_PATH} (${res.status})`);
  cache = ingest(await res.json());
  return cache;
}

function indexCatalysts(payload) {
  const rows = Array.isArray(payload?.catalysts) ? payload.catalysts : [];
  const byTicker = new Map();
  for (const c of rows) {
    const key = String(c.ticker || '').toUpperCase();
    if (!key) continue;
    if (!byTicker.has(key)) byTicker.set(key, []);
    byTicker.get(key).push(c);
  }
  return { rows, byTicker, meta: { generated_at: payload?.generated_at ?? null, source: payload?.source ?? null } };
}

function ingest(payload) {
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const latestQuarter = payload?.quarter ?? null;

  // Group calls by company, newest first, so `latest` and `previous` are unambiguous.
  const grouped = new Map();
  for (const call of calls) {
    const key = String(call.ticker || '').toUpperCase();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(call);
  }

  const companies = [];
  const byTicker = new Map();
  for (const [ticker, list] of grouped) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latest = list[0] || null;
    const previous = list[1] || null;
    const record = {
      ticker,
      name: latest?.name || ticker,
      sector: latest?.sector || '',
      latest,
      previous,
      calls: list,
      // A scheduled call has no transcript yet — the tab must show it as upcoming rather than
      // as a company that mentioned nothing. Kept as a flag so no view has to re-derive it.
      hasTranscript: !!latest?.transcript?.length,
      status: latest?.status || 'completed',
    };
    companies.push(record);
    byTicker.set(ticker, record);
  }
  companies.sort((a, b) => a.name.localeCompare(b.name));

  return {
    meta: {
      generated_at: payload?.generated_at ?? null,
      source: payload?.source ?? 'Mock data',
      generator: payload?.generator ?? null,
      seed: payload?.seed ?? null,
      quarter: latestQuarter,
      previous_quarter: payload?.previous_quarter ?? null,
      as_of: payload?.as_of ?? null,
      company_count: payload?.company_count ?? companies.length,
      call_count: payload?.call_count ?? calls.length,
      provenance: payload?._provenance ?? null,
      isMock: String(payload?.source ?? '').toLowerCase().includes('mock'),
    },
    companies,
    byTicker,
    calls,
    catalysts: indexCatalysts(catalystPayload),
  };
}

// ---- accessors (synchronous; call load() first) --------------------------------------------

export function companies() {
  return cache ? cache.companies : [];
}
export function meta() {
  return cache ? cache.meta : null;
}
export function isLoaded() {
  return !!cache;
}
export function byTicker(ticker) {
  if (!cache || !ticker) return null;
  return cache.byTicker.get(String(ticker).toUpperCase()) || null;
}
export function callById(callId) {
  if (!cache || !callId) return null;
  return cache.calls.find((c) => c.callId === callId) || null;
}
export function allCatalysts() {
  return cache?.catalysts?.rows ?? (catalystPayload?.catalysts || []);
}
export function catalystsFor(ticker) {
  if (!ticker) return [];
  const key = String(ticker).toUpperCase();
  return cache?.catalysts?.byTicker.get(key) || (catalystPayload?.catalysts || []).filter((c) => String(c.ticker).toUpperCase() === key);
}

/** Calls in progress right now. */
export function liveCalls() {
  return companies().filter((c) => c.status === 'live');
}
/** Calls scheduled but not yet held. */
export function scheduledCalls() {
  return companies().filter((c) => c.status === 'scheduled');
}

/**
 * forScope('universe') → every company with a call.
 * forScope('portfolio', holdings) → the portfolio's holdings.
 *
 * A holding with no call is NOT dropped: it comes back carrying `noCallData`, so the table
 * shows "no call data" instead of the position silently vanishing from a portfolio view.
 */
export function forScope(scope, holdings = []) {
  const rows = companies();
  if (scope !== 'portfolio') return rows;

  const out = [];
  for (const h of holdings) {
    const hit = byTicker(h.ticker);
    if (hit) {
      out.push(hit);
    } else {
      out.push({
        ticker: h.ticker,
        name: h.name || h.ticker,
        sector: h.sector || '',
        latest: null,
        previous: null,
        calls: [],
        hasTranscript: false,
        status: 'none',
        noCallData: 'No con-call in the current set for this holding',
      });
    }
  }
  return out;
}

// ---- live engine wiring ---------------------------------------------------------------------

// How far into each in-progress call the ticker has read. Lives here rather than in the view
// so a re-render (scope change, keyword edit, sub-view switch) does not rewind the call.
const cursors = new Map(); // callId -> { revealed, elapsedSec }

/** Segments whose timestamp has already passed at `elapsedSec` — where a live call starts. */
function segmentsBy(call, elapsedSec) {
  const segs = call?.transcript || [];
  let n = 0;
  while (n < segs.length && (segs[n].t ?? 0) <= elapsedSec) n++;
  return Math.max(1, n);
}

function cursorFor(company) {
  const call = company?.latest;
  if (!call?.callId) return null;
  let cur = cursors.get(call.callId);
  if (!cur) {
    // `initialElapsedSec` is where the call is when the page loads. It is stored as a duration,
    // not a wall-clock start: a fixed start timestamp in a committed mock file would read
    // "started 340 days ago" the moment the file ages past its generation date.
    const elapsedSec = call.initialElapsedSec ?? 0;
    cur = { revealed: segmentsBy(call, elapsedSec), elapsedSec };
    cursors.set(call.callId, cur);
  }
  return cur;
}

/** Read-only view of where an in-progress call has got to. */
export function liveCursor(callId) {
  const cur = cursors.get(callId);
  return cur ? { ...cur } : null;
}

/**
 * The live tick.
 *
 * A real feed would expose "segments appended since <cursor>", and this would be
 * `live.realFetcher('/api/concalls/live?since=…')`. There is no such endpoint yet, so this
 * computes the same shape from the corpus already in memory and advances the cursor by one
 * segment per tick.
 *
 * It deliberately does NOT re-fetch concall-calls.json. That file is ~2MB; re-downloading it
 * every five seconds to learn that one more sentence was spoken would be indefensible, and
 * `live.mockFetcher` would also jitter numbers inside quoted speech — inventing words nobody
 * said. The discipline that matters is still the engine's: polls only while started and
 * visible, backs off on error, never throws into the UI.
 */
async function liveTickFetcher() {
  const at = Date.now();
  const calls = liveCalls().map((company) => {
    const call = company.latest;
    const cur = cursorFor(company);
    const total = call.transcript?.length || 0;
    if (cur.revealed < total) cur.revealed += 1;
    cur.elapsedSec += 5;
    return {
      callId: call.callId,
      ticker: company.ticker,
      revealed: cur.revealed,
      total,
      elapsedSec: cur.elapsedSec,
      complete: cur.revealed >= total,
      // The segment just appended — what the ticker renders and the scanner checks for a hit.
      appended: cur.revealed > 0 ? call.transcript[cur.revealed - 1] : null,
    };
  });
  return { at, calls };
}

/** Register the con-call poller. 5s cadence — fast enough that a live call visibly moves. */
export function registerPoller(live, { intervalMs = 5000 } = {}) {
  live.register(LIVE_ID, { intervalMs, fetcher: liveTickFetcher });
}
