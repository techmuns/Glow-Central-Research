// data/managers.js — THE FAMILY'S MANAGERS, read side. GLOW-OWNED.
//
//   load()                       reads public/data/managers.json once; never rejects — a failure is a
//                                named state on failureInfo()
//   all() / byId(id) / byKind(k) the managers, as scripts/build-managers.mjs wrote them
//   allMoves()                   every PMS move, tagged with whose it is
//   periodSummary({ include })   the cross-mandate roll-up: who bought what, who sold what, and where
//                                more than one of the family's managers moved on the same company
//   companyDetail(securityKey)   one company across every mandate that holds or held it
//   scopeFilter(scope, tickers)  the one predicate the panel and the roll-up narrow through
//   meta()                       what the file is, when it is from, and what it does not cover
//
// `public/data/managers.json` is written by `scripts/build-managers.mjs` from a techmuns/GlowVentures
// checkout — the same daily copy that brings `book.json` — and it is the OTHER list on the Super
// Investors tab: not ninety public investors the family has no relationship with, but the PMS
// mandates, alternative funds and mutual fund houses its own wealth-platform statements show it
// invested with. Every figure is somebody's statement or disclosure; this module derives only the
// roll-up, and says so on every surface that renders it.
//
// Four rules, each the same rule the rest of this dashboard runs on:
//
//   • A MOVE IS A CHANGE IN QUANTITY between a mandate's two newest statements, never in value.
//     `deltaPp` is the change in the security's weight of the mandate, derived on the statements'
//     own market values, and is headed as derived wherever it appears. A new position has no prior
//     weight and an exit no current one; neither is given a size it does not have.
//   • "NO LONGER ON THE STATEMENT" IS THE WORDING FOR AN EXIT — a PMS statement lists every holding,
//     so an absence is a sale or a corporate action, and each move carries the trades and corporate
//     actions in its window so the panel can say which.
//   • CONSENSUS IS A COUNT of the family's managers who moved the same way on one company. Not
//     weighted, not scored, not a recommendation.
//   • A NULL IS NOT ZERO. A manager whose statement prints no cost gets no return; a fund that
//     publishes no NAV is worth "no valuation", never ₹0.

import { revalidatedJson } from '../core/store.js';

const PATH = 'data/managers.json';

export const KINDS = [
  {
    id: 'pms',
    label: 'PMS mandates',
    noun: 'mandate',
    plural: 'mandates',
    blurb: 'Discretionary mandates. The manager’s own statement lists every share it holds for the family, so what it is doing is read off two consecutive statements and the trades between them.',
  },
  {
    id: 'aif',
    label: 'Alternative & private funds',
    noun: 'fund',
    plural: 'funds',
    blurb: 'Units of alternative funds. SEBI requires no monthly portfolio from a Category II or III AIF, so what the manager reports is a NAV, its returns, the capital drawn against a commitment and any distribution — never a holdings list.',
  },
  {
    id: 'mf',
    label: 'Mutual fund houses',
    noun: 'fund house',
    plural: 'fund houses',
    blurb: 'Every scheme the family holds, grouped by AMC. What each scheme holds is the AMC’s own monthly SEBI portfolio disclosure, read through the family’s AmfiBeas store; the family’s share of each underlying is derived from its units and labelled so.',
  },
];
export const kindOf = (id) => KINDS.find((k) => k.id === id) || null;
export const kindLabel = (id) => kindOf(id)?.label || id;

const ACTIONS = ['new', 'added', 'trimmed', 'exited', 'held'];

let raw = null;
let loading = null;
let failure = null; // { reason: 'missing' | 'unreachable' | 'shape', message }
let derived = null;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (v) => Math.round(v * 100) / 100;

/** Seed from a payload already in hand. Safe to call more than once. */
export function prime(payload) {
  if (!payload || !Array.isArray(payload.managers)) return null;
  raw = payload;
  failure = null;
  derived = null;
  return raw;
}

/**
 * Read the file once. NEVER REJECTS: a missing or unreadable file is a named state, because an
 * empty grid would claim the family has no managers, which is the one thing this module must not
 * say by accident.
 */
