// tabs/earnings-hub.js — LIVE quarterly results for the whole listed universe.
//
// This tab is genuinely live. It paints from a committed snapshot instantly, then polls
// /api/earnings every 30s; a company that files at 14:32 is on this table by about 14:33. The
// header pill shows which of the two you are looking at, and the "just reported" strip names
// anything that arrived while the tab was open.
//
// THE TABLE IS THE POINT. No score, no signal dots, no hero cards on the main view — this is a
// dense sortable table because that is what a results screen is for. The screener kit's
// scoreTable does all of it (search, sort, filter, watchlist, export, sticky head, 1,300 rows at
// ~120ms) with Score and Signals switched off.
//
// WHY THERE IS NO 21-POINT SCORE HERE ANY MORE
//   The old Earnings Hub scored synthetic financials against a 15-rule model. Moneycontrol
//   publishes three figures per company — revenue, gross profit, net profit — which is nowhere
//   near enough to feed that model. Rather than run a real model on fake numbers next to a live
//   table of real ones, the scoring sub-views are gone. `js/scoring/earnings-scoring.js` and the
//   mock set remain in the repo for the Breakouts → Earnings Surprise join, which still labels
//   itself mock.
//
// THE PERCENTAGE THAT ISN'T ONE
//   13% of companies have a sign flip between the two periods. "+199%" on a loss-to-profit
//   turnaround is not a growth rate, and a green +43% on a company that lost ₹3,754 Cr reads as
//   profit growth when it means the loss narrowed. Every such cell is a labelled pill instead of
//   a number — see `changeCell`.

import { statStrip, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatCroreCompact, formatPct, formatNumber, formatRupee, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/earnings-live.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
  subviews: [
    { id: 'latest-results', label: 'Latest Results' },
    { id: 'movers', label: 'Movers' },
    { id: 'by-industry', label: 'By Industry' },
  ],
};

const FEATURES = [
  'Per-company quarter history (this feed carries the latest quarter only)',
  'Margin, tax-rate and other-income detail from the XBRL filings',
  'Result-day price reaction intraday, not just close-to-now',
  'Alerts when a watchlisted company reports',
];

let disposers = [];
let renderToken = 0;

