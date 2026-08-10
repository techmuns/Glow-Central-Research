// portfolio/transactions.js — the full buy/sell ledger behind the portfolio.
//
// THIS PROMPT: presentation only. Rows are trades, not companies, and the prompt specifies no
// ranking for this tab — a "top 10 trades" grid would imply a judgement the data doesn't
// support. So no top cards, no signals, no legend: just the ledger, done well.

import { statStrip, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
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

function typePill(type) {
  const cls = type === 'Buy' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${type}</span>`;
}

function scopedRows(ctx) {
  const rows = ctx.data?.transactions || [];
  // Universe scope shows the complete ledger including names since exited; Portfolio scope
  // narrows to trades in names still held today.
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function drillTrade(ctx, row) {
  const sameTicker = (ctx.data?.transactions || []).filter((t) => t.ticker === row.ticker);
  const buys = sameTicker.filter((t) => t.type === 'Buy');
  const sells = sameTicker.filter((t) => t.type === 'Sell');
  const netQty = buys.reduce((s, t) => s + t.qty, 0) - sells.reduce((s, t) => s + t.qty, 0);

  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.type} on ${formatDate(row.date)}`,
    headerStats: [
      { label: 'Trade value', value: formatRupee(row.value, { decimals: 0 }), caption: `${formatNumber(row.qty)} @ ${formatRupee(row.price)}` },
      { label: 'Net qty held', value: formatNumber(netQty), caption: `${sameTicker.length} trades in this name` },
    ],
    groups: [
      {
        category: 'This trade',
        items: [
          { label: 'Type', status: null, value: row.type, note: formatDate(row.date) },
          { label: 'Quantity', status: null, value: formatNumber(row.qty), note: `Executed at ${formatRupee(row.price)}` },
          { label: 'Value', criteria: 'Quantity × price', status: null, value: formatRupee(row.value, { decimals: 0 }), note: 'Excludes brokerage, STT and other charges.' },
        ],
      },
      {
        category: `All trades in ${row.ticker}`,
        items: [
          { label: 'Buys', status: null, value: `${buys.length} · ${formatNumber(buys.reduce((s, t) => s + t.qty, 0))} shares`, note: formatRupee(buys.reduce((s, t) => s + t.value, 0), { decimals: 0 }) },
          { label: 'Sells', status: null, value: `${sells.length} · ${formatNumber(sells.reduce((s, t) => s + t.qty, 0))} shares`, note: formatRupee(sells.reduce((s, t) => s + t.value, 0), { decimals: 0 }) },
        ],
      },
      {
        category: 'Not yet built',
        items: [
          { label: 'FIFO cost basis', criteria: 'Lot-level matching of sells to buys', status: 'na', value: '', note: 'Realised P&L computation arrives in prompt 7.' },
          { label: 'Capital gains split', criteria: 'STCG vs LTCG by holding period', status: 'na', value: '', note: 'Prompt 7.' },
          { label: 'Charges reconciliation', criteria: 'Brokerage, STT, stamp duty', status: 'na', value: '', note: 'Contract-note import — prompt 7.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  const allScoped = scopedRows(ctx);
  const rows = ctx.subview === 'buys' ? allScoped.filter((r) => r.type === 'Buy') : ctx.subview === 'sells' ? allScoped.filter((r) => r.type === 'Sell') : allScoped;

  const buys = allScoped.filter((r) => r.type === 'Buy');
  const sells = allScoped.filter((r) => r.type === 'Sell');
  const deployed = buys.reduce((s, r) => s + r.value, 0);
  const realised = sells.reduce((s, r) => s + r.value, 0);
  const newest = allScoped.slice().sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  const stats = statStrip([
    { label: 'Transactions', value: formatNumber(allScoped.length), note: `${buys.length} buys · ${sells.length} sells` },
    { label: 'Capital deployed', value: formatRupee(deployed, { decimals: 0 }), note: 'gross purchase value' },
    {
      label: 'Net deployed',
      value: formatRupee(deployed - realised, { decimals: 0 }),
      note: 'net of sale proceeds',
      help: {
        title: 'What "net deployed" means',
        body: `<p>Gross purchase value minus gross sale proceeds — the cash currently committed to the book.</p>
               <p class="mt-2">It is <strong>not</strong> a profit figure: sale proceeds include whatever gain or loss was realised, and this view does not yet separate the two.</p>
               <p class="mt-3 text-slate-500">FIFO lot matching, realised P&L and an STCG/LTCG split arrive in prompt 7, along with brokerage and charges reconciliation from broker contract notes.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: newest ? formatDate(newest.date) : '—', note: 'Broker ledger · event-driven' },
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.id,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${formatDate(r.date)}`,
    columns: [
      { label: 'Date', get: (r) => formatDate(r.date), sortValue: (r) => new Date(r.date).getTime() },
      { label: 'Type', get: (r) => typePill(r.type), html: true, sortValue: (r) => r.type },
      { label: 'Qty', get: (r) => formatNumber(r.qty), align: 'right', sortValue: (r) => r.qty },
      { label: 'Price', get: (r) => formatRupee(r.price), align: 'right', sortValue: (r) => r.price },
      { label: 'Value', get: (r) => formatRupee(r.value, { decimals: 0 }), align: 'right', sortValue: (r) => r.value },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All trades' },
        { value: 'Buy', label: 'Buys only' },
        { value: 'Sell', label: 'Sells only' },
      ],
      match: (r, v) => r.type === v,
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.type}`,
    initialSort: { key: 'Date', dir: 'desc' },
    onRowClick: (row) => drillTrade(ctx, row),
    emptyMessage: 'No transactions match your filters.',
    exportName: 'sattva-transactions',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: ctx.scope === 'portfolio' ? 'Trades in names still held today.' : 'Every recorded trade, including names since exited.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'transactions' }),
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
