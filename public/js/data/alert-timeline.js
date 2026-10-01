// Reading a card's complete retained evidence must not change its 14-day priority.
import { foldAlertRowsAsync as foldAlertRowsInSlices, developmentOfRow } from './alert-developments.js';
import { newsCanSupportAI, isRelatedNewsContext } from './company-news-attribution.js';
import { matchesAIEvent } from './ai-alert-types.js';
import { runStepsInSlices, sortSteps } from '../core/slices.js';
import { AI_ALERT_WINDOW_DAYS } from '../core/alert-window.js';
import { publicAlertFeed } from './all-alerts-cache.js';
import { shiftDay } from './alert-pool-shared.js';

export const timelineKey = card => String(card.key || card.ticker || card.entityId);
export const incompleteHistory = report => !report || !!report.pending || report.feeds?.some(feed => ['pending', 'failed'].includes(feed.status));
const sameCompany = (event, card) => !!(card.ticker && event.ticker === card.ticker || card.entityId && event.entityId === card.entityId);
const newest = (a, b) => String(b.event.day || '').localeCompare(String(a.event.day || '')) ||
  // A clockless material update still follows its known proposal. Never invent a time.
  (a.event.storyId && a.event.storyId === b.event.storyId && (!a.event.time || !b.event.time)
    ? (b.event.storySequence || 0) - (a.event.storySequence || 0) : 0) ||
  String(b.event.time || '').localeCompare(String(a.event.time || '')) || (b.event.importance === 'high') - (a.event.importance === 'high');
const entries = new WeakMap();
function entry(dev) {
  if (!entries.has(dev)) entries.set(dev, { id: String(dev.lead.id), event: dev.lead, dev });
  return entries.get(dev);
}
function* selectHistory(card, history, day, filters) {
  const selected = new Map();
  const oldestRecent = shiftDay(day, 1 - AI_ALERT_WINDOW_DAYS);
  for (let i = 0; i < (history?.events?.length || 0); i++) {
    const event = history.events[i];
    if (sameCompany(event, card) && event.day && event.day < oldestRecent &&
        (newsCanSupportAI(event) && event.aiEligible !== false || isRelatedNewsContext(event)) && matchesAIEvent(event, filters)) selected.set(String(event.id), event);
    if ((i & 511) === 511) yield;
  }
  // The live card owns the recent window, including corrections, filtering and removals.
  for (let i = 0; i < card.events.length; i++) {
    const event = card.events[i];
    // Reproject original members through Sattva’s single checked grouping authority.
    for (const source of event.storyReports || [event]) selected.set(String(source.id), source);
    if ((i & 511) === 511) yield;
  }
  return [...selected.values()];
}
function* orderRows(developments, foldedRows) {
  const rows = [];
  for (let i = 0; i < developments.length; i++) {
    rows.push(entry(foldedRows ? developmentOfRow(developments[i]) : developments[i]));
    if ((i & 511) === 511) yield;
  }
  yield* sortSteps(rows, newest);
  return rows;
}
/** Complete data, sliced preparation, bounded DOM owned by ui/alert-timeline.js. */
export async function prepareTimeline(card, { history = null, day, filters, isCurrent = () => true } = {}) {
  const options = { keepGoing: isCurrent, sliceMs: 8 };
  let developments = card.developments, foldedRows = false;
  if (history || !developments?.length) {
    const events = await runStepsInSlices(selectHistory(card, history, day, filters), options);
    if (!events || !isCurrent()) return null;
    const rows = await foldAlertRowsInSlices(events, options);
    if (!rows || !isCurrent()) return null;
    developments = rows; foldedRows = true;
  }
  const rows = await runStepsInSlices(orderRows(developments, foldedRows), options);
  return isCurrent() ? rows : null;
}

function* retainFailedHistory(previous, report) {
  const states = new Map((report.feeds || []).map(feed => [feed.id, feed.status]));
  const incomingIds = new Map(), events = [];
  for (let i = 0; i < report.events.length; i++) {
    const event = report.events[i];
    if (!incomingIds.has(event.feed)) incomingIds.set(event.feed, new Set());
    incomingIds.get(event.feed).add(String(event.id));
    if ((i & 511) === 511) yield;
  }
  for (let i = 0; i < previous.events.length; i++) {
    const event = previous.events[i], status = states.get(event.feed);
    // A successful source can remove/correct a record. Revoked private records must disappear
    // even if an unrelated public source failed; never revive them from the old view.
    if (!event.private && !event.portfolioOnly && publicAlertFeed({ id: event.feed }) &&
        (['pending', 'failed'].includes(status) || !status && report.pending) &&
        !incomingIds.get(event.feed)?.has(String(event.id))) events.push(event);
    if ((i & 511) === 511) yield;
  }
  // Several company matches can legitimately share an id. Replace whole identity groups,
  // preserving all records inside the current group instead of collapsing it into one Map entry.
  for (let i = 0; i < report.events.length; i++) {
    events.push(report.events[i]);
    if ((i & 511) === 511) yield;
  }
  return events;
}

/** One shared, on-demand archive read per open view; repeated cards share its source work. */
export function createTimelineHistory({ collect, options, isCurrent }) {
  let saved = null, pending = null;
  return {
    get loaded() { return !!saved; },
    read({ refresh = false, memoryOnly = false } = {}) {
      if (pending) return pending;
      if (saved && !refresh && !memoryOnly) return Promise.resolve(saved);
      if (memoryOnly && !saved) return Promise.resolve(null);
      pending = collect({ ...options(), includeHistory: true, load: !memoryOnly, refresh, isCurrent }).then(async report => {
        if (!isCurrent() || !report) return null;
        if (saved && incompleteHistory(report)) {
          const events = await runStepsInSlices(retainFailedHistory(saved, report), { keepGoing: isCurrent, sliceMs: 8 });
          if (!events || !isCurrent()) return null;
          report = { ...report, events };
        }
        saved = report;
        return saved;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
