// tabs/earnings-hub.js — quarterly results, scored.
//
// Built exactly as if the feed were live: a real 15-rule model, real filters, real drills.
// The FINANCIALS ARE SYNTHETIC and the tab says so everywhere it shows one — an amber ribbon
// at the top, "Mock data" on the freshness card, a banner in every drill, `mock` in the
// Sources modal, and a header row in the Excel export. When the filings feed is wired,
// data/earnings.js swaps its fetcher, `meta().isMock` goes false, and the markers disappear
// on their own. Nothing else here changes.
//
// The feed is loaded and scored ONCE by data/earnings.js and cached; the live poller
// re-scores in place on tick. Sub-view switches, scope changes, chips and sorts all operate
// on that cached list.

import { statStrip, topCards, scoreTable, sectionHead, roadmapStrip, openModal } from '../ui/screener.js';
import { legendStrip, avatarFor, scoreTier, tierColor, tierLabel } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatPct, formatDate, formatRelativeTime } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as earnings from '../data/earnings.js';
import { ACTIVE_RULES, TOTAL_MAX, earningsVals } from '../scoring/earnings-scoring.js';
import { openEarningsDrill, fmtPoints } from './earnings-drill.js';
import { SCANS, runScan, scanById, loadCustomScans, saveCustomScan, deleteCustomScan, describeCustom, matchesCustom } from './earnings-scans.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Quarterly results scored on a 15-rule quality and growth framework.',
  subviews: [
    { id: 'latest-results', label: 'Latest Results' },
    { id: 'result-scans', label: 'Result Scans' },
    { id: 'quality-growth', label: 'Quality & Growth' },
  ],
};

const FEATURES = [
  'Live filings feed replacing the illustrative data set',
  'Auto-parsed result PDFs (segment tables, management commentary)',
  'Consensus estimates from a live provider',
  'Score history per company across quarters',
  'Result-day alerts on saved scans',
  'Peer comparison within an industry',
];

