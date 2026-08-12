// concall/scans.js — the two LIVE Con-call sub-views, off StockScans.
//
//   renderScans(ctx)     the quarter's calls: result score, sentiment, highlights, links
//   renderSchedule(ctx)  today's calls and what is coming
//
// EVERYTHING SCORED HERE IS STOCKSCANS' OWN ANALYSIS.
//   `resultScore` (0-100), `sentimentTier` (0-4) and the highlight bullets are theirs, rendered
//   unchanged. The tier LABELS come from their published bands (see data/stockscans-shared.js),
//   so "Strong" here means what "Strong" means there. We deliberately compute nothing of our own
//   on top — a number under our chrome that they did not produce would be the dishonest case, and
//   a band of our own invention under their score would be worse.
//
//   That is why this view uses `scoreTable`'s Score column with `max: 100` rather than the
//   dashboard's usual points-out-of-max: it is a published index, not a model of ours.
//
// PENDING IS NOT ZERO.
//   A call appears on the feed when it is HELD and acquires its analysis some minutes later.
//   Until then `resultScore` is null and StockScans' own UI says "pending". A zero would claim
//   they had assessed it and found it worthless.

import { scoreTable, sectionHead, openDrill, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { deliveryNote } from '../ui/sources.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/concall-scans.js';

const ATTRIBUTION = 'Scores, sentiment and highlights are StockScans’ own analysis, shown unchanged.';

// StockScans' tone vocabulary -> our semantic palette. Emerald/amber/rose are pass/partial/fail
// here, which is exactly what these tiers mean, so the mapping is honest rather than decorative.
const TONE = {
  excellent: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  grey: 'bg-slate-100 text-slate-600 ring-slate-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-rose-50 text-rose-700 ring-rose-200',
};

const pendingPill = (what) =>
  `<span class="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-400 ring-1 ring-slate-200" title="StockScans has not published ${escapeHtml(what)} for this call yet. Not zero — not yet analysed.">pending</span>`;

function tierPill(tier, title) {
  if (!tier) return pendingPill(title || 'an assessment');
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TONE[tier.tone] || TONE.grey}">${escapeHtml(tier.label)}</span>`;
}

// "▲ Revenue guidance raised" — the marker is StockScans'; it carries the direction, so it drives
// the colour rather than any reading of ours.
function highlight(tag) {
  const s = String(tag || '');
  const mark = s.charAt(0);
  const text = s.slice(1).trim() || s;
  const cls = mark === '▲' ? 'text-emerald-700' : mark === '▼' ? 'text-rose-700' : 'text-slate-600';
  const dot = mark === '▲' ? '▲' : mark === '▼' ? '▼' : '●';
  return `<span class="flex items-start gap-1 ${cls}"><span class="mt-px flex-shrink-0 text-[9px] leading-4">${dot}</span><span>${escapeHtml(text)}</span></span>`;
}

// EVERY TIME ON THIS TAB IS IST, EXPLICITLY — NOT THE VIEWER'S ZONE.
//
// An Indian earnings call at 18:00 IST is an 18:00 IST event. Rendering it in the browser's local
// zone turned it into "12:30" on a UTC machine: the same instant, but not the time anyone involved
// would ever call it, and off by a day either side of midnight. Company schedules are published in
// IST and read in IST, so that is what we show, with the zone named so it cannot be misread.
const IST = 'Asia/Kolkata';
const IST_DATE = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' });
const IST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false });
const IST_FULL = new Intl.DateTimeFormat('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' });

function whenCell(iso) {
  if (!iso) return '<span class="text-slate-300">—</span>';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '<span class="text-slate-300">—</span>';
  return `<span class="whitespace-nowrap" title="${escapeHtml(IST_FULL.format(d))} IST">${escapeHtml(IST_DATE.format(d))}<span class="ml-1 text-slate-400">${escapeHtml(IST_TIME.format(d))}</span></span>`;
}

