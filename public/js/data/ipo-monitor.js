import { validateIpoSnapshot, validateScoring } from './ipo-monitor-shared.js';
import { validDay } from './combined-filings-shared.js';

const historyIndex = (dates) => {
  if (!Array.isArray(dates) || dates.some((date) => !validDay(date)))
    throw new Error('Invalid history index');
  return [...new Set(dates)].sort().reverse();
};

export function createIpoFeed({ fetcher = fetch } = {}) {
  const state = {
    bundle: null,
    snapshots: new Map(),
    failedDates: new Set(),
    localDates: new Set(),
    fallback: false,
    error: null,
  };
  const read = async (url, signal) => {
    const deadline = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(url.startsWith('api/') ? 22000 : 8000),
    ]);
    const response = await fetcher(url, { cache: 'no-store', signal: deadline });
    if (!response.ok) throw new Error('IPO source unavailable');
    return response.json();
  };
  async function load(signal) {
    let bundle;
    try {
      bundle = await read('api/ipo-monitor', signal);
      if (!bundle.ok) throw new Error('IPO source unavailable');
      validateIpoSnapshot(bundle.latest);
      bundle.historyDates = historyIndex(bundle.historyDates);
      if (bundle.config) validateScoring(bundle.config);
      if (!bundle.historyAvailable) {
        // An API index outage must not hide already-imported history. Keep the live latest
        // capture and explicitly mark that discovery of newer archive dates is unavailable.
        try {
          const index = await read('data/ipo-monitor/index.json', signal);
          bundle.historyDates = historyIndex(index.historyDates);
          bundle.historyIndexFallback = true;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
      state.fallback = false;
      state.error = null;
    } catch (error) {
      if (signal?.aborted) throw error;
      const [latest, config, index] = await Promise.all(
        ['latest.json', 'scoring_config.json', 'index.json'].map((path) =>
          read(`data/ipo-monitor/${path}`, signal),
        ),
      );
      bundle = {
        latest: validateIpoSnapshot(latest),
        config: validateScoring(config),
        historyDates: historyIndex(index.historyDates),
        historyAvailable: true,
        checkedAt: null,
        source: `Bundled DRHP snapshot · ${index.sourceCommit}`,
      };
      state.fallback = true;
      state.error = 'The current published source could not be read. Showing the bundled capture.';
    }
    // The live latest may be newer than a bundled/stale index; it is still a loaded capture.
    bundle.historyDates = historyIndex([...bundle.historyDates, bundle.latest.meta.snapshot_id]);
    if (signal?.aborted) throw new Error('Cancelled');
    state.bundle = bundle;
    state.snapshots.set(bundle.latest.meta.snapshot_id, bundle.latest);
    return state;
  }
  async function loadHistory(signal, limit = 20) {
    const dates = (state.bundle?.historyDates || [])
      .filter((date) => !state.snapshots.has(date) || state.failedDates.has(date))
      .slice(0, limit);
    // Small bounded pool; loading the tracker never starts the upstream capture pipeline.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, dates.length) }, async () => {
        while (next < dates.length && !signal?.aborted) {
          const date = dates[next++];
          try {
            let snapshot;
            try {
              if (state.fallback) throw new Error('Use local capture');
              const result = await read(`api/ipo-monitor?snapshot=${encodeURIComponent(date)}`, signal);
              if (!result.ok) throw new Error('Snapshot unavailable');
              snapshot = validateIpoSnapshot(result.snapshot);
              state.localDates.delete(date);
            } catch (error) {
              if (signal?.aborted) throw error;
              snapshot = validateIpoSnapshot(await read(`data/ipo-monitor/snapshots/${date}.json`, signal));
              state.localDates.add(date);
            }
            if (snapshot.meta.snapshot_id !== date) throw new Error('Wrong snapshot');
            if (signal?.aborted) return;
            state.snapshots.set(date, snapshot);
            state.failedDates.delete(date);
          } catch {
            if (!signal?.aborted) state.failedDates.add(date);
          }
        }
      }),
    );
    return state;
  }
  return { state, load, loadHistory };
}
