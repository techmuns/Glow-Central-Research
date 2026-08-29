// tabs/market-news-view.js — the Universe half of the News tab: market-wide stocks news.
//
// ONE TAB, TWO QUESTIONS, AND THE SCOPE TOGGLE PICKS WHICH.
//   Portfolio scope asks "what has been written about each of these companies" — a search, one
//   request per company, which is why it makes the reader name them. Universe scope asks the other
//   question, "what has been published", because 603 searches is ten minutes of somebody else's
//   service. They are different feeds from different publishers answering different questions, and
//   the description on each says which — a reader must never have to guess why the same tab shows
//   unrelated rows under two scopes.
//
// WHAT THE REFRESH CONTROL MAY CLAIM.
//   Neither the browser nor the Worker can read Moneycontrol — both get a 403 from TLS
//   fingerprinting, measured (see js/data/market-news.js). A scheduled Action reads it and commits
//   the capture. So this button asks whether a NEWER CAPTURE exists; it cannot and does not fetch
//   the publisher. It says so in those words, and the two times are printed separately:
//
//     "Moneycontrol last read"  the capture's own time — how fresh the NEWS is
//     "checked"                 when this browser last confirmed it has the newest capture
//
//   A twenty-minute-old capture confirmed one second ago is fresh in one sense and not the other,
//   and one combined "updated just now" would let the second stand in for the first.
//
// NO SCORE, NO SENTIMENT, NO RANKING. The order is the publisher's own, by their article id.
// Headlines and standfirsts are theirs, reproduced; the article stays on their site.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as marketNews from '../data/market-news.js';

let unsub = null;
let disposers = [];
let ctxRef = null;
let view = null;
let busy = false;
let lastResult = null;

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

/** IST, because the market and the publisher are both there and the reader almost certainly is. */
function istTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function pill(m) {
  const captured = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : null;
  const label = m.reason ? 'No capture' : `Captured ${captured || 'unknown'}`;
  const tone = m.reason ? 'bg-amber-50 text-amber-800 ring-amber-200' : 'bg-sky-50 text-sky-700 ring-sky-200';
  return `<button type="button" data-mcnews-info
      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tone} transition hover:brightness-95">
      <span class="h-1.5 w-1.5 rounded-full ${m.reason ? 'bg-amber-500' : 'bg-sky-500'}"></span>
      ${escapeHtml(label)}
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.count))} stories</span>
    </button>`;
}

/**
 * The freshness line and the button.
 *
 * A row of its own under the heading, never the `meta` slot — the text changes as the capture ages
 * and as the button reports, and a control that moves when you use it reads as a different page.
 */
function controls(m) {
  const captured = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : 'never';
  const checked = m.checkedAt ? formatRelativeTime(m.checkedAt) : 'not yet';
  const result = lastResult
    ? `<span class="ml-2 font-semibold ${lastResult.added ? 'text-emerald-700' : 'text-slate-500'}">${escapeHtml(lastResult.text)}</span>`
    : '';
  return `
    <div class="flex w-full flex-wrap items-center gap-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100">
      <button type="button" data-mcnews-refresh ${busy ? 'disabled' : ''}
        class="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
        <span>${busy ? '…' : '⟳'}</span><span>${busy ? 'Checking' : 'Check for new stories'}</span>
      </button>
      <p class="text-xs leading-relaxed text-slate-500">
        <strong class="text-slate-700">Moneycontrol last read ${escapeHtml(captured)}</strong>
        · this page checked for a newer capture ${escapeHtml(checked)}.
        Refreshed automatically every 20 minutes.${result}
      </p>
    </div>`;
}

