// data/funnel-fundamentals.js — the Screening Funnel's fundamentals SCREEN, keyed by NSE symbol.
//
//   load()         fetch the committed screen once (revalidated), cache it
//   all()          every company row (parsed numbers; a missing figure is null, never 0)
//   byTicker(sym)  one company's row, or null
//   has(sym)       is this company in the screen?
//   meta()         { count, capturedAt, source, origin } for the freshness note
//
// This is the funnel's breadth layer (public/data/funnel-fundamentals.json), DELIBERATELY SEPARATE
// from the per-company one-pager feed (data/fundamentals.js + data/fundamentals.json): the one-pager
// carries deep nested data for fewer companies, the screen carries a flat comparable row for the
// whole screenable universe plus the cash-conversion / pledge / margin columns the funnel screens on.
// Unifying the two Screener feeds into one source is tracked as the LKP-merge task. It is a committed
// snapshot refreshed on a schedule; there is no live per-request route, so the funnel states the
// capture date rather than claiming "up to date".

import { revalidatedJson } from '../core/store.js';

const PATH = 'data/funnel-fundamentals.json';

let loading = null;
let rows = null;
let byKey = null;
let metaInfo = { count: 0, capturedAt: null, source: null, origin: 'empty' };

function index(doc) {
  const list = Array.isArray(doc) ? doc : (doc && doc.companies) || [];
  rows = list;
  byKey = new Map();
  for (const r of list) {
    const t = r && r.ticker ? String(r.ticker).toUpperCase() : null;
    if (t && !byKey.has(t)) byKey.set(t, r);
  }
  metaInfo = {
    count: list.length,
    capturedAt: (doc && doc.capturedAt) || null,
    generatedAt: (doc && doc.generatedAt) || null,
    source: (doc && doc.source) || 'Screener.in',
    origin: 'snapshot',
  };
  return rows;
}

export function load() {
  if (rows) return Promise.resolve(rows);
  if (loading) return loading;
  loading = revalidatedJson(PATH, { optional: true })
    .then((doc) => (doc ? index(doc) : (rows = rows || [], byKey = byKey || new Map(), rows)))
    .catch(() => { rows = rows || []; byKey = byKey || new Map(); return rows; })
    .finally(() => { loading = null; });
  return loading;
}

export function all() { return rows || []; }
export function byTicker(sym) { return byKey && sym ? byKey.get(String(sym).toUpperCase()) || null : null; }
export function has(sym) { return !!(byKey && sym && byKey.has(String(sym).toUpperCase())); }
export function meta() { return metaInfo; }