export function render(ctx) {
  const token = ++renderToken;
  ctx.root.innerHTML = loadingHtml();

  feed
    .load()
    .then(() => {
      if (token !== renderToken) return;
      paint(ctx);
      // One subscription for the life of the tab: the poller repaints in place on real change.
      disposers.push(
        feed.onChange(() => {
          if (token !== renderToken) return;
          paint(ctx);
        })
      );
      disposers.push(feed.startLive(ctx.live));
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[earnings-hub] load failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The results feed could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load the earnings feed</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

export function destroy() {
  renderToken++;
  disposers.forEach((d) => d && d());
  disposers = [];
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  // Only the subscription disposers survive a repaint; table listeners are re-registered below.
  const view = ctx.subview || 'latest-results';
  if (view === 'movers') return renderMovers(ctx);
  if (view === 'by-industry') return renderByIndustry(ctx);
  return renderLatest(ctx);
}

const rowsFor = (ctx) => feed.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/**
 * A period-on-period change, rendered honestly.
 *
 * `normal` gets a signed percentage. Everything else gets a pill naming what actually happened,
 * because a percentage across a sign change is not a growth rate and colouring it green or red
 * would assert something the arithmetic does not support.
 */
function changeCell(m) {
  if (!m || m.kind === 'na') return '<span class="text-slate-300">—</span>';

  if (m.kind === 'normal') {
    const cls = m.pct > 0 ? 'text-emerald-600' : m.pct < 0 ? 'text-rose-600' : 'text-slate-500';
    return `<span class="font-semibold ${cls}">${escapeHtml(formatPct(m.pct))}</span>`;
  }
  if (m.kind === 'loss-narrowed' || m.kind === 'loss-widened') {
    const narrowed = m.kind === 'loss-narrowed';
    const cls = narrowed ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200';
    return `<span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${cls}"
       title="Loss in both periods: ${escapeHtml(formatNumber(m.prior))} Cr → ${escapeHtml(formatNumber(m.current))} Cr. A percentage here describes the size of the loss, not profit growth.">
       Loss ${narrowed ? '↓' : '↑'} ${m.pct != null ? escapeHtml(Math.abs(m.pct).toFixed(0)) + '%' : ''}</span>`;
  }
  if (m.kind === 'turnaround') {
    return `<span class="inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200"
       title="Loss of ${escapeHtml(formatNumber(m.prior))} Cr became a profit of ${escapeHtml(formatNumber(m.current))} Cr. A percentage change across zero is not a growth rate.">To profit</span>`;
  }
  if (m.kind === 'slipped-to-loss') {
    return `<span class="inline-flex items-center rounded-full bg-rose-50 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200"
       title="Profit of ${escapeHtml(formatNumber(m.prior))} Cr became a loss of ${escapeHtml(formatNumber(m.current))} Cr.">To loss</span>`;
  }
  if (m.kind === 'flat') return '<span class="text-slate-400">0%</span>';
  return `<span class="text-slate-300" title="Prior period was zero, so there is no percentage to compute.">—</span>`;
}

// Sort value that keeps the pills in a sensible order rather than dumping them all at one end.
function changeSortValue(m) {
  if (!m) return -Infinity;
  if (m.kind === 'normal') return m.pct ?? -Infinity;
  if (m.kind === 'turnaround') return 1e6; // best possible outcome, sorts above any percentage
  if (m.kind === 'slipped-to-loss') return -1e6;
  if (m.kind === 'loss-narrowed') return (m.pct ?? 0) - 5e5; // improving, but still loss-making
  if (m.kind === 'loss-widened') return -5e5 - Math.abs(m.pct ?? 0);
  return -Infinity;
}

function returnCell(r) {
  if (r.returnSinceResult == null) {
    return `<span class="text-slate-300" title="${r.ticker ? 'No closing price cached for the result date yet.' : 'No NSE ticker resolved for this company.'}">—</span>`;
  }
  const v = r.returnSinceResult;
  const cls = v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}" title="From ${escapeHtml(formatRupee(r.basePrice))} on ${escapeHtml(r.basePricedOn || r.resultDate)} to ${escapeHtml(formatRupee(r.ltp))} now">${escapeHtml(formatPct(v, { decimals: 2 }))}</span>`;
}

// "2026-08-10" -> "10 Aug". The screenshot's compact form; the full date is in the drill.
function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
}

function basisPill(basis) {
  const con = basis === 'Consolidated';
  return `<span class="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold ${con ? 'bg-slate-100 text-slate-500' : 'bg-violet-50 text-violet-600'}" title="${escapeHtml(basis || 'unknown')} results">${con ? 'CON' : 'STD'}</span>`;
}

// ---------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------
function liveRibbon(m) {
  if (!m) return '';
  if (m.degraded) {
    return `<div class="mb-5 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-300">
            <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span> Showing the last snapshot
          </span>
        </div>
        <p class="mt-2 text-xs leading-relaxed text-amber-900/90">${escapeHtml(m.degraded)}
          The figures below are real and were correct when captured, but they are not live right now.</p>
      </div>`;
  }
  return `<div class="mb-5 rounded-2xl bg-emerald-50 p-4 ring-1 ring-emerald-200">
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-300">
          <span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>
          ${m.isLive ? 'Live' : 'Snapshot'}
        </span>
        <span class="text-xs font-semibold text-emerald-900">${escapeHtml(m.quarter || 'Latest quarter')}</span>
        <span class="text-xs text-emerald-900/70">${escapeHtml(m.currentPeriod || '')} vs ${escapeHtml(m.priorPeriod || '')}</span>
      </div>
      <p class="mt-2 text-xs leading-relaxed text-emerald-900/90">
        <strong>Real reported figures</strong> from Moneycontrol Rapid Results, in ₹ crore, polled every 30 seconds — a company
        that files now appears here within about a minute. Tickers, market caps and industries are joined from the NSE-500
        export; <strong>Return since result</strong> is computed here from the close on the result date against the live price.
      </p>
    </div>`;
}

function arrivalsStrip() {
  const a = feed.newArrivals();
  if (!a.length) return '';
  return `
    <div class="mb-5 rounded-2xl bg-indigo-50 p-4 ring-1 ring-indigo-200 fade-in">
      <div class="text-xs font-bold uppercase tracking-wider text-indigo-700">Just reported — arrived while this tab was open</div>
      <div class="mt-2 flex flex-wrap gap-2">
        ${a
          .slice(0, 12)
          .map(
            (r) => `<span class="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs ring-1 ring-indigo-200">
              <strong class="text-slate-800">${escapeHtml(r.ticker || r.shortName)}</strong>
              <span class="text-slate-500">PAT</span> ${changeCell(r.netProfit)}
            </span>`
          )
          .join('')}
      </div>
    </div>`;
}

function statsFor(rows, m) {
  const reported = rows.length;
  const growers = rows.filter((r) => r.netProfit?.kind === 'normal' && r.netProfit.pct > 0).length;
  const turnarounds = rows.filter((r) => r.netProfit?.kind === 'turnaround').length;
  const withReturn = rows.filter((r) => r.returnSinceResult != null);
  const medianReturn = withReturn.length
    ? [...withReturn].sort((a, b) => a.returnSinceResult - b.returnSinceResult)[Math.floor(withReturn.length / 2)].returnSinceResult
    : null;

  return statStrip([
    { label: 'Companies reported', value: formatNumber(reported), note: `${m?.quarter || ''} · ${m?.currentPeriod || ''} vs ${m?.priorPeriod || ''}` },
    {
      label: 'PAT grew YoY',
      value: reported ? `${Math.round((growers / reported) * 100)}%` : '—',
      note: `${formatNumber(growers)} of ${formatNumber(reported)} · plus ${turnarounds} loss-to-profit`,
      help: {
        title: 'Why some cells are pills instead of percentages',
        body: `<p>Moneycontrol reports profit growth as a plain percentage even when the sign flips between the two periods.
                 Across a full quarter that is about <strong>13% of companies</strong>, and in those cases the number does not mean
                 what it looks like:</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Loss in both periods.</strong> Vodafone Idea shows "+43%" — the loss narrowed from ₹6,608 Cr to
                     ₹3,754 Cr. Painted green as +43% it reads as profit growth.</li>
                 <li><strong>Loss to profit.</strong> Shown as <em>To profit</em>. A percentage change across zero is not a growth rate.</li>
                 <li><strong>Profit to loss.</strong> Shown as <em>To loss</em>, for the same reason.</li>
               </ul>
               <p class="mt-2">Only genuine profit-to-profit moves get a signed percentage. Hover any pill for the two raw figures.</p>
               <p class="mt-3 text-slate-500">The "PAT grew" headline counts profit-to-profit growth only, and reports turnarounds
                 separately rather than folding them in.</p>`,
      },
    },
    {
      label: 'Median return since result',
      value: medianReturn == null ? '—' : formatPct(medianReturn, { decimals: 2 }),
      note: `${formatNumber(withReturn.length)} of ${formatNumber(reported)} priced`,
      help: {
        title: 'How "Return since result" is measured',
        body: `<p><code class="rounded bg-slate-100 px-1">(price now − close on the result date) / close on the result date</code>.</p>
               <p class="mt-2">Indian results are usually announced after the close, so the base is the <strong>closing price on the
                 result date</strong> — the last price at which the market could trade without knowing the numbers. If that day was
                 not a trading day, the previous close is used and the drill records which date was actually priced.</p>
               <p class="mt-2">The base close is a fact about a past date and never changes, so it is cached
                 (<code class="rounded bg-slate-100 px-1">data/result-returns.json</code>). The current price arrives live with every
                 poll, which is what makes this column move without refetching any history.</p>
               <p class="mt-3 text-slate-500">A company with no cached base price shows "—", never 0%.</p>`,
      },
    },
    {
      hero: true,
      label: m?.isLive ? 'Live · updating' : 'Last snapshot',
      value: m?.receivedAt ? formatRelativeTime(m.receivedAt) : '—',
      note: m?.isLive ? `Polling every ${feed.POLL_MS / 1000}s · Moneycontrol` : 'Committed file · live feed unavailable',
    },
  ]);
}

// ---------------------------------------------------------------------------------------
// Latest Results — the table
// ---------------------------------------------------------------------------------------
function renderLatest(ctx) {
  const rows = rowsFor(ctx);
  const m = feed.meta();
  const stats = statsFor(rows, m);

  const table = scoreTable({
    rows,
    key: (r) => r.scId,
    name: (r) => r.company,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || r.sectorSlug || '—'}`,
    columns: [
      { label: 'Updated', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: (r) => r.resultDate || '' },
      { label: 'Ticker', get: (r) => (r.ticker ? `<span class="font-mono text-xs font-semibold text-slate-700">${escapeHtml(r.ticker)}</span>` : '<span class="text-slate-300">—</span>'), html: true, sortValue: (r) => r.ticker || 'zzz' },
      { label: 'MCap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
      { label: 'Industry', get: (r) => escapeHtml(r.industry || '—'), html: true, sortValue: (r) => r.industry || 'zzz' },
      { label: 'PAT YoY', get: (r) => changeCell(r.netProfit), html: true, align: 'right', sortValue: (r) => changeSortValue(r.netProfit) },
      { label: 'Revenue YoY', get: (r) => changeCell(r.revenue), html: true, align: 'right', sortValue: (r) => changeSortValue(r.revenue) },
      { label: 'Return Since Result', get: returnCell, html: true, align: 'right', sortValue: (r) => r.returnSinceResult ?? -Infinity },
      { label: 'Basis', get: (r) => basisPill(r.basis), html: true, sortValue: (r) => r.basis || '' },
    ],
    filters: {
      options: [
        { value: 'all', label: 'All results' },
        { value: 'pat-up', label: 'PAT grew' },
        { value: 'pat-down', label: 'PAT fell' },
        { value: 'turnaround', label: 'Loss → profit' },
        { value: 'to-loss', label: 'Profit → loss' },
        { value: 'rev-up-20', label: 'Revenue +20% or more' },
        { value: 'in-universe', label: 'NSE 500 only' },
        { value: 'today', label: 'Reported on the latest date' },
      ],
      match: (r, v) => {
        if (v === 'pat-up') return r.netProfit?.kind === 'normal' && r.netProfit.pct > 0;
        if (v === 'pat-down') return r.netProfit?.kind === 'normal' && r.netProfit.pct < 0;
        if (v === 'turnaround') return r.netProfit?.kind === 'turnaround';
        if (v === 'to-loss') return r.netProfit?.kind === 'slipped-to-loss';
        if (v === 'rev-up-20') return r.revenue?.kind === 'normal' && r.revenue.pct >= 20;
        if (v === 'in-universe') return r.inUniverse;
        if (v === 'today') return r.resultDate === m?.latestResultDate;
        return true;
      },
    },
    searchable: (r) => `${r.company} ${r.shortName} ${r.ticker || ''} ${r.industry || ''} ${r.sectorSlug || ''}`,
    initialSort: { key: 'Return Since Result', dir: 'desc' },
    onRowClick: (r) => drillResult(r, m),
    exportName: 'sattva-earnings',
    onExport: (visible) => exportResults(visible, m),
    emptyMessage: ctx.scope === 'portfolio' ? 'None of your holdings has reported in this quarter yet.' : 'No results match your filters.',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Latest Results',
      description: 'Every company that has reported this quarter, newest first. Click a row for the full figures.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies reported' }),
    })}
    ${liveRibbon(m)}
    ${arrivalsStrip()}
    ${stats.html}
    ${table.html}
    ${coverageNote(rows, m)}
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  const off = table.wire(ctx.root);
  disposers.push(off);
}

function coverageNote(rows, m) {
  const noTicker = rows.filter((r) => !r.ticker).length;
  const noCap = rows.filter((r) => r.marketCap == null).length;
  const noReturn = rows.filter((r) => r.returnSinceResult == null).length;
  return `
    <p class="mb-6 text-[11px] leading-relaxed text-slate-500">
      Of ${formatNumber(rows.length)} companies: ${formatNumber(rows.length - noTicker)} resolved to an NSE ticker,
      ${formatNumber(rows.length - noCap)} matched the NSE-500 export for market cap and industry, and
      ${formatNumber(rows.length - noReturn)} have a cached result-day close for the return column.
      The rest show "—" in those columns — a dash means <em>not joined</em>, never zero.
      ${m?.priorPeriod ? `Growth is against ${escapeHtml(m.priorPeriod)}.` : ''}
    </p>`;
}

// ---------------------------------------------------------------------------------------
// Movers
// ---------------------------------------------------------------------------------------
function renderMovers(ctx) {
  const rows = rowsFor(ctx);
  const m = feed.meta();
  const stats = statsFor(rows, m);

  const normal = rows.filter((r) => r.netProfit?.kind === 'normal');
  const panels = [
    { title: 'Biggest PAT gains', tone: 'emerald', items: [...normal].sort((a, b) => b.netProfit.pct - a.netProfit.pct).slice(0, 10), metric: (r) => formatPct(r.netProfit.pct) },
    { title: 'Biggest PAT falls', tone: 'rose', items: [...normal].sort((a, b) => a.netProfit.pct - b.netProfit.pct).slice(0, 10), metric: (r) => formatPct(r.netProfit.pct) },
    { title: 'Loss → profit', tone: 'indigo', items: rows.filter((r) => r.netProfit?.kind === 'turnaround').slice(0, 10), metric: (r) => `${formatNumber(r.netProfit.prior)} → ${formatNumber(r.netProfit.current)} Cr` },
    { title: 'Profit → loss', tone: 'amber', items: rows.filter((r) => r.netProfit?.kind === 'slipped-to-loss').slice(0, 10), metric: (r) => `${formatNumber(r.netProfit.prior)} → ${formatNumber(r.netProfit.current)} Cr` },
    { title: 'Best reaction since result', tone: 'emerald', items: rows.filter((r) => r.returnSinceResult != null).sort((a, b) => b.returnSinceResult - a.returnSinceResult).slice(0, 10), metric: (r) => formatPct(r.returnSinceResult, { decimals: 1 }) },
    { title: 'Worst reaction since result', tone: 'rose', items: rows.filter((r) => r.returnSinceResult != null).sort((a, b) => a.returnSinceResult - b.returnSinceResult).slice(0, 10), metric: (r) => formatPct(r.returnSinceResult, { decimals: 1 }) },
  ];

  const TONE = {
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
    indigo: 'text-indigo-600',
    amber: 'text-amber-600',
  };

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Movers',
      description: 'The tails of this quarter — where profit swung hardest, where the sign flipped, and how the market took it.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies reported' }),
    })}
    ${liveRibbon(m)}
    ${arrivalsStrip()}
    ${stats.html}
    <div class="mb-6 grid gap-4 lg:grid-cols-2">
      ${panels
        .map(
          (p) => `
        <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
          <h3 class="font-display text-sm font-bold text-slate-900">${escapeHtml(p.title)}</h3>
          ${
            p.items.length
              ? `<ol class="mt-3 space-y-1.5">
                  ${p.items
                    .map(
                      (r, i) => `<li class="flex items-baseline justify-between gap-3 text-xs">
                        <span class="min-w-0 truncate"><span class="mr-1.5 tabular-nums text-slate-300">${i + 1}</span>
                          <strong class="text-slate-800">${escapeHtml(r.ticker || r.shortName)}</strong>
                          <span class="ml-1 text-slate-400">${escapeHtml(r.company.slice(0, 30))}</span></span>
                        <span class="flex-shrink-0 font-semibold tabular-nums ${TONE[p.tone]}">${escapeHtml(p.metric(r))}</span>
                      </li>`
                    )
                    .join('')}
                 </ol>`
              : '<p class="mt-3 text-xs text-slate-400">Nothing in this bucket for the current scope.</p>'
          }
        </section>`
        )
        .join('')}
    </div>
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
}

// ---------------------------------------------------------------------------------------
// By Industry
// ---------------------------------------------------------------------------------------
function renderByIndustry(ctx) {
  const rows = rowsFor(ctx);
  const m = feed.meta();
  const stats = statsFor(rows, m);

  const groups = new Map();
  for (const r of rows) {
    const k = r.industry || r.sectorSlug?.replace(/-/g, ' ') || 'Unclassified';
    const g = groups.get(k) || { key: k, rows: [], patUp: 0, patDown: 0, turn: 0, toLoss: 0 };
    g.rows.push(r);
    if (r.netProfit?.kind === 'normal') (r.netProfit.pct > 0 ? g.patUp++ : g.patDown++);
    else if (r.netProfit?.kind === 'turnaround') g.turn++;
    else if (r.netProfit?.kind === 'slipped-to-loss') g.toLoss++;
    groups.set(k, g);
  }
  const list = [...groups.values()]
    .map((g) => {
      const pats = g.rows.filter((r) => r.netProfit?.kind === 'normal').map((r) => r.netProfit.pct).sort((a, b) => a - b);
      const revs = g.rows.filter((r) => r.revenue?.kind === 'normal').map((r) => r.revenue.pct).sort((a, b) => a - b);
      const rets = g.rows.filter((r) => r.returnSinceResult != null).map((r) => r.returnSinceResult).sort((a, b) => a - b);
      const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
      return { ...g, count: g.rows.length, medPat: med(pats), medRev: med(revs), medRet: med(rets) };
    })
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count);

  const table = scoreTable({
    rows: list,
    key: (g) => g.key,
    name: (g) => g.key,
    nameLabel: 'Industry',
    sub: (g) => `${g.count} reported · ${g.patUp} up, ${g.patDown} down${g.turn ? `, ${g.turn} to profit` : ''}${g.toLoss ? `, ${g.toLoss} to loss` : ''}`,
    columns: [
      { label: 'Reported', get: (g) => formatNumber(g.count), align: 'right', sortValue: (g) => g.count },
      { label: 'Median PAT YoY', get: (g) => (g.medPat == null ? '<span class="text-slate-300">—</span>' : changeCell({ kind: 'normal', pct: g.medPat })), html: true, align: 'right', sortValue: (g) => g.medPat ?? -Infinity },
      { label: 'Median Revenue YoY', get: (g) => (g.medRev == null ? '<span class="text-slate-300">—</span>' : changeCell({ kind: 'normal', pct: g.medRev })), html: true, align: 'right', sortValue: (g) => g.medRev ?? -Infinity },
      { label: 'Median Return', get: (g) => (g.medRet == null ? '<span class="text-slate-300">—</span>' : changeCell({ kind: 'normal', pct: g.medRet })), html: true, align: 'right', sortValue: (g) => g.medRet ?? -Infinity },
      { label: 'To profit', get: (g) => (g.turn ? String(g.turn) : '—'), align: 'right', sortValue: (g) => g.turn },
      { label: 'To loss', get: (g) => (g.toLoss ? String(g.toLoss) : '—'), align: 'right', sortValue: (g) => g.toLoss },
    ],
    searchable: (g) => g.key,
    initialSort: { key: 'Reported', dir: 'desc' },
    exportName: 'sattva-earnings-by-industry',
    emptyMessage: 'No industry has two or more companies reported in this scope.',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'By Industry',
      description: 'Medians, not averages — one turnaround at +4,000% would drag a mean somewhere useless. Industries with a single reporter are omitted.',
      meta: scopeSummary({ scope: ctx.scope, count: list.length, noun: 'industries' }),
    })}
    ${liveRibbon(m)}
    ${stats.html}
    ${table.html}
    <p class="mb-6 text-[11px] text-slate-500">Industry comes from the NSE-500 export, so companies outside it fall back to Moneycontrol's sector slug.</p>
    ${roadmapStrip(FEATURES)}
  `;
  stats.wire(ctx.root);
  disposers.push(table.wire(ctx.root));
}

// ---------------------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------------------
function metricRows(r) {
  const line = (m) => {
    if (!m) return null;
    return {
      label: m.label,
      criteria: `${r.meta?.currentPeriod || 'current'} vs prior year`,
      status: m.kind === 'normal' ? (m.pct > 0 ? 'pass' : 'fail') : m.kind === 'turnaround' ? 'pass' : m.kind === 'slipped-to-loss' || m.kind === 'loss-widened' ? 'fail' : m.kind === 'loss-narrowed' ? 'partial' : 'na',
      value: `${formatNumber(m.current)} Cr`,
      note:
        m.kind === 'normal'
          ? `Prior ${formatNumber(m.prior)} Cr — ${formatPct(m.pct)}.`
          : m.kind === 'loss-narrowed'
            ? `Loss in both periods: ${formatNumber(m.prior)} Cr → ${formatNumber(m.current)} Cr. The loss narrowed; this is not profit growth.`
            : m.kind === 'loss-widened'
              ? `Loss in both periods: ${formatNumber(m.prior)} Cr → ${formatNumber(m.current)} Cr. The loss widened.`
              : m.kind === 'turnaround'
                ? `A loss of ${formatNumber(m.prior)} Cr became a profit of ${formatNumber(m.current)} Cr. No percentage is shown because a change across zero is not a growth rate.`
                : m.kind === 'slipped-to-loss'
                  ? `A profit of ${formatNumber(m.prior)} Cr became a loss of ${formatNumber(m.current)} Cr.`
                  : `Prior period was ${formatNumber(m.prior)} Cr.`,
    };
  };
  return [line(r.revenue), line(r.grossProfit), line(r.netProfit)].filter(Boolean);
}

function drillResult(row, m) {
  openDrill({
    name: row.company,
    sub: `${row.ticker || 'no NSE ticker'} · ${row.industry || row.sectorSlug || '—'} · ${row.basis}`,
    link: row.mcUrl,
    linkLabel: 'Moneycontrol ↗',
    headerStats: [
      {
        label: 'Net profit',
        value: `${formatNumber(row.netProfit?.current)} Cr`,
        caption: row.netProfit?.kind === 'normal' ? formatPct(row.netProfit.pct) : row.netProfit?.kind?.replace(/-/g, ' ') || '',
        tone: (row.netProfit?.direction ?? 0) > 0 ? 'positive' : (row.netProfit?.direction ?? 0) < 0 ? 'negative' : 'neutral',
      },
      {
        label: 'Since result',
        value: row.returnSinceResult == null ? '—' : formatPct(row.returnSinceResult, { decimals: 2 }),
        caption: row.basePrice ? `from ${formatRupee(row.basePrice)}` : 'no base price',
        tone: (row.returnSinceResult ?? 0) > 0 ? 'positive' : (row.returnSinceResult ?? 0) < 0 ? 'negative' : 'neutral',
      },
    ],
    beforeGroupsHtml: `
      <div class="mb-4 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
        <strong>Reported ${escapeHtml(row.resultDateLabel || row.resultDate || '')}</strong> · ${escapeHtml(m?.quarter || '')}
        (${escapeHtml(m?.currentPeriod || '')} vs ${escapeHtml(m?.priorPeriod || '')}) · ${escapeHtml(row.basis)} basis.
        Figures are as published by Moneycontrol, in ₹ crore.
      </div>`,
    groups: [
      { category: 'Reported figures', items: metricRows({ ...row, meta: m }) },
      {
        category: 'Market',
        items: [
          { label: 'Last traded price', status: null, value: formatRupee(row.ltp), note: `${formatPct(row.changePct)} today. Live from the Moneycontrol feed.` },
          {
            label: 'Return since result',
            criteria: 'Price now vs the close on the result date',
            status: row.returnSinceResult == null ? 'na' : row.returnSinceResult > 0 ? 'pass' : 'fail',
            value: row.returnSinceResult == null ? 'not available' : formatPct(row.returnSinceResult, { decimals: 2 }),
            note: row.basePrice ? `Base ${formatRupee(row.basePrice)}, the close on ${row.basePricedOn}${row.basePricedOn !== row.resultDate ? ' (the result date was not a trading day)' : ''}.` : 'No cached closing price for the result date, so this is not computed rather than shown as zero.',
          },
          {
            label: 'Market cap',
            status: row.marketCap == null ? 'na' : null,
            value: row.marketCap == null ? 'not available' : formatCroreCompact(row.marketCap),
            note: row.marketCapIsLive
              ? 'Computed live: shares outstanding × the price above. The share count is cached; the price is this tick, so this figure is current rather than as-of the last data refresh.'
              : row.inUniverse
                ? 'From the NSE-500 screener export, refreshed by hand.'
                : 'No share count cached for this company, so market cap is not computed.',
          },
        ],
      },
      {
        category: 'Provenance',
        items: [
          { label: 'Figures', status: 'pass', value: 'real', note: 'Published quarterly results, via Moneycontrol Rapid Results. Polled every 30 seconds.' },
          { label: 'Ticker join', status: row.ticker ? 'pass' : 'na', value: row.ticker || 'unresolved', note: `Moneycontrol code ${row.scId} resolved through its price feed. Names are truncated to 15 characters upstream, so the code is the join key, never the name.` },
        ],
      },
    ],
  });
}

async function exportResults(rows, m) {
  const banner = {
    __banner:
      `REAL DATA. Quarterly results as published, via Moneycontrol Rapid Results — ${m?.quarter || ''} (${m?.currentPeriod || ''} vs ${m?.priorPeriod || ''}), ` +
      `captured ${new Date().toISOString()}. Figures in Rs. crore. Where the sign flips between periods the "growth" column reads ` +
      `"To profit" / "To loss" / "Loss narrowed" instead of a percentage, because a percentage change across zero is not a growth rate. ` +
      `Return since result = live price vs the close on the result date. Blank cells mean not joined, not zero.`,
  };
  const pct = (mm) => (mm?.kind === 'normal' ? mm.pct : mm?.kind === 'turnaround' ? 'To profit' : mm?.kind === 'slipped-to-loss' ? 'To loss' : mm?.kind === 'loss-narrowed' ? `Loss narrowed ${mm.pct}%` : mm?.kind === 'loss-widened' ? `Loss widened ${mm.pct}%` : '');
  await exportRows({
    filename: 'sattva-earnings',
    sheetName: 'Latest Results',
    columns: [
      { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.company) },
      { header: 'MCap (Cr)', key: 'm', width: 14, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
      { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Revenue (Cr)', key: 'rv', width: 14, get: (r) => (r.__banner ? '' : (r.revenue?.current ?? '')) },
      { header: 'Revenue YoY', key: 'rg', width: 18, get: (r) => (r.__banner ? '' : pct(r.revenue)) },
      { header: 'Net Profit (Cr)', key: 'np', width: 16, get: (r) => (r.__banner ? '' : (r.netProfit?.current ?? '')) },
      { header: 'PAT YoY', key: 'pg', width: 18, get: (r) => (r.__banner ? '' : pct(r.netProfit)) },
      { header: 'Return Since Result %', key: 'rs', width: 20, get: (r) => (r.__banner ? '' : (r.returnSinceResult ?? '')) },
      { header: 'Basis', key: 'b', width: 14, get: (r) => (r.__banner ? '' : r.basis) },
    ],
    rows: [banner, ...rows],
  });
}