// ---------------------------------------------------------------------------------------
// The Live pill and its provenance modal
// ---------------------------------------------------------------------------------------
export function livePill(m) {
  if (!m) return '';
  const degraded = !!m.degraded;
  const cls = degraded
    ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100'
    : 'bg-emerald-50 text-emerald-800 ring-emerald-300 hover:bg-emerald-100';
  const dot = degraded
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';
  const fresh = feed.newArrivals().length;
  return `
    <button type="button" data-cs-info title="Where this comes from, and what is ours versus theirs"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}">
      ${dot}<span>${degraded ? 'Snapshot' : 'Live'}</span>
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.count || 0))} calls</span>
      ${fresh ? `<span class="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">+${fresh} new</span>` : ''}
    </button>`;
}

export function wireLivePill(root, m) {
  const btn = root.querySelector('[data-cs-info]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const arrivals = feed.newArrivals();
    const pending = feed.all().filter((r) => r.resultScore == null).length;
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">${m.degraded ? 'Showing the last snapshot' : 'Live con-call scan'}</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          ${
            m.degraded
              ? `<p class="rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">${escapeHtml(m.degraded)}
                   The rows below were correct when captured, but they are not live right now.</p>`
              : `<p><strong>Real, live</strong> from <a class="font-semibold text-indigo-600 hover:underline" href="https://www.stockscans.in/concall-scans" target="_blank" rel="noopener">StockScans &rarr; Concall Scans</a>,
                   polled every ${feed.POLL_MS / 1000} seconds.</p>`
          }
          <p class="mt-2"><strong>${escapeHtml(formatNumber(m.count || 0))}</strong> calls this quarter ·
             <strong>${escapeHtml(formatNumber(m.analysed || 0))}</strong> analysed ·
             last update ${escapeHtml(m.receivedAt ? formatRelativeTime(m.receivedAt) : '—')}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Whose numbers these are</h3>
          <p class="mt-1 text-xs"><strong>Not ours.</strong> The result score, the sentiment tier and the highlight bullets are
             StockScans' analysis of each call, reproduced unchanged. Even the tier labels — Excellent / Strong / Average /
             Weak / Poor, and Bullish through Bearish — use their published cut-points, so a label here means what it means
             there. This dashboard adds no scoring of its own to this view, deliberately: a band of our invention under
             their score would read as their judgement and be ours.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How fresh it is</h3>
          <p class="mt-1 text-xs">A call joins the feed when it is <em>held</em> and gains its score some minutes later, once
             StockScans has processed it. The poller watches for both, so a row can arrive twice over: once listed, once
             analysed. ${pending ? `<strong>${escapeHtml(formatNumber(pending))}</strong> calls are listed but not yet analysed — they read <em>pending</em>, never zero.` : ''}</p>

          ${deliveryNote(m, { poll: feed.POLL_MS / 1000 })}

          ${
            arrivals.length
              ? `<h3 class="font-display mt-4 text-sm font-bold text-slate-900">Arrived while this tab was open</h3>
                 <div class="mt-1 flex flex-wrap gap-1.5">
                   ${arrivals
                     .slice(0, 20)
                     .map(
                       (r) =>
                         `<span class="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200" title="${r.reason === 'analysed' ? 'analysis published' : 'newly listed'}">${escapeHtml(r.ticker || r.name)}${r.reason === 'analysed' ? ' ✓' : ''}</span>`
                     )
                     .join('')}
                 </div>
                 <p class="mt-1 text-[11px] text-slate-500">A tick means the call was already listed and has just been analysed.</p>`
              : ''
          }
          <p class="mt-4 text-xs text-slate-500">Full summaries and transcripts live on StockScans; each row links straight to theirs.</p>
        </div>
      </div>`,
      { size: 'default' }
    );
  });
}

// ---------------------------------------------------------------------------------------
// Sub-view 1 — the scan table
// ---------------------------------------------------------------------------------------
export function renderScans(ctx, { disposers, tableView, onView }) {
  const m = feed.meta();
  const rows = feed.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);

  const table = scoreTable({
    rows,
    key: (r) => `${r.companyKey}|${r.when}`,
    name: (r) => r.name,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || '—'}`,
    showRank: false,
    nameAfter: 1,
    dense: true,
    nameMaxPx: 250,
    stickyHead: 'max(320px, calc(100vh - 330px))',
    columns: [
      { label: 'Call', get: (r) => whenCell(r.when), html: true, align: 'left', sortValue: (r) => r.when || '' },
      {
        // Their index, on their scale. `max: 100` and no tier colouring of our own — the badge
        // beside it is their label for that band.
        label: 'Result Score',
        get: (r) =>
          r.resultScore == null
            ? pendingPill('a result score')
            : `<span class="font-semibold tabular-nums text-slate-900">${escapeHtml(r.resultScore.toFixed(1))}</span><span class="ml-1 text-[10px] text-slate-400">/100</span>`,
        html: true,
        align: 'right',
        sortValue: (r) => r.resultScore ?? -1,
      },
      { label: 'Result', get: (r) => tierPill(r.resultTier, 'a result score'), html: true, align: 'right', sortValue: (r) => r.resultScore ?? -1 },
      { label: 'Sentiment', get: (r) => tierPill(r.sentiment, 'a sentiment reading'), html: true, align: 'right', sortValue: (r) => r.sentimentTier ?? -1 },
      {
        label: 'Highlights',
        get: (r) =>
          r.tags.length
            ? `<div class="flex max-w-[430px] flex-col gap-0.5 whitespace-normal text-[11px] leading-snug">${r.tags.slice(0, 3).map(highlight).join('')}</div>`
            : `<span class="text-slate-300">—</span>`,
        html: true,
        sortable: false,
      },
    ],
    filters: [
      {
        label: 'Result tier',
        options: [
          { value: 'all', label: 'All results' },
          { value: 'excellent', label: 'Excellent (80+)' },
          { value: 'strong', label: 'Strong (60+)' },
          { value: 'weak', label: 'Weak or Poor (<40)' },
          { value: 'pending', label: 'Awaiting analysis' },
        ],
        match: (r, v) => {
          if (v === 'pending') return r.resultScore == null;
          if (r.resultScore == null) return false;
          if (v === 'excellent') return r.resultScore >= 80;
          if (v === 'strong') return r.resultScore >= 60;
          if (v === 'weak') return r.resultScore < 40;
          return true;
        },
      },
      {
        label: 'Sentiment',
        options: [
          { value: 'all', label: 'All sentiment' },
          { value: '4', label: 'Bullish' },
          { value: '3', label: 'Optimistic' },
          { value: '2', label: 'Neutral' },
          { value: '1', label: 'Cautious' },
          { value: '0', label: 'Bearish' },
        ],
        match: (r, v) => String(r.sentimentTier) === v,
      },
    ],
    searchable: (r) => `${r.name} ${r.ticker || ''} ${r.industry || ''} ${r.tags.join(' ')}`,
    initialSort: { key: 'Call', dir: 'desc' },
    onRowClick: (r) => drillCall(r, m),
    exportName: 'sattva-concall-scans',
    onExport: (visible) => exportScans(visible, m),
    emptyMessage: ctx.scope === 'portfolio' ? 'None of your holdings has held a call this quarter.' : 'No calls match your filters.',
    initialView: tableView,
  });
  onView?.(table.view);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Concall Scans',
      description: `Every earnings call held this quarter, newest first. Times are IST. ${ATTRIBUTION}`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'calls' })}</div>`,
    })}
    ${table.html}
  `;
  wireLivePill(ctx.root, m);
  disposers.push(table.wire(ctx.root));
}

