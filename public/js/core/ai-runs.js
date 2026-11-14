// core/ai-runs.js — THE BROWSER HALF OF THE SHARED AI-INSIGHTS RUNS. GLOW-OWNED.
//
// A run — the AI "Our view" a reader built for a company — costs a metered model step. It is kept on
// the device (localStorage, in js/tabs/ai-insights.js) AND written here to the desk's shared store,
// so a company one person ran shows as run, with its view, for everyone. This module is only the
// transport: it never decides what a run is (that is data/ai-runs-shared.js) and it never throws, so
// a static origin or an outage degrades to the device's own copy rather than breaking the tab.

const PATH = '/api/ai-runs';

/**
 * Load the desk's shared runs. Returns the runs array (possibly empty) when the shared store
 * answered, or `null` when there is nothing to read — a static origin (no Worker), an outage, or a
 * reply that is not our JSON. A failed read is NEVER an empty list: `null` tells the caller to keep
 * whatever the device already holds, exactly as the watchlist and sheet clients do.
 */
export async function loadSharedRuns() {
  try {
    const res = await fetch(PATH, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    if (!/application\/json/i.test(res.headers.get('content-type') || '')) return null;
    const data = await res.json();
    return data && data.ok === true && Array.isArray(data.runs) ? data.runs : null;
  } catch {
    return null;
  }
}

/**
 * Write one completed run to the shared store. Fire-and-forget: resolves `true` when the write was
 * accepted, `false` otherwise (a static origin, offline, or a refusal). The run still works for this
 * device regardless — its localStorage copy is written separately — so a `false` here is never a
 * lost run, only a run not yet shared.
 */
export async function writeSharedRun(run) {
  if (!run?.ticker) return false;
  const idea = run.idea ?? null;
  const rawText = typeof run.rawText === 'string' ? run.rawText : null;
  if (idea == null && !rawText) return false; // nothing worth sharing
  const intent = { op: 'set', key: run.ticker, name: run.name || run.ticker, sector: run.sector || null, idea, rawText, by: run.by || null };
  try {
    const res = await fetch(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intents: [intent] }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!(data && data.ok === true);
  } catch {
    return false;
  }
}
