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
//
//   That is also why the table carries BOTH periods for all three metrics rather than the growth
//   percentage alone. A percentage is a ratio with its numerator and denominator thrown away:
//   "+43%" is the same cell whether the company earned ₹4 Cr or ₹4,000 Cr, and Vodafone Idea's
//   PAT "+43%" is -6,608 → -3,754. The reported figures sit next to the percentage so the reader
//   can see what it was computed from, on the row itself.
//
// WHY THERE IS NO DRILL PANEL
//   There was one, and the six reported figures were the bulk of what it said — so once those
//   became columns it was mostly restating the row you clicked. Rows are not clickable now.
//   Nothing accountable was lost with it: the return-since-result figure it explained is no
//   longer a column at all, and the provenance it carried (what is live, where each column is
//   joined from, how market cap is computed, what a dash means) lives behind the Live pill,
//   which is one click from anywhere on the page rather than one click per row.
//
//   Do not re-add a drill to hold a number that could be a column. Add the column.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatCroreCompact, formatPct, formatNumber, formatRupee, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as feed from '../data/earnings-live.js';
import * as calendar from '../data/earnings-calendar.js';

export const meta = {
  id: 'earnings-hub',
  title: 'Earnings Hub',
  subtitle: 'Live quarterly results across the listed universe, updated as companies report.',
  // No sub-views: this tab is one table. The shell hides the rail entirely when this is empty.
  subviews: [],
};

// The two halves of this tab: what has been reported, and what is scheduled. Same source, same
// quarter, opposite direction in time.
const VIEWS = [
  { value: 'reported', label: 'Earnings Reported', help: 'Companies that have already filed this quarter' },
  { value: 'calendar', label: 'Earnings Calendar', help: 'Companies scheduled to report, by date' },
];

let disposers = [];
let renderToken = 0;
let calendarDate = null; // the selected date in the calendar view
let calendarBusy = false;
// The table is rebuilt whenever a company files. Carrying its view forward means the reader's
// search, filters, watchlist toggle and sort survive that rebuild instead of resetting under them.
let tableView = null;
// Set when a QoQ/YoY switch was asked for and could not be made. Rendered as an amber note rather
// than swallowed, because the alternative is one comparison shown under the other's label.
let periodError = null;

