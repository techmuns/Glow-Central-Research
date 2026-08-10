// tabs/super-investors.js — superstar-investor holdings, institutional ownership and fund flows.
// THIS PROMPT: structure + placeholder panel only. Real Ticker Finology / AMFI scrapers land in prompt 6.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, comingSoonStrip } from '../ui/components.js';
import { formatNumber, formatPct, formatDate, toneForValue } from '../core/format.js';

export const meta = {
  id: 'super-investors',
  title: 'Super Investors',
  subtitle: 'Superstar-investor holdings, institutional ownership and fund flow shifts.',
  subviews: [
    { id: 'superstar-investors', label: 'Superstar Investors' },
    { id: 'institutions', label: 'Institutions' },
    { id: 'fund-flows', label: 'Fund Flows' },
  ],
};

const FEATURES = [
  'Quarterly shareholding scrape (Ticker Finology)',
  'Per-investor portfolio pages with history',
  'New-entry / full-exit alerting',
  'AMFI + Trendlyne mutual fund flow overlay',
  'Investor conviction scoring vs position size',
  'Cross-investor overlap heatmap',
];

function scopedList(ctx, rows) {
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

const INVESTOR_COLUMNS = [
  { key: 'investor', label: 'Investor', render: (r) => `<span class="font-semibold text-slate-800">${r.investor}</span>` },
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-700">${r.ticker}</span>` },
  { key: 'company', label: 'Company' },
  { key: 'action', label: 'Action', render: (r) => pill({ label: r.action, tone: actionTone(r.action) }) },
  { key: 'qtyChange', label: 'Qty Δ', align: 'right', render: (r) => qtyCell(r.qtyChange) },
  { key: 'pctHolding', label: 'Holding %', align: 'right', render: (r) => `${r.pctHolding.toFixed(2)}%` },
  { key: 'pctHoldingChange', label: 'Δ QoQ', align: 'right', render: (r) => pctCell(r.pctHoldingChange, 2) },
  { key: 'asOf', label: 'As of', render: (r) => formatDate(r.asOf) },
];

const INSTITUTION_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'company', label: 'Company' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fiiPct', label: 'FII %', align: 'right', render: (r) => `${r.fiiPct.toFixed(1)}%` },
  { key: 'fiiChangeQoqPct', label: 'FII Δ', align: 'right', render: (r) => pctCell(r.fiiChangeQoqPct) },
  { key: 'diiPct', label: 'DII %', align: 'right', render: (r) => `${r.diiPct.toFixed(1)}%` },
  { key: 'diiChangeQoqPct', label: 'DII Δ', align: 'right', render: (r) => pctCell(r.diiChangeQoqPct) },
  { key: 'mfPct', label: 'MF %', align: 'right', render: (r) => `${r.mfPct.toFixed(1)}%` },
];

const FLOW_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'company', label: 'Company' },
  { key: 'netFlowPct', label: 'Net Inst. Flow Δ', align: 'right', render: (r) => pctCell(r.netFlowPct) },
  { key: 'fiiChangeQoqPct', label: 'FII Δ', align: 'right', render: (r) => pctCell(r.fiiChangeQoqPct) },
  { key: 'diiChangeQoqPct', label: 'DII Δ', align: 'right', render: (r) => pctCell(r.diiChangeQoqPct) },
  { key: 'direction', label: 'Direction', render: (r) => pill({ label: r.direction, tone: r.direction === 'Inflow' ? 'positive' : r.direction === 'Outflow' ? 'negative' : 'neutral' }) },
];

