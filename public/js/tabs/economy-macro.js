// tabs/economy-macro.js — ECONOMY & MACRO INDICATORS: the release calendar, and the growth /
// inflation / labour / government / fixed-income / banking / housing / household / consumption /
// capital-market indicator grid, live where the series store answers a row. GLOW-OWNED.
//
// A port of `src/pages/Economy.tsx` and `src/components/EconomicCalendar.tsx` from
// techmuns/GlowVentures onto this dashboard's kit. The rules travel with it:
//
//   • THE LIVE ROWS COME FROM THE SERIES STORE, with their full history, so any of them charts. The
//     World Bank ones are ANNUAL and lagged; the observation year is printed on every figure. They
//     are RATES, so the change is in percentage points — a "return" on an inflation rate is the
//     same category error as one on a bond yield.
//   • A ROW WITHOUT A SERIES RENDERS ABSENT — an em dash with the reason — never a sample figure.
//     The upstream page used to print invented values ("Manufacturing PMI 58.1") and deleted the
//     field that carried them; here a row is a name plus a series that exists, or nothing.
//   • THE CALENDAR SHOWS previous · consensus · actual · surprise, with NO VERDICT on a surprise
//     (a CPI beat is bad news, a GDP beat is good, and nothing in the feed says which way an
//     indicator runs), NO FIGURE WITHOUT ITS UNIT, and NO INVENTED CLOCK for a day-only release.

import { sectionHead, scoreTable, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import { todayStamp } from '../ui/export.js';
import { seriesChart } from '../ui/series-chart.js';
import * as series from '../data/series.js';
import * as cal from '../data/econ-calendar.js';

export const meta = {
  id: 'economy-macro',
  title: 'Economy & Macro',
  subtitle: 'Growth, inflation, labour, government, fixed income, banking, housing, household, consumption and capital-market series — with the data release calendar.',
  subviews: [],
};

// `seriesId` maps a row to a harvested series. A row WITHOUT one renders absent.
const CATEGORIES = [
  { title: 'Economic growth', rows: [{ name: 'GDP growth (YoY)', seriesId: 'india-gdp-growth' }, { name: 'Industrial Production' }, { name: 'Manufacturing PMI' }, { name: 'Capacity Utilisation' }] },
  { title: 'Inflation', rows: [{ name: 'CPI (YoY)', seriesId: 'india-cpi' }, { name: 'Core CPI' }, { name: 'WPI' }, { name: 'Rural / Urban CPI' }] },
  { title: 'Labour market', rows: [{ name: 'Unemployment Rate', seriesId: 'india-unemployment' }, { name: 'Labour Participation' }, { name: 'US Non-Farm Payrolls' }, { name: 'Wage Growth' }] },
  { title: 'Government', rows: [{ name: 'Fiscal Deficit (% GDP)' }, { name: 'Govt Debt / GDP', seriesId: 'india-govt-debt-gdp' }, { name: 'GST Collections' }, { name: 'E-way Bills' }] },
  { title: 'Fixed income & credit', rows: [{ name: 'India 10Y', seriesId: 'india-10y' }, { name: 'US 10Y', seriesId: 'us-10y' }, { name: 'AAA Credit Spread' }, { name: 'Yield Curve (10Y–2Y)' }] },
  { title: 'Banking & policy', rows: [{ name: 'Repo Rate', seriesId: 'india-repo-rate' }, { name: 'Cash Reserve Ratio', seriesId: 'india-crr' }, { name: 'Statutory Liquidity Ratio', seriesId: 'india-slr' }, { name: 'Bank Rate', seriesId: 'india-bank-rate' }] },
  { title: 'Housing', rows: [{ name: 'House Price Index' }, { name: 'Affordability Index' }, { name: 'Registrations (MoM)' }, { name: 'Inventory (months)' }] },
  { title: 'Household', rows: [{ name: 'Household Debt / GDP' }, { name: 'Financial Savings' }, { name: 'Physical Savings' }, { name: 'Equity in Asset Mix' }] },
  { title: 'Consumption', rows: [{ name: 'Passenger Vehicles' }, { name: 'Two Wheelers' }, { name: 'Tractors' }, { name: 'FMCG Volumes' }] },
  {
    title: 'Capital markets',
    rows: [
      { name: 'Mutual Fund AUM', seriesId: 'india-mf-aum' }, { name: 'Mutual Fund Net Flows', seriesId: 'india-mf-net-flows' }, { name: 'Equity MF Flows', seriesId: 'india-mf-equity-flows' },
      { name: 'Debt MF Flows', seriesId: 'india-mf-debt-flows' }, { name: 'Gold ETF Flows', seriesId: 'india-etf-gold-flows' }, { name: 'Other ETF Flows', seriesId: 'india-etf-other-flows' },
      { name: 'Mutual Fund Folios', seriesId: 'india-mf-folios' }, { name: 'SIP Flows' }, { name: 'Demat Accounts' }, { name: 'F&O Turnover' },
    ],
  },
];

// ---- state ------------------------------------------------------------------------------------
let ctxRef = null;
let token = 0;
let disposers = [];
let chartDisposer = null;
let calTable = null;
let calTableView = null;
let calRange = 'week';
let countries = new Set(cal.DEFAULT_COUNTRIES);
let impacts = new Set(['high', 'medium']);
let categories = new Set(); // empty = every category
let calState; // undefined = loading · { ok:false } · { ok:true, events }
let calSeq = 0;
let charted = null;
const points = new Map();

const release = () => {
  disposers.forEach((d) => d && d());
  disposers = [];
  chartDisposer?.();
  chartDisposer = null;
};

export function render(ctx) {
  ctxRef = ctx;
  const t = ++token;
  if (calTable?.view) calTableView = calTable.view;
  release();
  if (!series.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}<div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
    series.load().then(() => {
      if (t === token && ctxRef) paint(ctxRef);
    });
    return;
  }
  paint(ctx);
}

