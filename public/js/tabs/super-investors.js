// tabs/super-investors.js — superstar-investor holdings, institutional ownership and fund flows.
//
// THIS PROMPT: presentation only. Holding value in ₹ crore is derived (holding % × market cap
// from universe.json) rather than sourced — the derivation is stated in the drill panel so the
// number is never mistaken for a disclosed figure.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { formatNumber, formatPct, formatDate, formatCroreCompact, formatCrore, toneForValue } from '../core/format.js';

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

// Holding value is DERIVED: disclosed holding % applied to the universe market cap.
function holdingValueCr(ctx, row) {
  const mc = (ctx.data?.universe || []).find((c) => c.ticker === row.ticker)?.marketCap;
  if (!mc) return null;
  return (mc * row.pctHolding) / 100;
}

function actionPill(action) {
  const cls =
    action === 'Buy' || action === 'New'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : action === 'Sell' || action === 'Exit'
        ? 'bg-rose-50 text-rose-700 ring-rose-200'
        : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${action}</span>`;
}
function pctCell(value, decimals = 1) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value, { decimals })}</span>`;
}
function qtyCell(value) {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-400';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${formatNumber(value)}</span>`;
}

const INSTITUTION_SIGNALS = (r) => [
  { label: 'FII added this quarter', status: r.fiiChangeQoqPct > 0 ? 'pass' : 'fail' },
  { label: 'DII added this quarter', status: r.diiChangeQoqPct > 0 ? 'pass' : 'fail' },
  { label: 'Net institutional inflow', status: r.fiiChangeQoqPct + r.diiChangeQoqPct > 0 ? 'pass' : 'fail' },
  { label: 'FII holding above 20%', status: r.fiiPct >= 20 ? 'pass' : r.fiiPct >= 10 ? 'partial' : 'fail' },
  { label: 'MF participation above 8%', status: r.mfPct >= 8 ? 'pass' : r.mfPct >= 5 ? 'partial' : 'fail' },
];

function drillInvestor(ctx, row) {
  const value = holdingValueCr(ctx, row);
  openDrill({
    name: row.investor,
    sub: `${row.investorType} · ${row.ticker} · as of ${formatDate(row.asOf)}`,
    headerStats: [
      { label: 'Holding', value: `${row.pctHolding.toFixed(2)}%`, caption: `${formatPct(row.pctHoldingChange, { decimals: 2 })} QoQ`, tone: toneForValue(row.pctHoldingChange) },
      { label: 'Est. value', value: value == null ? '—' : formatCroreCompact(value), caption: 'derived, see below' },
    ],
    groups: [
      {
        category: 'The move',
        items: [
          { label: 'Action', criteria: 'Buy / Sell / New / Exit / Hold', status: null, value: row.action, note: `${row.company} (${row.ticker})` },
          { label: 'Quantity change', criteria: 'Shares added or removed', status: null, value: `${row.qtyChange > 0 ? '+' : ''}${formatNumber(row.qtyChange)}`, note: 'As disclosed in the shareholding pattern.' },
          { label: 'Resulting holding', criteria: 'Percent of company equity', status: null, value: `${row.pctHolding.toFixed(2)}%`, note: `Change vs prior quarter: ${formatPct(row.pctHoldingChange, { decimals: 2 })}` },
        ],
      },
      {
        category: 'Derived figure',
        items: [
          {
            label: 'Estimated holding value',
            criteria: 'Holding % × current market cap',
            status: null,
            value: value == null ? '—' : formatCrore(value),
            note: 'Derived, not disclosed. Filings state a percentage, not a rupee value — this multiplies it by the market cap in universe.json and moves with the share price.',
          },
        ],
      },
      {
        category: 'Not yet built',
        items: [
          { label: 'Per-investor portfolio history', criteria: 'Every position, tracked over quarters', status: 'na', value: '', note: 'Ticker Finology scrape — prompt 6.' },
          { label: 'Conviction scoring', criteria: 'Position size vs the investor’s book', status: 'na', value: '', note: 'Prompt 6.' },
        ],
      },
    ],
  });
}

