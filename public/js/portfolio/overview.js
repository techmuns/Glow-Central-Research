// portfolio/overview.js — holdings table + allocation breakdown for the tracked portfolio.
//
// THIS PROMPT: presentation only. `enrichHoldings` stays exported — position-by.js and
// drawdown.js both build on it, so the cost-basis maths lives in exactly one place.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber, formatCroreCompact, formatDate, toneForValue } from '../core/format.js';

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

// Derive per-position metrics. Once the live technicals feed lands (prompt 2) `lastPrice`
// comes from there instead of the mock file — the maths below is unchanged.
export function enrichHoldings(holdings = []) {
  return holdings.map((h) => {
    const invested = h.qty * h.avgPrice;
    const marketValue = h.qty * h.lastPrice;
    const pnl = marketValue - invested;
    const pnlPct = invested ? (pnl / invested) * 100 : 0;
    return { ...h, invested, marketValue, pnl, pnlPct };
  });
}

const HOLDING_SIGNALS = (r) => [
  { label: 'Position in profit', status: r.pnl > 0 ? 'pass' : 'fail' },
  { label: 'Beating +10%', status: r.pnlPct >= 10 ? 'pass' : r.pnlPct >= 0 ? 'partial' : 'fail' },
  { label: 'Trading above cost', status: r.lastPrice >= r.avgPrice ? 'pass' : 'fail' },
  { label: 'Within 10% of 52w high', status: r.high52w && r.lastPrice >= r.high52w * 0.9 ? 'pass' : r.high52w && r.lastPrice >= r.high52w * 0.8 ? 'partial' : 'fail' },
  { label: 'Core conviction', status: r.convictionTier === 'Core' ? 'pass' : r.convictionTier === 'High Conviction' ? 'partial' : 'na' },
];

