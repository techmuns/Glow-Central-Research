// portfolio/position-by.js — the portfolio sliced by sector, market cap band or conviction tier.
//
// THIS PROMPT: presentation only. Rows here are groups rather than companies, so no Signals
// column and no legend — there is nothing per-company to score on this view.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber, formatDate, toneForValue } from '../core/format.js';
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

// Market cap bands in ₹ crore, using SEBI-style cut-offs.
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
    const e = groups.get(key) || { group: key, positions: 0, invested: 0, marketValue: 0, tickers: [] };
    e.positions += 1;
    e.invested += row.invested;
    e.marketValue += row.marketValue;
    e.tickers.push(row.ticker);
    groups.set(key, e);
  }
  return Array.from(groups.values()).map((e) => ({
    ...e,
    pnl: e.marketValue - e.invested,
    pnlPct: e.invested ? ((e.marketValue - e.invested) / e.invested) * 100 : 0,
    weightPct: total ? (e.marketValue / total) * 100 : 0,
    tickerList: e.tickers.join(', '),
  }));
}

function weightBar(pct) {
  return `
    <span class="inline-flex items-center justify-end gap-2">
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}
function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}

function drillGroup(group, isPortfolio) {
  openDrill({
    name: group.group,
    sub: `${group.positions} position${group.positions === 1 ? '' : 's'} · ${group.tickerList}`,
    headerStats: [
      { label: 'Weight', value: `${group.weightPct.toFixed(1)}%`, caption: isPortfolio ? 'of market value' : 'of universe market cap' },
      isPortfolio
        ? { label: 'Slice P&L', value: formatPct(group.pnlPct), tone: toneForValue(group.pnlPct) }
        : { label: 'Companies', value: formatNumber(group.positions), caption: 'in this slice' },
    ],
    groups: [
      {
        category: 'Slice totals',
        items: [
          { label: isPortfolio ? 'Market value' : 'Aggregate market cap', status: null, value: formatRupee(group.marketValue, { decimals: 0 }), note: `${group.weightPct.toFixed(1)}% of the total` },
          ...(isPortfolio
            ? [{ label: 'Invested', criteria: 'Cost basis for this slice', status: null, value: formatRupee(group.invested, { decimals: 0 }), note: `Unrealised ${formatRupee(group.pnl, { decimals: 0 })} (${formatPct(group.pnlPct)})` }]
            : []),
          { label: 'Constituents', status: null, value: group.tickerList, note: `${group.positions} name${group.positions === 1 ? '' : 's'}.` },
        ],
      },
      {
        category: 'Not yet built',
        items: [
          { label: 'Target weight & drift', criteria: 'Actual vs intended allocation', status: 'na', value: '', note: 'Target weights arrive in prompt 7.' },
          { label: 'Slice XIRR contribution', criteria: 'Return attribution per slice', status: 'na', value: '', note: 'Prompt 7.' },
          { label: 'Concentration risk flags', criteria: 'Top-5 weight, single-name cap', status: 'na', value: '', note: 'Prompt 7.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  const holdings = enrichHoldings(ctx.data?.portfolio?.holdings || []);
  const universeByTicker = new Map((ctx.data?.universe || []).map((c) => [c.ticker, c]));
  const isPortfolio = ctx.scope === 'portfolio';

  // Under Universe scope the same slicing runs over the whole coverage list. Universe rows
  // have no cost basis, so "weight" means share of aggregate market cap and P&L is omitted.
  const rows = isPortfolio
    ? holdings
    : (ctx.data?.universe || []).map((c) => ({ ticker: c.ticker, name: c.name, sector: c.sector, convictionTier: 'Not held', invested: 0, marketValue: c.marketCap }));

  const groups = buildGroups(rows, ctx.subview, universeByTicker);
  const largest = groups.slice().sort((a, b) => b.weightPct - a.weightPct)[0];
  const best = groups.slice().sort((a, b) => b.pnlPct - a.pnlPct)[0];
  const sliceLabel = ctx.subview === 'market-cap' ? 'Cap bands' : ctx.subview === 'conviction' ? 'Conviction tiers' : 'Sectors';

  const stats = statStrip([
    { label: sliceLabel, value: formatNumber(groups.length), note: `${rows.length} ${isPortfolio ? 'holdings' : 'companies'}` },
    { label: 'Largest slice', value: largest ? largest.group.split(' (')[0] : '—', note: largest ? `${largest.weightPct.toFixed(1)}% of ${isPortfolio ? 'book' : 'universe'}` : '' },
    isPortfolio
      ? {
          label: 'Best performing',
          value: best ? best.group.split(' (')[0] : '—',
          note: best ? formatPct(best.pnlPct) : '',
          help: {
            title: 'How slices are weighted',
            body: `<p>Weight is a slice's <strong>market value as a share of the whole book</strong>, and slice P&L is the aggregate cost basis compared to aggregate market value.</p>
                   <p class="mt-2">Under <strong>Universe</strong> scope there is no cost basis, so weight becomes share of aggregate market cap and P&L is not shown at all rather than displayed as zero.</p>
                   <p class="mt-3 text-slate-500">Target weights, drift alerts and per-slice XIRR arrive in prompt 7.</p>`,
          },
        }
      : { label: 'Widest slice', value: largest ? `${largest.positions}` : '—', note: 'companies in the largest band' },
    { hero: true, label: 'Last Refresh', value: ctx.data?.portfolio?.asOf ? formatDate(ctx.data.portfolio.asOf) : '—', note: isPortfolio ? 'Holdings snapshot · user-maintained' : 'Coverage list · quarterly' },
  ]);

  const ranked = groups.slice().sort((a, b) => b.weightPct - a.weightPct);
  const cards = topCards({
    title: `Slices by Weight — ${sliceLabel}`,
    items: ranked.map((g) => ({
      name: g.group,
      sub: `${g.positions} ${isPortfolio ? 'position' : 'company'}${g.positions === 1 ? '' : 's'}`,
      value: `${g.weightPct.toFixed(1)}%`,
      tone: 'brand',
      caption: isPortfolio ? `P&L ${formatPct(g.pnlPct)}` : g.tickers.slice(0, 2).join(', '),
      payload: g,
    })),
    valueFormat: 'metric',
    limit: 10,
    onSelect: (item) => drillGroup(item.payload, isPortfolio),
  });

  const columns = [
    { label: 'Positions', get: (r) => formatNumber(r.positions), align: 'right', sortValue: (r) => r.positions },
    { label: 'Constituents', get: (r) => `<span class="block max-w-xs truncate text-slate-500">${r.tickerList}</span>`, html: true, sortable: false },
    { label: isPortfolio ? 'Market Value' : 'Aggregate Cap', get: (r) => formatRupee(r.marketValue, { decimals: 0 }), align: 'right', sortValue: (r) => r.marketValue },
    { label: 'Weight', get: (r) => weightBar(r.weightPct), html: true, align: 'right', sortValue: (r) => r.weightPct },
  ];
  if (isPortfolio) {
    columns.splice(3, 0, { label: 'Invested', get: (r) => formatRupee(r.invested, { decimals: 0 }), align: 'right', sortValue: (r) => r.invested });
    columns.push({ label: 'P&L %', get: (r) => pctCell(r.pnlPct), html: true, align: 'right', sortValue: (r) => r.pnlPct });
  }

  const table = scoreTable({
    rows: groups,
    key: (r) => r.group,
    name: (r) => r.group,
    nameLabel: 'Slice',
    sub: (r) => `${r.positions} ${isPortfolio ? 'position' : 'company'}${r.positions === 1 ? '' : 's'}`,
    columns,
    searchable: (r) => `${r.group} ${r.tickerList}`,
    initialSort: { key: 'Weight', dir: 'desc' },
    onRowClick: (row) => drillGroup(row, isPortfolio),
    emptyMessage: 'No slices match your search.',
    exportName: `sattva-position-by-${ctx.subview}`,
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: describe(ctx.subview, ctx.scope), meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: isPortfolio ? 'holdings' : 'companies' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
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
