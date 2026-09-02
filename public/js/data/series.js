// data/series.js — THE MACRO SERIES STORE, read side. GLOW-OWNED.
//
//   load()                     fetch the manifest once (revalidated), cache it
//   index() / isLoaded()       the manifest, or null
//   meta()                     { generatedAt, live, absent, failed, origin }
//   fetchPoints(entry, fromYear)  observations for a series, year-chunked for daily ones
//   sliceRange / yearForRange / resample / availableFrequencies / FREQ_LABEL / RANGES
//   fmtLevel / fmtReturn / returnTone / groupBy / rebase / HORIZON_COLS / lastAtOrBefore
//
// WHERE THE STORE COMES FROM. `public/data/series/` is a copy of the series store that the
// GlowVentures family-office cockpit harvests nightly (`npm run harvest` in techmuns/GlowVentures:
// Yahoo Finance for anything with a futures contract, the World Bank Pink Sheet and API, FRED, the
// RBI, IEX, data.gov.in, AMFI). `.github/workflows/series-refresh.yml` copies it here every day
// after that harvest; the manifest's `generatedAt` is the harvest time and is printed on screen.
// This dashboard COMPUTES NOTHING from it: every return, span, 52-week figure and staleness flag
// is the harvester's, computed against the full stored history with every horizon independent —
// a horizon the series cannot reach is null, and renders as absent, never as a shorter window
// relabelled. The only client-side transforms are presentation ones — a range slice, a coarser
// resample that takes each period's LAST observation, and a rebase-to-100 for overlays — and each
// says so where it is applied.
//
// This is a port of `src/lib/series.ts` in that repository, kept behaviourally identical so the two
// dashboards cannot disagree about what a figure means. Read the header of that file for the rules.

import { revalidatedJson } from '../core/store.js';

const BASE = 'data/series';

let manifest = null;
let loading = null;
let origin = null; // 'snapshot' once the committed file has been read

/** The columns the spec lists, in its order. */
export const HORIZON_COLS = [
  { key: 'd1', label: '1D' },
  { key: 'w1', label: '1W' },
  { key: 'm1', label: '1M' },
  { key: 'm3', label: '3M' },
  { key: 'm6', label: '6M' },
  { key: 'qtd', label: 'QTD' },
  { key: 'ytd', label: 'YTD' },
  { key: 'y1', label: '1Y' },
  { key: 'y3', label: '3Y', annualised: true },
  { key: 'y5', label: '5Y', annualised: true },
  { key: 'y10', label: '10Y', annualised: true },
  { key: 'max', label: 'Max', annualised: true },
];

export const RANGES = [
  { key: '1M', label: '1M', days: 30 },
  { key: '6M', label: '6M', days: 182 },
  { key: '1Y', label: '1Y', days: 365 },
  { key: '5Y', label: '5Y', days: 365 * 5 },
  { key: '10Y', label: '10Y', days: 365 * 10 },
  { key: 'MAX', label: 'Max', days: null },
];

const FREQ_ORDER = ['daily', 'weekly', 'monthly', 'quarterly', 'annual'];
export const FREQ_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Year-end' };

/**
 * Fetch the manifest once. Never rejects: a store that cannot be read leaves `index()` null and
 * `meta().origin` null, and the tab renders a named failure rather than an empty table.
 */
