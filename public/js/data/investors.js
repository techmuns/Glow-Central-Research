// data/investors.js — superstar investors, institutions and fund flows.
//
//   prime(investors, institutions, flows)   // seeded from app.js's bootstrap fetch
//   holders()          // individuals + institutions, one record each
//   individuals() / institutions()
//   byId('dolly-khanna')
//   moves(quarter)     // one row per (holder, company) for the latest quarter
//   overlap()          // holders × companies, for the heatmap and the Overlap view
//   flows()            // 24 months of FII / DII / MF category net flows
//
// ATTRIBUTION. The names are real public figures; the positions are synthetic. Every surface
// that renders a number from here is required to say so — see `meta().isMock` and the ribbon
// in js/tabs/super-investors.js. This module deliberately exposes no commentary, rationale or
// quote field, because the data set contains none: inventing a position is bounded and
// labelled, inventing something a named person said is not. See scripts/gen-mock-investors.mjs.
//
// `valueCr` is DERIVED — holding % applied to market cap — because filings disclose a
// percentage and never a rupee amount. `isDerivedValue` is exported so the UI can say so
// rather than each view having to remember.

export const isDerivedValue = true;

let cache = null;

export function prime(investorsPayload, institutionsPayload, flowsPayload) {
  const individuals = (investorsPayload?.investors || []).map((x) => normalise(x, 'individual'));
  const insts = (institutionsPayload?.institutions || []).map((x) => normalise(x, 'institution'));
  const all = [...individuals, ...insts];

  cache = {
    meta: {
      generated_at: investorsPayload?.generated_at ?? null,
      source: investorsPayload?.source ?? 'Mock data',
      generator: investorsPayload?.generator ?? null,
      seed: investorsPayload?.seed ?? null,
      as_of: investorsPayload?.as_of ?? null,
      quarter: investorsPayload?.quarter ?? null,
      quarters: investorsPayload?.quarters ?? [],
      provenance: investorsPayload?._provenance ?? null,
      isMock: String(investorsPayload?.source ?? '').toLowerCase().includes('mock'),
    },
    individuals,
    institutions: insts,
    all,
    byId: new Map(all.map((h) => [h.investorId, h])),
    flows: flowsPayload?.months || [],
    flowsMeta: {
      unit: flowsPayload?.unit ?? 'INR crore, net',
      isMock: String(flowsPayload?.source ?? '').toLowerCase().includes('mock'),
    },
  };
  return cache;
}

function normalise(holder, type) {
  const quarters = holder.quarters || [];
  const latestQuarter = quarters[0];
  const byQuarter = new Map();
  const byTicker = new Map();
  for (const h of holder.holdings || []) {
    if (!byQuarter.has(h.quarter)) byQuarter.set(h.quarter, []);
    byQuarter.get(h.quarter).push(h);
    if (!byTicker.has(h.ticker)) byTicker.set(h.ticker, []);
    byTicker.get(h.ticker).push(h);
  }
  // Newest first within each company, so a per-holding history table reads top-down.
  for (const list of byTicker.values()) list.sort((a, b) => quarters.indexOf(a.quarter) - quarters.indexOf(b.quarter));

  const latest = (byQuarter.get(latestQuarter) || []).filter((h) => h.holdingPct > 0);
  const bySector = new Map();
  for (const h of latest) bySector.set(h.sector, (bySector.get(h.sector) || 0) + h.valueCr);
  const totalValue = latest.reduce((s, h) => s + h.valueCr, 0);

  const sorted = latest.slice().sort((a, b) => b.valueCr - a.valueCr);
  return {
    ...holder,
    type: holder.type || type,
    latestQuarter,
    byQuarter,
    byTicker,
    latestHoldings: sorted,
    sectorAllocation: [...bySector.entries()]
      .map(([sector, valueCr]) => ({ sector, valueCr, sharePct: totalValue ? Math.round((valueCr / totalValue) * 1000) / 10 : 0 }))
      .sort((a, b) => b.valueCr - a.valueCr),
    // Concentration: how much of the book sits in the five largest positions.
    top5SharePct: totalValue ? Math.round((sorted.slice(0, 5).reduce((s, h) => s + h.valueCr, 0) / totalValue) * 1000) / 10 : 0,
    valueByQuarter: quarters
      .slice()
      .reverse()
      .map((q) => ({
        quarter: q,
        valueCr: Math.round((byQuarter.get(q) || []).filter((h) => h.holdingPct > 0).reduce((s, h) => s + h.valueCr, 0) * 10) / 10,
      })),
  };
}

// ---- accessors -------------------------------------------------------------------------------

export function isLoaded() {
  return !!cache;
}
export function meta() {
  return cache ? cache.meta : null;
}
export function holders() {
  return cache ? cache.all : [];
}
export function individuals() {
  return cache ? cache.individuals : [];
}
export function institutions() {
  return cache ? cache.institutions : [];
}
export function byId(id) {
  return cache?.byId.get(id) || null;
}
export function flows() {
  return cache ? cache.flows : [];
}
export function flowsMeta() {
  return cache ? cache.flowsMeta : { unit: '', isMock: true };
}

/** Every (holder, company) position for a quarter, flattened — the all-moves table. */
export function moves(quarter = meta()?.quarter, { type = 'all' } = {}) {
  const pool = type === 'individual' ? individuals() : type === 'institution' ? institutions() : holders();
  const out = [];
  for (const h of pool) {
    for (const pos of h.byQuarter.get(quarter) || []) {
      // A zero-percent row is only interesting when it is the exit itself.
      if (pos.holdingPct === 0 && pos.action !== 'Exit') continue;
      out.push({ ...pos, investorId: h.investorId, investor: h.name, investorType: h.type, house: h.house ?? null });
    }
  }
  return out;
}

