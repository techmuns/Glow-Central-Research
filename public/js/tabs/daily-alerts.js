// tabs/daily-alerts.js — THE FIRST TAB, AND THE ONLY ONE THAT ASKS ABOUT A DAY RATHER THAN A FEED.
//
// Every other tab here is organised by SOURCE: this is what the results feed holds, this is what
// BSE filed, this is what the technicals scrape measured. That is the right shape for research and
// the wrong shape for the first thirty seconds of a morning, when the question is not "what does
// Moneycontrol have" but "what happened, and does any of it need me". So this tab is organised by
// DAY: one stream, every feed, today only.
//
// It introduces no data source of its own — see js/data/daily-alerts.js, which is where the
// readings are taken and where the rule for each one is written down.
//
// ---------------------------------------------------------------------------------------
// THE TWO COLOURS
//
//   RED   an alert: a direct negative reading, named in the row that carries it.
//   ORANGE an update: something arrived today.
//
// The colours are the semantic tokens, used semantically — `--negative` and `--caution` — never the
// brand ramp, which would make "an event happened" look like a verdict. And a red row always shows
// the reading that made it red, because a colour whose cause is not on screen beside it is this
// dashboard making a judgement, which it does not do.
//
// ---------------------------------------------------------------------------------------
// THE COVERAGE PANEL IS NOT DECORATION — IT IS THE HALF THAT MAKES AN EMPTY DAY READABLE
//
// Most of these feeds are committed captures on a best-effort schedule. So a bucket with nothing in
// it has two completely different meanings — nobody filed, or nothing has looked at today yet — and
// a consolidated page that showed only the events would present the second as the first on every
// weekend, every holiday and every morning before the scrapes run. `Feeds read for this day` states,
// per feed, when it last looked and whether that reaches today. It is the same rule as the filings
// tabs' "63 companies have not been checked since": never claim nothing is new.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary, pill } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as refresh from '../core/refresh.js';
import * as alerts from '../data/daily-alerts.js';
import * as coverage from '../data/coverage.js';
import { scopeLabel } from '../data/scope.js';

export const meta = {
  id: 'daily-alerts',
  title: 'Daily Alerts',
  subtitle: 'Everything that happened today, consolidated from every feed on this dashboard.',
  // No rail. This is one stream and splitting it by feed would rebuild the tabs it exists to
  // collapse — the feed filter in the toolbar does that job without costing a navigation.
  subviews: [],
};

const REFRESH_ID = 'daily-alerts';

// ---------------------------------------------------------------------------------------
// Module state
//
// `ctxRef` IS THE LIFECYCLE GUARD, and it is the thing the shell actually owns: `render()` runs
// again on every scope change, so a subscription guarded by a token captured inside one render is
// alive until the reader touches the scope toggle and dead afterwards (CLAUDE.md, the module
// interface contract). Every handler below re-reads `ctxRef` instead of closing over a ctx.
// ---------------------------------------------------------------------------------------
let ctxRef = null;
let report = null; // the last collected report
let loadToken = 0;
let unsubs = [];
let tableView = null; // the reader's search / filters / sort, carried across repaints

export function render(ctx) {
  ctxRef = ctx;

  if (!unsubs.length) {
    // NOTHING SUBSCRIBED, BECAUSE NOTHING THIS PAGE READS POLLS. All four tabs behind it are
    // scheduled captures, not live routes — so the page is built on mount and rebuilt when the
    // reader presses Refresh, and it must not be dressed up as a feed that arrives on its own.
    // (It used to watch the results and con-call pollers; both of those tabs are out of scope now.)
    unsubs.push(
      refresh.register(REFRESH_ID, {
        label: 'Daily Alerts',
        // A REFRESH HERE COSTS NOTHING PER COMPANY. It re-reads the same committed files and cached
        // routes the mount did — one conditional GET each, a bodyless 304 where nothing moved. It
        // does NOT call any feed's `refresh()`, which is the per-company walk.
        refresh: async () => {
          const before = new Set((report?.events || []).map((e) => e.id));
          await recollect(ctxRef);
          const now = report?.events || [];
          // IDENTITIES, NEVER SIZES. A count cannot answer "did anything change" for a collection
          // that can gain and lose rows in the same read — the day rolls over, a capture lands, a
          // story drops off the end. Same rule, and same failure, as the news Fetch button.
          const added = now.filter((e) => !before.has(e.id)).length;
          return { added, checked: (report?.feeds || []).filter((f) => f.status === 'ok').length };
        },
      })
    );
  }

  // A REPORT FOR ANOTHER SCOPE IS NOT A HEAD START, IT IS THE WRONG ANSWER. `render()` runs again
  // on every scope change and the module keeps its last report so a return visit paints instantly
  // — but that report was collected FOR a scope, and painting Universe's rows under a Portfolio
  // pill for the second before the new collect lands is the page stating something untrue.
  if (report && report.scope !== ctx.scope) report = null;

  // Paint immediately with whatever is already collected, then collect. A tab that renders nothing
  // until every feed has answered is a blank screen on the landing page.
  paint(ctx);
  recollect(ctx);
}

