// concall/deep-dive.js — the Deep Dive panel: trigger a run on the Concall Deep Dive dashboard,
// watch it, and show what it produced.
//
//   openDeepDive(row, opts)   full-screen overlay for one company
//
// THE REPORT IS SOMEBODY ELSE'S ANALYSIS AND THE PANEL NEVER PRETENDS OTHERWISE.
//   Every heading, verdict, number and quote in it comes from the Concall Deep Dive pipeline.
//   This file lays it out; it computes nothing, re-bands nothing, drops nothing and adds no
//   judgement. An "Open on Concall Deep Dive ↗" link sits at the top of every finished report so
//   their own rendering — the canonical one — is always one click away. Same rule as the
//   StockScans scores in the table behind it.
//
//   That includes the QUOTED SPEECH. A finished report carries transcript quotes attributed to
//   named executives and named sell-side analysts. Those are real words from a real call, lifted
//   by their pipeline — the opposite of the synthetic-speech case CLAUDE.md forbids, where the
//   words would have been invented. Nothing here edits, paraphrases or generates any of it, the
//   ribbon above every report says whose extraction it is, and `meta.sources` links the filed
//   transcript so the primary document is one click away. If that ever stopped being true — if a
//   quote could be model-written rather than transcript-lifted — this panel would have to stop
//   rendering quotes, not caveat them.
//
// THE LOADING WINDOW IS THEIR WORDS, NOT OUR GUESS.
//   A run takes minutes. The progress panel prints the `stage` and `message` their pipeline
//   reports on each poll, the elapsed time, and every stage seen so far as a trail. A generic
//   spinner would be inventing reassurance; "extract · pulling the transcript" is what is
//   actually happening.
//
// WHY THE REPORT RENDERER IS SHAPE-DRIVEN AND NOT FIELD-DRIVEN
//   `report.schema.json` lives in that repo, not this one, and the payload is expected to grow.
//   So this renders sections IN THEIR OWN KEY ORDER and decides how to draw each one from its
//   SHAPE — a uniform array of short scalars is a table, an array carrying prose is a stack of
//   cards, a flat object is a definition grid — rather than from a list of field names we would
//   have to keep in sync. A section they add next month arrives laid out, not dropped and not
//   dumped as JSON. `meta` is the one exception: it is provenance, so it gets a purpose-built
//   strip, and even that falls back to the generic path if its shape changes.
//
//   It is also EXTERNAL CONTENT, so every string is escaped and only http(s) links are ever
//   turned into anchors. Nothing from that API reaches the DOM as markup.

