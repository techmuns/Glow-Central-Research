// concall/deep-dive.js — the Deep Dive panel: trigger a run on the Concall Deep Dive dashboard,
// watch it, and show what it produced.
//
//   openDeepDive(row, ctx)   full-screen overlay for one company
//
// THE REPORT IS SOMEBODY ELSE'S ANALYSIS AND THE PANEL NEVER PRETENDS OTHERWISE.
//   Every heading, verdict and number in it comes from the Concall Deep Dive pipeline. This file
//   lays it out; it computes nothing, re-bands nothing and adds no judgement. A "Open on Concall
//   Deep Dive ↗" link sits at the top of every finished report so their own rendering — the
//   canonical one — is always one click away. Same rule as the StockScans scores.
//
// THE LOADING WINDOW IS THEIR WORDS, NOT OUR GUESS.
//   A run takes minutes. The progress panel prints the `stage` and `message` their pipeline
//   reports on each poll, the elapsed time, and every stage seen so far as a trail. A generic
//   spinner would be inventing reassurance; "extract · pulling the transcript" is what is
//   actually happening.
//
// WHY THE REPORT RENDERER IS DEFENSIVE
//   `report.schema.json` lives in that repo, not this one, and the payload is expected to grow.
//   So nothing here indexes a field it has not checked for: known sections get a proper heading
//   in a sensible order, and anything unrecognised is still rendered by a generic walker rather
//   than dropped on the floor. A field they add next month shows up without a change here.
//
//   It is also EXTERNAL CONTENT, so every string is escaped. Nothing from that API reaches the
//   DOM as markup.

