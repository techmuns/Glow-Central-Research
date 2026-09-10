// tabs/macro-research.js — MACRO RESEARCH: commodities, global equity indices, currencies and
// benchmark yields, every figure read from the stored series. GLOW-OWNED.
//
// A port of `src/pages/MacroResearch.tsx` from techmuns/GlowVentures onto this dashboard's kit.
// The rules travel with it:
//
//   • EVERY FIGURE COMES FROM A STORED SERIES, not a quote call. The returns table is the
//     harvester's, computed against the full stored history; this tab adds no number of its own.
//   • A SERIES THE SPEC ASKS FOR AND NOTHING SERVES IS NAMED, NOT DRAWN — the "not yet sourced"
//     list at the bottom carries the reason, never an illustrative number.
//   • FREQUENCIES OFFERED ARE THE INTERSECTION ACROSS THE OVERLAY. Comparing a daily index against
//     a monthly commodity, the finest HONEST shared view is monthly; the toggle offers only what
//     every chosen series can actually be resampled to.
//   • A YIELD IS NOT A PRICE. The 3Y/5Y/10Y/Max columns are CAGR for prices and absolute
//     basis-point change for yields, and the footnote says so.
//
// SCOPE DOES NOT APPLY HERE and the head says so: these are market-wide series, not per-company
// feeds, so the Portfolio / Watchlist / Universe toggle narrows nothing on this tab.
//
// ONE SUB-VIEW IS NOT A SERIES AT ALL. FPI Activity reads a capture of NSDL's own FPI Monitor
// (`js/data/fpi-activity.js`) and renders a fixed template table, so it takes none of the
// furniture above — no chart, no frequency, no range — and it carries its OWN description rather
// than the tab subtitle, because "computed from a stored daily series" is not true of it. It is
// here rather than on a tab of its own because a reader asking what foreign money did this week
// is asking a macro question, beside the rupee, the ten-year and the commodity complex.

import { sectionHead, scoreTable, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { seriesChart, yieldCurveChart, exportChartPng } from '../ui/series-chart.js';
import * as series from '../data/series.js';
import * as fpi from '../data/fpi-activity.js';

const VIEWS = {
  commodities: { label: 'Commodities', blurb: 'Energy, precious and industrial metals, agriculture and fertilisers — futures closes and the World Bank Pink Sheet.' },
  indices: { label: 'Global Indices', blurb: 'The US, European, Asian and Indian benchmarks, daily closes.' },
  currencies: { label: 'Currencies', blurb: 'USD/INR and the majors, daily closes.' },
  rates: { label: 'Rates & Bonds', blurb: 'Government-bond yields, the US corporate credit spread and RBI policy rates — a yield reports basis points, never a percentage return.' },
  // THE ONE VIEW ON THIS TAB THAT DOES NOT READ THE SERIES STORE. It reads a capture of NSDL's own
  // FPI Monitor instead, and it is a fixed template table rather than a chart over a series — so
  // `paint` hands it off whole rather than trying to fit it to the furniture above. See
  // `js/data/fpi-activity.js` for what is published and what is derived.
  fpi: {
    label: 'FPI Activity',
    // `standalone` REPLACES the tab subtitle rather than being appended to it. Every other view
    // here is "computed from a stored daily series" and this one is not a series at all, so
    // concatenating would put a provenance claim on the page that is false for the figures under
    // it — the one thing this tab's own rules forbid most plainly.
    standalone: true,
    blurb: 'What foreign portfolio investors bought and sold in Indian government securities, state development loans, corporate bonds and equities — by reporting day, month, financial year and calendar year, with the debt they hold now. Read from NSDL, the depository that publishes it.',
  },
};
const CHART_TYPES = [['line', 'Line'], ['area', 'Area'], ['bar', 'Bar'], ['scatter', 'Scatter']];
const MAX_COMPARE = 6;
const TENORS = [
  { id: 'us-3m', label: '3M', years: 0.25 },
  { id: 'us-5y', label: '5Y', years: 5 },
  { id: 'us-10y', label: '10Y', years: 10 },
  { id: 'us-30y', label: '30Y', years: 30 },
];

export const meta = {
  id: 'macro-research',
  title: 'Macro Research',
  subtitle: 'Historical prices, returns and comparison for commodities, global equity indices, currencies and benchmark yields — every figure computed from a stored daily series.',
  subviews: Object.entries(VIEWS).map(([id, v]) => ({ id, label: v.label })),
  // Scope does not apply here, so an EMPTY watchlist must not replace the tab with the shell's
  // "add companies" panel — the same opt-out Ask Research uses.
  allowEmptyScope: true,
};

// ---- state that survives repaints within the tab ------------------------------------------
let ctxRef = null;
let token = 0;
let disposers = [];
let chartDisposer = null;
let curveDisposer = null;
let selected = [];
let range = '5Y';
let chartType = 'line';
let freq = 'daily';
let tableView = null;
let table = null;
const points = new Map(); // `${id}@${range}` → [{ t, v }]

const release = () => {
  disposers.forEach((d) => d && d());
  disposers = [];
  chartDisposer?.();
  chartDisposer = null;
  curveDisposer?.();
  curveDisposer = null;
};

export function render(ctx) {
  ctxRef = ctx;
  const t = ++token;
  if (table?.view) tableView = table.view;
  release();
  applyParams(ctx.params || {});
  // Each sub-view waits on the store it actually reads. FPI Activity is not in the series store
  // and must not sit behind it: a reader who lands there should not pay for a manifest whose
  // every figure this view ignores, and the series store failing must not blank a view it does
  // not feed.
  const view = viewOf(ctx);
  const wanted = view === 'fpi' ? fpi : series;
  if (!wanted.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: VIEWS[view].standalone ? VIEWS[view].blurb : meta.subtitle })}${loadingHtml()}`;
    wanted.load().then(() => {
      if (t === token && ctxRef) paint(ctxRef);
    });
    return;
  }
  paint(ctx);
}

export function destroy() {
  token++;
  if (table?.view) tableView = table.view;
  release();
  table = null;
  ctxRef = null;
}

function applyParams(p) {
  if (typeof p.s === 'string' && p.s) selected = p.s.split(',').filter(Boolean).slice(0, MAX_COMPARE);
  if (series.RANGES.some((r) => r.key === p.range)) range = p.range;
  if (CHART_TYPES.some(([k]) => k === p.type)) chartType = p.type;
  if (['daily', 'weekly', 'monthly', 'quarterly', 'annual'].includes(p.freq)) freq = p.freq;
}

function writeParams() {
  if (!ctxRef?.setParamsQuiet) return;
  ctxRef.setParamsQuiet({ ...(ctxRef.params || {}), s: selected.join(','), range, type: chartType, freq });
}

const viewOf = (ctx) => (VIEWS[ctx.subview] ? ctx.subview : 'commodities');

function loadingHtml() {
  return `
    <div class="skeleton-shimmer mb-5 h-80 rounded-2xl bg-slate-100"></div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

