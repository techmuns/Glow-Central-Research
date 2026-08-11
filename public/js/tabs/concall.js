// tabs/concall.js — the Con-call tab.
//
//   Concall Scans      LIVE, from StockScans: every call held this quarter with their result
//                      score, sentiment tier and highlight bullets — see js/concall/scans.js
//   Today & Upcoming   LIVE, from StockScans: the schedule
//   Live Feed     calls in progress, with a transcript ticker that appends on every poll
//   Keyword Scan  companies × tracked keywords, recomputed at runtime by the keyword engine
//   Catalysts     what to watch for, from calls and annual reports
//   Deep Dive     the full-screen workspace — see js/concall/deep-dive.js
//
// EVERY KEYWORD NUMBER ON THIS TAB IS COMPUTED IN THE BROWSER. Nothing is read from a counts
// field in the JSON. Edit the keyword set and this module re-scans and repaints, because it
// subscribes to engine.onKeywordsChange — that responsiveness is the feature.
//
// TWO PROVENANCES IN ONE TAB, AND THE LINE BETWEEN THEM MUST STAY VISIBLE.
//   The first two sub-views are LIVE off StockScans: real calls, and scores that are StockScans'
//   own analysis reproduced unchanged. They carry a green Live pill.
//   The last four run on the SYNTHETIC transcript corpus, because no open source gives us full
//   transcripts — StockScans publishes summaries, not text, and the one provider that does
//   publish structured transcripts truncates them at ninety seconds for anonymous callers. Those
//   four keep their amber ribbon and their fictional speakers.
//
//   Do not let a live number and a synthetic one share a panel. They share a tab; that is already
//   the most they should share, and the pill/ribbon pair is what makes it legible.
//
// PROVENANCE (the synthetic half): transcripts are synthetic and every person and firm named in
// them is fictional. The amber ribbon, the freshness card, the Sources modal rows and the export
// banner all read one flag, `concalls.meta().isMock`, derived from the payload's own `source`.

