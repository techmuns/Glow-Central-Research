// portfolio/overview.js — holdings table + allocation breakdown for the tracked portfolio.
// THIS PROMPT: structure + placeholder panel only. Real P&L attribution lands in prompt 7.
// Note: this tab is inherently portfolio-shaped, but it still honours the global scope toggle —
// under "Universe" it widens to show every universe name alongside the held ones.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, spark, comingSoonStrip } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber, formatCroreCompact, toneForValue } from '../core/format.js';

export const meta = {
  id: 'overview',
  title: 'Overview',
  subtitle: 'Current holdings, market value and unrealised P&L at a glance.',
  subviews: [
    { id: 'positions', label: 'Positions' },
    { id: 'allocation', label: 'Allocation' },
  ],
};

const FEATURES = [
  'Live mark-to-market from the technicals feed',
  'XIRR and absolute return per position',
  'Realised vs unrealised P&L split',
  'Benchmark comparison (Nifty 50 / Nifty 500)',
  'Dividend and corporate-action adjustments',
  'Allocation drift alerts vs target weights',
];

// Derive per-position metrics from qty/avgPrice/lastPrice. Once the live technicals feed lands
// (prompt 2) `lastPrice` comes from there instead of the mock file — the math is unchanged.
export function enrichHoldings(holdings = []) {
  return holdings.map((h) => {
    const invested = h.qty * h.avgPrice;
    const marketValue = h.qty * h.lastPrice;
    const pnl = marketValue - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    return { ...h, invested, marketValue, pnl, pnlPct };
  });
}

const POSITION_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'convictionTier', label: 'Conviction', render: (r) => pill({ label: r.convictionTier, tone: convictionTone(r.convictionTier) }) },
  { key: 'qty', label: 'Qty', align: 'right', render: (r) => formatNumber(r.qty) },
  { key: 'avgPrice', label: 'Avg Price', align: 'right', render: (r) => formatRupee(r.avgPrice) },
  { key: 'lastPrice', label: 'Last', align: 'right', render: (r) => formatRupee(r.lastPrice) },
  { key: 'marketValue', label: 'Market Value', align: 'right', render: (r) => formatRupee(r.marketValue, { decimals: 0 }) },
  { key: 'pnl', label: 'P&L', align: 'right', render: (r) => moneyCell(r.pnl) },
  { key: 'pnlPct', label: 'P&L %', align: 'right', render: (r) => pctCell(r.pnlPct) },
  { key: 'trend', label: 'Trend', sortable: false, render: (r) => spark({ values: trendSeries(r), tone: r.pnl >= 0 ? 'positive' : 'negative' }) },
];

const ALLOCATION_COLUMNS = [
  { key: 'sector', label: 'Sector', render: (r) => `<span class="font-semibold text-slate-800">${r.sector}</span>` },
  { key: 'positions', label: 'Positions', align: 'right', render: (r) => formatNumber(r.positions) },
  { key: 'marketValue', label: 'Market Value', align: 'right', render: (r) => formatRupee(r.marketValue, { decimals: 0 }) },
  { key: 'weightPct', label: 'Weight', align: 'right', render: (r) => weightBar(r.weightPct) },
  { key: 'pnlPct', label: 'P&L %', align: 'right', render: (r) => pctCell(r.pnlPct) },
];

const UNIVERSE_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'marketCap', label: 'Market Cap', align: 'right', render: (r) => formatCroreCompact(r.marketCap) },
  { key: 'held', label: 'In portfolio', render: (r) => (r.held ? pill({ label: 'Held', tone: 'positive' }) : pill({ label: 'Watchlist', tone: 'neutral' })) },
];

function convictionTone(tier) {
  if (tier === 'Core') return 'brand';
  if (tier === 'High Conviction') return 'accent';
  return 'neutral';
}
function moneyCell(value) {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${formatRupee(value, { decimals: 0 })}</span>`;
}
function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}
function weightBar(pct) {
  return `
    <span class="inline-flex items-center justify-end gap-2">
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-teal-500 to-emerald-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}