const chip = (label, title = '', tone = 'neutral') => {
  const cls = tone === 'good' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tone === 'brand' ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
};
const btn = (attrs, label, active = false, title = '') =>
  `<button type="button" ${attrs} class="rounded-md px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${active ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;

// ---- the panel -------------------------------------------------------------------------------

function paint(ctx) {
  const view = viewOf(ctx);
  if (view === 'fpi') {
    paintFpi(ctx);
    return;
  }
  const idx = series.index();
  if (!idx) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: meta.title, description: meta.subtitle, meta: scopeNote() })}
      <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-base font-bold text-slate-900">The series store did not load</h3>
        <p class="mt-1.5 text-sm leading-relaxed text-slate-600">Every figure on this page is read from <code class="rounded bg-slate-100 px-1">public/data/series/index.json</code>, which is committed to the repository and served statically. If this persists the deployment is incomplete rather than the data being missing — nothing here depends on a live API or a token.</p>
      </div>`;
    return;
  }
  const rows = idx.series.filter((s) => s.category === view);
  const absent = (idx.absent || []).filter((s) => s.category === view);
  if (!rows.some((r) => selected.includes(r.id))) selected = rows.length ? [rows[0].id] : [];
  const chosen = idx.series.filter((s) => selected.includes(s.id));
  const freqOptions = freqOptionsFor(chosen);
  if (!freqOptions.includes(freq)) freq = freqOptions[0];
  const m = series.meta();
  const totalPoints = rows.reduce((n, r) => n + (r.count || 0), 0);
  const groups = [...new Set(rows.map((r) => r.group))];

  table = scoreTable({
    rows,
    key: (r) => r.id,
    watchKey: () => null,
    name: (r) => r.label,
    nameLabel: 'Series',
    sub: (r) => `${r.group} · ${r.unit} · ${r.source?.name || 'source unknown'}${r.accumulating ? ` · building · ${r.count}` : ''}${r.staleSince ? ` · stale since ${r.staleSince}` : ''}`,
    nameMaxPx: 280,
    columns: [
      { label: 'Last', get: (r) => series.fmtLevel(r.last_value, r.unit), align: 'right', sortable: true, sortValue: (r) => (Number.isFinite(r.last_value) ? r.last_value : -Infinity) },
      ...series.HORIZON_COLS.map((c) => ({
        label: `${c.label}${c.annualised ? '*' : ''}`,
        html: true,
        align: 'right',
        sortable: true,
        sortValue: (r) => (typeof r.returns?.[c.key] === 'number' ? r.returns[c.key] : -Infinity),
        get: (r) => returnCell(r, c),
      })),
      { label: '52W H', get: (r) => series.fmtLevel(r.high52, r.unit), align: 'right', sortable: true, sortValue: (r) => (Number.isFinite(r.high52) ? r.high52 : -Infinity) },
      { label: '52W L', get: (r) => series.fmtLevel(r.low52, r.unit), align: 'right', sortable: true, sortValue: (r) => (Number.isFinite(r.low52) ? r.low52 : -Infinity) },
    ],
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    filters: [{ label: 'Group', options: [{ value: 'all', label: 'All groups' }, ...groups.map((g) => ({ value: g, label: g }))], match: (r, v) => r.group === v }],
    searchable: (r) => `${r.label} ${r.group} ${r.source?.symbol || ''} ${r.source?.name || ''}`,
    onRowClick: (r) => toggle(r.id),
    rowClass: (r) => (selected.includes(r.id) ? 'bg-indigo-50/70' : ''),
    initialView: tableView,
    countNoun: 'series',
    emptyMessage: 'No series match your filters.',
    exportName: `glow-macro-${view}-${todayStamp()}`,
    onExport: (visible) => exportExcel(visible, view),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: `${meta.subtitle} ${VIEWS[view].blurb}`,
      meta: `${chip(`${formatNumber(rows.length)} live`, 'Series in this view with a stored history', 'good')}${chip(`${formatNumber(totalPoints)} observations`, 'Observations across the series in this view')}${scopeNote()}<button type="button" data-macro-info class="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" title="Where these figures come from">Sources ?</button>`,
    })}
    ${chartCard(chosen, freqOptions)}
    ${view === 'rates' ? curveCard() : ''}
    ${table.html}
    <p class="mt-3 rounded-2xl bg-white px-4 py-3 text-xs leading-relaxed text-slate-500 shadow-sm ring-1 ring-slate-100">
      <span class="font-semibold text-slate-600">*</span> 3Y/5Y/10Y/Max are annualised (CAGR); the shorter horizons are cumulative.
      <span class="font-semibold text-slate-600">Every horizon is independent</span> — a cell is <span class="font-mono">—</span> when the series does not reach back that far, never a shorter window relabelled.
      ${rows.some((r) => r.kind === 'yield') ? ' A <span class="font-semibold text-slate-600">yield</span> series reports the absolute change in <span class="font-semibold text-slate-600">basis points</span>, not a percentage return — the US 10-year going 0.5% to 4.3% is +380bp, and calling it "+760%" would be a category error.' : ''}
      ${rows.some((r) => r.accumulating) ? ' A row marked <span class="font-semibold text-slate-600">building</span> comes from a source that publishes only its current value — RBI’s policy rates and IEX’s day-ahead price have no downloadable history — so the store accumulates one observation per run and every horizon stays absent until it can answer one.' : ''}
      Click any row to chart it; click several to overlay them (up to ${MAX_COMPARE}).
    </p>
    ${absentCard(absent)}`;

  const d = table.wire(ctx.root);
  if (typeof d === 'function') disposers.push(d);
  wireControls(ctx);
  paintChart();
  if (view === 'rates') paintCurve(idx);
  void m;
}

function scopeNote() {
  return chip('Market-wide · scope does not apply', 'These are market series, not per-company feeds, so the Portfolio / Watchlist / Universe toggle narrows nothing here.');
}

function returnCell(r, c) {
  const v = r.returns?.[c.key];
  const span = r.spans?.[c.key];
  const title = span ? `${span[0]} → ${span[1]}` : 'Series does not reach back this far';
  return `<span class="tabular-nums ${series.returnTone(v)}" title="${escapeHtml(title)}">${escapeHtml(series.fmtReturn(v, r.kind))}</span>`;
}

function freqOptionsFor(chosen) {
  if (!chosen.length) return ['daily'];
  const sets = chosen.map((s) => new Set(series.availableFrequencies(s.frequency)));
  return ['daily', 'weekly', 'monthly', 'quarterly', 'annual'].filter((f) => sets.every((set) => set.has(f)));
}

function chartCard(chosen, freqOptions) {
  const one = chosen.length === 1 ? chosen[0] : null;
  return `
    <div class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-macro-chart-card>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="font-display text-base font-bold text-slate-900" data-chart-title>${escapeHtml(one ? one.label : `${chosen.length} series compared`)}</h3>
          <p class="mt-0.5 text-xs text-slate-500" data-chart-sub>${escapeHtml(one ? `${one.unit} · ${one.source?.name || ''} (${one.source?.symbol || ''}) · ${formatNumber(one.count)} closes from ${one.first}` : 'Click any row in the table below to add or remove a series from the overlay')}</p>
        </div>
        <div class="flex flex-wrap items-center gap-1.5" data-chart-controls>
          ${CHART_TYPES.map(([k, l]) => btn(`data-chart-type="${k}"`, l, chartType === k, `${l} chart`)).join('')}
          <span class="mx-1 h-4 w-px bg-slate-200"></span>
          ${freqOptions.length > 1 ? `<select data-freq class="rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200" title="Show the series at this frequency. Only frequencies coarser than or equal to the source's own are offered.">${freqOptions.map((f) => `<option value="${f}"${f === freq ? ' selected' : ''}>${series.FREQ_LABEL[f]}</option>`).join('')}</select><span class="mx-1 h-4 w-px bg-slate-200"></span>` : ''}
          ${series.RANGES.map((r) => btn(`data-range="${r.key}"`, r.label, range === r.key)).join('')}
        </div>
      </div>
      <div class="mt-3" data-chart-mount><div class="grid h-[320px] place-items-center text-xs text-slate-400">Loading observations…</div></div>
      <p class="mt-2 hidden text-[11px] leading-relaxed text-slate-500" data-freq-note></p>
      <div class="mt-2 flex flex-wrap gap-1.5" data-chart-chips>${chosen.map((s) => `<button type="button" data-chip-remove="${escapeHtml(s.id)}" class="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-800 ring-1 ring-indigo-200 hover:bg-indigo-100" title="Remove from the overlay">${escapeHtml(s.label)} ×</button>`).join('')}</div>
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        ${btn('data-export-png', 'Chart PNG', false, 'Download the chart as a PNG, with its title, unit, source and window drawn into the image')}
        ${btn('data-export-csv', 'CSV', false, 'Download exactly what the chart is drawing, at the frequency on screen')}
        ${btn('data-export-xlsx', 'Export Excel', false, 'The returns table for this view, plus a sheet of observations for every charted series')}
        <span class="text-[11px] text-slate-400" data-export-note></span>
      </div>
    </div>`;
}

function curveCard() {
  return `
    <div class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-curve-card>
      <h3 class="font-display text-base font-bold text-slate-900">US Treasury yield curve</h3>
      <p class="mt-0.5 text-xs text-slate-500">Maturity on the x-axis, today against a year earlier — drawn only from tenors the store holds.</p>
      <div class="mt-3" data-curve-mount><div class="grid h-[300px] place-items-center text-xs text-slate-400">Loading tenors…</div></div>
    </div>`;
}

function absentCard(absent) {
  if (!absent.length) return '';
  return `
    <div class="mt-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-macro-absent>
      <div class="flex items-center justify-between gap-2">
        <div>
          <h3 class="font-display text-base font-bold text-slate-900">Asked for by the spec, not yet sourced</h3>
          <p class="mt-0.5 text-xs text-slate-500">Named with the reason rather than shown as an illustrative number.</p>
        </div>
        ${chip(String(absent.length))}
      </div>
      <ul class="mt-3 space-y-2">
        ${absent.map((a) => `<li class="border-b border-slate-100 pb-2 last:border-0 last:pb-0"><div class="text-sm font-medium text-slate-700">${escapeHtml(a.label)} <span class="text-slate-400">· ${escapeHtml(a.group || '')}</span></div><div class="text-xs leading-relaxed text-slate-500">${escapeHtml(a.absent || '')}</div></li>`).join('')}
      </ul>
    </div>`;
}

// ---- FPI Activity ------------------------------------------------------------------------------
//
// A FIXED TEMPLATE TABLE, NOT A SCREENER, which is why it is hand-rolled rather than built from
// `scoreTable`. The kit models a record with columns — a company, a score, a date — that a reader
// compares down the column and narrows with a search. This is five instrument lines against eleven
// fixed windows: nothing to search, nothing to sort, no company to star, and a two-deep header
// grouping the windows that no screener column set can express. Same test as the news list in
// `js/tabs/market-news-view.js`: the row is not a record, so the kit is the wrong tool.
//
// What opting out of the kit does NOT opt out of, and is therefore done by hand here: every string
// escaped, the table scrolling inside its own container so the page never scrolls sideways, every
// `<th>` carrying a scope, and a null rendering as an em dash that says why.

const FPI_GROUPS = [
  { key: 'daily', label: 'Reporting day', tint: '' },
  { key: 'month', label: 'Month', tint: 'bg-slate-50' },
  { key: 'fy', label: 'Financial year', tint: '' },
  { key: 'cy', label: 'Calendar year', tint: 'bg-slate-50' },
  { key: 'outstanding', label: 'Held now', tint: 'bg-indigo-50/60' },
];

const fpiTitle = (asOn) =>
  `FPI activity in the Indian local-currency debt and equity market${asOn ? `, as reported for ${new Date(`${asOn}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}` : ''}`;