import { openWorkspace, closeWorkspace, refreshWorkspace, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';
import * as api from '../data/deep-dive.js';

// The panel's whole state, kept at module level because the workspace re-renders itself lazily
// and a poll tick has to be able to repaint whatever tab is showing.
let live = null;

/**
 * Open the panel for one call row.
 *
 * Nothing is dispatched on open. The reader lands on a confirm step, because a dispatch costs a
 * real pipeline run on an unauthenticated endpoint — see the header of js/data/deep-dive.js.
 *
 * `onRecorded(slug)` fires the moment the run gets its id, so the table behind can mark the row.
 *
 * NO URL MIRRORING, DELIBERATELY — and this is the one workspace that opts out of the kit's usual
 * `ctx.setParamsQuiet()` contract. Reopening from the URL has to happen after every paint, and the
 * Con-call tab repaints on every live tick; a reopen mid-run would tear down a job that has been
 * going for ten minutes. There is also little to link to: the report's canonical address is on the
 * Deep Dive dashboard itself, and every finished panel carries that link.
 */
export function openDeepDive(row, { onRecorded = null } = {}) {
  stop();
  const ticker = row.ticker || null;
  const company = row.name || ticker || '';
  const known = api.remembered(ticker);

  live = {
    ticker,
    company,
    onRecorded,
    phase: api.configured() ? 'confirm' : 'connect',
    progress: null,
    trail: [],
    report: null,
    slug: known?.slug || null,
    partial: false,
    cached: false,
    error: null,
    controller: null,
  };

  openWorkspace({
    title: company,
    subtitle: `${ticker ? `${ticker} · ` : ''}Concall Deep Dive`,
    avatarName: company,
    badges: [
      '<span class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">External analysis</span>',
    ],
    tabs: [{ id: 'run', label: 'Deep Dive', render: renderPanel, wire: wirePanel }],
    activeTab: 'run',
    onClose: () => stop(),
  });
}

/**
 * Stop polling and drop the state. The run itself continues on their side.
 *
 * Exported because the shell closes overlays on every route change with `{ silent: true }`, which
 * skips `onClose` — without this the poller would outlive the panel it repaints, ticking against
 * a workspace that is no longer on screen for the rest of the session.
 */
export function stopDeepDive() {
  if (!live) return;
  live.controller?.abort();
  live = null;
}

const stop = stopDeepDive;

// ---------------------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------------------

function renderPanel() {
  if (!live) return '';
  switch (live.phase) {
    case 'connect':
      return connectPanel();
    case 'confirm':
      return confirmPanel();
    case 'running':
      return runningPanel();
    case 'error':
      return errorPanel();
    case 'done':
      return reportPanel();
    default:
      return '';
  }
}

function connectPanel() {
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">Connect the Deep Dive dashboard</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        Concall Deep Dive runs on its own Cloudflare Worker, and its URL is assigned per deployment — nobody in this
        repo can know it, so it is not committed here. Paste it once and it is remembered in this browser.
      </p>
      <label class="mt-5 block text-xs font-bold uppercase tracking-wider text-slate-500" for="dd-base">Dashboard URL</label>
      <input id="dd-base" type="url" spellcheck="false" placeholder="https://concall-sattva.your-subdomain.workers.dev"
        class="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:border-indigo-400 focus:outline-none" />
      <p data-dd-connect-error class="mt-2 hidden text-xs text-rose-700"></p>
      <div class="mt-4 flex flex-wrap gap-2">
        <button data-dd-save class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white transition-opacity hover:opacity-90">Save and continue</button>
        <button data-dd-cancel class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Cancel</button>
      </div>
      <p class="mt-6 text-xs leading-relaxed text-slate-500">
        To set it for everyone instead of just this browser, add
        <code class="rounded bg-slate-100 px-1">window.SATTVA_DEEPDIVE_URL = '…'</code> in
        <code class="rounded bg-slate-100 px-1">public/index.html</code>.
      </p>
    </div>`;
}

function confirmPanel() {
  const known = api.remembered(live.ticker);
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">Run a Deep Dive on ${escapeHtml(live.company)}</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        This asks the <strong>Concall Deep Dive</strong> dashboard to analyse this company's latest call. The analysis is
        entirely theirs — this page triggers it, shows its progress, and displays what it returns.
      </p>
      <div class="mt-4 rounded-xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
        <strong>A run costs real compute.</strong> Each dispatch starts an LLM pipeline on their side and takes several
        minutes. A report produced in the last fortnight is reused automatically and costs nothing, which is what
        usually happens on a second click.
      </div>
      ${
        known?.slug
          ? `<p class="mt-3 text-xs text-slate-500">A previous run for this company is on record (<code class="rounded bg-slate-100 px-1">${escapeHtml(known.slug)}</code>). <button data-dd-resume class="font-semibold text-indigo-600 hover:underline">Reattach to it</button> instead of starting a new one.</p>`
          : ''
      }
      <div class="mt-5 flex flex-wrap items-center gap-2">
        <button data-dd-start class="rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90">Start the Deep Dive</button>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" data-dd-force class="rounded border-slate-300" />
          Force a fresh run, ignoring any cached report
        </label>
      </div>
      <p class="mt-6 text-xs text-slate-500">Connected to <code class="rounded bg-slate-100 px-1">${escapeHtml(api.baseUrl())}</code> · <button data-dd-reconnect class="font-semibold text-indigo-600 hover:underline">change</button></p>
    </div>`;
}

/** The loading window: their stage and message, the trail of stages, and the clock. */
function runningPanel() {
  const p = live.progress || {};
  const mins = Math.floor((p.elapsedMs || 0) / 60000);
  const secs = Math.floor(((p.elapsedMs || 0) % 60000) / 1000);
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <div class="flex items-center gap-3">
        <span class="relative flex h-3 w-3">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75"></span>
          <span class="relative inline-flex h-3 w-3 rounded-full bg-indigo-600"></span>
        </span>
        <h3 class="font-display text-lg font-bold text-slate-900">Analysing ${escapeHtml(live.company)}</h3>
      </div>

      <div class="mt-5 rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(p.stage || p.status || 'starting')}</span>
          <span class="text-xs tabular-nums text-slate-500">${mins}m ${String(secs).padStart(2, '0')}s elapsed</span>
        </div>
        <p class="mt-1 text-sm text-slate-700">${escapeHtml(p.message || 'Waiting for the pipeline to report in…')}</p>
        ${p.transientError ? '<p class="mt-2 text-xs text-amber-700">Connection blipped — still polling; the run is unaffected.</p>' : ''}
      </div>

      ${
        live.trail.length > 1
          ? `<div class="mt-4">
               <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Stages so far</div>
               <ol class="space-y-1">
                 ${live.trail
                   .map(
                     (t, i) => `<li class="flex items-baseline gap-2 text-xs ${i === live.trail.length - 1 ? 'text-slate-900' : 'text-slate-500'}">
                       <span class="w-14 flex-shrink-0 tabular-nums">${escapeHtml(t.at)}</span>
                       <span class="font-semibold">${escapeHtml(t.stage)}</span>
                       ${t.message ? `<span class="min-w-0 flex-1 truncate">${escapeHtml(t.message)}</span>` : ''}
                     </li>`
                   )
                   .join('')}
               </ol>
             </div>`
          : ''
      }

      <p class="mt-5 text-xs leading-relaxed text-slate-500">
        A full run usually takes several minutes and their pipeline gives up after about twenty.
        Closing this panel does not cancel the run — reopening reattaches to it${live.slug ? `, and it is on record as <code class="rounded bg-slate-100 px-1">${escapeHtml(live.slug)}</code>` : ''}.
      </p>
      <button data-dd-close class="mt-4 rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Leave it running</button>
    </div>`;
}

function errorPanel() {
  const url = api.reportUrl(live.slug);
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">The Deep Dive did not finish</h3>
      <div class="mt-3 rounded-xl bg-rose-50 p-4 text-sm leading-relaxed text-rose-900 ring-1 ring-rose-200">${escapeHtml(live.error || 'Unknown error.')}</div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button data-dd-start class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:opacity-90">Try again</button>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="rounded-lg px-4 py-2 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50">Open on Concall Deep Dive ↗</a>` : ''}
        <button data-dd-reconnect class="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Change dashboard URL</button>
      </div>
    </div>`;
}

function reportPanel() {
  const url = api.reportUrl(live.slug);
  const report = live.report;
  return `
    <div class="px-6 py-6">
      <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100">
        <div class="min-w-0 flex-1 text-xs leading-relaxed text-slate-700">
          <strong>This analysis is Concall Deep Dive's, reproduced here unchanged.</strong>
          Nothing on this panel is computed or re-scored by Sattva Central Research.
          ${live.cached ? 'Served from their cache rather than a fresh run.' : 'Produced by a run started from this page.'}
          ${live.partial ? '<span class="text-amber-800"> Some fields were unavailable, so the report is incomplete in places — they flagged it <code class="rounded bg-amber-100 px-1">partial</code>.</span>' : ''}
        </div>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="flex-shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90">Open on Concall Deep Dive ↗</a>` : ''}
      </div>
      ${report ? renderReport(report) : '<p class="text-sm text-slate-500">The run finished but returned no report body. Their own page above will have it.</p>'}
      <div class="mt-6 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <button data-dd-force-run class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Re-run from scratch</button>
        <button data-dd-raw class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">View raw JSON</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// The report renderer — see "why it is defensive" in the header
// ---------------------------------------------------------------------------------------

// Sections we know the names of, in the order their doc lists them. Anything not here still
// renders, after these, under its own humanised heading.
const KNOWN_ORDER = ['meta', 'verdict', 'key_takeaways', 'thesis', 'financials', 'valuation', 'risks', 'catalysts', 'guidance', 'management', 'sources'];

const humanise = (k) =>
  String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());

function renderReport(report) {
  if (typeof report !== 'object' || report === null) return `<p class="text-sm text-slate-700">${escapeHtml(String(report))}</p>`;
  const keys = Object.keys(report);
  const ordered = [...KNOWN_ORDER.filter((k) => keys.includes(k)), ...keys.filter((k) => !KNOWN_ORDER.includes(k))];
  return ordered
    .map((k) => {
      const body = renderValue(report[k], 0);
      if (!body) return '';
      return `<section class="mb-6">
        <h3 class="font-display mb-2 text-sm font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(humanise(k))}</h3>
        ${body}
      </section>`;
    })
    .join('');
}

/**
 * Render an arbitrary JSON value.
 *
 * Depth-limited, because a deeply nested payload should degrade to readable JSON rather than a
 * hundred nested cards. Every string is escaped — this is another service's output.
 */
function renderValue(v, depth) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return `<p class="text-sm text-slate-700">${v ? 'Yes' : 'No'}</p>`;
  if (typeof v === 'number') return `<p class="text-sm tabular-nums text-slate-800">${escapeHtml(formatNumber(v))}</p>`;
  if (typeof v === 'string') {
    // Paragraph breaks preserved; nothing else about the string is interpreted.
    return v
      .split(/\n{2,}/)
      .map((para) => `<p class="mb-2 text-sm leading-relaxed text-slate-700">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  if (Array.isArray(v)) {
    if (!v.length) return '';
    if (v.every((x) => typeof x !== 'object' || x === null)) {
      return `<ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">${v.map((x) => `<li>${escapeHtml(String(x))}</li>`).join('')}</ul>`;
    }
    // Uniform array of flat objects reads best as a table.
    const cols = uniformColumns(v);
    if (cols && depth < 3) {
      return `<div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
        <table class="w-full text-sm"><thead class="bg-slate-50"><tr>
          ${cols.map((c) => `<th scope="col" class="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider text-slate-600">${escapeHtml(humanise(c))}</th>`).join('')}
        </tr></thead><tbody>
          ${v
            .map(
              (rowObj) => `<tr class="border-t border-slate-100">${cols
                .map((c) => `<td class="px-3 py-2 align-top text-slate-700 ${typeof rowObj[c] === 'number' ? 'tabular-nums' : ''}">${rowObj[c] == null || rowObj[c] === '' ? '<span class="text-slate-300">—</span>' : escapeHtml(typeof rowObj[c] === 'number' ? formatNumber(rowObj[c]) : String(rowObj[c]))}</td>`)
                .join('')}</tr>`
            )
            .join('')}
        </tbody></table>
      </div>`;
    }
    return v.map((x) => `<div class="mb-3 rounded-xl bg-white p-3 ring-1 ring-slate-100">${renderValue(x, depth + 1)}</div>`).join('');
  }

  // Plain object.
  if (depth >= 3) return `<pre class="overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
  const entries = Object.entries(v).filter(([, val]) => val != null && val !== '');
  if (!entries.length) return '';
  // Flat object of scalars -> a definition grid. Anything richer -> nested sections.
  if (entries.every(([, val]) => typeof val !== 'object' || val === null)) {
    return `<dl class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      ${entries
        .map(
          ([k, val]) => `<div class="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1">
            <dt class="text-xs font-medium text-slate-500">${escapeHtml(humanise(k))}</dt>
            <dd class="text-sm font-semibold text-slate-900 ${typeof val === 'number' ? 'tabular-nums' : ''}">${escapeHtml(typeof val === 'number' ? formatNumber(val) : String(val))}</dd>
          </div>`
        )
        .join('')}
    </dl>`;
  }
  return entries
    .map(([k, val]) => {
      const body = renderValue(val, depth + 1);
      return body ? `<div class="mb-4"><div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">${escapeHtml(humanise(k))}</div>${body}</div>` : '';
    })
    .join('');
}