export function destroy() {
  token++;
  if (calTable?.view) calTableView = calTable.view;
  release();
  calTable = null;
  ctxRef = null;
}

const chip = (label, title = '', tone = 'neutral') => {
  const cls = tone === 'good' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tone === 'warn' ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
};
const btn = (attrs, label, active = false, title = '') =>
  `<button type="button" ${attrs} class="rounded-md px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${active ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</button>`;
const DASH = '<span class="text-slate-300">—</span>';

/** A series value in its OWN unit and the source's own scale — AMFI publishes in crore and it stays in crore. */
function fmtByUnit(v, unit) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (unit === '%') return `${v.toFixed(1)}%`;
  if (unit === 'INR Cr') return `${Math.round(v).toLocaleString('en-IN')} Cr`;
  if (unit === 'count') return Math.round(v).toLocaleString('en-IN');
  return v.toFixed(1);
}

// ---- the panel -------------------------------------------------------------------------------

function paint(ctx) {
  const idx = series.index();
  const byId = new Map((idx?.series ?? []).map((s) => [s.id, s]));
  const liveCount = CATEGORIES.reduce((n, c) => n + c.rows.filter((r) => r.seriesId && byId.has(r.seriesId)).length, 0);
  const m = series.meta();

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Economy & Macro Indicators',
      description: meta.subtitle,
      meta: `${liveCount > 0 ? chip(`${liveCount} live · series store`, `Harvested ${m.generatedAt || 'unknown'}`, 'good') : chip('series store did not load', '', 'warn')}${chip('Market-wide · scope does not apply', 'These are national and market series, not per-company feeds, so the Portfolio / Watchlist / Universe toggle narrows nothing here.')}<button type="button" data-econ-info class="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" title="Where these figures come from">Sources ?</button>`,
    })}
    <div class="mb-5 rounded-2xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 shadow-sm ring-1 ring-slate-100">
      ${liveCount > 0
        ? `Growth, inflation, unemployment, government debt, the two 10-year yields, the RBI's policy rates and AMFI's mutual-fund figures are <span class="font-semibold text-emerald-700">live</span> from the harvested series store — each with its full history (India's CPI runs from 1960), so any of them can be charted by clicking the row. The World Bank series are <span class="font-semibold text-slate-700">annual</span> and lagged; the observation year is shown on every figure. The remaining rows come from Indian statistical sources with no API and are shown as absent until a source is wired — never as a sample number.`
        : `The series store did not load. Every live figure on this page is read from <code class="rounded bg-slate-100 px-1">public/data/series/</code>, which is committed and served statically — so this is a deployment problem rather than a missing feed. Every indicator row below is shown as absent until it loads.`}
    </div>
    ${calendarCard()}
    <div data-econ-chart class="mb-5 hidden"></div>
    <div class="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      ${CATEGORIES.map((c) => categoryCard(c, byId)).join('')}
    </div>`;

  wireControls(ctx);
  loadCalendar();
  if (charted) paintChart(byId.get(charted));
}

function categoryCard(c, byId) {
  const live = c.rows.filter((r) => r.seriesId && byId.has(r.seriesId)).length;
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-econ-category="${escapeHtml(c.title)}">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-display text-sm font-bold text-slate-900">${escapeHtml(c.title)}</h3>
        ${live > 0 ? chip(`${live} live`, '', 'good') : chip('not yet sourced', 'No free source wired here publishes these; shown as absent rather than as a sample figure.')}
      </div>
      <ul class="mt-2 space-y-1.5">
        ${c.rows
          .map((r) => {
            const e = r.seriesId ? byId.get(r.seriesId) : null;
            if (e) {
              const yoy = e.returns?.y1;
              return `<li>
                <button type="button" data-econ-row="${escapeHtml(e.id)}" class="flex w-full items-center justify-between gap-2 rounded-lg px-1.5 py-1 text-left text-sm transition hover:bg-slate-50 ${charted === e.id ? 'bg-indigo-50/70' : ''}" title="Chart ${escapeHtml(e.label)}">
                  <span class="text-slate-700">${escapeHtml(r.name)}</span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <span class="h-1.5 w-1.5 rounded-full bg-emerald-500" title="Live · ${escapeHtml(e.source?.name || '')} · ${escapeHtml(e.frequency || '')} · observation dated ${escapeHtml(e.last || '')}"></span>
                    <span class="tabular-nums font-semibold text-slate-900">${escapeHtml(fmtByUnit(e.last_value, e.unit))}</span>
                    <span class="text-[11px] tabular-nums ${series.returnTone(yoy)}" title="Change over one year, to ${escapeHtml(e.last || '')}">${escapeHtml(series.fmtReturn(yoy, e.kind))}</span>
                  </span>
                </button>
                <div class="px-1.5 text-[10px] text-slate-400">${escapeHtml(String(e.last || '').slice(0, 4))}${e.staleSince ? ' · source has not updated since' : ''}${e.accumulating ? ` · building · ${formatNumber(e.count)}` : ''}</div>
              </li>`;
            }
            return `<li class="flex items-center justify-between gap-2 px-1.5 text-sm"><span class="text-slate-500">${escapeHtml(r.name)}</span><span class="text-slate-300" title="No series in the harvest store answers ${escapeHtml(r.name)} — the spec asks for it and no free source wired here publishes it.">—</span></li>`;
          })
          .join('')}
      </ul>
    </div>`;
}

