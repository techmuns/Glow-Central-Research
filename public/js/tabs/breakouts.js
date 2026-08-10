// tabs/breakouts.js — technical scans across the coverage universe.
//
// THIS PROMPT: presentation only. Technical Scanner and Strong Breakouts genuinely have no
// data — public/data/technicals.json arrives in prompt 2 — so they keep the honest "Pending"
// state and get NO top-card ranking. Inventing a technical score to fill the grid would be
// fabricating analysis, so those two sub-views show the universe list with an explicit
// Pending marker instead.
//
// FII Accumulation and Earnings Surprise DO have real mock data behind them
// (institutions.json / earnings.json), so they get the full kit including signal dots.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip, pendingPanel } from '../ui/screener.js';
import { legendStrip } from '../ui/visual.js';
import { scopeSummary } from '../ui/components.js';
import { formatCroreCompact, formatPct, formatNumber, formatCrore, toneForValue } from '../core/format.js';

export const meta = {
  id: 'breakouts',
  title: 'Breakouts / Technical',
  subtitle: 'Technical scans across the coverage universe — the live price feed lands in the next prompt.',
  subviews: [
    { id: 'technical-scanner', label: 'Technical Scanner' },
    { id: 'strong-breakouts', label: 'Strong Breakouts' },
    { id: 'fii-accumulation', label: 'FII Accumulation' },
    { id: 'earnings-surprise', label: 'Earnings Surprise' },
  ],
};

const FEATURES = [
  'Live EOD price/volume feed (Yahoo Finance, NSE 500)',
  '50/100/200-DMA breakout detection',
  'Volume surge & momentum scoring',
  '52-week-high proximity scanner',
  'Sector-relative strength ranking',
  'FII/DII flow overlays on price action',
];

const PENDING_SUBVIEWS = new Set(['technical-scanner', 'strong-breakouts']);