export function destroy() {
  ctxRef = null;
  cancelThrottledPaint();
  for (const off of unsubs) {
    try {
      off && off();
    } catch (err) {
      console.error('[daily-alerts] cleanup failed', err);
    }
  }
  unsubs = [];
}

/**
 * Re-read every feed and repaint.
 *
 * `loadToken` closes the obvious race: a scope change while a collect is in flight would otherwise
 * paint the previous scope's rows over the new one. The token is compared against the module's
 * counter, not against a captured ctx, for the same reason the subscriptions are.
 */
async function recollect(ctx) {
  // NO "already collecting" EARLY RETURN. `render()` runs again on every scope change, so bailing
  // out because a collect was in flight would leave the new scope showing the old scope's rows for
  // ever — the guard has to be about which result is allowed to PAINT, not about which reads are
  // allowed to start. Every read below is a conditional GET against a file or a cached route, so
  // an overlapping one costs a revalidation, not a download.
  const token = ++loadToken;
  try {
    const next = await alerts.collect({
      scope: ctx.scope,
      holdings: coverage.holdings(),
      // Feeds land one at a time and the page follows them. Coalesced, because eight arrivals is
      // eight full rebuilds of a table the reader may be typing into — a TRAILING THROTTLE rather
      // than a debounce, since a debounce would keep deferring while feeds kept landing and the
      // page would sit still until the slowest of them finished, which is the thing this exists to
      // stop. The final report below paints immediately, so the settled state never waits on a timer.
      onPartial: (partial) => {
        if (token !== loadToken || !ctxRef) return;
        report = partial;
        throttledPaint();
      },
    });
    if (token !== loadToken || !ctxRef) return;
    cancelThrottledPaint();
    report = next;
    paint(ctxRef);
  } catch (err) {
    console.error('[daily-alerts] collect failed', err);
  }
}

// ---- the trailing throttle ------------------------------------------------------------
const PAINT_COALESCE_MS = 250;
let paintTimer = null;
let paintedAt = 0;

function throttledPaint() {
  const wait = Math.max(0, PAINT_COALESCE_MS - (Date.now() - paintedAt));
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    paintedAt = Date.now();
    if (ctxRef) paint(ctxRef);
  }, wait);
}

function cancelThrottledPaint() {
  if (paintTimer) clearTimeout(paintTimer);
  paintTimer = null;
  paintedAt = Date.now();
}


// ---------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------

function paint(ctx) {
  const day = report?.day || alerts.today();
  const events = report?.events || [];
  const feeds = report?.feeds || [];
  const m = report?.meta || {};

  const focus = captureFocus(ctx.root);
  const table = eventsTable(ctx, events, day);
  tableView = table.view;

  // NO DESCRIPTION, NO STAT STRIP, AND THE TWO CHIPS ARE ONE PILL. What they said is all still
  // said — behind the pill, which is the resolution this codebase reaches every time a caveat
  // starts competing with the content it qualifies. The four cards were the loudest version of
  // the problem: three of them counted rows the table beneath them already lists, and the fourth
  // printed a date the pill now carries. What may NOT go is the provenance, so the pill is the
  // control that keeps it one click away — see the stat-strip opt-out rule in CLAUDE.md.
  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Daily Alerts',
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(report, day)}${pendingPill(report)}${scopeSummary({
        scope: ctx.scope,
        count: m.companies || 0,
        noun: 'companies with events',
        book: coverage.meta(),
      })}</div>`,
    })}
    ${coveragePanel(feeds, day, ctx.scope)}
    ${table.html}
    ${legend()}`;

  table.wire(ctx.root);
  wireProvenance(ctx.root, feeds, day, ctx.scope);
  restoreFocus(ctx.root, focus);
}