// ---- the calendar ----------------------------------------------------------------------------

function calendarCard() {
  return `
    <div class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-econ-calendar>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="font-display text-base font-bold text-slate-900">Data release calendar</h3>
          <p class="mt-0.5 text-xs text-slate-500">Previous · consensus · actual · surprise vs consensus</p>
        </div>
        <div data-cal-count></div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2" data-cal-filters>
        <div class="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">${cal.CAL_RANGES.map((r) => btn(`data-cal-range="${r.key}"`, r.label, calRange === r.key)).join('')}</div>
        ${multiSelect('country', 'countries', Object.keys(cal.COUNTRY_NAME), countries, (c) => cal.COUNTRY_NAME[c] ?? c)}
        <div class="inline-flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">${cal.IMPACTS.map((i) => btn(`data-impact="${i}"`, cal.IMPACT_LABEL[i], impacts.has(i), i === 'unranked' ? 'Releases the feed does not rank. Excluded by default rather than shown as low — an unranked event is not a minor one.' : `${cal.IMPACT_LABEL[i]}-impact releases`)).join('')}</div>
        <span data-cal-categories></span>
      </div>
      <div class="mt-3" data-cal-body><div class="grid h-32 place-items-center text-sm text-slate-400">Loading the release calendar…</div></div>
      <p class="mt-3 border-t border-dashed border-slate-200 pt-2.5 text-[11px] leading-relaxed text-slate-500">
        <span class="font-semibold text-slate-600">Times are your own local zone.</span> A release the source publishes without an announced time shows as <span class="font-mono">—</span> rather than being placed at an invented hour.
        <span class="font-semibold text-slate-600">Surprise</span> is actual less consensus and appears only where both are published — it carries a sign and no verdict, because whether a beat is good news depends on the indicator and nothing in this feed says which way round each one runs.
        <span class="font-semibold text-slate-600">Impact</span> is the feed's own ranking; an unranked release is shown as such rather than folded into "low". Every row names the agency that published it.
        <span data-cal-source></span>
      </p>
    </div>`;
}