export function render(ctx) {
  const token = ++renderToken;
  ctx.root.innerHTML = loadingHtml();

  feed
    .load()
    .then(async () => {
      if (token !== renderToken) return;
      // Restore the comparison basis from the URL, so ?period=qoq is a shareable link and survives
      // a reload. A failure here is reported, never silently downgraded to the other basis.
      const wanted = ctx.params?.period;
      if (wanted && wanted !== feed.currentSubType()) {
        try {
          await feed.setSubType(wanted);
          periodError = null;
        } catch (err) {
          periodError = String(err.message || err);
        }
        if (token !== renderToken) return;
      }
      paint(ctx);
      // One subscription for the life of the tab: the poller repaints in place on real change.
      disposers.push(
        feed.onChange(() => {
          if (token !== renderToken) return;
          // A results tick must not repaint the calendar out from under the reader. Different
          // half of the tab, different upstream, different refresh cadence.
          if (viewOf(ctx) === 'reported') paint(ctx);
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
  // Leaving the tab is a deliberate exit; coming back should be a clean table, not last visit's
  // half-applied filter. Only a live repaint carries the view forward.
  tableView = null;
  periodError = null;
  calendarDate = null;
  calendar.reset();
}

/** Which half of the tab the URL is asking for. Anything unrecognised falls back to reported. */
const viewOf = (ctx) => (ctx.params?.view === 'calendar' ? 'calendar' : 'reported');

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  if (viewOf(ctx) === 'calendar') renderCalendar(ctx);
  else renderLatest(ctx);
}

/**
 * Reported / Calendar. Not a filter — two different upstreams answering opposite questions about
 * the same quarter, so each half owns its own toolbar, its own freshness and its own caveats.
 */
function viewToggle(active) {
  return `
    <div class="inline-flex items-center gap-1 rounded-full bg-slate-100 p-0.5 ring-1 ring-slate-200" data-view-toggle>
      ${VIEWS.map(
        (v) => `<button type="button" data-view="${v.value}" title="${escapeHtml(v.help)}" aria-pressed="${v.value === active}"
             class="rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
               v.value === active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
             }">${escapeHtml(v.label)}</button>`
      ).join('')}
    </div>`;
}

function wireViewToggle(root, ctx) {
  for (const btn of root.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view;
      if (next === viewOf(ctx)) return;
      // setParams, not setParamsQuiet: this swaps the whole panel, so a re-mount is exactly right
      // and it gives the calendar half a clean load rather than a half-torn-down results table.
      ctx.setParams({ ...ctx.params, view: next });
    });
  }
}

const rowsFor = (ctx) => feed.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/**
 * Moneycontrol publishes whole-number percentages, so `formatPct`'s fixed decimal renders an
 * invented ".0" on 99% of cells and widens three columns for nothing. Keep the decimal only where
 * the value genuinely has one.
 */
function pctText(v) {
  if (v == null) return '—';
  return Number.isInteger(v) ? `${v > 0 ? '+' : ''}${v}%` : formatPct(v);
}

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
    return `<span class="font-semibold ${cls}">${escapeHtml(pctText(m.pct))}</span>`;
  }
  if (m.kind === 'loss-flat') {
    return `<span class="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-200"
       title="Loss in both periods and unchanged: ${escapeHtml(formatNumber(m.prior))} Cr → ${escapeHtml(formatNumber(m.current))} Cr.">Loss flat</span>`;
  }
  if (m.kind === 'loss-narrowed' || m.kind === 'loss-widened') {
    const narrowed = m.kind === 'loss-narrowed';
    const cls = narrowed ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-rose-50 text-rose-700 ring-rose-200';
    return `<span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${cls}"
       title="Loss in both periods: ${escapeHtml(formatNumber(m.prior))} Cr → ${escapeHtml(formatNumber(m.current))} Cr. A percentage here describes the size of the loss, not profit growth.">Loss&nbsp;${narrowed ? '↓' : '↑'}${m.pct != null ? escapeHtml(Math.abs(m.pct).toFixed(0)) + '%' : ''}</span>`;
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

/**
 * One reported ₹ crore figure.
 *
 * A loss is tinted rose. Next to a five-figure revenue line a bare "-433" is genuinely easy to
 * read past, and the whole reason these columns exist is that the growth percentage alone hides
 * the sign. `muted` dims the prior-period column so the current period stays the primary read
 * without having to make the comparison column smaller or move it away.
 */
function figureCell(v, { muted = false } = {}) {
  if (v == null) return '<span class="text-slate-300">—</span>';
  const cls = v < 0 ? (muted ? 'text-rose-400' : 'font-medium text-rose-600') : muted ? 'text-slate-400' : 'text-slate-700';
  return `<span class="${cls}">${escapeHtml(formatNumber(v))}</span>`;
}

// Sort value that keeps the pills in a sensible order rather than dumping them all at one end.
function changeSortValue(m) {
  if (!m) return -Infinity;
  if (m.kind === 'normal') return m.pct ?? -Infinity;
  if (m.kind === 'turnaround') return 1e6; // best possible outcome, sorts above any percentage
  if (m.kind === 'slipped-to-loss') return -1e6;
  if (m.kind === 'loss-flat') return -5e5;
  if (m.kind === 'loss-narrowed') return (m.pct ?? 0) - 5e5; // improving, but still loss-making
  if (m.kind === 'loss-widened') return -5e5 - Math.abs(m.pct ?? 0);
  return -Infinity;
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
  // Spelled out, like the header. "CON" and "STD" saved 45px and cost every reader who has not
  // met the abbreviations a guess about whether they are looking at the group or the parent.
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${con ? 'bg-slate-100 text-slate-500' : 'bg-violet-50 text-violet-600'}"
     title="${escapeHtml(basis || 'unknown')} results — ${con ? 'the whole group' : 'the parent company alone'}">${con ? 'Consolidated' : 'Standalone'}</span>`;
}

// ---------------------------------------------------------------------------------------
// Chrome — one small live button, and the provenance behind it on click.
//
// This page used to open with a green ribbon, a "just reported" strip and a 4-card stat row
// before you reached a single result. That is a lot of furniture in front of the thing people
// came for. It is now a pill in the section head.
//
// The provenance did NOT go away — it moved behind the pill. What is live, what is joined, what
// is missing and how the return is measured are all one click away. Deleting them outright would
// have made the page cleaner and the numbers less accountable.
// ---------------------------------------------------------------------------------------
function liveButton(m, rows) {
  if (!m) return '';
  const degraded = !!m.degraded;
  const cls = degraded
    ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100'
    : 'bg-emerald-50 text-emerald-800 ring-emerald-300 hover:bg-emerald-100';
  const dot = degraded
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';

  const arrivals = feed.newArrivals().length;
  return `
    <button type="button" data-live-info
      title="What this feed is, and how fresh"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}">
      ${dot}
      <span>${degraded ? 'Snapshot' : 'Live'}</span>
      <span class="font-normal opacity-70">${escapeHtml(m.quarter || '')} · ${escapeHtml(formatNumber(rows.length))} reported</span>
      ${arrivals ? `<span class="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">+${arrivals} new</span>` : ''}
    </button>`;
}

/**
 * YoY / QoQ. The current-period figures are identical between the two — only the comparison
 * changes — so this switches what the "prior" columns and every percentage MEAN, not what quarter
 * you are looking at. That is exactly why the column headers carry the period names.
 */
function periodToggle(m) {
  const active = m?.subType || feed.currentSubType();
  const help = { yoy: 'Compare against the same quarter last year', qoq: 'Compare against the previous quarter' };
  return `
    <div class="inline-flex items-center gap-1 rounded-full bg-slate-100 p-0.5 ring-1 ring-slate-200" data-period-toggle>
      ${feed.SUB_TYPES.map(
        (s) => `<button type="button" data-period="${s.value}" title="${escapeHtml(help[s.value] || '')}"
             aria-pressed="${s.value === active}"
             class="rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
               s.value === active ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
             }">${escapeHtml(s.label)}</button>`
      ).join('')}
    </div>`;
}

function wirePeriodToggle(root, ctx) {
  const btns = [...root.querySelectorAll('[data-period]')];
  for (const btn of btns) {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.period;
      if (next === feed.currentSubType()) return;
      btns.forEach((b) => (b.disabled = true));
      try {
        await feed.setSubType(next); // notifies -> paint()
        periodError = null;
        // Quiet, not setParams: setParams re-mounts the tab, which would refetch what we just
        // fetched and throw away the table's view. The URL still updates, so the link is shareable.
        ctx.setParamsQuiet({ ...ctx.params, period: next });
      } catch (err) {
        btns.forEach((b) => (b.disabled = false));
        periodError = String(err.message || err);
        paint(ctx);
      }
    });
  }
}

function wireLiveButton(root, m, rows) {
  const btn = root.querySelector('[data-live-info]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const arrivals = feed.newArrivals();
    const noTicker = rows.filter((r) => !r.ticker).length;
    const noCap = rows.filter((r) => r.marketCap == null).length;
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">${m.degraded ? 'Showing the last snapshot' : 'Live results feed'}</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          ${
            m.degraded
              ? `<p class="rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">${escapeHtml(m.degraded)}
                   The figures below are real and were correct when captured, but they are not live right now.</p>`
              : `<p><strong>Real reported figures</strong> from Moneycontrol Rapid Results, in ₹ crore, polled every
                   ${feed.POLL_MS / 1000} seconds. A company that files now appears here within about a minute — no reload.</p>`
          }
          <p class="mt-2"><strong>${escapeHtml(m.quarter || '')}</strong> · comparing ${escapeHtml(m.currentPeriod || '')} against ${escapeHtml(m.priorPeriod || '')} ·
             <strong>${escapeHtml(formatNumber(rows.length))}</strong> companies reported ·
             last update ${escapeHtml(m.receivedAt ? formatRelativeTime(m.receivedAt) : '—')}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Where each column comes from</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
            <li><strong>Rev / PAT, both periods</strong> — as published, in ₹ crore, unrounded. Both periods are shown
                because the percentage alone hides the sign and the scale: "+43%" reads the same on ₹4 Cr and ₹4,000 Cr,
                and on a loss that merely got smaller. Gross profit is in the feed and in the Excel export, but is not
                a column — three metrics × three columns did not fit on screen.</li>
            <li><strong>YoY / QoQ</strong> — the same filing, compared two ways. The ${escapeHtml(m.currentPeriod || 'current')}
                figures are identical under both; only the comparison column and the percentage change.
                YoY is ${escapeHtml(m.currentPeriod || '')} against the same quarter a year earlier, QoQ against the
                quarter before it. The column headers name whichever is active, so a screenshot cannot mislead.</li>
            <li><strong>Basis</strong> — CON is consolidated (the whole group), STD is standalone (the parent alone).
                They are not comparable with each other, which is what the second dropdown is for.</li>
            <li><strong>The % columns</strong> — as published. Where the sign flips between periods you get a labelled pill
                instead of a percentage, because a change across zero is not a growth rate.</li>
            <li><strong>Ticker and industry</strong> (under the company name) — resolved from Moneycontrol's own company
                code; names are truncated to 15 characters upstream, so the code is the join key, never the name.
                ${noTicker ? `<strong>${formatNumber(noTicker)}</strong> unresolved.` : 'All resolved.'}</li>
            <li><strong>MCap</strong> — computed live as shares outstanding × the current price, so it is correct now rather
                than as of the last data refresh. ${noCap ? `<strong>${formatNumber(noCap)}</strong> without a share count.` : ''}</li>
          </ul>

          ${
            arrivals.length
              ? `<h3 class="font-display mt-4 text-sm font-bold text-slate-900">Arrived while this tab was open</h3>
                 <div class="mt-1 flex flex-wrap gap-1.5">
                   ${arrivals.slice(0, 20).map((r) => `<span class="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">${escapeHtml(r.ticker || r.shortName)}</span>`).join('')}
                 </div>`
              : ''
          }
          <p class="mt-4 text-xs text-slate-500">A dash in any column means <em>not joined</em> — never zero.</p>
        </div>
      </div>`,
      { size: 'default' }
    );
  });
}