/**
 * KEEP THE READER'S CARET WHERE THEY LEFT IT.
 *
 * This panel repaints as each feed lands — eight times on a cold visit, over about three seconds —
 * and a repaint replaces `ctx.root.innerHTML`, which takes the focus and the caret out of the
 * search box somebody may be typing into. `initialView` already carries the TEXT across; this
 * carries the cursor. Same class of thing the News tab handles by rebuilding only its list.
 *
 * Only the search input, and only while it is genuinely focused inside this panel: restoring focus
 * to a control the reader was not using would be its own kind of rude.
 */
function captureFocus(root) {
  const el = document.activeElement;
  // Matched on the kit's own hook rather than on `type`, which is `text` — the screener's search
  // box is not an `<input type="search">`, and testing for one would silently never fire.
  if (!el || !root.contains(el) || !el.matches?.('[data-table-search]')) return null;
  return { start: el.selectionStart, end: el.selectionEnd };
}

function restoreFocus(root, focus) {
  if (!focus) return;
  const el = root.querySelector('[data-table-search]');
  if (!el) return;
  el.focus();
  try {
    el.setSelectionRange(focus.start, focus.end);
  } catch {
    // Some browsers refuse setSelectionRange on certain input types — the focus is the useful half.
  }
}

/**
 * The one always-visible statement of what this page is and where it came from.
 *
 * IT CARRIES THE DATE ON ITS FACE, and that is not decoration: this is the one tab defined by a
 * DAY, the date is in IST rather than UTC (a UTC date names yesterday for five and a half hours
 * every evening), and a screenshot travels without the modal. Everything else the two chips and
 * the four cards used to say is behind it.
 *
 * IT IS GREEN ONLY WHEN THE DATA EARNS IT. Every feed reaching today is the claim; one behind is
 * amber and says so, because a chip that reads Live over a feed that has not looked at today is
 * the same false freshness claim as the header chip that tracked a heartbeat and asked no server
 * anything.
 */
function livePill(rep, day) {
  const feeds = rep?.feeds || [];
  const behind = feeds.filter((f) => f.reachesToday === false).length;
  const reading = rep?.pending ?? 0;
  const label = `${fmtDay(day)}`;
  if (behind || reading) {
    return `<button type="button" data-alerts-info
       class="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 ring-1 ring-amber-300 transition-colors hover:bg-amber-100"
       title="${escapeHtml(behind ? `${behind} feed${behind === 1 ? ' has' : 's have'} not looked at today yet.` : 'Still reading.')}">
       <span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span> ${escapeHtml(label)}
     </button>`;
  }
  return `<button type="button" data-alerts-info
     class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 transition-colors hover:bg-emerald-100"
     title="Every feed on this page has looked at today. Indian trading date, not UTC.">
     <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Live · ${escapeHtml(label)}
   </button>`;
}

/** `2026-09-01` -> `01 Sept 2026`, so the chip reads as a date rather than as an id. */
function fmtDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/**
 * How many feeds have not answered yet — a statement about US, not about the day.
 *
 * It names the count rather than saying "loading", because a partial page that looks finished is
 * the failure this whole tab is built to avoid: a reader who sees four rows and no pill has no way
 * to know that four more feeds are still being read.
 */
function pendingPill(rep) {
  const n = rep?.pending ?? 0;
  if (!n) return '';
  return pill({ label: `Reading ${n} more ${n === 1 ? 'feed' : 'feeds'}…`, tone: 'neutral' });
}

// ---------------------------------------------------------------------------------------
// The coverage panel — one row per feed
// ---------------------------------------------------------------------------------------

