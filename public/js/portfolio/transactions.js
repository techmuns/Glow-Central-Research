// portfolio/transactions.js — the full buy/sell ledger behind the portfolio.
// THIS PROMPT: structure + placeholder panel only. Broker import/reconciliation lands in prompt 7.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, comingSoonStrip } from '../ui/components.js';
import { formatRupee, formatNumber, formatDate } from '../core/format.js';

export const meta = {
  id: 'transactions',
  title: 'Transaction History',
  subtitle: 'Every buy and sell behind the current book, newest first.',
  subviews: [
    { id: 'all', label: 'All' },
    { id: 'buys', label: 'Buys' },
    { id: 'sells', label: 'Sells' },
  ],
};

const FEATURES = [
  'Broker contract-note import (Zerodha / Groww / ICICI Direct)',
  'FIFO cost-basis and realised P&L computation',
  'Capital gains statement (STCG / LTCG split)',
  'Charges & brokerage reconciliation',
  'Corporate action adjustments (splits, bonus)',
  'CSV / XLSX export',
];

const COLUMNS = [
  { key: 'date', label: 'Date', render: (r) => formatDate(r.date) },
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'name', label: 'Company' },
  { key: 'type', label: 'Type', render: (r) => pill({ label: r.type, tone: r.type === 'Buy' ? 'positive' : 'negative' }) },
  { key: 'qty', label: 'Qty', align: 'right', render: (r) => formatNumber(r.qty) },
  { key: 'price', label: 'Price', align: 'right', render: (r) => formatRupee(r.price) },
  { key: 'value', label: 'Value', align: 'right', render: (r) => formatRupee(r.value, { decimals: 0 }) },
];

function scopedRows(ctx) {
  const rows = ctx.data?.transactions || [];
  // Under Universe scope the ledger isn't filtered to current holdings — it shows every recorded
  // trade including names since exited. Portfolio scope narrows to names still in the book.
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function filterForSubview(rows, subview) {
  if (subview === 'buys') return rows.filter((r) => r.type === 'Buy');
  if (subview === 'sells') return rows.filter((r) => r.type === 'Sell');
  return rows;
}

function buildStats(rows) {
  const buys = rows.filter((r) => r.type === 'Buy');
  const sells = rows.filter((r) => r.type === 'Sell');
  const deployed = buys.reduce((s, r) => s + r.value, 0);
  const realised = sells.reduce((s, r) => s + r.value, 0);
  return [
    { label: 'Transactions', value: formatNumber(rows.length) },
    { label: 'Buys', value: formatNumber(buys.length), deltaTone: 'positive' },
    { label: 'Sells', value: formatNumber(sells.length), deltaTone: sells.length ? 'negative' : 'neutral' },
    { label: 'Capital deployed', value: formatRupee(deployed - realised, { decimals: 0 }), sublabel: 'net of sale proceeds' },
  ];
}

export function render(ctx) {
  const allScoped = scopedRows(ctx);
  const rows = filterForSubview(allScoped, ctx.subview).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const table = dataTable({ columns: COLUMNS, rows, initialSort: { key: 'date', dir: 'desc' } });

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: ctx.scope === 'portfolio' ? 'Trades in names still held today.' : 'Every recorded trade, including names since exited.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'transactions' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(allScoped)
      .map((s) => statCard(s))
      .join('')}</div>
    <div id="transactions-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#transactions-table');
  mount.innerHTML = table.html;
  table.wire(mount);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