// ---------------------------------------------------------------------------------------
// Latest Results — the table
// ---------------------------------------------------------------------------------------
function renderLatest(ctx) {
  const rows = rowsFor(ctx);
  const m = feed.meta();

  // Column headers name the actual periods being compared — "REV JUN 26" / "REV JUN 25" — rather
  // than "current" and "prior". A screenshot of this table should say which quarters it is,
  // because a growth percentage is meaningless without knowing what it is measured against.
  const cur = m?.currentPeriod || 'Current';
  const pri = m?.priorPeriod || 'Prior';

  // Ticker and industry are not columns any more: they live on the second line of the identity
  // cell, where they stay searchable and visible without costing two columns of width. The width
  // freed up goes to the reported figures, which is what the growth percentages are derived from.
  const table = scoreTable({
    rows,
    key: (r) => r.scId,
    name: (r) => r.company,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || r.sectorSlug || '—'}`,
    // No rank counter: a results table is sorted by date, and "#7" against a date-ordered list is
    // a position, not a ranking, so it invites a reading the data does not support. The watchlist
    // star moves into the company cell. `nameAfter: 1` puts Date ahead of the company name.
    showRank: false,
    nameAfter: 1,
    dense: true,
    // Ten columns leave room the thirteen did not, so the identity column gets it back: fewer
    // industries truncate and the ticker never does.
    nameMaxPx: 260,
    // The head has to stay put on a 1,300-row table. This turns the table body into its own
    // scroller, which is what makes `sticky` engage — see `stickyHead` in screener.js. The
    // subtraction is the header, tab bar, section head and toolbar above it.
    stickyHead: 'max(320px, calc(100vh - 300px))',
    columns: [
      // Newest first, and within a day Moneycontrol's own order — see `dateSortValue`.
      { label: 'Date', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: feed.dateSortValue },

      // Revenue then net profit, each as reported for both periods followed by the change, so a
      // row reads across the way the filing does. Headers spell the metric out: "PAT" and "REV"
      // are trade shorthand, and this table is read by people who did not write it.
      { label: `Revenue ${cur}`, get: (r) => figureCell(r.revenue?.current), html: true, align: 'right', sortValue: (r) => r.revenue?.current ?? -Infinity },
      { label: `Revenue ${pri}`, get: (r) => figureCell(r.revenue?.prior, { muted: true }), html: true, align: 'right', sortValue: (r) => r.revenue?.prior ?? -Infinity },
      { label: 'Revenue Growth', get: (r) => changeCell(r.revenue), html: true, align: 'right', sortValue: (r) => changeSortValue(r.revenue) },

      // Gross profit is not shown. The feed still carries it and the export still includes it —
      // it is only the on-screen columns that were cut, to keep the table readable.
      { label: `Net Profit ${cur}`, get: (r) => figureCell(r.netProfit?.current), html: true, align: 'right', sortValue: (r) => r.netProfit?.current ?? -Infinity },
      { label: `Net Profit ${pri}`, get: (r) => figureCell(r.netProfit?.prior, { muted: true }), html: true, align: 'right', sortValue: (r) => r.netProfit?.prior ?? -Infinity },
      { label: 'Net Profit Growth', get: (r) => changeCell(r.netProfit), html: true, align: 'right', sortValue: (r) => changeSortValue(r.netProfit) },

      { label: 'Market Cap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
      { label: 'Basis', get: (r) => basisPill(r.basis), html: true, align: 'right', sortValue: (r) => r.basis || '' },
    ],
    // Two dropdowns, not one: "PAT grew" and "Consolidated only" are different questions and a
    // reader should be able to ask both at once.
    filters: [
      {
        label: 'Result shape',
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
      {
        // Reporting basis. A group's consolidated numbers and the parent's standalone numbers are
        // not comparable, so screening across a mix of both is a real trap — Moneycontrol offers
        // the same three-way choice for the same reason. The Basis column shows which each row is.
        label: 'Reporting basis',
        options: [
          { value: 'all', label: 'All' },
          { value: 'con', label: 'Consolidated' },
          { value: 'std', label: 'Standalone' },
        ],
        match: (r, v) => (v === 'con' ? r.basis === 'Consolidated' : v === 'std' ? r.basis === 'Standalone' : true),
      },
    ],
    searchable: (r) => `${r.company} ${r.shortName} ${r.ticker || ''} ${r.industry || ''} ${r.sectorSlug || ''}`,
    // Newest first. The view is called Latest Results and Moneycontrol's own page defaults the
    // same way, so anything else is a surprise. It used to default to Return Since Result, which
    // had a nastier consequence than mere preference: a company that reported TODAY has no cached
    // result-day close yet, so its return is null and it sorted to the very bottom — the four
    // newest filings landed at positions 1313-1316 of 1326. Return is still one header click away.
    initialSort: { key: 'Date', dir: 'desc' },
    // No onRowClick, deliberately — see "WHY THERE IS NO DRILL PANEL" at the top of this file.
    exportName: 'sattva-earnings',
    onExport: (visible) => exportResults(visible, m),
    emptyMessage: ctx.scope === 'portfolio' ? 'None of your holdings has reported in this quarter yet.' : 'No results match your filters.',
    initialView: tableView,
  });
  tableView = table.view;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Latest Results',
      description: `Every company that has reported this quarter, newest first. Reported figures in ₹ crore${m?.currentPeriod ? `, ${m.currentPeriod} against ${m.priorPeriod}` : ''}.`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${viewToggle('reported')}${periodToggle(m)}${liveButton(m, rows)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'reported' })}</div>`,
    })}
    ${
      periodError
        ? `<div class="mb-4 rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
             <strong>Comparison not switched.</strong> ${escapeHtml(periodError)}
             You are still looking at ${escapeHtml((m?.subType || 'yoy').toUpperCase())} — ${escapeHtml(m?.currentPeriod || '')} against ${escapeHtml(m?.priorPeriod || '')}, as the column headers say.
           </div>`
        : ''
    }
    ${table.html}
  `;
  wireViewToggle(ctx.root, ctx);
  wirePeriodToggle(ctx.root, ctx);
  wireLiveButton(ctx.root, m, rows);
  disposers.push(table.wire(ctx.root));
}

// ---------------------------------------------------------------------------------------
// Earnings Calendar — who is SCHEDULED to report, and when.
//
// TWO NUMBERS THAT MUST NEVER BE CONFLATED
//   `scheduledCount` is complete: Moneycontrol's calendar API gives the true number reporting on
//   each date. The company LIST is the twenty largest by market cap — the page cannot be paged
//   past and the route its own "load more" uses is blocked to non-browser clients (see the header
//   of worker/mc.mjs). So on a busy day this table shows 20 of 206, and it says exactly that.
//   Rendering twenty rows under a plain heading would assert that twenty is all there are.
// ---------------------------------------------------------------------------------------

// "2026-08-13" -> "Thu 13 Aug". The strip needs the weekday: results cluster on weekdays and a
// gap that turns out to be a Sunday is not the same information as a quiet Wednesday.
function stripLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${wd} ${d.getUTCDate()} ${mo}`;
}