function scopedList(ctx, rows) {
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function pctCell(value) {
  const tone = toneForValue(value);
  const cls = tone === 'positive' ? 'text-emerald-600' : tone === 'negative' ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${formatPct(value)}</span>`;
}
function tagPill(tag) {
  const cls =
    tag === 'Beat' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : tag === 'Miss' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${tag}</span>`;
}

const FII_SIGNALS = (r) => [
  { label: 'FII added this quarter', status: r.fiiChangeQoqPct > 0 ? 'pass' : 'fail' },
  { label: 'DII added this quarter', status: r.diiChangeQoqPct > 0 ? 'pass' : 'fail' },
  { label: 'Both institutions net buyers', status: r.fiiChangeQoqPct > 0 && r.diiChangeQoqPct > 0 ? 'pass' : r.fiiChangeQoqPct > 0 || r.diiChangeQoqPct > 0 ? 'partial' : 'fail' },
  { label: 'FII holding above 20%', status: r.fiiPct >= 20 ? 'pass' : r.fiiPct >= 10 ? 'partial' : 'fail' },
];

const SURPRISE_SIGNALS = (r) => [
  { label: 'Beat Street EPS', status: r.surprisePct > 0 ? 'pass' : r.surprisePct === 0 ? 'partial' : 'fail' },
  { label: 'Revenue YoY positive', status: r.revenueYoyPct > 0 ? 'pass' : 'fail' },
  { label: 'PAT YoY positive', status: r.netProfitYoyPct > 0 ? 'pass' : 'fail' },
  { label: 'Surprise above 3%', status: r.surprisePct >= 3 ? 'pass' : r.surprisePct > 0 ? 'partial' : 'fail' },
];

function drillPending(row) {
  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.industry || ''}`,
    headerStats: [
      { label: 'Market cap', value: formatCroreCompact(row.marketCap) },
      { label: 'Technical score', value: 'Pending', tone: 'caution', caption: 'needs the price feed' },
    ],
    banner: { tone: 'amber', title: 'No technical data yet', body: 'public/data/technicals.json is built in prompt 2 from Yahoo Finance EOD across the NSE 500. Nothing on this panel is estimated in the meantime.' },
    groups: [
      {
        category: 'Known today',
        items: [
          { label: 'Sector', status: null, value: row.sector, note: row.industry || '' },
          { label: 'Market capitalisation', criteria: '₹ crore', status: null, value: formatCrore(row.marketCap), note: 'From the coverage universe list.' },
        ],
      },
      {
        category: 'Awaiting the price feed (prompt 2)',
        items: [
          { label: 'Last close & volume', criteria: 'Daily OHLCV', status: 'na', value: '', note: 'Yahoo Finance EOD.' },
          { label: '50 / 100 / 200-day moving averages', criteria: 'Trend position', status: 'na', value: '', note: 'Derived once price history lands.' },
          { label: '52-week high proximity', criteria: 'Distance from the annual peak', status: 'na', value: '', note: 'Derived once price history lands.' },
          { label: 'Volume surge', criteria: 'Volume vs trailing average', status: 'na', value: '', note: 'Derived once price history lands.' },
        ],
      },
    ],
  });
}

function drillFii(row) {
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
          { label: 'Foreign institutional', criteria: 'Percent of equity', status: null, value: `${row.fiiPct.toFixed(1)}%`, note: `Change vs prior quarter: ${formatPct(row.fiiChangeQoqPct)}` },
          { label: 'Domestic institutional', criteria: 'Percent of equity', status: null, value: `${row.diiPct.toFixed(1)}%`, note: `Change vs prior quarter: ${formatPct(row.diiChangeQoqPct)}` },
          { label: 'Mutual funds', criteria: 'A subset of DII, not additive to it', status: null, value: `${row.mfPct.toFixed(1)}%`, note: 'Sourced from AMFI monthly disclosures.' },
        ],
      },
      { category: 'Signal readings', items: FII_SIGNALS(row).map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of the reported shareholding.' })) },
    ],
  });
}

function drillSurprise(row) {
  openDrill({
    name: row.name,
    sub: `${row.ticker} · ${row.sector} · ${row.quarter}`,
    headerStats: [
      { label: 'EPS surprise', value: formatPct(row.surprisePct), caption: row.resultTag, tone: toneForValue(row.surprisePct) },
      { label: 'PAT YoY', value: formatPct(row.netProfitYoyPct), tone: toneForValue(row.netProfitYoyPct) },
    ],
    groups: [
      {
        category: 'Reported numbers',
        items: [
          { label: 'Revenue', status: null, value: formatCrore(row.revenueCr), note: `${formatPct(row.revenueYoyPct)} YoY` },
          { label: 'Net profit', status: null, value: formatCrore(row.netProfitCr), note: `${formatPct(row.netProfitYoyPct)} YoY` },
          { label: 'EPS vs estimate', status: null, value: `${row.epsActual} vs ${row.epsEstimate}`, note: `Surprise ${formatPct(row.surprisePct)}` },
        ],
      },
      { category: 'Signal readings', items: SURPRISE_SIGNALS(row).map((s) => ({ label: s.label, status: s.status, value: '', note: 'Direct reading of the reported figure.' })) },
      {
        category: 'Awaiting the price feed (prompt 2)',
        items: [{ label: 'Post-result price reaction', criteria: 'Move since the result date', status: 'na', value: '', note: 'Needs daily price history.' }],
      },
    ],
  });
}

export function render(ctx) {
  const isPending = PENDING_SUBVIEWS.has(ctx.subview);
  if (isPending) return renderPending(ctx);
  if (ctx.subview === 'fii-accumulation') return renderFii(ctx);
  return renderSurprise(ctx);
}

function renderPending(ctx) {
  const rows = scopedList(ctx, ctx.data?.universe || []);
  const stats = statStrip([
    { label: 'Universe coverage', value: formatNumber(rows.length), note: ctx.scope === 'portfolio' ? 'of your holdings' : 'NSE 500 sample' },
    {
      label: 'Data pipeline',
      value: 'Pending',
      note: 'no technicals yet',
      help: {
        title: 'Why this panel is empty',
        body: `<p>Every other tab ships with mock data so the layout has something to show. This one deliberately does not.</p>
               <p class="mt-2">Technical indicators — moving averages, breakout flags, momentum, volume surge — are the dashboard's <strong>one genuinely live feed</strong>. Faking them would put plausible-looking but invented numbers in front of a trading decision.</p>
               <p class="mt-3 text-slate-500">The pipeline (Yahoo Finance EOD across the NSE 500, refreshed by a scheduled job) is built in prompt 2, and this tab's UI in prompt 3.</p>`,
      },
    },
    { label: 'Indicators planned', value: '12+', note: 'DMAs, RSI, volume surge…' },
    { hero: true, label: 'Last Refresh', value: 'Not yet wired', note: 'Yahoo Finance EOD · arrives prompt 2' },
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    columns: [
      { label: 'Sector', get: (r) => r.sector },
      { label: 'Industry', get: (r) => r.industry },
      { label: 'Market Cap', get: (r) => formatCroreCompact(r.marketCap), align: 'right', sortValue: (r) => r.marketCap },
      {
        label: 'Technical Score',
        get: () => '<span class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Pending</span>',
        html: true,
        sortable: false,
      },
    ],
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector} ${r.industry}`,
    initialSort: { key: 'Market Cap', dir: 'desc' },
    onRowClick: drillPending,
    exportName: 'sattva-universe',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description:
        ctx.subview === 'technical-scanner'
          ? 'The coverage list, ready to score the moment the live technical feed lands. No indicator values are estimated here.'
          : 'Breakout candidates will surface here once EOD price and volume data is wired in.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies' }),
    })}
    ${stats.html}
    <div class="mb-6">${pendingPanel({
      title: 'Momentum & volume heatmap',
      body: 'Deliberately blank: no technical indicator on this tab is estimated or back-filled. Real values arrive with the Yahoo Finance EOD pipeline.',
      arriving: 'prompt 3',
    })}</div>
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  table.wire(ctx.root);
}

function renderFii(ctx) {
  const rows = scopedList(ctx, ctx.data?.institutions || []);
  const buyers = rows.filter((r) => r.fiiChangeQoqPct > 0).length;
  const avg = rows.length ? rows.reduce((s, r) => s + r.fiiChangeQoqPct, 0) / rows.length : 0;

  const stats = statStrip([
    { label: 'Names tracked', value: formatNumber(rows.length), note: rows[0]?.quarter || 'latest quarter' },
    { label: 'Net FII buyers', value: formatNumber(buyers), note: `${rows.length - buyers} net sellers` },
    { label: 'Avg FII Δ QoQ', value: formatPct(avg), note: 'percentage points' },
    { hero: true, label: 'Last Refresh', value: rows[0]?.quarter || '—', note: 'Trendlyne / BSE filings · quarterly' },
  ]);

  const ranked = rows.slice().sort((a, b) => b.fiiChangeQoqPct - a.fiiChangeQoqPct);
  const cards = topCards({
    title: 'Top 10 by FII Accumulation',
    items: ranked.map((r) => ({
      name: r.company,
      sub: `${r.ticker} · ${r.quarter}`,
      value: formatPct(r.fiiChangeQoqPct),
      tone: r.fiiChangeQoqPct > 0 ? 'positive' : 'negative',
      caption: `${r.fiiPct.toFixed(1)}% held`,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillFii(item.payload),
  });

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.company,
    sub: (r) => `${r.ticker} · ${r.quarter}`,
    showSignals: true,
    signals: FII_SIGNALS,
    columns: [
      { label: 'FII %', get: (r) => `${r.fiiPct.toFixed(1)}%`, align: 'right', sortValue: (r) => r.fiiPct },
      { label: 'FII Δ QoQ', get: (r) => pctCell(r.fiiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.fiiChangeQoqPct },
      { label: 'DII %', get: (r) => `${r.diiPct.toFixed(1)}%`, align: 'right', sortValue: (r) => r.diiPct },
      { label: 'DII Δ QoQ', get: (r) => pctCell(r.diiChangeQoqPct), html: true, align: 'right', sortValue: (r) => r.diiChangeQoqPct },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All names' },
        { value: 'buying', label: 'FII accumulating' },
        { value: 'selling', label: 'FII trimming' },
      ],
      match: (r, v) => (v === 'buying' ? r.fiiChangeQoqPct > 0 : r.fiiChangeQoqPct < 0),
    },
    searchable: (r) => `${r.company} ${r.ticker}`,
    initialSort: { key: 'FII Δ QoQ', dir: 'desc' },
    onRowClick: drillFii,
    exportName: 'sattva-fii-accumulation',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: 'Ranked by quarter-on-quarter change in foreign institutional shareholding.', meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'names' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals read the reported shareholding directly. Technical scoring for this tab arrives in prompt 3.' })}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

function renderSurprise(ctx) {
  const rows = scopedList(ctx, ctx.data?.earnings || []);
  const beats = rows.filter((r) => r.resultTag === 'Beat').length;
  const avgAbs = rows.length ? rows.reduce((s, r) => s + Math.abs(r.surprisePct), 0) / rows.length : 0;

  const stats = statStrip([
    { label: 'Results scanned', value: formatNumber(rows.length), note: rows[0]?.quarter || 'latest quarter' },
    { label: 'Beats', value: formatNumber(beats), note: `${rows.length - beats} in-line or miss` },
    { label: 'Avg |surprise|', value: formatPct(avgAbs, { signed: false }), note: 'absolute EPS gap' },
    { hero: true, label: 'Last Refresh', value: rows[0]?.quarter || '—', note: 'BSE / NSE filings · event-driven' },
  ]);

  const ranked = rows.slice().sort((a, b) => b.surprisePct - a.surprisePct);
  const cards = topCards({
    title: 'Top 10 by Earnings Surprise',
    items: ranked.map((r) => ({
      name: r.name,
      sub: `${r.ticker} · ${r.quarter}`,
      value: formatPct(r.surprisePct),
      tone: r.surprisePct > 0 ? 'positive' : 'negative',
      caption: r.resultTag,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillSurprise(item.payload),
  });

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker} · ${r.sector}`,
    showSignals: true,
    signals: SURPRISE_SIGNALS,
    columns: [
      { label: 'Quarter', get: (r) => r.quarter },
      { label: 'Rev YoY', get: (r) => pctCell(r.revenueYoyPct), html: true, align: 'right', sortValue: (r) => r.revenueYoyPct },
      { label: 'PAT YoY', get: (r) => pctCell(r.netProfitYoyPct), html: true, align: 'right', sortValue: (r) => r.netProfitYoyPct },
      { label: 'Surprise', get: (r) => pctCell(r.surprisePct), html: true, align: 'right', sortValue: (r) => r.surprisePct },
      { label: 'Tag', get: (r) => tagPill(r.resultTag), html: true, sortValue: (r) => r.resultTag },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All results' },
        { value: 'Beat', label: 'Beat only' },
        { value: 'Miss', label: 'Miss only' },
      ],
      match: (r, v) => r.resultTag === v,
    },
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: { key: 'Surprise', dir: 'desc' },
    onRowClick: drillSurprise,
    exportName: 'sattva-earnings-surprise',
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: 'Ranked by earnings surprise against Street estimates this quarter.', meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'names' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${legendStrip({ note: 'Signals read reported figures directly. Post-result price reaction needs the technical feed — prompt 2.' })}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