function convictionPill(tier) {
  const cls = tier === 'Core' ? 'bg-indigo-50 text-indigo-700 ring-indigo-200' : tier === 'High Conviction' ? 'bg-purple-50 text-purple-700 ring-purple-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${tier}</span>`;
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
      <span class="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100"><span class="block h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>
      <span class="w-12 text-right font-semibold text-slate-600">${pct.toFixed(1)}%</span>
    </span>`;
}

function drillHolding(row) {
  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.convictionTier}`,
    headerStats: [
      { label: 'Unrealised P&L', value: `${row.pnl > 0 ? '+' : ''}${formatRupee(row.pnl, { decimals: 0 })}`, caption: formatPct(row.pnlPct), tone: toneForValue(row.pnl) },
      { label: 'Market value', value: formatRupee(row.marketValue, { decimals: 0 }), caption: `${formatNumber(row.qty)} shares` },
    ],
    groups: [
      {
        category: 'Position',
        items: [
          { label: 'Quantity', status: null, value: formatNumber(row.qty), note: `Average cost ${formatRupee(row.avgPrice)}` },
          { label: 'Cost basis', criteria: 'Quantity × average price', status: null, value: formatRupee(row.invested, { decimals: 0 }), note: 'Excludes brokerage and charges — prompt 7 adds those separately.' },
          { label: 'Last price', status: null, value: formatRupee(row.lastPrice), note: 'Placeholder from portfolio.json; the technicals feed supersedes it in prompt 2.' },
          { label: '52-week high', status: null, value: formatRupee(row.high52w), note: `Currently ${formatPct(((row.lastPrice - row.high52w) / row.high52w) * 100)} from peak.` },
        ],
      },
      { category: 'Signal readings', items: HOLDING_SIGNALS(row).map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of the position, no model applied.' })) },
      {
        category: 'Not yet built',
        items: [
          { label: 'XIRR', criteria: 'Time-weighted return for this position', status: 'na', value: '', note: 'Needs the transaction ledger joined to price history — prompt 7.' },
          { label: 'Benchmark comparison', criteria: 'vs Nifty 50 / Nifty 500', status: 'na', value: '', note: 'Prompt 7.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  const holdings = enrichHoldings(ctx.data?.portfolio?.holdings || []);
  if (ctx.scope === 'universe') return renderUniverse(ctx, holdings);
  if (ctx.subview === 'allocation') return renderAllocation(ctx, holdings);
  return renderPositions(ctx, holdings);
}

function portfolioStats(ctx, rows) {
  const invested = rows.reduce((s, r) => s + r.invested, 0);
  const marketValue = rows.reduce((s, r) => s + r.marketValue, 0);
  const pnl = marketValue - invested;
  const pnlPct = invested ? (pnl / invested) * 100 : 0;
  const winners = rows.filter((r) => r.pnl > 0).length;
  return statStrip([
    { label: 'Market value', value: formatRupee(marketValue, { decimals: 0 }), note: `${rows.length} positions` },
    { label: 'Invested', value: formatRupee(invested, { decimals: 0 }), note: 'cost basis, ex-charges' },
    {
      label: 'Unrealised P&L',
      value: `${pnl > 0 ? '+' : ''}${formatRupee(pnl, { decimals: 0 })}`,
      note: `${formatPct(pnlPct)} · ${winners} of ${rows.length} in profit`,
      help: {
        title: 'How P&L is calculated',
        body: `<p>Per position: <code class="rounded bg-slate-100 px-1">(last price − average cost) × quantity</code>.</p>
               <p class="mt-2">Cost basis excludes brokerage, STT and other charges — those get their own line in prompt 7 rather than being folded into the average price.</p>
               <p class="mt-3 text-slate-500">Last price is a placeholder in <code class="rounded bg-slate-100 px-1">portfolio.json</code> today. When the Yahoo Finance EOD feed lands in prompt 2 it becomes a real mark-to-market, and the formula does not change. Realised P&L and XIRR arrive in prompt 7.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: ctx.data?.portfolio?.asOf ? formatDate(ctx.data.portfolio.asOf) : '—', note: 'Holdings snapshot · user-maintained' },
  ]);
}

function renderPositions(ctx, holdings) {
  const stats = portfolioStats(ctx, holdings);
  const ranked = holdings.slice().sort((a, b) => b.pnlPct - a.pnlPct);

  const cards = topCards({
    title: 'Top 10 by Unrealised P&L %',
    items: ranked.map((h) => ({
      name: h.name,
      sub: `${h.ticker} · ${h.sector}`,
      value: formatPct(h.pnlPct),
      tone: h.pnlPct > 0 ? 'positive' : h.pnlPct < 0 ? 'negative' : 'neutral',
      caption: `${h.pnl > 0 ? '+' : ''}${formatRupee(h.pnl, { decimals: 0 })}`,
      payload: h,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillHolding(item.payload),
  });

  const table = scoreTable({
    rows: holdings,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    showSignals: true,
    signals: HOLDING_SIGNALS,
    columns: [
      { label: 'Conviction', get: (r) => convictionPill(r.convictionTier), html: true, sortValue: (r) => r.convictionTier },
      { label: 'Qty', get: (r) => formatNumber(r.qty), align: 'right', sortValue: (r) => r.qty },
      { label: 'Avg Price', get: (r) => formatRupee(r.avgPrice), align: 'right', sortValue: (r) => r.avgPrice },
      { label: 'Last', get: (r) => formatRupee(r.lastPrice), align: 'right', sortValue: (r) => r.lastPrice },
      { label: 'Market Value', get: (r) => formatRupee(r.marketValue, { decimals: 0 }), align: 'right', sortValue: (r) => r.marketValue },
      { label: 'P&L', get: (r) => moneyCell(r.pnl), html: true, align: 'right', sortValue: (r) => r.pnl },
      { label: 'P&L %', get: (r) => pctCell(r.pnlPct), html: true, align: 'right', sortValue: (r) => r.pnlPct },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All positions' },
        { value: 'winners', label: 'In profit' },
        { value: 'losers', label: 'In loss' },
        { value: 'Core', label: 'Core only' },
        { value: 'High Conviction', label: 'High conviction' },
      ],
      match: (r, v) => (v === 'winners' ? r.pnl > 0 : v === 'losers' ? r.pnl < 0 : r.convictionTier === v),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: { key: 'Market Value', dir: 'desc' },
    onRowClick: drillHolding,
    exportName: 'sattva-positions',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: meta.subtitle, meta: scopeSummary({ scope: ctx.scope, count: holdings.length, noun: 'holdings' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals read the position directly. XIRR and benchmark-relative scoring arrive in prompt 7.' })}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

function renderAllocation(ctx, holdings) {
  const total = holdings.reduce((s, r) => s + r.marketValue, 0);
  const bySector = new Map();
  for (const r of holdings) {
    const e = bySector.get(r.sector) || { sector: r.sector, positions: 0, marketValue: 0, invested: 0, tickers: [] };
    e.positions += 1;
    e.marketValue += r.marketValue;
    e.invested += r.invested;
    e.tickers.push(r.ticker);
    bySector.set(r.sector, e);
  }
  const rows = Array.from(bySector.values()).map((e) => ({
    ...e,
    weightPct: total ? (e.marketValue / total) * 100 : 0,
    pnlPct: e.invested ? ((e.marketValue - e.invested) / e.invested) * 100 : 0,
    tickerList: e.tickers.join(', '),
  }));

  const stats = portfolioStats(ctx, holdings);
  const ranked = rows.slice().sort((a, b) => b.weightPct - a.weightPct);

  const cards = topCards({
    title: 'Sectors by Portfolio Weight',
    items: ranked.map((r) => ({
      name: r.sector,
      sub: `${r.positions} position${r.positions === 1 ? '' : 's'}`,
      value: `${r.weightPct.toFixed(1)}%`,
      tone: 'brand',
      caption: `P&L ${formatPct(r.pnlPct)}`,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => {
      const g = item.payload;
      openDrill({
        name: g.sector,
        sub: `${g.positions} positions · ${g.tickerList}`,
        headerStats: [
          { label: 'Weight', value: `${g.weightPct.toFixed(1)}%`, caption: 'of market value' },
          { label: 'Sector P&L', value: formatPct(g.pnlPct), tone: toneForValue(g.pnlPct) },
        ],
        groups: [
          {
            category: 'Sector totals',
            items: [
              { label: 'Market value', status: null, value: formatRupee(g.marketValue, { decimals: 0 }), note: `${g.weightPct.toFixed(1)}% of the book` },
              { label: 'Invested', status: null, value: formatRupee(g.invested, { decimals: 0 }), note: `Unrealised ${formatRupee(g.marketValue - g.invested, { decimals: 0 })}` },
              { label: 'Holdings', status: null, value: g.tickerList, note: `${g.positions} position${g.positions === 1 ? '' : 's'} in this sector.` },
            ],
          },
          {
            category: 'Not yet built',
            items: [{ label: 'Target weight & drift', criteria: 'Actual vs intended allocation', status: 'na', value: '', note: 'Target weights and drift alerts arrive in prompt 7.' }],
          },
        ],
      });
    },
  });

  const table = scoreTable({
    rows,
    key: (r) => r.sector,
    name: (r) => r.sector,
    nameLabel: 'Sector',
    sub: (r) => `${r.positions} position${r.positions === 1 ? '' : 's'}`,
    columns: [
      { label: 'Holdings', get: (r) => `<span class="block max-w-xs truncate text-slate-500">${r.tickerList}</span>`, html: true, sortable: false },
      { label: 'Market Value', get: (r) => formatRupee(r.marketValue, { decimals: 0 }), align: 'right', sortValue: (r) => r.marketValue },
      { label: 'Weight', get: (r) => weightBar(r.weightPct), html: true, align: 'right', sortValue: (r) => r.weightPct },
      { label: 'P&L %', get: (r) => pctCell(r.pnlPct), html: true, align: 'right', sortValue: (r) => r.pnlPct },
    ],
    searchable: (r) => `${r.sector} ${r.tickerList}`,
    initialSort: { key: 'Market Value', dir: 'desc' },
    exportName: 'sattva-allocation',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: 'Sector-level weight and P&L across the tracked portfolio.', meta: scopeSummary({ scope: ctx.scope, count: holdings.length, noun: 'holdings' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

// Universe scope: the tab widens from "my holdings" to the full coverage list, flagging which
// names are already held. No P&L exists for names outside the book, so none is shown.
function renderUniverse(ctx, holdings) {
  const held = new Set(holdings.map((h) => h.ticker));
  const rows = (ctx.data?.universe || []).map((c) => ({ ...c, held: held.has(c.ticker) }));

  const stats = statStrip([
    { label: 'Universe size', value: formatNumber(rows.length), note: 'companies covered' },
    { label: 'Held', value: formatNumber(held.size), note: `${rows.length - held.size} watchlist only` },
    { label: 'Sectors', value: formatNumber(new Set(rows.map((r) => r.sector)).size), note: 'represented in coverage' },
    { hero: true, label: 'Last Refresh', value: ctx.data?.portfolio?.asOf ? formatDate(ctx.data.portfolio.asOf) : '—', note: 'Coverage list · quarterly' },
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    columns: [
      { label: 'Industry', get: (r) => r.industry },
      { label: 'Market Cap', get: (r) => formatCroreCompact(r.marketCap), align: 'right', sortValue: (r) => r.marketCap },
      {
        label: 'In portfolio',
        get: (r) =>
          r.held
            ? '<span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">Held</span>'
            : '<span class="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">Watchlist</span>',
        html: true,
        sortValue: (r) => (r.held ? 1 : 0),
      },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All companies' },
        { value: 'held', label: 'Held only' },
        { value: 'watch', label: 'Not held' },
      ],
      match: (r, v) => (v === 'held' ? r.held : !r.held),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector} ${r.industry}`,
    initialSort: { key: 'Market Cap', dir: 'desc' },
    exportName: 'sattva-universe',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Scope is set to Universe — showing full coverage with held names flagged. Switch to Portfolio for P&L.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies' }),
    })}
    ${stats.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  table.wire(ctx.root);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
