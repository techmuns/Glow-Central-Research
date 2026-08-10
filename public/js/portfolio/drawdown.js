// portfolio/drawdown.js — how far the book and each position sit below their highs.
//
// THIS PROMPT: presentation only. Per-position drawdown is computed from the mock `high52w`
// in portfolio.json, which is real enough to rank and signal on. The portfolio-level equity
// curve genuinely needs daily price history (prompt 2), so it keeps an honest pending panel
// rather than a drawn-from-nothing chart.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip, pendingPanel } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber, formatDate, formatCroreCompact } from '../core/format.js';
import { enrichHoldings } from './overview.js';

export const meta = {
  id: 'drawdown',
  title: 'Drawdown',
  subtitle: 'Distance from peak, at the book level and per position.',
  subviews: [
    { id: 'portfolio', label: 'Portfolio' },
    { id: 'per-position', label: 'Per Position' },
  ],
};

const FEATURES = [
  'Daily portfolio equity curve with peak/trough markers',
  'Max drawdown and recovery-time statistics',
  'Underwater plot vs Nifty 50',
  'Per-position drawdown from true rolling 52w high',
  'Volatility and downside-deviation metrics',
  'Drawdown alerts at user-set thresholds',
];

function withDrawdown(holdings) {
  return holdings.map((h) => {
    const drawdownPct = h.high52w ? ((h.lastPrice - h.high52w) / h.high52w) * 100 : 0;
    const valueAtHigh = h.qty * (h.high52w || h.lastPrice);
    return { ...h, drawdownPct, valueAtHigh, valueLostFromHigh: h.marketValue - valueAtHigh };
  });
}

const DRAWDOWN_SIGNALS = (r) => [
  { label: 'Within 3% of 52w high', status: r.drawdownPct > -3 ? 'pass' : 'fail' },
  { label: 'Shallower than −10%', status: r.drawdownPct > -10 ? 'pass' : r.drawdownPct > -15 ? 'partial' : 'fail' },
  { label: 'Shallower than −20%', status: r.drawdownPct > -20 ? 'pass' : 'hard_fail' },
  { label: 'Still above cost', status: r.pnl > 0 ? 'pass' : 'fail' },
];

