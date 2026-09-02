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

import { sectionHead, scoreTable, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { seriesChart, yieldCurveChart, exportChartPng } from '../ui/series-chart.js';
import * as series from '../data/series.js';

const VIEWS = {
  commodities: { label: 'Commodities', blurb: 'Energy, precious and industrial metals, agriculture and fertilisers — futures closes and the World Bank Pink Sheet.' },
  indices: { label: 'Global Indices', blurb: 'The US, European, Asian and Indian benchmarks, daily closes.' },
  currencies: { label: 'Currencies', blurb: 'USD/INR and the majors, daily closes.' },
  rates: { label: 'Rates & Bonds', blurb: 'Government-bond yields, the US corporate credit spread and RBI policy rates — a yield reports basis points, never a percentage return.' },
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
  if (!series.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}${loadingHtml()}`;
    series.load().then(() => {
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
  const idx = series.index();
  const view = viewOf(ctx);
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