function fpiTableHtml(t) {
  const groups = FPI_GROUPS.map((g) => ({ ...g, cols: t.columns.filter((c) => c.group === g.key) })).filter((g) => g.cols.length);
  const cellFor = (row, i) => {
    const c = row.cells[i];
    const tone = row.total ? 'font-bold ' : '';
    const value = fpi.fmtCrore(c.value);
    return `<td class="whitespace-nowrap px-3 py-2 text-right tabular-nums ${tone}${c.value == null ? 'text-slate-300' : fpi.toneOf(c.value)}" title="${escapeHtml(c.note || '')}">${escapeHtml(value)}</td>`;
  };
  return `
    <div class="scrollbar-thin overflow-x-auto" data-fpi-scroll>
      <table class="w-full min-w-[880px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-slate-200">
            <th scope="col" class="sticky left-0 z-10 bg-white px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(t.currency)}</th>
            ${groups.map((g) => `<th scope="col" colspan="${g.cols.length}" class="${g.tint} border-l border-slate-100 px-3 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(g.label)}</th>`).join('')}
          </tr>
          <tr class="border-b-2 border-slate-200">
            <th scope="col" class="sticky left-0 z-10 bg-white px-3 pb-2 text-left text-xs font-semibold text-slate-700">Instrument</th>
            ${groups
              .map((g) =>
                g.cols
                  .map(
                    (c, i) =>
                      `<th scope="col" class="${g.tint} ${i === 0 ? 'border-l border-slate-100' : ''} whitespace-nowrap px-3 pb-2 text-right text-xs font-semibold text-slate-700"${c.partial ? ' title="This period has not closed — the figure is the period so far."' : ''}>${escapeHtml(c.label)}${c.partial ? '<span class="text-slate-400"> *</span>' : ''}</th>`,
                  )
                  .join(''),
              )
              .join('')}
          </tr>
        </thead>
        <tbody>
          ${t.rows
            .map(
              (r) => `
            <tr class="border-b border-slate-100 last:border-0 ${r.total ? 'bg-slate-50/70' : ''}">
              <th scope="row" class="sticky left-0 z-10 ${r.total ? 'bg-slate-50' : 'bg-white'} px-3 py-2 text-left align-top">
                <span class="block whitespace-nowrap text-sm ${r.total ? 'font-bold' : 'font-semibold'} text-slate-900">${escapeHtml(r.label)}</span>
                <span class="block text-[11px] font-normal text-slate-400">${escapeHtml(r.sub || '')}</span>
              </th>
              ${r.cells.map((_, i) => cellFor(r, i)).join('')}
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function paintFpi(ctx) {
  const t = fpi.activityTable();
  const m = fpi.meta();
  if (!t) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: meta.title, description: VIEWS.fpi.blurb, meta: scopeNote() })}
      <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-base font-bold text-slate-900">The FPI capture did not load</h3>
        <p class="mt-1.5 text-sm leading-relaxed text-slate-600">Every figure in this view is read from <code class="rounded bg-slate-100 px-1">public/data/fpi-activity.json</code>, which is committed to the repository and served statically. If this persists the deployment is incomplete rather than NSDL being unavailable — nothing here depends on a live API or a token.</p>
      </div>`;
    return;
  }
  const stale = m.asOn ? Math.floor((Date.now() - Date.parse(`${m.asOn}T00:00:00Z`)) / 86400000) : null;
  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: VIEWS.fpi.blurb,
      meta: `${chip(`NSDL · as on ${t.asOn}`, `NSDL's newest reporting date in this capture. Captured ${m.capturedAt || 'unknown'}.`, stale != null && stale <= 4 ? 'good' : 'neutral')}${scopeNote()}<button type="button" data-fpi-info class="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" title="What is published, what is derived, and where each figure comes from">Sources ?</button>`,
    })}
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(fpiTitle(t.asOn))}</h3>
      <p class="mt-0.5 text-xs text-slate-500">A figure in brackets is an outflow${t.flowsAsOn && t.flowsAsOn !== t.asOn ? ` · equity is reported to ${escapeHtml(t.flowsAsOn)}` : ''}</p>
      <div class="mt-3">${fpiTableHtml(t)}</div>
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        ${btn('data-fpi-csv', 'CSV', false, 'Download exactly this table')}
        ${btn('data-fpi-xlsx', 'Export Excel', false, 'This table, plus the published levels and daily net investment behind it')}
        <span class="text-[11px] text-slate-400" data-fpi-note></span>
      </div>
    </div>
    <p class="mt-3 rounded-2xl bg-white px-4 py-3 text-xs leading-relaxed text-slate-500 shadow-sm ring-1 ring-slate-100">
      <span class="font-semibold text-slate-600">The equity row is NSDL's own net investment</span>, published for each of these windows and reproduced unchanged — nothing on this page adds it up.
      <span class="font-semibold text-slate-600">The three debt rows are derived</span>: NSDL publish the outstanding investment foreign portfolio investors hold in each instrument on every reporting date, and the figure shown is the <span class="font-semibold text-slate-600">change in that holding</span> across the window. A maturity or a redemption moves it too, so it is close to net buying but is not the same statement.
      Debt is the <span class="font-semibold text-slate-600">general investment route</span>; the long-term investor category, the coupon re-investment limit, the voluntary retention route and the FAR route are separate limits with their own utilisation and are not folded in — adding two limits together would make a reallocation between them read as a purchase.
      <span class="font-semibold text-slate-600">Equity carries no outstanding figure</span> because these reports do not publish one, and a window whose opening level was not captured is an em dash naming the date, never a difference taken against an earlier one.
      ${t.columns.some((c) => c.partial) ? 'A period marked <span class="font-semibold text-slate-600">*</span> has not closed; its figure is the period so far. ' : ''}
      ${t.unmeasured.length ? `${escapeHtml(t.unmeasured.map((u) => `${u.column} needs the level for ${u.missing}`).join('; '))}. ` : ''}
      ${m.failed.length ? `${escapeHtml(String(m.failed.length))} read${m.failed.length === 1 ? '' : 's'} failed on the last capture; every retained record is unchanged.` : ''}
    </p>`;
  wireFpi(ctx, t);
}

function fpiRows(t) {
  return t.rows.map((r) => ({ label: r.label, basis: r.basis, values: r.cells.map((c) => c.value) }));
}

function exportFpiCsv(t) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [
    [`FPI activity — ${t.currency}. NSDL FPI Monitor, as on ${t.asOn}. Equity is NSDL's published net investment; the debt rows are the change in NSDL's published outstanding investment across each window, which is not the same measurement as net purchases. A blank cell is a window this capture cannot measure — not a zero.`],
    ['Instrument', 'Basis', ...t.columns.map((c) => `${c.label}${c.partial ? ' (period not closed)' : ''}`)],
    ...fpiRows(t).map((r) => [r.label, r.basis === 'debt' ? 'change in outstanding investment (derived)' : r.basis === 'equity' ? 'net investment (NSDL, published)' : 'sum of the rows above', ...r.values]),
  ];
  downloadText(lines.map((r) => r.map(esc).join(',')).join('\n'), `glow_fpi_activity_${t.asOn}_${todayStamp()}.csv`);
  return true;
}

async function exportFpiExcel(t) {
  const payload = fpi.index();
  const banner =
    `MEASURED, NOT OURS. NSDL FPI Monitor (https://www.fpi.nsdl.co.in/), captured ${fpi.meta().capturedAt || 'on an unknown date'}, newest reporting date ${t.asOn}. All figures in ${t.currency}. ` +
    'THE EQUITY ROW IS NSDL\'S OWN PUBLISHED NET INVESTMENT for each window, reproduced unchanged. THE DEBT ROWS ARE DERIVED: they are the change in NSDL\'s published outstanding investment between the opening and closing reporting date of each window, which a maturity or redemption also moves, and is therefore not the same measurement as net purchases. ' +
    'Debt is the general investment route only; the long-term investor category, coupon re-investment, VRR and FAR are separate limits and are not included. Equity has no outstanding figure because these reports do not publish one. A blank cell is a window that could not be measured — never a zero.';
  return exportSheets({
    filename: `glow-fpi-activity-${t.asOn}`,
    banner,
    sheets: [
      {
        name: 'FPI activity',
        columns: [
          { header: 'Instrument', key: 'label', width: 18, get: (r) => r.label },
          { header: 'Basis', key: 'basis', width: 38, get: (r) => (r.basis === 'debt' ? 'change in outstanding investment (derived)' : r.basis === 'equity' ? 'net investment (NSDL, published)' : 'sum of the rows above') },
          ...t.columns.map((c, i) => ({ header: `${c.label}${c.partial ? ' *' : ''}`, key: `c${i}`, width: 14, get: (r) => r.values[i] })),
        ],
        rows: fpiRows(t),
      },
      {
        name: 'Debt outstanding (NSDL)',
        columns: [
          { header: 'Reporting date', key: 'date', width: 14, get: (r) => r.date },
          { header: 'G-Sec — general route', key: 'gsec', width: 20, get: (r) => r.gsec },
          { header: 'SDLs — general route', key: 'sdl', width: 20, get: (r) => r.sdl },
          { header: 'Corp bonds — general route', key: 'corpBond', width: 24, get: (r) => r.corpBond },
          { header: 'G-Sec — VRR route', key: 'gsecVrr', width: 18, get: (r) => r.gsecVrr },
          { header: 'Corp bonds — VRR route', key: 'corpBondVrr', width: 22, get: (r) => r.corpBondVrr },
          { header: 'G-Sec — long-term category', key: 'gsecLongTerm', width: 24, get: (r) => r.gsecLongTerm },
          { header: 'Report layout', key: 'layout', width: 22, get: (r) => r.layout || '' },
        ],
        rows: payload?.levels || [],
      },
      {
        name: 'Daily net investment (NSDL)',
        columns: [
          { header: 'Reporting date', key: 'date', width: 14, get: (r) => r.date },
          { header: 'Equity', key: 'equity', width: 12, get: (r) => r.equity },
          { header: 'Debt — general limit', key: 'debtGeneral', width: 20, get: (r) => r.debtGeneral },
          { header: 'Debt — VRR', key: 'debtVrr', width: 14, get: (r) => r.debtVrr },
          { header: 'Debt — FAR', key: 'debtFar', width: 14, get: (r) => r.debtFar },
          { header: 'Hybrid', key: 'hybrid', width: 12, get: (r) => r.hybrid },
          { header: 'Mutual funds', key: 'mutualFunds', width: 14, get: (r) => r.mutualFunds },
          { header: 'AIFs', key: 'aifs', width: 10, get: (r) => r.aifs },
          { header: 'Total', key: 'total', width: 12, get: (r) => r.total },
        ],
        rows: payload?.dailyFlows || [],
      },
    ],
  });
}