// ---------------------------------------------------------------------------------------
// Sub-view 2 — today and upcoming
// ---------------------------------------------------------------------------------------
export function renderSchedule(ctx, { disposers }) {
  const m = feed.meta();
  const held = ctx.data?.portfolio?.holdings || [];
  const today = feed.today();
  const todayRows = feed.forScope(ctx.scope, held, today.rows || []);
  const upcomingRows = feed.forScope(ctx.scope, held, feed.upcoming());

  const card = (label, rows, empty) => `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 flex items-baseline justify-between gap-3">
        <h3 class="font-display text-sm font-bold text-slate-900">${escapeHtml(label)}</h3>
        <span class="text-xs text-slate-500">${escapeHtml(formatNumber(rows.length))} ${rows.length === 1 ? 'call' : 'calls'}</span>
      </div>
      ${
        rows.length
          ? `<div class="scrollbar-thin max-h-[420px] overflow-y-auto"><ul class="divide-y divide-slate-100">
               ${rows
                 .map(
                   (r) => `<li class="flex items-center gap-3 py-2">
                     <span class="w-14 flex-shrink-0 text-xs font-semibold tabular-nums text-indigo-600">${escapeHtml(timeOf(r.when))}</span>
                     <span class="min-w-0 flex-1 truncate text-sm text-slate-800">${escapeHtml(r.name)}</span>
                     <span class="flex-shrink-0 font-mono text-[11px] text-slate-400">${escapeHtml(r.ticker || '—')}</span>
                   </li>`
                 )
                 .join('')}
             </ul></div>`
          : `<p class="py-6 text-center text-sm text-slate-500">${escapeHtml(empty)}</p>`
      }
    </section>`;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Today & Upcoming',
      description: 'Calls scheduled by StockScans, with their listed start times in IST. Times are as published and do slip.',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}${scopeSummary({ scope: ctx.scope, count: todayRows.length + upcomingRows.length, noun: 'scheduled' })}</div>`,
    })}
    <div class="grid gap-0 md:grid-cols-2 md:gap-5">
      ${card(today.day ? `Today · ${today.day}` : 'Today', todayRows, ctx.scope === 'portfolio' ? 'None of your holdings is on today.' : 'No calls listed for today.')}
      ${card('Upcoming', upcomingRows, ctx.scope === 'portfolio' ? 'None of your holdings has a call scheduled.' : 'Nothing scheduled yet.')}
    </div>
    <p class="mb-6 text-[11px] leading-relaxed text-slate-500">
      A call listed here has not been held yet, so it carries no score — it appears in <strong>Concall Scans</strong> with
      its analysis once StockScans has processed it. Schedule from
      <a class="font-medium text-indigo-600 hover:underline" href="https://www.stockscans.in/concall-scans" target="_blank" rel="noopener">StockScans</a>.
    </p>`;
  wireLivePill(ctx.root, m);
  void disposers;
}

