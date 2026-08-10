// tabs/breakouts.js — technical scans across the coverage universe.
// THIS PROMPT: structure + placeholder panel only. "Technical Scanner" and "Strong Breakouts"
// need the live technicals.json feed that arrives in prompt 2 (see docs/DATA-CONTRACTS.md) —
// they honestly show a pending state rather than fabricated indicator numbers. "FII Accumulation"
// and "Earnings Surprise" already have real mock data (institutions.json / earnings.json) to lean on.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, skeleton, comingSoonStrip } from '../ui/components.js';
import { formatCroreCompact, formatPct, formatNumber, toneForValue } from '../core/format.js';

export const meta = {
  id: 'breakouts',
  title: 'Breakouts / Technical',
  subtitle: 'Technical scans across the coverage universe — live pricing data lands in the next prompt.',
  subviews: [
    { id: 'technical-scanner', label: 'Technical Scanner' },
    { id: 'strong-breakouts', label: 'Strong Breakouts' },
    { id: 'fii-accumulation', label: 'FII Accumulation' },
    { id: 'earnings-surprise', label: 'Earnings Surprise' },
  ],
};

const FEATURES = [
  'Live EOD price/volume feed (Yahoo Finance, NSE 500)',
  '50/100/200-DMA breakout detection',
  'Volume surge & momentum scoring',
  '52-week-high proximity scanner',
  'Sector-relative strength ranking',
  'FII/DII flow overlays on price action',
];

function scopedList(ctx, rows, tickerKey = 'ticker') {
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r[tickerKey]));
}

const UNIVERSE_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'marketCap', label: 'Market Cap', align: 'right', render: (r) => formatCroreCompact(r.marketCap) },
  { key: 'technicalScore', label: 'Technical Score', sortable: false, render: () => pill({ label: 'Pending', tone: 'caution' }) },
];

const FII_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'company', label: 'Company' },
  { key: 'fiiPct', label: 'FII %', align: 'right', render: (r) => `${r.fiiPct.toFixed(1)}%` },
  { key: 'fiiChangeQoqPct', label: 'FII Δ QoQ', align: 'right', render: (r) => changeCell(r.fiiChangeQoqPct) },
];

const SURPRISE_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'revenueYoyPct', label: 'Rev YoY', align: 'right', render: (r) => changeCell(r.revenueYoyPct) },
  { key: 'netProfitYoyPct', label: 'PAT YoY', align: 'right', render: (r) => changeCell(r.netProfitYoyPct) },
  { key: 'surprisePct', label: 'Surprise', align: 'right', render: (r) => changeCell(r.surprisePct) },
  { key: 'resultTag', label: 'Tag', render: (r) => pill({ label: r.resultTag, tone: r.resultTag === 'Beat' ? 'positive' : r.resultTag === 'Miss' ? 'negative' : 'neutral' }) },
];

function changeCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}

function pendingStats(rows) {
  return [
    { label: 'Universe coverage', value: formatNumber(rows.length) },
    { label: 'Data pipeline', value: 'Pending', deltaTone: 'caution' },
    { label: 'Next update', value: 'Prompt 2', sublabel: 'Yahoo Finance EOD · NSE 500' },
    { label: 'Indicators planned', value: '12+', sublabel: 'DMAs, RSI, volume surge…' },
  ];
}

function fiiStats(rows) {
  const buyers = rows.filter((r) => r.fiiChangeQoqPct > 0).length;
  const sellers = rows.filter((r) => r.fiiChangeQoqPct < 0).length;
  const avg = rows.length ? rows.reduce((s, r) => s + r.fiiChangeQoqPct, 0) / rows.length : 0;
  return [
    { label: 'Names tracked', value: formatNumber(rows.length) },
    { label: 'Net FII buyers', value: formatNumber(buyers), deltaTone: 'positive' },
    { label: 'Net FII sellers', value: formatNumber(sellers), deltaTone: sellers ? 'negative' : 'neutral' },
    { label: 'Avg FII Δ QoQ', value: formatPct(avg), deltaTone: toneForValue(avg) },
  ];
}

function surpriseStats(rows) {
  const beats = rows.filter((r) => r.resultTag === 'Beat').length;
  const misses = rows.filter((r) => r.resultTag === 'Miss').length;
  const avgAbs = rows.length ? rows.reduce((s, r) => s + Math.abs(r.surprisePct), 0) / rows.length : 0;
  return [
    { label: 'Results scanned', value: formatNumber(rows.length) },
    { label: 'Beats', value: formatNumber(beats), deltaTone: 'positive' },
    { label: 'Misses', value: formatNumber(misses), deltaTone: misses ? 'negative' : 'neutral' },
    { label: 'Avg |surprise|', value: formatPct(avgAbs, { signed: false }) },
  ];
}

export function render(ctx) {
  const universe = ctx.data?.universe || [];
  const isPending = ctx.subview === 'technical-scanner' || ctx.subview === 'strong-breakouts';

  let rows;
  let stats;
  let table;

  if (isPending) {
    rows = scopedList(ctx, universe);
    stats = pendingStats(rows);
    table = dataTable({ columns: UNIVERSE_COLUMNS, rows, initialSort: { key: 'marketCap', dir: 'desc' } });
  } else if (ctx.subview === 'fii-accumulation') {
    rows = scopedList(ctx, ctx.data?.institutions || []);
    stats = fiiStats(rows);
    table = dataTable({ columns: FII_COLUMNS, rows, initialSort: { key: 'fiiChangeQoqPct', dir: 'desc' } });
  } else {
    rows = scopedList(ctx, ctx.data?.earnings || []);
    stats = surpriseStats(rows);
    table = dataTable({ columns: SURPRISE_COLUMNS, rows, initialSort: { key: 'surprisePct', dir: 'desc' } });
  }

  ctx.root.innerHTML = `
    <div>${sectionHeader({ title: meta.title, description: subviewDescription(ctx.subview), meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: isPending ? 'companies' : 'names' }) })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${stats.map((s) => statCard(s)).join('')}</div>
    <div id="breakouts-table"></div>
    ${isPending ? pendingHeatmapPreview() : ''}
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#breakouts-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

function subviewDescription(subview) {
  if (subview === 'technical-scanner') return 'Universe list, ready to score once the live technical feed lands.';
  if (subview === 'strong-breakouts') return 'Breakout candidates will surface here once EOD price/volume data is wired in.';
  if (subview === 'fii-accumulation') return 'Sorted by quarter-on-quarter change in FII shareholding.';
  return 'Sorted by earnings surprise vs Street estimates this quarter.';
}

function pendingHeatmapPreview() {
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Momentum &amp; volume heatmap (live, next prompt)</div>
      ${skeleton({ rows: 4, variant: 'cards' })}
    </div>`;
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
