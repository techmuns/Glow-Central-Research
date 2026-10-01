import { bseLastCompleteTo } from './bse-collection.mjs';

export function failedBseCapture(previous, { now = Date.now(), reason = 'upstream' } = {}) {
  const at = new Date(now).toISOString();
  const error = { reason, at, message: 'BSE announcements could not be checked. Previously captured announcements are retained.' };
  return { ...(previous || { kind: 'announcements', byTicker: {}, rowCount: 0, capturedAt: null }),
    lastAttemptAt: at, lastError: error, coversUniverse: false, lastCompleteTo: bseLastCompleteTo(previous),
    failed: { ...(previous?.failed || {}), 'BSE collection': error } };
}