/** A native <details> multi-select: no positioning code, keyboard-accessible, and it closes on outside click. */
function multiSelect(kind, noun, options, chosen, label) {
  const n = chosen.size;
  return `
    <details data-multi="${kind}" class="relative">
      <summary class="cursor-pointer list-none rounded-md bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">${n ? `${n} ${noun}` : `All ${noun}`} ▾</summary>
      <div class="absolute left-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl bg-white p-2 shadow-xl ring-1 ring-slate-200">
        <label class="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-slate-50"><input type="checkbox" data-multi-all="${kind}" ${n === 0 ? 'checked' : ''}> All ${noun}</label>
        ${options.map((o) => `<label class="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50"><input type="checkbox" data-multi-opt="${kind}" value="${escapeHtml(o)}" ${chosen.has(o) ? 'checked' : ''}> ${escapeHtml(label(o))}</label>`).join('')}
      </div>
    </details>`;
}

async function loadCalendar() {
  const seq = ++calSeq;
  const today = new Date();
  const [from, to] = (cal.CAL_RANGES.find((r) => r.key === calRange) ?? cal.CAL_RANGES[1]).of(today);
  calState = undefined;
  paintCalendar();
  const res = await cal.fetchCalendar(from, to, [...countries]);
  if (seq !== calSeq || !ctxRef) return;
  calState = { ...res, from, to };
  paintCalendar();
}

function filteredEvents() {
  const events = calState && calState.ok ? calState.events : [];
  return events.filter((e) => {
    if (impacts.size && !impacts.has(cal.impactOf(e.importance))) return false;
    if (categories.size && !categories.has(e.category ?? '')) return false;
    return true;
  });
}