function timeOf(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : IST_TIME.format(d);
}

// ---------------------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------------------
function drillCall(row, m) {
  openDrill({
    name: row.name,
    sub: `${row.ticker || 'no ticker'} · ${row.industry || '—'}`,
    link: row.transcriptUrl,
    linkLabel: 'Open on StockScans ↗',
    headerStats: [
      {
        label: 'Result score',
        value: row.resultScore == null ? 'pending' : `${row.resultScore.toFixed(1)}`,
        caption: row.resultTier ? row.resultTier.label : 'not yet analysed',
        tone: row.resultScore == null ? 'neutral' : row.resultScore >= 60 ? 'positive' : row.resultScore < 40 ? 'negative' : 'neutral',
      },
      {
        label: 'Sentiment',
        value: row.sentiment ? row.sentiment.label : 'pending',
        caption: row.sentimentTier == null ? 'not yet analysed' : `tier ${row.sentimentTier} of 4`,
        tone: (row.sentimentTier ?? 2) >= 3 ? 'positive' : (row.sentimentTier ?? 2) <= 1 ? 'negative' : 'neutral',
      },
    ],
    beforeGroupsHtml: `
      <div class="mb-4 rounded-xl bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-900 ring-1 ring-emerald-200">
        <strong>Call held ${escapeHtml(IST_FULL.format(new Date(row.when)))} IST</strong>
        ${m?.quarter ? ` · quarter ${escapeHtml(String(m.quarter))}` : ''}.
        ${escapeHtml(ATTRIBUTION)}
      </div>
      ${
        row.tags.length
          ? `<div class="mb-4 space-y-1.5 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed ring-1 ring-slate-200">
               <div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Highlights</div>
               ${row.tags.map(highlight).join('')}
             </div>`
          : ''
      }`,
    groups: [
      {
        category: 'StockScans’ assessment',
        items: [
          {
            label: 'Result score',
            criteria: 'StockScans’ own 0–100 index for the reported quarter',
            status: row.resultScore == null ? 'na' : row.resultScore >= 60 ? 'pass' : row.resultScore >= 40 ? 'partial' : 'fail',
            value: row.resultScore == null ? 'pending' : `${row.resultScore.toFixed(1)} / 100 — ${row.resultTier?.label}`,
            note: 'Bands are StockScans’: 80+ Excellent, 60+ Strong, 40+ Average, 20+ Weak, below that Poor. This dashboard does not re-band or recompute it.',
          },
          {
            label: 'Management sentiment',
            criteria: 'StockScans’ 0–4 reading of management tone on the call',
            status: row.sentimentTier == null ? 'na' : row.sentimentTier >= 3 ? 'pass' : row.sentimentTier === 2 ? 'partial' : 'fail',
            value: row.sentiment ? `${row.sentiment.label} (${row.sentimentTier}/4)` : 'pending',
            note: '4 Bullish · 3 Optimistic · 2 Neutral · 1 Cautious · 0 Bearish.',
          },
          {
            label: 'Summary published',
            status: row.notesReady ? 'pass' : 'na',
            value: row.notesReady ? 'yes' : 'not yet',
            note: row.notesReady
              ? 'The full call summary is on StockScans — use the link above.'
              : 'The call is listed but StockScans has not published its summary yet. Not an absence of news; an absence of analysis so far.',
          },
        ],
      },
      {
        category: 'Provenance',
        items: [
          { label: 'Source', status: 'pass', value: 'StockScans', note: 'stockscans.in/concall-scans, polled every 30 seconds through this dashboard’s Worker. Scores and highlights are reproduced unchanged and are not this dashboard’s analysis.' },
          { label: 'Ticker', status: row.ticker ? 'pass' : 'na', value: row.companyId || '—', note: 'StockScans’ own exchange-qualified identifier; the NSE symbol is taken from it directly rather than name-matched.' },
          { label: 'Full transcript', status: row.transcriptUrl ? 'pass' : 'na', value: row.transcriptUrl ? 'on StockScans' : 'not published', note: 'Transcripts and full summaries stay on StockScans — this dashboard links to them rather than reproducing them.' },
        ],
      },
    ],
  });
}