function wireFpi(ctx, t) {
  const root = ctx.root;
  const say = (text) => {
    const el = root.querySelector('[data-fpi-note]');
    if (el) el.textContent = text;
  };
  const onClick = async (ev) => {
    const el = ev.target.closest('[data-fpi-info],[data-fpi-csv],[data-fpi-xlsx]');
    if (!el || !root.contains(el)) return;
    if (el.hasAttribute('data-fpi-info')) openModal(fpiProvenanceHtml(t), { size: 'wide' });
    else if (el.hasAttribute('data-fpi-csv')) say(exportFpiCsv(t) ? 'CSV downloaded.' : 'Nothing to export yet.');
    else {
      say('Building the workbook…');
      say((await exportFpiExcel(t)) ? 'Workbook downloaded.' : 'Export unavailable (the spreadsheet library could not be loaded).');
    }
  };
  root.addEventListener('click', onClick);
  disposers.push(() => root.removeEventListener('click', onClick));
}

function fpiProvenanceHtml(t) {
  const m = fpi.meta();
  const report = (label, url) => `<li><strong>${escapeHtml(label)}</strong> — <a class="text-indigo-700 underline" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></li>`;
  return `
    <div class="p-6">
      <h2 class="font-display text-lg font-bold text-slate-900">Where these figures come from</h2>
      <p class="mt-2 text-sm leading-relaxed text-slate-600"><strong>Measured, and not ours.</strong> Every figure in this view is read from NSDL's FPI Monitor — the depository that publishes India's foreign-portfolio-investment statistics — captured by <code class="rounded bg-slate-100 px-1">scripts/scrape-fpi-activity.mjs</code> and refreshed by <code class="rounded bg-slate-100 px-1">.github/workflows/fpi-activity-refresh.yml</code>. No credential is involved and nothing here is scored, ranked or judged.</p>
      <dl class="mt-4 grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl bg-slate-50 p-3"><dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Newest reporting date</dt><dd class="mt-1 text-sm text-slate-800">${escapeHtml(t.asOn || 'unknown')}${t.flowsAsOn && t.flowsAsOn !== t.asOn ? ` · equity to ${escapeHtml(t.flowsAsOn)}` : ''}</dd></div>
        <div class="rounded-xl bg-slate-50 p-3"><dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Captured</dt><dd class="mt-1 text-sm text-slate-800">${escapeHtml(m.capturedAt || 'unknown')}</dd></div>
      </dl>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">What is published, and what this view derives</h3>
      <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li><strong>Equity is published.</strong> NSDL print net investment in equity for the day, the month, the financial year and the calendar year. Every equity cell is one of their numbers; nothing is summed here.</li>
        <li><strong>Debt is derived, and it is one derivation.</strong> NSDL publish the <em>outstanding investment</em> held in each instrument on every reporting date. A window's figure is the change in that holding between its opening and closing reporting date. <strong>That is not the same measurement as net purchases</strong> — a maturity or a redemption moves it too.</li>
        <li><strong>Outstanding investment is published</strong>, as at the newest reporting date. Equity has none on these reports, so its cell is an em dash rather than a zero or a figure borrowed from elsewhere.</li>
        <li><strong>A window that cannot be measured has no number.</strong> Where the opening level has not been captured the cell is an em dash naming the missing date — it is never differenced against an earlier level, which would span sessions and read as one day's trading.</li>
        <li><strong>A total with a missing part is not a total.</strong> <em>Debt + Equity</em> is blank unless every row above it answered for that window.</li>
      </ul>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">Which limit the debt rows are</h3>
      <p class="mt-1 text-sm leading-relaxed text-slate-600">The <strong>general investment route</strong>, which is the line these reports are quoted on. The long-term investor category, the coupon re-investment limit, the voluntary retention route (VRR) and the fully accessible route (FAR) are <strong>separate limits with their own utilisation</strong> and are not added in: folding two limits together would make a reallocation between them read as a purchase. The VRR and long-term figures are captured alongside each level and are in the exported workbook.</p>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">The reports read</h3>
      <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
        ${report('Debt Utilisation Status — the outstanding holding, one file per reporting date', m.reports.debtOutstanding || 'https://www.fpi.nsdl.co.in/web/Reports/ReportDetail.aspx?RepID=1')}
        ${report('Daily Trends in FPI Investments — net investment by day', m.reports.dailyNetInvestment || 'https://www.fpi.nsdl.co.in/web/Reports/Monthly.aspx')}
        ${report('FPI Net Investment Details (Calendar Year) — by month and calendar year', m.reports.calendarYear || 'https://www.fpi.nsdl.co.in/web/Reports/Yearwise.aspx?RptType=6')}
        ${report('FPI Net Investment Details (Financial Year)', m.reports.financialYear || 'https://www.fpi.nsdl.co.in/web/Reports/Yearwise.aspx?RptType=5')}
      </ul>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">How the capture checks itself</h3>
      <p class="mt-1 text-sm leading-relaxed text-slate-600">NSDL publish both the daily net investment and the monthly total, so the capture <strong>adds up the days it holds and compares them to the published month</strong>; a month that does not reconcile is not claimed as complete, and the figure that ships is always the published one. The debt table's columns move between reporting dates under an unchanged header, so each row is aligned by the source's own published identity rather than by position — a layout it cannot align is reported rather than guessed at.</p>
      ${m.failed.length ? `<h3 class="font-display mt-5 text-sm font-bold text-slate-900">Failed on the last capture</h3><ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">${m.failed.map((f) => `<li><strong>${escapeHtml(f.what || 'a read')}</strong> — ${escapeHtml(f.message || f.reason || 'no reason given')}</li>`).join('')}</ul><p class="mt-1 text-xs text-slate-500">Every record captured before that run is unchanged.</p>` : ''}
      <p class="mt-4 text-xs text-slate-500">Files: <code class="rounded bg-slate-100 px-1">public/data/fpi-activity.json</code> · <code class="rounded bg-slate-100 px-1">scripts/lib/nsdl-fpi.mjs</code> · <code class="rounded bg-slate-100 px-1">scripts/scrape-fpi-activity.mjs</code> · <code class="rounded bg-slate-100 px-1">public/js/data/fpi-activity.js</code> · <code class="rounded bg-slate-100 px-1">public/js/tabs/macro-research.js</code>.</p>
    </div>`;
}

// ---- interaction -----------------------------------------------------------------------------

function wireControls(ctx) {
  const root = ctx.root;
  const onClick = async (ev) => {
    const el = ev.target.closest('[data-chart-type],[data-range],[data-chip-remove],[data-export-png],[data-export-csv],[data-export-xlsx],[data-macro-info]');
    if (!el || !root.contains(el)) return;
    if (el.hasAttribute('data-chart-type')) {
      chartType = el.getAttribute('data-chart-type');
      writeParams();
      refreshControls(root);
      paintChart();
    } else if (el.hasAttribute('data-range')) {
      range = el.getAttribute('data-range');
      writeParams();
      refreshControls(root);
      paintChart();
    } else if (el.hasAttribute('data-chip-remove')) {
      toggle(el.getAttribute('data-chip-remove'));
    } else if (el.hasAttribute('data-export-png')) {
      const ok = await exportPng(root);
      note(root, ok ? 'PNG downloaded.' : 'Nothing to export yet.');
    } else if (el.hasAttribute('data-export-csv')) {
      note(root, exportCsv() ? 'CSV downloaded.' : 'Nothing to export yet.');
    } else if (el.hasAttribute('data-export-xlsx')) {
      note(root, 'Building the workbook…');
      const ok = await exportExcel(table?.currentRows?.() || series.index().series.filter((s) => s.category === viewOf(ctx)), viewOf(ctx));
      note(root, ok ? 'Workbook downloaded.' : 'Export unavailable (the spreadsheet library could not be loaded).');
    } else if (el.hasAttribute('data-macro-info')) {
      openModal(provenanceHtml(), { size: 'wide' });
    }
  };
  const onChange = (ev) => {
    const el = ev.target.closest('[data-freq]');
    if (!el || !root.contains(el)) return;
    freq = el.value;
    writeParams();
    paintChart();
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  disposers.push(() => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
  });
}

function refreshControls(root) {
  root.querySelectorAll('[data-chart-type]').forEach((b) => setActive(b, b.getAttribute('data-chart-type') === chartType));
  root.querySelectorAll('[data-range]').forEach((b) => setActive(b, b.getAttribute('data-range') === range));
}
function setActive(b, on) {
  b.classList.toggle('bg-indigo-50', on);
  b.classList.toggle('text-indigo-800', on);
  b.classList.toggle('ring-indigo-200', on);
  b.classList.toggle('bg-white', !on);
  b.classList.toggle('text-slate-600', !on);
  b.classList.toggle('ring-slate-200', !on);
}
function note(root, text) {
  const el = root.querySelector('[data-export-note]');
  if (el) el.textContent = text;
}

function toggle(id) {
  const was = selected.includes(id);
  if (was) {
    if (selected.length > 1) selected = selected.filter((x) => x !== id);
  } else {
    selected = selected.length >= MAX_COMPARE ? [...selected.slice(1), id] : [...selected, id];
  }
  writeParams();
  // The whole chart card is re-drawn from state (title, chips, frequency options), the table row
  // is rebuilt in place so its highlight follows the selection without losing the reader's sort.
  if (ctxRef) {
    const idx = series.index();
    const chosen = idx.series.filter((s) => selected.includes(s.id));
    const freqOptions = freqOptionsFor(chosen);
    if (!freqOptions.includes(freq)) freq = freqOptions[0];
    const card = ctxRef.root.querySelector('[data-macro-chart-card]');
    if (card) {
      chartDisposer?.();
      chartDisposer = null;
      card.outerHTML = chartCard(chosen, freqOptions);
    }
    table?.updateRows?.(was ? [id] : selected);
    paintChart();
  }
}

// ---- the chart -------------------------------------------------------------------------------

async function ensurePoints(chosen) {
  const missing = chosen.filter((s) => !points.has(`${s.id}@${range}`));
  await Promise.all(
    missing.map(async (s) => {
      const pts = await series.fetchPoints(s, series.yearForRange(s, range));
      points.set(`${s.id}@${range}`, series.sliceRange(pts, s, range));
    }),
  );
}

function resampledSeries(chosen) {
  return chosen
    .map((s) => {
      const raw = points.get(`${s.id}@${range}`) ?? [];
      const r = series.resample(raw, s.frequency, freq);
      return { meta: s, points: r.points, lastBucketOpen: r.lastBucketOpen };
    })
    .filter((s) => s.points.length > 0);
}

async function paintChart() {
  const t = token;
  const idx = series.index();
  if (!idx || !ctxRef) return;
  const chosen = idx.series.filter((s) => selected.includes(s.id));
  await ensurePoints(chosen);
  if (t !== token || !ctxRef) return;
  const mount = ctxRef.root.querySelector('[data-chart-mount]');
  if (!mount) return;
  chartDisposer?.();
  chartDisposer = null;
  const drawn = resampledSeries(chosen);
  const chart = seriesChart({ series: drawn.map(({ meta: m, points: pts }) => ({ meta: m, points: pts })), type: chartType, height: 320 });
  mount.innerHTML = chart.empty ? '<div class="grid h-[320px] place-items-center text-xs text-slate-400">No observations in this window.</div>' : chart.html;
  if (!chart.empty) chartDisposer = chart.wire(mount);
  const noteEl = ctxRef.root.querySelector('[data-freq-note]');
  if (noteEl) {
    const anyOpen = drawn.some((s) => s.lastBucketOpen);
    noteEl.classList.toggle('hidden', freq === 'daily');
    noteEl.innerHTML = freq === 'daily' ? '' : `${escapeHtml(series.FREQ_LABEL[freq])} view — each point is the <span class="text-slate-600">last observation</span> in its period, which is what a period-end figure means. An average over the period would be a different measurement under the same label.${anyOpen ? ' The final point sits in a period that <span class="text-slate-600">has not closed yet</span>, so it is the latest reading rather than a period end.' : ''}`;
  }
}

async function paintCurve(idx) {
  const t = token;
  const available = TENORS.map((tn) => ({ ...tn, entry: idx.series.find((s) => s.id === tn.id) })).filter((tn) => tn.entry);
  const mount = ctxRef?.root.querySelector('[data-curve-mount]');
  if (!mount) return;
  if (!available.length) {
    mount.innerHTML = '<div class="rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><strong>No benchmark yields are stored.</strong> The curve is drawn from harvested Treasury tenors; none is in the series store, so there is nothing to plot.</div>';
    return;
  }
  const pairs = await Promise.all(available.map(async (tn) => [tn.id, await series.fetchPoints(tn.entry, new Date().getUTCFullYear() - 1)]));
  if (t !== token || !ctxRef) return;
  const pts = Object.fromEntries(pairs);
  const loaded = available.filter((tn) => (pts[tn.id] ?? []).length);
  if (!loaded.length) {
    mount.innerHTML = '<div class="rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><strong>The stored tenors carry no observations in this window.</strong></div>';
    return;
  }
  // THE CURVE CLOSES ON THE OLDEST OF THE TENORS' NEWEST DATES, so every point is from one day.
  const asOf = loaded.map((tn) => pts[tn.id][pts[tn.id].length - 1].t).sort()[0];
  const prior = series.shiftIso(asOf, 365);
  const rows = loaded.map((tn) => ({ label: tn.label, years: tn.years, now: series.lastAtOrBefore(pts[tn.id], asOf), then: series.lastAtOrBefore(pts[tn.id], prior) }));
  const y10 = rows.find((r) => r.label === '10Y')?.now ?? null;
  const m3 = rows.find((r) => r.label === '3M')?.now ?? null;
  const spread = y10 != null && m3 != null ? y10 - m3 : null;
  const missing = available.filter((tn) => !(pts[tn.id] ?? []).length).map((tn) => tn.label);
  const chart = yieldCurveChart({ rows, asOf, priorDate: prior, height: 300 });
  mount.innerHTML = `${chart.html}
    <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
      <span class="text-slate-600">10Y − 3M ${spread == null ? '<span class="text-slate-400">—</span>' : `<span class="font-semibold ${spread < 0 ? 'text-rose-700' : 'text-emerald-700'}">${spread >= 0 ? '+' : ''}${(spread * 100).toFixed(0)} bp</span>${spread < 0 ? ' <span class="text-rose-700">· inverted</span>' : ''}`}</span>
      <span class="text-slate-400">${rows.filter((r) => r.now != null).length} of ${TENORS.length} tenors stored</span>
    </div>
    <p class="mt-2 text-[11px] leading-relaxed text-slate-500">Built from the Treasury tenors in the series store, each read at its last observation <span class="text-slate-600">on or before ${escapeHtml(asOf)}</span> — tenors settle on slightly different days, and reading forward would put a later yield on this date's curve. The <span class="text-slate-600">2-year is not carried</span> by any series here, so the classic 10Y–2Y spread is not shown; the spread above is 10Y–3M and is labelled as that, because interpolating a 2-year off its neighbours would put a yield nobody quoted on a chart of quoted ones.${missing.length ? ` ${escapeHtml(missing.join(', '))} returned no observations in this window.` : ''}</p>`;
  curveDisposer?.();
  curveDisposer = chart.wire(mount);
}

