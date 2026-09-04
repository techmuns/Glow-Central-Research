// One read-only stream over the existing BSE/company captures and live NSE feed.
import { announcements } from './filings.js';
import * as nseFilings from './nse-filings.js';
import { announcementUrl, mergeAnnouncements } from './announcements-shared.js';

export const LIVE_ID = 'corporate-announcements';
export const POLL_MS = 90_000;

export function nseAnnouncement(row) {
  const time = Date.parse(row.publishedAt || '');
  const ist = Number.isFinite(time) ? new Date(time + 19800000).toISOString() : null;
  return { ...row, title: row.subject || row.description || null, summary: row.description || null,
    date: ist?.slice(0, 10) || null, time: ist?.slice(11, 19) || null,
    url: announcementUrl(row.url), source: 'NSE', sources: ['NSE'], providers: ['NSE announcements RSS'] };
}

export function createCorporateAnnouncementsFeed({ base = announcements, nse = nseFilings } = {}) {
  let pending = null, historyPending = null, held = [], nseError = null;
  const listeners = new Set();
  const rows = () => {
    held = mergeAnnouncements(held, base.rows(), nse.retainedRows().map(nseAnnouncement));
    return held;
  };
  const emit = () => listeners.forEach((fn) => fn());
  function loadHistory() {
    if (historyPending) return historyPending;
    historyPending = Promise.allSettled([
      base.loadArchive({ onlyChanged: true }),
      nse.loadHistory(90, { updateWindow: false }),
    ]).finally(() => { historyPending = null; emit(); });
    return historyPending;
  }
  function read(initial, items) {
    if (pending) return pending;
    pending = (async () => {
      const before = rows().length;
      const results = await Promise.allSettled([
        initial ? base.load(items) : base.refreshSnapshot(),
        initial ? nse.load() : nse.refresh(),
      ]);
      nseError = results[1].status === 'rejected' ? results[1].reason.message : null;
      emit(); // Latest announcements appear before older files finish loading.
      // A slow historical download must never hold up the next live-source check.
      void loadHistory();
      return { added: Math.max(0, rows().length - before), failed: nseError ? 1 : 0 };
    })().finally(() => { pending = null; emit(); });
    return pending;
  }
  return {
    ...base, rows,
    forTicker: (ticker) => rows().filter((row) => row.ticker === String(ticker).toUpperCase()),
    meta() {
      const m = base.meta(), list = rows();
      return { ...m, rowCount: list.length, covered: new Set(list.map((row) => row.ticker).filter(Boolean)).size,
        reason: list.length ? null : m.reason, nse: { ...nse.meta(), error: nseError } };
    },
    load: (items) => read(true, items),
    loadArchive: loadHistory,
    refresh: () => read(false),
    onChange(fn) {
      listeners.add(fn);
      const offBase = base.onChange(fn), offNse = nse.onChange(fn);
      return () => { listeners.delete(fn); offBase(); offNse(); };
    },
    startLive(live) {
      live.register(LIVE_ID, { intervalMs: POLL_MS, fetcher: () => read(false) });
      live.start(LIVE_ID);
    },
    stopLive: (live) => live.stop(LIVE_ID),
  };
}

export const corporateAnnouncements = createCorporateAnnouncementsFeed();
