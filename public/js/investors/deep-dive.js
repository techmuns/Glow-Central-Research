// investors/deep-dive.js — the per-investor workspace.
//
// Four views over one holder's book, in the full-screen overlay (ui/screener.js
// openWorkspace). Opened from an investor card, a moves-table row, and the overlap heatmap.
//
//   Portfolio  full holdings, sector allocation, concentration, value across four quarters
//   Activity   this quarter's adds / trims / new entries / full exits
//   History    per-holding, quarter by quarter
//   Overlap    which other tracked holders own the same names
//
// ATTRIBUTION. The holder's name is real; every position shown here is synthetic. The banner
// below is not decoration — it is the reason this view is allowed to exist, and it renders on
// all four tabs. There is deliberately no commentary, rationale or quote anywhere in this
// file, because the data set contains none: see scripts/gen-mock-investors.mjs.

import { openWorkspace, refreshWorkspace, closeWorkspace, selectWorkspaceTab } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCroreCompact } from '../core/format.js';
import * as investors from '../data/investors.js';

const TABS = ['portfolio', 'activity', 'history', 'overlap'];
const TAB_LABEL = { portfolio: 'Portfolio', activity: 'Activity', history: 'History', overlap: 'Overlap' };

let openState = null;

export function open(holder, { tab = 'portfolio', onTabChange = null, onClose = null, focusTicker = null, onSwitch = null } = {}) {
  if (!holder) return false;
  const activeTab = TABS.includes(tab) ? tab : 'portfolio';
  openState = { holder, activeTab, focusTicker, onSwitch };

  openWorkspace({
    title: holder.name,
    avatarName: holder.name,
    subtitle: subtitleFor(holder),
    badges: [typeBadge(holder), mockBadge()].filter(Boolean),
    tabs: TABS.map((id) => ({
      id,
      label: TAB_LABEL[id],
      badge: badgeFor(id, holder),
      render: () => RENDERERS[id](holder),
      wire: (root) => WIRERS[id]?.(root, holder),
    })),
    activeTab,
    onTabChange: (id) => {
      if (openState) openState.activeTab = id;
      onTabChange?.(id);
    },
    onClose: () => {
      openState = null;
      onClose?.();
    },
  });
  return true;
}

export function close() {
  closeWorkspace();
}
export function refresh() {
  if (openState) refreshWorkspace();
}
export function currentId() {
  return openState?.holder?.investorId || null;
}
export function openById(id, opts) {
  return open(investors.byId(id), opts);
}

function subtitleFor(h) {
  const bits = [];
  if (h.type === 'institution') {
    if (h.house) bits.push(h.house);
    if (h.manager) bits.push(`managed by ${h.manager}`);
    if (h.category) bits.push(h.category);
    if (h.aumCr) bits.push(`AUM ${formatCroreCompact(h.aumCr)}`);
    if (h.schemeCount) bits.push(`${h.schemeCount} scheme${h.schemeCount === 1 ? '' : 's'}`);
  } else {
    if (h.since) bits.push(`tracked since ${h.since}`);
    bits.push(`${h.stocksHeld} holdings`);
  }
  bits.push(`as of ${h.latestQuarter}`);
  return bits.join(' · ');
}

function typeBadge(h) {
  return h.type === 'institution'
    ? `<span class="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-700 ring-1 ring-purple-200">${escapeHtml(h.category || 'Institution')}</span>`
    : '<span class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700 ring-1 ring-indigo-200">Individual</span>';
}

function mockBadge() {
  if (!investors.meta()?.isMock) return null;
  return '<span class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">Illustrative</span>';
}

function badgeFor(id, holder) {
  if (id === 'portfolio') return holder.stocksHeld || null;
  if (id === 'activity') {
    const a = investors.activity(holder);
    return a.newEntries.length + a.adds.length + a.trims.length + a.exits.length || null;
  }
  if (id === 'overlap') return investors.overlapFor(holder).length || null;
  return null;
}

/**
 * The attribution banner. This renders on every tab of every investor workspace, because this
 * is the surface where a synthetic position is attached to a real person's name — the one
 * place where being unlabelled would actually mislead someone.
 */