function drawdownCell(pct) {
  const cls = pct <= -15 ? 'text-rose-600' : pct <= -5 ? 'text-amber-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(pct)}</span>`;
}
function severityPill(pct) {
  const [label, cls] =
    pct <= -20
      ? ['Deep', 'bg-rose-100 text-rose-800 ring-rose-300']
      : pct <= -10
        ? ['Moderate', 'bg-amber-50 text-amber-700 ring-amber-200']
        : pct <= -3
          ? ['Shallow', 'bg-slate-100 text-slate-600 ring-slate-200']
          : ['Near high', 'bg-emerald-50 text-emerald-700 ring-emerald-200'];
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${label}</span>`;
}

function drillDrawdown(row) {
  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.convictionTier}`,
    headerStats: [
      { label: 'Drawdown', value: formatPct(row.drawdownPct), caption: 'from 52-week high', tone: row.drawdownPct <= -10 ? 'negative' : row.drawdownPct <= -3 ? 'caution' : 'positive' },
      { label: 'Value vs peak', value: formatRupee(row.valueLostFromHigh, { decimals: 0 }), caption: 'if held since the high', tone: row.valueLostFromHigh < 0 ? 'negative' : 'neutral' },
    ],
    banner:
      row.drawdownPct <= -20
        ? { tone: 'rose', title: 'Deep drawdown', body: 'More than 20% below its 52-week high. A market condition, not necessarily a company problem — check the fundamentals before acting.' }
        : null,
    groups: [
      {
        category: 'Distance from peak',
        items: [
          { label: 'Last price', status: null, value: formatRupee(row.lastPrice), note: `52-week high ${formatRupee(row.high52w)}` },
          { label: 'Drawdown', criteria: '(last − 52w high) / 52w high', status: null, value: formatPct(row.drawdownPct), note: 'Computed from the mock 52-week high in portfolio.json.' },
          { label: 'Value at peak', criteria: 'Quantity × 52-week high', status: null, value: formatRupee(row.valueAtHigh, { decimals: 0 }), note: `Current market value ${formatRupee(row.marketValue, { decimals: 0 })}` },
        ],
      },
      { category: 'Signal readings', items: DRAWDOWN_SIGNALS(row).map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of price against the 52-week high.' })) },
      {
        category: 'Awaiting daily price history (prompt 2)',
        items: [
          { label: 'True rolling 52-week high', criteria: 'Recomputed daily from real closes', status: 'na', value: '', note: 'Today the high is a static field in the mock file.' },
          { label: 'Max drawdown & recovery time', criteria: 'Peak-to-trough and days to recover', status: 'na', value: '', note: 'Needs the full price series.' },
          { label: 'Downside deviation', criteria: 'Volatility of negative returns', status: 'na', value: '', note: 'Needs the full price series.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  if (ctx.scope === 'universe') return renderUniversePending(ctx);

  const holdings = withDrawdown(enrichHoldings(ctx.data?.portfolio?.holdings || []));
  const worst = holdings.slice().sort((a, b) => a.drawdownPct - b.drawdownPct)[0];
  const avg = holdings.length ? holdings.reduce((s, r) => s + r.drawdownPct, 0) / holdings.length : 0;
  const deep = holdings.filter((r) => r.drawdownPct <= -10).length;
  const nearHigh = holdings.filter((r) => r.drawdownPct > -3).length;

  const stats = statStrip([
    { label: 'Avg drawdown', value: formatPct(avg), note: 'mean distance from peak' },
    { label: 'Worst position', value: worst ? worst.ticker : '—', note: worst ? formatPct(worst.drawdownPct) : '' },
    {
      label: 'Below −10%',
      value: `${deep} of ${holdings.length}`,
      note: `${nearHigh} near their high`,
      help: {
        title: 'How drawdown is measured here',
        body: `<p>Per position: <code class="rounded bg-slate-100 px-1">(last price − 52-week high) / 52-week high</code>. It is always zero or negative.</p>
               <p class="mt-2">Severity bands: <strong>Near high</strong> above −3%, <strong>Shallow</strong> to −10%, <strong>Moderate</strong> to −20%, <strong>Deep</strong> beyond that.</p>
               <p class="mt-3 text-slate-500">Both the last price and the 52-week high are static placeholders in <code class="rounded bg-slate-100 px-1">portfolio.json</code> today. A true rolling high, book-level max drawdown and recovery statistics all need daily price history — that lands in prompt 2.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: ctx.data?.portfolio?.asOf ? formatDate(ctx.data.portfolio.asOf) : '—', note: 'Holdings snapshot · price feed pending' },
  ]);

  const ranked = holdings.slice().sort((a, b) => a.drawdownPct - b.drawdownPct);
  const cards = topCards({
    title: 'Deepest 10 by Drawdown from 52w High',
    items: ranked.map((h) => ({
      name: h.name,
      sub: `${h.ticker} · ${h.sector}`,
      value: formatPct(h.drawdownPct),
      tone: h.drawdownPct <= -10 ? 'negative' : h.drawdownPct <= -3 ? 'caution' : 'neutral',
      caption: `peak ${formatRupee(h.high52w)}`,
      warn: h.drawdownPct <= -20 ? 'More than 20% below its 52-week high' : null,
      payload: h,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillDrawdown(item.payload),
  });

  const table = scoreTable({
    rows: holdings,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    showSignals: true,
    signals: DRAWDOWN_SIGNALS,
    columns: [
      { label: 'Last', get: (r) => formatRupee(r.lastPrice), align: 'right', sortValue: (r) => r.lastPrice },
      { label: '52w High', get: (r) => formatRupee(r.high52w), align: 'right', sortValue: (r) => r.high52w },
      { label: 'Drawdown', get: (r) => drawdownCell(r.drawdownPct), html: true, align: 'right', sortValue: (r) => r.drawdownPct },
      { label: 'Value vs Peak', get: (r) => `<span class="font-semibold ${r.valueLostFromHigh < 0 ? 'text-rose-600' : 'text-slate-500'}">${formatRupee(r.valueLostFromHigh, { decimals: 0 })}</span>`, html: true, align: 'right', sortValue: (r) => r.valueLostFromHigh },
      { label: 'Severity', get: (r) => severityPill(r.drawdownPct), html: true, sortValue: (r) => r.drawdownPct },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All positions' },
        { value: 'deep', label: 'Deep (worse than −20%)' },
        { value: 'moderate', label: 'Moderate (−10% to −20%)' },
        { value: 'near', label: 'Near high (above −3%)' },
      ],
      match: (r, v) => (v === 'deep' ? r.drawdownPct <= -20 : v === 'moderate' ? r.drawdownPct <= -10 && r.drawdownPct > -20 : r.drawdownPct > -3),
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: { key: 'Drawdown', dir: 'asc' },
    onRowClick: drillDrawdown,
    exportName: 'sattva-drawdown',
  });

  const isBookLevel = ctx.subview === 'portfolio';

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: isBookLevel ? 'Book-level equity curve and max drawdown — needs daily price history from the next prompt.' : 'Each holding measured against its own 52-week high.',
      meta: scopeSummary({ scope: ctx.scope, count: holdings.length, noun: 'holdings' }),
    })}
    ${stats.html}
    ${
      isBookLevel
        ? `<div class="mb-6">${pendingPanel({
            title: 'Portfolio equity curve & underwater plot',
            body: 'Deliberately blank — an equity curve drawn without real daily closes would be fiction. Per-position drawdown below is already live off the 52-week highs in portfolio.json.',
            arriving: 'prompt 2',
          })}</div>`
        : ''
    }
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals read price against the 52-week high. Book-level max drawdown and recovery statistics arrive with the price feed in prompt 2.' })}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

// Universe-wide drawdown needs the price feed; nothing here is estimated in the meantime.
function renderUniversePending(ctx) {
  const universe = ctx.data?.universe || [];
  const stats = statStrip([
    { label: 'Universe size', value: formatNumber(universe.length), note: 'companies covered' },
    { label: 'Price history', value: 'Pending', note: 'no drawdown computable' },
    { label: 'Source', value: 'Yahoo EOD', note: 'NSE 500 · prompt 2' },
    { hero: true, label: 'Last Refresh', value: 'Not yet wired', note: 'Yahoo Finance EOD · arrives prompt 2' },
  ]);

  const table = scoreTable({
    rows: universe,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    columns: [
      { label: 'Sector', get: (r) => r.sector },
      { label: 'Market Cap', get: (r) => formatCroreCompact(r.marketCap), align: 'right', sortValue: (r) => r.marketCap },
      {
        label: 'Drawdown',
        get: () => '<span class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Pending</span>',
        html: true,
        sortable: false,
      },
    ],
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: { key: 'Market Cap', dir: 'desc' },
    exportName: 'sattva-universe',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Universe-wide drawdown needs the live price feed landing in the next prompt. Switch scope to Portfolio for per-holding drawdown.',
      meta: scopeSummary({ scope: ctx.scope, count: universe.length, noun: 'companies' }),
    })}
    ${stats.html}
    <div class="mb-6">${pendingPanel({ title: 'Universe drawdown distribution', body: 'No 52-week highs exist for names outside the portfolio until the price feed lands.', arriving: 'prompt 2' })}</div>
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  table.wire(ctx.root);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
