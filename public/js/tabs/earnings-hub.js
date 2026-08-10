// tabs/earnings-hub.js — quarterly results, scans and quality/growth signals.
//
// THIS PROMPT: presentation only, assembled from the screener kit. No composite score is
// computed yet (that lands in prompt 4), so the table's Score column stays off. The Signals
// dots ARE shown, because every dot is a direct boolean reading of a number already in
// earnings.json — revenue grew or it didn't — not an invented model.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { formatCrore, formatPct, formatDate, formatNumber, formatRupee, toneForValue } from '../core/format.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Quarterly results, scans and quality/growth signals across coverage.',
  subviews: [
    { id: 'latest-results', label: 'Latest Results' },
    { id: 'result-scans', label: 'Result Scans' },
    { id: 'quality-growth', label: 'Quality & Growth' },
  ],
};

const FEATURES = [
  'Auto-parsed result PDFs (revenue, PAT, margin extraction)',
  'Beat/miss scoring vs Street estimates',
  'Segment-wise revenue break-up',
  'Quality & growth composite score (ROE, ROCE, consistency)',
  'Saved scans and custom result alerts',
  'Historical per-company result trend charts',
];

// Each signal is a factual reading of one field, not a judgement call.
function signalsFor(row) {
  return [
    { label: 'Revenue YoY positive', status: row.revenueYoyPct > 0 ? 'pass' : 'fail' },
    { label: 'Revenue QoQ positive', status: row.revenueQoqPct > 0 ? 'pass' : 'fail' },
    { label: 'PAT YoY positive', status: row.netProfitYoyPct > 0 ? 'pass' : 'fail' },
    { label: 'Beat Street EPS', status: row.surprisePct > 0 ? 'pass' : row.surprisePct === 0 ? 'partial' : 'fail' },
    { label: 'Double-digit revenue growth', status: row.revenueYoyPct >= 10 ? 'pass' : row.revenueYoyPct >= 5 ? 'partial' : 'fail' },
    { label: 'Double-digit PAT growth', status: row.netProfitYoyPct >= 10 ? 'pass' : row.netProfitYoyPct >= 5 ? 'partial' : 'fail' },
  ];
}

function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}

