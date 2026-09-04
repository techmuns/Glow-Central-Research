// tabs/nse-filings.js — NSE Filings: the live exchange announcements feed, narrowed to your scope.
//
// THE FEED THAT ANSWERS "WHAT DID MY COMPANIES JUST FILE". Every other news surface here is either
// market-wide (the publisher feeds carry no company, so they cannot be scoped) or a scheduled
// per-company snapshot. NSE rebuilds its announcements RSS every few minutes and every item names
// the filer, so this table resolves each one to a ticker and the scope toggle shows just your
// Portfolio, your Watchlist, or the whole exchange — updating live while you watch it.
//
// The rows, their subjects and the filing PDFs are NSE's own, reproduced unchanged and linked to
// their server. Nothing here is scored, ranked or judged. A filing whose company is outside the
// universe this dashboard can name keeps no ticker and appears only under Universe — never under a
// narrowed scope, because nothing on it says whose it is (the honesty rule every feed here follows).

import { scoreTable, sectionHead } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';
import { scopePossessive } from '../data/scope.js';
import * as coverage from '../data/coverage.js';
import * as feed from '../data/nse-filings.js';

export const meta = {
  id: 'nse-filings',
  title: 'NSE Filings',
  subtitle: 'Live exchange announcements, narrowed to your companies — updated as they are filed.',
  subviews: [],
};

let renderToken = 0;
let unsubscribe = null;
let tableView = null;
// The live engine is owned by the app, not the tab. Captured on mount so destroy() — which takes no
// ctx — can stop the poller it started; folding it into the render closure would leak the poller
// past the tab, and app-wide polling of a per-scope table is not what this feed is for.
let liveRef = null;

export function render(ctx) {
  const token = ++renderToken;
  cleanup();
  ctx.root.innerHTML = loadingHtml();

  feed
    .load()
    .then(() => {
      if (token !== renderToken) return;
      paint(ctx);
      unsubscribe = feed.onChange(() => {
        if (token !== renderToken) return;
        paint(ctx);
      });
      liveRef = ctx.live;
      feed.startLive(ctx.live);
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[nse-filings] feed failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The NSE announcements feed could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not reach the NSE announcements feed</div>
          <div class="mt-1 text-xs text-slate-500">${escapeHtml(String(err.message || err))}</div>
        </div>`;
    });
}

export function destroy() {
  renderToken++;
  cleanup();
  tableView = null;
}

function cleanup() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  // Stop our poller so it does not outlive the mounted tab.
  if (liveRef) {
    feed.stopLive(liveRef);
    liveRef = null;
  }
}

/** IST — the exchange and the reader are both there. */
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

const linkable = (u) => /^https?:\/\//i.test(String(u || ''));

function whenCell(iso) {
  const t = istTime(iso);
  return t
    ? `<span class="tabular-nums text-slate-700">${escapeHtml(t)}</span>`
    : `<span class="text-slate-300" title="NSE published no time for this item">time not given</span>`;
}

function filingCell(r) {
  if (!linkable(r.url)) {
    return `<span class="text-slate-300" title="This is an exchange notice with no attached document (e.g. a price/volume surveillance alert).">no document</span>`;
  }
  return `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer"
      class="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">Open filing ↗</a>`;
}

function paint(ctx) {
  const m = feed.meta();
  const rows = feed.forScope(ctx.scope, coverage.holdings());

  // The subject filter is built from what is actually in scope, most common first — a reader can
  // see there are twelve "Board Meeting" filings before spending a click. Measured off the rows,
  // never typed, so it can never claim a category the feed does not carry.
  const subjectCounts = new Map();
  for (const r of rows) if (r.subject) subjectCounts.set(r.subject, (subjectCounts.get(r.subject) || 0) + 1);
  const subjects = [...subjectCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const table = scoreTable({
    rows,
    key: feed.rowKey,
    // THE STAR MARKS THE COMPANY, NOT THE ROW. `key` is the filing's identity; the watch key is the
    // ticker, so the Watchlist scope has a symbol to match. A row we could not resolve gets no star
    // rather than a dead one — the same rule Superstar Investors and Public Chatter follow.
    watchKey: (r) => r.ticker || null,
    watchName: (r) => r.company,
    name: (r) => r.company,
    nameLabel: 'Company',
    sub: (r) => (r.ticker ? r.ticker : 'no NSE symbol'),
    showRank: false,
    nameAfter: 1,
    dense: true,
    nameMaxPx: 280,
    stickyHead: 'max(320px, calc(100vh - 300px))',
    columns: [
      { label: 'Filed (IST)', get: (r) => whenCell(r.publishedAt), html: true, align: 'left', sortValue: (r) => r.publishedAt || '' },
      {
        label: 'Subject',
        get: (r) => (r.subject ? `<span class="whitespace-normal text-[12px] leading-snug text-slate-700">${escapeHtml(r.subject)}</span>` : '<span class="text-slate-300">—</span>'),
        html: true,
        sortValue: (r) => r.subject || '',
      },
      { label: 'Document', get: filingCell, html: true, align: 'right', sortable: false },
    ],
    filters: subjects.length > 1
      ? [
          {
            label: 'Subject',
            options: [{ value: 'all', label: 'All subjects' }, ...subjects.map(([s, n]) => ({ value: s, label: `${s} (${n})` }))],
            match: (r, v) => r.subject === v,
          },
        ]
      : null,
    searchable: (r) => `${r.company} ${r.ticker || ''} ${r.subject || ''}`,
    link: (r) => (linkable(r.url) ? r.url : null),
    initialSort: { key: 'Filed (IST)', dir: 'desc' },
    exportName: 'sattva-nse-filings',
    emptyMessage: scopePossessive(ctx.scope)
      ? `None of ${scopePossessive(ctx.scope)} has filed with NSE recently.`
      : 'No filings match your filters.',
    initialView: tableView,
  });
  tableView = table.view;

  const fresh = m.capturedAt ? formatRelativeTime(Date.parse(m.capturedAt)) : 'never';
  const originWord = m.origin === 'live' ? 'Live' : m.origin === 'store' ? 'Cached' : m.origin === 'snapshot' ? 'Snapshot' : '';
  const desc = `Every announcement NSE has published recently, newest first, resolved to the filing company. `
    + `${m.resolved} of ${m.count} resolved to a symbol. Times are IST. `
    + `${originWord ? `${originWord} · read ${escapeHtml(fresh)}.` : ''}`
    + (m.degraded ? ` ${escapeHtml(m.degraded)}` : '');

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: desc,
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'filings', book: coverage.meta() }),
    })}
    ${table.html}
  `;
  table.wire(ctx.root);
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="skeleton-shimmer h-[520px] rounded-2xl bg-slate-100"></div>`;
}