function paintCalendar() {
  const root = ctxRef?.root;
  const body = root?.querySelector('[data-cal-body]');
  if (!body) return;
  const countEl = root.querySelector('[data-cal-count]');
  const catsEl = root.querySelector('[data-cal-categories]');
  const srcEl = root.querySelector('[data-cal-source]');
  if (calTable?.view) calTableView = calTable.view;
  calTable = null;
  if (calState === undefined) {
    body.innerHTML = '<div class="grid h-32 place-items-center text-sm text-slate-400">Loading the release calendar…</div>';
    countEl.innerHTML = '';
    return;
  }
  if (!calState.ok) {
    countEl.innerHTML = chip('calendar unavailable', '', 'warn');
    body.innerHTML = `
      <div class="rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
        <strong class="text-slate-800">The release calendar could not be fetched.</strong> ${escapeHtml(cal.calendarReason(calState))}
        ${calState.requestedUrl ? `<div class="mt-1 font-mono text-[11px] text-slate-500">${escapeHtml(calState.requestedUrl)}</div>` : ''}
        <div class="mt-1 text-xs text-slate-500">An empty window and a window we could not read must never look the same, so nothing is drawn.</div>
      </div>`;
    return;
  }
  const events = calState.events;
  const categoryOptions = [...new Set(events.map((e) => e.category ?? '').filter(Boolean))].sort((a, b) => cal.categoryLabel(a).localeCompare(cal.categoryLabel(b)));
  catsEl.innerHTML = categoryOptions.length ? multiSelect('category', 'categories', categoryOptions, categories, (c) => cal.categoryLabel(c)) : '';
  const rows = filteredEvents();
  countEl.innerHTML = chip(`${formatNumber(rows.length)} of ${formatNumber(calState.count)} shown`, `Releases between ${calState.from} and ${calState.to}`);
  srcEl.textContent = ` Source: ${calState.source}. Its forward horizon is about a month.`;

  const bands = [];
  if (calState.stale) bands.push(`The calendar feed did not respond, so this is the last saved copy${typeof calState.ageS === 'number' ? ` — fetched ${calState.ageS < 3600 ? `${Math.max(1, Math.round(calState.ageS / 60))}m` : `${Math.floor(calState.ageS / 3600)}h`} ago` : ''}. A schedule barely moves, but an <strong>actual</strong> that has landed since will not be in it.`);
  if (calState.truncated) bands.push('This window hit the feed’s per-request row limit, so it is <strong>incomplete</strong> — narrow the date range or the country list to see all of it.');
  if (calState.slicesFailed > 0) bands.push(`${calState.slicesFailed} of ${calState.slices} sub-requests failed, so part of this range is missing rather than empty.`);
  const bandHtml = bands.map((b) => `<div class="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">${b}</div>`).join('');

  if (!events.length) {
    body.innerHTML = `${bandHtml}<div class="rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><strong class="text-slate-800">No releases in this window.</strong> The feed carries no scheduled release between ${escapeHtml(calState.from)} and ${escapeHtml(calState.to)} for ${escapeHtml(countries.size ? [...countries].map((c) => cal.COUNTRY_NAME[c] ?? c).join(', ') : 'any country')}. Its forward horizon is about a month — beyond that no vendor here publishes a schedule.</div>`;
    return;
  }
  if (!rows.length) {
    body.innerHTML = `${bandHtml}<div class="rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><strong class="text-slate-800">Every release in this window is filtered out.</strong> ${formatNumber(events.length)} release${events.length === 1 ? '' : 's'} came back; the impact and category filters exclude all of them. Widen either to see them.</div>`;
    return;
  }

  const todayKey = cal.shiftDate(new Date(), 0);
  const dayLabel = (e) => {
    const d = cal.dayOf(e.date);
    const txt = new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return d === todayKey ? `${txt} · Today` : txt;
  };
  const val = (e, v) => cal.fmtEconValue(v, e.unit, e.currency);
  const impactDot = (i) => (i === 'high' ? 'bg-rose-500' : i === 'medium' ? 'bg-amber-500' : i === 'low' ? 'bg-slate-400' : 'bg-white ring-1 ring-slate-300');
  calTable = scoreTable({
    rows,
    key: (e) => e.id,
    watchKey: () => null,
    name: (e) => e.title,
    nameLabel: 'Event',
    sub: (e) => `${e.source || ''}${e.category ? `${e.source ? ' · ' : ''}${cal.categoryLabel(e.category)}` : ''}`,
    nameMaxPx: 360,
    nameAfter: 2,
    columns: [
      { label: 'Date', get: (e) => dayLabel(e), sortable: true, sortValue: (e) => Date.parse(e.date) },
      { label: 'Time', html: true, get: (e) => (cal.isDayOnly(e.date) ? `<span class="text-slate-300" title="The source publishes no time for this release, only a date.">—</span>` : `<span class="tabular-nums">${escapeHtml(cal.eventTime(e.date))}</span>`), sortable: false },
      { label: 'Country', html: true, get: (e) => { const i = cal.impactOf(e.importance); return `<span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full ${impactDot(i)}" title="${cal.IMPACT_LABEL[i]} impact"></span>${escapeHtml(cal.COUNTRY_NAME[e.country ?? ''] ?? e.country ?? '—')}</span>`; }, sortable: true, sortValue: (e) => e.country || '' },
      { label: 'Period', get: (e) => e.period ?? '—', sortable: false },
      { label: 'Actual', html: true, align: 'right', get: (e) => { const a = val(e, e.actual); return a == null ? `<span class="text-slate-300" title="Not published yet — this release is still ahead.">—</span>` : `<span class="tabular-nums font-semibold text-slate-900">${escapeHtml(a)}</span>`; }, sortable: true, sortValue: (e) => (e.actual == null ? -Infinity : e.actual) },
      { label: 'Consensus', html: true, align: 'right', get: (e) => { const f = val(e, e.forecast); return f == null ? `<span class="text-slate-300" title="No consensus is published for this release.">—</span>` : `<span class="tabular-nums">${escapeHtml(f)}</span>`; }, sortable: false },
      { label: 'Previous', html: true, align: 'right', get: (e) => { const p = val(e, e.previous); return p == null ? DASH : `<span class="tabular-nums">${escapeHtml(p)}</span>`; }, sortable: false },
      { label: 'Surprise', html: true, align: 'right', get: (e) => { const s = cal.surpriseOf(e); if (s == null) return `<span class="text-slate-300" title="${e.actual == null ? 'Not released yet.' : 'No consensus was published, so there is nothing to measure the surprise against.'}">—</span>`; return `<span class="tabular-nums font-medium text-slate-800" title="${cal.surpriseDirection(s)} consensus">${s > 0 ? '+' : ''}${escapeHtml(cal.fmtEconValue(s, e.unit, e.currency))}</span>`; }, sortable: true, sortValue: (e) => cal.surpriseOf(e) ?? -Infinity },
    ],
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    link: (e) => e.sourceUrl || null,
    searchable: (e) => `${e.title} ${e.country || ''} ${e.source || ''} ${cal.categoryLabel(e.category)}`,
    initialSort: { key: 'Date', dir: 'asc' },
    initialView: calTableView,
    countNoun: 'releases',
    emptyMessage: 'No releases match your filters.',
    exportName: `glow-release-calendar-${todayStamp()}`,
  });
  body.innerHTML = `${bandHtml}${calTable.html}`;
  const d = calTable.wire(body);
  if (typeof d === 'function') disposers.push(d);
}