import { statStrip, topCards, scoreTable, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as concalls from '../data/concalls.js';
import * as engine from '../concall/keyword-engine.js';
import * as deepDive from '../concall/deep-dive.js';
import * as scans from '../concall/scans.js';
import * as scanFeed from '../data/concall-scans.js';

export const meta = {
  id: 'concall',
  title: 'Con-call',
  subtitle: 'Live transcript feed, runtime keyword scanning and catalyst tracking — Deep Dive lives here too.',
  subviews: [
    { id: 'concall-scans', label: 'Concall Scans' },
    { id: 'schedule', label: 'Today & Upcoming' },
    { id: 'live-feed', label: 'Live Feed' },
    { id: 'keyword-scan', label: 'Keyword Scan' },
    { id: 'catalysts', label: 'Catalysts' },
    { id: 'deep-dive', label: 'Deep Dive' },
  ],
};

const FEATURES = [
  'Transcript ingestion from exchange filings and transcript providers',
  'Server-side keyword store shared across a team',
  'Alerting when a tracked keyword appears on a live call',
  'Speaker-level tone scoring rather than call-level',
  'Cross-company theme clustering within a sector',
];

let renderToken = 0;
// The live half's own disposers and carried table view — kept apart from the synthetic half's
// state so neither can tear down the other.
let scanDisposers = [];
let scanTableView = null;
let unsubscribeScanFeed = null;
let unsubscribeLive = null;
let unsubscribeKeywords = null;
let liveRef = null;
let tickerTimers = [];
let ctxRef = null;

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  const token = ++renderToken;
  cleanup();
  liveRef = ctx.live;
  ctxRef = ctx;
  ctx.root.innerHTML = loadingHtml();

  // The live feed loads in parallel and independently: a StockScans outage must not blank the
  // synthetic sub-views, and a missing mock file must not blank the live ones.
  scanFeed
    .load()
    .then(() => {
      if (token !== renderToken) return;
      if (LIVE_SUBVIEWS.has(ctx.subview)) paint(ctx);
      unsubscribeScanFeed = scanFeed.onChange(() => {
        if (token !== renderToken) return;
        // Only repaint the half that changed. A new call landing must not throw away a scrolled
        // transcript on the synthetic side.
        if (LIVE_SUBVIEWS.has(ctx.subview)) paint(ctx);
      });
      scanDisposers.push(scanFeed.startLive(ctx.live));
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[concall] live scan feed failed', err);
      if (LIVE_SUBVIEWS.has(ctx.subview)) {
        ctx.root.innerHTML = `
          ${sectionHead({ title: 'Concall Scans', description: 'The live con-call feed could not be loaded.' })}
          <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
            <div class="text-3xl">⚠️</div>
            <div class="mt-2 text-sm font-semibold text-slate-700">Could not reach the con-call scan feed</div>
            <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
          </div>`;
      }
    });

  concalls
    .load()
    .then(() => {
      if (token !== renderToken) return;
      // Register only. The Live Feed sub-view subscribes and start()s it in wireTickers();
      // the other three sub-views have nothing to tick, so they leave it stopped.
      concalls.registerPoller(ctx.live, { intervalMs: 5000 });
      if (!LIVE_SUBVIEWS.has(ctx.subview)) paint(ctx);
      // A keyword edit anywhere — the header button, the Keyword Scan toolbar, the Deep Dive —
      // repaints the whole tab and the open Deep Dive. This is the single wire that makes the
      // editor feel instant rather than "save and reload".
      unsubscribeKeywords = engine.onKeywordsChange(() => {
        if (token !== renderToken) return;
        if (LIVE_SUBVIEWS.has(ctx.subview)) return; // keywords do not touch the live half
        paint(ctx);
        deepDive.refresh();
      });
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[concall] load failed', err);
      if (LIVE_SUBVIEWS.has(ctx.subview)) return; // the live half does not need the mock corpus
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The con-call data set could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load data/mock/concall-calls.json</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

export function destroy() {
  renderToken++;
  cleanup();
}

function cleanup() {
  if (unsubscribeLive) {
    unsubscribeLive();
    unsubscribeLive = null;
  }
  if (unsubscribeKeywords) {
    unsubscribeKeywords();
    unsubscribeKeywords = null;
  }
  for (const t of tickerTimers) clearInterval(t);
  tickerTimers = [];
  liveRef?.stop(concalls.LIVE_ID);
  ctxRef = null;
  disposeScans();
  if (unsubscribeScanFeed) unsubscribeScanFeed();
  unsubscribeScanFeed = null;
  scanTableView = null;
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

const LIVE_SUBVIEWS = new Set(['concall-scans', 'schedule']);

function paint(ctx) {
  // The live half and the synthetic half do not share a code path. Mixing them behind one
  // dispatcher is how a mock number ends up on a live panel.
  if (LIVE_SUBVIEWS.has(ctx.subview)) return paintLiveHalf(ctx);

  const rows = concalls.forScope(ctx.scope, ctx.data?.portfolio?.holdings || []);
  const view = { 'live-feed': renderLive, 'keyword-scan': renderKeywordScan, catalysts: renderCatalysts, 'deep-dive': renderDeepDiveHome }[ctx.subview] || renderLive;
  view(ctx, rows);
  restoreDeepDiveFromUrl(ctx, rows);
}

function paintLiveHalf(ctx) {
  disposeScans();
  if (ctx.subview === 'schedule') scans.renderSchedule(ctx, { disposers: scanDisposers });
  else scans.renderScans(ctx, { disposers: scanDisposers, tableView: scanTableView, onView: (v) => (scanTableView = v) });
}

function disposeScans() {
  scanDisposers.forEach((d) => d && d());
  scanDisposers = [];
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------

function provenanceRibbon() {
  if (!concalls.meta()?.isMock) return '';
  const m = concalls.meta();
  return `
    <div data-mock-ribbon class="mb-5 flex flex-wrap items-start gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
      <span class="flex-shrink-0 rounded-full bg-amber-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-900">Illustrative data</span>
      <p class="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">
        Transcripts, guidance and tone readings are <strong>synthetic</strong> until the transcript feed is wired.
        Company names, tickers and sectors are real. <strong>Every person and brokerage firm named in these calls is fictional</strong> —
        no real individual said any of this. Generated by <code class="rounded bg-amber-100 px-1">${escapeHtml(m.generator || 'scripts/gen-mock-concalls.mjs')}</code>
        with seed <code class="rounded bg-amber-100 px-1">${escapeHtml(String(m.seed ?? '—'))}</code>.
        <em class="not-italic text-amber-800">The keyword counts, however, are real</em> — they are computed from that text in your browser.
      </p>
    </div>`;
}

function freshnessCard(extraNote) {
  const m = concalls.meta();
  const mock = m?.isMock;
  return {
    hero: true,
    label: 'Last refresh',
    value: mock ? 'Mock data' : formatDate(m?.generated_at),
    note: mock
      ? `Generated ${formatDate(m?.generated_at)} · not a live feed${extraNote ? ` · ${extraNote}` : ''}`
      : `Transcript feed${extraNote ? ` · ${extraNote}` : ''}`,
  };
}

/** The gradient Deep Dive button. Appears in the tab header, on cards, and on table rows. */
function deepDiveButton(ticker, { size = 'sm', label = 'Deep Dive' } = {}) {
  const pad = size === 'lg' ? 'px-4 py-2 text-sm' : 'px-2.5 py-1.5 text-xs';
  return `<button data-deepdive="${escapeHtml(ticker)}"
    class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 ${pad} font-bold text-white shadow-sm transition-opacity hover:opacity-90">
    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>
    ${escapeHtml(label)}</button>`;
}

/**
 * The tab-header launcher: pick a company, hit Deep Dive. This is the entry point that does
 * not depend on finding the company in a table first — the other three (a Live Feed card, a
 * Keyword Scan row, a catalyst row) act on the row you clicked.
 */
function deepDiveLauncher(rows, selected) {
  const options = rows.filter((r) => r.hasTranscript);
  if (!options.length) return '';
  const chosen = options.some((o) => o.ticker === selected) ? selected : options[0].ticker;
  return `
    <div class="mb-5 flex flex-wrap items-center gap-2 rounded-2xl bg-gradient-to-r from-indigo-50 via-purple-50 to-pink-50 p-3 ring-1 ring-indigo-100">
      <span class="text-[11px] font-bold uppercase tracking-wider text-indigo-700">Con-call Deep Dive</span>
      <select data-dd-select class="min-w-[220px] flex-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none">
        ${options
          .map((o) => `<option value="${escapeHtml(o.ticker)}" ${o.ticker === chosen ? 'selected' : ''}>${escapeHtml(o.name)} — ${escapeHtml(o.latest?.quarter || '')}</option>`)
          .join('')}
      </select>
      <button data-dd-launch class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>
        Open Deep Dive
      </button>
    </div>`;
}

function wireDeepDiveLauncher(ctx, root) {
  const btn = root.querySelector('[data-dd-launch]');
  const sel = root.querySelector('[data-dd-select]');
  if (!btn || !sel) return;
  btn.addEventListener('click', () => openDeepDive(ctx, sel.value, 'summary'));
}

/** Delegated: every [data-deepdive] on the page opens the workspace. */
function wireDeepDiveButtons(ctx, root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-deepdive]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openDeepDive(ctx, btn.dataset.deepdive, btn.dataset.ddview || 'summary');
  });
}

function openDeepDive(ctx, ticker, tab = 'summary') {
  const company = concalls.byTicker(ticker);
  if (!company) return;
  const writeUrl = (view) => ctx.setParamsQuiet({ ...(ctx.params || {}), deepdive: ticker, view });
  deepDive.open(company, {
    tab,
    onTabChange: writeUrl,
    onClose: () => {
      const next = { ...(ctx.params || {}) };
      delete next.deepdive;
      delete next.view;
      ctx.setParamsQuiet(next);
    },
  });
  writeUrl(tab);
}

/**
 * ?deepdive=TICKER&view=comparison must survive a reload and a shared link. The overlay is
 * torn down on every mount, so it is reopened from the URL after each paint.
 */
function restoreDeepDiveFromUrl(ctx, rows) {
  const ticker = ctx.params?.deepdive;
  if (!ticker) return;
  if (deepDive.currentTicker() === ticker) return;
  const inScope = rows.some((r) => r.ticker === ticker);
  if (!inScope && ctx.scope === 'portfolio') return; // don't resurrect a company the scope excludes
  openDeepDive(ctx, ticker, ctx.params.view || 'summary');
}

function keywordToolbar() {
  const kws = engine.getKeywords();
  return `
    <div class="mb-5 flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100">
      <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Tracking</span>
      ${kws
        .map((k) => {
          const c = engine.colorFor(k.color);
          return `<span data-kw-chip="${escapeHtml(k.id)}" class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-all ${c.chip}">
            <span class="h-1.5 w-1.5 rounded-full ${c.dot}"></span>${escapeHtml(k.label)}
            <span data-kw-chip-count="${escapeHtml(k.id)}" class="rounded-full bg-white/70 px-1.5 text-[10px] font-bold tabular-nums"></span>
          </span>`;
        })
        .join('')}
      <button data-open-keyword-editor class="ml-auto rounded-lg px-3 py-1.5 text-xs font-bold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">
        ⚙ Edit keywords${engine.hasUserEdits() ? ' <span class="ml-1 rounded bg-indigo-100 px-1 text-[9px]">edited</span>' : ''}
      </button>
    </div>`;
}

function wireKeywordToolbar(root, counts = null) {
  root.querySelector('[data-open-keyword-editor]')?.addEventListener('click', async () => {
    const { openKeywordEditor } = await import('../concall/keyword-editor.js');
    openKeywordEditor();
  });
  if (counts) {
    for (const [id, n] of Object.entries(counts)) {
      const el = root.querySelector(`[data-kw-chip-count="${CSS.escape(id)}"]`);
      if (el) el.textContent = n;
    }
  }
}

// ---------------------------------------------------------------------------------------
// (a) LIVE FEED
// ---------------------------------------------------------------------------------------

function renderLive(ctx, rows) {
  const live = rows.filter((r) => r.status === 'live');
  const scheduled = rows.filter((r) => r.status === 'scheduled');
  const completed = rows.filter((r) => r.status === 'completed');
  const todayIso = concalls.meta()?.as_of;
  const today = completed.filter((r) => r.latest?.date === todayIso);

  const stats = statStrip([
    { label: 'Calls today', value: formatNumber(today.length + live.length), note: `${live.length} still in progress` },
    { label: 'Live now', value: formatNumber(live.length), note: live.length ? 'transcripts streaming below' : 'nothing on air' },
    { label: 'Scheduled this week', value: formatNumber(scheduled.length), note: 'next 7 days' },
    freshnessCard('ticks every 5s'),
  ]);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Calls in progress, streaming as they happen, then everything held this week.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${deepDiveLauncher(rows, ctx.params?.deepdive)}
    ${liveSection(live)}
    ${timelineSection({ live, today, scheduled, completed })}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  wireDeepDiveButtons(ctx, ctx.root);
  wireDeepDiveLauncher(ctx, ctx.root);
  wireTickers(ctx.root, live);
}

function liveSection(live) {
  if (!live.length) {
    return `
      <div class="mb-6 rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <div class="text-3xl">🎙️</div>
        <div class="font-display mt-2 text-base font-bold text-slate-700">No calls in progress</div>
        <div class="mt-1 text-sm text-slate-500">The ticker starts as soon as a call goes live.</div>
      </div>`;
  }
  return `
    <div class="mb-6">
      <div class="mb-3 flex items-center gap-2">
        <span class="relative flex h-2.5 w-2.5">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75"></span>
          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-600"></span>
        </span>
        <h3 class="font-display text-base font-bold text-slate-900">Live now</h3>
        <span class="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200">${live.length} on air</span>
      </div>
      <div class="grid gap-4 xl:grid-cols-2">${live.map(liveCard).join('')}</div>
    </div>`;
}

function liveCard(company) {
  const call = company.latest;
  const kws = engine.getKeywords();
  return `
    <div data-live-card="${escapeHtml(call.callId)}" class="fade-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div class="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-gradient-to-r from-rose-50/70 to-transparent px-4 py-3">
        <span class="relative flex h-2 w-2 flex-shrink-0">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75"></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-rose-600"></span>
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-bold text-slate-900">${escapeHtml(company.name)}</div>
          <div class="text-[11px] text-slate-500">${escapeHtml(company.ticker)} · ${escapeHtml(call.quarter)} · ${escapeHtml(company.sector || '')}</div>
        </div>
        <div class="text-right">
          <div data-elapsed="${escapeHtml(call.callId)}" class="font-mono text-sm font-bold tabular-nums text-rose-700">00:00</div>
          <div class="text-[10px] uppercase tracking-wide text-slate-400">elapsed</div>
        </div>
        ${deepDiveButton(company.ticker)}
      </div>

      <div class="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-2">
        ${kws
          .map((k) => {
            const c = engine.colorFor(k.color);
            return `<span data-live-kw="${escapeHtml(call.callId)}:${escapeHtml(k.id)}"
              class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 transition-all duration-300 ${c.chip} opacity-40">
              ${escapeHtml(k.label)} <span data-live-kw-n class="tabular-nums">0</span></span>`;
          })
          .join('')}
      </div>

      <div data-ticker="${escapeHtml(call.callId)}" class="scrollbar-thin h-56 space-y-2 overflow-y-auto px-4 py-3"></div>

      <div class="flex items-center justify-between border-t border-slate-100 bg-slate-50/70 px-4 py-2 text-[11px] text-slate-500">
        <span data-ticker-progress="${escapeHtml(call.callId)}">—</span>
        <span class="text-slate-400">auto-scrolls · hover to pause</span>
      </div>
    </div>`;
}

/**
 * The ticker. On mount it renders what has already been "said"; on every poll tick the data
 * layer advances the cursor by one segment and this appends it, flashing any keyword chip the
 * new segment matched and bumping its counter.
 */
function wireTickers(root, live) {
  if (!live.length) return;

  const state = new Map(); // callId -> { paused, rendered, counts }

  for (const company of live) {
    const call = company.latest;
    const box = root.querySelector(`[data-ticker="${CSS.escape(call.callId)}"]`);
    if (!box) continue;
    const cursor = concalls.liveCursor(call.callId) || { revealed: 1, elapsedSec: 0 };
    const st = { paused: false, rendered: 0, counts: {} };
    state.set(call.callId, st);

    box.addEventListener('mouseenter', () => (st.paused = true));
    box.addEventListener('mouseleave', () => (st.paused = false));

    // Backfill everything already spoken, then keep appending.
    appendSegments(root, call, st, 0, cursor.revealed);
    paintElapsed(root, call.callId, cursor.elapsedSec);
  }

  unsubscribeLive?.();
  unsubscribeLive = liveRef.subscribe(concalls.LIVE_ID, (payload) => {
    for (const entry of payload?.calls || []) {
      const st = state.get(entry.callId);
      if (!st) continue;
      const company = concalls.byTicker(entry.ticker);
      const call = company?.latest;
      if (!call) continue;
      appendSegments(root, call, st, st.rendered, entry.revealed);
      paintElapsed(root, entry.callId, entry.elapsedSec);
      const prog = root.querySelector(`[data-ticker-progress="${CSS.escape(entry.callId)}"]`);
      if (prog) {
        prog.textContent = entry.complete
          ? `Call complete · ${entry.total} segments`
          : `${entry.revealed} of ~${entry.total} segments`;
      }
    }
  });
  liveRef.start(concalls.LIVE_ID);
}

function paintElapsed(root, callId, sec) {
  const el = root.querySelector(`[data-elapsed="${CSS.escape(callId)}"]`);
  if (!el) return;
  const s = Math.max(0, sec | 0);
  el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const MAX_TICKER_NODES = 40; // never let the ticker grow unbounded across a long session

function appendSegments(root, call, st, from, to) {
  const box = root.querySelector(`[data-ticker="${CSS.escape(call.callId)}"]`);
  if (!box) return;
  const kws = engine.getKeywords();

  for (let i = from; i < Math.min(to, call.transcript.length); i++) {
    const seg = call.transcript[i];
    const isAnalyst = /analyst/i.test(seg.role || '');
    const node = document.createElement('div');
    node.className = `fade-in rounded-lg border-l-2 ${isAnalyst ? 'border-purple-300 bg-purple-50/40' : 'border-indigo-300 bg-slate-50'} px-2.5 py-1.5`;
    node.innerHTML = `
      <div class="text-[10px] font-bold ${isAnalyst ? 'text-purple-700' : 'text-indigo-700'}">${escapeHtml(seg.speaker)}
        <span class="font-normal text-slate-400">· ${escapeHtml(seg.role)}</span></div>
      <p class="text-[11px] leading-snug text-slate-700">${engine.highlight(seg.text, kws, escapeHtml)}</p>`;
    box.appendChild(node);

    // Which tracked keywords did this new line contain? Same engine as everywhere else.
    const hit = engine.scanCall({ callId: `live:${call.callId}:${i}`, transcript: [seg] }, kws);
    for (const k of kws) {
      const n = hit.byKeyword[k.id]?.hits || 0;
      if (!n) continue;
      st.counts[k.id] = (st.counts[k.id] || 0) + n;
      flashKeywordChip(root, call.callId, k.id, st.counts[k.id]);
    }
  }
  st.rendered = Math.max(st.rendered, Math.min(to, call.transcript.length));

  while (box.children.length > MAX_TICKER_NODES) box.removeChild(box.firstChild);
  if (!st.paused) box.scrollTop = box.scrollHeight;
}

function flashKeywordChip(root, callId, keywordId, count) {
  const chip = root.querySelector(`[data-live-kw="${CSS.escape(`${callId}:${keywordId}`)}"]`);
  if (!chip) return;
  const n = chip.querySelector('[data-live-kw-n]');
  if (n) n.textContent = count;
  chip.classList.remove('opacity-40');
  chip.classList.add('scale-110', 'ring-2');
  setTimeout(() => chip.classList.remove('scale-110', 'ring-2'), 700);
}

const TIMELINE_PILL = {
  live: 'bg-rose-50 text-rose-700 ring-rose-200',
  today: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  week: 'bg-purple-50 text-purple-700 ring-purple-200',
  done: 'bg-slate-100 text-slate-600 ring-slate-200',
};

function timelineSection({ live, today, scheduled, completed }) {
  const earlier = completed.filter((c) => !today.includes(c)).slice(0, 40);
  const groups = [
    { id: 'live', label: 'Live', rows: live },
    { id: 'today', label: 'Today', rows: today },
    { id: 'week', label: 'Scheduled this week', rows: scheduled },
    { id: 'done', label: 'Completed', rows: earlier },
  ].filter((g) => g.rows.length);

  if (!groups.length) {
    return '<div class="mb-6 rounded-2xl bg-white p-8 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No calls for the current scope.</div>';
  }

  return `
    <div class="mb-6 space-y-5">
      ${groups
        .map(
          (g) => `
        <div>
          <div class="mb-2 flex items-center gap-2">
            <span class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${TIMELINE_PILL[g.id]}">${escapeHtml(g.label)}</span>
            <span class="text-xs text-slate-400">${g.rows.length}</span>
          </div>
          <div class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
            ${g.rows.map((r) => timelineRow(r, g.id)).join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

function timelineRow(company, groupId) {
  const call = company.latest;
  const kws = engine.getKeywords();
  const scan = call?.transcript?.length ? engine.scanCall(call, kws) : null;
  const top = scan
    ? Object.values(scan.byKeyword)
        .filter((b) => b.hits)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 4)
    : [];

  return `
    <div class="flex flex-wrap items-center gap-3 border-b border-slate-50 px-4 py-2.5 last:border-0 hover:bg-slate-50/60">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold text-slate-800">${escapeHtml(company.name)}</div>
        <div class="text-[11px] text-slate-400">${escapeHtml(company.ticker)} · ${escapeHtml(company.sector || '')}</div>
      </div>
      <div class="w-20 text-xs text-slate-500">${escapeHtml(call?.quarter || '—')}</div>
      <div class="w-28 text-xs text-slate-500">${call?.date ? escapeHtml(formatDate(call.date)) : '—'}</div>
      <div class="w-16 text-xs tabular-nums text-slate-400">${call?.durationMin ? `${call.durationMin}m` : '—'}</div>
      <div class="hidden min-w-[190px] flex-1 flex-wrap gap-1 sm:flex">
        ${
          top.length
            ? top
                .map((b) => {
                  const c = engine.colorFor(b.color);
                  return `<span class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ring-1 ${c.chip}">${escapeHtml(b.label)} ${b.hits}</span>`;
                })
                .join('')
            : `<span class="text-[10px] text-slate-300">${groupId === 'week' ? 'not held yet' : 'no keyword hits'}</span>`
        }
      </div>
      ${call?.transcript?.length ? deepDiveButton(company.ticker) : '<span class="w-[104px] text-right text-[10px] text-slate-300">upcoming</span>'}
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (b) KEYWORD SCAN
// ---------------------------------------------------------------------------------------

/** One matrix row per company: per-keyword hits, deltas, tone, catalyst count. */
function buildMatrix(rows) {
  const kws = engine.getKeywords();
  return rows
    .filter((r) => r.hasTranscript)
    .map((company) => {
      const now = engine.scanCall(company.latest, kws);
      const prev = company.previous?.transcript?.length ? engine.scanCall(company.previous, kws) : null;
      const cmp = engine.compareScans(now, prev);
      return {
        company,
        ticker: company.ticker,
        name: company.name,
        sector: company.sector,
        quarter: company.latest?.quarter || '',
        scan: now,
        cmp,
        totalHits: now.totalHits,
        momentum: cmp.totalDelta,
        tone: company.latest?.tone || null,
        guidance: company.latest?.guidance || [],
        catalystCount: concalls.catalystsFor(company.ticker).length,
      };
    });
}

const TONE_BAND = (t) => (t == null ? 'unknown' : t > 0.25 ? 'positive' : t < -0.2 ? 'cautious' : 'neutral');

const SCAN_FILTERS = {
  kw: {
    label: 'Mentions',
    options: (kws) => [{ id: 'any', label: 'Any keyword' }, ...kws.map((k) => ({ id: k.id, label: k.label }))],
    test: (row, id) => id === 'any' || (row.scan.byKeyword[id]?.hits || 0) > 0,
  },
  sec: {
    label: 'Sector',
    options: (_, rows) => [{ id: 'any', label: 'All sectors' }, ...[...new Set(rows.map((r) => r.sector).filter(Boolean))].sort().slice(0, 8).map((s) => ({ id: s, label: s.length > 22 ? `${s.slice(0, 20)}…` : s }))],
    test: (row, id) => id === 'any' || row.sector === id,
  },
  tone: {
    label: 'Tone',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'positive', label: 'Positive' },
      { id: 'neutral', label: 'Neutral' },
      { id: 'cautious', label: 'Cautious' },
    ],
    test: (row, id) => id === 'any' || TONE_BAND(row.tone?.score) === id,
  },
  guide: {
    label: 'Guidance',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'raised', label: 'Raised' },
      { id: 'cut', label: 'Cut' },
    ],
    test: (row, id) => id === 'any' || row.guidance.some((g) => g.direction === id),
  },
  cat: {
    label: 'Catalysts',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'has', label: 'Has catalysts' },
    ],
    test: (row, id) => id === 'any' || row.catalystCount > 0,
  },
};
const SCAN_DEFAULTS = { kw: 'any', sec: 'any', tone: 'any', guide: 'any', cat: 'any' };

