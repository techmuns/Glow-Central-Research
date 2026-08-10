// core/live.js — small pub/sub polling engine so tabs can "just subscribe" to live data.
//
//   live.register('concall-feed', { intervalMs: 15000, fetcher: live.mockFetcher('data/mock/concall-feed.json') });
//   const unsubscribe = live.subscribe('concall-feed', (rows) => { ...render... });
//   live.start('concall-feed');   // call from a tab's render()
//   live.stop('concall-feed');    // call from that tab's destroy()
//
// Pollers only tick while both `start()` has been called (their tab is mounted) AND the
// document is visible — they pause on hidden and refetch immediately when it becomes visible
// again. A failed fetch never throws into the UI: it logs, backs off, and keeps the last good
// data on screen.

const pollers = new Map(); // id -> poller record
let lastGlobalTick = null;
const globalTickListeners = new Set();

function makeRecord(id, { intervalMs, fetcher }) {
  return {
    id,
    intervalMs,
    fetcher,
    timer: null,
    running: false, // start() called (tab mounted)
    inFlight: false,
    errorCount: 0,
    lastData: null,
    lastTick: null,
    lastError: null,
    listeners: new Set(),
  };
}

// Register (or update) a poller. Safe to call again with the same id — e.g. on tab re-render —
// it just refreshes the config without dropping existing subscribers or restarting a live timer.
export function register(id, { intervalMs, fetcher }) {
  const existing = pollers.get(id);
  if (existing) {
    existing.intervalMs = intervalMs;
    existing.fetcher = fetcher;
    return;
  }
  pollers.set(id, makeRecord(id, { intervalMs, fetcher }));
}

export function subscribe(id, cb) {
  const poller = pollers.get(id);
  if (!poller) {
    console.warn(`[live] subscribe() before register() for "${id}"`);
    return () => {};
  }
  poller.listeners.add(cb);
  if (poller.lastData !== null) cb(poller.lastData, { error: null });
  return () => unsubscribe(id, cb);
}

export function unsubscribe(id, cb) {
  pollers.get(id)?.listeners.delete(cb);
}

// Begin polling (called when the owning tab mounts). Fetches immediately, then on interval.
export function start(id) {
  const poller = pollers.get(id);
  if (!poller || poller.running) return;
  poller.running = true;
  if (!document.hidden) scheduleTick(poller, 0);
}

// Stop polling (called when the owning tab unmounts). Leaves subscribers intact.
export function stop(id) {
  const poller = pollers.get(id);
  if (!poller) return;
  poller.running = false;
  clearTimer(poller);
}

export function getLastTick(id) {
  return id ? pollers.get(id)?.lastTick ?? null : lastGlobalTick;
}

// Header "Live" pill hook — fires whenever ANY poller completes a successful fetch.
export function onGlobalTick(cb) {
  globalTickListeners.add(cb);
  return () => globalTickListeners.delete(cb);
}

function clearTimer(poller) {
  if (poller.timer) {
    clearTimeout(poller.timer);
    poller.timer = null;
  }
}

function scheduleTick(poller, delay) {
  clearTimer(poller);
  poller.timer = setTimeout(() => tick(poller), delay);
}

async function tick(poller) {
  if (!poller.running || document.hidden || poller.inFlight) return;
  poller.inFlight = true;
  try {
    const data = await poller.fetcher();
    poller.inFlight = false;
    poller.errorCount = 0;
    poller.lastError = null;
    poller.lastData = data;
    poller.lastTick = Date.now();
    lastGlobalTick = poller.lastTick;
    for (const cb of poller.listeners) safeNotify(cb, data, null);
    for (const cb of globalTickListeners) safeNotify(cb, lastGlobalTick);
  } catch (err) {
    poller.inFlight = false;
    poller.errorCount += 1;
    poller.lastError = err;
    console.error(`[live] poller "${poller.id}" failed (attempt ${poller.errorCount})`, err);
    // Never throw into the UI — subscribers just keep showing the last good data.
  } finally {
    if (poller.running) {
      const backoff = Math.min(poller.intervalMs * 2 ** poller.errorCount, 60000);
      scheduleTick(poller, poller.errorCount > 0 ? backoff : poller.intervalMs);
    }
  }
}

function safeNotify(cb, ...args) {
  try {
    cb(...args);
  } catch (err) {
    console.error('[live] subscriber threw', err);
  }
}

// Pause every running poller when the tab is hidden; refetch immediately on return so the
// data is never stale-looking when the user comes back.
document.addEventListener('visibilitychange', () => {
  for (const poller of pollers.values()) {
    if (!poller.running) continue;
    if (document.hidden) clearTimer(poller);
    else scheduleTick(poller, 0);
  }
});

// ---- Fetchers -------------------------------------------------------------------------------

const JITTER_SKIP_KEYS = new Set(['id', 'ticker', 'qty', 'quantity', 'year', 'code', 'isin', 'reportDate', 'date', 'timestamp', 'postedAt', 'asOf', 'quarter']);

function jitterDeep(node, amount) {
  if (Array.isArray(node)) return node.map((item) => jitterDeep(item, amount));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = JITTER_SKIP_KEYS.has(key) ? value : jitterDeep(value, amount);
    }
    return out;
  }
  if (typeof node === 'number' && Number.isFinite(node)) {
    const factor = 1 + (Math.random() * 2 - 1) * amount;
    return Math.round(node * factor * 100) / 100;
  }
  return node;
}

// Development fetcher: reads a static mock JSON file and jitters its numbers slightly on every
// poll so the UI visibly "breathes" even though the underlying file never changes on disk.
export function mockFetcher(path, { jitter = 0.02 } = {}) {
  return async function fetchMock() {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`mockFetcher: ${path} -> ${res.status}`);
    const data = await res.json();
    return jitterDeep(data, jitter);
  };
}

// Real fetcher path (wired in a later prompt): same signature as mockFetcher, so swapping a
// tab from mock to live data is a one-line change at the call site —
//   live.register('technicals', { intervalMs: 30000, fetcher: live.realFetcher('/api/technicals') })
export function realFetcher(url, options = {}) {
  return async function fetchLive() {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`realFetcher: ${url} -> ${res.status}`);
    return res.json();
  };
}