// ---- interaction -----------------------------------------------------------------------------

function wireControls(ctx) {
  const root = ctx.root;
  const onClick = (ev) => {
    const el = ev.target.closest('[data-cal-range],[data-impact],[data-econ-row],[data-econ-close],[data-econ-info]');
    if (!el || !root.contains(el)) return;
    if (el.hasAttribute('data-cal-range')) {
      calRange = el.getAttribute('data-cal-range');
      root.querySelectorAll('[data-cal-range]').forEach((b) => setActive(b, b.getAttribute('data-cal-range') === calRange));
      loadCalendar();
    } else if (el.hasAttribute('data-impact')) {
      const i = el.getAttribute('data-impact');
      if (impacts.has(i)) impacts.delete(i);
      else impacts.add(i);
      setActive(el, impacts.has(i));
      paintCalendar();
    } else if (el.hasAttribute('data-econ-row')) {
      const id = el.getAttribute('data-econ-row');
      charted = charted === id ? null : id;
      root.querySelectorAll('[data-econ-row]').forEach((b) => b.classList.toggle('bg-indigo-50/70', b.getAttribute('data-econ-row') === charted));
      paintChart(charted ? series.byId(charted) : null);
    } else if (el.hasAttribute('data-econ-close')) {
      charted = null;
      root.querySelectorAll('[data-econ-row]').forEach((b) => b.classList.remove('bg-indigo-50/70'));
      paintChart(null);
    } else if (el.hasAttribute('data-econ-info')) {
      openModal(provenanceHtml(), { size: 'wide' });
    }
  };
  const onChange = (ev) => {
    const el = ev.target;
    if (!root.contains(el)) return;
    if (el.matches('[data-multi-all]')) {
      const kind = el.getAttribute('data-multi-all');
      const set = kind === 'country' ? countries : categories;
      set.clear();
      const box = el.closest('[data-multi]');
      box.querySelectorAll('[data-multi-opt]').forEach((o) => (o.checked = false));
      el.checked = true;
      box.querySelector('summary').textContent = `All ${kind === 'country' ? 'countries' : 'categories'} ▾`;
      if (kind === 'country') loadCalendar();
      else paintCalendar();
    } else if (el.matches('[data-multi-opt]')) {
      const kind = el.getAttribute('data-multi-opt');
      const set = kind === 'country' ? countries : categories;
      if (el.checked) set.add(el.value);
      else set.delete(el.value);
      const box = el.closest('[data-multi]');
      const all = box.querySelector('[data-multi-all]');
      if (all) all.checked = set.size === 0;
      box.querySelector('summary').textContent = `${set.size ? `${set.size} ${kind === 'country' ? 'countries' : 'categories'}` : `All ${kind === 'country' ? 'countries' : 'categories'}`} ▾`;
      if (kind === 'country') loadCalendar();
      else paintCalendar();
    }
  };
  // A <details> menu closes when the reader clicks anywhere else on the page.
  const onDocClick = (ev) => {
    root.querySelectorAll('details[data-multi][open]').forEach((d) => {
      if (!d.contains(ev.target)) d.removeAttribute('open');
    });
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  document.addEventListener('click', onDocClick);
  disposers.push(() => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    document.removeEventListener('click', onDocClick);
  });
}

function setActive(b, on) {
  b.classList.toggle('bg-indigo-50', on);
  b.classList.toggle('text-indigo-800', on);
  b.classList.toggle('ring-indigo-200', on);
  b.classList.toggle('bg-white', !on);
  b.classList.toggle('text-slate-600', !on);
  b.classList.toggle('ring-slate-200', !on);
}

// ---- the chart — opens when a live indicator row is clicked ----------------------------------
// A rate series is a BAR chart on purpose: consecutive annual rates are separate readings, and
// joining them with a line implies a path between two yearly figures that nothing measured.