function readScanState(params) {
  const out = {};
  for (const [k, def] of Object.entries(SCAN_DEFAULTS)) out[k] = params?.[k] || def;
  return out;
}

function applyScanFilters(rows, params) {
  const state = readScanState(params);
  return rows.filter((row) => Object.entries(SCAN_FILTERS).every(([key, f]) => f.test(row, state[key])));
}

function scanFilterBar(allRows, params) {
  const state = readScanState(params);
  const kws = engine.getKeywords();
  return `
    <div class="mb-5 space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-scan-filters>
      ${Object.entries(SCAN_FILTERS)
        .map(([key, f]) => {
          const opts = f.options(kws, allRows);
          return `
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(f.label)}</span>
            ${opts
              .map((o) => {
                const active = state[key] === o.id;
                const trial = { ...state, [key]: o.id };
                const n = allRows.filter((r) => Object.entries(SCAN_FILTERS).every(([k2, f2]) => f2.test(r, trial[k2]))).length;
                return `<button type="button" data-scan-filter="${escapeHtml(key)}" data-scan-value="${escapeHtml(o.id)}"
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }">
                  <span>${escapeHtml(o.label)}</span>
                  <span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>
                </button>`;
              })
              .join('')}
          </div>`;
        })
        .join('')}
    </div>`;
}