function attributionBanner(holder) {
  if (!investors.meta()?.isMock) return '';
  return `
    <div data-attribution class="mb-4 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-300">
      <div class="text-[11px] font-bold uppercase tracking-wider text-amber-800">Illustrative positions — not ${escapeHtml(holder.name)}'s actual holdings</div>
      <div class="mt-1 text-[11px] leading-relaxed text-amber-900">
        ${escapeHtml(holder.name)} is a real ${holder.type === 'institution' ? 'fund' : 'investor'} whose genuine shareholdings are disclosed in quarterly exchange filings
        and aggregated by Trendlyne, Ticker Finology and AMFI. <strong>Every position, quantity and percentage on this page is synthetic</strong>,
        generated by <code class="rounded bg-amber-100 px-1">scripts/gen-mock-investors.mjs</code> — none of it reflects what
        ${escapeHtml(holder.name)} owns. Nothing here is a statement, view or opinion attributed to them; the data set holds numbers only.
      </div>
    </div>`;
}

/** Value is holding % × market cap, because filings disclose a percentage and never a rupee amount. */
function derivedValueNote() {
  return `
    <div class="mb-4 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-200">
      <strong class="text-slate-600">Value is derived, not disclosed.</strong> A shareholding filing gives a percentage of the
      company, never a rupee amount. Every ₹ figure here is that percentage applied to the company's market cap, so it moves with
      the market as well as with the position.
    </div>`;
}

const ACTION_PILL = {
  New: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  Buy: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  Hold: 'bg-slate-100 text-slate-600 ring-slate-200',
  Sell: 'bg-amber-50 text-amber-700 ring-amber-200',
  Exit: 'bg-rose-50 text-rose-700 ring-rose-200',
};
const actionPill = (a) =>
  `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${ACTION_PILL[a] || ACTION_PILL.Hold}">${escapeHtml(a)}</span>`;