function coveragePanel(feeds, day, scope) {
  if (!feeds.length) {
    return `<div class="mb-6 rounded-2xl bg-white p-5 text-sm text-slate-400 shadow-sm ring-1 ring-slate-100">Reading the feeds…</div>`;
  }
  const row = (f) => {
    const state = feedState(f);
    return `
      <div class="flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1 ${state.ring} ${state.bg}">
        <span class="mt-1 h-2 w-2 flex-shrink-0 rounded-full ${state.dot}"></span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-sm font-semibold text-slate-800">${escapeHtml(f.label)}</span>
            <span class="text-xs font-semibold ${state.text}">${escapeHtml(state.label)}</span>
            ${f.count ? `<span class="text-xs text-slate-500">· ${formatNumber(f.count)} today</span>` : ''}
          </div>
          <div class="mt-0.5 text-xs leading-relaxed text-slate-500">
            ${escapeHtml(f.note || f.what)}
            ${f.asOf ? ` <span class="text-slate-400">Last read ${escapeHtml(formatRelativeTime(f.asOf))}.</span>` : ''}
          </div>
        </div>
      </div>`;
  };

  return `
    <section class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100" data-alerts-coverage>
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="text-xs font-bold uppercase tracking-wider text-slate-400">Feeds read for ${escapeHtml(day)}</h3>
        <p class="text-xs text-slate-400">A feed that has not looked at today cannot say nothing happened — so it says when it last looked instead.</p>
      </div>
      <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-3">${feeds.map(row).join('')}</div>
      ${scope !== 'universe' ? `<p class="mt-3 text-xs text-slate-400">Narrowed to ${escapeHtml(scopeLabel(scope))}. Market-wide news carries no company, so it is excluded here rather than filtered to nothing — see its row above.</p>` : ''}
    </section>`;
}

/**
 * The four states a feed can be in, kept apart deliberately.
 *
 * "Behind" and "failed" are different things an operator does different things about, and neither
 * is "no events" — collapsing any two of them would throw away the only information that makes the
 * panel worth having.
 */