function panel(m, rows) {
  const table = scoreTable({
    rows,
    // The publisher's own article id. Never a position — this table grows while the reader is on
    // it, and an index-derived key would reassign cached markup to a different story.
    key: (r) => String(r.id || r.url),
    name: (r) => r.title || '(untitled)',
    nameLabel: 'Headline',
    sub: (r) => [r.section ? r.section.replace(/-/g, ' ') : null, r.premium ? 'premium' : null].filter(Boolean).join(' · '),
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 820,
    stickyHead: 'max(320px, calc(100vh - 320px))',
    columns: [
      {
        label: 'Published (IST)',
        get: (r) => {
          const t = istTime(r.publishedAt);
          if (t) return `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(t)}</span>`;
          // NOT `firstSeenAt` dressed as a publish time. The listing page carries no date, and this
          // story's own page was not read for one, so the publisher's time is simply unknown.
          return dash('Moneycontrol’s listing page carries no time, and this story’s own page was not read for one. It is not the time we saw it.');
        },
        html: true,
        // Nulls sort last in both directions: the id keeps them in publication order regardless.
        sortValue: (r) => r.publishedAt || '',
      },
      {
        label: 'Section',
        get: (r) => (r.section ? `<span class="text-slate-600">${escapeHtml(r.section.replace(/-/g, ' '))}</span>` : dash('the URL carried no section')),
        html: true,
        sortValue: (r) => r.section || '',
      },
    ],
    filters: (() => {
      const sections = [...new Set(rows.map((r) => r.section).filter(Boolean))].sort();
      return sections.length > 1
        ? [
            {
              label: 'Section',
              options: [{ value: 'all', label: 'All sections' }, ...sections.map((sx) => ({ value: sx, label: sx.replace(/-/g, ' ') }))],
              match: (r, v) => r.section === v,
            },
          ]
        : null;
    })(),
    searchable: (r) => `${r.title || ''} ${r.summary || ''} ${r.section || ''}`,
    link: (r) => r.url || null,
    initialSort: { key: 'Published (IST)', dir: 'desc' },
    initialView: view,
    exportName: 'sattva-market-news',
    onExport: (visible) => exportVisible(visible, m),
    emptyMessage: 'No story matches your filters.',
  });
  view = table.view;
  return table;
}

async function exportVisible(visible, m) {
  await exportRows({
    filename: 'sattva-market-news',
    sheetName: 'Market news',
    columns: [
      {
        header: 'Published (IST)',
        key: 'd',
        width: 18,
        get: (r) =>
          r.__banner
            ? `REAL REPORTING, NOT OURS. Market-wide stocks news as published by Moneycontrol at /news/business/stocks/, ` +
              `captured ${m.capturedAt || 'unknown'}, exported ${new Date().toISOString()}. ` +
              `HEADLINES, STANDFIRSTS AND SECTIONS ARE THE PUBLISHER'S, reproduced unchanged — nothing here is summarised, scored, ranked or judged, and the order is their own. ` +
              `A BLANK TIME MEANS THE PUBLISHER'S TIME WAS NOT READ: their listing page carries no date, so it is fetched per story and is budgeted. It is never the time this dashboard saw the story. ` +
              `${m.withPublishedAt} of ${m.count} stories carry the publisher's time.`
            : istTime(r.publishedAt) || '',
      },
      { header: 'Headline', key: 'h', width: 80, get: (r) => (r.__banner ? '' : r.title || '') },
      { header: 'Section', key: 's', width: 20, get: (r) => (r.__banner ? '' : r.section || '') },
      { header: 'Standfirst (publisher)', key: 'p', width: 80, get: (r) => (r.__banner ? '' : r.summary || '') },
      { header: 'Premium', key: 'x', width: 10, get: (r) => (r.__banner ? '' : r.premium ? 'yes' : '') },
      { header: 'URL', key: 'u', width: 70, get: (r) => (r.__banner ? '' : r.url || '') },
      { header: 'First seen by this dashboard', key: 'f', width: 26, get: (r) => (r.__banner ? '' : r.firstSeenAt || '') },
    ],
    rows: [{ __banner: true }, ...visible],
  });
}