let renderToken = 0;
let unsubscribeLive = null;
let liveRef = null;

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  const token = ++renderToken;
  cleanup();
  liveRef = ctx.live;
  ctx.root.innerHTML = loadingHtml();

  earnings
    .load()
    .then(() => {
      if (token !== renderToken) return;
      paint(ctx);
      startPoller(ctx, token);
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[earnings-hub] load failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The earnings data set could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load data/mock/earnings.json</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

// The poller re-reads and re-scores on tick. Today that is a mock cadence against a static
// file; the discipline (pause on hidden, backoff, clean unmount) is the same one the real
// feed will need.
function startPoller(ctx, token) {
  earnings.registerPoller(ctx.live, { intervalMs: 45000 });
  unsubscribeLive = earnings.subscribe(ctx.live, () => {
    if (token !== renderToken) return;
    paint(ctx); // re-scored in place; the view rebuilds from the fresh cache
  });
  ctx.live.start(earnings.LIVE_ID);
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  const rows = applyChipFilters(earnings.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []), ctx.params || {});
  const view =
    { 'latest-results': renderLatest, 'result-scans': renderScans, 'quality-growth': renderQualityGrowth }[ctx.subview] || renderLatest;
  view(ctx, rows);
}

export function destroy() {
  renderToken++;
  cleanup();
}

function cleanup() {
  if (unsubscribeLive) {
    unsubscribeLive();
    unsubscribeLive = null;
  }
  liveRef?.stop(earnings.LIVE_ID);
}

// ---------------------------------------------------------------------------------------
// Provenance markers — the honesty layer
// ---------------------------------------------------------------------------------------

function provenanceRibbon() {
  const m = earnings.meta();
  if (!m?.isMock) return '';
  return `
    <div class="mb-5 flex flex-wrap items-start gap-2 rounded-2xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200" data-mock-ribbon>
      <span class="flex-shrink-0 rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">Illustrative data</span>
      <span class="min-w-0 flex-1">
        Earnings figures are <strong>synthetic</strong> until the filings feed is wired. Company names, tickers and sectors are real.
        Generated by <code class="rounded bg-amber-100 px-1">${escapeHtml(m.generator || 'scripts/gen-mock-earnings.mjs')}</code>${
          m.seed != null ? ` with seed <code class="rounded bg-amber-100 px-1">${escapeHtml(m.seed)}</code>` : ''
        }.
      </span>
    </div>`;
}

// Never a fake filing time: the hero card states the generation date and says it is mock.
function freshnessCard() {
  const m = earnings.meta();
  if (m?.isMock) {
    return {
      hero: true,
      label: 'Last Refresh',
      value: 'Mock data',
      note: `Generated ${m.generated_at ? formatDate(m.generated_at) : '—'} · not a filing time`,
    };
  }
  return {
    hero: true,
    label: 'Last Refresh',
    value: m?.generated_at ? formatRelativeTime(m.generated_at) : '—',
    note: `${m?.source || 'Exchange filings'} · ${m?.quarter || ''}`,
  };
}

// ---------------------------------------------------------------------------------------
// Shared cell formatters + table config
// ---------------------------------------------------------------------------------------

const lastQ = (s) => (Array.isArray(s.company?.quarters) && s.company.quarters.length ? s.company.quarters.at(-1) : null);
const vals = (s) => earningsVals(s.company) || {};

const crore = (n) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')} Cr`);
function toneSpan(text, tone) {
  const cls = tone === 'pos' ? 'text-emerald-600' : tone === 'neg' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-600';
  return `<span class="font-semibold ${cls}">${text}</span>`;
}
function pctCell(v, { warnBelow = 0 } = {}) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  return toneSpan(`${v > 0 ? '+' : ''}${v.toFixed(1)}%`, v > warnBelow ? 'pos' : v < 0 ? 'neg' : 'warn');
}
function opmCell(s) {
  const q = lastQ(s);
  if (!q || q.opm == null) return '<span class="text-slate-300">—</span>';
  const d = vals(s).opmDelta;
  return `<span class="font-semibold text-slate-700">${q.opm.toFixed(1)}%</span>${
    d == null ? '' : ` <span class="text-[11px] ${d >= 0 ? 'text-emerald-600' : 'text-rose-600'}">${d > 0 ? '+' : ''}${Math.round(d * 100)}bps</span>`
  }`;
}
function tagPill(s) {
  const v = vals(s);
  if (v.epsSurprise == null) return '<span class="text-slate-300">—</span>';
  const [label, cls] =
    v.epsSurprise > 1
      ? ['Beat', 'bg-emerald-50 text-emerald-700 ring-emerald-200']
      : v.epsSurprise < -1
        ? ['Miss', 'bg-rose-50 text-rose-700 ring-rose-200']
        : ['In-line', 'bg-slate-100 text-slate-600 ring-slate-200'];
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${label}</span>`;
}
export function resultTag(s) {
  const v = earningsVals(s.company);
  if (!v || v.epsSurprise == null) return 'n/a';
  return v.epsSurprise > 1 ? 'Beat' : v.epsSurprise < -1 ? 'Miss' : 'In-line';
}

const scoreOf = (s) => ({
  points: fmtPoints(s.totalPoints),
  max: s.totalMax,
  pct: s.scorePct,
  redFlag: s.hardFails.length ? s.hardFails.join(', ') : null,
});
const signalsOf = (s) => s.breakdown.map((b) => ({ label: `${b.label} (${fmtPoints(b.points)}/${b.max})`, status: b.status }));

const tableBase = (rows) => ({
  rows,
  key: (s) => s.company.ticker,
  name: (s) => s.company.name || s.company.ticker,
  sub: (s) => [s.company.ticker, s.company.sector].filter(Boolean).join(' · '),
  link: (s) => s.company.screenerUrl || null,
  searchable: (s) => `${s.company.name} ${s.company.ticker} ${s.company.sector || ''}`,
  onRowClick: openEarningsDrill,
  emptyMessage: 'No results match your filters.',
});

const RESULT_COLUMNS = [
  { label: 'Quarter', get: (s) => s.company.quarter || '—' },
  { label: 'Reported', get: (s) => (s.company.reportedOn ? formatDate(s.company.reportedOn) : '—'), sortValue: (s) => (s.company.reportedOn ? new Date(s.company.reportedOn).getTime() : 0) },
  { label: 'Revenue', get: (s) => crore(lastQ(s)?.revenue), align: 'right', sortValue: (s) => lastQ(s)?.revenue ?? -1 },
  { label: 'Rev YoY', get: (s) => pctCell(vals(s).revYoY), html: true, align: 'right', sortValue: (s) => vals(s).revYoY ?? -999 },
  { label: 'PAT', get: (s) => { const q = lastQ(s); return q?.netProfit == null ? '—' : toneSpan(crore(q.netProfit), q.netProfit < 0 ? 'neg' : null); }, html: true, align: 'right', sortValue: (s) => lastQ(s)?.netProfit ?? -1e9 },
  { label: 'PAT YoY', get: (s) => pctCell(vals(s).patYoY), html: true, align: 'right', sortValue: (s) => vals(s).patYoY ?? -999 },
  { label: 'OPM', get: (s) => opmCell(s), html: true, align: 'right', sortValue: (s) => lastQ(s)?.opm ?? -999 },
  { label: 'Surprise', get: (s) => pctCell(vals(s).epsSurprise, { warnBelow: 1 }), html: true, align: 'right', sortValue: (s) => vals(s).epsSurprise ?? -999 },
  { label: 'Tag', get: (s) => tagPill(s), html: true, sortValue: (s) => resultTag(s) },
];

const SCORE_FILTER = {
  options: [
    { value: 'all', label: 'All scores' },
    { value: 'excellent', label: 'Excellent (80%+)' },
    { value: 'good', label: 'Good (60–80%)' },
    { value: 'average', label: 'Average (40–60%)' },
    { value: 'weak', label: 'Weak (<40%)' },
    { value: 'loss', label: '⚠ Loss-making' },
  ],
  match: (s, v) => {
    if (v === 'loss') return s.hardFails.length > 0;
    if (s.tickerError) return false;
    const p = s.scorePct;
    if (v === 'excellent') return p >= 80;
    if (v === 'good') return p >= 60 && p < 80;
    if (v === 'average') return p >= 40 && p < 60;
    if (v === 'weak') return p < 40;
    return true;
  },
};

// ---------------------------------------------------------------------------------------
// Chip filters — quarter · sector · beat/miss · loss-making · exceptional items
// ---------------------------------------------------------------------------------------

function chipGroups(rows) {
  const sectors = [...new Set(rows.map((s) => s.company.sector).filter(Boolean))].sort();
  const quarters = [...new Set(rows.map((s) => s.company.quarter).filter(Boolean))].sort();
  return {
    quarter: {
      param: 'q',
      label: 'Quarter',
      options: [{ id: 'any', label: 'Any' }, ...quarters.map((q) => ({ id: q, label: q }))],
      test: (s, ids) => ids[0] === 'any' || ids.includes(s.company.quarter),
    },
    sector: {
      param: 'sec',
      label: 'Sector',
      options: [{ id: 'any', label: 'All sectors' }, ...sectors.slice(0, 8).map((x) => ({ id: x, label: x.length > 22 ? `${x.slice(0, 20)}…` : x }))],
      test: (s, ids) => ids[0] === 'any' || ids.includes(s.company.sector),
    },
    outcome: {
      param: 'tag',
      label: 'Result',
      options: [
        { id: 'any', label: 'Any' },
        { id: 'Beat', label: 'Beat' },
        { id: 'In-line', label: 'In-line' },
        { id: 'Miss', label: 'Miss' },
      ],
      test: (s, ids) => ids[0] === 'any' || ids.includes(resultTag(s)),
    },
    flags: {
      param: 'flag',
      label: 'Flags',
      options: [
        { id: 'any', label: 'No filter' },
        { id: 'loss', label: 'Loss-making' },
        { id: 'exceptional', label: 'Has exceptional items' },
      ],
      test: (s, ids) => {
        if (ids[0] === 'any') return true;
        if (ids[0] === 'loss') return s.hardFails.length > 0;
        return vals(s).hasExceptional === true;
      },
    },
  };
}
const CHIP_DEFAULTS = { q: 'any', sec: 'any', tag: 'any', flag: 'any' };

function readChipState(params) {
  const out = {};
  for (const [k, def] of Object.entries(CHIP_DEFAULTS)) {
    const raw = params[k];
    out[k] = raw == null || raw === '' ? [def] : String(raw).split(',');
  }
  return out;
}

function applyChipFilters(rows, params) {
  const state = readChipState(params);
  const groups = chipGroups(rows);
  // A named result-scan replaces the chip filters rather than stacking with them.
  if (params.scan) return rows;
  return rows.filter((s) => Object.values(groups).every((g) => g.test(s, state[g.param])));
}

function chipBarHtml(allRows, params) {
  const state = readChipState(params);
  const groups = chipGroups(allRows);
  return `
    <div class="mb-5 space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-chip-bar>
      ${Object.entries(groups)
        .map(([key, g]) => {
          return `
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(g.label)}</span>
            ${g.options
              .map((o) => {
                const active = state[g.param].includes(o.id);
                // Live count: how many rows survive if this chip alone changes.
                const trial = { ...state, [g.param]: [o.id] };
                const n = allRows.filter((s) => Object.values(groups).every((g2) => g2.test(s, trial[g2.param]))).length;
                return `<button type="button" data-chip-group="${escapeHtml(key)}" data-chip-id="${escapeHtml(o.id)}"
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }">
                  <span>${escapeHtml(o.label)}</span>
                  <span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>
                </button>`;
              })
              .join('')}
          </div>`;
        })
        .join('')}
    </div>`;
}

function wireChipBar(ctx, root) {
  const bar = root.querySelector('[data-chip-bar]');
  if (!bar) return;
  const groups = chipGroups(earnings.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []));
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chip-id]');
    if (!btn) return;
    const g = groups[btn.dataset.chipGroup];
    ctx.setParams({ ...(ctx.params || {}), [g.param]: btn.dataset.chipId });
  });
}

// ---------------------------------------------------------------------------------------
// Excel export — two sheets: scores + all rules, and the 8-quarter series
// ---------------------------------------------------------------------------------------

function runExport(visibleRows, filename) {
  const rows = visibleRows.filter((s) => s.company && !s.tickerError);
  const m = earnings.meta();
  const banner = m?.isMock
    ? 'ILLUSTRATIVE DATA — company names, tickers and sectors are real; every financial figure is synthetic (scripts/gen-mock-earnings.mjs). Not reported numbers.'
    : `Source: ${m?.source || 'Exchange filings'} · generated ${m?.generated_at || ''}`;

  const scoreColumns = [
    { header: 'Company', key: 'name', width: 30, get: (s) => s.company.name || '' },
    { header: 'Ticker', key: 'ticker', width: 14, get: (s) => s.company.ticker || '' },
    { header: 'Sector', key: 'sector', width: 26, get: (s) => s.company.sector || '' },
    { header: 'Quarter', key: 'quarter', width: 10, get: (s) => s.company.quarter || '' },
    { header: 'Reported on', key: 'reported', width: 13, get: (s) => s.company.reportedOn || '' },
    { header: 'Score', key: 'score', width: 9, get: (s) => s.totalPoints },
    { header: 'Max', key: 'max', width: 7, get: (s) => s.totalMax },
    { header: 'Score %', key: 'pct', width: 9, get: (s) => s.scorePct },
    { header: 'Tier', key: 'tier', width: 12, get: (s) => (s.hardFails.length ? 'Loss-making' : tierLabel(scoreTier(s.scorePct))) },
    { header: 'Red flag', key: 'flag', width: 22, get: (s) => s.hardFails.join('; ') },
    ...ACTIVE_RULES.map((r) => ({
      header: `${r.label} (/${r.fn({}).max})`,
      key: `rule_${r.key}`,
      width: 18,
      get: (s) => s.breakdown.find((b) => b.key === r.key)?.points ?? null,
    })),
    { header: 'Revenue', key: 'rev', width: 14, get: (s) => lastQ(s)?.revenue ?? null },
    { header: 'Rev YoY %', key: 'revyoy', width: 12, get: (s) => round2(vals(s).revYoY) },
    { header: 'PAT', key: 'pat', width: 14, get: (s) => lastQ(s)?.netProfit ?? null },
    { header: 'PAT YoY %', key: 'patyoy', width: 12, get: (s) => round2(vals(s).patYoY) },
    { header: 'OPM %', key: 'opm', width: 10, get: (s) => lastQ(s)?.opm ?? null },
    { header: 'OPM Δ bps', key: 'opmd', width: 12, get: (s) => (vals(s).opmDelta == null ? null : Math.round(vals(s).opmDelta * 100)) },
    { header: 'EPS', key: 'eps', width: 10, get: (s) => lastQ(s)?.eps ?? null },
    { header: 'EPS consensus', key: 'epsc', width: 14, get: (s) => s.company.consensus?.eps ?? null },
    { header: 'EPS surprise %', key: 'epss', width: 14, get: (s) => round2(vals(s).epsSurprise) },
  ];

  // Long-form series: one row per company per quarter.
  const seriesRows = [];
  for (const s of rows) {
    for (const q of s.company.quarters || []) {
      seriesRows.push({ s, q });
    }
  }
  const seriesColumns = [
    { header: 'Company', key: 'name', width: 30, get: (r) => r.s.company.name || '' },
    { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.s.company.ticker || '' },
    { header: 'Quarter', key: 'quarter', width: 10, get: (r) => r.q.quarter },
    { header: 'Revenue', key: 'revenue', width: 14, get: (r) => r.q.revenue },
    { header: 'Operating profit', key: 'op', width: 16, get: (r) => r.q.operatingProfit },
    { header: 'OPM %', key: 'opm', width: 10, get: (r) => r.q.opm },
    { header: 'Net profit', key: 'pat', width: 14, get: (r) => r.q.netProfit },
    { header: 'NPM %', key: 'npm', width: 10, get: (r) => r.q.npm },
    { header: 'EPS', key: 'eps', width: 10, get: (r) => r.q.eps },
    { header: 'Other income', key: 'oi', width: 14, get: (r) => r.q.otherIncome },
    { header: 'PBT', key: 'pbt', width: 14, get: (r) => r.q.pbt },
    { header: 'Tax expense', key: 'tax', width: 14, get: (r) => r.q.taxExpense },
    { header: 'Exceptional items', key: 'exc', width: 17, get: (r) => r.q.exceptionalItems },
  ];

  exportSheets({
    filename,
    banner,
    sheets: [
      { name: 'Scores', columns: scoreColumns, rows },
      { name: 'Quarterly series', columns: seriesColumns, rows: seriesRows },
    ],
  }).then((ok) => {
    if (!ok) console.warn('[earnings-hub] export did not complete — exceljs unavailable.');
  });
}
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ---------------------------------------------------------------------------------------
// (a) LATEST RESULTS
// ---------------------------------------------------------------------------------------

function renderLatest(ctx, rows) {
  const allScoped = earnings.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);
  const scored = rows.filter((s) => !s.tickerError);
  const beats = scored.filter((s) => resultTag(s) === 'Beat').length;
  const misses = scored.filter((s) => resultTag(s) === 'Miss').length;
  const surprises = scored.map((s) => vals(s).epsSurprise).filter((v) => v != null);
  const avgSurprise = surprises.length ? surprises.reduce((a, b) => a + b, 0) / surprises.length : null;
  const newest = scored
    .filter((s) => s.company.reportedOn)
    .slice()
    .sort((a, b) => new Date(b.company.reportedOn) - new Date(a.company.reportedOn))[0];

  const stats = statStrip([
    { label: 'Results this season', value: formatNumber(rows.length), note: earnings.meta()?.quarter || 'latest quarter' },
    { label: 'Beats vs Misses', value: `${beats} / ${misses}`, note: `${scored.length - beats - misses} in-line` },
    {
      label: 'Avg EPS surprise',
      value: avgSurprise == null ? '—' : `${avgSurprise > 0 ? '+' : ''}${avgSurprise.toFixed(1)}%`,
      note: 'mean across scored results',
      help: { title: 'Result Quality & Growth scoring', body: '' }, // replaced below with the full modal
    },
    freshnessCard(),
  ]);

  const cards = topCards({
    title: 'Top 10 by Result Quality Score',
    items: scored.slice(0, 10).map((s) => ({
      name: s.company.name || s.company.ticker,
      sub: s.company.sector || s.company.ticker,
      value: fmtPoints(s.totalPoints),
      max: s.totalMax,
      warn: s.hardFails.length ? s.hardFails.join(', ') : null,
      payload: s,
    })),
    valueFormat: 'score',
    onSelect: (item) => openEarningsDrill(item.payload),
  });

  const table = scoreTable({
    ...tableBase(rows),
    showScore: true,
    score: scoreOf,
    showSignals: true,
    signals: signalsOf,
    columns: RESULT_COLUMNS,
    filters: SCORE_FILTER,
    initialSort: { key: 'Score', dir: 'desc' },
    exportName: `sattva-earnings-${todayStamp()}`,
    onExport: runExport,
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Every reported result scored against the 15-rule quality and growth framework.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'results' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${calendarStripHtml(ctx)}
    ${chipBarHtml(allScoped, ctx.params || {})}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals are the 15 rules of the Result Quality & Growth model. A loss-making quarter is a hard fail.' })}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
  wireChipBar(ctx, ctx.root);
  wireCalendarStrip(ctx, ctx.root);

  // Swap the generic ? handler for the full model explainer.
  const helpBtn = ctx.root.querySelector('[data-stat-help]');
  if (helpBtn) {
    const fresh = helpBtn.cloneNode(true);
    helpBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => openModal(scoringModalHtml(), { size: 'wide' }));
  }
}

// ---- earnings calendar strip ----------------------------------------------------------

function calendarStripHtml(ctx) {
  const cal = earnings.calendar();
  const events = cal?.events || [];
  if (!events.length) return '';
  const active = (ctx.params || {}).cal || null;

  // Group by day, keep the natural date order.
  const byDay = new Map();
  for (const e of events) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }

  return `
    <section class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-calendar>
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500">Upcoming results · next 30 days</h3>
        <div class="flex items-center gap-2">
          ${active ? `<button type="button" data-cal-clear class="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100">Clear filter ✕</button>` : ''}
          <span class="text-[11px] text-slate-400">${events.length} scheduled · dates are illustrative</span>
        </div>
      </div>
      <div class="scrollbar-thin flex gap-3 overflow-x-auto pb-1">
        ${[...byDay.entries()]
          .map(
            ([date, items]) => `
          <div class="flex-shrink-0">
            <div class="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(formatDate(date))}</div>
            <div class="flex flex-col gap-1">
              ${items
                .map((e) => {
                  const on = active === e.ticker;
                  return `<button type="button" data-cal-ticker="${escapeHtml(e.ticker)}" title="${escapeHtml(e.name)} · ${e.confirmed ? 'board meeting intimated' : 'estimated date'}"
                    class="flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors ${
                      on ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/50'
                    }">
                    <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full ${e.confirmed ? 'bg-emerald-500' : 'bg-slate-300'}"></span>
                    <span class="max-w-[9rem] truncate">${escapeHtml(e.name)}</span>
                  </button>`;
                })
                .join('')}
            </div>
          </div>`
          )
          .join('')}
      </div>
    </section>`;
}

function wireCalendarStrip(ctx, root) {
  const cal = root.querySelector('[data-calendar]');
  if (!cal) return;
  cal.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-cal-clear]');
    if (clear) {
      const next = { ...(ctx.params || {}) };
      delete next.cal;
      ctx.setParams(next);
      return;
    }
    const btn = e.target.closest('[data-cal-ticker]');
    if (!btn) return;
    const t = btn.dataset.calTicker;
    ctx.setParams({ ...(ctx.params || {}), cal: (ctx.params || {}).cal === t ? '' : t });
  });
}

// ---- the model explainer modal ----------------------------------------------------------

function scoringModalHtml() {
  const byCat = new Map();
  for (const r of ACTIVE_RULES) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const sections = [...byCat.entries()]
    .map(([cat, rules]) => {
      const catMax = rules.reduce((s, r) => s + (r.fn({}).max || 0), 0);
      return `
        <div class="mb-4">
          <div class="mb-1.5 flex items-baseline justify-between">
            <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(cat)}</h3>
            <span class="text-xs font-semibold tabular-nums text-slate-500">${catMax} pts</span>
          </div>
          <div class="divide-y divide-slate-100 overflow-hidden rounded-xl ring-1 ring-slate-200/70">
            ${rules
              .map(
                (r) => `
              <div class="flex items-center justify-between gap-3 bg-white px-3 py-2">
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-slate-900">${escapeHtml(r.label)}</div>
                  <div class="text-[11px] text-slate-500">Criteria: ${escapeHtml(r.criteria)}</div>
                </div>
                <span class="flex-shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold tabular-nums text-slate-600">${r.fn({}).max} pt${r.fn({}).max === 1 ? '' : 's'}</span>
              </div>`
              )
              .join('')}
          </div>
        </div>`;
    })
    .join('');

  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">Result Quality &amp; Growth</h2>
          <p class="mt-1 text-sm text-slate-500">
            ${ACTIVE_RULES.length} rules across five categories, ${TOTAL_MAX} points in total. Each rule reads the reported
            quarterly numbers directly — a missing input scores N/A rather than a guess.
          </p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      </div>
      ${sections}
      <div class="rounded-xl bg-rose-50 p-3 text-[12px] leading-relaxed text-rose-800 ring-1 ring-rose-100">
        <strong>Hard fail:</strong> a loss-making quarter fails the screen outright. Those rows are tinted rose and carry a
        ⚠ Red Flag chip; the remaining rules still score so you can see what is working underneath.
      </div>
      <div class="mt-3 rounded-xl bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900 ring-1 ring-amber-100">
        <strong>Illustrative data:</strong> the model is real, the financials it scores are not. Company names, tickers and
        sectors come from the NSE-500 universe; every rupee is synthetic until the filings feed is wired.
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (b) RESULT SCANS
// ---------------------------------------------------------------------------------------

function renderScans(ctx, rows) {
  const params = ctx.params || {};
  const activeId = params.scan || SCANS[0].id;
  const custom = loadCustomScans();
  const active = scanById(activeId, custom);
  const matched = active ? runScan(active, rows) : rows;

  const stats = statStrip([
    { label: 'Scan', value: active ? active.name : '—', note: active?.custom ? 'custom scan' : 'built-in' },
    { label: 'Matches', value: formatNumber(matched.length), note: `of ${rows.length} scored results` },
    { label: 'Saved scans', value: formatNumber(custom.length), note: 'stored in this browser' },
    freshnessCard(),
  ]);

  const table = scoreTable({
    ...tableBase(matched),
    showScore: true,
    score: scoreOf,
    showSignals: true,
    signals: signalsOf,
    columns: RESULT_COLUMNS,
    initialSort: { key: 'Score', dir: 'desc' },
    exportName: `sattva-scan-${activeId}-${todayStamp()}`,
    onExport: runExport,
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Named screens over the scored result set. Every scan is a plain predicate — its definition is shown, not hidden.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'results' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${scanPickerHtml(rows, activeId, custom)}
    ${active ? scanDefinitionHtml(active, matched.length, rows.length) : ''}
    ${customBuilderHtml()}
    ${table.html}
    ${legendStrip()}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  table.wire(ctx.root);
  wireScanPicker(ctx, ctx.root);
  wireCustomBuilder(ctx, ctx.root, rows);
}

function scanPickerHtml(rows, activeId, custom) {
  const chip = (s) => {
    const n = runScan(s, rows).length;
    const on = s.id === activeId;
    return `<button type="button" data-scan-id="${escapeHtml(s.id)}"
      class="group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
        on ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
      }">
      <span>${escapeHtml(s.name)}</span>
      <span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${on ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>
      ${s.custom ? `<span data-scan-delete="${escapeHtml(s.id)}" title="Delete this saved scan" class="ml-0.5 rounded px-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600">✕</span>` : ''}
    </button>`;
  };
  return `
    <div class="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-scan-picker>
      <div class="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">Built-in scans</div>
      <div class="flex flex-wrap gap-2">${SCANS.map(chip).join('')}</div>
      ${
        custom.length
          ? `<div class="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wider text-slate-400">Saved scans</div>
             <div class="flex flex-wrap gap-2">${custom.map(chip).join('')}</div>`
          : ''
      }
    </div>`;
}

function scanDefinitionHtml(scan, matchCount, total) {
  return `
    <div class="mb-5 rounded-2xl bg-indigo-50/50 p-4 ring-1 ring-indigo-100">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(scan.name)}</h3>
        <span class="text-xs font-semibold tabular-nums text-indigo-700">${matchCount} of ${total} match</span>
      </div>
      <div class="mt-1.5 text-sm text-slate-700"><span class="font-semibold">Definition:</span> ${escapeHtml(scan.custom ? describeCustom(scan) : scan.definition)}</div>
      ${scan.why ? `<div class="mt-1 text-xs italic text-slate-500">${escapeHtml(scan.why)}</div>` : ''}
    </div>`;
}

const CUSTOM_METRICS = [
  { id: 'revYoY', label: 'Revenue YoY %' },
  { id: 'patYoY', label: 'PAT YoY %' },
  { id: 'opmDelta', label: 'OPM change (pp)' },
  { id: 'epsSurprise', label: 'EPS surprise %' },
  { id: 'score', label: 'Quality score' },
];
const CUSTOM_OPS = [
  { id: 'gt', label: '>' },
  { id: 'gte', label: '≥' },
  { id: 'lt', label: '<' },
  { id: 'lte', label: '≤' },
];

function customBuilderHtml() {
  return `
    <details class="mb-5 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100" data-custom-builder>
      <summary class="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
        <span class="text-indigo-600">＋</span> Build a custom scan
      </summary>
      <div class="border-t border-slate-100 p-4">
        <div class="mb-3 text-xs text-slate-500">Add one or more conditions. All of them must hold (AND).</div>
        <div data-condition-list class="mb-3 space-y-2"></div>
        <div class="flex flex-wrap items-center gap-2">
          <select data-cond-metric class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            ${CUSTOM_METRICS.map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('')}
          </select>
          <select data-cond-op class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            ${CUSTOM_OPS.map((o) => `<option value="${o.id}">${escapeHtml(o.label)}</option>`).join('')}
          </select>
          <input type="number" step="any" data-cond-value placeholder="value" class="w-28 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button type="button" data-cond-add class="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200">Add condition</button>
          <span data-cond-preview class="text-xs text-slate-500"></span>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <input type="text" data-scan-name placeholder="Name this scan" class="w-56 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button type="button" data-scan-save class="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700">Save scan</button>
          <span data-scan-msg class="text-xs text-slate-500"></span>
        </div>
      </div>
    </details>`;
}

function wireScanPicker(ctx, root) {
  const picker = root.querySelector('[data-scan-picker]');
  if (!picker) return;
  picker.addEventListener('click', (e) => {
    const del = e.target.closest('[data-scan-delete]');
    if (del) {
      e.stopPropagation();
      deleteCustomScan(del.dataset.scanDelete);
      const next = { ...(ctx.params || {}) };
      if (next.scan === del.dataset.scanDelete) delete next.scan;
      ctx.setParams(next);
      return;
    }
    const btn = e.target.closest('[data-scan-id]');
    if (btn) ctx.setParams({ ...(ctx.params || {}), scan: btn.dataset.scanId });
  });
}

function wireCustomBuilder(ctx, root, rows) {
  const box = root.querySelector('[data-custom-builder]');
  if (!box) return;
  const list = box.querySelector('[data-condition-list]');
  const preview = box.querySelector('[data-cond-preview]');
  const msg = box.querySelector('[data-scan-msg]');
  const conditions = [];

  function repaint() {
    list.innerHTML = conditions.length
      ? conditions
          .map(
            (c, i) => `
        <div class="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs ring-1 ring-slate-100">
          <span class="font-semibold text-slate-700">${escapeHtml(CUSTOM_METRICS.find((m) => m.id === c.metric)?.label || c.metric)}</span>
          <span class="text-slate-500">${escapeHtml(CUSTOM_OPS.find((o) => o.id === c.op)?.label || c.op)}</span>
          <span class="font-semibold tabular-nums text-slate-700">${c.value}</span>
          <button type="button" data-cond-remove="${i}" class="ml-auto rounded px-1 text-slate-400 hover:bg-rose-100 hover:text-rose-600">✕</button>
        </div>`
          )
          .join('')
      : '<div class="text-xs italic text-slate-400">No conditions yet.</div>';
    const n = conditions.length ? rows.filter((s) => matchesCustom({ conditions }, s)).length : rows.length;
    preview.textContent = conditions.length ? `${n} of ${rows.length} match` : '';
  }
  repaint();

  box.querySelector('[data-cond-add]').addEventListener('click', () => {
    const metric = box.querySelector('[data-cond-metric]').value;
    const op = box.querySelector('[data-cond-op]').value;
    const raw = box.querySelector('[data-cond-value]').value;
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) {
      msg.textContent = 'Enter a numeric threshold.';
      return;
    }
    msg.textContent = '';
    conditions.push({ metric, op, value });
    box.querySelector('[data-cond-value]').value = '';
    repaint();
  });

  list.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-cond-remove]');
    if (!rm) return;
    conditions.splice(Number(rm.dataset.condRemove), 1);
    repaint();
  });

  box.querySelector('[data-scan-save]').addEventListener('click', () => {
    const name = box.querySelector('[data-scan-name]').value.trim();
    if (!name) {
      msg.textContent = 'Give the scan a name.';
      return;
    }
    if (!conditions.length) {
      msg.textContent = 'Add at least one condition.';
      return;
    }
    const saved = saveCustomScan({ name, conditions });
    ctx.setParams({ ...(ctx.params || {}), scan: saved.id });
  });
}

// ---------------------------------------------------------------------------------------
// (c) QUALITY & GROWTH
// ---------------------------------------------------------------------------------------

const CATEGORY_ORDER = ['Growth', 'Margins', 'Earnings Quality', 'Surprise', 'Consistency'];

function renderQualityGrowth(ctx, rows) {
  const scored = rows.filter((s) => !s.tickerError);
  const allScoped = earnings.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);

  // Category averages across the filtered set.
  const catMax = new Map();
  const catSum = new Map();
  for (const r of ACTIVE_RULES) catMax.set(r.category, (catMax.get(r.category) || 0) + r.fn({}).max);
  for (const s of scored) {
    for (const b of s.breakdown) catSum.set(b.category, (catSum.get(b.category) || 0) + b.points);
  }
  const categories = CATEGORY_ORDER.filter((c) => catMax.has(c)).map((c) => ({
    name: c,
    avg: scored.length ? (catSum.get(c) || 0) / scored.length : 0,
    max: catMax.get(c),
  }));

  const avgScore = scored.length ? scored.reduce((a, s) => a + s.totalPoints, 0) / scored.length : 0;
  const weakest = categories.slice().sort((a, b) => a.avg / a.max - b.avg / b.max)[0];

  const stats = statStrip([
    { label: 'Companies scored', value: formatNumber(scored.length), note: `${rows.length - scored.length} without result data` },
    { label: 'Average score', value: `${avgScore.toFixed(1)} / ${TOTAL_MAX}`, note: `${Math.round((avgScore / TOTAL_MAX) * 100)}% of the maximum` },
    {
      label: 'Weakest category',
      value: weakest ? weakest.name : '—',
      note: weakest ? `${weakest.avg.toFixed(1)} of ${weakest.max} on average` : '',
      help: {
        title: 'Reading the category breakdown',
        body: `<p>Each bar is the <strong>average points earned</strong> across the filtered set, against that category's maximum.</p>
               <p class="mt-2">A low average is not automatically bad news — <em>Surprise</em> runs low in a quarter where the street modelled well, and <em>Consistency</em> is structurally hard for cyclicals. What it does tell you is where the season's results are concentrated.</p>
               <p class="mt-3 text-slate-500">The scatter below separates the two things that matter most: growth on the horizontal, earnings quality on the vertical.</p>`,
      },
    },
    freshnessCard(),
  ]);

  // "Watch for": strong growth, weak earnings quality — the exact rules that flag it.
  const QUALITY_KEYS = ['op_vs_pat', 'other_inc', 'exceptional'];
  const watchFor = scored
    .map((s) => {
      const v = vals(s);
      const flags = s.breakdown.filter((b) => QUALITY_KEYS.includes(b.key) && (b.status === 'fail' || b.status === 'hard_fail'));
      return { s, v, flags };
    })
    .filter((x) => x.flags.length >= 1 && (x.v.revYoY ?? 0) > 10)
    .sort((a, b) => b.flags.length - a.flags.length || (b.v.revYoY ?? 0) - (a.v.revYoY ?? 0))
    .slice(0, 8);

  const sectorRows = buildSectorRows(scored);
  const sectorTable = scoreTable({
    rows: sectorRows,
    key: (r) => r.sector,
    name: (r) => r.sector,
    nameLabel: 'Sector',
    sub: (r) => `${r.count} compan${r.count === 1 ? 'y' : 'ies'}`,
    columns: [
      { label: 'Companies', get: (r) => formatNumber(r.count), align: 'right', sortValue: (r) => r.count },
      { label: 'Avg score', get: (r) => `<span class="font-semibold text-slate-800">${r.avgScore.toFixed(1)}</span><span class="text-slate-400">/${TOTAL_MAX}</span>`, html: true, align: 'right', sortValue: (r) => r.avgScore },
      { label: 'Avg Rev YoY', get: (r) => pctCell(r.avgRevYoY), html: true, align: 'right', sortValue: (r) => r.avgRevYoY ?? -999 },
      { label: 'Avg OPM Δ', get: (r) => (r.avgOpmDelta == null ? '—' : toneSpan(`${r.avgOpmDelta > 0 ? '+' : ''}${Math.round(r.avgOpmDelta * 100)}bps`, r.avgOpmDelta > 0 ? 'pos' : 'neg')), html: true, align: 'right', sortValue: (r) => r.avgOpmDelta ?? -999 },
      { label: 'Beats', get: (r) => `${r.beats} / ${r.count}`, align: 'right', sortValue: (r) => (r.count ? r.beats / r.count : 0) },
    ],
    searchable: (r) => r.sector,
    initialSort: { key: 'Avg score', dir: 'desc' },
    emptyMessage: 'No sectors in this scope.',
    exportName: `sattva-earnings-sectors-${todayStamp()}`,
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'The same 15-rule model read analytically — where the points are earned, and which companies grow without the quality to back it.',
      meta: scopeSummary({ scope: ctx.scope, count: scored.length, noun: 'scored' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${chipBarHtml(allScoped, ctx.params || {})}
    ${categoryStripHtml(categories)}
    ${scatterHtml(scored)}
    ${watchForHtml(watchFor)}
    <div class="mb-2 mt-6 text-xs font-bold uppercase tracking-wider text-slate-500">Sector breakdown</div>
    ${sectorTable.html}
    ${legendStrip()}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  sectorTable.wire(ctx.root);
  wireChipBar(ctx, ctx.root);
  wireScatter(ctx.root, scored);
  wireWatchFor(ctx.root, watchFor);
}

function buildSectorRows(scored) {
  const bySector = new Map();
  for (const s of scored) {
    const key = s.company.sector || 'Unclassified';
    if (!bySector.has(key)) bySector.set(key, []);
    bySector.get(key).push(s);
  }
  return [...bySector.entries()].map(([sector, list]) => {
    const avg = (fn) => {
      const xs = list.map(fn).filter((v) => v != null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    return {
      sector,
      count: list.length,
      avgScore: avg((s) => s.totalPoints) ?? 0,
      avgRevYoY: avg((s) => vals(s).revYoY),
      avgOpmDelta: avg((s) => vals(s).opmDelta),
      beats: list.filter((s) => resultTag(s) === 'Beat').length,
    };
  });
}

function categoryStripHtml(categories) {
  return `
    <section class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Average points earned by category</div>
      <div class="space-y-2.5">
        ${categories
          .map((c) => {
            const pctFull = c.max ? (c.avg / c.max) * 100 : 0;
            return `
            <div class="flex items-center gap-3">
              <span class="w-32 flex-shrink-0 text-xs font-semibold text-slate-600">${escapeHtml(c.name)}</span>
              <span class="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <span class="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${Math.max(1, pctFull).toFixed(1)}%"></span>
              </span>
              <span class="w-20 flex-shrink-0 text-right text-xs font-bold tabular-nums text-slate-700">${c.avg.toFixed(1)} / ${c.max}</span>
              <span class="w-10 flex-shrink-0 text-right text-[11px] tabular-nums text-slate-400">${Math.round(pctFull)}%</span>
            </div>`;
          })
          .join('')}
      </div>
    </section>`;
}

// ---- quality-vs-growth scatter: inline SVG, no chart library ---------------------------

const SCATTER = { w: 760, h: 380, padL: 52, padR: 18, padT: 18, padB: 44 };

function scatterHtml(scored) {
  const pts = scored
    .map((s) => ({ s, x: vals(s).revYoY, y: s.totalPoints, cap: s.company.marketCap || 1000 }))
    .filter((p) => p.x != null && Number.isFinite(p.x));
  if (!pts.length) return '';

  // Clamp the x range so one runaway grower doesn't squash everything else.
  const xsSorted = pts.map((p) => p.x).sort((a, b) => a - b);
  const xLo = Math.min(-20, Math.floor(xsSorted[0] / 10) * 10);
  const xHi = Math.max(40, Math.ceil(xsSorted[Math.floor(xsSorted.length * 0.97)] / 10) * 10);
  const yLo = 0;
  const yHi = TOTAL_MAX;

  const { w, h, padL, padR, padT, padB } = SCATTER;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const sx = (x) => padL + ((Math.max(xLo, Math.min(xHi, x)) - xLo) / (xHi - xLo)) * plotW;
  const sy = (y) => padT + plotH - ((y - yLo) / (yHi - yLo)) * plotH;

  const caps = pts.map((p) => p.cap);
  const capLo = Math.min(...caps);
  const capHi = Math.max(...caps);
  const radius = (cap) => {
    if (capHi === capLo) return 5;
    // sqrt so area, not radius, tracks market cap
    const t = Math.sqrt((cap - capLo) / (capHi - capLo));
    return 3.5 + t * 8;
  };

  // Quadrant split: median growth, and 60% of the maximum score.
  const xMid = 12;
  const yMid = TOTAL_MAX * 0.6;

  const TIER_FILL = { excellent: '#059669', good: '#2563eb', average: '#d97706', weak: '#e11d48' };

  const xTicks = [];
  for (let v = xLo; v <= xHi; v += Math.max(10, Math.round((xHi - xLo) / 8 / 10) * 10)) xTicks.push(v);
  const yTicks = [0, 5, 10, 15, 20].filter((v) => v <= yHi);

  return `
    <section class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-scatter>
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-base font-bold text-slate-900">Quality vs growth</h3>
        <span class="text-[11px] text-slate-400">${pts.length} companies · dot size = market cap · colour = score tier</span>
      </div>
      <div class="scrollbar-thin overflow-x-auto">
        <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Quality score versus revenue growth" style="min-width:640px">
          <!-- quadrant washes -->
          <rect x="${sx(xMid)}" y="${padT}" width="${padL + plotW - sx(xMid)}" height="${sy(yMid) - padT}" fill="#059669" opacity="0.05" />
          <rect x="${padL}" y="${padT}" width="${sx(xMid) - padL}" height="${sy(yMid) - padT}" fill="#2563eb" opacity="0.04" />
          <rect x="${padL}" y="${sy(yMid)}" width="${sx(xMid) - padL}" height="${padT + plotH - sy(yMid)}" fill="#e11d48" opacity="0.04" />
          <rect x="${sx(xMid)}" y="${sy(yMid)}" width="${padL + plotW - sx(xMid)}" height="${padT + plotH - sy(yMid)}" fill="#d97706" opacity="0.05" />

          <!-- grid -->
          ${yTicks.map((v) => `<line x1="${padL}" y1="${sy(v)}" x2="${padL + plotW}" y2="${sy(v)}" stroke="#e2e8f0" stroke-width="1" />`).join('')}
          ${xTicks.map((v) => `<line x1="${sx(v)}" y1="${padT}" x2="${sx(v)}" y2="${padT + plotH}" stroke="#f1f5f9" stroke-width="1" />`).join('')}
          <line x1="${sx(xMid)}" y1="${padT}" x2="${sx(xMid)}" y2="${padT + plotH}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 3" />
          <line x1="${padL}" y1="${sy(yMid)}" x2="${padL + plotW}" y2="${sy(yMid)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 3" />

          <!-- quadrant labels -->
          <text x="${padL + plotW - 8}" y="${padT + 16}" text-anchor="end" font-size="11" font-weight="700" fill="#059669" opacity="0.75">Compounders</text>
          <text x="${padL + 8}" y="${padT + 16}" font-size="11" font-weight="700" fill="#2563eb" opacity="0.7">Turnarounds</text>
          <text x="${padL + 8}" y="${padT + plotH - 8}" font-size="11" font-weight="700" fill="#e11d48" opacity="0.65">Value traps</text>
          <text x="${padL + plotW - 8}" y="${padT + plotH - 8}" text-anchor="end" font-size="11" font-weight="700" fill="#b45309" opacity="0.7">Expensive growth</text>

          <!-- axes -->
          <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#94a3b8" stroke-width="1" />
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#94a3b8" stroke-width="1" />
          ${xTicks.map((v) => `<text x="${sx(v)}" y="${padT + plotH + 16}" text-anchor="middle" font-size="10" fill="#64748b">${v}%</text>`).join('')}
          ${yTicks.map((v) => `<text x="${padL - 8}" y="${sy(v) + 3}" text-anchor="end" font-size="10" fill="#64748b">${v}</text>`).join('')}
          <text x="${padL + plotW / 2}" y="${h - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">Revenue growth YoY</text>
          <text x="14" y="${padT + plotH / 2}" text-anchor="middle" font-size="11" font-weight="600" fill="#475569" transform="rotate(-90 14 ${padT + plotH / 2})">Quality score (of ${TOTAL_MAX})</text>

          <!-- points -->
          ${pts
            .map((p) => {
              const tier = p.s.hardFails.length ? 'weak' : scoreTier(p.s.scorePct);
              return `<circle data-dot-ticker="${escapeHtml(p.s.company.ticker)}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${radius(p.cap).toFixed(1)}"
                fill="${TIER_FILL[tier]}" fill-opacity="0.55" stroke="${TIER_FILL[tier]}" stroke-width="1.2" class="cursor-pointer transition-opacity hover:fill-opacity-90">
                <title>${escapeHtml(p.s.company.name)} · ${escapeHtml(p.s.company.ticker)}
Revenue YoY ${p.x.toFixed(1)}% · score ${fmtPoints(p.s.totalPoints)}/${p.s.totalMax} (${tierLabel(tier)})</title>
              </circle>`;
            })
            .join('')}
        </svg>
      </div>
      <div class="mt-1 text-[11px] leading-relaxed text-slate-400">
        Quadrants split at ${xMid}% revenue growth and ${yMid.toFixed(0)} of ${TOTAL_MAX} points.
        <span class="font-semibold text-slate-500">Compounders</span> grow and score well;
        <span class="font-semibold text-slate-500">expensive growth</span> grows without the quality to back it;
        <span class="font-semibold text-slate-500">value traps</span> do neither;
        <span class="font-semibold text-slate-500">turnarounds</span> score well on low growth. Click a dot for the full breakdown.
      </div>
    </section>`;
}

function wireScatter(root, scored) {
  const box = root.querySelector('[data-scatter]');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const dot = e.target.closest('[data-dot-ticker]');
    if (!dot) return;
    const hit = scored.find((s) => s.company.ticker === dot.dataset.dotTicker);
    if (hit) openEarningsDrill(hit);
  });
}

function watchForHtml(items) {
  if (!items.length) {
    return `
      <section class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
        <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Watch for</div>
        <div class="text-xs text-slate-400">No company in this scope pairs double-digit growth with a failing earnings-quality rule.</div>
      </section>`;
  }
  return `
    <section class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-watch-for>
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-base font-bold text-slate-900">Watch for: growth without quality</h3>
        <span class="text-[11px] text-slate-400">revenue up over 10% with an earnings-quality rule failing</span>
      </div>
      <div class="mt-2 divide-y divide-slate-100">
        ${items
          .map(({ s, v, flags }) => {
            const { color, initials } = avatarFor(s.company.name || s.company.ticker);
            return `
            <button type="button" data-watch-ticker="${escapeHtml(s.company.ticker)}" class="flex w-full items-center gap-3 py-2 text-left transition-colors hover:bg-slate-50">
              <span class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${color} text-[10px] font-bold text-white">${escapeHtml(initials)}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-semibold text-slate-900">${escapeHtml(s.company.name)}</span>
                <span class="block truncate text-[11px] text-slate-500">${flags.map((f) => escapeHtml(f.label)).join(' · ')}</span>
              </span>
              <span class="flex-shrink-0 text-right">
                <span class="block text-sm font-bold tabular-nums text-emerald-600">${v.revYoY > 0 ? '+' : ''}${v.revYoY.toFixed(1)}%</span>
                <span class="block text-[11px] tabular-nums ${tierColor(scoreTier(s.scorePct))}">${fmtPoints(s.totalPoints)}/${s.totalMax}</span>
              </span>
            </button>`;
          })
          .join('')}
      </div>
    </section>`;
}

function wireWatchFor(root, items) {
  const box = root.querySelector('[data-watch-for]');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch-ticker]');
    if (!btn) return;
    const hit = items.find((x) => x.s.company.ticker === btn.dataset.watchTicker);
    if (hit) openEarningsDrill(hit.s);
  });
}
