// data/mf-filter-memory.js — THE LAST STATE OF THE MUTUAL FUNDS FILTERS, kept on this device.
//
// GLOW-OWNED. The owner's ask, 17 September 2026: "you need to retain the last state of selection".
// Leaving the tab used to reset every control — Active / Passive, asset class, group, category,
// strategy, the Show toggle, the search text and its category chips, the sort — and a reload
// forgot them too, so a reader who had narrowed 1,800 schemes to the twelve they follow rebuilt
// that selection on every visit. This module is where those choices live between visits.
//
// Four rules, each one this codebase already runs on:
//
//   1. IT IS A DISPLAY PREFERENCE, NOT DATA. Same arrangement as the remembered filing-type
//      selection (`sattva:announcement-types:v1`): device-local, under one key, read on mount,
//      written on every change and on the way out. Nothing about capture, retention, counts or
//      export reads it, and the export names what the filters excluded exactly as before.
//   2. A SAVED CHOICE IS RE-CHECKED AGAINST THE FEED BEFORE IT IS APPLIED. A category id is the
//      source's own classification with this dashboard's kind appended; a group is a taxonomy
//      label; both can leave the feed. `reconcileHierarchy` keeps a level only while the levels
//      above it still hold it, so a stale saved value can never narrow the table to nothing under
//      a toolbar that reads "All" — the same control-disagrees-with-its-state failure `staleKeys`
//      exists to close. A strategy or a management word absent from the vocabulary is dropped the
//      same way. The kit re-checks the table's own filters through `initialView` already.
//   3. THE SHAPE IS VALIDATED FIELD BY FIELD, NEVER TRUSTED. A private window, a cleared site, a
//      value written by an older build or a hand edit all resolve to the defaults, per field,
//      rather than throwing or applying a value the toolbar cannot draw.
//   4. NOTHING IN HERE IS THE DEFAULT SELECTION. `EMPTY` is "nothing chosen": every control reads
//      All, the table opens as the source lists it. That is what a reader with no saved state
//      gets and what Clear returns them to, and both go through the same one definition.

import { MANAGEMENT, FACTORS } from './mf-taxonomy.js';

export const MF_FILTERS_KEY = 'sattva:mf-filters:v1';
const VERSION = 1;

const MANAGEMENT_IDS = new Set(MANAGEMENT.map((m) => m.id));
const FACTOR_IDS = new Set(FACTORS.map((f) => f.id));
// The union of every level's readings; `measureFor(level)` in the tab falls back per level.
export const MEASURE_IDS = new Set(['return', 'vs-benchmark', 'vs-median']);

/** The table state this remembers for one view: the search text, the sort and — on All Schemes — the search's category chips. */
const EMPTY_VIEW = Object.freeze({ q: '', sort: null, categories: [] });

export const EMPTY = Object.freeze({
  management: null,
  assetClass: null,
  group: null,
  categoryId: null,
  strategy: null,
  measure: 'return',
  live: EMPTY_VIEW,
  weekly: EMPTY_VIEW,
  benchmarks: {},
});

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const oneOf = (v, set) => (typeof v === 'string' && set.has(v) ? v : null);

function sortOf(v) {
  if (!v || typeof v !== 'object' || typeof v.key !== 'string' || !v.key) return null;
  return { key: v.key, dir: v.dir === 'asc' ? 'asc' : 'desc' };
}

function viewOf(v) {
  if (!v || typeof v !== 'object') return EMPTY_VIEW;
  return {
    q: typeof v.q === 'string' ? v.q : '',
    sort: sortOf(v.sort),
    categories: Array.isArray(v.categories) ? [...new Set(v.categories.filter((c) => typeof c === 'string' && c))] : [],
  };
}

function benchmarksOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) if (k && typeof val === 'string' && val) out[k] = val;
  return out;
}

/** Normalise anything into the saved shape — an unknown or malformed field resolves to its default. */
export function normaliseMfFilters(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    management: oneOf(s.management, MANAGEMENT_IDS),
    assetClass: str(s.assetClass),
    group: str(s.group),
    categoryId: str(s.categoryId),
    strategy: oneOf(s.strategy, FACTOR_IDS),
    measure: oneOf(s.measure, MEASURE_IDS) || 'return',
    live: viewOf(s.live),
    weekly: viewOf(s.weekly),
    benchmarks: benchmarksOf(s.benchmarks),
  };
}

/** @returns the saved selection, or `EMPTY`'s shape where nothing usable was saved. */
export function loadMfFilters(store = storage()) {
  try {
    const raw = store?.getItem(MF_FILTERS_KEY);
    if (!raw) return normaliseMfFilters(null);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== VERSION) return normaliseMfFilters(null);
    return normaliseMfFilters(parsed);
  } catch {
    return normaliseMfFilters(null);
  }
}

/** Persist the selection; a failure (private window, full quota) keeps the session's choice working. */
export function saveMfFilters(state, store = storage()) {
  const clean = normaliseMfFilters(state);
  try { store?.setItem(MF_FILTERS_KEY, JSON.stringify({ v: VERSION, ...clean })); } catch { /* session-only */ }
  return clean;
}

/**
 * Keep a saved asset class / group / category only while the tree the toolbar is drawn from still
 * offers it, level by level: a group is kept only under its class, a category only under its
 * group. Anything the tree no longer holds is dropped WITH everything beneath it, so the toolbar
 * and the table always describe the same set. Pure; the tab calls it on every paint, which is
 * cheap and makes a feed reload safe too.
 *
 * @param {{assetClass: string|null, group: string|null, categoryId: string|null}} sel
 * @param {Array<{assetClass: string, groups: Array<{group: string, categories: Array<{id: string}>}>}>} tree
 */
export function reconcileHierarchy(sel, tree) {
  const nodes = Array.isArray(tree) ? tree : [];
  let assetClass = sel.assetClass || null;
  let group = sel.group || null;
  let categoryId = sel.categoryId || null;

  // A group or category chosen from the all-classes list carries its class with it; a saved
  // value from an older build might not. Fill the class in from the tree where it is unambiguous
  // rather than dropping a choice the tree still offers.
  if (!assetClass && (group || categoryId)) {
    const owner = nodes.find((n) => n.groups.some((g) => (group ? g.group === group : g.categories.some((c) => c.id === categoryId))));
    assetClass = owner?.assetClass || null;
  }
  const classNode = assetClass ? nodes.find((n) => n.assetClass === assetClass) || null : null;
  if (!classNode) return { assetClass: null, group: null, categoryId: null };

  if (!group && categoryId) group = classNode.groups.find((g) => g.categories.some((c) => c.id === categoryId))?.group || null;
  const groupNode = group ? classNode.groups.find((g) => g.group === group) || null : null;
  if (!groupNode) return { assetClass, group: null, categoryId: null };

  const categoryNode = categoryId ? groupNode.categories.find((c) => c.id === categoryId) || null : null;
  return { assetClass, group, categoryId: categoryNode ? categoryId : null };
}