function provenance(m) {
  return `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Market news</h2>
      <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
    </div>
    <div class="text-sm leading-relaxed text-slate-600">
      <p><strong>Real reporting, and not ours.</strong> Every story Moneycontrol publish to
         <code class="rounded bg-slate-100 px-1">/news/business/stocks/</code>. Headlines, standfirsts and section names are
         theirs, reproduced unchanged; the article stays on their site and every row links to it. Nothing here summarises,
         scores, ranks or flags a story as important, and <strong>the order is their own</strong> — by their article id.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this is a capture rather than a live read</h3>
      <p class="mt-1 text-xs">Moneycontrol's site refuses automated readers by TLS fingerprint, not by headers. Measured:
         <code class="rounded bg-slate-100 px-1">curl</code> with a browser user-agent gets <strong>200 and 598 KB</strong>;
         Node's <code class="rounded bg-slate-100 px-1">fetch</code> gets <strong>403 with a 24-byte body</strong> on every
         header set tried, including the full browser set; and a <strong>Cloudflare Worker gets 403 as well</strong>. So there
         is no proxy route to build — a scheduled GitHub Action reads the page every twenty minutes and commits what it finds,
         and this page reads that capture.</p>
      <p class="mt-2 text-xs"><strong>The button checks for a newer capture. It does not fetch Moneycontrol</strong>, because
         nothing running in a browser or on the edge can. That is why two times are shown and never combined: when the
         publisher was last <em>read</em>, and when this browser last <em>confirmed</em> it holds the newest capture.</p>

      <h3 class="font-display mt-4 text-sm font-bold text-slate-900">The blank times are the honest part</h3>
      <p class="mt-1 text-xs">Moneycontrol's listing page carries no date on any story — checked, there is no date, time or
         timestamp element on it. The time comes from each story's own page, which costs one request per story, so it is
         budgeted and the newest are done first. <strong>${escapeHtml(formatNumber(m.withPublishedAt))} of
         ${escapeHtml(formatNumber(m.count))}</strong> stories carry the publisher's time; the rest render a dash.
         They are <strong>never</strong> stamped with the moment this dashboard first saw them — that is a fact about the
         scraper, is kept in its own field, and reaches the export under its own heading.</p>
    </div>
  </div>`;
}

function paint(ctx) {
  const m = marketNews.meta();
  const rows = marketNews.rows();

  if (!rows.length) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m), controls: controls(m) })}
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <h3 class="font-display text-lg font-bold text-slate-900">No market-news capture yet</h3>
        <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">
          The scheduled run that reads Moneycontrol has not committed a capture to this deployment.
          ${escapeHtml(m.message || '')}
        </p>
      </div>`;
    wire(ctx);
    return;
  }

  const table = panel(m, rows);
  ctx.root.innerHTML = `
    ${sectionHead({ title: 'News', description: DESCRIPTION, meta: pill(m), controls: controls(m) })}
    ${table.html}`;
  disposers.push(table.wire(ctx.root));
  wire(ctx);
}

function wire(ctx) {
  ctx.root.querySelector('[data-mcnews-info]')?.addEventListener('click', () => openModal(provenance(marketNews.meta()), { size: 'default' }));
  ctx.root.querySelector('[data-mcnews-refresh]')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    lastResult = null;
    paint(ctx);
    try {
      const out = await marketNews.refresh();
      // SAY WHAT IT FOUND. A control that spins and vanishes leaves the reader unsure anything was
      // checked — and "no newer capture" is a real, useful answer, not a failure.
      lastResult = out.added
        ? { added: out.added, text: `${out.added} new ${out.added === 1 ? 'story' : 'stories'}` }
        : { added: 0, text: 'No newer capture' };
    } catch {
      lastResult = { added: 0, text: 'Could not check' };
    } finally {
      busy = false;
      paint(ctx);
    }
  });
}

const DESCRIPTION =
  'Every stocks story Moneycontrol publish, market-wide — not filtered to the companies in scope. Headlines and standfirsts are theirs; the article stays where it is published.';

export function render(ctx) {
  ctxRef = ctx;
  disposers.forEach((d) => d && d());
  disposers = [];
  // Guard on `ctxRef`, which the lifecycle owns, rather than on anything captured at subscribe
  // time: render() runs again on every scope and sub-view change, and a token captured in the
  // closure would be stale from the first one onwards.
  if (!unsub) unsub = marketNews.onChange(() => ctxRef && paint(ctxRef));

  if (!marketNews.isLoaded()) {
    ctx.root.innerHTML = `${sectionHead({ title: 'News', description: DESCRIPTION })}
      <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
    marketNews.load().then(() => ctxRef && paint(ctxRef));
    return;
  }
  paint(ctx);
}

export function destroy() {
  ctxRef = null;
  disposers.forEach((d) => d && d());
  disposers = [];
  unsub?.();
  unsub = null;
  view = null;
  lastResult = null;
}