function actionTone(action) {
  if (action === 'Buy' || action === 'New') return 'positive';
  if (action === 'Sell' || action === 'Exit') return 'negative';
  return 'neutral';
}
function qtyCell(value) {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-400';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${formatNumber(value)}</span>`;
}
function pctCell(value, decimals = 1) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value, { decimals })}</span>`;
}

function buildFlowRows(institutions) {
  return institutions.map((r) => {
    const netFlowPct = Math.round((r.fiiChangeQoqPct + r.diiChangeQoqPct) * 10) / 10;
    return {
      ticker: r.ticker,
      company: r.company,
      fiiChangeQoqPct: r.fiiChangeQoqPct,
      diiChangeQoqPct: r.diiChangeQoqPct,
      netFlowPct,
      direction: netFlowPct > 0 ? 'Inflow' : netFlowPct < 0 ? 'Outflow' : 'Flat',
    };
  });
}

function investorStats(rows) {
  const buys = rows.filter((r) => r.action === 'Buy' || r.action === 'New').length;
  const sells = rows.filter((r) => r.action === 'Sell' || r.action === 'Exit').length;
  const investors = new Set(rows.map((r) => r.investor)).size;
  return [
    { label: 'Moves tracked', value: formatNumber(rows.length) },
    { label: 'Investors', value: formatNumber(investors) },
    { label: 'Accumulating', value: formatNumber(buys), deltaTone: 'positive' },
    { label: 'Trimming', value: formatNumber(sells), deltaTone: sells ? 'negative' : 'neutral' },
  ];
}

function institutionStats(rows) {
  const avgFii = rows.length ? rows.reduce((s, r) => s + r.fiiPct, 0) / rows.length : 0;
  const avgFiiChange = rows.length ? rows.reduce((s, r) => s + r.fiiChangeQoqPct, 0) / rows.length : 0;
  const avgDii = rows.length ? rows.reduce((s, r) => s + r.diiPct, 0) / rows.length : 0;
  return [
    { label: 'Names covered', value: formatNumber(rows.length) },
    { label: 'Avg FII holding', value: `${avgFii.toFixed(1)}%` },
    { label: 'Avg DII holding', value: `${avgDii.toFixed(1)}%` },
    { label: 'Avg FII Δ QoQ', value: formatPct(avgFiiChange), deltaTone: toneForValue(avgFiiChange) },
  ];
}

function flowStats(rows) {
  const inflow = rows.filter((r) => r.direction === 'Inflow').length;
  const outflow = rows.filter((r) => r.direction === 'Outflow').length;
  const net = rows.length ? rows.reduce((s, r) => s + r.netFlowPct, 0) / rows.length : 0;
  return [
    { label: 'Names covered', value: formatNumber(rows.length) },
    { label: 'Net inflows', value: formatNumber(inflow), deltaTone: 'positive' },
    { label: 'Net outflows', value: formatNumber(outflow), deltaTone: outflow ? 'negative' : 'neutral' },
    { label: 'Avg net flow Δ', value: formatPct(net), deltaTone: toneForValue(net) },
  ];
}

export function render(ctx) {
  let rows;
  let stats;
  let table;

  if (ctx.subview === 'institutions') {
    rows = scopedList(ctx, ctx.data?.institutions || []);
    stats = institutionStats(rows);
    table = dataTable({ columns: INSTITUTION_COLUMNS, rows, initialSort: { key: 'fiiPct', dir: 'desc' } });
  } else if (ctx.subview === 'fund-flows') {
    rows = buildFlowRows(scopedList(ctx, ctx.data?.institutions || []));
    stats = flowStats(rows);
    table = dataTable({ columns: FLOW_COLUMNS, rows, initialSort: { key: 'netFlowPct', dir: 'desc' } });
  } else {
    rows = scopedList(ctx, ctx.data?.superinvestors || []);
    stats = investorStats(rows);
    table = dataTable({ columns: INVESTOR_COLUMNS, rows, initialSort: { key: 'pctHoldingChange', dir: 'desc' } });
  }

  ctx.root.innerHTML = `
    <div>${sectionHeader({ title: meta.title, description: subviewDescription(ctx.subview), meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: ctx.subview === 'superstar-investors' ? 'moves' : 'names' }) })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${stats.map((s) => statCard(s)).join('')}</div>
    <div id="si-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#si-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

function subviewDescription(subview) {
  if (subview === 'institutions') return 'FII / DII / mutual fund shareholding by company, latest reported quarter.';
  if (subview === 'fund-flows') return 'Combined FII + DII quarter-on-quarter shift, ranked by net direction.';
  return 'Latest disclosed superstar-investor position changes, ranked by holding change.';
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