import { openWorkspace, closeWorkspace, refreshWorkspace, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import * as api from '../data/deep-dive.js';

// The panel's whole state, kept at module level because the workspace re-renders itself lazily
// and a poll tick has to be able to repaint whatever tab is showing.
let live = null;

/**
 * Open the panel for one call row.
 *
 * `ready` is that company's row from their `/api/summary` index, when they already hold a report
 * for it. That case skips the confirm step and opens the report straight away, because there is
 * nothing to confirm: fetching a finished report is a plain GET and costs nobody anything. Every
 * other row lands on the confirm step, because a dispatch starts a real pipeline run.
 *
 * `onRecorded(slug)` fires the moment a run gets its id, so the table behind can mark the row.
 *
 * NO URL MIRRORING, DELIBERATELY — and this is the one workspace that opts out of the kit's usual
 * `ctx.setParamsQuiet()` contract. Reopening from the URL has to happen after every paint, and the
 * Con-call tab repaints on every live tick; a reopen mid-run would tear down a job that has been
 * going for ten minutes. There is also little to link to: the report's canonical address is on the
 * Deep Dive dashboard itself, and every finished panel carries that link.
 */
export function openDeepDive(row, { onRecorded = null, ready = null } = {}) {
  stop();
  const ticker = row.ticker || null;
  const company = row.name || ticker || '';
  const known = api.remembered(ticker);

  live = {
    ticker,
    company,
    onRecorded,
    ready,
    phase: api.configured() ? 'confirm' : 'connect',
    progress: null,
    trail: [],
    report: null,
    slug: ready?.slug || known?.slug || null,
    partial: false,
    cached: false,
    error: null,
    controller: null,
  };

  openWorkspace({
    title: company,
    subtitle: `${ticker ? `${ticker} · ` : ''}Concall Deep Dive${ready?.quarter ? ` · ${ready.quarter}` : ''}`,
    avatarName: company,
    badges: [
      '<span class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700 ring-1 ring-indigo-200">External analysis</span>',
    ],
    tabs: [{ id: 'run', label: 'Deep Dive', render: renderPanel, wire: wirePanel }],
    activeTab: 'run',
    onClose: () => stop(),
  });

  // Their report is already on file: open it. No dispatch, no confirm, no cost.
  if (ready?.slug && api.configured()) run({ resume: true, slug: ready.slug });
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
  const rerun = !!live.rerun;
  return `
    <div class="mx-auto max-w-2xl px-6 py-10">
      <h3 class="font-display text-lg font-bold text-slate-900">${rerun ? 'Re-run the Deep Dive on' : 'Run a Deep Dive on'} ${escapeHtml(live.company)}</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        This asks the <strong>Concall Deep Dive</strong> dashboard to analyse this company's latest call. The analysis is
        entirely theirs — this page triggers it, shows its progress, and displays what it returns.
      </p>
      <div class="mt-4 rounded-xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">
        <strong>A run costs real compute.</strong> Each dispatch starts an LLM pipeline on their side and takes several
        minutes. A report produced in the last fortnight is reused automatically and costs nothing, which is what
        usually happens on a second click.
        ${rerun ? '<strong> Forcing a fresh run skips that reuse, so this one will cost a full run.</strong>' : ''}
      </div>
      ${
        known?.slug && !rerun
          ? `<p class="mt-3 text-xs text-slate-500">A previous run for this company is on record (<code class="rounded bg-slate-100 px-1">${escapeHtml(known.slug)}</code>). <button data-dd-resume class="font-semibold text-indigo-600 hover:underline">Reattach to it</button> instead of starting a new one.</p>`
          : ''
      }
      <div class="mt-5 flex flex-wrap items-center gap-2">
        <button data-dd-start class="rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-opacity hover:opacity-90">${rerun ? 'Yes, start a fresh run' : 'Start the Deep Dive'}</button>
        <label class="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" data-dd-force class="rounded border-slate-300" ${rerun ? 'checked' : ''} />
          Force a fresh run, ignoring any cached report
        </label>
        ${rerun && live.report ? '<button data-dd-back class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Back to the report</button>' : ''}
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

/**
 * The panel is titled with OUR row's company; the report is titled with THEIRS. Those must agree.
 *
 * A slug is derived on their side, and this dashboard resolves one from a ticker in two places —
 * their summary index and this browser's memory of a dispatch. If either ever pointed at the
 * wrong report, the result would be one company's analysis rendered under another's name, which
 * is the worst thing this panel could do. So it checks, and says so loudly rather than quietly
 * presenting it. Missing identity on their side is not a mismatch — only a contradiction is.
 */
function identityMismatch(report) {
  const theirs = String(report?.meta?.ticker || '').toUpperCase();
  const ours = String(live.ticker || '').toUpperCase();
  if (!theirs || !ours || theirs === ours) return '';
  return `
    <div class="mb-5 rounded-2xl bg-rose-50 p-4 text-xs leading-relaxed text-rose-900 ring-1 ring-rose-200">
      <strong>This report is for a different company.</strong> The row opened was
      <strong>${escapeHtml(live.company)}</strong> (${escapeHtml(ours)}), but Concall Deep Dive returned a report for
      <strong>${escapeHtml(String(report?.meta?.company || theirs))}</strong> (${escapeHtml(theirs)}).
      Read it as that company's, not this one's — and the link above goes to their copy, which is the one to trust.
    </div>`;
}

function reportPanel() {
  const url = api.reportUrl(live.slug);
  const report = live.report;
  return `
    <div class="px-6 py-6">
      ${identityMismatch(report)}
      <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-indigo-50/60 p-4 ring-1 ring-indigo-100">
        <div class="min-w-0 flex-1 text-xs leading-relaxed text-slate-700">
          <strong>This analysis is Concall Deep Dive's, reproduced here unchanged.</strong>
          Nothing on this panel is computed or re-scored by Sattva Central Research.
          ${
            live.ready
              ? `A report they already held${live.ready.generated_at ? `, generated ${escapeHtml(formatRelativeTime(live.ready.generated_at))}` : ''} — opening it started no run.`
              : live.cached
                ? 'Served from their cache rather than a fresh run.'
                : 'Produced by a run started from this page.'
          }
          ${live.partial ? '<span class="text-amber-800"> Some fields were unavailable, so the report is incomplete in places — they flagged it <code class="rounded bg-amber-100 px-1">partial</code>.</span>' : ''}
        </div>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="flex-shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:opacity-90">Open on Concall Deep Dive ↗</a>` : ''}
      </div>
      ${report ? renderReport(report) : '<p class="text-sm text-slate-500">The run finished but returned no report body. Their own page above will have it.</p>'}
      <div class="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <button data-dd-rerun class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">Re-run from scratch…</button>
        <button data-dd-raw class="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50">View raw JSON</button>
        <span class="text-[11px] text-slate-400">Re-running starts a fresh pipeline run and asks first.</span>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// The report renderer — see "shape-driven, not field-driven" in the header
//
// One rule decides everything: WHAT SHAPE IS THIS VALUE?
//
//   short scalar            a figure or a chip
//   long string             a paragraph
//   array of scalars        a bullet list (or chips, when they are all short)
//   array of objects, short a table
//   array of objects, prose a stack of cards, first field as the card's title
//   flat object             a definition grid
//   nested object           labelled blocks, one per key
//
// Nothing keys off a field NAME except `meta` (provenance, so it earns a purpose-built strip)
// and the two presentational hints below. That is what lets a section they add next month
// arrive laid out rather than dumped as JSON.
// ---------------------------------------------------------------------------------------

// Two name-based hints, both cosmetic and both safe if the field disappears:
//   quote — transcript speech, so it reads as speech rather than as another data field
//   *_url / url — an address, so it is clickable
const QUOTE_KEYS = new Set(['quote', 'anchor', 'sample']);
const isUrlKey = (k) => /(^|_)url$/i.test(k);
// The width at which a value stops being a table cell and becomes prose.
const PROSE_AT = 90;

const humanise = (k) =>
  String(k)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b(pct|yoy|qoq|fy\d+[ae]?|pe|ev|ebitda|aum|cmp|roa|qa|rbi|ltv|npa)\b/gi, (m) => m.toUpperCase())
    .replace(/\bcr\b/gi, 'Cr')
    .replace(/^./, (c) => c.toUpperCase());

const isScalar = (v) => v === null || typeof v !== 'object';
const longest = (arr, key) => Math.max(0, ...arr.map((o) => (typeof o?.[key] === 'string' ? o[key].length : 0)));

// A machine timestamp is data; printing it raw is just less readable, not more honest. Formatting
// one is presentation — unlike a number, where re-rendering could change what it claims.
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const stamp = (s) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : `${d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · ${formatRelativeTime(s)}`;
};

const scalarText = (v) =>
  typeof v === 'number'
    ? formatNumber(v, { decimals: Number.isInteger(v) ? 0 : 2 })
    : typeof v === 'boolean'
      ? v
        ? 'Yes'
        : 'No'
      : ISO_AT.test(String(v))
        ? stamp(v)
        : String(v);

/** Only ever produce an anchor for a real http(s) address — this is external content. */
function safeLink(value, label) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return escapeHtml(s);
  return `<a href="${escapeHtml(s)}" target="_blank" rel="noopener noreferrer" class="break-all font-medium text-indigo-600 hover:underline">${escapeHtml(label || s)}</a>`;
}

function renderReport(report) {
  if (!report || typeof report !== 'object') return `<p class="text-sm text-slate-700">${escapeHtml(String(report ?? ''))}</p>`;
  // THEIR key order, not ours. It is deliberate on their side and it reads well; reordering it
  // here would be this dashboard editing their report, and would silently misfile a new section.
  return Object.entries(report)
    .map(([key, value]) => {
      if (key === 'meta') return metaStrip(value);
      const body = renderValue(value, 0, key);
      if (!body) return '';
      return `<section class="mb-7">
        <h3 class="font-display mb-2.5 border-b border-slate-100 pb-1.5 text-sm font-bold uppercase tracking-wider text-indigo-700">${escapeHtml(humanise(key))}</h3>
        ${body}
      </section>`;
    })
    .join('');
}

/**
 * `meta` is the report's provenance: who it is about, when it was generated, what it was priced
 * off, and — the part that matters most — a link to the filed transcript the whole thing was
 * read from. That is the primary document, so it gets a real link rather than a table cell.
 * Anything unexpected in `meta` falls through to the generic renderer.
 */
function metaStrip(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return renderValue(meta, 0, 'meta');
  const { sources, inputs, company, ticker, slug, ...rest } = meta;
  const facts = Object.entries(rest).filter(([, v]) => v != null && v !== '' && isScalar(v));
  const links = [
    ['Filed transcript', sources?.transcript_url],
    ['Investor presentation', sources?.ppt_url],
  ].filter(([, u]) => typeof u === 'string' && /^https?:\/\//i.test(u));

  return `
    <section class="mb-7 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div class="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Report provenance · Concall Deep Dive</div>
      <div class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-slate-600">
        ${facts.map(([k, v]) => `<span><span class="text-slate-400">${escapeHtml(humanise(k))}</span> <span class="font-semibold text-slate-800">${escapeHtml(scalarText(v))}</span></span>`).join('')}
        ${sources?.concall_date ? `<span><span class="text-slate-400">Call date</span> <span class="font-semibold text-slate-800">${escapeHtml(String(sources.concall_date))}</span></span>` : ''}
      </div>
      ${
        links.length
          ? `<div class="mt-2.5 flex flex-wrap gap-3 text-xs">${links.map(([label, u]) => `<span>↗ ${safeLink(u, label)}</span>`).join('')}</div>
             <p class="mt-1.5 text-[11px] leading-relaxed text-slate-400">The filings above are the primary source. Everything below is Concall Deep Dive's reading of them.</p>`
          : ''
      }
      ${inputs && typeof inputs === 'object' ? `<div class="mt-3 border-t border-slate-200 pt-2"><div class="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Priced off</div>${renderValue(inputs, 2, 'inputs')}</div>` : ''}
    </section>`;
}

/**
 * Render an arbitrary JSON value by its shape.
 *
 * `depth` keeps nesting from running away; `key` is used only for the two cosmetic hints above.
 * Every string is escaped — this is another service's output.
 */
function renderValue(v, depth, key = '') {
  if (v == null || v === '') return '';

  if (typeof v === 'boolean') return `<p class="text-sm text-slate-700">${v ? 'Yes' : 'No'}</p>`;
  if (typeof v === 'number') return `<p class="text-sm font-semibold tabular-nums text-slate-900">${escapeHtml(scalarText(v))}</p>`;

  if (typeof v === 'string') {
    if (isUrlKey(key)) return `<p class="text-sm">${safeLink(v)}</p>`;
    if (QUOTE_KEYS.has(key)) return quoteBlock(v);
    // Paragraph breaks preserved; nothing else about the string is interpreted.
    return v
      .split(/\n{2,}/)
      .map((para) => `<p class="mb-2 text-sm leading-relaxed text-slate-700">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  if (Array.isArray(v)) {
    if (!v.length) return '';

    // All scalars: short ones read as chips, longer ones as a bullet list.
    if (v.every(isScalar)) {
      const max = Math.max(...v.map((x) => String(x ?? '').length));
      if (max <= 28) {
        return `<div class="flex flex-wrap gap-1.5">${v
          .map((x) => `<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">${escapeHtml(scalarText(x))}</span>`)
          .join('')}</div>`;
      }
      return `<ul class="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700">${v.map((x) => `<li>${escapeHtml(scalarText(x))}</li>`).join('')}</ul>`;
    }

    const objects = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (objects.length === v.length) {
      const cols = [...new Set(v.flatMap((o) => Object.keys(o)))];
      const flat = v.every((o) => Object.values(o).every(isScalar));
      const wide = cols.some((c) => longest(v, c) > PROSE_AT);
      // A table only where every cell is a short scalar. One 400-character "evidence" field turns
      // a table into an unreadable wall, and that is exactly what these reports carry.
      if (flat && !wide && cols.length <= 8 && depth < 3) return objectTable(v, cols);
      return v.map((item) => itemCard(item, depth)).join('');
    }
    // Mixed bag — render each element on its own terms.
    return v.map((x) => `<div class="mb-3">${renderValue(x, depth + 1)}</div>`).join('');
  }

  // Plain object.
  const entries = Object.entries(v).filter(([, val]) => val != null && val !== '' && !(Array.isArray(val) && !val.length));
  if (!entries.length) return '';
  if (entries.every(([, val]) => isScalar(val))) return definitionGrid(entries);
  return entries
    .map(([k, val]) => {
      const body = renderValue(val, depth + 1, k);
      return body
        ? `<div class="mb-4">
             <div class="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">${escapeHtml(humanise(k))}</div>
             ${body}
           </div>`
        : '';
    })
    .join('');
}

/** Speech from the call, set as speech. */
const quoteBlock = (s) =>
  `<blockquote class="border-l-2 border-indigo-200 pl-3 text-sm italic leading-relaxed text-slate-600">${escapeHtml(String(s))}</blockquote>`;

/**
 * One chip on a card's title line.
 *
 * A bare figure needs its field name and a word does not: "+38%" is meaningless without knowing
 * it is the YoY delta, while "FY27", "hard" and "Transcript" say what they are. So the label is
 * printed only for values that are purely numeric — otherwise the chips stay clean.
 */
const BARE_NUMBER = /^[+\-−]?[\d.,]+\s*%?$/;
const chip = (k, val) => {
  const text = scalarText(val);
  const labelled = BARE_NUMBER.test(text);
  return `<span class="inline-flex items-baseline gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600" title="${escapeHtml(humanise(k))}">${
    labelled ? `<span class="font-medium text-slate-400">${escapeHtml(humanise(k))}</span>` : ''
  }${escapeHtml(text)}</span>`;
};

function objectTable(rows, cols) {
  return `<div class="overflow-x-auto rounded-xl ring-1 ring-slate-200">
    <table class="w-full text-sm"><thead class="bg-slate-50"><tr>
      ${cols
        .map(
          (c, i) =>
            `<th scope="col" class="whitespace-nowrap px-3 py-2 text-xs font-bold uppercase tracking-wider text-slate-600 ${i && typeof rows[0][c] === 'number' ? 'text-right' : 'text-left'}">${escapeHtml(humanise(c))}</th>`
        )
        .join('')}
    </tr></thead><tbody>
      ${rows
        .map(
          (row) => `<tr class="border-t border-slate-100">${cols
            .map((c, i) => {
              const cell = row[c];
              const num = typeof cell === 'number';
              const body =
                cell == null || cell === ''
                  ? '<span class="text-slate-300">—</span>'
                  : isUrlKey(c)
                    ? safeLink(cell, 'link')
                    : escapeHtml(scalarText(cell));
              return `<td class="px-3 py-2 align-top ${num ? 'tabular-nums' : ''} ${i && num ? 'text-right' : 'text-left'} ${i === 0 ? 'font-semibold text-slate-900' : 'text-slate-700'}">${body}</td>`;
            })
            .join('')}</tr>`
        )
        .join('')}
    </tbody></table>
  </div>`;
}

/**
 * One element of an array of objects, as a card.
 *
 * The FIRST key is the title — their key order puts the identifying field first in every section
 * of a real report (`theme`, `risk`, `catalyst`, `metric`, `trigger`, `analyst`), so this needs no
 * list of field names. Short scalars become chips on the title line; prose and quotes stack below.
 */
function itemCard(item, depth) {
  const entries = Object.entries(item).filter(([, val]) => val != null && val !== '' && !(Array.isArray(val) && !val.length));
  if (!entries.length) return '';
  const [titleKey, titleValue] = entries[0];
  const rest = entries.slice(1);
  const chips = rest.filter(([k, val]) => isScalar(val) && !QUOTE_KEYS.has(k) && !isUrlKey(k) && String(val).length <= 28);
  const blocks = rest.filter((e) => !chips.includes(e));

  return `
    <div class="mb-2.5 rounded-xl bg-white p-3.5 ring-1 ring-slate-200">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span class="text-sm font-bold text-slate-900">${isScalar(titleValue) ? escapeHtml(scalarText(titleValue)) : escapeHtml(humanise(titleKey))}</span>
        ${chips.map(([k, val]) => chip(k, val)).join('')}
      </div>
      ${!isScalar(titleValue) ? renderValue(titleValue, depth + 1, titleKey) : ''}
      ${blocks
        .map(([k, val]) => {
          const body = renderValue(val, depth + 1, k);
          if (!body) return '';
          // A quote carries its own visual voice, so it needs no label above it.
          if (QUOTE_KEYS.has(k)) return `<div class="mt-2">${body}</div>`;
          return `<div class="mt-2">
            <div class="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(humanise(k))}</div>
            ${body}
          </div>`;
        })
        .join('')}
    </div>`;
}

function definitionGrid(entries) {
  return `<dl class="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
    ${entries
      .map(
        ([k, val]) => `<div class="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1">
          <dt class="text-xs text-slate-500">${escapeHtml(humanise(k))}</dt>
          <dd class="text-right text-sm font-semibold text-slate-900 ${typeof val === 'number' ? 'tabular-nums' : ''}">${isUrlKey(k) ? safeLink(val, 'link') : escapeHtml(scalarText(val))}</dd>
        </div>`
      )
      .join('')}
  </dl>`;
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
  // "Re-run" goes BACK TO THE CONFIRM STEP rather than dispatching. It is the one control on a
  // finished report that spends money, and a single stray click on it should not be able to.
  on('[data-dd-rerun]', () => {
    live.phase = 'confirm';
    live.rerun = true;
    refreshWorkspace();
  });
  on('[data-dd-resume]', () => run({ resume: true }));
  on('[data-dd-back]', () => {
    live.rerun = false;
    live.phase = 'done';
    refreshWorkspace();
  });
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

async function run({ force = false, resume = false, slug = null } = {}) {
  if (!live) return;
  const controller = new AbortController();
  live.controller?.abort();
  live.controller = controller;
  live.phase = 'running';
  live.error = null;
  live.trail = [];
  live.progress = {
    status: resume ? 'running' : 'dispatching',
    message: resume
      ? live.ready?.slug === slug
        ? 'Fetching the report they already hold…'
        : 'Reattaching to the run already on record…'
      : 'Asking the Deep Dive dashboard to start…',
    elapsedMs: 0,
  };
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
    // Resume takes the slug it was handed, or the one this browser remembers. Either way it only
    // ever polls — `api.start` is the single path in this file that can dispatch a run.
    const resumeSlug = slug || api.remembered(live.ticker)?.slug;
    const out =
      resume && resumeSlug
        ? await api.resume(resumeSlug, { onProgress, signal: controller.signal })
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
