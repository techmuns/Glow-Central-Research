// tabs/concall.js — live transcript feed, keyword scanning, catalyst tracking + Deep Dive.
//
// THIS PROMPT: presentation only, EXCEPT the Live Feed sub-view, which stays genuinely wired
// to core/live.js against the mock feed — that behaviour was built in prompt 1 and must not
// regress. Rows here are feed items rather than companies, so the table shows no Signals
// column and the tab carries no legend: there is nothing scored to explain yet.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip, pendingPanel } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { formatNumber, formatRelativeTime, formatTime } from '../core/format.js';

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
let liveRef = null;

function scopedFeed(ctx, rows) {
  const list = rows || ctx.data?.concallFeed || [];
  if (ctx.scope !== 'portfolio') return list;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return list.filter((r) => held.has(r.ticker));
}

function sentimentPill(sentiment) {
  const cls =
    sentiment === 'positive'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : sentiment === 'negative'
        ? 'bg-rose-50 text-rose-700 ring-rose-200'
        : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${sentiment}</span>`;
}

function keywordPill(keyword) {
  if (!keyword) return '<span class="text-slate-300">—</span>';
  return `<span class="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700 ring-1 ring-purple-200">${keyword}</span>`;
}

function drillForFeedItem(row) {
  openDrill({
    name: row.company,
    sub: `${row.ticker} · ${formatTime(row.timestamp)} · ${row.type}`,
    headerStats: [
      { label: 'Sentiment', value: row.sentiment, tone: row.sentiment === 'positive' ? 'positive' : row.sentiment === 'negative' ? 'negative' : 'neutral' },
      { label: 'Keyword', value: row.keyword || '—', caption: row.keyword ? 'matched the scan set' : 'general highlight' },
    ],
    groups: [
      {
        category: 'Commentary',
        items: [{ label: 'What was said', status: null, value: row.text, note: `Captured ${formatRelativeTime(row.timestamp)} from the ${row.type} stream.` }],
      },
      {
        category: 'Not yet built',
        items: [
          { label: 'Full transcript', criteria: 'Complete call text with speaker turns', status: 'na', value: '', note: 'Transcript ingestion arrives in prompt 5.' },
          { label: 'Quarter-over-quarter diff', criteria: 'What changed vs the last call', status: 'na', value: '', note: 'Deep Dive lands in prompt 5.' },
          { label: 'Tone scoring', criteria: 'Management consistency over time', status: 'na', value: '', note: 'Needs the transcript corpus — prompt 5.' },
        ],
      },
    ],
  });
}

export function render(ctx) {
  cleanup();
  liveRef = ctx.live;

  const rows = scopedFeed(ctx);
  const keywords = ctx.data?.concallKeywords || [];
  const positive = rows.filter((r) => r.sentiment === 'positive').length;
  const negative = rows.filter((r) => r.sentiment === 'negative').length;
  const newest = rows.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  const stats = statStrip([
    { label: 'Feed items', value: formatNumber(rows.length), note: ctx.scope === 'portfolio' ? 'in your holdings' : 'across coverage' },
    { label: 'Positive / Negative', value: `${positive} / ${negative}`, note: `${rows.length - positive - negative} neutral` },
    {
      label: 'Keywords tracked',
      value: formatNumber(keywords.length),
      note: 'default scan set',
      help: {
        title: 'The keyword scan set',
        body: `<p>Nine default keywords are matched against every transcript line: guidance, margin, capex, order book, attrition, debt reduction, capacity expansion, management change and pricing pressure.</p>
               <p class="mt-3 text-slate-500">A hit tags the line and files it under Keyword Scan. The five catalyst-shaped keywords — guidance, capex, capacity expansion, debt reduction, order book — additionally surface under Catalysts. The set becomes user-editable in prompt 5.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: newest ? formatRelativeTime(newest.timestamp) : '—', note: 'Exchange filings · polls every 12s' },
  ]);

  // Rank companies by how many keyword hits they drew in the current feed window.
  const hitsByCompany = new Map();
  for (const r of rows) {
    if (r.type !== 'keyword-hit') continue;
    const entry = hitsByCompany.get(r.ticker) || { name: r.company, ticker: r.ticker, hits: 0, keywords: new Set() };
    entry.hits += 1;
    if (r.keyword) entry.keywords.add(r.keyword);
    hitsByCompany.set(r.ticker, entry);
  }
  const ranked = Array.from(hitsByCompany.values()).sort((a, b) => b.hits - a.hits);

  const cards = topCards({
    title: 'Top 10 by Keyword Hits in Call',
    items: ranked.map((c) => ({
      name: c.name,
      sub: c.ticker,
      value: String(c.hits),
      tone: 'brand',
      caption: Array.from(c.keywords).slice(0, 2).join(', ') || 'hits',
      payload: c,
    })),
    valueFormat: 'metric',
    onSelect: (item) => {
      const first = rows.find((r) => r.ticker === item.payload.ticker);
      if (first) drillForFeedItem(first);
    },
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: describe(ctx.subview),
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'feed items' }),
    })}
    ${stats.html}
    ${ctx.subview === 'deep-dive' ? '' : cards.html}
    <div id="concall-body"></div>
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  if (ctx.subview !== 'deep-dive') cards.wire(ctx.root);

  const body = ctx.root.querySelector('#concall-body');
  if (ctx.subview === 'live-feed') renderLiveFeed(ctx, body, rows);
  else if (ctx.subview === 'keyword-scan') renderKeywordScan(body, keywords);
  else if (ctx.subview === 'catalysts') renderFeedTable(body, rows.filter((r) => r.keyword && CATALYST_KEYWORDS.has(r.keyword)), 'catalysts');
  else renderDeepDive(body);
}

