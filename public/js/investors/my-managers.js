// investors/my-managers.js — MY MANAGERS: the family's own PMS mandates, alternative funds and fund
// houses, and what each is doing. GLOW-OWNED.
//
//   sectionsFor(scope, base)      where the section sits in the Superstar Investors tab bar
//   defaultSection(scope)         which section a fresh visit opens on
//   renderManagers(ctx, opts)     the section body — cards by kind, click to expand
//   managerSummaryBlock(ctx)      the period roll-up shown above the superstar one on Quarterly Changes
//   openManager(id)               one manager, as a workspace
//
// THE ASK, verbatim: "what my managers are doing, can I see that? I'm more interested in the
// portfolio managers I have access to." So under Portfolio this is the FIRST in-page tab, ahead of
// ninety public investors the family has no relationship with, and the same roll-up the tab already
// does for those investors is done here for the family's own mandates — from their statements.
//
// THE DESIGN IS THE SUPERSTAR INVESTORS DESIGN, deliberately: the same card, the same click-to-
// expand workspace, the same six ranked lists, the same vocabulary (new / added / trimmed / no longer
// on the statement / held), so a reader who has learned one half of the tab has learned the other.
// What differs is stated on every surface: these are the manager's OWN statements to the family,
// not exchange filings, so a move is a change in QUANTITY (the statement's primitive) rather than
// in a disclosed percentage, and an exit here really is a sale or a corporate action rather than
// "no longer disclosed".
//
// SCOPE. Portfolio and Universe both show the whole set — the family's managers are the family's,
// and there is no wider universe of them to widen to — but only Portfolio puts the section first.
// Watchlist narrows every move to the starred symbols and says so. Universe does not offer the
// section at all: that scope means every tracked investor, and "mine" is what the toggle's first
// position is for.
//
// Every figure is a statement's or a disclosure's; the derived ones — weight of the mandate, its
// change, the family's share of a fund's underlying — are headed as derived. Nothing is scored.

import { rankedList, openWorkspace, openModal } from '../ui/screener.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatDate, formatPct } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as managers from '../data/managers.js';
import * as watchlist from '../core/watchlist.js';

export const SECTION = { id: 'my-managers', label: 'My Managers' };

/** First under Portfolio, last under Watchlist, absent under Universe — see the header. */
export function sectionsFor(scope, base = []) {
  if (scope === 'portfolio') return [SECTION, ...base];
  if (scope === 'watchlist') return [...base, SECTION];
  return base;
}

export const defaultSection = (scope) => (scope === 'portfolio' ? SECTION.id : 'investors');

// ---------------------------------------------------------------------------------------
// Formatting — rupees as the statements print them, in the unit a reader would say aloud
// ---------------------------------------------------------------------------------------

const dash = '<span class="text-slate-300">—</span>';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** ₹ in crore above one, lakh above one, rupees below — a ₹115 index-fund line is not "₹0.00 Cr". */
function money(rupees) {
  const v = num(rupees);
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${formatNumber(v / 1e7, { decimals: 2 })} Cr`;
  if (abs >= 1e5) return `₹${formatNumber(v / 1e5, { decimals: 2 })} L`;
  return `₹${formatNumber(v, { decimals: 0 })}`;
}
const pct = (v, decimals = 2) => (num(v) == null ? '—' : `${Number(v).toFixed(decimals)}%`);
const pp = (v) => (num(v) == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)} pp`);
const qty = (v) => (num(v) == null ? '—' : formatNumber(v, { decimals: Number.isInteger(v) ? 0 : 3 }));
const date = (v) => (v ? formatDate(v) : '—');
const tone = (v) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500');
const chip = (label, title = '', kind = 'neutral') => {
  const cls =
    kind === 'good' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : kind === 'brand' ? 'bg-indigo-50 text-indigo-800 ring-indigo-200'
        : kind === 'warn' ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
};

