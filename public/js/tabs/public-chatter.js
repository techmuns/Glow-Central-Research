// tabs/public-chatter.js — community sentiment from ValuePickr, Telegram and trending mentions.
//
// THIS PROMPT: presentation only. Rows are posts (ValuePickr / Telegram) or ticker aggregates
// (Trending) rather than scored companies, so no Score or Signals columns and no legend —
// sentiment already has its own explicit column.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';

export const meta = {
  id: 'public-chatter',
  title: 'Public Chatter',
  subtitle: 'Community sentiment from ValuePickr, Telegram and trending mentions.',
  subviews: [
    { id: 'valuepickr', label: 'ValuePickr' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'trending', label: 'Trending' },
  ],
};

const FEATURES = [
  'Real-time ValuePickr thread crawler with dedup',
  'Telegram channel ingestion via bot API',
  'NLP sentiment scoring per post',
  'Ticker-level chatter velocity alerts',
  'Spam / promotional post filtering',
  'Cross-source mention aggregation',
];

function scopedChatter(ctx) {
  const chatter = ctx.data?.chatter || { valuepickr: [], telegram: [], trending: [] };
  if (ctx.scope !== 'portfolio') return chatter;
  const held = new Set((ctx.data?.portfolio?.holdings || []).map((h) => h.ticker));
  return {
    valuepickr: chatter.valuepickr.filter((r) => held.has(r.ticker)),
    telegram: chatter.telegram.filter((r) => held.has(r.ticker)),
    trending: chatter.trending.filter((r) => held.has(r.ticker)),
  };
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
function signedCell(value, suffix = '%') {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${value.toFixed(value % 1 === 0 ? 0 : 1)}${suffix}</span>`;
}
function esc(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function drillForPost(row, kind) {
  const isTrend = kind === 'trending';
  openDrill({
    name: row.company,
    sub: isTrend ? row.ticker : `${row.ticker} · ${kind === 'telegram' ? row.channel : row.thread}`,
    headerStats: isTrend
      ? [
          { label: 'Mentions (24h)', value: formatNumber(row.mentions24h), caption: `${row.mentionsChangePct > 0 ? '+' : ''}${row.mentionsChangePct.toFixed(1)}% vs prior day`, tone: row.mentionsChangePct > 0 ? 'positive' : 'negative' },
          { label: 'Sentiment score', value: `${row.sentimentScore > 0 ? '+' : ''}${row.sentimentScore.toFixed(2)}`, caption: 'aggregate, −1 to +1', tone: row.sentimentScore > 0.1 ? 'positive' : row.sentimentScore < -0.1 ? 'negative' : 'neutral' },
        ]
      : [
          { label: 'Sentiment', value: row.sentiment || '—', tone: row.sentiment === 'positive' ? 'positive' : row.sentiment === 'negative' ? 'negative' : 'neutral' },
          { label: kind === 'telegram' ? 'Forwards' : 'Replies', value: formatNumber(kind === 'telegram' ? row.forwards : row.replies), caption: 'engagement proxy' },
        ],
    groups: [
      {
        category: isTrend ? 'Aggregate reading' : 'The post',
        items: isTrend
          ? [
              { label: 'Mention volume', criteria: 'Mentions across all sources, last 24h', status: null, value: formatNumber(row.mentions24h), note: `Change vs prior 24h: ${row.mentionsChangePct > 0 ? '+' : ''}${row.mentionsChangePct.toFixed(1)}%` },
              { label: 'Sentiment score', criteria: 'Aggregate, −1.0 to +1.0 (not a percentage)', status: null, value: row.sentimentScore.toFixed(2), note: 'Derived from the same posts listed under ValuePickr and Telegram.' },
            ]
          : [
              { label: kind === 'telegram' ? 'Message' : 'Excerpt', status: null, value: kind === 'telegram' ? row.message : row.excerpt, note: `Posted ${formatRelativeTime(row.postedAt)}${row.author ? ` by ${row.author}` : ''}.` },
            ],
      },
      {
        category: 'Not yet built',
        items: [
          { label: 'NLP sentiment scoring', criteria: 'Model-scored per post', status: 'na', value: '', note: 'Sentiment ships as mock data today — the model arrives in prompt 6.' },
          { label: 'Spam / promo filtering', criteria: 'Drop pump posts before they reach the feed', status: 'na', value: '', note: 'Prompt 6.' },
        ],
      },
    ],
  });
}

const VALUEPICKR_COLUMNS = [
  { label: 'Thread', get: (r) => `<span class="block max-w-xs truncate">${esc(r.thread)}</span>`, html: true, sortValue: (r) => r.thread },
  { label: 'Excerpt', get: (r) => `<span class="block max-w-md truncate text-slate-500">${esc(r.excerpt)}</span>`, html: true, sortable: false },
  { label: 'Author', get: (r) => r.author },
  { label: 'Posted', get: (r) => formatRelativeTime(r.postedAt), sortValue: (r) => new Date(r.postedAt).getTime() },
  { label: 'Replies', get: (r) => formatNumber(r.replies), align: 'right', sortValue: (r) => r.replies },
  { label: 'Sentiment', get: (r) => sentimentPill(r.sentiment), html: true, sortValue: (r) => r.sentiment },
];

const TELEGRAM_COLUMNS = [
  { label: 'Channel', get: (r) => r.channel },
  { label: 'Message', get: (r) => `<span class="block max-w-md truncate text-slate-500">${esc(r.message)}</span>`, html: true, sortable: false },
  { label: 'Posted', get: (r) => formatRelativeTime(r.postedAt), sortValue: (r) => new Date(r.postedAt).getTime() },
  { label: 'Forwards', get: (r) => formatNumber(r.forwards), align: 'right', sortValue: (r) => r.forwards },
];

const TRENDING_COLUMNS = [
  { label: 'Mentions 24h', get: (r) => formatNumber(r.mentions24h), align: 'right', sortValue: (r) => r.mentions24h },
  { label: 'Change', get: (r) => signedCell(r.mentionsChangePct), html: true, align: 'right', sortValue: (r) => r.mentionsChangePct },
  { label: 'Sentiment', get: (r) => signedCell(r.sentimentScore, ''), html: true, align: 'right', sortValue: (r) => r.sentimentScore },
];

export function render(ctx) {
  const chatter = scopedChatter(ctx);
  const rows = chatter[ctx.subview] || [];
  const avgSentiment = chatter.trending.length ? chatter.trending.reduce((s, r) => s + r.sentimentScore, 0) / chatter.trending.length : 0;
  const newest = [...chatter.valuepickr, ...chatter.telegram].sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt))[0];

  const stats = statStrip([
    { label: 'ValuePickr threads', value: formatNumber(chatter.valuepickr.length), note: 'forum posts in window' },
    { label: 'Telegram posts', value: formatNumber(chatter.telegram.length), note: 'across subscribed channels' },
    {
      label: 'Avg sentiment',
      value: `${avgSentiment > 0 ? '+' : ''}${avgSentiment.toFixed(2)}`,
      note: `${chatter.trending.length} tickers trending`,
      help: {
        title: 'How sentiment is expressed',
        body: `<p>Per-post sentiment is categorical — <strong>positive</strong>, <strong>neutral</strong> or <strong>negative</strong>.</p>
               <p class="mt-2">The Trending view aggregates those into a <strong>score from −1.00 to +1.00</strong>. It is a score, not a percentage: +0.62 means strongly positive chatter, −0.31 means net negative.</p>
               <p class="mt-3 text-slate-500">Today both ship as mock data. Model-scored sentiment over a live ValuePickr and Telegram crawl arrives in prompt 6.</p>`,
      },
    },
    { hero: true, label: 'Last Refresh', value: newest ? formatRelativeTime(newest.postedAt) : '—', note: 'ValuePickr 15 min · Telegram near real-time' },
  ]);

  const ranked = chatter.trending.slice().sort((a, b) => b.mentions24h - a.mentions24h);
  const cards = topCards({
    title: 'Top 10 by Mentions (24h)',
    items: ranked.map((r) => ({
      name: r.company,
      sub: r.ticker,
      value: formatNumber(r.mentions24h),
      tone: r.sentimentScore > 0.1 ? 'positive' : r.sentimentScore < -0.1 ? 'negative' : 'neutral',
      caption: `${r.mentionsChangePct > 0 ? '+' : ''}${r.mentionsChangePct.toFixed(1)}% vs prior day`,
      payload: r,
    })),
    valueFormat: 'metric',
    onSelect: (item) => drillForPost(item.payload, 'trending'),
  });

  const columns = ctx.subview === 'telegram' ? TELEGRAM_COLUMNS : ctx.subview === 'trending' ? TRENDING_COLUMNS : VALUEPICKR_COLUMNS;
  const initialSort =
    ctx.subview === 'trending' ? { key: 'Mentions 24h', dir: 'desc' } : ctx.subview === 'telegram' ? { key: 'Forwards', dir: 'desc' } : { key: 'Replies', dir: 'desc' };

  const table = scoreTable({
    rows,
    key: (r) => r.id || r.ticker,
    name: (r) => r.company,
    sub: (r) => r.ticker,
    columns,
    searchable: (r) => `${r.company} ${r.ticker} ${r.thread || ''} ${r.channel || ''} ${r.excerpt || ''} ${r.message || ''}`,
    initialSort,
    onRowClick: (row) => drillForPost(row, ctx.subview),
    emptyMessage: 'No chatter matches your filters.',
    exportName: `sattva-chatter-${ctx.subview}`,
  });

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description: describe(ctx.subview), meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'mentions' }) })}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}
  `;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
}

function describe(subview) {
  if (subview === 'telegram') return 'Messages from subscribed research channels, ranked by forward count.';
  if (subview === 'trending') return 'Tickers ranked by mention volume across every source in the last 24 hours.';
  return 'ValuePickr forum threads, ranked by reply volume.';
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