// ---- exports ---------------------------------------------------------------------------------

function chartedNow() {
  const idx = series.index();
  if (!idx) return [];
  return resampledSeries(idx.series.filter((s) => selected.includes(s.id)));
}

function downloadText(text, filename, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`﻿${text}`], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCsv() {
  const drawn = chartedNow();
  if (!drawn.length) return false;
  const dates = [...new Set(drawn.flatMap((s) => s.points.map((p) => p.t)))].sort();
  const byId = drawn.map((s) => new Map(s.points.map((p) => [p.t, p.v])));
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ['date', ...drawn.map((s) => `${s.meta.label} (${s.meta.unit})`)];
  // A date a series has no observation for stays EMPTY, never 0.
  const lines = [header, ...dates.map((d) => [d, ...byId.map((m) => (m.has(d) ? m.get(d) : null))])].map((r) => r.map(esc).join(','));
  downloadText(lines.join('\n'), `glow_series_${freq}_${range}_${todayStamp()}.csv`);
  return true;
}

async function exportPng(root) {
  const drawn = chartedNow();
  if (!drawn.length) return false;
  const one = drawn.length === 1 ? drawn[0].meta : null;
  return exportChartPng(root.querySelector('[data-chart-mount]'), {
    title: one ? one.label : `${drawn.length} series compared`,
    subtitle: one ? `${one.unit} · ${one.source?.name || ''} (${one.source?.symbol || ''})` : drawn.map((s) => s.meta.label).join(' · '),
    footer: `${series.FREQ_LABEL[freq]} · ${range} window · from the committed series store (harvested ${series.meta().generatedAt || '—'}) · exported ${todayStamp()}`,
    filename: `glow_chart_${range}_${todayStamp()}.png`,
  });
}