function dateStrip(active, today) {
  const days = calendar.strip();
  if (!days.length) return '';
  // Oldest first reads like a calendar; the API hands them back newest first.
  const ordered = [...days].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return `
    <div class="scrollbar-thin mb-4 flex gap-2 overflow-x-auto pb-2" data-date-strip>
      ${ordered
        .map((d) => {
          const on = d.date === active;
          const empty = !d.count;
          const isToday = d.date === today;
          return `<button type="button" data-date="${escapeHtml(d.date)}" ${empty ? 'disabled' : ''}
            title="${escapeHtml(stripLabel(d.date))}${empty ? ' — nothing scheduled' : ` — ${formatNumber(d.count)} companies`}"
            class="flex min-w-[92px] flex-shrink-0 flex-col items-center rounded-xl px-3 py-2 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
              on
                ? 'bg-indigo-600 text-white shadow-sm'
                : empty
                  ? 'cursor-default bg-slate-50 text-slate-300 ring-1 ring-slate-100'
                  : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-indigo-50 hover:text-indigo-700'
            }">
            <span class="font-semibold ${on ? '' : isToday ? 'text-indigo-600' : ''}">${escapeHtml(stripLabel(d.date))}${isToday ? ' ·' : ''}</span>
            <span class="mt-0.5 font-bold tabular-nums ${on ? 'text-white' : empty ? '' : 'text-slate-900'}">${d.count ? formatNumber(d.count) : '—'}</span>
          </button>`;
        })
        .join('')}
    </div>`;
}