function tagPill(tag) {
  const cls =
    tag === 'Beat'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : tag === 'Miss'
        ? 'bg-rose-50 text-rose-700 ring-rose-200'
        : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${tag}</span>`;
}

function scopedRows(ctx) {
  const rows = ctx.data?.earnings || [];
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function drillFor(row) {
  const sig = signalsFor(row);
  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.quarter}`,
    headerStats: [
      { label: 'EPS Surprise', value: formatPct(row.surprisePct), caption: `vs ₹${row.epsEstimate} estimate`, tone: toneForValue(row.surprisePct) },
      { label: 'Revenue', value: formatCrore(row.revenueCr), caption: `${formatPct(row.revenueYoyPct)} YoY` },
    ],
    groups: [
      {
        category: 'Reported numbers',
        items: [
          { label: 'Revenue', criteria: 'Consolidated, ₹ crore', status: null, value: formatCrore(row.revenueCr), note: `${formatPct(row.revenueYoyPct)} YoY · ${formatPct(row.revenueQoqPct)} QoQ` },
          { label: 'Net profit', criteria: 'Consolidated PAT, ₹ crore', status: null, value: formatCrore(row.netProfitCr), note: `${formatPct(row.netProfitYoyPct)} YoY` },
          { label: 'EPS — actual vs estimate', criteria: 'Reported EPS vs Street consensus', status: null, value: `${formatRupee(row.epsActual)} vs ${formatRupee(row.epsEstimate)}`, note: `Surprise ${formatPct(row.surprisePct)} → tagged ${row.resultTag}` },
          { label: 'Reported on', criteria: 'Exchange filing date', status: null, value: formatDate(row.reportDate), note: `Quarter ${row.quarter}` },
        ],
      },
      {
        category: 'Signal readings',
        items: sig.map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of the reported figure — no model applied yet.' })),
      },
      {
        category: 'Not yet scored',
        items: [
          { label: 'Quality & growth composite', criteria: 'ROE, ROCE, earnings consistency', status: 'na', value: '', note: 'Scoring model arrives in prompt 4.' },
          { label: 'Segment revenue break-up', criteria: 'Per-segment contribution', status: 'na', value: '', note: 'Needs result-PDF parsing — prompt 4.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  const rows = scopedRows(ctx);
  const beats = rows.filter((r) => r.resultTag === 'Beat').length;
  const misses = rows.filter((r) => r.resultTag === 'Miss').length;
  const avgSurprise = rows.length ? rows.reduce((s, r) => s + r.surprisePct, 0) / rows.length : 0;
  const latest = rows.slice().sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate))[0];

  const stats = statStrip([
    { label: 'Results tracked', value: formatNumber(rows.length), note: ctx.scope === 'portfolio' ? 'in your holdings' : 'across coverage' },
    {
      label: 'Beat / Miss',
      value: `${beats} / ${misses}`,
      note: `${rows.length - beats - misses} in-line`,
      help: {
        title: 'How Beat / Miss is decided',
        body: `<p>A result is tagged from its <strong>EPS surprise</strong> — reported EPS measured against Street consensus:</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Beat</strong> — reported EPS above consensus</li>
                 <li><strong>In-line</strong> — within roughly a percent either way</li>
                 <li><strong>Miss</strong> — reported EPS below consensus</li>
               </ul>
               <p class="mt-3 text-slate-500">The tag ships in the data today. A calibrated threshold and a full quality/growth composite arrive in prompt 4 — until then no points-based score is shown.</p>`,
      },
    },
    { label: 'Avg surprise', value: formatPct(avgSurprise), note: 'mean EPS surprise' },
    { hero: true, label: 'Last Refresh', value: latest ? formatDate(latest.reportDate) : '—', note: 'BSE / NSE filings · event-driven' },
  ]);

  const ranked = rows.slice().sort((a, b) => b.surprisePct - a.surprisePct);
  const cards = topCards({
    title: 'Top 10 by Earnings Surprise',
    items: ranked.map((r) => ({
      name: r.name,
      sub: `${r.ticker} · ${r.quarter}`,
      value: formatPct(r.surprisePct),
      tone: r.surprisePct > 0 ? 'positive' : r.surprisePct < 0 ? 'negative' : 'neutral',
      caption: r.resultTag,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillFor(item.payload),
  });

  const table = scoreTable({
    rows: sortForSubview(ctx.subview, rows),
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    showSignals: true,
    signals: signalsFor,
    columns: [
      { label: 'Quarter', get: (r) => r.quarter },
      { label: 'Reported', get: (r) => formatDate(r.reportDate), sortValue: (r) => new Date(r.reportDate).getTime() },
      { label: 'Revenue', get: (r) => formatCrore(r.revenueCr), align: 'right', sortValue: (r) => r.revenueCr },
      { label: 'Rev YoY', get: (r) => pctCell(r.revenueYoyPct), html: true, align: 'right', sortValue: (r) => r.revenueYoyPct },
      { label: 'PAT YoY', get: (r) => pctCell(r.netProfitYoyPct), html: true, align: 'right', sortValue: (r) => r.netProfitYoyPct },
      { label: 'Surprise', get: (r) => pctCell(r.surprisePct), html: true, align: 'right', sortValue: (r) => r.surprisePct },
      { label: 'Tag', get: (r) => tagPill(r.resultTag), html: true, sortValue: (r) => r.resultTag },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All results' },
        { value: 'Beat', label: 'Beat only' },
        { value: 'In-line', label: 'In-line only' },
        { value: 'Miss', label: 'Miss only' },
      ],
      match: (r, v) => r.resultTag === v,
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: ctx.subview === 'quality-growth' ? { key: 'PAT YoY', dir: 'desc' } : { key: 'Reported', dir: 'desc' },
    onRowClick: drillFor,
    exportName: 'sattva-earnings',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: describe(ctx.subview),
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'results' }),
    })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals are direct readings of reported figures. A points-based quality & growth score arrives in prompt 4.' })}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

function sortForSubview(subview, rows) {
  const sorted = rows.slice();
  if (subview === 'quality-growth') sorted.sort((a, b) => b.netProfitYoyPct - a.netProfitYoyPct);
  else sorted.sort((a, b) => new Date(b.reportDate) - new Date(a.reportDate));
  return sorted;
}

function describe(subview) {
  if (subview === 'result-scans') return 'Filter the quarter by beat, miss or in-line against Street estimates.';
  if (subview === 'quality-growth') return 'Ranked by YoY profit growth as a growth proxy — the full quality composite lands in prompt 4.';
  return meta.subtitle;
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