function feedState(f) {
  // PENDING IS ITS OWN STATE. A feed nobody has heard from yet must never be drawn as "nothing
  // today" — that is a finished answer, and this is the absence of one.
  if (f.status === 'pending') return { label: 'reading…', dot: 'bg-slate-300 animate-pulse', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-slate-400' };
  if (f.status === 'failed') return { label: 'could not be read', dot: 'bg-rose-500', ring: 'ring-rose-100', bg: 'bg-rose-50/40', text: 'text-rose-700' };
  if (f.scopable === false) return { label: 'not in this scope', dot: 'bg-slate-300', ring: 'ring-slate-100', bg: 'bg-slate-50/50', text: 'text-slate-500' };
  if (f.reachesToday === false) return { label: 'has not looked at today', dot: 'bg-amber-500', ring: 'ring-amber-100', bg: 'bg-amber-50/40', text: 'text-amber-700' };
  if (f.count) return { label: 'current', dot: 'bg-emerald-500', ring: 'ring-emerald-100', bg: 'bg-emerald-50/40', text: 'text-emerald-700' };
  return { label: 'current · nothing today', dot: 'bg-emerald-500', ring: 'ring-slate-100', bg: 'bg-white', text: 'text-emerald-700' };
}

// ---------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------

// The row tint plus a 3px left edge in the semantic token's own colour: `--negative` for an alert,
// `--caution` for an update. NO `hover:` class here — `scoreTable` appends its own `hover:bg-slate-50`
// after whatever `rowClass` returns, and two hover rules on one element are decided by stylesheet
// order rather than by class order, which is a coin toss dressed up as a decision.
const SEV = {
  alert: { label: 'Alert', chip: 'bg-rose-50 text-rose-700 ring-rose-200', row: 'bg-rose-50/40 shadow-[inset_3px_0_0_#e11d48]' },
  update: { label: 'Update', chip: 'bg-amber-50 text-amber-700 ring-amber-200', row: 'bg-amber-50/20 shadow-[inset_3px_0_0_#d97706]' },
};

function eventsTable(ctx, events, day) {
  return scoreTable({
    rows: events,
    // Content-derived and unique per event — never a position. The stream grows while feeds land,
    // so an index in the key would make one key mean a different row on every arrival, which is
    // exactly what made the News table look as though it were duplicating rows.
    key: (e) => e.id,
    // THE STAR MARKS THE COMPANY, NOT THE EVENT. Three announcements from one filer are three rows
    // and one watched company; a market-wide story has no company and gets no star at all.
    watchKey: (e) => e.ticker || null,
    watchName: (e) => e.company,
    name: (e) => e.company,
    nameLabel: 'Company',
    nameMaxPx: 220,
    sub: (e) => [e.ticker, e.section, e.feedLabel].filter(Boolean).join(' · '),
    showRank: false,
    // Time leads: this is a stream, and the first thing a reader wants from a stream is when.
    nameAfter: 1,
    dense: true,
    wrapHeads: true,
    stickyHead: 'max(320px, calc(100vh - 420px))',
    rowClass: (e) => SEV[e.severity]?.row || '',
    columns: [
      {
        label: 'Time',
        align: 'left',
        get: (e) => (e.time ? `<span class="tabular-nums text-slate-600">${escapeHtml(e.time)}</span>` : `<span class="text-slate-300" title="This feed dates the event to the day, not to the minute.">—</span>`),
        html: true,
        sortValue: (e) => e.time || '',
      },
      {
        label: 'Signal',
        get: (e) => {
          const s = SEV[e.severity] || SEV.update;
          return `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${s.chip}">${s.label}</span>`;
        },
        html: true,
        sortValue: (e) => (e.severity === 'alert' ? 1 : 0),
      },
      {
        label: 'What happened',
        get: (e) => `
          <div class="max-w-[560px]">
            <div class="truncate font-medium text-slate-800" title="${escapeHtml(e.headline)}">${escapeHtml(e.headline)}</div>
            <div class="truncate text-xs text-slate-500" title="${escapeHtml(e.detail || '')}">${escapeHtml(e.detail || '')}</div>
            ${e.reason ? `<div class="mt-0.5 truncate text-xs font-semibold text-rose-700" title="${escapeHtml(e.reason)}">▲ ${escapeHtml(e.reason)}</div>` : ''}
          </div>`,
        html: true,
        sortValue: (e) => String(e.headline || '').toLowerCase(),
      },
      { label: 'Feed', get: (e) => e.feedLabel },
    ],
    link: (e) => e.url || null,
    // The row takes you to the tab that owns the feed. That is the whole promise of a consolidated
    // page — see one line here, go and read it properly there — and it is not a drill panel
    // restating somebody else's analysis under our chrome, which is the thing this codebase does
    // not do (see the con-call rule in CLAUDE.md).
    onRowClick: (e) => {
      if (!e.tab) return;
      location.hash = `#/research/${e.tab}?scope=${ctx.scope}`;
    },
    searchable: (e) => `${e.company} ${e.ticker || ''} ${e.headline} ${e.detail || ''} ${e.feedLabel}`,
    filters: [
      {
        label: 'Signal',
        options: [
          { value: 'all', label: 'Alerts and updates' },
          { value: 'alert', label: 'Alerts only' },
          { value: 'update', label: 'Updates only' },
        ],
        match: (e, v) => e.severity === v,
      },
      {
        label: 'Feed',
        options: [{ value: 'all', label: 'Every feed' }, ...feedOptions(events)],
        match: (e, v) => e.feed === v,
      },
    ],
    initialView: tableView,
    emptyMessage: emptyMessageFor(ctx.scope, day),
    exportName: `sattva-daily-alerts-${day}`,
    onExport: (visible) => exportStream(visible, day, ctx.scope),
  });
}

const feedOptions = (events) => {
  const seen = new Map();
  for (const e of events) if (!seen.has(e.feed)) seen.set(e.feed, e.feedLabel);
  return [...seen].map(([value, label]) => ({ value, label }));
};

/**
 * The empty table's message, which must not overstate what an empty table means.
 *
 * "Nothing happened today" is a claim nobody measured — the coverage panel above says which feeds
 * have actually looked. So this says what IS true: nothing reached this page, and points at the
 * panel that explains why.
 */
function emptyMessageFor(scope, day) {
  const where = scope === 'universe' ? 'across the market' : `for your ${scopeLabel(scope).toLowerCase()}`;
  return `Nothing has reached this page ${where} on ${day}. The feed panel above says which feeds have actually looked at today — an empty stream is not the same as a quiet day.`;
}

function legend() {
  const swatch = (cls, label, body) => `
    <div class="flex items-start gap-2">
      <span class="mt-1 h-3 w-3 flex-shrink-0 rounded ${cls}"></span>
      <div><span class="text-xs font-bold text-slate-700">${escapeHtml(label)}</span><p class="text-xs leading-relaxed text-slate-500">${escapeHtml(body)}</p></div>
    </div>`;
  return `
    <div class="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="grid gap-3 sm:grid-cols-2">
        ${swatch('bg-rose-500', 'Red — alert', `A direct negative reading on the row, printed in the row. Across these four tabs there is one: the price fell more than ${alerts.MOVE_PCT}% at today’s close.`)}
        ${swatch('bg-amber-500', 'Orange — update', 'Everything else that arrived. Announcements, insider disclosures and news are always this colour: their columns and headlines are the upstream’s own, and nothing here reads them as good or bad.')}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------

function wireProvenance(root, feeds, day, scope) {
  const btn = root.querySelector('[data-alerts-info]');
  if (!btn) return;
  btn.addEventListener('click', () => openModal(provenanceHtml(feeds, day, scope), { size: 'wide' }));
}

function provenanceHtml(feeds, day, scope) {
  const rows = feeds
    .map(
      (f) => `
      <tr class="border-b border-slate-100">
        <td class="py-2 pr-4 align-top text-sm font-semibold text-slate-800">${escapeHtml(f.label)}</td>
        <td class="py-2 pr-4 align-top text-sm text-slate-600">${escapeHtml(f.what)}</td>
        <td class="py-2 align-top text-sm ${f.status === 'failed' ? 'text-rose-700' : f.reachesToday === false ? 'text-amber-700' : 'text-slate-600'}">
          ${escapeHtml(feedState(f).label)}${f.asOf ? ` · last read ${escapeHtml(formatRelativeTime(f.asOf))}` : ''}
        </td>
      </tr>`
    )
    .join('');

  return `
    <div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-xl font-bold text-slate-900">Daily Alerts — where every row comes from</h2>
          <p class="mt-1 text-sm text-slate-500">${escapeHtml(day)} · ${escapeHtml(scopeLabel(scope))} scope</p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
      </div>

      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong class="text-slate-800">This tab has no data source of its own.</strong> Every row is a reading taken from a feed that already has its own tab, filtered to today's Indian trading date. Nothing here is scored, ranked, summarised or re-banded.</p>

        <h3 class="mt-4 font-bold text-slate-800">Which tabs it reads</h3>
        <p>Four: <strong class="text-slate-800">Breakouts / Technical, News, Corp Announcements and Insider Trades.</strong> News appears twice below because that tab is two feeds behind one name — the per-company search and the market-wide capture.</p>
        <p class="mt-2">The <strong>Earnings Hub</strong>, <strong>Con-call</strong>, <strong>Public Chatter</strong> and <strong>Super Investors</strong> are not consolidated here. That is a chosen scope rather than a gap, and it is stated so that an absent earnings row reads as a decision rather than a fault.</p>

        <h3 class="mt-4 font-bold text-slate-800">What the colours mean</h3>
        <p><span class="font-semibold text-rose-700">Red</span> is a direct negative reading, and the reading is printed in the row that carries it. On these four tabs there is exactly one such reading: a price fall of more than ${alerts.MOVE_PCT}% at today's close, from the end-of-day scrape behind Breakouts / Technical.</p>
        <p class="mt-2"><span class="font-semibold text-amber-700">Orange</span> is everything else that arrived today. <strong class="text-slate-800">Three of the four tabs are never red.</strong> Insider trades and corporate announcements carry the upstream's own columns and categories, so grading one would be a materiality flag we invented; a news headline is editorial, and reading a sentiment off it would put a model we do not have over somebody else's words. A day with no big faller is therefore a page of orange, which is the honest rendering rather than a page with something missing.</p>

        <h3 class="mt-4 font-bold text-slate-800">Thresholds, stated</h3>
        <p>A price move reaches this page at <strong>±${alerts.MOVE_PCT}%</strong> on the day. It is a filter applied on your behalf, so it is printed rather than left implicit — here, in the row, in the alert card's explainer, and in row 1 of any exported sheet, all four reading one constant.</p>

        <h3 class="mt-4 font-bold text-slate-800">Whose judgement is on screen</h3>
        <p>Announcement categories are BSE's own filing taxonomy. Insider-trade columns are the upstream's, under its own headings. Headlines and standfirsts belong to their publishers, and the article stays where it was published. This dashboard adds no judgement to any of them.</p>

        <h3 class="mt-4 font-bold text-slate-800">What was read for this day</h3>
        <table class="mt-2 w-full text-left">
          <thead><tr class="border-b border-slate-200">
            <th scope="col" class="py-2 pr-4 text-xs font-bold uppercase tracking-wider text-slate-500">Feed</th>
            <th scope="col" class="py-2 pr-4 text-xs font-bold uppercase tracking-wider text-slate-500">Contributes</th>
            <th scope="col" class="py-2 text-xs font-bold uppercase tracking-wider text-slate-500">State</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <p class="mt-4 text-xs text-slate-400">A feed that has not looked at today is not broken and its rows are not wrong — they are about an earlier day, so they are not on this page. Nothing on this tab sends a request per company; it re-reads committed captures and cached routes, and an unchanged one answers with no body at all.</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Export
//
// ROW 1 IS THE BANNER. A workbook leaves the page without any of the chrome above it — no legend,
// no coverage panel, no provenance modal — so everything a reader needs in order not to misread the
// colours has to travel inside the file.
// ---------------------------------------------------------------------------------------

function exportStream(visible, day, scope) {
  const feeds = report?.feeds || [];
  const behind = feeds.filter((f) => f.reachesToday === false).map((f) => f.label);
  const banner = {
    __banner: true,
    line:
      `SATTVA CENTRAL RESEARCH — DAILY ALERTS for ${day} (Indian trading date), ${scopeLabel(scope)} scope. ` +
      `"Alert" is a direct negative reading printed in the Reading column, never a judgement about the company; "Update" is everything else that arrived. ` +
      `Rows come from four tabs only: Breakouts / Technical, News, Corp Announcements and Insider Trades. ` +
      `Announcements, insider disclosures and news are NEVER graded here — their columns, categories and headlines are the upstream's own. ` +
      `The one negative reading on this sheet is a price fall past ${alerts.MOVE_PCT}% at the close, which is also the only thing that can mark a row "Alert". ` +
      (behind.length
        ? `NOT EVERY FEED HAS LOOKED AT THIS DAY: ${behind.join(', ')} last read earlier, so an absence here is not evidence that nothing happened.`
        : `Every daily feed on this dashboard had read this day when the sheet was written.`),
  };

  const cell = (get) => (r) => (r.__banner ? '' : get(r));
  return exportRows({
    filename: `sattva-daily-alerts-${day}`,
    sheetName: 'Daily Alerts',
    columns: [
      { header: 'Time (IST)', key: 'time', width: 12, get: (r) => (r.__banner ? r.line : r.time || '') },
      { header: 'Signal', key: 'sev', width: 10, get: cell((r) => (r.severity === 'alert' ? 'Alert' : 'Update')) },
      { header: 'Feed', key: 'feed', width: 18, get: cell((r) => r.feedLabel) },
      { header: 'Ticker', key: 'ticker', width: 14, get: cell((r) => r.ticker || '') },
      { header: 'Company', key: 'company', width: 32, get: cell((r) => r.company) },
      { header: 'What happened', key: 'headline', width: 60, get: cell((r) => r.headline) },
      { header: 'Detail', key: 'detail', width: 50, get: cell((r) => r.detail || '') },
      { header: 'Reading behind the alert', key: 'reason', width: 44, get: cell((r) => r.reason || '') },
      { header: 'Source link', key: 'url', width: 44, get: cell((r) => r.url || '') },
    ],
    rows: [banner, ...visible],
  });
}