function renderCalendar(ctx) {
  const today = new Date().toISOString().slice(0, 10);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params?.date || '') ? ctx.params.date : calendarDate || today;
  calendarDate = wanted;
  const payload = calendar.forDate(wanted);

  // Not loaded yet: fetch, then repaint. Guarded three ways — `calendarBusy` stops a rapid walk
  // along the strip stacking paints, and `errorFor` stops the retry loop that a failure would
  // otherwise create, because the repaint that follows a failed load asks for the same date again.
  if (!payload && !calendarBusy && !calendar.errorFor(wanted)) {
    calendarBusy = true;
    const token = renderToken;
    calendar
      .loadDate(wanted)
      .catch(() => {})
      .finally(() => {
        calendarBusy = false;
        if (token === renderToken) renderCalendar(ctx);
      });
  }

  const rows = payload?.rows || [];
  const scoped = ctx.scope === 'portfolio' ? rows.filter((r) => holdings(ctx).has(String(r.ticker || '').toUpperCase())) : rows;
  const err = calendar.errorFor(wanted);

  const table = scoped.length
    ? scoreTable({
        rows: scoped,
        key: (r) => r.scId,
        name: (r) => r.name,
        nameLabel: 'Company',
        sub: (r) => `${r.ticker || 'no ticker'} · ${r.industry || '—'}`,
        showRank: false,
        nameAfter: 1,
        dense: true,
        nameMaxPx: 300,
        stickyHead: 'max(280px, calc(100vh - 420px))',
        columns: [
          { label: 'Date', get: (r) => shortDate(r.resultDate), align: 'left', sortValue: (r) => r.resultDate || '' },
          { label: 'Quarter', get: (r) => escapeHtml(r.quarter || '—'), html: true, sortValue: (r) => r.quarter || '' },
          // Moneycontrol says "Time Not Available" for almost every row; the normaliser turns that
          // into null so this reads as a dash rather than a sentence where a clock belongs.
          { label: 'Time', get: (r) => (r.time ? escapeHtml(r.time) : '<span class="text-slate-300">—</span>'), html: true, sortValue: (r) => r.time || 'zzz' },
          { label: 'Price', get: (r) => (r.ltp == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatRupee(r.ltp))), html: true, align: 'right', sortValue: (r) => r.ltp ?? -Infinity },
          {
            label: 'Change',
            get: (r) => {
              if (r.changePct == null) return '<span class="text-slate-300">—</span>';
              const cls = r.changePct > 0 ? 'text-emerald-600' : r.changePct < 0 ? 'text-rose-600' : 'text-slate-500';
              return `<span class="font-semibold ${cls}">${escapeHtml(pctText(r.changePct))}</span>`;
            },
            html: true,
            align: 'right',
            sortValue: (r) => r.changePct ?? -Infinity,
          },
          { label: 'Market Cap', get: (r) => (r.marketCap == null ? '<span class="text-slate-300">—</span>' : escapeHtml(formatCroreCompact(r.marketCap))), html: true, align: 'right', sortValue: (r) => r.marketCap ?? -1 },
        ],
        searchable: (r) => `${r.name} ${r.ticker || ''} ${r.industry || ''}`,
        initialSort: { key: 'Market Cap', dir: 'desc' },
        exportName: 'sattva-earnings-calendar',
        onExport: (visible) => exportCalendar(visible, payload),
        emptyMessage: 'No companies match your filters.',
      })
    : null;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Earnings Calendar',
      description: 'Companies scheduled to report, by date. Pick a date from the strip.',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${viewToggle('calendar')}${calendarPill(payload, err)}${scopeSummary({ scope: ctx.scope, count: scoped.length, noun: 'listed' })}</div>`,
    })}
    ${dateStrip(wanted, today)}
    ${
      err
        ? `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
             <div class="text-3xl">📅</div>
             <div class="mt-2 text-sm font-semibold text-slate-700">The results calendar could not be loaded</div>
             <div class="mt-1 text-xs text-slate-500">${escapeHtml(err)}</div>
             <div class="mx-auto mt-3 max-w-lg text-xs text-slate-400">This view needs the live route. There is no committed calendar file on purpose — a schedule is a claim about the future, and a stale one looks exactly like a fresh one.</div>
           </div>`
        : !payload
          ? '<div class="skeleton-shimmer h-80 rounded-2xl bg-slate-100"></div>'
          : payload.degraded
            ? `<div class="rounded-2xl bg-amber-50 p-5 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
                 <strong>Counts only for this date.</strong> ${escapeHtml(payload.degraded)}
               </div>`
            : table
              ? `${table.html}${calendarNote(payload, scoped.length, ctx)}`
              : `<div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
                   <div class="text-3xl">🗓️</div>
                   <div class="mt-2 text-sm font-semibold text-slate-700">${ctx.scope === 'portfolio' ? 'None of your holdings is scheduled on this date' : 'Nothing scheduled on this date'}</div>
                   <div class="mt-1 text-xs text-slate-500">${escapeHtml(stripLabel(wanted))}${payload.scheduledCount ? ` · ${formatNumber(payload.scheduledCount)} companies report, none in this scope` : ''}</div>
                 </div>`
    }
  `;
  wireViewToggle(ctx.root, ctx);
  wireCalendarPill(ctx.root, payload, wanted);
  for (const btn of ctx.root.querySelectorAll('[data-date]')) {
    btn.addEventListener('click', () => {
      calendarDate = btn.dataset.date;
      ctx.setParamsQuiet({ ...ctx.params, view: 'calendar', date: calendarDate });
      renderCalendar(ctx);
    });
  }
  if (table) disposers.push(table.wire(ctx.root));
}

