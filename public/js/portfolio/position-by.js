// portfolio/position-by.js — the portfolio sliced by sector, market cap band or conviction tier.
// THIS PROMPT: structure + placeholder panel only. Richer grouping/charts land in prompt 7.

import { sectionHeader, statCard, scopeSummary, dataTable, comingSoonStrip } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber, toneForValue } from '../core/format.js';
import { enrichHoldings } from './overview.js';

export const meta = {
  id: 'position-by',
  title: 'Position By',
  subtitle: 'The portfolio sliced by sector, market cap band and conviction tier.',
  subviews: [
    { id: 'sector', label: 'Sector' },
    { id: 'market-cap', label: 'Market Cap' },
    { id: 'conviction', label: 'Conviction' },
  ],
};

const FEATURES = [
  'Donut + treemap allocation charts',
  'Target vs actual weight drift tracking',
  'Concentration risk flags (top-5 weight, single-name cap)',
  'Custom user-defined grouping tags',
  'Slice-level XIRR contribution',
  'Rebalancing suggestions',
];

// Market cap bands in ₹ crore — India-standard SEBI-style cut-offs, kept simple for now.
function marketCapBand(marketCap) {
  if (marketCap === undefined || marketCap === null) return 'Unclassified';
  if (marketCap >= 200000) return 'Mega Cap (> ₹2 L Cr)';
  if (marketCap >= 50000) return 'Large Cap (₹50k Cr – ₹2 L Cr)';
  if (marketCap >= 17000) return 'Mid Cap (₹17k – ₹50k Cr)';
  return 'Small Cap (< ₹17k Cr)';
}

function groupKeyFor(subview, row, universeByTicker) {
  if (subview === 'market-cap') return marketCapBand(universeByTicker.get(row.ticker)?.marketCap);
  if (subview === 'conviction') return row.convictionTier;
  return row.sector;
}

function buildGroups(rows, subview, universeByTicker) {
  const total = rows.reduce((s, r) => s + r.marketValue, 0);
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyFor(subview, row, universeByTicker);
    const entry = groups.get(key) || { group: key, positions: 0, invested: 0, marketValue: 0, tickers: [] };
    entry.positions += 1;
    entry.invested += row.invested;
    entry.marketValue += row.marketValue;
    entry.tickers.push(row.ticker);
    groups.set(key, entry);
  }
  return Array.from(groups.values()).map((e) => ({
    ...e,
    pnl: e.marketValue - e.invested,
    pnlPct: e.invested ? ((e.marketValue - e.invested) / e.invested) * 100 : 0,
    weightPct: total ? (e.marketValue / total) * 100 : 0,
    tickerList: e.tickers.join(', '),
  }));
}

const COLUMNS = [
  { key: 'group', label: 'Group', render: (r) => `<span class="font-semibold text-slate-800">${r.group}</span>` },
  { key: 'positions', label: 'Positions', align: 'right', render: (r) => formatNumber(r.positions) },
  { key: 'tickerList', label: 'Holdings', sortable: false, render: (r) => `<span class="block max-w-xs truncate text-slate-500" title="${r.tickerList}">${r.tickerList}</span>` },
  { key: 'invested', label: 'Invested', align: 'right', render: (r) => formatRupee(r.invested, { decimals: 0 }) },
  { key: 'marketValue', label: 'Market Value', align: 'right', render: (r) => formatRupee(r.marketValue, { decimals: 0 }) },
  { key: 'weightPct', label: 'Weight', align: 'right', render: (r) => weightBar(r.weightPct) },
  { key: 'pnlPct', label: 'P&L %', align: 'right', render: (r) => pctCell(r.pnlPct) },
];

function weightBar(pct) {
  return `
    <span class="inline-flex items-center justify-end gap-2">
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-violet-500 to-teal-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}
function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}

function buildStats(groups, rows, subview) {
  const largest = groups.slice().sort((a, b) => b.weightPct - a.weightPct)[0];
  const best = groups.slice().sort((a, b) => b.pnlPct - a.pnlPct)[0];
  const label = subview === 'market-cap' ? 'Cap bands' : subview === 'conviction' ? 'Conviction tiers' : 'Sectors';
  return [
    { label, value: formatNumber(groups.length) },
    { label: 'Positions', value: formatNumber(rows.length) },
    { label: 'Largest slice', value: largest ? largest.group : '—', sublabel: largest ? `${largest.weightPct.toFixed(1)}% of book` : undefined },
    { label: 'Best performing', value: best ? best.group : '—', delta: best ? formatPct(best.pnlPct) : null, deltaTone: best ? toneForValue(best.pnlPct) : 'neutral' },
  ];
}

export function render(ctx) {
  const holdings = enrichHoldings(ctx.data?.portfolio?.holdings || []);
  const universeByTicker = new Map((ctx.data?.universe || []).map((c) => [c.ticker, c]));

  // Under Universe scope this tab groups the whole coverage list instead of just held names;
  // universe rows have no cost basis, so weight is by market cap and P&L columns read as zero.
  const rows =
    ctx.scope === 'universe'
      ? (ctx.data?.universe || []).map((c) => ({ ticker: c.ticker, name: c.name, sector: c.sector, convictionTier: 'Not held', invested: 0, marketValue: c.marketCap }))
      : holdings;

  const groups = buildGroups(rows, ctx.subview, universeByTicker);
  const table = dataTable({ columns: COLUMNS, rows: groups, initialSort: { key: 'marketValue', dir: 'desc' } });

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: describe(ctx.subview, ctx.scope),
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: ctx.scope === 'portfolio' ? 'holdings' : 'companies' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(groups, rows, ctx.subview)
      .map((s) => statCard(s))
      .join('')}</div>
    <div id="position-by-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#position-by-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

function describe(subview, scope) {
  const noun = scope === 'portfolio' ? 'portfolio' : 'coverage universe';
  if (subview === 'market-cap') return `The ${noun} grouped into mega / large / mid / small cap bands.`;
  if (subview === 'conviction') return `The ${noun} grouped by conviction tier (Core, High Conviction, Tracking).`;
  return `The ${noun} grouped by sector, ranked by weight.`;
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