const ACTION = {
  new: ['New', 'bg-indigo-50 text-indigo-700 ring-indigo-200'],
  added: ['Added', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  held: ['Held', 'bg-slate-100 text-slate-600 ring-slate-200'],
  trimmed: ['Trimmed', 'bg-amber-50 text-amber-800 ring-amber-200'],
  exited: ['No longer on the statement', 'bg-rose-50 text-rose-700 ring-rose-200'],
};
const actionPill = (action) => {
  const [label, cls] = ACTION[action] || ACTION.held;
  return `<span class="inline-flex whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(label)}</span>`;
};

const KIND_TAG = { pms: 'PMS mandate', aif: 'Alternative fund', mf: 'Fund house' };

let openInvestorFn = null;

function scopeInclude(ctx) {
  return managers.scopeFilter(ctx.scope, ctx.scope === 'watchlist' ? watchlist.tickers() : null);
}

/** The moves of one mandate under the current scope — one predicate for the card and the roll-up. */
const scopedMoves = (m, include) => (include ? (m.moves || []).filter(include) : m.moves || []);

// ---------------------------------------------------------------------------------------
// The section body
// ---------------------------------------------------------------------------------------

/**
 * Returns `{ html, wire }` like every other panel on this tab. The file is read on first use —
 * nothing in app.js waits for it — so the first paint is a shimmer that swaps itself for the grid
 * in place when the read lands, without asking the whole tab to repaint.
 */
export function renderManagers(ctx, { openInvestor = null } = {}) {
  openInvestorFn = openInvestor || openInvestorFn;
  if (managers.isLoaded()) {
    const built = buildPanel(ctx);
    return {
      html: `<div data-managers-panel>${built.inner}</div>`,
      wire: (root, disposers) => built.wire(root.querySelector('[data-managers-panel]'), disposers),
    };
  }
  const html = `
    <div data-managers-panel data-managers-loading>
      <div class="mb-3 h-5 w-64 animate-pulse rounded bg-slate-100"></div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${Array.from({ length: 4 }, () => '<div class="skeleton-shimmer h-40 rounded-2xl bg-slate-100"></div>').join('')}</div>
    </div>`;
  return {
    html,
    wire: (root, disposers) => {
      const host = root.querySelector('[data-managers-panel]');
      managers.load().then(() => {
        // The read outlived the panel — a scope toggle or a sub-view change already repainted.
        if (!host || !host.isConnected) return;
        const built = buildPanel(ctx);
        host.removeAttribute('data-managers-loading');
        host.innerHTML = built.inner;
        built.wire(host, disposers);
      });
    },
  };
}

function buildPanel(ctx) {
  const m = managers.meta();
  if (!m) return { inner: unavailablePanel(), wire: () => {} };
  const include = scopeInclude(ctx);
  const starred = ctx.scope === 'watchlist' ? watchlist.size() : null;

  const kinds = managers.KINDS.map((k) => ({ kind: k, list: managers.byKind(k.id) })).filter((g) => g.list.length);
  const inner = `
    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 max-w-3xl">
        <div class="text-[11px] font-bold uppercase tracking-wider text-slate-500">The family’s managers</div>
        <p class="mt-1 text-sm leading-relaxed text-slate-600">${escapeHtml(headSentence(m))}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        ${scopePill(ctx, starred, include)}
        ${chip(`Statements · as of ${m.asOf ? formatDate(m.asOf) : '?'}`, 'Every figure is a wealth platform’s own statement or an AMC’s own disclosure; this is the newest statement date across the family’s accounts.', 'good')}
        <button type="button" data-managers-info class="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" title="Where these figures come from">Sources ?</button>
      </div>
    </div>
    ${kinds.map((g) => kindSection(g.kind, g.list, m, include)).join('')}
    <p class="mt-4 text-xs leading-relaxed text-slate-500">${escapeHtml(footnote(m))}</p>`;

  function wire(host, disposers) {
    if (!host) return;
    const onClick = (e) => {
      const btn = e.target.closest('[data-open-manager]');
      if (btn && host.contains(btn)) openManager(btn.dataset.openManager, ctx);
      const info = e.target.closest('[data-managers-info]');
      if (info && host.contains(info)) openProvenance();
    };
    host.addEventListener('click', onClick);
    disposers.push(() => host.removeEventListener('click', onClick));
  }
  return { inner, wire };
}

function headSentence(m) {
  const k = m.byKind || {};
  const parts = [
    k.pms?.count ? `${formatNumber(k.pms.count)} PMS mandate${k.pms.count === 1 ? '' : 's'}` : null,
    k.aif?.count ? `${formatNumber(k.aif.count)} alternative fund${k.aif.count === 1 ? '' : 's'}` : null,
    k.mf?.count ? `${formatNumber(k.mf.count)} fund house${k.mf.count === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const managed = m.managedValue != null && m.bookValue != null ? `${money(m.managedValue)} of the ${money(m.bookValue)} book` : '';
  return `${formatNumber(m.managers)} managers run ${managed || 'the managed part of the book'} — ${parts.join(', ')} — as the wealth platforms’ statements print it. What each one holds and traded is read from its own statements, and nothing here is scored.`;
}

function footnote(m) {
  const bits = [];
  if (m.direct?.marketValue != null) bits.push(`Direct holdings — ${money(m.direct.marketValue)} across ${formatNumber(m.direct.positions)} positions in the family’s own ${formatNumber(m.direct.accounts)} depository and broking accounts — are not a manager and are on the Family Book tab.`);
  if (m.unresolvedSchemes?.length) bits.push(`${formatNumber(m.unresolvedSchemes.length)} scheme${m.unresolvedSchemes.length === 1 ? '' : 's'} could not be matched to an AMC disclosure and ${m.unresolvedSchemes.length === 1 ? 'is' : 'are'} under no fund house: ${m.unresolvedSchemes.map((u) => `${u.security} (${money(u.marketValue)})`).join(', ')}.`);
  bits.push('A dash is a figure the statement does not carry, never a zero.');
  return bits.join(' ');
}

function scopePill(ctx, starred, include) {
  if (ctx.scope === 'watchlist') {
    if (!starred) return chip('Watchlist · nothing starred yet', 'Star a company anywhere on the dashboard to narrow the managers’ moves to it here.', 'brand');
    const n = managers.allMoves().filter(include).length;
    return chip(`Watchlist · ${formatNumber(n)} move${n === 1 ? '' : 's'} in ${formatNumber(starred)} starred compan${starred === 1 ? 'y' : 'ies'}`, 'Every manager is still listed; the moves counted on the cards and in the roll-up are narrowed to the starred NSE symbols. A holding with no symbol cannot match.', 'brand');
  }
  return chip(`${ctx.scope === 'universe' ? 'Universe' : 'Portfolio'} · the family’s managers`, 'The family’s managers are the family’s — there is no wider universe of them to widen to.', 'neutral');
}

function kindSection(kind, list, m, include) {
  const totals = m.byKind?.[kind.id];
  const note =
    kind.id === 'pms'
      ? 'what each manager holds and traded, from its own statements'
      : kind.id === 'aif'
        ? 'units marked by the manager; no portfolio is published for an AIF'
        : 'what each scheme holds, from the AMC’s monthly disclosure';
  return `
    <section class="mb-2" data-manager-kind="${escapeHtml(kind.id)}">
      <div class="mb-2 mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(kind.label)}</h3>
        <span class="text-xs text-slate-500">${escapeHtml(`${formatNumber(list.length)} · ${totals ? money(totals.marketValue) : ''} · ${note}`)}</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${list.map((x) => managerCard(x, include)).join('')}</div>
    </section>`;
}

// ---------------------------------------------------------------------------------------
// The cards — the investor card, with a manager on it
// ---------------------------------------------------------------------------------------

const statCell = (value, label, title = '') => `
  <span class="rounded-lg bg-slate-50 px-2 py-1.5"${title ? ` title="${escapeHtml(title)}"` : ''}>
    <span class="block truncate text-sm font-bold tabular-nums text-slate-900">${value == null ? dash : value}</span>
    <span class="block text-[10px] uppercase tracking-wide text-slate-400">${escapeHtml(label)}</span>
  </span>`;

function noValuationReason(m) {
  const reasons = (m.accounts || []).map((a) => a.noPositionsReason).filter(Boolean);
  if (reasons.length && reasons.length === m.accounts.length) return reasons[0];
  return null;
}

function managerCard(m, include) {
  const { color, initials } = avatarFor(m.name);
  const sub =
    m.kind === 'pms'
      ? m.strategy || m.providerEngagement || ''
      : m.kind === 'aif'
        ? [m.house !== m.name ? m.house : null, m.providerEngagement].filter(Boolean).join(' · ')
        : `${formatNumber((m.lookthrough?.funds || []).length)} scheme${(m.lookthrough?.funds || []).length === 1 ? '' : 's'} held`;
  const reason = m.value?.marketValue === 0 ? noValuationReason(m) : null;
  return `
    <button type="button" data-open-manager="${escapeHtml(m.id)}"
      class="flex flex-col rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <div class="flex items-center gap-3">
        <span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-xs font-bold text-white">${escapeHtml(initials)}</span>
        <span class="min-w-0">
          <span class="block truncate font-display text-sm font-bold text-slate-900" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
          <span class="block truncate text-[11px] text-slate-500" title="${escapeHtml(sub)}">${escapeHtml(sub || KIND_TAG[m.kind])}</span>
        </span>
      </div>
      <p class="mt-2.5 line-clamp-2 text-[11px] leading-snug text-slate-500">${escapeHtml(cardLine(m, include))}</p>
      ${
        reason
          ? `<p class="mt-3 rounded-lg bg-amber-50 p-2 text-[11px] leading-snug text-amber-800 ring-1 ring-amber-200">No valuation on the statement — not ₹0. ${escapeHtml(reason)}</p>`
          : `<div class="mt-3 grid grid-cols-2 gap-2">${cardStats(m, include).join('')}</div>`
      }
    </button>`;
}

function cardLine(m, include) {
  if (m.kind === 'pms') {
    if (!m.window) return `One statement in the archive${m.asOf ? ` (${formatDate(m.asOf)})` : ''} — nothing to compare it against yet, so no moves are shown rather than calling every position new.`;
    const moves = scopedMoves(m, include);
    const c = (a) => moves.filter((x) => x.action === a).length;
    const parts = [c('new') && `${c('new')} new`, c('added') && `${c('added')} added`, c('trimmed') && `${c('trimmed')} trimmed`, c('exited') && `${c('exited')} no longer on the statement`].filter(Boolean);
    return `${parts.length ? parts.join(' · ') : 'No position changed'} between ${formatDate(m.window.from)} and ${formatDate(m.window.to)} · ${formatNumber(m.transactions?.length || 0)} trades on the statements since ${m.tape?.from ? formatDate(m.tape.from) : '?'}`;
  }
  if (m.kind === 'aif') {
    const c = (m.commitments || [])[0];
    const drawn = m.commitments?.length ? `${money(m.commitments.reduce((s, x) => s + (num(x.drawn) ?? 0), 0))} drawn of ${money(m.commitments.reduce((s, x) => s + (num(x.committed) ?? 0), 0))} committed` : null;
    return [`${formatNumber(m.accounts.length)} account${m.accounts.length === 1 ? '' : 's'} · ${m.owners.join(', ')}`, drawn, c?.undrawn ? `${money(m.commitments.reduce((s, x) => s + (num(x.undrawn) ?? 0), 0))} still callable` : null].filter(Boolean).join(' · ');
  }
  const funds = m.lookthrough?.funds || [];
  return funds.map((f) => f.scheme).join(' · ');
}

function cardStats(m, include) {
  const v = m.value || {};
  if (m.kind === 'pms') {
    const latest = (m.statements || []).filter((s) => s.asOf === m.statements?.[0]?.asOf);
    const holdings = new Set(latest.flatMap((s) => s.holdings.filter((h) => h.assetClass !== 'Cash').map((h) => h.securityKey))).size;
    const moves = scopedMoves(m, include);
    const up = moves.filter((x) => x.action === 'new' || x.action === 'added').length;
    const down = moves.filter((x) => x.action === 'trimmed' || x.action === 'exited').length;
    return [
      statCell(money(v.marketValue), 'statement value', 'The mandate as the manager’s newest statement values it — shares and the cash sleeve'),
      statCell(holdings ? formatNumber(holdings) : null, 'holdings', 'Distinct securities on the newest statement, cash excluded'),
      statCell(m.window ? `${formatNumber(up)} / ${formatNumber(down)}` : null, 'added / reduced', m.window ? `New or added, against trimmed or no longer on the statement, ${formatDate(m.window.from)} → ${formatDate(m.window.to)}` : 'One statement only — nothing to compare'),
      statCell(m.cash?.weightNow == null ? null : pct(m.cash.weightNow, 1), 'cash sleeve', m.cash ? `Cash the manager is holding back, as a share of the mandate on ${formatDate(m.window.to)} (was ${pct(m.cash.weightBefore, 1)})` : ''),
    ];
  }
  if (m.kind === 'aif') {
    const committed = m.commitments?.length ? m.commitments.reduce((s, x) => s + (num(x.committed) ?? 0), 0) : null;
    const drawn = m.commitments?.length && m.commitments.every((x) => num(x.drawn) != null) ? m.commitments.reduce((s, x) => s + x.drawn, 0) : null;
    return [
      statCell(money(v.marketValue), 'statement value', 'The units as the fund’s newest statement values them'),
      statCell(v.costBasis == null ? null : money(v.costBasis), 'cost', v.costBasis == null ? 'The statement carries no cost — not zero' : `Cost on ${formatNumber(v.costRows)} of ${formatNumber(v.positions)} lines`),
      statCell(v.returnPct == null ? null : `<span class="${tone(v.returnPct)}">${escapeHtml(formatPct(v.returnPct, { decimals: 1 }))}</span>`, 'return (derived)', v.returnPct == null ? 'No return without a cost on every line' : 'Statement value against the statement’s cost — derived, not a fund NAV return'),
      statCell(committed == null ? date(m.asOf) : `${money(drawn)} / ${money(committed)}`, committed == null ? 'statement date' : 'drawn / committed', committed == null ? 'The newest account statement date' : 'Capital called so far against what the family signed up for, as the fund prints it'),
    ];
  }
  const funds = m.lookthrough?.funds || [];
  const rows = funds.reduce((s, f) => s + (f.equity?.length || 0), 0);
  const navDate = funds.flatMap((f) => f.plans.map((p) => p.nav?.date)).filter(Boolean).sort().at(-1) ?? null;
  return [
    statCell(money(v.marketValue), 'statement value', 'The units as the family’s statements value them'),
    statCell(formatNumber(funds.length), 'schemes', 'Distinct schemes the family holds with this AMC'),
    statCell(rows ? formatNumber(rows) : null, 'disclosed holdings', rows ? 'Equity lines across the AMC’s monthly portfolio disclosures for these schemes' : 'The schemes held publish no equity portfolio (debt, liquid or commodity ETFs)'),
    statCell(navDate ? formatDate(navDate) : null, 'NAV as of', 'The newest published NAV date across the plans held'),
  ];
}

// ---------------------------------------------------------------------------------------
// One manager, as a workspace
// ---------------------------------------------------------------------------------------

let open = null;

export function openManager(id, ctx = null) {
  const m = managers.byId(id);
  if (!m) return;
  open = { m, ctx };
  const kindTag = `<span class="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 ring-1 ring-slate-200">${escapeHtml(KIND_TAG[m.kind] || m.kind)}</span>`;
  const tabs =
    m.kind === 'pms'
      ? [
          { id: 'holdings', label: 'Holdings', badge: latestHoldings(m).length || undefined, render: pmsHoldingsPanel },
          { id: 'moves', label: 'This period', badge: m.window ? (m.moves || []).filter((x) => x.action !== 'held').length : undefined, render: pmsMovesPanel },
          { id: 'trades', label: 'Trades', badge: m.transactions?.length || undefined, render: pmsTradesPanel },
          { id: 'performance', label: 'Performance', render: performancePanel },
          { id: 'profile', label: 'Profile', render: profilePanel },
        ]
      : m.kind === 'aif'
        ? [
            { id: 'units', label: 'Units', badge: m.positions?.length || undefined, render: aifUnitsPanel },
            { id: 'performance', label: 'Performance', render: performancePanel },
            { id: 'capital', label: 'Commitments & distributions', render: aifCapitalPanel },
            ...(m.finologySlug ? [{ id: 'filed', label: 'Filed stakes', render: filedPanel, wire: wireFiled }] : []),
            { id: 'profile', label: 'Profile', render: profilePanel },
          ]
        : [
            { id: 'funds', label: 'What the schemes hold', badge: (m.lookthrough?.funds || []).length || undefined, render: mfFundsPanel, wire: wireFunds },
            { id: 'profile', label: 'Profile', render: profilePanel },
          ];

  openWorkspace({
    title: m.name,
    subtitle: [m.kind === 'pms' ? m.strategy : m.kind === 'aif' ? m.providerEngagement : null, m.owners.join(', '), m.asOf ? `statements as of ${formatDate(m.asOf)}` : null].filter(Boolean).join(' · '),
    avatarName: m.name,
    badges: [kindTag],
    actionsHtml: m.kind === 'pms' ? `<button type="button" data-manager-export class="rounded-lg bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">Export Excel</button>` : '',
    tabs,
    activeTab: tabs[0].id,
    onClose: () => (open = null),
  });
  document.querySelector('#workspace-content [data-manager-export]')?.addEventListener('click', () => exportManager(m));
}

const latestHoldings = (m) => {
  const first = m.statements?.[0]?.asOf;
  return (m.statements || []).filter((s) => s.asOf === first).flatMap((s) => s.holdings.map((h) => ({ ...h, accountId: s.accountId, asOf: s.asOf })));
};

const th = (label, align = 'left', title = '') => `<th scope="col"${title ? ` title="${escapeHtml(title)}"` : ''} class="whitespace-nowrap px-3 py-2 text-${align} text-[11px] font-bold uppercase tracking-wide text-slate-600">${escapeHtml(label)}</th>`;
const td = (html, align = 'left', extra = '') => `<td class="px-3 py-2 text-${align} tabular-nums ${extra}">${html}</td>`;
const table = (head, body, minWidth = 720) => `
  <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
    <table class="w-full text-sm" style="min-width:${minWidth}px">
      <thead class="bg-slate-50"><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
const ownerOf = (m, accountId) => m.accounts.find((a) => a.accountId === accountId)?.owner || accountId;
const security = (h) => `<span class="font-semibold text-slate-900">${escapeHtml(h.security)}</span>${h.symbol ? `<span class="ml-1.5 text-[11px] text-slate-400">${escapeHtml(h.symbol)}</span>` : ''}`;

function pmsHoldingsPanel() {
  const m = open?.m;
  const rows = latestHoldings(m);
  if (!rows.length) return `<p class="py-10 text-center text-sm text-slate-500">No holdings statement for this mandate is in the archive.</p>`;
  const statements = (m.statements || []).filter((s) => s.asOf === m.statements[0].asOf);
  const multi = statements.length > 1;
  const body = rows
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    .map(
      (h) => `<tr class="border-t border-slate-100${h.assetClass === 'Cash' ? ' bg-slate-50/60' : ''}">
        ${td(security(h))}
        ${multi ? td(`<span class="text-xs text-slate-500">${escapeHtml(ownerOf(m, h.accountId))}</span>`) : ''}
        ${td(qty(h.quantity), 'right')}
        ${td(h.marketPrice == null ? dash : `₹${formatNumber(h.marketPrice, { decimals: 2 })}`, 'right')}
        ${td(money(h.marketValue), 'right', 'font-semibold text-slate-900')}
        ${td(h.totalCost == null ? `<span title="The statement carries no cost for this line — not zero">${dash}</span>` : money(h.totalCost), 'right')}
        ${td(h.pctGainLoss == null ? dash : `<span class="${tone(h.pctGainLoss)}">${escapeHtml(formatPct(h.pctGainLoss, { decimals: 1 }))}</span>`, 'right')}
        ${td(h.weightPct == null ? dash : pct(h.weightPct, 1), 'right')}
      </tr>`
    )
    .join('');
  const totals = statements.map((s) => s.totals).filter(Boolean);
  const total = totals.length ? totals.reduce((a, t) => a + (num(t.totalMarketValue) ?? 0), 0) : null;
  const cash = totals.length ? totals.reduce((a, t) => a + (num(t.cashValue) ?? 0), 0) : null;
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">
      The ${escapeHtml(statements[0].reportType.replace(/-/g, ' '))} of ${escapeHtml(formatDate(statements[0].asOf))}${multi ? `, across ${statements.length} accounts` : ''} — every line as the manager printed it.
      <strong class="text-slate-600">Weight is derived</strong> on the statement’s own market values; the manager’s printed weight is on hover where it differs.
      ${total != null ? `The statement totals <strong class="text-slate-700">${escapeHtml(money(total))}</strong>${cash != null ? `, of which ${escapeHtml(money(cash))} is the cash sleeve` : ''}.` : ''}
    </p>
    ${table(`${th('Security')}${multi ? th('Owner') : ''}${th('Quantity', 'right')}${th('Price', 'right')}${th('Value', 'right', 'The manager’s market value on the statement date')}${th('Cost', 'right')}${th('Gain', 'right', 'On the statement’s cost — null where it prints none')}${th('Weight (derived)', 'right', 'Share of the mandate on the statement’s own market values')}`, body, multi ? 860 : 760)}
    ${statements.flatMap((s) => s.warnings).length ? `<p class="mt-3 text-[11px] leading-relaxed text-amber-800">${escapeHtml(`The extractor noted: ${[...new Set(statements.flatMap((s) => s.warnings))].join(' · ')}`)}</p>` : ''}`;
}

function movesNote(m) {
  return `<strong>Derived</strong> — the ${escapeHtml(formatDate(m.window.to))} statement against the ${escapeHtml(formatDate(m.window.from))} one, per security, by <strong>quantity</strong>.
    Value moves with the price on a day the manager did nothing, so it is not what a move is measured by. The weight change is derived on the statements’ own market values.
    A security gone from the statement was sold or restructured — the trades and corporate actions in the same window say which.`;
}

function tradesCell(mv) {
  const t = mv.trades || {};
  const bits = [];
  if (t.buys) bits.push(`bought ${qty(t.qtyBought)} in ${t.buys} trade${t.buys === 1 ? '' : 's'}${t.bought != null ? ` for ${money(t.bought)}` : ''}`);
  if (t.sells) bits.push(`sold ${qty(t.qtySold)} in ${t.sells} trade${t.sells === 1 ? '' : 's'}${t.sold != null ? ` for ${money(t.sold)}` : ''}`);
  if (mv.via?.length) bits.push(`corporate action: ${mv.via.join(', ')}`);
  if (!bits.length && mv.action !== 'held') bits.push('no trade in this window on the statements');
  return bits.join(' · ');
}

function pmsMovesPanel() {
  const m = open?.m;
  if (!m.window) return `<p class="py-10 text-center text-sm text-slate-500">Only one holdings statement for this mandate is in the archive, so there is nothing to compare it against. No moves are shown rather than calling every position new.</p>`;
  const order = ['new', 'added', 'trimmed', 'exited', 'held'];
  const moves = m.moves || [];
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">${movesNote(m)}${m.cash ? ` The cash sleeve went from <strong>${escapeHtml(pct(m.cash.weightBefore, 1))}</strong> to <strong>${escapeHtml(pct(m.cash.weightNow, 1))}</strong> of the mandate.` : ''}${m.window.pairs?.length > 1 ? ` The accounts were compared over different windows: ${escapeHtml(m.window.pairs.join('; '))}.` : ''}</p>
    ${order
      .map((action) => {
        const group = moves.filter((x) => x.action === action);
        if (!group.length) return '';
        return `<div class="mb-4">
          <div class="mb-1.5 flex items-baseline gap-2">${actionPill(action)}<span class="text-xs text-slate-400">${group.length}</span></div>
          <div class="grid gap-1.5 sm:grid-cols-2">
            ${group
              .map(
                (mv) => `<div class="rounded-lg bg-slate-50 px-3 py-2">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="min-w-0 truncate text-sm text-slate-800">${escapeHtml(mv.security)}${mv.symbol ? `<span class="ml-1.5 text-[11px] text-slate-400">${escapeHtml(mv.symbol)}</span>` : ''}</span>
                    <span class="flex-shrink-0 text-xs tabular-nums text-slate-500">${escapeHtml(qty(mv.qtyBefore))} → ${escapeHtml(qty(mv.qtyNow))}${mv.deltaPp != null ? ` <span class="${tone(mv.deltaPp)}">(${escapeHtml(pp(mv.deltaPp))})</span>` : ''}</span>
                  </div>
                  <div class="mt-0.5 flex items-baseline justify-between gap-3 text-[11px] text-slate-500">
                    <span class="min-w-0 truncate">${escapeHtml(tradesCell(mv))}</span>
                    <span class="flex-shrink-0 tabular-nums">${mv.action === 'exited' ? `was ${escapeHtml(pct(mv.weightBefore, 1))}` : `${escapeHtml(pct(mv.weightNow, 1))} of the mandate`}</span>
                  </div>
                </div>`
              )
              .join('')}
          </div>
        </div>`;
      })
      .join('')}`;
}

function pmsTradesPanel() {
  const m = open?.m;
  const rows = m.transactions || [];
  if (!rows.length) return `<p class="py-10 text-center text-sm text-slate-500">No transaction statement for this mandate is in the archive.</p>`;
  const multi = m.accounts.length > 1;
  const body = rows
    .map(
      (t) => `<tr class="border-t border-slate-100">
        ${td(escapeHtml(formatDate(t.date)))}
        ${td(`<span class="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${t.side === 'buy' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200'}">${t.side}</span>`)}
        ${td(security(t))}
        ${multi ? td(`<span class="text-xs text-slate-500">${escapeHtml(t.owner || '')}</span>`) : ''}
        ${td(qty(t.quantity), 'right')}
        ${td(t.unitPrice == null ? dash : `₹${formatNumber(t.unitPrice, { decimals: 2 })}`, 'right')}
        ${td(t.amount == null ? `<span title="The statement printed no settlement amount for this trade — not zero">${dash}</span>` : money(t.amount), 'right', 'font-semibold text-slate-900')}
      </tr>`
    )
    .join('');
  const bought = rows.filter((t) => t.side === 'buy' && t.amount != null).reduce((s, t) => s + t.amount, 0);
  const sold = rows.filter((t) => t.side === 'sell' && t.amount != null).reduce((s, t) => s + t.amount, 0);
  const unpriced = rows.filter((t) => t.amount == null).length;
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">
      Every dated buy and sell on the ${escapeHtml((m.tape?.reportTypes || []).join(' and ').replace(/-/g, ' ') || 'statements')}${m.tape?.from ? `, ${escapeHtml(formatDate(m.tape.from))} to ${escapeHtml(formatDate(m.tape.to))}` : ''} — ${escapeHtml(formatNumber(rows.filter((t) => t.side === 'buy').length))} buys for ${escapeHtml(money(bought))} and ${escapeHtml(formatNumber(rows.filter((t) => t.side === 'sell').length))} sells for ${escapeHtml(money(sold))}, over the trades that print a settlement amount${unpriced ? ` (${escapeHtml(formatNumber(unpriced))} do not)` : ''}.
      The amount is the statement’s own settlement figure. This window is the statements’, not the holding period.
    </p>
    ${table(`${th('Date')}${th('Side')}${th('Security')}${multi ? th('Owner') : ''}${th('Quantity', 'right')}${th('Price', 'right')}${th('Settled', 'right', 'The statement’s own settlement amount')}`, body, multi ? 820 : 720)}
    ${m.tape?.warnings?.length ? `<p class="mt-3 text-[11px] leading-relaxed text-amber-800">${escapeHtml(`The extractor noted: ${m.tape.warnings.join(' · ')}`)}</p>` : ''}`;
}

const PERIODS = [
  ['mtd', 'MTD'],
  ['qtd', 'QTD'],
  ['fytd', 'FYTD'],
  ['m1', '1M'],
  ['m3', '3M'],
  ['m6', '6M'],
  ['y1', '1Y'],
  ['y3', '3Y'],
  ['si', 'Since inception'],
];

function performancePanel() {
  const m = open?.m;
  const blocks = m.returns || [];
  const nav = m.navHistory || {};
  const bridges = m.bridges || [];
  if (!blocks.length && !Object.keys(nav).length && !bridges.length) {
    return `<p class="py-10 text-center text-sm text-slate-500">${escapeHtml(m.kind === 'aif' ? 'The fund’s statements to the family print no return series, bridge or dated NAV — a cost and a current value are on the Units tab, and the return derived from them is labelled as such.' : 'No fact sheet or performance report for this mandate is in the archive.')}</p>`;
  }
  const multi = m.accounts.length > 1;
  const series = blocks.flatMap((b) => b.series.map((s) => ({ ...s, accountId: b.accountId, reportType: b.reportType })));
  const used = PERIODS.filter(([k]) => series.some((s) => num(s[k]) != null));
  const returnsTable = series.length
    ? table(
        `${multi ? th('Owner') : ''}${th('Series')}${th('Report')}${used.map(([, label]) => th(label, 'right')).join('')}${th('Fees', 'right')}`,
        series
          .map(
            (s) => `<tr class="border-t border-slate-100${s.isBenchmark ? ' text-slate-500' : ''}">
              ${multi ? td(`<span class="text-xs">${escapeHtml(ownerOf(m, s.accountId))}</span>`) : ''}
              ${td(`${escapeHtml(s.series)}${s.isBenchmark ? ' <span class="text-[10px] uppercase tracking-wide text-slate-400">benchmark</span>' : ''}`, 'left', s.isBenchmark ? '' : 'font-semibold text-slate-900')}
              ${td(`<span class="text-xs text-slate-500">${escapeHtml(s.reportType.replace(/-/g, ' '))}</span>`)}
              ${used.map(([k]) => td(num(s[k]) == null ? dash : `<span class="${s.isBenchmark ? '' : tone(s[k])}">${escapeHtml(formatPct(s[k], { decimals: 2 }))}</span>${k === 'si' && s.siAnnualised === false ? '<span class="ml-1 text-[10px] text-slate-400" title="Under a year: not annualised">abs</span>' : ''}`, 'right')).join('')}
              ${td(s.feeBasis ? `<span class="text-xs text-slate-500">${escapeHtml(s.feeBasis)}</span>` : dash, 'right')}
            </tr>`
          )
          .join(''),
        720
      )
    : '';
  const navRows = Object.entries(nav)
    .flatMap(([id, points]) => points.map((p) => ({ id, ...p })))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const navTable = navRows.length
    ? `<h4 class="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Account value, statement by statement</h4>
       ${table(`${multi ? th('Owner') : ''}${th('Date')}${th('Value', 'right')}`, navRows.map((p) => `<tr class="border-t border-slate-100">${multi ? td(`<span class="text-xs text-slate-500">${escapeHtml(ownerOf(m, p.id))}</span>`) : ''}${td(escapeHtml(formatDate(p.date)))}${td(money(p.nav), 'right', 'font-semibold text-slate-900')}</tr>`).join(''), 420)}`
    : '';
  const bridgeTable = bridges.length
    ? `<h4 class="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Capital in, capital out — as the reports bridge it</h4>
       ${table(
         `${multi ? th('Owner') : ''}${th('Report')}${th('Window')}${th('Contributed', 'right')}${th('Withdrawn', 'right')}${th('Realised', 'right')}${th('Unrealised', 'right')}${th('Closing', 'right')}${th('Profit', 'right')}`,
         bridges
           .map(
             (b) => `<tr class="border-t border-slate-100">
               ${multi ? td(`<span class="text-xs text-slate-500">${escapeHtml(ownerOf(m, b.accountId))}</span>`) : ''}
               ${td(`<span class="text-xs text-slate-500">${escapeHtml(b.reportType.replace(/-/g, ' '))}</span>`)}
               ${td(`<span class="text-xs">${escapeHtml(`${formatDate(b.periodFrom)} → ${formatDate(b.periodTo)}`)}<span class="ml-1 text-[10px] text-slate-400">${escapeHtml(b.basis || '')}</span></span>`)}
               ${[b.contribution, b.withdrawal, b.realized, b.unrealized, b.closing, b.profit].map((v) => td(num(v) == null ? dash : money(v), 'right')).join('')}
             </tr>`
           )
           .join(''),
         900
       )}`
    : '';
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">Every figure below is the manager’s own, as its fact sheet or performance report prints it — period labels, benchmark and fee basis included. Nothing is recomputed or annualised here; two reports on one account can disagree, and both are shown.</p>
    ${returnsTable}${navTable}${bridgeTable}`;
}

function aifUnitsPanel() {
  const m = open?.m;
  const rows = m.positions || [];
  const reason = noValuationReason(m);
  if (!rows.length) return `<p class="py-10 text-center text-sm text-slate-500">${escapeHtml(reason || 'The statements carry no unit line for this fund.')}</p>`;
  const body = rows
    .map(
      (p) => `<tr class="border-t border-slate-100">
        ${td(`<span class="font-semibold text-slate-900">${escapeHtml(p.security)}</span>${p.alsoReportedUnder?.length ? '<span class="ml-1.5 text-[10px] uppercase tracking-wide text-amber-700" title="Reported on two members’ statements with identical figures; counted once in every total">also reported under another member</span>' : ''}`)}
        ${td(`<span class="text-xs text-slate-500">${escapeHtml(p.owner || '')}</span>`)}
        ${td(qty(p.quantity), 'right')}
        ${td(money(p.marketValue), 'right', 'font-semibold text-slate-900')}
        ${td(p.costBasis == null ? `<span title="The statement carries no cost — not zero">${dash}</span>` : money(p.costBasis), 'right')}
        ${td(p.returnPct == null ? dash : `<span class="${tone(p.returnPct)}">${escapeHtml(formatPct(p.returnPct, { decimals: 1 }))}</span>`, 'right')}
        ${td(p.positionIrrPct == null ? dash : `<span class="${tone(p.positionIrrPct)}">${escapeHtml(formatPct(p.positionIrrPct, { decimals: 1 }))}</span>`, 'right')}
        ${td(escapeHtml(date(p.accountAsOf)), 'right')}
      </tr>`
    )
    .join('');
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">The family’s units as each statement values them. <strong class="text-slate-600">An AIF publishes no portfolio</strong> — SEBI requires none from a Category II or III fund — so there is nothing to look through; the return is the statement value against the statement’s cost, and the IRR is the fund’s own where it prints one.${reason ? ` ${escapeHtml(reason)}` : ''}</p>
    ${table(`${th('Unit class')}${th('Owner')}${th('Units', 'right')}${th('Value', 'right')}${th('Cost', 'right')}${th('Return', 'right', 'Value against cost, as the statement states them')}${th('IRR (fund’s)', 'right')}${th('Statement', 'right')}`, body, 880)}`;
}

function aifCapitalPanel() {
  const m = open?.m;
  const c = m.commitments || [];
  const ca = m.corporateActions || [];
  if (!c.length && !ca.length) return `<p class="py-10 text-center text-sm text-slate-500">The statements print no capital commitment and record no distribution for this fund — an open-ended fund draws nothing and this one has distributed nothing the archive saw.</p>`;
  const commit = c.length
    ? table(
        `${th('Owner')}${th('As of')}${th('Committed', 'right')}${th('Drawn', 'right')}${th('Undrawn', 'right', 'Dry powder, as printed — never committed minus drawn')}${th('Distributed', 'right')}`,
        c
          .map(
            (x) => `<tr class="border-t border-slate-100">
              ${td(`<span class="text-xs text-slate-500">${escapeHtml(ownerOf(m, x.accountId))}</span>`)}
              ${td(escapeHtml(date(x.asOf)))}
              ${td(money(x.committed), 'right', 'font-semibold text-slate-900')}
              ${td(num(x.drawn) == null ? dash : money(x.drawn), 'right')}
              ${td(num(x.undrawn) == null ? `<span title="The statement prints no undrawn figure — not zero">${dash}</span>` : money(x.undrawn), 'right')}
              ${td(num(x.distributed) == null ? dash : money(x.distributed), 'right')}
            </tr>${x.arithmeticHolds === false ? `<tr><td colspan="6" class="px-3 pb-2 text-[11px] text-amber-800">The fund’s own three figures do not add up on this statement; they are shown as printed rather than reconciled here.</td></tr>` : ''}`
          )
          .join(''),
        720
      )
    : '<p class="text-sm text-slate-500">No capital commitment on the statements — the fund is open-ended or fully drawn on a statement that prints no commitment line.</p>';
  const actions = ca.length
    ? `<h4 class="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Distributions and corporate actions</h4>
       ${table(`${th('Ex-date')}${th('Kind')}${th('Security')}${th('Owner')}${th('Amount', 'right')}`, ca.map((x) => `<tr class="border-t border-slate-100">${td(escapeHtml(date(x.exDate)))}${td(escapeHtml(x.kind || '—'))}${td(escapeHtml(x.security))}${td(`<span class="text-xs text-slate-500">${escapeHtml(ownerOf(m, x.accountId))}</span>`)}${td(num(x.amount) == null ? dash : money(x.amount), 'right')}</tr>`).join(''), 620)}`
    : '';
  return `<p class="mb-3 text-xs leading-relaxed text-slate-500">What the family signed up for, what the fund has called, and what it has paid back — each as the fund’s own statement prints it. Undrawn is printed, never derived.</p>${commit}${actions}`;
}

function filedPanel() {
  const m = open?.m;
  return `
    <div class="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-100">
      <h3 class="font-display text-base font-bold text-slate-900">This fund files stakes with the exchanges</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">${escapeHtml(m.name)} is on Ticker Finology’s superstar-investor list as <strong>${escapeHtml(m.finologySlug)}</strong>: every company in which the fund holds more than 1% is on the shareholding pattern that company files each quarter, and Finology publish that book. It is the one place a Category III fund’s positions can be read from, and it is the public disclosure, not the fund’s statement to the family — a position below 1% of a company is invisible in it.</p>
      <button type="button" data-open-filed class="mt-4 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"${openInvestorFn ? '' : ' disabled'}>Open the filed book, quarter by quarter →</button>
      ${openInvestorFn ? '' : '<p class="mt-2 text-xs text-slate-500">The superstar books have not loaded on this visit.</p>'}
    </div>`;
}

function wireFiled(panel) {
  panel.querySelector('[data-open-filed]')?.addEventListener('click', () => {
    const slug = open?.m?.finologySlug;
    if (slug && openInvestorFn) openInvestorFn(slug);
  });
}

const SHOW_FIRST = 15;

function mfFundsPanel() {
  const m = open?.m;
  const funds = m.lookthrough?.funds || [];
  if (!funds.length) return `<p class="py-10 text-center text-sm text-slate-500">No scheme of this house resolved to an AMC disclosure.</p>`;
  return `
    <p class="mb-3 text-xs leading-relaxed text-slate-500">
      Each scheme’s equity holdings as the AMC disclosed them for the month named — a share of the <strong class="text-slate-600">fund</strong>, not of the family. <strong class="text-slate-600">The family’s share of each underlying is derived</strong> from its units’ value and that weight, and is never added to any book total. NAV and returns are AmfiBeas’s, over AMFI’s daily file, for the plan the family holds.
    </p>
    ${funds.map(fundBlock).join('')}`;
}

function fundBlock(f, i) {
  const plans = f.plans || [];
  const value = f.value?.marketValue ?? null;
  const nav = plans.map((p) => p.nav).find((n) => n?.value != null) || null;
  const returns = plans.map((p) => p.returns).find((r) => r && Object.keys(r).length) || null;
  const periods = returns ? ['1M', '3M', '6M', '1Y', '3Y', '5Y'].filter((k) => returns[k]) : [];
  const rows = (f.equity || []).slice().sort((a, b) => (b.pctAum ?? 0) - (a.pctAum ?? 0));
  const equity = rows.length
    ? table(
        `${th('Company')}${th('Sector (AMC’s)')}${th('% of fund', 'right', 'As the AMC disclosed it')}${th('Family’s share (derived)', 'right', 'Units’ statement value × the disclosed weight — derived, not a position')}`,
        rows
          .map(
            (h, j) => `<tr class="border-t border-slate-100${j >= SHOW_FIRST ? ' hidden' : ''}" data-fund-row="${i}">
              ${td(`<span class="font-semibold text-slate-900">${escapeHtml(h.name)}</span>`)}
              ${td(`<span class="text-xs text-slate-500">${escapeHtml(h.sector || '—')}</span>`)}
              ${td(pct(h.pctAum), 'right')}
              ${td(value == null || h.pctAum == null ? dash : `<span class="text-slate-600">${escapeHtml(money((value * h.pctAum) / 100))}</span>`, 'right')}
            </tr>`
          )
          .join(''),
        640
      )
    : `<p class="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">${escapeHtml(f.section ? `The disclosure’s ${f.section.toLowerCase()} section holds no rows for this scheme — a debt, liquid or commodity scheme holds no equity, and its other sleeves are not in the store.` : 'No portfolio disclosure resolved for this scheme (an ETF on a metal, or a scheme the store does not carry).')}</p>`;
  return `
    <section class="mb-5 rounded-2xl bg-white p-4 ring-1 ring-slate-100">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
          <h4 class="font-display text-sm font-bold text-slate-900">${escapeHtml(f.scheme)}</h4>
          <p class="mt-0.5 text-[11px] text-slate-500">${escapeHtml([f.classification, plans.map((p) => `${p.plan || 'plan'} · ${p.positions.map((x) => x.owner).filter(Boolean).join(', ')}`).join(' / ')].filter(Boolean).join(' · '))}</p>
        </div>
        <div class="text-right">
          <div class="text-sm font-bold tabular-nums text-slate-900">${escapeHtml(money(value))}</div>
          <div class="text-[10px] uppercase tracking-wide text-slate-400">statement value</div>
        </div>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        ${statCell(nav ? `₹${formatNumber(nav.value, { decimals: 2 })}` : null, nav?.date ? `NAV · ${formatDate(nav.date)}` : 'NAV', 'The plan’s published NAV')}
        ${statCell(nav?.changePct == null ? null : `<span class="${tone(nav.changePct)}">${escapeHtml(formatPct(nav.changePct, { decimals: 2 }))}</span>`, 'day change', 'Against the previous published NAV')}
        ${statCell(f.fundAumCr == null ? null : `₹${formatNumber(f.fundAumCr, { decimals: 0 })} Cr`, 'fund AUM', 'The scheme’s assets under management, as published')}
        ${statCell(f.holdingsAsOf ? formatDate(f.holdingsAsOf) : null, `holdings as of${f.holdingsSource?.kind ? ` · ${f.holdingsSource.kind}` : ''}`, f.holdingsSource?.kind === 'amc' ? 'Read from the AMC’s own monthly disclosure' : f.holdingsSource?.kind === 'aggregator' ? 'Read from a third party’s copy of the AMC’s disclosure' : 'No disclosure resolved')}
      </div>
      ${periods.length ? `<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">${periods.map((k) => `<span title="${escapeHtml(`${returns[k].kind || ''} · ${returns[k].startDate || '?'} → ${returns[k].endDate || '?'}`)}"><span class="font-semibold text-slate-600">${k}</span> <span class="tabular-nums ${tone(returns[k].value)}">${escapeHtml(formatPct(returns[k].value, { decimals: 1 }))}</span></span>`).join('')}<span class="text-slate-400">returns as AmfiBeas compute them, each over its own window (on hover)</span></div>` : ''}
      <div class="mt-3">${equity}</div>
      ${rows.length > SHOW_FIRST ? `<button type="button" data-fund-more="${i}" class="mt-2 text-xs font-semibold text-indigo-700 hover:underline">Show all ${formatNumber(rows.length)} disclosed holdings</button>` : ''}
    </section>`;
}

function wireFunds(panel) {
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fund-more]');
    if (!btn) return;
    panel.querySelectorAll(`[data-fund-row="${btn.dataset.fundMore}"]`).forEach((tr) => tr.classList.remove('hidden'));
    btn.remove();
  });
}

function profilePanel() {
  const m = open?.m;
  const rows = [
    ['Manager', m.house],
    ['Kind', KIND_TAG[m.kind]],
    ['Strategy', m.strategy],
    ['Engagement', [m.engagement, m.providerEngagement].filter(Boolean).join(' · ')],
    ['Owners', m.owners.join(', ')],
    ['Statement value', money(m.value?.marketValue)],
    ['Cost on the statements', m.value?.costBasis == null ? null : `${money(m.value.costBasis)} on ${formatNumber(m.value.costRows)} of ${formatNumber(m.value.positions)} lines`],
    ['Newest statement', date(m.asOf)],
    m.kind === 'pms' ? ['Comparison window', m.window ? `${formatDate(m.window.from)} → ${formatDate(m.window.to)}` : 'one statement only'] : null,
    m.kind === 'pms' ? ['Trades on the statements', m.tape?.from ? `${formatNumber(m.transactions?.length || 0)} · ${formatDate(m.tape.from)} → ${formatDate(m.tape.to)}` : null] : null,
    m.finologySlug ? ['Ticker Finology', m.finologySlug] : null,
  ].filter(Boolean);
  const accounts = table(
    `${th('Account')}${th('Owner')}${th('Provider')}${th('Statement', 'right')}${th('Since', 'right')}`,
    m.accounts
      .map(
        (a) => `<tr class="border-t border-slate-100">
          ${td(`<span class="font-mono text-xs">${escapeHtml(a.accountNo || a.accountId)}</span>`)}
          ${td(escapeHtml(a.owner || '—'))}
          ${td(`<span class="text-xs text-slate-500">${escapeHtml(a.provider || '')}</span>`)}
          ${td(escapeHtml(date(a.asOf)), 'right')}
          ${td(escapeHtml(date(a.inceptionDate)), 'right')}
        </tr>${a.noPositionsReason ? `<tr><td colspan="5" class="px-3 pb-2 text-[11px] text-amber-800">${escapeHtml(a.noPositionsReason)}</td></tr>` : ''}`
      )
      .join(''),
    640
  );
  const statements = (m.statements || []).length
    ? `<h4 class="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Statements read</h4><ul class="space-y-1 text-xs text-slate-600">${m.statements.map((s) => `<li><span class="font-mono text-[11px] text-slate-500">${escapeHtml(s.docKey)}</span> — ${escapeHtml(s.reportType.replace(/-/g, ' '))} of ${escapeHtml(formatDate(s.asOf))}, ${escapeHtml(formatNumber(s.holdings.length))} lines</li>`).join('')}</ul>`
    : '';
  return `
    <dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      ${rows.map(([k, v]) => `<div class="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1"><dt class="text-xs text-slate-500">${escapeHtml(k)}</dt><dd class="text-right text-sm font-semibold text-slate-900">${v == null || v === '' ? dash : escapeHtml(String(v))}</dd></div>`).join('')}
    </dl>
    <h4 class="mb-1.5 mt-5 text-[11px] font-bold uppercase tracking-wider text-slate-500">Accounts on the statements</h4>
    ${accounts}
    ${statements}
    <p class="mt-4 text-xs leading-relaxed text-slate-500">Every field above is as techmuns/GlowVentures read it from the wealth platforms’ PDF statements${managers.meta()?.builtFrom ? ` (GlowVentures@${escapeHtml(managers.meta().builtFrom)})` : ''}, copied here daily as public/data/managers.json. Where one is blank the statement did not print it — nothing is inferred or filled in.</p>`;
}

async function exportManager(m) {
  const meta = managers.meta();
  await exportSheets({
    filename: `glow-manager-${m.id}-${todayStamp()}`,
    banner:
      `THE MANAGER'S OWN STATEMENTS TO THE FAMILY, NOT OURS. ${m.name}${m.strategy ? ` — ${m.strategy}` : ''}, as read by techmuns/GlowVentures${meta?.builtFrom ? `@${meta.builtFrom}` : ''} from the PDF statements and exported ${new Date().toISOString()}. ` +
      `Holdings are the newest statement's lines with the manager's own quantity, price, value and cost; "Weight (derived)" is this dashboard's share-of-mandate on those market values. ` +
      `"This period" compares the two newest statements BY QUANTITY — never by value — and "no longer on the statement" is a sale or a corporate action, with the trades in the window beside it. ` +
      `Trades are the statement's dated buys and sells with its own settlement amount. A BLANK IS A FIGURE THE STATEMENT DOES NOT PRINT, NOT ZERO. Nothing here is scored.`,
    sheets: [
      {
        name: 'Holdings',
        columns: [
          { header: 'Security', width: 34, get: (r) => r.security },
          { header: 'Symbol', width: 12, get: (r) => r.symbol || '' },
          { header: 'Owner', width: 22, get: (r) => ownerOf(m, r.accountId) },
          { header: 'Statement', width: 12, get: (r) => r.asOf },
          { header: 'Quantity', width: 12, get: (r) => r.quantity ?? '' },
          { header: 'Price', width: 12, get: (r) => r.marketPrice ?? '' },
          { header: 'Value', width: 16, get: (r) => r.marketValue ?? '' },
          { header: 'Cost', width: 16, get: (r) => r.totalCost ?? '' },
          { header: 'Gain %', width: 10, get: (r) => r.pctGainLoss ?? '' },
          { header: 'Weight % (derived)', width: 16, get: (r) => r.weightPct ?? '' },
          { header: 'Weight % (printed)', width: 16, get: (r) => r.printedWeightPct ?? '' },
        ],
        rows: latestHoldings(m),
      },
      {
        name: 'This period (derived)',
        columns: [
          { header: 'Security', width: 34, get: (r) => r.security },
          { header: 'Symbol', width: 12, get: (r) => r.symbol || '' },
          { header: 'Action', width: 26, get: (r) => (ACTION[r.action] || [r.action])[0] },
          { header: 'Qty before', width: 12, get: (r) => r.qtyBefore ?? '' },
          { header: 'Qty now', width: 12, get: (r) => r.qtyNow ?? '' },
          { header: 'Weight before %', width: 14, get: (r) => r.weightBefore ?? '' },
          { header: 'Weight now %', width: 14, get: (r) => r.weightNow ?? '' },
          { header: 'Change pp (derived)', width: 16, get: (r) => r.deltaPp ?? '' },
          { header: 'Buys in window', width: 12, get: (r) => r.trades?.buys ?? '' },
          { header: 'Sells in window', width: 12, get: (r) => r.trades?.sells ?? '' },
          { header: 'Bought (settled)', width: 16, get: (r) => r.trades?.bought ?? '' },
          { header: 'Sold (settled)', width: 16, get: (r) => r.trades?.sold ?? '' },
          { header: 'Corporate action', width: 16, get: (r) => (r.via || []).join(', ') },
        ],
        rows: m.moves || [],
      },
      {
        name: 'Trades',
        columns: [
          { header: 'Date', width: 12, get: (r) => r.date },
          { header: 'Side', width: 8, get: (r) => r.side },
          { header: 'Security', width: 34, get: (r) => r.security },
          { header: 'Symbol', width: 12, get: (r) => r.symbol || '' },
          { header: 'Owner', width: 22, get: (r) => r.owner || '' },
          { header: 'Quantity', width: 12, get: (r) => r.quantity ?? '' },
          { header: 'Price', width: 12, get: (r) => r.unitPrice ?? '' },
          { header: 'Settled', width: 16, get: (r) => r.amount ?? '' },
          { header: 'Source', width: 60, get: (r) => r.source },
        ],
        rows: m.transactions || [],
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// THE PERIOD, ACROSS EVERY MANDATE — the block Quarterly Changes carries above the superstar one
// ---------------------------------------------------------------------------------------

/**
 * `{ html, wire }` for the Quarterly Changes section, or null under Universe. Portfolio shows the
 * whole set; Watchlist narrows through the same predicate the cards use.
 */
export function managerSummaryBlock(ctx) {
  if (ctx.scope === 'universe') return null;
  if (!managers.isLoaded()) {
    const html = `<section class="mb-6" data-manager-summary data-manager-summary-loading><div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div></section>`;
    return {
      html,
      wire(root, disposers) {
        const host = root.querySelector('[data-manager-summary]');
        managers.load().then(() => {
          if (!host || !host.isConnected) return;
          const built = buildSummary(ctx);
          host.outerHTML = built.html;
          built.wire(root, disposers);
        });
      },
    };
  }
  return buildSummary(ctx);
}

function buildSummary(ctx) {
  const m = managers.meta();
  if (!m) {
    return { html: `<section class="mb-6" data-manager-summary>${unavailablePanel()}</section>`, wire: () => {} };
  }
  const include = scopeInclude(ctx);
  const q = managers.periodSummary({ include, limit: 5 });
  const openCompany = (item) => openCompanyDetail(item.securityKey);
  const sub = (mv) => `${mv.manager}${mv.trades?.buys || mv.trades?.sells ? ` · ${[mv.trades.buys ? `${mv.trades.buys} buy${mv.trades.buys === 1 ? '' : 's'}` : null, mv.trades.sells ? `${mv.trades.sells} sell${mv.trades.sells === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')}` : mv.via?.length ? ` · ${mv.via.join(', ')}` : ''}`;
  const andOthers = (names) => (names.length <= 2 ? names.join(' & ') : `${names[0]}, ${names[1]} +${names.length - 2}`);

  const panels = [
    rankedList({
      key: 'mm-consensus-buys',
      title: 'Bought by more than one of your managers',
      note: 'Newly on the statement, or added to, by two or more of the family’s mandates.',
      items: q.consensusBuys.map((c) => ({ name: c.security, securityKey: c.securityKey, sub: andOthers(c.managers.map((i) => i.manager)), value: `${c.count} managers`, badge: c.sized ? pp(c.sumPp) : null, tone: 'pos' })),
      empty: 'No company was bought by more than one of your managers this period.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'mm-new',
      title: 'New positions',
      note: 'First statement it appears on. Ranked by the weight now held — an appearance has no prior weight.',
      items: q.newEntrants.map((mv) => ({ name: mv.security, securityKey: mv.securityKey, sub: sub(mv), value: mv.weightNow == null ? '—' : `${pct(mv.weightNow, 1)} of mandate`, tone: 'pos' })),
      empty: 'No new position appeared on any statement this period.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'mm-adds',
      title: 'Largest increases',
      note: 'Change in weight of the mandate, newest statement minus the one before — derived; the quantity rose.',
      items: q.topAdds.map((mv) => ({ name: mv.security, securityKey: mv.securityKey, sub: sub(mv), value: pp(mv.deltaPp), tone: 'pos' })),
      empty: 'No position was added to this period.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'mm-consensus-sells',
      title: 'Sold by more than one of your managers',
      note: 'Trimmed, or no longer on the statement, at two or more of the family’s mandates.',
      items: q.consensusSells.map((c) => ({ name: c.security, securityKey: c.securityKey, sub: andOthers(c.managers.map((i) => i.manager)), value: `${c.count} managers`, badge: c.sized ? pp(c.sumPp) : null, tone: 'neg' })),
      empty: 'No company was sold down by more than one of your managers this period.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'mm-trims',
      title: 'Largest reductions',
      note: 'Change in weight of the mandate, newest statement minus the one before — derived; the quantity fell.',
      items: q.topTrims.map((mv) => ({ name: mv.security, securityKey: mv.securityKey, sub: sub(mv), value: pp(mv.deltaPp), tone: 'neg' })),
      empty: 'No position was reduced this period.',
      onSelect: openCompany,
    }),
    rankedList({
      key: 'mm-exits',
      title: 'No longer on the statement',
      note: 'On the prior statement, gone from the newest. A PMS statement lists every holding, so this is a sale or a corporate action — the row says which.',
      items: q.exits.map((mv) => ({ name: mv.security, securityKey: mv.securityKey, sub: sub(mv), value: mv.weightBefore == null ? '—' : `was ${pct(mv.weightBefore, 1)}`, tone: 'neg' })),
      empty: 'Every position on the prior statements is still on the newest ones.',
      onSelect: openCompany,
    }),
  ];

  const html = `
    <section class="mb-6" data-manager-summary>
      ${summaryHead(q, ctx)}
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">${panels.map((p) => p.html).join('')}</div>
    </section>`;

  function wire(root, disposers) {
    for (const panel of panels) disposers.push(panel.wire(root));
    const btn = root.querySelector('[data-manager-summary-help]');
    if (btn) btn.addEventListener('click', () => openModal(summaryHelpBody(q), { size: 'wide' }));
  }
  return { html, wire };
}

function summaryHead(q, ctx) {
  const c = q.counts;
  const clause = (n, text) => (n ? text : null);
  const parts = [clause(c.new, `${formatNumber(c.new)} new`), clause(c.added, `${formatNumber(c.added)} added`), clause(c.trimmed, `${formatNumber(c.trimmed)} trimmed`), clause(c.exited, `${formatNumber(c.exited)} no longer on the statement`)].filter(Boolean);
  const tradeClause = q.trades.buys || q.trades.sells ? ` · ${formatNumber(q.trades.buys)} buys${q.trades.bought != null ? ` for ${money(q.trades.bought)}` : ''} and ${formatNumber(q.trades.sells)} sells${q.trades.sold != null ? ` for ${money(q.trades.sold)}` : ''} on the statements` : '';
  const scopeNote = ctx.scope === 'watchlist' ? ' · narrowed to the starred symbols' : '';
  return `
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="font-display text-lg font-bold text-slate-900">Your managers this period</h2>
      <button type="button" data-manager-summary-help
        class="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        <span>How this is derived</span><span aria-hidden="true">?</span>
      </button>
    </div>
    <p class="mb-3 text-xs text-slate-500">
      ${parts.length ? `${escapeHtml(parts.join(' · '))} across ${formatNumber(q.contributingManagers)} of ${formatNumber(q.comparableManagers)} comparable mandates${escapeHtml(tradeClause)}` : `No position changed on any comparable mandate${escapeHtml(scopeNote ? ' among the starred symbols' : '')}.`}
      <span class="text-slate-400">· ${q.windows.length === 1 ? escapeHtml(q.windows[0]) : `${q.windows.length} statement windows`}${q.singleStatementManagers ? ` · ${formatNumber(q.singleStatementManagers)} mandate${q.singleStatementManagers === 1 ? '' : 's'} with one statement cannot be compared` : ''}${escapeHtml(scopeNote)}</span>
    </p>`;
}

function summaryHelpBody(q) {
  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">How your managers’ moves are derived</h2>
          <p class="mt-1 text-sm text-slate-500">From each PMS manager’s own statements to the family, read by techmuns/GlowVentures and copied here daily.</p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">&times;</button>
      </div>
      <div class="space-y-3 text-[13px] leading-relaxed text-slate-700">
        <p>Each mandate’s two newest holdings statements are compared <strong>by quantity</strong>, security by security. A position on the newest statement and not the prior one is <strong>new</strong>; on the prior and not the newest, <strong>no longer on the statement</strong>; a higher or lower quantity is <strong>added</strong> or <strong>trimmed</strong>. Value is not what a move is measured by — it moves with the price on a day the manager did nothing.</p>
        <p><strong>The weight change is derived.</strong> Each security’s share of the mandate is computed on the statement’s own market values, and the change is the newest share minus the prior one, in percentage points of the mandate. A new position has no prior share and an exit no current one, so neither is given a size; new entrants rank by the weight now held, and an exit carries the weight it had, worded <em>was</em>.</p>
        <p><strong>The trades beside a move are the statement’s.</strong> Every dated buy and sell on the manager’s transaction statement or SEBI investor report in the same window is counted against the move, with the settlement amount the statement prints. A quantity that changed with no trade in the window says so — a corporate action recorded on the statements is named where one explains it.</p>
        <p><strong>“Bought by more than one of your managers” is a count</strong> of the family’s mandates that newly hold or added to the same company. It is not weighted, not scored and not a recommendation.</p>
        <p><strong>Only PMS mandates enter this roll-up.</strong> An alternative fund publishes no portfolio and a mutual fund’s monthly disclosure is a share of the fund; both are on their own cards, and neither is a move the family’s manager made in the family’s account. A mandate with one statement in the archive is not comparable and contributes nothing${q.singleStatementManagers ? ` — ${formatNumber(q.singleStatementManagers)} right now` : ''}.</p>
      </div>
    </div>`;
}

/** One company across every mandate whose comparison window contains it, unchanged holders included. */
function openCompanyDetail(securityKey) {
  const d = managers.companyDetail(securityKey);
  const current = d.rows.filter((r) => r.qtyNow != null).length;
  const changed = d.rows.filter((r) => r.action !== 'held').length;
  const rows = d.rows
    .map(
      (r) => `<tr class="border-t border-slate-100" data-company-manager-row>
        ${td(`<div class="font-semibold text-slate-900">${escapeHtml(r.manager)}</div><div class="text-[11px] text-slate-500">${escapeHtml(r.strategy || '')}</div>`)}
        ${td(actionPill(r.action))}
        ${td(`<span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(r.window ? formatDate(r.window.from) : '')}</span><span class="mt-0.5 block font-semibold tabular-nums text-slate-700">${r.qtyBefore == null ? dash : `${escapeHtml(qty(r.qtyBefore))} · ${escapeHtml(pct(r.weightBefore, 1))}`}</span>`, 'right')}
        ${td(`<span class="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">${escapeHtml(r.window ? formatDate(r.window.to) : '')}</span><span class="mt-0.5 block font-semibold tabular-nums text-slate-900">${r.qtyNow == null ? dash : `${escapeHtml(qty(r.qtyNow))} · ${escapeHtml(pct(r.weightNow, 1))}`}</span>`, 'right')}
        ${td(r.deltaPp == null ? dash : `<span class="font-semibold ${tone(r.deltaPp)}">${escapeHtml(pp(r.deltaPp))}</span>`, 'right')}
        ${td(`<span class="text-xs text-slate-600">${escapeHtml(tradesCell(r) || '—')}</span>`)}
        ${td(r.valueNow == null ? dash : `<span class="font-semibold tabular-nums text-slate-700">${escapeHtml(money(r.valueNow))}</span>`, 'right')}
      </tr>`
    )
    .join('');
  openModal(
    `<div class="scrollbar-thin max-h-[82vh] overflow-y-auto" data-company-manager-detail>
      <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-6 py-5 backdrop-blur sm:px-7">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[11px] font-bold uppercase tracking-wider text-indigo-600">Across your managers</p>
            <h2 class="font-display mt-1 text-xl font-bold text-slate-900">${escapeHtml(d.security)}${d.symbol ? `<span class="ml-2 text-sm font-semibold text-slate-400">${escapeHtml(d.symbol)}</span>` : ''}</h2>
            <p class="mt-1 text-xs text-slate-500">${escapeHtml(formatNumber(d.rows.length))} mandate${d.rows.length === 1 ? '' : 's'} in the latest comparison · ${escapeHtml(formatNumber(current))} currently on a statement · ${escapeHtml(formatNumber(changed))} changed</p>
          </div>
          <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
      </div>
      <div class="px-6 py-5 sm:px-7">
        <p class="mb-4 text-xs leading-relaxed text-slate-500">Quantity and weight of the mandate on each manager’s prior and newest statement; the weight and its change are derived on the statements’ own market values. <strong class="text-slate-600">Value is the newest statement’s mark on the position, not an amount bought or sold</strong> — the trades column carries what was actually settled. A dash is a figure the statement does not carry, not zero.</p>
        <div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
          <table class="w-full text-sm" style="min-width:900px">
            <thead class="bg-slate-50"><tr>${th('Manager')}${th('Status')}${th('Before', 'right', 'Quantity · weight of the mandate on the prior statement')}${th('Now', 'right', 'Quantity · weight of the mandate on the newest statement')}${th('Change (derived)', 'right')}${th('Trades in the window')}${th('Value now', 'right', 'The newest statement’s market value of the position')}</tr></thead>
            <tbody>${rows || `<tr><td colspan="7" class="px-4 py-10 text-center text-sm text-slate-500">No mandate’s comparison window contains this company.</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    </div>`,
    { size: 'wide' }
  );
}

// ---------------------------------------------------------------------------------------
// Provenance, and the state with nothing to show
// ---------------------------------------------------------------------------------------

function unavailablePanel() {
  const f = managers.failureInfo();
  const why = f?.reason === 'missing' ? 'public/data/managers.json is not on this origin.' : f?.reason === 'shape' ? 'public/data/managers.json is not in the shape this dashboard knows.' : 'public/data/managers.json could not be read.';
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100" data-managers-unavailable>
      <div class="text-sm font-semibold text-slate-900">The managers file could not be read</div>
      <p class="mt-2 text-sm text-slate-600">${escapeHtml(why)}${f?.message ? ` <span class="font-mono text-[11px] text-slate-500">${escapeHtml(f.message)}</span>` : ''}</p>
      <p class="mt-2 text-xs text-slate-500">It is written by <code class="rounded bg-slate-100 px-1">scripts/build-managers.mjs</code> from a techmuns/GlowVentures checkout and refreshed daily by the GlowVentures copy workflow. <strong>Nothing is shown in its place</strong> — an empty grid would claim the family has no managers.</p>
    </div>`;
}

function openProvenance() {
  const m = managers.meta() || {};
  const k = m.byKind || {};
  const row = (label, value) => `<div class="flex items-start justify-between gap-4 py-1.5"><dt class="text-xs text-slate-500">${escapeHtml(label)}</dt><dd class="text-right text-sm tabular-nums text-slate-800">${escapeHtml(value)}</dd></div>`;
  openModal(
    `
    <div class="scrollbar-thin max-h-[85vh] overflow-y-auto p-6">
      <div class="text-xs font-bold uppercase tracking-wider text-slate-400">My Managers · sources</div>
      <h3 class="font-display mt-1 text-xl font-bold text-slate-900">Where these figures come from</h3>
      <p class="mt-3 text-sm text-slate-600"><strong>Real, and not computed here.</strong> Every manager is an account on a wealth platform’s statement to the family; techmuns/GlowVentures reads those PDF statements, and <code class="rounded bg-slate-100 px-1">scripts/build-managers.mjs</code> copies what this page needs as <code class="rounded bg-slate-100 px-1">public/data/managers.json</code>, daily, beside the Family Book.</p>
      <dl class="mt-4 divide-y divide-slate-100 rounded-xl bg-slate-50 px-4 py-1 ring-1 ring-slate-100">
        ${row('Statements as of', m.asOf ? formatDate(m.asOf) : '—')}
        ${row('Synced from', m.builtFrom ? `techmuns/GlowVentures@${m.builtFrom}` : 'techmuns/GlowVentures')}
        ${row('Managers · managed value', `${formatNumber(m.managers)} · ${money(m.managedValue)} of the ${money(m.bookValue)} book`)}
        ${row('PMS mandates · comparable', `${formatNumber(k.pms?.count)} · ${formatNumber(m.comparableMandates)} with two statements`)}
        ${row('Trades on the statements', formatNumber(m.trades))}
        ${row('Alternative funds', `${formatNumber(k.aif?.count)} · ${money(k.aif?.marketValue)}`)}
        ${row('Fund houses · disclosed equity lines', `${formatNumber(k.mf?.count)} · ${formatNumber(m.disclosedRows)}`)}
        ${row('Direct holdings, outside this page', m.direct ? `${money(m.direct.marketValue)} across ${formatNumber(m.direct.positions)} positions` : '—')}
        ${row('Schemes with no AMC disclosure', m.unresolvedSchemes?.length ? m.unresolvedSchemes.map((u) => u.security).join(', ') : 'none')}
      </dl>
      <div class="mt-4 space-y-2 text-sm text-slate-600">
        <p><strong>PMS mandates</strong> — the manager’s portfolio appraisal, SEBI investor report or holdings statement (in that precedence, the same one GlowVentures’ ledger reads in), newest issue first, and its transaction statement for the dated trades. A move is a change in <strong>quantity</strong> between the two newest statements; the weight of the mandate and its change are derived on the statements’ own market values and headed so.</p>
        <p><strong>Alternative funds</strong> — units as the fund’s statement values them, with its own return series, capital bridge, commitment and distributions. No portfolio: SEBI requires none from a Category II or III AIF. A fund that also files &gt;1% stakes with the exchanges links to its Finology book, which is the public disclosure and not the fund’s statement.</p>
        <p><strong>Fund houses</strong> — the AMC’s monthly SEBI portfolio disclosure per scheme, read through the family’s AmfiBeas store (the AMC’s own file where it has one, a third party’s copy where not, and the card says which); NAV and returns are AmfiBeas’s over AMFI’s daily file, for the plan the family holds. The family’s share of an underlying is derived from its units and never added to any total.</p>
        <p><strong>A dash is a figure the statement does not carry</strong> — never zero, never summed as zero. A fund that publishes no NAV reads <em>no valuation</em>, not ₹0. Nothing on this page is scored.</p>
        <p class="text-xs text-slate-500">Refresh: <code class="rounded bg-slate-100 px-1">.github/workflows/series-refresh.yml</code>, 03:30 UTC daily, needs <code class="rounded bg-slate-100 px-1">GLOWVENTURES_READ_TOKEN</code>. By hand: <code class="rounded bg-slate-100 px-1">GLOWVENTURES_DIR=… node scripts/build-managers.mjs</code>.</p>
      </div>
    </div>`,
    { size: 'wide' }
  );
}