async function paintChart(entry) {
  const t = token;
  const host = ctxRef?.root.querySelector('[data-econ-chart]');
  if (!host) return;
  chartDisposer?.();
  chartDisposer = null;
  if (!entry) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-econ-chart-card>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(entry.label)}</h3>
          <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(`${entry.unit} · ${entry.source?.name || ''} · ${formatNumber(entry.count)} ${entry.frequency} observations, ${String(entry.first || '').slice(0, 4)} to ${String(entry.last || '').slice(0, 4)}`)}</p>
        </div>
        ${btn('data-econ-close', 'Close')}
      </div>
      <div class="mt-3" data-econ-chart-mount><div class="grid h-[260px] place-items-center text-xs text-slate-400">Loading observations…</div></div>
      ${entry.staleSince ? `<p class="mt-2 text-[11px] leading-relaxed text-amber-800">The source has published nothing since ${escapeHtml(String(entry.staleSince).slice(0, 4))}. The figure shown is that year's reading, not an estimate of today.</p>` : ''}
    </div>`;
  if (!points.has(entry.id)) points.set(entry.id, await series.fetchPoints(entry));
  if (t !== token || !ctxRef || charted !== entry.id) return;
  const mount = host.querySelector('[data-econ-chart-mount]');
  const chart = seriesChart({ series: [{ meta: entry, points: points.get(entry.id) }], type: 'bar', height: 260 });
  mount.innerHTML = chart.empty ? '<div class="grid h-[260px] place-items-center text-xs text-slate-400">No observations stored.</div>' : chart.html;
  if (!chart.empty) chartDisposer = chart.wire(mount);
}

// ---- provenance ------------------------------------------------------------------------------

function provenanceHtml() {
  const m = series.meta();
  return `
    <div class="p-6">
      <h2 class="font-display text-lg font-bold text-slate-900">Where these figures come from</h2>
      <p class="mt-2 text-sm leading-relaxed text-slate-600"><strong>Two sources, both reproduced, neither ours.</strong></p>
      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The indicator grid — the series store</h3>
      <p class="mt-1 text-sm leading-relaxed text-slate-600">Each live row is a series harvested nightly by the GlowVentures family-office cockpit and copied here every morning (<code class="rounded bg-slate-100 px-1">.github/workflows/series-refresh.yml</code>) — last harvested <strong>${escapeHtml(m.generatedAt || 'unknown')}</strong>. The World Bank API supplies growth, inflation, unemployment and government debt (annual, lagged); FRED the India and US 10-year yields; the RBI its policy rates (a current value the store accumulates one run at a time); AMFI the mutual-fund AUM, flows and folio count. The year-on-year change is the harvester's one-year figure, in percentage points for a rate. A row with no series is shown as absent — <em>no sample figure is ever printed</em>.</p>
      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The release calendar — TradingView, through this Worker</h3>
      <p class="mt-1 text-sm leading-relaxed text-slate-600">Previous, consensus, actual, the period each reading is for, the unit, an importance rank and the <strong>agency that published it</strong>, read from TradingView's calendar endpoint by <code class="rounded bg-slate-100 px-1">GET /api/econ-calendar</code> (it needs Origin and Referer headers a browser cannot set, and no token). Every window is fetched in seven-day slices and merged on the event id because the upstream silently caps a response at 2,000 rows; a slice still at the cap is reported as <em>incomplete</em> above the table. Held at the edge for six hours, re-fetched after fifteen minutes; a feed that does not answer serves the last held copy marked stale.</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li><strong>Surprise</strong> is actual less consensus, only where both are published, with a sign and no verdict.</li>
        <li><strong>Impact</strong> is the feed's own rank (−1 / 0 / 1 → low / medium / high, verified against known-high events); an unranked release stays unranked.</li>
        <li>A release with no announced time is shown on the source's own date with no clock.</li>
      </ul>
      <p class="mt-4 text-xs text-slate-500">Files: <code class="rounded bg-slate-100 px-1">public/data/series/</code> · <code class="rounded bg-slate-100 px-1">js/data/series.js</code> · <code class="rounded bg-slate-100 px-1">js/data/econ-calendar.js</code> · <code class="rounded bg-slate-100 px-1">worker/econ-calendar.mjs</code> · <code class="rounded bg-slate-100 px-1">js/tabs/economy-macro.js</code>.</p>
    </div>`;
}