export function load() {
  if (manifest) return Promise.resolve(manifest);
  if (!loading) {
    loading = revalidatedJson(`${BASE}/index.json`)
      .then((payload) => {
        if (payload && Array.isArray(payload.series)) {
          manifest = payload;
          origin = 'snapshot';
        }
        return manifest;
      })
      .catch(() => null)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export const isLoaded = () => !!manifest;
export const index = () => manifest;

export function meta() {
  return {
    generatedAt: manifest?.generatedAt ?? null,
    live: manifest?.series?.length ?? 0,
    absent: manifest?.absent?.length ?? 0,
    failed: manifest?.failed?.length ?? 0,
    observations: (manifest?.series ?? []).reduce((n, s) => n + (s.count || 0), 0),
    origin,
  };
}

/** One series' manifest entry, by id, or null. */
export const byId = (id) => (manifest?.series ?? []).find((s) => s.id === id) ?? null;

/**
 * Load a series' points. ONLY DAILY SERIES ARE CHUNKED BY YEAR; a monthly or annual series lives
 * in one `series.json`. A missing year resolves to nothing rather than throwing — a gap in
 * coverage is a gap, not an error.
 */
export async function fetchPoints(entry, fromYear) {
  if (!entry) return [];
  const read = async (path) => {
    try {
      const r = await fetch(`${BASE}/${path}`, { cache: 'no-cache' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };
  if (entry.frequency !== 'daily') {
    const c = await read(`${entry.id}/series.json`);
    const out = [];
    for (let i = 0; i < (c?.t?.length ?? 0); i++) out.push({ t: c.t[i], v: c.v[i] });
    return out;
  }
  const firstYear = Number(String(entry.first || '').slice(0, 4));
  const lastYear = Number(String(entry.last || '').slice(0, 4));
  if (!firstYear || !lastYear) return [];
  const start = Math.max(firstYear, fromYear ?? firstYear);
  const years = [];
  for (let y = start; y <= lastYear; y++) years.push(y);
  const chunks = await Promise.all(years.map((y) => read(`${entry.id}/${y}.json`)));
  const out = [];
  for (const c of chunks) {
    if (!c?.t) continue;
    for (let i = 0; i < c.t.length; i++) out.push({ t: c.t[i], v: c.v[i] });
  }
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

/** First calendar year a range needs, so the loader fetches no more than that. */
export function yearForRange(entry, range) {
  const days = RANGES.find((r) => r.key === range)?.days;
  if (days == null) return undefined;
  const from = new Date(Date.parse(`${entry.last}T00:00:00Z`) - days * 86400000);
  return from.getUTCFullYear();
}

export function sliceRange(points, entry, range) {
  const days = RANGES.find((r) => r.key === range)?.days;
  if (days == null) return points;
  const cutoff = Date.parse(`${entry.last}T00:00:00Z`) - days * 86400000;
  return points.filter((p) => Date.parse(`${p.t}T00:00:00Z`) >= cutoff);
}

/** The frequencies a series can honestly be shown at: its own, and every coarser one. */
export function availableFrequencies(native) {
  const i = FREQ_ORDER.indexOf(native ?? 'daily');
  return FREQ_ORDER.slice(i < 0 ? 0 : i);
}

function bucketKey(t, to) {
  const [y, m, d] = t.split('-');
  switch (to) {
    case 'annual':
      return y;
    case 'quarterly':
      return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
    case 'monthly':
      return `${y}-${m}`;
    case 'weekly': {
      // ISO week, so a week that straddles a month or a year stays one bucket.
      const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      const day = dt.getUTCDay() || 7;
      dt.setUTCDate(dt.getUTCDate() + 4 - day);
      const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
      const week = Math.ceil(((dt.getTime() - yearStart) / 86400000 + 1) / 7);
      return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    default:
      return t;
  }
}

/**
 * Resample to a COARSER frequency, taking the LAST observation in each bucket — what "year-end"
 * means and what every publisher quotes. A request for the series' own frequency, or a finer
 * one, returns the points untouched: the UI must never offer a finer option, because the only
 * ways to produce one are to interpolate or repeat, both of which invent readings.
 */
export function resample(points, native, to) {
  const from = native ?? 'daily';
  if (!points.length) return { points, lastBucketOpen: false };
  if (FREQ_ORDER.indexOf(to) <= FREQ_ORDER.indexOf(from)) return { points, lastBucketOpen: false };
  const last = new Map();
  for (const p of points) last.set(bucketKey(p.t, to), p);
  const out = [...last.values()];
  const newest = points[points.length - 1].t;
  const [y, m, d] = newest.split('-').map(Number);
  const endsBucket =
    to === 'annual' ? m === 12 && d >= 28
    : to === 'quarterly' ? m % 3 === 0 && d >= 28
    : to === 'monthly' ? d >= 28
    : new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 5;
  return { points: out, lastBucketOpen: !endsBucket };
}

/**
 * A level in its OWN unit. Yahoo quotes the grains, cotton, sugar and coffee in US CENTS: reading
 * 639.75 as $639/bushel rather than ¢639 is a 100x error that looks like an ordinary price.
 */
export function fmtLevel(v, unit = '') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const dp = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 2 : Math.abs(v) >= 1 ? 3 : 4;
  const n = v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  if (unit === '%') return `${n}%`;
  if (unit === 'index') return n;
  if (unit.startsWith('USc')) return `¢${n}`;
  if (unit.startsWith('USD')) return `$${n}`;
  if (unit.startsWith('INR')) return `₹${n}`;
  return n;
}

/** The unit's denominator, for an axis label — "USD/bbl" → "per bbl". */
export function unitSuffix(unit = '') {
  const i = unit.indexOf('/');
  return i === -1 ? '' : ` per ${unit.slice(i + 1)}`;
}

/**
 * A return, formatted for what it IS. A yield series reports the ABSOLUTE change in basis points:
 * the US 10-year going 0.52% → 4.28% is "+376bp", not "+723%".
 */
export function fmtReturn(v, kind = 'price') {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (kind === 'yield') {
    const bp = Math.round(v * 100);
    return `${bp >= 0 ? '+' : ''}${bp}bp`;
  }
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Tailwind text classes for a return: emerald above zero, rose below, slate for none. */
export const returnTone = (v) =>
  typeof v !== 'number' || !Number.isFinite(v) ? 'text-slate-300' : v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';

/** Group entries by their `group` field, preserving catalogue order. */
export function groupBy(rows) {
  const m = new Map();
  for (const r of rows) (m.get(r.group) ?? m.set(r.group, []).get(r.group)).push(r);
  return [...m.entries()].map(([group, rs]) => ({ group, rows: rs }));
}

/**
 * Rebase a series to 100 at its first point — the only honest way to overlay a ₹ index, a $/bbl
 * price and a ratio on one axis. A presentation transform, and the chart says "rebased" when on.
 */
export function rebase(points) {
  const base = points.find((p) => Number.isFinite(p.v) && p.v !== 0)?.v;
  if (!base) return points;
  return points.map((p) => ({ t: p.t, v: (p.v / base) * 100 }));
}

/** The last observation at or before `iso`, or null when the series starts later. */
export function lastAtOrBefore(points, iso) {
  let out = null;
  for (const p of points) {
    if (p.t > iso) break;
    out = p.v;
  }
  return out;
}

/** ISO date `days` before an ISO date. */
export const shiftIso = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
