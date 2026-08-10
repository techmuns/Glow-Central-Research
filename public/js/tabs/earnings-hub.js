// tabs/earnings-hub.js — quarterly results, scans and quality/growth signals.
// THIS PROMPT: structure + placeholder panel only. Real result parsing/scoring lands in prompt 4.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, filterChips, comingSoonStrip } from '../ui/components.js';
import { formatCrore, formatPct, formatDate, formatNumber, toneForValue } from '../core/format.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Quarterly results, scans and quality/growth signals across coverage.',
  subviews: [
    { id: 'latest-results', label: 'Latest Results' },
    { id: 'result-scans', label: 'Result Scans' },
    { id: 'quality-growth', label: 'Quality & Growth' },
  ],
};

const FEATURES = [
  'Auto-parsed result PDFs (revenue, PAT, margin extraction)',
  'Beat/miss scoring vs Street estimates',
  'Segment-wise revenue break-up',
  'Quality & growth composite score (ROE, ROCE, consistency)',
  'Saved scans and custom result alerts',
  'Historical per-company result trend charts',
];

const COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'reportDate', label: 'Reported', render: (r) => formatDate(r.reportDate) },
  { key: 'revenueCr', label: 'Revenue', align: 'right', render: (r) => formatCrore(r.revenueCr) },
  { key: 'revenueYoyPct', label: 'Rev YoY', align: 'right', render: (r) => pctCell(r.revenueYoyPct) },
  { key: 'netProfitCr', label: 'Net Profit', align: 'right', render: (r) => formatCrore(r.netProfitCr) },
  { key: 'netProfitYoyPct', label: 'PAT YoY', align: 'right', render: (r) => pctCell(r.netProfitYoyPct) },
  { key: 'surprisePct', label: 'Surprise', align: 'right', render: (r) => pctCell(r.surprisePct) },
  { key: 'resultTag', label: 'Tag', render: (r) => pill({ label: r.resultTag, tone: r.resultTag === 'Beat' ? 'positive' : r.resultTag === 'Miss' ? 'negative' : 'neutral' }) },
];

function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}

function scopedRows(ctx) {
  const rows = ctx.data?.earnings || [];
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function sortForSubview(subview, rows) {
  const sorted = rows.slice();
  if (subview === 'quality-growth') sorted.sort((a, b) => b.netProfitYoyPct - a.netProfitYoyPct);
  else sorted.sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate));
  return sorted;
}

function buildStats(rows) {
  const beats = rows.filter((r) => r.resultTag === 'Beat').length;
  const misses = rows.filter((r) => r.resultTag === 'Miss').length;
  const avgSurprise = rows.length ? rows.reduce((sum, r) => sum + r.surprisePct, 0) / rows.length : 0;
  const latest = rows.slice().sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate))[0];
  return [
    { label: 'Results tracked', value: formatNumber(rows.length) },
    { label: 'Beats', value: formatNumber(beats), sublabel: `${misses} miss${misses === 1 ? '' : 'es'}` },
    { label: 'Avg surprise', value: formatPct(avgSurprise), deltaTone: toneForValue(avgSurprise) },
    { label: 'Latest print', value: latest ? latest.ticker : '—', sublabel: latest ? formatDate(latest.reportDate) : undefined },
  ];
}

export function render(ctx) {
  cleanup();
  const rows = scopedRows(ctx);
  const description =
    ctx.subview === 'result-scans'
      ? 'Scan results by beat, miss or in-line vs Street estimates.'
      : ctx.subview === 'quality-growth'
        ? 'Sorted by YoY profit growth as a crude quality/growth proxy — full composite scoring lands later.'
        : meta.subtitle;

  ctx.root.innerHTML = `
    <div>${sectionHeader({ title: meta.title, description, meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'results' }) })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(rows)
      .map((s) => statCard(s))
      .join('')}</div>
    ${ctx.subview === 'result-scans' ? '<div id="scan-chips"></div>' : ''}
    <div id="earnings-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const tableMount = ctx.root.querySelector('#earnings-table');
  paintTable(tableMount, ctx.subview, rows);

  if (ctx.subview === 'result-scans') wireScanChips(ctx, rows, tableMount);
}

function paintTable(mount, subview, rows) {
  const table = dataTable({ columns: COLUMNS, rows: sortForSubview(subview, rows), initialSort: null });
  mount.innerHTML = table.html;
  table.wire(mount);
}

function wireScanChips(ctx, rows, tableMount) {
  const chipsMount = ctx.root.querySelector('#scan-chips');
  const options = [
    { id: 'all', label: 'All' },
    { id: 'Beat', label: 'Beat' },
    { id: 'Miss', label: 'Miss' },
    { id: 'In-line', label: 'In-line' },
  ];
  let active = 'all';

  function paintChips() {
    const chips = filterChips({ options, activeIds: [active], onToggle: (id) => { active = id; paintChips(); paintTable(tableMount, ctx.subview, active === 'all' ? rows : rows.filter((r) => r.resultTag === active)); } });
    chipsMount.innerHTML = chips.html;
    chips.wire(chipsMount);
  }
  paintChips();
}

export function destroy() {
  cleanup();
}

function cleanup() {
  // No live pollers or global listeners registered by this tab — nothing to unwind yet.
}