export function load() {
  if (raw) return Promise.resolve(raw);
  if (!loading) {
    loading = revalidatedJson(PATH)
      .then((payload) => {
        if (!prime(payload)) failure = { reason: 'shape', message: `${PATH} is not in the shape this dashboard knows` };
        return raw;
      })
      .catch((err) => {
        const message = String(err?.message || err);
        failure = { reason: /\(404\)/.test(message) ? 'missing' : 'unreachable', message };
        return null;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

export const isLoaded = () => !!raw;
export const failureInfo = () => failure;
export const all = () => raw?.managers || [];
export const byId = (id) => all().find((m) => m.id === id) || null;
export const byKind = (kind) => all().filter((m) => m.kind === kind);

// ---- derived views, built once per payload --------------------------------------------------

function build() {
  if (derived) return derived;
  const moves = [];
  for (const m of all()) {
    if (m.kind !== 'pms') continue;
    for (const mv of m.moves || []) {
      moves.push({ ...mv, managerId: m.id, manager: m.name, house: m.house, strategy: m.strategy, window: m.window });
    }
  }
  derived = { moves };
  return derived;
}

/** Every PMS move across every mandate, tagged with whose it is. */
export function allMoves() {
  return raw ? build().moves : [];
}

/**
 * ONE PREDICATE, used by the grid, the workspace counts AND the roll-up. `null` means "this scope
 * does not narrow", the same convention `scopeTickers()` uses — and for the same reason an empty
 * watchlist must narrow to nothing rather than to everything.
 *
 * Portfolio and Universe both show the whole set: the family's managers are the family's, and
 * there is no wider universe of them to widen to. Watchlist narrows to the rows whose NSE symbol is
 * starred; a row with no symbol (a fund unit, a name the book could not resolve) cannot match and
 * drops out, which is a limit of the join and not a claim about the manager.
 */
export function scopeFilter(scope, tickers = null) {
  if (scope !== 'watchlist') return null;
  const wanted = new Set([...(tickers instanceof Set ? tickers : tickers || [])].map((t) => String(t).toUpperCase()));
  return (row) => !!row?.symbol && wanted.has(String(row.symbol).toUpperCase());
}

/**
 * The period across every mandate — the roll-up Quarterly Changes shows for the family's own
 * managers, in the same shape as `quarterSummary()` in super-investors.js so the panels beside it
 * read the same way.
 *
 * Four things it refuses to invent, and each is the obvious feature request:
 *   1. no rupee size on a new position or an exit — a first appearance has no prior weight and an
 *      absence no current one; new entrants rank by the weight now held, exits carry the weight
 *      they had, worded "was";
 *   2. increases and reductions rank by the change in weight of the mandate, derived on the
 *      statements' own market values — the trades that produced them ride alongside, as counts and
 *      the settled amounts the statements print;
 *   3. a mandate with one statement is not comparable and contributes nothing, rather than reading
 *      as a manager who bought everything;
 *   4. consensus is a count.
 */
export function periodSummary({ include = null, limit = 5 } = {}) {
  const every = allMoves();
  const moves = include ? every.filter(include) : every;
  const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  for (const mv of moves) if (counts[mv.action] != null) counts[mv.action] += 1;

  const group = (actions) => {
    const byKey = new Map();
    for (const mv of moves) {
      if (!actions.includes(mv.action)) continue;
      if (!byKey.has(mv.securityKey)) byKey.set(mv.securityKey, { securityKey: mv.securityKey, security: mv.security, symbol: mv.symbol, managers: [] });
      byKey.get(mv.securityKey).managers.push({ managerId: mv.managerId, manager: mv.manager, action: mv.action, deltaPp: mv.deltaPp, weightNow: mv.weightNow, qtyNow: mv.qtyNow });
    }
    return [...byKey.values()]
      .filter((c) => c.managers.length > 1)
      .map((c) => ({
        ...c,
        count: c.managers.length,
        sized: c.managers.filter((i) => i.deltaPp != null).length,
        sumPp: r2(c.managers.reduce((a, i) => a + (i.deltaPp ?? 0), 0)),
      }))
      .sort((a, b) => b.count - a.count || Math.abs(b.sumPp) - Math.abs(a.sumPp) || a.security.localeCompare(b.security));
  };
  const byAction = (action) => moves.filter((mv) => mv.action === action);

  const mandates = byKind('pms');
  const comparable = mandates.filter((m) => m.window);
  const windows = [];
  for (const mv of moves) {
    const w = mv.window ? `${mv.window.from} → ${mv.window.to}` : null;
    if (w && !windows.includes(w)) windows.push(w);
  }
  // The settled amounts the statements print, over the trades inside each move's window — a sum
  // of reported figures with its coverage beside it, never a total that treats an unreported
  // trade as ₹0.
  const trades = moves.reduce(
    (t, mv) => {
      t.buys += mv.trades?.buys || 0;
      t.sells += mv.trades?.sells || 0;
      if (num(mv.trades?.bought) != null) {
        t.bought = r2((t.bought ?? 0) + mv.trades.bought);
        t.boughtMoves += 1;
      }
      if (num(mv.trades?.sold) != null) {
        t.sold = r2((t.sold ?? 0) + mv.trades.sold);
        t.soldMoves += 1;
      }
      return t;
    },
    { buys: 0, sells: 0, bought: null, sold: null, boughtMoves: 0, soldMoves: 0 }
  );

  return {
    counts,
    total: moves.length,
    windows,
    comparableManagers: comparable.length,
    singleStatementManagers: mandates.length - comparable.length,
    contributingManagers: new Set(moves.map((mv) => mv.managerId)).size,
    trades,
    consensusBuys: group(['new', 'added']).slice(0, limit),
    consensusSells: group(['exited', 'trimmed']).slice(0, limit),
    newEntrants: byAction('new').sort((a, b) => (b.weightNow ?? 0) - (a.weightNow ?? 0)),
    topAdds: byAction('added').sort((a, b) => (b.deltaPp ?? 0) - (a.deltaPp ?? 0)),
    topTrims: byAction('trimmed').sort((a, b) => (a.deltaPp ?? 0) - (b.deltaPp ?? 0)),
    // An exit has no size, so nothing ranks them: the weight they had is the only figure, and the
    // list is in the order the mandates were built (largest mandate first).
    exits: byAction('exited'),
  };
}

/**
 * One company across every mandate whose comparison window contains it — including a manager who
 * simply held it, because "who else holds this" is the question a consensus row cannot answer on
 * its own.
 */
export function companyDetail(securityKey) {
  const rows = allMoves()
    .filter((mv) => mv.securityKey === securityKey)
    .sort((a, b) => (b.qtyNow != null) - (a.qtyNow != null) || (b.weightNow ?? -1) - (a.weightNow ?? -1) || a.manager.localeCompare(b.manager));
  const first = rows[0] || null;
  return { securityKey, security: first?.security ?? securityKey, symbol: first?.symbol ?? null, rows };
}

export function meta() {
  if (!raw) return null;
  const s = raw.summary || {};
  const mandates = byKind('pms');
  return {
    source: raw.source || null,
    builtFrom: raw.builtFrom || null,
    asOf: raw.asOf || null,
    origin: 'snapshot',
    managers: all().length,
    byKind: s.byKind || {},
    bookValue: num(s.bookValue),
    managedValue: num(s.managedValue),
    direct: s.direct || null,
    unresolvedSchemes: s.unresolvedSchemes || [],
    excludedAccounts: s.excludedAccounts || [],
    statementsKept: s.statementsKept ?? null,
    comparableMandates: mandates.filter((m) => m.window).length,
    singleStatementMandates: mandates.filter((m) => !m.window).length,
    trades: mandates.reduce((n, m) => n + (m.transactions?.length || 0), 0),
    disclosedRows: byKind('mf').reduce((n, m) => n + (m.lookthrough?.funds || []).reduce((a, f) => a + (f.equity?.length || 0), 0), 0),
  };
}
