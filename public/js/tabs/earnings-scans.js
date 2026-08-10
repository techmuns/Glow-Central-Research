// tabs/earnings-scans.js — the Result Scans predicates.
//
// A scan is a pure function over a scored row plus a plain-English definition. Keeping them
// here (rather than inline in the tab) means the definition shown to the user and the code
// that filters are the same object — they cannot drift apart.
//
// Built-ins are `SCANS`. Custom scans are `{ conditions: [{ metric, op, value }] }` saved to
// localStorage and evaluated by matchesCustom(); their definition string is generated from
// the conditions, so a saved scan is as self-describing as a built-in.

import { earningsVals } from '../scoring/earnings-scoring.js';

const CUSTOM_KEY = 'sattva:earnings-scans';

// Convenience: pull the metric bundle for a scored row, tolerating rows with no data.
const V = (s) => earningsVals(s.company) || {};
const ruleStatus = (s, key) => s.breakdown?.find((b) => b.key === key)?.status ?? null;

export const SCANS = [
  {
    id: 'clean-beat',
    name: 'Clean beat',
    definition: 'Reported EPS above consensus AND reported revenue above consensus.',
    why: 'Both halves of the print beat. A company that beats on EPS alone may have done it below the operating line.',
    test: (s) => (V(s).epsSurprise ?? -Infinity) > 1 && (V(s).revSurprise ?? -Infinity) > 1,
  },
  {
    id: 'quality-compounder',
    name: 'Quality compounder',
    definition: 'Revenue growth above 15% YoY, operating margin expanding YoY, and operating profit growing at least as fast as PAT.',
    why: 'Growth, margin and earnings quality moving together — the combination that is hard to fake for more than a quarter or two.',
    test: (s) => (V(s).revYoY ?? -Infinity) > 15 && (V(s).opmDelta ?? -Infinity) > 0 && (V(s).opYoY ?? -Infinity) >= (V(s).patYoY ?? Infinity),
  },
  {
    id: 'margin-expansion',
    name: 'Margin expansion',
    definition: 'Operating margin up by 100bps or more against the same quarter last year.',
    why: 'Pricing power or operating leverage showing up in the margin line rather than just the topline.',
    test: (s) => (V(s).opmDelta ?? -Infinity) >= 1,
  },
  {
    id: 'growth-acceleration',
    name: 'Growth acceleration',
    definition: 'Latest revenue YoY growth is above the average of the preceding three quarters.',
    why: 'The second derivative. A business speeding up against its own run-rate, not just growing.',
    test: (s) => (V(s).revAccel ?? -Infinity) > 0,
  },
  {
    id: 'cost-pressure',
    name: 'Cost pressure',
    definition: 'Revenue up year on year while PAT is down year on year.',
    why: 'Volumes are holding but something below the topline is eating them — input costs, wages or interest.',
    test: (s) => (V(s).revYoY ?? -Infinity) > 0 && (V(s).patYoY ?? Infinity) < 0,
  },
  {
    id: 'low-quality-beat',
    name: 'Low-quality beat',
    definition: 'EPS beat consensus, but operating profit grew more slowly than PAT.',
    why: 'The beat came from below the operating line — other income, a tax credit or a one-off. Treat the headline with care.',
    test: (s) => (V(s).epsSurprise ?? -Infinity) > 1 && (V(s).opYoY ?? Infinity) < (V(s).patYoY ?? -Infinity),
  },
  {
    id: 'turnaround',
    name: 'Turnaround',
    definition: 'Profitable this quarter after a loss in the immediately preceding quarter.',
    why: 'The first profitable print after a loss is the moment a recovery becomes visible in the numbers.',
    test: (s) => V(s).lossMaking === false && V(s).prevLossMaking === true,
  },
  {
    id: 'consistent-compounder',
    name: 'Consistent compounder',
    definition: 'Revenue grew year on year in all four of the last quarters, and the company was profitable in all four.',
    why: 'Consistency over four quarters filters out the single good print that a cyclical upswing can produce.',
    test: (s) => ruleStatus(s, 'rev_streak') === 'pass' && ruleStatus(s, 'pat_streak') === 'pass',
  },
];

// ---------------------------------------------------------------------------------------
// Custom scans
// ---------------------------------------------------------------------------------------

const METRIC_LABEL = {
  revYoY: 'Revenue YoY %',
  patYoY: 'PAT YoY %',
  opmDelta: 'OPM change (pp)',
  epsSurprise: 'EPS surprise %',
  score: 'Quality score',
};
const OP_LABEL = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

function metricValue(s, metric) {
  if (metric === 'score') return s.totalPoints;
  const v = V(s);
  return v[metric] ?? null;
}

function compare(actual, op, target) {
  if (actual == null || !Number.isFinite(actual)) return false;
  switch (op) {
    case 'gt': return actual > target;
    case 'gte': return actual >= target;
    case 'lt': return actual < target;
    case 'lte': return actual <= target;
    default: return false;
  }
}

/** All conditions must hold (AND). A row missing a metric fails that condition. */
export function matchesCustom(scan, s) {
  const conditions = scan?.conditions || [];
  if (!conditions.length) return true;
  return conditions.every((c) => compare(metricValue(s, c.metric), c.op, c.value));
}

export function describeCustom(scan) {
  const parts = (scan?.conditions || []).map((c) => `${METRIC_LABEL[c.metric] || c.metric} ${OP_LABEL[c.op] || c.op} ${c.value}`);
  return parts.length ? parts.join(' AND ') : 'No conditions — matches everything.';
}

export function loadCustomScans() {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map((s) => ({ ...s, custom: true })) : [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.map(({ custom, ...rest }) => rest)));
  } catch {
    // Private mode / quota — the scan still works this session, it just won't persist.
  }
}

export function saveCustomScan({ name, conditions }) {
  const list = loadCustomScans();
  // Ids are slugged from the name so a saved scan produces a readable, shareable URL.
  const base = `custom-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scan'}`;
  let id = base;
  let n = 2;
  while (list.some((s) => s.id === id)) id = `${base}-${n++}`;
  const scan = { id, name, conditions, custom: true };
  list.push(scan);
  persist(list);
  return scan;
}

export function deleteCustomScan(id) {
  persist(loadCustomScans().filter((s) => s.id !== id));
}

// ---------------------------------------------------------------------------------------
// Lookup + execution
// ---------------------------------------------------------------------------------------

export function scanById(id, custom = loadCustomScans()) {
  return SCANS.find((s) => s.id === id) || custom.find((s) => s.id === id) || null;
}

/** Run any scan — built-in or custom — over a set of scored rows. */
export function runScan(scan, rows) {
  if (!scan) return rows;
  const scored = rows.filter((s) => !s.tickerError);
  if (scan.custom) return scored.filter((s) => matchesCustom(scan, s));
  return scored.filter((s) => {
    try {
      return scan.test(s);
    } catch {
      return false;
    }
  });
}