/** Activity for one holder in one quarter, bucketed. */
export function activity(holder, quarter = holder?.latestQuarter) {
  const rows = (holder?.byQuarter.get(quarter) || []).filter((p) => p.holdingPct > 0 || p.action === 'Exit');
  return {
    quarter,
    newEntries: rows.filter((r) => r.action === 'New'),
    adds: rows.filter((r) => r.action === 'Buy'),
    trims: rows.filter((r) => r.action === 'Sell'),
    exits: rows.filter((r) => r.action === 'Exit'),
    holds: rows.filter((r) => r.action === 'Hold'),
  };
}

/**
 * Which other tracked holders own the same companies.
 * Returns, for one holder, each of its companies plus the co-owners and their stakes.
 */
export function overlapFor(holder) {
  const q = holder?.latestQuarter;
  const out = [];
  for (const pos of holder?.latestHoldings || []) {
    const others = [];
    for (const other of holders()) {
      if (other.investorId === holder.investorId) continue;
      const theirs = (other.byQuarter.get(q) || []).find((p) => p.ticker === pos.ticker && p.holdingPct > 0);
      if (theirs) others.push({ investorId: other.investorId, investor: other.name, type: other.type, holdingPct: theirs.holdingPct, valueCr: theirs.valueCr });
    }
    if (others.length) out.push({ ...pos, others: others.sort((a, b) => b.holdingPct - a.holdingPct) });
  }
  return out.sort((a, b) => b.others.length - a.others.length);
}

/**
 * The overlap heatmap: tracked holders × their most-held companies.
 * `companies` are the names held by the most distinct holders, so the grid is dense enough to
 * read rather than a mostly-empty matrix.
 */
export function overlapMatrix({ limit = 14, type = 'all' } = {}) {
  const pool = type === 'individual' ? individuals() : type === 'institution' ? institutions() : holders();
  const q = meta()?.quarter;

  const counts = new Map();
  for (const h of pool) {
    for (const pos of h.byQuarter.get(q) || []) {
      if (pos.holdingPct <= 0) continue;
      if (!counts.has(pos.ticker)) counts.set(pos.ticker, { ticker: pos.ticker, name: pos.name, holders: 0, totalPct: 0 });
      const c = counts.get(pos.ticker);
      c.holders += 1;
      c.totalPct += pos.holdingPct;
    }
  }
  const companies = [...counts.values()]
    .sort((a, b) => b.holders - a.holders || b.totalPct - a.totalPct)
    .slice(0, limit);

  const grid = pool.map((h) => ({
    holder: h,
    cells: companies.map((c) => {
      const pos = (h.byQuarter.get(q) || []).find((p) => p.ticker === c.ticker && p.holdingPct > 0);
      return { ticker: c.ticker, name: c.name, holdingPct: pos?.holdingPct ?? null, valueCr: pos?.valueCr ?? null };
    }),
  }));

  const maxPct = Math.max(0.01, ...grid.flatMap((r) => r.cells.map((c) => c.holdingPct || 0)));
  return { companies, grid, maxPct, quarter: q };
}

/**
 * Institutional interest per company, aggregated across every tracked holder.
 * The Fund Flows view joins this to the REAL technicals feed.
 */
export function companyInterest() {
  const q = meta()?.quarter;
  const byTicker = new Map();
  for (const h of holders()) {
    for (const pos of h.byQuarter.get(q) || []) {
      if (pos.holdingPct <= 0) continue;
      if (!byTicker.has(pos.ticker)) {
        byTicker.set(pos.ticker, { ticker: pos.ticker, name: pos.name, sector: pos.sector, holders: [], totalPct: 0, totalValueCr: 0, netAction: 0 });
      }
      const row = byTicker.get(pos.ticker);
      row.holders.push({ investorId: h.investorId, investor: h.name, type: h.type, holdingPct: pos.holdingPct, action: pos.action });
      row.totalPct += pos.holdingPct;
      row.totalValueCr += pos.valueCr;
      if (pos.action === 'Buy' || pos.action === 'New') row.netAction += 1;
      if (pos.action === 'Sell' || pos.action === 'Exit') row.netAction -= 1;
    }
  }
  return [...byTicker.values()]
    .map((r) => ({ ...r, totalPct: Math.round(r.totalPct * 100) / 100, totalValueCr: Math.round(r.totalValueCr * 10) / 10, holderCount: r.holders.length }))
    .sort((a, b) => b.holderCount - a.holderCount || b.totalPct - a.totalPct);
}

/**
 * Narrow a holder list to the portfolio scope: holders with at least one position in a held
 * name. Holders with none are kept, carrying `noPortfolioOverlap`, so the view can say "none
 * of your holdings" rather than dropping the investor and implying they are not tracked.
 */
export function holdersForScope(scope, holdings = [], pool = holders()) {
  if (scope !== 'portfolio') return pool;
  const held = new Set(holdings.map((h) => String(h.ticker).toUpperCase()));
  return pool.map((h) => {
    const hits = h.latestHoldings.filter((p) => held.has(String(p.ticker).toUpperCase()));
    return hits.length ? { ...h, scopedHoldings: hits } : { ...h, scopedHoldings: [], noPortfolioOverlap: true };
  });
}