// Deterministic pseudo-series purely so the sparkline column has a shape to draw. Replaced by
// real price history once the technicals feed lands.
function trendSeries(row) {
  const start = row.avgPrice;
  const end = row.lastPrice;
  return Array.from({ length: 8 }, (_, i) => {
    const t = i / 7;
    const wobble = Math.sin(i * 1.7 + row.ticker.length) * (Math.abs(end - start) * 0.12);
    return start + (end - start) * t + wobble;
  });
}

function buildAllocation(rows) {
  const total = rows.reduce((s, r) => s + r.marketValue, 0);
  const bySector = new Map();
  for (const r of rows) {
    const entry = bySector.get(r.sector) || { sector: r.sector, positions: 0, marketValue: 0, invested: 0 };
    entry.positions += 1;
    entry.marketValue += r.marketValue;
    entry.invested += r.invested;
    bySector.set(r.sector, entry);
  }
  return Array.from(bySector.values()).map((e) => ({
    ...e,
    weightPct: total ? (e.marketValue / total) * 100 : 0,
    pnlPct: e.invested ? ((e.marketValue - e.invested) / e.invested) * 100 : 0,
  }));
}

function portfolioStats(rows) {
  const invested = rows.reduce((s, r) => s + r.invested, 0);
  const marketValue = rows.reduce((s, r) => s + r.marketValue, 0);
  const pnl = marketValue - invested;
  const pnlPct = invested ? (pnl / invested) * 100 : 0;
  const winners = rows.filter((r) => r.pnl > 0).length;
  return [
    { label: 'Market value', value: formatRupee(marketValue, { decimals: 0 }) },
    { label: 'Invested', value: formatRupee(invested, { decimals: 0 }) },
    { label: 'Unrealised P&L', value: `${pnl > 0 ? '+' : ''}${formatRupee(pnl, { decimals: 0 })}`, delta: formatPct(pnlPct), deltaTone: toneForValue(pnl) },
    { label: 'Winners', value: `${winners} / ${rows.length}`, sublabel: 'positions in profit' },
  ];
}

export function render(ctx) {
  const holdings = enrichHoldings(ctx.data?.portfolio?.holdings || []);

  if (ctx.scope === 'universe') return renderUniverse(ctx, holdings);

  const stats = portfolioStats(holdings);
  const isAllocation = ctx.subview === 'allocation';
  const rows = isAllocation ? buildAllocation(holdings) : holdings;
  const table = isAllocation
    ? dataTable({ columns: ALLOCATION_COLUMNS, rows, initialSort: { key: 'marketValue', dir: 'desc' } })
    : dataTable({ columns: POSITION_COLUMNS, rows, initialSort: { key: 'marketValue', dir: 'desc' } });

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: isAllocation ? 'Sector-level weight and P&L across the tracked portfolio.' : meta.subtitle,
      meta: scopeSummary({ scope: ctx.scope, count: holdings.length, noun: 'holdings' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${stats.map((s) => statCard(s)).join('')}</div>
    <div id="overview-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#overview-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

// Universe scope: the same tab widens from "my 12 holdings" to the full coverage list, flagging
// which names are already held.
function renderUniverse(ctx, holdings) {
  const held = new Set(holdings.map((h) => h.ticker));
  const rows = (ctx.data?.universe || []).map((c) => ({ ...c, held: held.has(c.ticker) }));
  const stats = [
    { label: 'Universe size', value: formatNumber(rows.length) },
    { label: 'Held', value: formatNumber(held.size), deltaTone: 'positive' },
    { label: 'Watchlist only', value: formatNumber(rows.length - held.size) },
    { label: 'Sectors', value: formatNumber(new Set(rows.map((r) => r.sector)).size) },
  ];
  const table = dataTable({ columns: UNIVERSE_COLUMNS, rows, initialSort: { key: 'marketCap', dir: 'desc' } });

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: 'Scope is set to Universe — showing full coverage with held names flagged. Switch to Portfolio for P&L.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${stats.map((s) => statCard(s)).join('')}</div>
    <div id="overview-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#overview-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