async function exportExcel(rows, view) {
  const m = series.meta();
  const drawn = chartedNow();
  const banner = `MEASURED, NOT OURS. Series store harvested by the GlowVentures cockpit on ${m.generatedAt || 'an unknown date'} from Yahoo Finance, the World Bank, FRED, the RBI, IEX and AMFI. Every return and 52-week figure is the harvester's, computed on the full stored history; 3Y/5Y/10Y/Max are CAGR (basis points for yields); a blank cell is a horizon the series does not reach back to — not a zero. Observation sheets carry the ${drawn.length} charted series at the ${series.FREQ_LABEL[freq].toLowerCase()} frequency over the ${range} window.`;
  const used = new Set(['Returns']);
  const safeName = (s) => {
    const base = String(s).replace(/[\\/*?:[\]]/g, '-').slice(0, 28);
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base.slice(0, 26)}~${n++}`;
    used.add(name);
    return name;
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : null);
  return exportSheets({
    filename: `glow-macro-${view}-${todayStamp()}`,
    banner,
    sheets: [
      {
        name: 'Returns',
        columns: [
          { header: 'Series', key: 'label', width: 28, get: (r) => r.label },
          { header: 'Group', key: 'group', width: 18, get: (r) => r.group },
          { header: 'Unit', key: 'unit', width: 10, get: (r) => r.unit },
          { header: 'As of', key: 'last', width: 12, get: (r) => r.last },
          { header: 'Last', key: 'last_value', width: 12, get: (r) => num(r.last_value) },
          ...series.HORIZON_COLS.map((c) => ({ header: `${c.label}${c.annualised ? ' (CAGR)' : ''}${rows.some((r) => r.kind === 'yield') ? ' — pp for yields' : ''}`, key: c.key, width: 12, get: (r) => num(r.returns?.[c.key]) })),
          { header: '52W High', key: 'high52', width: 12, get: (r) => num(r.high52) },
          { header: '52W Low', key: 'low52', width: 12, get: (r) => num(r.low52) },
          { header: 'Kind', key: 'kind', width: 8, get: (r) => r.kind },
          { header: 'Frequency', key: 'frequency', width: 10, get: (r) => r.frequency },
          { header: 'Source', key: 'source', width: 22, get: (r) => r.source?.name || '' },
          { header: 'Symbol', key: 'symbol', width: 12, get: (r) => r.source?.symbol || '' },
          { header: 'Retrieved', key: 'retrievedAt', width: 22, get: (r) => r.retrievedAt || '' },
        ],
        rows,
      },
      ...drawn.map((s) => ({
        name: safeName(s.meta.label),
        columns: [
          { header: 'Date', key: 't', width: 14, get: (p) => p.t },
          { header: `Value (${s.meta.unit})`, key: 'v', width: 16, get: (p) => p.v },
        ],
        rows: s.points,
      })),
    ],
  });
}

// ---- provenance ------------------------------------------------------------------------------

function provenanceHtml() {
  const m = series.meta();
  const idx = series.index();
  const failed = idx?.failed || [];
  return `
    <div class="p-6">
      <h2 class="font-display text-lg font-bold text-slate-900">Where these figures come from</h2>
      <p class="mt-2 text-sm leading-relaxed text-slate-600"><strong>Measured, and not ours.</strong> Every figure on Macro Research and Economy &amp; Macro is read from a <em>series store</em> harvested nightly by the GlowVentures family-office cockpit (<code class="rounded bg-slate-100 px-1">npm run harvest</code> in that repository) and copied here each morning by <code class="rounded bg-slate-100 px-1">.github/workflows/series-refresh.yml</code>. This dashboard computes nothing from it: the returns table, the spans behind each cell, the 52-week range and the stale flags are the harvester's, computed against the full stored history with every horizon independent.</p>
      <dl class="mt-4 grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl bg-slate-50 p-3"><dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Harvested</dt><dd class="mt-1 text-sm text-slate-800">${escapeHtml(m.generatedAt || 'unknown')}</dd></div>
        <div class="rounded-xl bg-slate-50 p-3"><dt class="text-xs font-semibold uppercase tracking-wide text-slate-500">Series</dt><dd class="mt-1 text-sm text-slate-800">${formatNumber(m.live)} live · ${formatNumber(m.absent)} declared absent · ${formatNumber(m.failed)} failed on the last run</dd></div>
      </dl>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">Sources, by adapter</h3>
      <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li><strong>Yahoo Finance</strong> — anything with a futures contract, the equity indices, the FX pairs and the US Treasury tenors; daily closes, settled sessions only.</li>
        <li><strong>World Bank Pink Sheet</strong> — monthly commodity prices no free daily feed carries (thermal coal, LNG, iron ore, palm oil, the licensed LME metals, fertilisers).</li>
        <li><strong>World Bank API</strong> — annual growth, inflation, unemployment and government-debt series for India and the US.</li>
        <li><strong>FRED</strong> — the India 10-year (OECD, monthly) and the US corporate credit spread (ICE BofA OAS, a rolling three-year window because the family is licensed).</li>
        <li><strong>RBI, IEX</strong> — sources that publish only a current value; the store accumulates one observation per run and marks the row <em>building</em>.</li>
        <li><strong>AMFI</strong> — monthly mutual-fund AUM, flows and folios, read from the workbook AMFI publishes.</li>
      </ul>
      <h3 class="font-display mt-5 text-sm font-bold text-slate-900">What this tab does to the numbers, and says so</h3>
      <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>A <strong>range</strong> slices the stored observations; nothing is recomputed.</li>
        <li>A coarser <strong>frequency</strong> takes each period's <em>last</em> observation — a period end, never an average — and only frequencies every charted series can honestly be shown at are offered.</li>
        <li>Overlaying series in different units <strong>rebases each to 100</strong> at the start of the window, and the chart says so; a single series is always drawn at its level.</li>
        <li>A yield series reports the absolute change in <strong>basis points</strong>; 3Y/5Y/10Y/Max are CAGR for prices.</li>
        <li>A horizon the series cannot reach back to is an em dash, <strong>never a zero</strong> and never a shorter window relabelled.</li>
      </ul>
      ${failed.length ? `<h3 class="font-display mt-5 text-sm font-bold text-slate-900">Failed on the last harvest</h3><ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-600">${failed.map((f) => `<li><strong>${escapeHtml(f.label)}</strong> — ${escapeHtml(f.error || 'no reason given')}${f.kept ? ` (${formatNumber(f.kept)} stored observations kept)` : ''}</li>`).join('')}</ul>` : ''}
      <p class="mt-4 text-xs text-slate-500">Files: <code class="rounded bg-slate-100 px-1">public/data/series/index.json</code> (the manifest, with the returns) and <code class="rounded bg-slate-100 px-1">public/data/series/&lt;id&gt;/&lt;year&gt;.json</code> (daily observations, one file per calendar year) · <code class="rounded bg-slate-100 px-1">js/data/series.js</code> · <code class="rounded bg-slate-100 px-1">js/tabs/macro-research.js</code>.</p>
    </div>`;
}