const holdings = (ctx) => new Set((ctx.data?.portfolio?.holdings || []).map((h) => String(h.ticker).toUpperCase()));

function calendarPill(payload, err) {
  const bad = !!err || !!payload?.degraded;
  const cls = bad ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100' : 'bg-emerald-50 text-emerald-800 ring-emerald-300 hover:bg-emerald-100';
  const dot = bad
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';
  const count = payload?.scheduledCount;
  return `
    <button type="button" data-cal-info title="Where this calendar comes from, and what it does not show"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}">
      ${dot}<span>${bad ? 'Partial' : 'Live'}</span>
      <span class="font-normal opacity-70">${count != null ? `${escapeHtml(formatNumber(count))} scheduled` : 'schedule'}</span>
    </button>`;
}

// The one sentence that keeps this table honest: how many report, versus how many are named.
function calendarNote(payload, shown, ctx) {
  const total = payload?.scheduledCount;
  const partial = total != null && payload.capped && shown < total;
  return `
    <p class="mb-6 text-[11px] leading-relaxed ${partial ? 'text-amber-700' : 'text-slate-500'}">
      ${total != null ? `<strong>${formatNumber(total)}</strong> companies report on this date.` : ''}
      ${
        partial
          ? `Moneycontrol's calendar publishes the <strong>${formatNumber(payload.listCap)} largest by market cap</strong> per date and cannot be paged past, so ${formatNumber(shown)} are named here${ctx.scope === 'portfolio' ? ' before your scope filter' : ''}. The count above is the complete one.`
          : `All ${formatNumber(shown)} are listed.`
      }
      Prices are live; a dash means not known, never zero.
    </p>`;
}

function wireCalendarPill(root, payload, date) {
  const btn = root.querySelector('[data-cal-info]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    openModal(
      `<div class="px-7 py-6">
        <div class="mb-3 flex items-start justify-between gap-4">
          <h2 class="font-display text-xl font-bold text-slate-900">Results calendar</h2>
          <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
        </div>
        <div class="text-sm leading-relaxed text-slate-600">
          <p><strong>Real, live, from Moneycontrol</strong> — the same source as the reported results, asked the other
             way round: who is <em>due</em> to report rather than who has.</p>
          <p class="mt-2">Showing <strong>${escapeHtml(stripLabel(date))}</strong>${payload?.asOnDate ? ` · Moneycontrol's schedule as on ${escapeHtml(payload.asOnDate)}` : ''}.</p>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Two numbers, two sources</h3>
          <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
            <li><strong>The count on each date</strong> — from Moneycontrol's calendar API. Complete, unpaginated.</li>
            <li><strong>The company list</strong> — from the calendar page itself, which publishes the
                <strong>${escapeHtml(formatNumber(payload?.listCap ?? 20))} largest by market cap</strong> for a date and
                offers no way to page past that. So on a busy day this table names a fraction of the count beside it,
                and says so under the table rather than letting twenty rows imply twenty companies.</li>
            <li><strong>Ticker and industry</strong> — resolved from Moneycontrol's company code, live, because a
                company that has not reported yet is not in a map built from companies that have.</li>
          </ul>

          <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why there is no offline copy</h3>
          <p class="mt-1 text-xs">A schedule is a claim about the future. A committed file would go on saying a company
             reports next Thursday long after that Thursday, and nothing on screen could tell you it was stale. If the
             live route is unreachable this view says so instead of showing you a plausible old calendar.</p>
          <p class="mt-4 text-xs text-slate-500">A dash in any column means <em>not known</em> — never zero.</p>
        </div>
      </div>`,
      { size: 'default' }
    );
  });
}

async function exportCalendar(rows, payload) {
  const banner = {
    __banner:
      `REAL DATA. Results calendar via Moneycontrol — companies scheduled to report on ${payload?.date || ''}` +
      `${payload?.asOnDate ? ` (schedule as on ${payload.asOnDate})` : ''}, captured ${new Date().toISOString()}. ` +
      `${payload?.scheduledCount != null ? `${payload.scheduledCount} companies report on this date; ` : ''}` +
      `Moneycontrol publishes only the ${payload?.listCap ?? 20} largest by market cap per date, so THIS SHEET IS NOT THE FULL LIST. ` +
      `Market cap in Rs. crore. Blank cells mean not known, not zero.`,
  };
  await exportRows({
    filename: 'sattva-earnings-calendar',
    sheetName: 'Results Calendar',
    columns: [
      { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 36, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: 'Quarter', key: 'q', width: 14, get: (r) => (r.__banner ? '' : r.quarter || '') },
      { header: 'Time', key: 'tm', width: 14, get: (r) => (r.__banner ? '' : r.time || '') },
      { header: 'Price', key: 'p', width: 14, get: (r) => (r.__banner ? '' : (r.ltp ?? '')) },
      { header: 'Change %', key: 'ch', width: 12, get: (r) => (r.__banner ? '' : (r.changePct ?? '')) },
      { header: 'MCap (Cr)', key: 'm', width: 16, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
    ],
    rows: [banner, ...rows],
  });
}

async function exportResults(rows, m) {
  const banner = {
    __banner:
      `REAL DATA. Quarterly results as published, via Moneycontrol Rapid Results — ${m?.quarter || ''}, ` +
      `${(m?.subType || 'yoy').toUpperCase()}: ${m?.currentPeriod || ''} vs ${m?.priorPeriod || ''}, ` +
      `captured ${new Date().toISOString()}. Figures in Rs. crore. Where the sign flips between periods the "growth" column reads ` +
      `"To profit" / "To loss" / "Loss narrowed" instead of a percentage, because a percentage change across zero is not a growth rate. ` +
      `Return since result = live price vs the close on the result date. Blank cells mean not joined, not zero.`,
  };
  const pct = (mm) => (mm?.kind === 'normal' ? mm.pct : mm?.kind === 'turnaround' ? 'To profit' : mm?.kind === 'slipped-to-loss' ? 'To loss' : mm?.kind === 'loss-narrowed' ? `Loss narrowed ${mm.pct}%` : mm?.kind === 'loss-widened' ? `Loss widened ${mm.pct}%` : '');
  // The sheet carries the same three metrics × two periods the table does. Ticker and industry
  // stay as columns here even though they are no longer columns on screen: a spreadsheet has no
  // second line under the company name, and a workbook you cannot filter by ticker is less useful.
  const cur = m?.currentPeriod || 'Current';
  const pri = m?.priorPeriod || 'Prior';
  const val = (mm, field) => (mm?.[field] ?? '');
  await exportRows({
    filename: 'sattva-earnings',
    sheetName: 'Latest Results',
    columns: [
      { header: 'Result Date', key: 'd', width: 14, get: (r) => (r.__banner ? r.__banner : r.resultDate) },
      { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.company) },
      { header: 'Industry', key: 'i', width: 26, get: (r) => (r.__banner ? '' : r.industry || '') },
      { header: `Revenue ${cur} (Cr)`, key: 'rv', width: 18, get: (r) => (r.__banner ? '' : val(r.revenue, 'current')) },
      { header: `Revenue ${pri} (Cr)`, key: 'rvp', width: 18, get: (r) => (r.__banner ? '' : val(r.revenue, 'prior')) },
      { header: 'Revenue Change', key: 'rg', width: 18, get: (r) => (r.__banner ? '' : pct(r.revenue)) },
      { header: `Gross Profit ${cur} (Cr)`, key: 'gp', width: 20, get: (r) => (r.__banner ? '' : val(r.grossProfit, 'current')) },
      { header: `Gross Profit ${pri} (Cr)`, key: 'gpp', width: 20, get: (r) => (r.__banner ? '' : val(r.grossProfit, 'prior')) },
      { header: 'Gross Profit Change', key: 'gg', width: 20, get: (r) => (r.__banner ? '' : pct(r.grossProfit)) },
      { header: `Net Profit ${cur} (Cr)`, key: 'np', width: 18, get: (r) => (r.__banner ? '' : val(r.netProfit, 'current')) },
      { header: `Net Profit ${pri} (Cr)`, key: 'npp', width: 18, get: (r) => (r.__banner ? '' : val(r.netProfit, 'prior')) },
      { header: 'Net Profit Change', key: 'pg', width: 18, get: (r) => (r.__banner ? '' : pct(r.netProfit)) },
      { header: 'MCap (Cr)', key: 'm', width: 14, get: (r) => (r.__banner ? '' : (r.marketCap ?? '')) },
      { header: 'Return Since Result %', key: 'rs', width: 20, get: (r) => (r.__banner ? '' : (r.returnSinceResult ?? '')) },
      { header: 'Basis', key: 'b', width: 14, get: (r) => (r.__banner ? '' : r.basis) },
    ],
    rows: [banner, ...rows],
  });
}


