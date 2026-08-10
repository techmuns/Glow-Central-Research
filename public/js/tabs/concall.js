// tabs/concall.js — live transcript feed, keyword scanning, catalyst tracking + Deep Dive.
// THIS PROMPT: structure + placeholder panel only, EXCEPT the Live Feed sub-view, which is
// genuinely wired to core/live.js against the mock feed so the "live" feel is real, not decorative.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, badge, emptyState, comingSoonStrip } from '../ui/components.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';

export const meta = {
  id: 'concall',
  title: 'Con-call',
  subtitle: 'Live transcript feed, keyword scanning and catalyst tracking — Deep Dive lives here too.',
  subviews: [
    { id: 'live-feed', label: 'Live Feed' },
    { id: 'keyword-scan', label: 'Keyword Scan' },
    { id: 'catalysts', label: 'Catalysts' },
    { id: 'deep-dive', label: 'Deep Dive' },
  ],
};

const FEATURES = [
  'Live transcript ingestion from exchange filings',
  'Custom keyword sets with instant alerts',
  'Sentiment scoring per management commentary line',
  'Catalyst tagging (guidance raise/cut, capex, M&A)',
  'Con-call Deep Dive: full transcript + quarter-over-quarter diff',
  'Management tone/consistency scoring over time',
];

const CATALYST_KEYWORDS = new Set(['guidance', 'capex', 'capacity-expansion', 'debt-reduction', 'order-book']);
const LIVE_ID = 'concall-feed';

let unsubscribeLive = null;
let revealCount = 0;
let liveRef = null; // captured each render() so destroy() can stop the poller without needing ctx

function scopedFeed(ctx) {
  const rows = ctx.data?.concallFeed || [];
  if (ctx.scope !== 'portfolio') return rows;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function sentimentTone(sentiment) {
  return sentiment === 'positive' ? 'positive' : sentiment === 'negative' ? 'negative' : 'neutral';
}

const FEED_COLUMNS = [
  { key: 'timestamp', label: 'Time', render: (r) => `<span class="text-slate-500">${formatRelativeTime(r.timestamp)}</span>` },
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'type', label: 'Type', render: (r) => badge({ label: r.type, tone: 'brand' }) },
  { key: 'keyword', label: 'Keyword', render: (r) => (r.keyword ? pill({ label: r.keyword, tone: 'accent' }) : '<span class="text-slate-300">—</span>') },
  { key: 'text', label: 'Note', render: (r) => `<span class="block max-w-md truncate text-slate-600" title="${r.text.replace(/"/g, '&quot;')}">${r.text}</span>` },
  { key: 'sentiment', label: 'Sentiment', render: (r) => pill({ label: r.sentiment, tone: sentimentTone(r.sentiment) }) },
];

const KEYWORD_COLUMNS = [
  { key: 'label', label: 'Keyword', render: (r) => `<span class="font-semibold text-slate-800">${r.label}</span>` },
  { key: 'hits', label: 'Hits (7d)', align: 'right', render: (r) => formatNumber(r.hits) },
  { key: 'trend', label: 'Trend', render: (r) => pill({ label: r.trend, tone: r.trend === 'up' ? 'positive' : r.trend === 'down' ? 'negative' : 'neutral' }) },
];

function buildStats(rows, keywords) {
  const positive = rows.filter((r) => r.sentiment === 'positive').length;
  const negative = rows.filter((r) => r.sentiment === 'negative').length;
  return [
    { label: 'Feed items (recent)', value: formatNumber(rows.length) },
    { label: 'Positive mentions', value: formatNumber(positive), deltaTone: 'positive' },
    { label: 'Negative mentions', value: formatNumber(negative), deltaTone: negative ? 'negative' : 'neutral' },
    { label: 'Keywords tracked', value: formatNumber(keywords.length) },
  ];
}

export function render(ctx) {
  cleanup();
  liveRef = ctx.live;
  const rows = scopedFeed(ctx);
  const keywords = ctx.data?.concallKeywords || [];

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: subviewDescription(ctx.subview),
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'feed items' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(rows, keywords)
      .map((s) => statCard(s))
      .join('')}</div>
    <div id="concall-body"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const body = ctx.root.querySelector('#concall-body');

  if (ctx.subview === 'live-feed') renderLiveFeed(ctx, body, rows);
  else if (ctx.subview === 'keyword-scan') renderKeywordScan(body, keywords);
  else if (ctx.subview === 'catalysts') renderCatalysts(body, rows);
  else renderDeepDive(body);
}

function subviewDescription(subview) {
  if (subview === 'live-feed') return 'Live-polling transcript & highlight feed — updates automatically while this tab is open.';
  if (subview === 'keyword-scan') return 'Default 9-keyword scan across recent transcripts (fully user-editable in a later prompt).';
  if (subview === 'catalysts') return 'Feed items flagged against catalyst-shaped keywords (guidance, capex, order book, debt reduction).';
  return 'Pick a company to open its full transcript, keyword timeline and quarter-over-quarter diff.';
}

function renderLiveFeed(ctx, mount, rows) {
  revealCount = Math.min(revealCount || 6, rows.length) || Math.min(6, rows.length);
  mount.innerHTML = `<div class="mb-2 flex items-center justify-between text-xs text-slate-400"><span>Sorted newest first · polling every 12s while this tab is open</span></div><div id="live-feed-table"></div>`;
  const tableMount = mount.querySelector('#live-feed-table');
  paintFeed(tableMount, rows);

  ctx.live.register(LIVE_ID, { intervalMs: 12000, fetcher: ctx.live.mockFetcher('data/mock/concall-feed.json', { jitter: 0 }) });
  unsubscribeLive = ctx.live.subscribe(LIVE_ID, (data) => {
    const scoped = ctx.scope === 'portfolio' ? filterHeld(ctx, data) : data;
    revealCount = revealCount >= scoped.length ? Math.min(6, scoped.length) : revealCount + 1;
    paintFeed(tableMount, scoped);
  });
  ctx.live.start(LIVE_ID);
}

function filterHeld(ctx, rows) {
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return rows.filter((r) => held.has(r.ticker));
}

function paintFeed(mount, rows) {
  const visible = rows.slice(0, revealCount || rows.length);
  const table = dataTable({ columns: FEED_COLUMNS, rows: visible, sortable: false });
  mount.innerHTML = table.html;
}

function renderKeywordScan(mount, keywords) {
  const table = dataTable({ columns: KEYWORD_COLUMNS, rows: keywords, initialSort: { key: 'hits', dir: 'desc' } });
  mount.innerHTML = table.html;
  table.wire(mount);
}

function renderCatalysts(mount, rows) {
  const catalystRows = rows.filter((r) => r.keyword && CATALYST_KEYWORDS.has(r.keyword));
  const table = dataTable({ columns: FEED_COLUMNS, rows: catalystRows, sortable: false });
  mount.innerHTML = table.html;
}

function renderDeepDive(mount) {
  mount.innerHTML = emptyState({
    title: 'No company selected',
    message: 'Use the search bar (⌘K) to pick a company and open its Con-call Deep Dive — full transcript, keyword timeline and QoQ diff land in prompt 5.',
    icon: '🔎',
  });
}

export function destroy() {
  cleanup();
}

function cleanup() {
  if (unsubscribeLive) {
    unsubscribeLive();
    unsubscribeLive = null;
  }
  // Stop polling while this tab isn't mounted — register() stays intact (cheap), so a quick
  // re-visit resumes immediately with the last good data instead of a cold start.
  liveRef?.stop(LIVE_ID);
}