async function exportScans(rows, m) {
  const banner = {
    __banner:
      `REAL DATA, NOT OURS. Con-call scans via StockScans (stockscans.in/concall-scans) — quarter ${m?.quarter || ''}, ` +
      `captured ${new Date().toISOString()}. The result score (0-100), the sentiment tier (0-4) and the highlight bullets are ` +
      `StockScans' own analysis, reproduced unchanged; this dashboard adds no scoring of its own. Tier labels use StockScans' ` +
      `published bands. "pending" means the call is listed but not yet analysed — it is not a zero.`,
  };
  await exportRows({
    filename: 'sattva-concall-scans',
    sheetName: 'Concall Scans',
    columns: [
      { header: 'Call Date', key: 'd', width: 20, get: (r) => (r.__banner ? r.__banner : r.when) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Industry', key: 'i', width: 28, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Result Score (StockScans)', key: 's', width: 24, get: (r) => (r.__banner ? '' : (r.resultScore ?? 'pending')) },
      { header: 'Result Tier (StockScans)', key: 'rt', width: 22, get: (r) => (r.__banner ? '' : r.resultTier?.label || 'pending') },
      { header: 'Sentiment (StockScans)', key: 'st', width: 22, get: (r) => (r.__banner ? '' : r.sentiment?.label || 'pending') },
      { header: 'Highlights (StockScans)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.tags.join(' | ')) },
      { header: 'StockScans Link', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.transcriptUrl || '') },
    ],
    rows: [banner, ...rows],
  });
}