function renderKeywordScan(ctx, rows) {
  const kws = engine.getKeywords();
  const all = buildMatrix(rows);
  const matrix = applyScanFilters(all, ctx.params);
  const noCall = rows.filter((r) => !r.hasTranscript);

  // Total hits per keyword across the visible set — the chip counters in the toolbar.
  const chipCounts = {};
  for (const k of kws) chipCounts[k.id] = matrix.reduce((s, r) => s + (r.scan.byKeyword[k.id]?.hits || 0), 0);

  const totalHits = matrix.reduce((s, r) => s + r.totalHits, 0);
  const risers = matrix.filter((r) => (r.momentum ?? 0) > 0).length;

  const stats = statStrip([
    { label: 'Companies scanned', value: formatNumber(matrix.length), note: noCall.length ? `${noCall.length} with no call data` : 'all have a transcript' },
    { label: 'Keyword mentions', value: formatNumber(totalHits), note: `across ${kws.length} tracked keywords` },
    {
      label: 'Talking more',
      value: formatNumber(risers),
      note: 'vs their previous call',
      help: {
        title: 'How these counts are produced',
        body: `<p>Every number in this matrix is computed <strong>in your browser, right now</strong>, by scanning transcript text for each keyword's match terms. Nothing is read from a stored count.</p>
               <p class="mt-3">Matching is case-insensitive and word-boundary anchored, and all of a keyword's aliases count toward it — a call that says "capital outlay" but never "capex" still registers under Capex. Overlapping aliases count once.</p>
               <p class="mt-3 text-slate-500">Edit the keyword set and this table rebuilds immediately: columns appear, disappear and re-count. The transcripts themselves are <strong>mock</strong> (see the amber ribbon); the scanning is real.</p>`,
      },
    },
    freshnessCard(`${kws.length} keywords`),
  ]);

  const cards = topCards({
    title: 'Top 10 by Keyword Momentum', // topCards prepends the trophy
    items: matrix
      .filter((r) => r.momentum != null)
      .sort((a, b) => (b.momentum ?? 0) - (a.momentum ?? 0))
      .slice(0, 10)
      .map((r) => ({
        key: r.ticker,
        name: r.name,
        sub: r.sector,
        value: `${r.momentum > 0 ? '+' : ''}${r.momentum}`,
        tone: r.momentum > 0 ? 'positive' : r.momentum < 0 ? 'negative' : 'neutral',
      })),
    valueFormat: 'metric',
    onSelect: (item) => openDeepDive(ctx, item.key, 'comparison'),
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Every tracked keyword, counted against every transcript, recomputed as you edit the set.',
      meta: scopeSummary({ scope: ctx.scope, count: matrix.length, noun: 'calls scanned' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${deepDiveLauncher(rows, ctx.params?.deepdive)}
    ${keywordToolbar()}
    ${scanFilterBar(all, ctx.params)}
    ${cards.html}
    ${matrixTable(matrix, kws)}
    ${noCallPanel(noCall)}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  wireKeywordToolbar(ctx.root, chipCounts);
  wireScanFilters(ctx, ctx.root);
  wireMatrix(ctx, ctx.root, matrix, kws);
  wireDeepDiveButtons(ctx, ctx.root);
  wireDeepDiveLauncher(ctx, ctx.root);
}

function noCallPanel(noCall) {
  if (!noCall.length) return '';
  return `
    <div class="mb-6 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div class="text-xs font-bold uppercase tracking-wider text-slate-500">No call data (${noCall.length})</div>
      <div class="mt-1 text-[11px] text-slate-500">
        These holdings have no con-call in the current set. They are listed rather than dropped — a missing transcript is not the
        same as a company that said nothing.
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${noCall.map((r) => `<span class="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">${escapeHtml(r.name)}</span>`).join('')}
      </div>
    </div>`;
}

/**
 * The matrix. Company column is sticky so it stays put while the keyword columns scroll
 * sideways INSIDE the container — the page itself never scrolls horizontally.
 */
function matrixTable(matrix, kws) {
  if (!matrix.length) {
    return '<div class="mb-6 rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No calls match these filters.</div>';
  }
  const th = 'px-2.5 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500';
  return `
    <div class="mb-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
      <div class="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <h3 class="font-display text-sm font-bold text-slate-900">Keyword matrix</h3>
          <p class="text-[11px] text-slate-400">Hover a cell for the matched sentences · click to open that keyword in the Deep Dive</p>
        </div>
        <button data-matrix-export class="flex-shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-700">Export Excel</button>
      </div>
      <div class="scrollbar-thin overflow-x-auto">
        <table class="w-full text-sm" data-matrix>
          <thead class="bg-slate-50/80">
            <tr>
              <th scope="col" class="sticky left-0 z-20 bg-slate-50 ${th} min-w-[210px] text-left">Company</th>
              <th scope="col" class="${th} text-left">Quarter</th>
              <th scope="col" class="${th} text-right">Total</th>
              <th scope="col" class="${th} text-right">Momentum</th>
              <th scope="col" class="${th} text-left">Tone</th>
              <th scope="col" class="${th} text-right">Catalysts</th>
              ${kws
                .map((k) => {
                  const c = engine.colorFor(k.color);
                  return `<th scope="col" class="${th} min-w-[74px] text-center" title="${escapeHtml(k.terms.join(', '))}">
                    <span class="mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${c.dot}"></span>
                    <span class="block leading-tight">${escapeHtml(k.label)}</span></th>`;
                })
                .join('')}
              <th scope="col" class="${th}"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${matrix.map((row) => matrixRow(row, kws)).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function matrixRow(row, kws) {
  const toneScore = row.tone?.score;
  const toneCls = toneScore == null ? 'text-slate-400' : toneScore > 0.25 ? 'text-emerald-600' : toneScore < -0.2 ? 'text-rose-600' : 'text-amber-600';
  return `
    <tr data-matrix-row="${escapeHtml(row.ticker)}" class="group hover:bg-slate-50/70">
      <td class="sticky left-0 z-10 min-w-[210px] bg-white px-2.5 py-2 group-hover:bg-slate-50">
        <div class="truncate text-sm font-semibold text-slate-800">${escapeHtml(row.name)}</div>
        <div class="text-[10px] text-slate-400">${escapeHtml(row.ticker)} · ${escapeHtml(row.sector || '')}</div>
      </td>
      <td class="px-2.5 py-2 text-xs text-slate-500">${escapeHtml(row.quarter)}</td>
      <td class="px-2.5 py-2 text-right text-sm font-bold tabular-nums text-slate-800">${row.totalHits}</td>
      <td class="px-2.5 py-2 text-right">${momentumCell(row.momentum)}</td>
      <td class="px-2.5 py-2 text-xs font-semibold ${toneCls}">${escapeHtml(row.tone?.label || '—')}</td>
      <td class="px-2.5 py-2 text-right text-xs tabular-nums text-slate-500">${row.catalystCount || '—'}</td>
      ${kws.map((k) => matrixCell(row, k)).join('')}
      <td class="px-2.5 py-2 text-right">${deepDiveButton(row.ticker)}</td>
    </tr>`;
}

function momentumCell(delta) {
  if (delta == null) return '<span class="text-[11px] text-slate-300">n/a</span>';
  if (delta === 0) return '<span class="text-xs tabular-nums text-slate-400">0</span>';
  const up = delta > 0;
  return `<span class="inline-flex items-center gap-0.5 text-xs font-bold tabular-nums ${up ? 'text-indigo-700' : 'text-slate-500'}">
    ${up ? '▲' : '▼'} ${Math.abs(delta)}</span>`;
}

function matrixCell(row, k) {
  const b = row.scan.byKeyword[k.id];
  const hits = b?.hits || 0;
  const delta = row.cmp.byKeyword[k.id]?.delta ?? null;
  const c = engine.colorFor(k.color);
  if (!hits) {
    return `<td class="px-2.5 py-2 text-center"><span class="text-xs text-slate-200">·</span></td>`;
  }
  return `
    <td class="px-1 py-2 text-center">
      <button data-cell="${escapeHtml(row.ticker)}:${escapeHtml(k.id)}"
        class="mx-auto flex w-full max-w-[64px] flex-col items-center rounded-lg px-1.5 py-1 transition-transform hover:scale-105 ${c.cell}">
        <span class="text-sm font-bold tabular-nums leading-none">${hits}</span>
        ${
          delta == null
            ? '<span class="text-[9px] leading-tight opacity-50">new</span>'
            : delta === 0
              ? '<span class="text-[9px] leading-tight opacity-50">—</span>'
              : `<span class="text-[9px] font-bold leading-tight ${delta > 0 ? '' : 'opacity-60'}">${delta > 0 ? '+' : ''}${delta}</span>`
        }
      </button>
    </td>`;
}

function wireScanFilters(ctx, root) {
  root.querySelector('[data-scan-filters]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scan-filter]');
    if (!btn) return;
    ctx.setParams({ ...(ctx.params || {}), [btn.dataset.scanFilter]: btn.dataset.scanValue });
  });
}

function wireMatrix(ctx, root, matrix, kws) {
  const table = root.querySelector('[data-matrix]');
  if (!table) return;
  const byTicker = new Map(matrix.map((r) => [r.ticker, r]));

  // Delegated — one listener for up to 60 rows × 9 columns of cells.
  table.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-cell]');
    if (cell) {
      const [ticker] = cell.dataset.cell.split(':');
      openDeepDive(ctx, ticker, 'keywords');
      return;
    }
    if (e.target.closest('[data-deepdive]')) return; // handled by the delegated button wiring
    const row = e.target.closest('[data-matrix-row]');
    if (row) openDeepDive(ctx, row.dataset.matrixRow, 'summary');
  });

  // Hover tooltip showing the matched sentences behind a cell.
  let tip = null;
  const hide = () => {
    tip?.remove();
    tip = null;
  };
  table.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('[data-cell]');
    if (!cell) return;
    const [ticker, kwId] = cell.dataset.cell.split(':');
    const row = byTicker.get(ticker);
    const bucket = row?.scan.byKeyword[kwId];
    if (!bucket?.contexts.length) return;
    hide();
    const k = kws.find((x) => x.id === kwId);
    tip = document.createElement('div');
    tip.className = 'pointer-events-none fixed z-[80] max-w-sm rounded-xl bg-slate-900 p-3 text-white shadow-2xl';
    tip.innerHTML = `
      <div class="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-300">
        ${escapeHtml(k?.label || kwId)} · ${bucket.hits} mention${bucket.hits === 1 ? '' : 's'}
        <span class="rounded bg-slate-700 px-1">${bucket.prepared} prepared</span>
        <span class="rounded bg-slate-700 px-1">${bucket.qna} Q&amp;A</span>
      </div>
      ${bucket.contexts
        .slice(0, 3)
        .map((c) => `<p class="mb-1 text-[11px] leading-snug text-slate-200">“${escapeHtml(c.sentence)}”<span class="block text-[10px] text-slate-400">— ${escapeHtml(c.speaker)}</span></p>`)
        .join('')}
      ${bucket.contexts.length > 3 ? `<div class="text-[10px] text-slate-400">+${bucket.contexts.length - 3} more — click to open</div>` : ''}`;
    document.body.appendChild(tip);
    const r = cell.getBoundingClientRect();
    const top = r.top - tip.offsetHeight - 8;
    tip.style.top = `${top < 8 ? r.bottom + 8 : top}px`;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  });
  table.addEventListener('mouseout', (e) => {
    if (!e.target.closest('[data-cell]')) return;
    hide();
  });
  // A repaint (keyword edit, filter change) drops the table without a mouseout firing.
  table.addEventListener('mouseleave', hide);

  root.querySelector('[data-matrix-export]')?.addEventListener('click', () => runExport(matrix, kws));
}

// ---------------------------------------------------------------------------------------
// (c) CATALYSTS
// ---------------------------------------------------------------------------------------

const CAT_DEFAULTS = { ctype: 'any', csrc: 'any', cstatus: 'any', cwhen: 'any', cgroup: 'company' };

const MONTHS_MS = 30.44 * 24 * 3600 * 1000;
function monthsAway(iso) {
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - new Date('2026-08-10T00:00:00Z').getTime()) / MONTHS_MS;
}

const CAT_FILTERS = {
  ctype: {
    label: 'Type',
    options: (rows) => [{ id: 'any', label: 'All types' }, ...[...new Set(rows.map((r) => r.type))].sort().map((t) => ({ id: t, label: t }))],
    test: (r, id) => id === 'any' || r.type === id,
  },
  csrc: {
    label: 'Source',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'concall', label: 'Con-call' },
      { id: 'annual-report', label: 'Annual report' },
    ],
    test: (r, id) => id === 'any' || r.source?.kind === id,
  },
  cstatus: {
    label: 'Status',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'upcoming', label: 'Upcoming' },
      { id: 'in-progress', label: 'In progress' },
      { id: 'delivered', label: 'Delivered' },
    ],
    test: (r, id) => id === 'any' || r.status === id,
  },
  cwhen: {
    label: 'Expected',
    options: () => [
      { id: 'any', label: 'Any time' },
      { id: '3', label: 'Within 3m' },
      { id: '6', label: 'Within 6m' },
      { id: '12', label: 'Within 12m' },
    ],
    test: (r, id) => {
      if (id === 'any') return true;
      const m = monthsAway(r.expectedBy);
      return m != null && m <= Number(id);
    },
  },
};

function renderCatalysts(ctx, rows) {
  const inScope = new Set(rows.map((r) => r.ticker));
  const all = concalls.allCatalysts().filter((c) => inScope.has(String(c.ticker).toUpperCase()));
  const state = { ...CAT_DEFAULTS };
  for (const k of Object.keys(CAT_DEFAULTS)) if (ctx.params?.[k]) state[k] = ctx.params[k];
  const list = all.filter((c) => Object.entries(CAT_FILTERS).every(([key, f]) => f.test(c, state[key])));

  const upcoming = list.filter((c) => c.status === 'upcoming').length;
  const near = list.filter((c) => (monthsAway(c.expectedBy) ?? 99) <= 3).length;

  const stats = statStrip([
    { label: 'Catalysts', value: formatNumber(list.length), note: `${all.length} in scope before filters` },
    { label: 'Upcoming', value: formatNumber(upcoming), note: 'not yet started' },
    { label: 'Within 3 months', value: formatNumber(near), note: 'by expected date' },
    freshnessCard('catalysts refresh with each call'),
  ]);

  const table = scoreTable({
    rows: list,
    key: (r) => `${r.ticker}:${r.catalyst}`,
    name: (r) => r.name || r.ticker,
    nameLabel: 'Company',
    sub: (r) => [r.ticker, r.sector].filter(Boolean).join(' · '),
    searchable: (r) => `${r.name} ${r.ticker} ${r.catalyst} ${r.type}`,
    initialSort: { key: 'Expected by', dir: 'asc' },
    exportName: `sattva-catalysts-${todayStamp()}`,
    onRowClick: (r) => openDeepDive(ctx, r.ticker, 'catalysts'),
    columns: [
      { label: 'Catalyst', get: (r) => `<span class="text-sm text-slate-700">${escapeHtml(r.catalyst)}</span>`, html: true },
      { label: 'Type', get: (r) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">${escapeHtml(r.type)}</span>`, html: true, sortValue: (r) => r.type },
      {
        label: 'Source',
        html: true,
        sortValue: (r) => r.source?.kind || '',
        get: (r) =>
          r.source?.kind === 'concall'
            ? `<span class="text-[11px] font-medium text-indigo-700">Con-call ${escapeHtml(String(r.source.ref || '').split('-').pop() || '')}</span>`
            : `<span class="text-[11px] font-medium text-purple-700">${escapeHtml(r.source?.ref || 'Annual report')}</span>`,
      },
      { label: 'Expected by', get: (r) => formatDate(r.expectedBy), sortValue: (r) => r.expectedBy, align: 'right' },
      {
        label: 'Status',
        html: true,
        sortValue: (r) => r.status,
        get: (r) => `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${
          r.status === 'delivered' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : r.status === 'in-progress' ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-indigo-50 text-indigo-700 ring-indigo-200'
        }">${escapeHtml(r.status)}</span>`,
      },
      { label: 'Confidence', html: true, sortValue: (r) => ({ high: 3, medium: 2, low: 1 })[r.confidence] || 0, get: (r) => confidenceMeter(r.confidence) },
      { label: '', html: true, get: (r) => deepDiveButton(r.ticker, { label: 'Deep Dive' }) },
    ],
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Catalysts management has committed to, from con-calls and annual reports, with the quote behind each one.',
      meta: scopeSummary({ scope: ctx.scope, count: list.length, noun: 'catalysts' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${deepDiveLauncher(rows, ctx.params?.deepdive)}
    ${catalystFilterBar(all, state)}
    ${state.cgroup === 'type' ? groupedByType(list) : table.html}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  if (state.cgroup !== 'type') table.wire(ctx.root);
  wireCatalystFilters(ctx, ctx.root);
  wireDeepDiveButtons(ctx, ctx.root);
  wireDeepDiveLauncher(ctx, ctx.root);
}

function confidenceMeter(level) {
  const n = { high: 3, medium: 2, low: 1 }[level] || 0;
  return `<span class="inline-flex items-center gap-0.5" title="${escapeHtml(level || 'unknown')} confidence">
    ${[1, 2, 3].map((i) => `<span class="h-1.5 w-1.5 rounded-full ${i <= n ? 'bg-indigo-500' : 'bg-slate-200'}"></span>`).join('')}
  </span>`;
}

function catalystFilterBar(allRows, state) {
  return `
    <div class="mb-5 space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-cat-filters>
      ${Object.entries(CAT_FILTERS)
        .map(([key, f]) => {
          const opts = f.options(allRows);
          return `
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-20 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(f.label)}</span>
            ${opts
              .map((o) => {
                const active = state[key] === o.id;
                const trial = { ...state, [key]: o.id };
                const n = allRows.filter((r) => Object.entries(CAT_FILTERS).every(([k2, f2]) => f2.test(r, trial[k2]))).length;
                return `<button type="button" data-cat-filter="${escapeHtml(key)}" data-cat-value="${escapeHtml(o.id)}"
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  }">
                  <span>${escapeHtml(o.label)}</span>
                  <span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>
                </button>`;
              })
              .join('')}
          </div>`;
        })
        .join('')}
      <div class="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
        <span class="w-20 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">Group by</span>
        ${[
          { id: 'company', label: 'Company' },
          { id: 'type', label: 'Type' },
        ]
          .map(
            (o) => `<button type="button" data-cat-filter="cgroup" data-cat-value="${o.id}"
              class="rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                state.cgroup === o.id ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }">${o.label}</button>`
          )
          .join('')}
      </div>
    </div>`;
}

function groupedByType(list) {
  const groups = new Map();
  for (const c of list) {
    if (!groups.has(c.type)) groups.set(c.type, []);
    groups.get(c.type).push(c);
  }
  if (!groups.size) return '<div class="mb-6 rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No catalysts match these filters.</div>';
  return `
    <div class="mb-6 space-y-4">
      ${[...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(
          ([type, rows]) => `
        <div>
          <div class="mb-2 flex items-center gap-2">
            <h3 class="font-display text-sm font-bold text-slate-800">${escapeHtml(type)}</h3>
            <span class="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">${rows.length}</span>
          </div>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            ${rows
              .map(
                (c) => `
              <div class="rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-100">
                <div class="mb-1 flex items-start justify-between gap-2">
                  <span class="text-xs font-bold text-slate-800">${escapeHtml(c.name || c.ticker)}</span>
                  ${deepDiveButton(c.ticker, { label: 'Open' })}
                </div>
                <div class="text-sm text-slate-700">${escapeHtml(c.catalyst)}</div>
                <div class="mt-1 text-[11px] text-slate-400">${escapeHtml(c.status)} · expected by ${escapeHtml(formatDate(c.expectedBy))}</div>
              </div>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;
}

function wireCatalystFilters(ctx, root) {
  root.querySelector('[data-cat-filters]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat-filter]');
    if (!btn) return;
    ctx.setParams({ ...(ctx.params || {}), [btn.dataset.catFilter]: btn.dataset.catValue });
  });
}

// ---------------------------------------------------------------------------------------
// (d) DEEP DIVE sub-view — a picker, since the Deep Dive itself is an overlay
// ---------------------------------------------------------------------------------------

function renderDeepDiveHome(ctx, rows) {
  const kws = engine.getKeywords();
  const withCalls = rows.filter((r) => r.hasTranscript);
  const ranked = withCalls
    .map((company) => {
      const now = engine.scanCall(company.latest, kws);
      const prev = company.previous?.transcript?.length ? engine.scanCall(company.previous, kws) : null;
      return { company, hits: now.totalHits, delta: engine.compareScans(now, prev).totalDelta };
    })
    .sort((a, b) => b.hits - a.hits);

  const stats = statStrip([
    { label: 'Calls available', value: formatNumber(withCalls.length), note: 'with a full transcript' },
    { label: 'With a prior call', value: formatNumber(withCalls.filter((c) => c.previous?.transcript?.length).length), note: 'comparison available' },
    { label: 'Keywords tracked', value: formatNumber(kws.length), note: engine.hasUserEdits() ? 'your edited set' : 'default set' },
    freshnessCard(),
  ]);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Con-call Deep Dive',
      description: 'Pick a company to open the full analysis — summary, quarter-on-quarter comparison, transcript, Q&A, keywords and catalysts.',
      meta: scopeSummary({ scope: ctx.scope, count: withCalls.length, noun: 'calls' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    <div class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <input data-dd-search type="search" placeholder="Search a company to deep dive…"
        class="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none" />
    </div>
    <div data-dd-grid class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      ${ranked.map(ddCard).join('') || '<div class="col-span-full rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">No calls in this scope.</div>'}
    </div>
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  wireDeepDiveButtons(ctx, ctx.root);

  const search = ctx.root.querySelector('[data-dd-search]');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    ctx.root.querySelectorAll('[data-dd-card]').forEach((card) => {
      card.classList.toggle('hidden', !!q && !card.dataset.ddCard.toLowerCase().includes(q));
    });
  });
}

function ddCard({ company, hits, delta }) {
  const tone = company.latest?.tone;
  return `
    <button data-deepdive="${escapeHtml(company.ticker)}" data-dd-card="${escapeHtml(`${company.name} ${company.ticker} ${company.sector}`)}"
      class="rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-all hover:-translate-y-0.5 hover:shadow-md hover:ring-indigo-200">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-sm font-bold text-slate-900">${escapeHtml(company.name)}</div>
          <div class="text-[11px] text-slate-400">${escapeHtml(company.ticker)} · ${escapeHtml(company.latest?.quarter || '')}</div>
        </div>
        ${company.status === 'live' ? '<span class="flex-shrink-0 rounded-full bg-rose-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-rose-700 ring-1 ring-rose-200">live</span>' : ''}
      </div>
      <div class="mt-3 flex items-end justify-between">
        <div>
          <div class="text-xl font-bold tabular-nums text-slate-900">${hits}</div>
          <div class="text-[10px] uppercase tracking-wide text-slate-400">keyword mentions</div>
        </div>
        <div class="text-right">
          <div class="text-xs font-semibold ${delta == null ? 'text-slate-400' : delta > 0 ? 'text-indigo-700' : 'text-slate-500'}">${delta == null ? 'first call' : `${delta > 0 ? '+' : ''}${delta} QoQ`}</div>
          ${tone ? `<div class="text-[10px] text-slate-400">${escapeHtml(tone.label)} ${tone.score > 0 ? '+' : ''}${tone.score}</div>` : ''}
        </div>
      </div>
    </button>`;
}

// ---------------------------------------------------------------------------------------
// Export — three sheets, provenance banner as row 1 of each
// ---------------------------------------------------------------------------------------

async function runExport(matrix, kws) {
  const m = concalls.meta();
  const banner = m?.isMock
    ? 'ILLUSTRATIVE DATA — company names, tickers and sectors are real; all transcripts, guidance and tone readings are synthetic (scripts/gen-mock-concalls.mjs), and every person and firm named is fictional. Keyword counts are genuinely computed from that synthetic text.'
    : `Con-call data as of ${formatDate(m?.generated_at)}.`;

  const keywordColumns = kws.flatMap((k) => [
    { header: k.label, key: `kw_${k.id}`, width: 12, get: (r) => r.scan.byKeyword[k.id]?.hits ?? 0 },
    { header: `${k.label} Δ`, key: `kwd_${k.id}`, width: 9, get: (r) => r.cmp.byKeyword[k.id]?.delta ?? '' },
  ]);

  const ok = await exportSheets({
    filename: `sattva-concalls-${todayStamp()}`,
    banner,
    sheets: [
      {
        name: 'Keyword matrix',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Sector', key: 'sector', width: 26, get: (r) => r.sector },
          { header: 'Quarter', key: 'quarter', width: 10, get: (r) => r.quarter },
          { header: 'Total hits', key: 'total', width: 11, get: (r) => r.totalHits },
          { header: 'Momentum', key: 'mom', width: 11, get: (r) => r.momentum ?? '' },
          { header: 'Tone', key: 'tone', width: 12, get: (r) => r.tone?.label ?? '' },
          { header: 'Tone score', key: 'tones', width: 11, get: (r) => r.tone?.score ?? '' },
          ...keywordColumns,
        ],
        rows: matrix,
      },
      {
        name: 'Catalysts',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name || r.ticker },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Catalyst', key: 'catalyst', width: 46, get: (r) => r.catalyst },
          { header: 'Type', key: 'type', width: 20, get: (r) => r.type },
          { header: 'Source', key: 'src', width: 22, get: (r) => (r.source?.kind === 'concall' ? `Con-call ${r.source.ref}` : r.source?.ref || 'Annual report') },
          { header: 'Expected by', key: 'exp', width: 14, get: (r) => r.expectedBy },
          { header: 'Status', key: 'status', width: 13, get: (r) => r.status },
          { header: 'Confidence', key: 'conf', width: 12, get: (r) => r.confidence },
          { header: 'Quote', key: 'quote', width: 60, get: (r) => r.quote },
        ],
        rows: concalls.allCatalysts().filter((c) => matrix.some((r) => r.ticker === String(c.ticker).toUpperCase())),
      },
      {
        name: 'Guidance changes',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Quarter', key: 'quarter', width: 10, get: (r) => r.quarter },
          { header: 'Metric', key: 'metric', width: 26, get: (r) => r.metric },
          { header: 'Guided', key: 'guided', width: 14, get: (r) => r.guided },
          { header: 'Prior', key: 'prior', width: 14, get: (r) => r.priorGuided ?? '' },
          { header: 'Direction', key: 'dir', width: 13, get: (r) => r.direction },
          { header: 'Supporting quote', key: 'quote', width: 70, get: (r) => r.quote },
        ],
        rows: matrix.flatMap((r) => r.guidance.map((g) => ({ name: r.name, ticker: r.ticker, quarter: r.quarter, ...g }))),
      },
    ],
  });

  if (!ok) {
    const btn = document.querySelector('[data-matrix-export]');
    if (btn) {
      btn.textContent = 'Export unavailable offline';
      btn.disabled = true;
      btn.className = 'flex-shrink-0 rounded-lg bg-slate-200 px-3 py-2 text-xs font-bold text-slate-500';
    }
  }
}