const signed = (n, d = 2) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(d)}`);
const qtyDelta = (n) =>
  n == null || n === 0
    ? '<span class="text-xs text-slate-400">—</span>'
    : `<span class="text-xs font-semibold tabular-nums ${n > 0 ? 'text-emerald-600' : 'text-rose-600'}">${n > 0 ? '+' : ''}${formatNumber(n)}</span>`;

// ---------------------------------------------------------------------------------------
// (a) PORTFOLIO
// ---------------------------------------------------------------------------------------

function renderPortfolio(holder) {
  const rows = holder.latestHoldings;
  if (!rows.length) {
    return `${attributionBanner(holder)}<div class="rounded-2xl bg-slate-50 p-10 text-center text-sm text-slate-500 ring-1 ring-slate-200">No positions on file for ${escapeHtml(holder.latestQuarter)}.</div>`;
  }
  const total = rows.reduce((s, h) => s + h.valueCr, 0);

  return `
    ${attributionBanner(holder)}
    ${derivedValueNote()}

    <div class="mb-5 grid gap-4 lg:grid-cols-[280px_1fr]">
      ${sectorDonut(holder)}
      <div class="space-y-4">
        ${concentrationCard(holder, total)}
        ${valueTrendCard(holder)}
      </div>
    </div>

    <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Holdings · ${escapeHtml(holder.latestQuarter)} (${rows.length})</div>
    <div class="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table class="w-full min-w-[720px] text-sm">
        <thead class="border-b border-slate-100 bg-slate-50/70">
          <tr class="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <th class="px-4 py-2.5">Company</th>
            <th class="px-4 py-2.5 text-right">Holding %</th>
            <th class="px-4 py-2.5 text-right">Δ QoQ</th>
            <th class="px-4 py-2.5 text-right">Quantity</th>
            <th class="px-4 py-2.5 text-right">Value (derived)</th>
            <th class="px-4 py-2.5 text-right">% of book</th>
            <th class="px-4 py-2.5">Action</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-50">
          ${rows
            .map(
              (h) => `
            <tr class="hover:bg-slate-50/70">
              <td class="px-4 py-2.5">
                <div class="font-semibold text-slate-800">${escapeHtml(h.name)}</div>
                <div class="text-[10px] text-slate-400">${escapeHtml(h.ticker)} · ${escapeHtml(h.sector)}</div>
              </td>
              <td class="px-4 py-2.5 text-right font-bold tabular-nums text-slate-900">${h.holdingPct}%</td>
              <td class="px-4 py-2.5 text-right"><span class="text-xs font-semibold tabular-nums ${h.holdingPctDelta > 0 ? 'text-emerald-600' : h.holdingPctDelta < 0 ? 'text-rose-600' : 'text-slate-400'}">${h.holdingPctDelta === 0 ? '—' : `${signed(h.holdingPctDelta)}pp`}</span></td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-600">${formatNumber(h.qty)}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-slate-700">${formatCroreCompact(h.valueCr)}</td>
              <td class="px-4 py-2.5 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <span class="h-1.5 w-10 rounded-full bg-slate-100"><span class="block h-1.5 rounded-full bg-indigo-400" style="width:${Math.min(100, (h.valueCr / total) * 100)}%"></span></span>
                  <span class="w-9 text-right text-[11px] tabular-nums text-slate-500">${((h.valueCr / total) * 100).toFixed(1)}%</span>
                </div>
              </td>
              <td class="px-4 py-2.5">${actionPill(h.action)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

/** Sector allocation as a donut. Inline SVG — no chart library. */
function sectorDonut(holder) {
  const alloc = holder.sectorAllocation.slice(0, 8);
  if (!alloc.length) return '';
  const total = alloc.reduce((s, a) => s + a.valueCr, 0);
  const COLORS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#0ea5e9', '#06b6d4', '#14b8a6'];
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return `
    <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Sector allocation</div>
      <svg viewBox="0 0 140 140" class="mx-auto w-full max-w-[160px]" role="img" aria-label="Sector allocation">
        ${alloc
          .map((a, i) => {
            const frac = a.valueCr / total;
            const dash = `${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}`;
            const el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="22"
              stroke-dasharray="${dash}" stroke-dashoffset="${(-offset * C).toFixed(2)}" transform="rotate(-90 70 70)"><title>${escapeHtml(a.sector)} ${a.sharePct}%</title></circle>`;
            offset += frac;
            return el;
          })
          .join('')}
        <text x="70" y="66" text-anchor="middle" font-size="10" fill="#94a3b8">sectors</text>
        <text x="70" y="82" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${holder.sectorAllocation.length}</text>
      </svg>
      <div class="mt-3 space-y-1">
        ${alloc
          .map(
            (a, i) => `
          <div class="flex items-center gap-1.5 text-[11px]">
            <span class="h-2 w-2 flex-shrink-0 rounded-full" style="background:${COLORS[i % COLORS.length]}"></span>
            <span class="min-w-0 flex-1 truncate text-slate-600">${escapeHtml(a.sector)}</span>
            <span class="font-semibold tabular-nums text-slate-500">${a.sharePct}%</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function concentrationCard(holder, total) {
  const top5 = holder.latestHoldings.slice(0, 5);
  return `
    <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <div class="mb-1 flex items-baseline justify-between">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Concentration</span>
        <span class="text-sm"><strong class="text-slate-900">${holder.top5SharePct}%</strong> <span class="text-slate-500">in the top 5</span></span>
      </div>
      <div class="mb-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
        ${top5.map((h, i) => `<div class="h-3" style="width:${(h.valueCr / total) * 100}%;background:${['#4f46e5', '#7c3aed', '#a855f7', '#d946ef', '#ec4899'][i]}" title="${escapeHtml(h.name)} ${((h.valueCr / total) * 100).toFixed(1)}%"></div>`).join('')}
        <div class="h-3 flex-1 bg-slate-200" title="the other ${Math.max(0, holder.latestHoldings.length - 5)} holdings"></div>
      </div>
      <div class="space-y-1">
        ${top5
          .map(
            (h, i) => `
          <div class="flex items-center gap-2 text-[11px]">
            <span class="w-4 text-slate-400">${i + 1}</span>
            <span class="min-w-0 flex-1 truncate text-slate-700">${escapeHtml(h.name)}</span>
            <span class="tabular-nums text-slate-500">${h.holdingPct}%</span>
            <span class="w-16 text-right font-semibold tabular-nums text-slate-700">${formatCroreCompact(h.valueCr)}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function valueTrendCard(holder) {
  const series = holder.valueByQuarter;
  if (!series.length) return '';
  const max = Math.max(...series.map((s) => s.valueCr), 1);
  return `
    <div class="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <div class="mb-3 flex items-baseline justify-between">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Book value by quarter</span>
        <span class="text-[11px] text-slate-400">derived from holding % × market cap</span>
      </div>
      <div class="flex items-end gap-3" style="height:96px">
        ${series
          .map(
            (s, i) => `
          <div class="flex flex-1 flex-col items-center justify-end gap-1" style="height:100%">
            <span class="text-[10px] font-bold tabular-nums text-slate-600">${formatCroreCompact(s.valueCr)}</span>
            <div class="w-full rounded-t ${i === series.length - 1 ? 'bg-gradient-to-t from-indigo-500 to-purple-500' : 'bg-slate-200'}" style="height:${Math.max(3, (s.valueCr / max) * 68)}px"></div>
            <span class="text-[10px] text-slate-400">${escapeHtml(s.quarter)}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (b) ACTIVITY
// ---------------------------------------------------------------------------------------

function renderActivity(holder) {
  const a = investors.activity(holder);
  // Class strings are written out in full rather than interpolated — Tailwind only ships the
  // classes it can see literally, so `bg-${tone}-50` produces an unstyled chip.
  const blocks = [
    { key: 'newEntries', title: 'New entries', note: 'not held in the previous quarter', rows: a.newEntries, chip: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
    { key: 'adds', title: 'Added to', note: 'holding percentage increased', rows: a.adds, chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    { key: 'trims', title: 'Trimmed', note: 'holding percentage reduced', rows: a.trims, chip: 'bg-amber-50 text-amber-700 ring-amber-200' },
    { key: 'exits', title: 'Full exits', note: 'held last quarter, gone this quarter', rows: a.exits, chip: 'bg-rose-50 text-rose-700 ring-rose-200' },
  ];
  const any = blocks.some((b) => b.rows.length);

  return `
    ${attributionBanner(holder)}
    <div class="mb-4 flex flex-wrap items-center gap-2 text-xs">
      ${blocks
        .map(
          (b) => `<span class="rounded-full px-2.5 py-1 font-semibold ring-1 ${b.chip}">${b.rows.length} ${escapeHtml(b.title.toLowerCase())}</span>`
        )
        .join('')}
      <span class="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">${a.holds.length} unchanged</span>
    </div>

    ${
      any
        ? blocks
            .filter((b) => b.rows.length)
            .map(
              (b) => `
      <div class="mb-5">
        <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">${escapeHtml(b.title)} (${b.rows.length})</div>
        <div class="mb-2 text-[11px] text-slate-400">${escapeHtml(b.note)}</div>
        <div class="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
          <table class="w-full min-w-[600px] text-sm">
            <thead class="border-b border-slate-100 bg-slate-50/70">
              <tr class="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <th class="px-4 py-2">Company</th>
                <th class="px-4 py-2 text-right">Quantity Δ</th>
                <th class="px-4 py-2 text-right">Holding %</th>
                <th class="px-4 py-2 text-right">Δ QoQ</th>
                <th class="px-4 py-2 text-right">Value (derived)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-50">
              ${b.rows
                .map(
                  (h) => `
                <tr class="hover:bg-slate-50/70">
                  <td class="px-4 py-2">
                    <div class="font-semibold text-slate-800">${escapeHtml(h.name)}</div>
                    <div class="text-[10px] text-slate-400">${escapeHtml(h.ticker)} · ${escapeHtml(h.sector)}</div>
                  </td>
                  <td class="px-4 py-2 text-right">${qtyDelta(h.qtyDelta)}</td>
                  <td class="px-4 py-2 text-right font-bold tabular-nums text-slate-900">${h.holdingPct}%</td>
                  <td class="px-4 py-2 text-right"><span class="text-xs font-semibold tabular-nums ${h.holdingPctDelta > 0 ? 'text-emerald-600' : h.holdingPctDelta < 0 ? 'text-rose-600' : 'text-slate-400'}">${signed(h.holdingPctDelta)}pp</span></td>
                  <td class="px-4 py-2 text-right tabular-nums text-slate-700">${formatCroreCompact(h.valueCr)}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`
            )
            .join('')
        : '<div class="rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500 ring-1 ring-slate-200">No position changes this quarter — the whole book was held unchanged.</div>'
    }`;
}

// ---------------------------------------------------------------------------------------
// (c) HISTORY
// ---------------------------------------------------------------------------------------

function renderHistory(holder) {
  const quarters = holder.quarters; // newest first
  const tickers = [...holder.byTicker.keys()].sort((a, b) => {
    const av = holder.byTicker.get(a).find((h) => h.quarter === holder.latestQuarter)?.valueCr ?? 0;
    const bv = holder.byTicker.get(b).find((h) => h.quarter === holder.latestQuarter)?.valueCr ?? 0;
    return bv - av;
  });

  return `
    ${attributionBanner(holder)}
    <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Holding % by quarter</div>
    <div class="mb-3 text-[11px] text-slate-400">
      Every company the holder has appeared in across the tracked quarters. A dash means no disclosed position that quarter,
      which is not the same as a zero — it means they were not on the shareholder list at all.
    </div>
    <div class="scrollbar-thin overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table class="w-full min-w-[640px] text-sm">
        <thead class="bg-slate-50/70">
          <tr class="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <th class="sticky left-0 z-10 bg-slate-50 px-4 py-2.5 text-left">Company</th>
            ${quarters.map((q) => `<th class="px-3 py-2.5 text-right">${escapeHtml(q)}</th>`).join('')}
            <th class="px-4 py-2.5 text-right">Trend</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-50">
          ${tickers
            .map((t) => {
              const list = holder.byTicker.get(t);
              const first = list[0];
              const byQ = new Map(list.map((h) => [h.quarter, h]));
              const vals = quarters
                .slice()
                .reverse()
                .map((q) => byQ.get(q)?.holdingPct ?? 0);
              const trend = vals.at(-1) - vals[0];
              return `
              <tr class="group hover:bg-slate-50/70">
                <td class="sticky left-0 z-[1] bg-white px-4 py-2.5 group-hover:bg-slate-50">
                  <div class="font-semibold text-slate-800">${escapeHtml(first.name)}</div>
                  <div class="text-[10px] text-slate-400">${escapeHtml(t)}</div>
                </td>
                ${quarters
                  .map((q) => {
                    const h = byQ.get(q);
                    if (!h || h.holdingPct === 0) return '<td class="px-3 py-2.5 text-right text-xs text-slate-300">—</td>';
                    return `<td class="px-3 py-2.5 text-right"><span class="font-semibold tabular-nums text-slate-800">${h.holdingPct}%</span><span class="block text-[10px] tabular-nums ${h.holdingPctDelta > 0 ? 'text-emerald-600' : h.holdingPctDelta < 0 ? 'text-rose-600' : 'text-slate-300'}">${h.holdingPctDelta === 0 ? '—' : `${signed(h.holdingPctDelta)}`}</span></td>`;
                  })
                  .join('')}
                <td class="px-4 py-2.5 text-right"><span class="text-xs font-bold ${trend > 0 ? 'text-emerald-600' : trend < 0 ? 'text-rose-600' : 'text-slate-400'}">${trend > 0 ? '▲' : trend < 0 ? '▼' : '—'} ${signed(trend)}pp</span></td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (d) OVERLAP
// ---------------------------------------------------------------------------------------

function renderOverlap(holder) {
  const rows = investors.overlapFor(holder);
  if (!rows.length) {
    return `${attributionBanner(holder)}<div class="rounded-2xl bg-slate-50 p-10 text-center ring-1 ring-slate-200">
      <div class="text-3xl">🔍</div>
      <div class="font-display mt-2 text-lg font-bold text-slate-800">No overlap with other tracked holders</div>
      <div class="mx-auto mt-1 max-w-md text-sm text-slate-500">None of ${escapeHtml(holder.name)}'s positions are also held by anyone else in the tracked set this quarter.</div>
    </div>`;
  }

  return `
    ${attributionBanner(holder)}
    <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Shared positions (${rows.length})</div>
    <div class="mb-3 text-[11px] text-slate-400">
      Companies ${escapeHtml(holder.name)} holds that at least one other tracked holder also holds, most-crowded first.
      Click a co-holder to open their book.
    </div>
    <div class="space-y-2">
      ${rows
        .map(
          (r) => `
        <div class="rounded-2xl bg-white p-3 ring-1 ring-slate-200">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="text-sm font-bold text-slate-800">${escapeHtml(r.name)}</span>
            <span class="text-[10px] text-slate-400">${escapeHtml(r.ticker)}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">${r.others.length} other${r.others.length === 1 ? '' : 's'}</span>
            <span class="ml-auto text-xs text-slate-500">this holder <strong class="tabular-nums text-slate-800">${r.holdingPct}%</strong></span>
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${r.others
              .map(
                (o) => `
              <button data-open-holder="${escapeHtml(o.investorId)}"
                class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition-colors ${
                  o.type === 'institution' ? 'bg-purple-50 text-purple-700 ring-purple-200 hover:bg-purple-100' : 'bg-indigo-50 text-indigo-700 ring-indigo-200 hover:bg-indigo-100'
                }">
                ${escapeHtml(o.investor)} <span class="tabular-nums opacity-70">${o.holdingPct}%</span>
              </button>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

// ---------------------------------------------------------------------------------------

const RENDERERS = { portfolio: renderPortfolio, activity: renderActivity, history: renderHistory, overlap: renderOverlap };

const WIRERS = {
  overlap: (root) => {
    root.querySelectorAll('[data-open-holder]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const next = investors.byId(btn.dataset.openHolder);
        if (!next) return;
        // Re-open in place. The caller's onTabChange/onClose are re-supplied by the tab, which
        // owns the URL; see js/tabs/super-investors.js openHolder().
        openState?.onSwitch?.(next.investorId);
      })
    );
  },
};

export { selectWorkspaceTab };