function drillInstitution(row) {
  openDrill({
    name: row.company,
    sub: `${row.ticker} · ${row.quarter}`,
    headerStats: [
      { label: 'FII holding', value: `${row.fiiPct.toFixed(1)}%`, caption: `${formatPct(row.fiiChangeQoqPct)} QoQ`, tone: toneForValue(row.fiiChangeQoqPct) },
      { label: 'DII holding', value: `${row.diiPct.toFixed(1)}%`, caption: `${formatPct(row.diiChangeQoqPct)} QoQ`, tone: toneForValue(row.diiChangeQoqPct) },
    ],
    groups: [
      {
        category: 'Shareholding',
        items: [
          { label: 'Foreign institutional', criteria: 'Percent of equity', status: null, value: `${row.fiiPct.toFixed(1)}%`, note: `Change: ${formatPct(row.fiiChangeQoqPct)}` },
          { label: 'Domestic institutional', criteria: 'Percent of equity', status: null, value: `${row.diiPct.toFixed(1)}%`, note: `Change: ${formatPct(row.diiChangeQoqPct)}` },
          { label: 'Mutual funds', criteria: 'A subset of DII, not additive to it', status: null, value: `${row.mfPct.toFixed(1)}%`, note: 'AMFI monthly portfolio disclosures.' },
        ],
      },
      { category: 'Signal readings', items: INSTITUTION_SIGNALS(row).map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of the reported shareholding.' })) },
    ],
  });
}

export function render(ctx) {
  if (ctx.subview === 'institutions') return renderInstitutions(ctx, 'institutions');
  if (ctx.subview === 'fund-flows') return renderInstitutions(ctx, 'fund-flows');
  return renderInvestors(ctx);
}

function renderInvestors(ctx) {
  const rows = scopedList(ctx, ctx.data?.superinvestors || []);
  const buys = rows.filter((r) => r.action === 'Buy' || r.action === 'New').length;
  const sells = rows.filter((r) => r.action === 'Sell' || r.action === 'Exit').length;
  const investors = new Set(rows.map((r) => r.investor)).size;

  const stats = statStrip([
    { label: 'Moves tracked', value: formatNumber(rows.length), note: `${investors} investors` },
    { label: 'Accumulating', value: formatNumber(buys), note: `${sells} trimming or exiting` },
    {
      label: 'Est. value',
      value: 'Derived',
      note: 'holding % × market cap',
      help: {
        title: 'Where "holding value" comes from',
        body: `<p>Shareholding filings disclose a <strong>percentage of equity</strong>, never a rupee amount. The ₹ crore figure on this tab is derived:</p>
               <p class="mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs">value = holding % × market cap</p>
               <p class="mt-2">Market cap comes from <code class="rounded bg-slate-100 px-1">universe.json</code>, so the value moves with the share price while the disclosed percentage is only refreshed quarterly.</p>
               <p class="mt-3 text-slate-500">Treat it as an order-of-magnitude estimate for ranking, not a reported number.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: rows[0] ? formatDate(rows[0].asOf) : '—', note: 'Ticker Finology · quarterly' },
  ]);

  const ranked = rows
    .map((r) => ({ ...r, valueCr: holdingValueCr(ctx, r) }))
    .filter((r) => r.valueCr != null)
    .sort((a, b) => b.valueCr - a.valueCr);

  const cards = topCards({
    title: 'Top 10 by Holding Value (₹ Cr, derived)',
    items: ranked.map((r) => ({
      name: r.company,
      sub: `${r.investor} · ${r.pctHolding.toFixed(2)}%`,
      value: formatCroreCompact(r.valueCr),
      tone: r.action === 'Buy' || r.action === 'New' ? 'positive' : r.action === 'Sell' || r.action === 'Exit' ? 'negative' : 'brand',
      caption: r.action,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillInvestor(ctx, item.payload),
  });

  const table = scoreTable({
    rows,
    key: (r) => r.id,
    name: (r) => r.investor,
    nameLabel: 'Investor',
    sub: (r) => `${r.ticker} · ${r.investorType}`,
    columns: [
      { label: 'Company', get: (r) => r.company },
      { label: 'Action', get: (r) => actionPill(r.action), html: true, sortValue: (r) => r.action },
      { label: 'Qty Δ', get: (r) => qtyCell(r.qtyChange), html: true, align: 'right', sortValue: (r) => r.qtyChange },
      { label: 'Holding %', get: (r) => `${r.pctHolding.toFixed(2)}%`, align: 'right', sortValue: (r) => r.pctHolding },
      { label: 'Δ QoQ', get: (r) => pctCell(r.pctHoldingChange, 2), html: true, align: 'right', sortValue: (r) => r.pctHoldingChange },
      { label: 'Est. Value', get: (r) => { const v = holdingValueCr(ctx, r); return v == null ? '—' : formatCroreCompact(v); }, align: 'right', sortValue: (r) => holdingValueCr(ctx, r) ?? 0 },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All moves' },
        { value: 'buying', label: 'Buying / New' },
        { value: 'selling', label: 'Selling / Exit' },
        { value: 'Hold', label: 'Holding' },
      ],
      match: (r, v) => (v === 'buying' ? r.action === 'Buy' || r.action === 'New' : v === 'selling' ? r.action === 'Sell' || r.action === 'Exit' : r.action === v),
    },
    searchable: (r) => `${r.investor} ${r.company} ${r.ticker}`,
    initialSort: { key: 'Δ QoQ', dir: 'desc' },
    onRowClick: (row) => drillInvestor(ctx, row),
    exportName: 'sattva-superinvestors',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: 'Latest disclosed superstar-investor position changes, ranked by holding change.', meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'moves' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

function renderInstitutions(ctx, mode) {
  const rows = scopedList(ctx, ctx.data?.institutions || []);
  const isFlows = mode === 'fund-flows';
  const withNet = rows.map((r) => ({ ...r, netFlowPct: Math.round((r.fiiChangeQoqPct + r.diiChangeQoqPct) * 10) / 10 }));
  const inflow = withNet.filter((r) => r.netFlowPct > 0).length;
  const avgFii = rows.length ? rows.reduce((s, r) => s + r.fiiPct, 0) / rows.length : 0;
  const avgNet = withNet.length ? withNet.reduce((s, r) => s + r.netFlowPct, 0) / withNet.length : 0;

  const stats = statStrip([
    { label: 'Names covered', value: formatNumber(rows.length), note: rows[0]?.quarter || 'latest quarter' },
    isFlows
      ? { label: 'Net inflows', value: formatNumber(inflow), note: `${withNet.length - inflow} net outflows` }
      : { label: 'Avg FII holding', value: `${avgFii.toFixed(1)}%`, note: 'across covered names' },
    {
      label: isFlows ? 'Avg net flow Δ' : 'Avg DII holding',
      value: isFlows ? formatPct(avgNet) : `${(rows.length ? rows.reduce((s, r) => s + r.diiPct, 0) / rows.length : 0).toFixed(1)}%`,
      note: isFlows ? 'FII + DII, percentage points' : 'mutual funds are a subset',
      help: {
        title: 'FII, DII and MF — how they relate',
        body: `<p><strong>FII</strong> is foreign institutional holding and <strong>DII</strong> is domestic institutional holding; each is a percentage of company equity.</p>
               <p class="mt-2"><strong>MF</strong> (mutual funds) is a <em>subset of DII</em>, not a third bucket — do not add it to the DII number.</p>
               <p class="mt-2">Net flow on this tab is simply <code class="rounded bg-slate-100 px-1">FII Δ + DII Δ</code> in percentage points, quarter over quarter.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: rows[0]?.quarter || '—', note: 'AMFI / Trendlyne · quarterly' },
  ]);

  const ranked = withNet.slice().sort((a, b) => (isFlows ? b.netFlowPct - a.netFlowPct : b.fiiPct - a.fiiPct));
  const cards = topCards({
    title: isFlows ? 'Top 10 by Net Institutional Flow' : 'Top 10 by FII Holding',
    items: ranked.map((r) => ({
      name: r.company,
      sub: `${r.ticker} · ${r.quarter}`,
      value: isFlows ? formatPct(r.netFlowPct) : `${r.fiiPct.toFixed(1)}%`,
      tone: isFlows ? (r.netFlowPct > 0 ? 'positive' : r.netFlowPct < 0 ? 'negative' : 'neutral') : 'brand',
      caption: isFlows ? (r.netFlowPct > 0 ? 'Inflow' : r.netFlowPct < 0 ? 'Outflow' : 'Flat') : `DII ${r.diiPct.toFixed(1)}%`,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillInstitution(item.payload),
  });

  const flowColumns = [
    { label: 'Net Flow Δ', get: (r) => pctCell(r.netFlowPct), html: true, align: 'right', sortValue: (r) => r.netFlowPct },
    { label: 'FII Δ', get: (r) => pctCell(r.fiiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.fiiChangeQoqPct },
    { label: 'DII Δ', get: (r) => pctCell(r.diiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.diiChangeQoqPct },
    {
      label: 'Direction',
      get: (r) => {
        const dir = r.netFlowPct > 0 ? 'Inflow' : r.netFlowPct < 0 ? 'Outflow' : 'Flat';
        const cls = dir === 'Inflow' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : dir === 'Outflow' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
        return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${dir}</span>`;
      },
      html: true,
      sortValue: (r) => r.netFlowPct,
    },
  ];

  const holdingColumns = [
    { label: 'Quarter', get: (r) => r.quarter },
    { label: 'FII %', get: (r) => `${r.fiiPct.toFixed(1)}%`, align: 'right', sortValue: (r) => r.fiiPct },
    { label: 'FII Δ', get: (r) => pctCell(r.fiiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.fiiChangeQoqPct },
    { label: 'DII %', get: (r) => `${r.diiPct.toFixed(1)}%`, align: 'right', sortValue: (r) => r.diiPct },
    { label: 'DII Δ', get: (r) => pctCell(r.diiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.diiChangeQoqPct },
    { label: 'MF %', get: (r) => `${r.mfPct.toFixed(1)}%`, align: 'right', sortValue: (r) => r.mfPct },
  ];

  const table = scoreTable({
    rows: withNet,
    key: (r) => r.ticker,
    name: (r) => r.company,
    sub: (r) => `${r.ticker} · ${r.quarter}`,
    showSignals: true,
    signals: INSTITUTION_SIGNALS,
    columns: isFlows ? flowColumns : holdingColumns,
    filters: {
      options: [
        { value: 'all', label: 'All names' },
        { value: 'inflow', label: 'Net inflow' },
        { value: 'outflow', label: 'Net outflow' },
      ],
      match: (r, v) => (v === 'inflow' ? r.netFlowPct > 0 : r.netFlowPct < 0),
    },
    searchable: (r) => `${r.company} ${r.ticker}`,
    initialSort: isFlows ? { key: 'Net Flow Δ', dir: 'desc' } : { key: 'FII %', dir: 'desc' },
    onRowClick: drillInstitution,
    exportName: isFlows ? 'sattva-fund-flows' : 'sattva-institutions',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: isFlows ? 'Combined FII + DII quarter-on-quarter shift, ranked by net direction.' : 'FII / DII / mutual fund shareholding by company, latest reported quarter.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'names' }),
    })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals read the reported shareholding directly. Conviction scoring arrives in prompt 6.' })}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