/** Column set for an array of flat objects, or null if they are not uniform enough for a table. */
function uniformColumns(arr) {
  const keys = [...new Set(arr.flatMap((o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : [null])))];
  if (keys.includes(null) || !keys.length || keys.length > 6) return null;
  const flat = arr.every((o) => Object.values(o).every((val) => typeof val !== 'object' || val === null));
  return flat ? keys : null;
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

function wirePanel(panel) {
  if (!live) return;
  const on = (sel, fn) => panel.querySelector(sel)?.addEventListener('click', fn);

  on('[data-dd-cancel]', () => closeWorkspace());
  on('[data-dd-close]', () => closeWorkspace());
  on('[data-dd-reconnect]', () => {
    live.phase = 'connect';
    refreshWorkspace();
  });
  on('[data-dd-start]', () => run({ force: !!panel.querySelector('[data-dd-force]')?.checked }));
  on('[data-dd-force-run]', () => run({ force: true }));
  on('[data-dd-resume]', () => run({ resume: true }));
  on('[data-dd-raw]', () =>
    openModal(
      `<div class="px-6 py-5">
         <div class="mb-3 flex items-start justify-between gap-4">
           <h2 class="font-display text-lg font-bold text-slate-900">Report as returned</h2>
           <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
         </div>
         <pre class="scrollbar-thin max-h-[60vh] overflow-auto rounded-xl bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">${escapeHtml(JSON.stringify(live.report, null, 2))}</pre>
       </div>`,
      { size: 'wide' }
    )
  );

  const save = panel.querySelector('[data-dd-save]');
  if (save) {
    const input = panel.querySelector('#dd-base');
    const err = panel.querySelector('[data-dd-connect-error]');
    input?.focus();
    const commit = () => {
      const url = api.setBaseUrl(input.value);
      if (!url) {
        err.textContent = 'Enter the dashboard URL, for example https://concall-sattva.your-subdomain.workers.dev';
        err.classList.remove('hidden');
        return;
      }
      live.phase = 'confirm';
      refreshWorkspace();
    };
    save.addEventListener('click', commit);
    input?.addEventListener('keydown', (e) => e.key === 'Enter' && commit());
  }
}

async function run({ force = false, resume = false } = {}) {
  if (!live) return;
  const controller = new AbortController();
  live.controller?.abort();
  live.controller = controller;
  live.phase = 'running';
  live.error = null;
  live.trail = [];
  live.progress = { status: resume ? 'running' : 'dispatching', message: resume ? 'Reattaching to the run already on record…' : 'Asking the Deep Dive dashboard to start…', elapsedMs: 0 };
  refreshWorkspace();

  const onProgress = (p) => {
    if (!live || live.controller !== controller) return;
    live.progress = p;
    if (p.slug && p.slug !== live.slug) {
      live.slug = p.slug;
      // The table behind this panel marks companies with a run on record, and it only repaints on
      // a live tick. Tell it now so the mark appears with the run rather than a minute later.
      live.onRecorded?.(p.slug);
    }
    const stage = p.stage || p.status;
    const last = live.trail[live.trail.length - 1];
    // One entry per stage change, not per tick — a trail of forty identical lines is noise.
    if (stage && (!last || last.stage !== stage)) {
      live.trail.push({ stage, message: p.message || null, at: clock(p.elapsedMs) });
    } else if (last && p.message && last.message !== p.message) {
      last.message = p.message;
    }
    refreshWorkspace();
  };

  try {
    const known = api.remembered(live.ticker);
    const out =
      resume && known?.slug
        ? await api.resume(known.slug, { onProgress, signal: controller.signal })
        : await api.start({ company: live.company, ticker: live.ticker, force }, { onProgress, signal: controller.signal });
    if (!live || live.controller !== controller) return;
    live.report = out.report;
    live.slug = out.slug;
    live.partial = out.partial;
    live.cached = out.cached;
    live.phase = 'done';
  } catch (err) {
    if (err?.name === 'AbortError') return; // the reader closed the panel; the run continues
    if (!live || live.controller !== controller) return;
    live.error = String(err.message || err);
    live.phase = 'error';
  }
  refreshWorkspace();
}

const clock = (ms) => {
  const total = Math.floor((ms || 0) / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
};