function describe(subview) {
  if (subview === 'live-feed') return 'Live-polling transcript & highlight feed — updates automatically while this tab is open.';
  if (subview === 'keyword-scan') return 'Default 9-keyword scan across recent transcripts (user-editable in a later prompt).';
  if (subview === 'catalysts') return 'Feed items flagged against catalyst-shaped keywords: guidance, capex, order book, capacity expansion, debt reduction.';
  return 'Pick a company to open its full transcript, keyword timeline and quarter-over-quarter diff.';
}

const FEED_COLUMNS = [
  { label: 'Time', get: (r) => formatRelativeTime(r.timestamp), sortValue: (r) => new Date(r.timestamp).getTime() },
  { label: 'Type', get: (r) => `<span class="inline-flex items-center rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-bold text-indigo-700">${r.type}</span>`, html: true, sortValue: (r) => r.type },
  { label: 'Keyword', get: (r) => keywordPill(r.keyword), html: true, sortValue: (r) => r.keyword || '' },
  { label: 'Note', get: (r) => `<span class="block max-w-md truncate text-slate-600">${r.text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])}</span>`, html: true, sortable: false },
  { label: 'Sentiment', get: (r) => sentimentPill(r.sentiment), html: true, sortValue: (r) => r.sentiment },
];

function feedTable(rows, exportName) {
  return scoreTable({
    rows,
    key: (r) => r.id,
    name: (r) => r.company,
    sub: (r) => r.ticker,
    columns: FEED_COLUMNS,
    filters: {
      options: [
        { value: 'all', label: 'All sentiment' },
        { value: 'positive', label: 'Positive' },
        { value: 'neutral', label: 'Neutral' },
        { value: 'negative', label: 'Negative' },
      ],
      match: (r, v) => r.sentiment === v,
    },
    searchable: (r) => `${r.company} ${r.ticker} ${r.text} ${r.keyword || ''}`,
    initialSort: { key: 'Time', dir: 'desc' },
    onRowClick: drillForFeedItem,
    emptyMessage: 'No feed items match your filters.',
    exportName,
  });
}

function renderLiveFeed(ctx, mount, rows) {
  revealCount = Math.min(revealCount || 6, rows.length) || Math.min(6, rows.length);
  mount.innerHTML = `
    <div class="mb-2 text-xs text-slate-400">Newest first · polling every 12s while this tab is open</div>
    <div id="live-feed-table"></div>`;
  const tableMount = mount.querySelector('#live-feed-table');
  paintFeed(tableMount, rows);

  ctx.live.register(LIVE_ID, { intervalMs: 12000, fetcher: ctx.live.mockFetcher('data/mock/concall-feed.json', { jitter: 0 }) });
  unsubscribeLive = ctx.live.subscribe(LIVE_ID, (data) => {
    const scoped = scopedFeed(ctx, data);
    revealCount = revealCount >= scoped.length ? Math.min(6, scoped.length) : revealCount + 1;
    paintFeed(tableMount, scoped);
  });
  ctx.live.start(LIVE_ID);
}

function paintFeed(mount, rows) {
  const table = feedTable(rows.slice(0, revealCount || rows.length), 'sattva-concall-feed');
  mount.innerHTML = table.html;
  table.wire(mount);
}

function renderFeedTable(mount, rows, exportName) {
  const table = feedTable(rows, `sattva-concall-${exportName}`);
  mount.innerHTML = table.html;
  table.wire(mount);
}

function renderKeywordScan(mount, keywords) {
  const trendPill = (t) => {
    const cls = t === 'up' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : t === 'down' ? 'bg-rose-50 text-rose-700 ring-rose-200' : 'bg-slate-100 text-slate-600 ring-slate-200';
    return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${cls}">${t}</span>`;
  };
  const table = scoreTable({
    rows: keywords,
    key: (r) => r.id,
    name: (r) => r.label,
    nameLabel: 'Keyword',
    sub: (r) => r.id,
    columns: [
      { label: 'Hits (7d)', get: (r) => formatNumber(r.hits), align: 'right', sortValue: (r) => r.hits },
      { label: 'Trend', get: (r) => trendPill(r.trend), html: true, sortValue: (r) => r.trend },
      { label: 'Catalyst', get: (r) => (CATALYST_KEYWORDS.has(r.id) ? 'Yes' : 'No'), sortValue: (r) => (CATALYST_KEYWORDS.has(r.id) ? 1 : 0) },
    ],
    searchable: (r) => `${r.label} ${r.id}`,
    initialSort: { key: 'Hits (7d)', dir: 'desc' },
    emptyMessage: 'No keywords match your search.',
    exportName: 'sattva-concall-keywords',
  });
  mount.innerHTML = table.html;
  table.wire(mount);
}

function renderDeepDive(mount) {
  mount.innerHTML = pendingPanel({
    title: 'Con-call Deep Dive',
    body: 'Use the header search (⌘K) to pick a company. Full transcript, keyword timeline and quarter-over-quarter diff arrive in prompt 5.',
    arriving: 'prompt 5',
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
  liveRef?.stop(LIVE_ID);
}
