// portfolio/drawdown.js — how far the book and each position sit below their highs.
// THIS PROMPT: structure + placeholder panel only. Per-position drawdown uses the mock
// `high52w` in portfolio.json; the portfolio-level equity curve genuinely needs the price
// history arriving in prompt 2, so it shows an honest pending state rather than a fake chart.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, skeleton, comingSoonStrip } from '../ui/components.js';
import { formatRupee, formatPct, formatNumber } from '../core/format.js';
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

// Drawdown from 52-week high: how far below its own peak each holding currently trades.
function withDrawdown(holdings) {
  return holdings.map((h) => {
    const drawdownPct = h.high52w ? ((h.lastPrice - h.high52w) / h.high52w) * 100 : 0;
    const valueAtHigh = h.qty * (h.high52w || h.lastPrice);
    return { ...h, drawdownPct, valueAtHigh, valueLostFromHigh: h.marketValue - valueAtHigh };
  });
}

const COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'lastPrice', label: 'Last', align: 'right', render: (r) => formatRupee(r.lastPrice) },
  { key: 'high52w', label: '52w High', align: 'right', render: (r) => formatRupee(r.high52w) },
  { key: 'drawdownPct', label: 'Drawdown', align: 'right', render: (r) => drawdownCell(r.drawdownPct) },
  { key: 'valueLostFromHigh', label: 'Value vs peak', align: 'right', render: (r) => `<span class="font-semibold ${r.valueLostFromHigh < 0 ? 'text-rose-600' : 'text-slate-500'}">${formatRupee(r.valueLostFromHigh, { decimals: 0 })}</span>` },
  { key: 'severity', label: 'Severity', sortable: false, render: (r) => severityPill(r.drawdownPct) },
];

function drawdownCell(pct) {
  const cls = pct <= -15 ? 'text-rose-600' : pct <= -5 ? 'text-amber-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(pct)}</span>`;
}
function severityPill(pct) {
  if (pct <= -20) return pill({ label: 'Deep', tone: 'negative' });
  if (pct <= -10) return pill({ label: 'Moderate', tone: 'caution' });
  if (pct <= -3) return pill({ label: 'Shallow', tone: 'neutral' });
  return pill({ label: 'Near high', tone: 'positive' });
}

function buildStats(rows) {
  const worst = rows.slice().sort((a, b) => a.drawdownPct - b.drawdownPct)[0];
  const avg = rows.length ? rows.reduce((s, r) => s + r.drawdownPct, 0) / rows.length : 0;
  const deep = rows.filter((r) => r.drawdownPct <= -10).length;
  const nearHigh = rows.filter((r) => r.drawdownPct > -3).length;
  return [
    { label: 'Avg drawdown', value: formatPct(avg), deltaTone: 'caution' },
    { label: 'Worst position', value: worst ? worst.ticker : '—', delta: worst ? formatPct(worst.drawdownPct) : null, deltaTone: 'negative' },
    { label: '> 10% below peak', value: formatNumber(deep), deltaTone: deep ? 'negative' : 'neutral' },
    { label: 'Near 52w high', value: formatNumber(nearHigh), deltaTone: 'positive' },
  ];
}

export function render(ctx) {
  const holdings = withDrawdown(enrichHoldings(ctx.data?.portfolio?.holdings || []));

  if (ctx.scope === 'universe') {
    // Universe-wide drawdown needs the price feed from prompt 2 — no fabricated numbers here.
    ctx.root.innerHTML = `
      <div>${sectionHeader({
        title: meta.title,
        description: 'Universe-wide drawdown needs the live price feed landing in the next prompt. Switch scope to Portfolio for per-holding drawdown from mock 52w highs.',
        meta: scopeSummary({ scope: ctx.scope, count: (ctx.data?.universe || []).length, noun: 'companies' }),
      })}</div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${[
        { label: 'Universe size', value: formatNumber((ctx.data?.universe || []).length) },
        { label: 'Price history', value: 'Pending', deltaTone: 'caution' },
        { label: 'Source', value: 'Yahoo EOD', sublabel: 'NSE 500' },
        { label: 'Arrives', value: 'Prompt 2' },
      ]
        .map((s) => statCard(s))
        .join('')}</div>
      <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
        <div class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">Universe drawdown distribution (live, next prompt)</div>
        ${skeleton({ rows: 5 })}
      </div>
      ${comingSoonStrip(FEATURES)}`;
    return;
  }

  const isPortfolioLevel = ctx.subview === 'portfolio';

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: isPortfolioLevel ? 'Book-level equity curve and max drawdown — needs daily price history from the next prompt.' : 'Each holding measured against its own 52-week high.',
      meta: scopeSummary({ scope: ctx.scope, count: holdings.length, noun: 'holdings' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(holdings)
      .map((s) => statCard(s))
      .join('')}</div>
    ${isPortfolioLevel ? equityCurvePending() : ''}
    <div id="drawdown-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#drawdown-table');
  const table = dataTable({ columns: COLUMNS, rows: holdings, initialSort: { key: 'drawdownPct', dir: 'asc' } });
  mount.innerHTML = table.html;
  table.wire(mount);
}

function equityCurvePending() {
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 flex items-center justify-between">
        <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Portfolio equity curve &amp; underwater plot</div>
        ${pill({ label: 'Needs daily price history · prompt 2', tone: 'caution' })}
      </div>
      ${skeleton({ rows: 5 })}
      <p class="mt-3 text-xs text-slate-400">Per-position drawdown below is computed from the mock 52-week highs in portfolio.json and is already live.</p>
    </div>`;
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
