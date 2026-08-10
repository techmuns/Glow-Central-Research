// tabs/public-chatter.js — community sentiment from ValuePickr, Telegram and trending mentions.
// THIS PROMPT: structure + placeholder panel only. Real crawlers/NLP land in prompt 6.

import { sectionHeader, statCard, scopeSummary, dataTable, pill, comingSoonStrip } from '../ui/components.js';
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

const VALUEPICKR_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'thread', label: 'Thread' },
  { key: 'excerpt', label: 'Excerpt', render: (r) => `<span class="block max-w-md truncate text-slate-500" title="${r.excerpt.replace(/"/g, '&quot;')}">${r.excerpt}</span>` },
  { key: 'author', label: 'Author' },
  { key: 'postedAt', label: 'Posted', render: (r) => formatRelativeTime(r.postedAt) },
  { key: 'replies', label: 'Replies', align: 'right', render: (r) => formatNumber(r.replies) },
  { key: 'sentiment', label: 'Sentiment', render: (r) => sentimentPill(r.sentiment) },
];

const TELEGRAM_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'channel', label: 'Channel' },
  { key: 'message', label: 'Message', render: (r) => `<span class="block max-w-md truncate text-slate-500" title="${r.message.replace(/"/g, '&quot;')}">${r.message}</span>` },
  { key: 'postedAt', label: 'Posted', render: (r) => formatRelativeTime(r.postedAt) },
  { key: 'forwards', label: 'Forwards', align: 'right', render: (r) => formatNumber(r.forwards) },
];

const TRENDING_COLUMNS = [
  { key: 'ticker', label: 'Ticker', render: (r) => `<span class="font-semibold text-slate-800">${r.ticker}</span>` },
  { key: 'company', label: 'Company' },
  { key: 'mentions24h', label: 'Mentions (24h)', align: 'right', render: (r) => formatNumber(r.mentions24h) },
  { key: 'mentionsChangePct', label: 'Change', align: 'right', render: (r) => changeCell(r.mentionsChangePct) },
  { key: 'sentimentScore', label: 'Sentiment', align: 'right', render: (r) => sentimentScoreCell(r.sentimentScore) },
];

function sentimentPill(sentiment) {
  return pill({ label: sentiment, tone: sentiment === 'positive' ? 'positive' : sentiment === 'negative' ? 'negative' : 'neutral' });
}
function changeCell(value) {
  const cls = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${value > 0 ? '+' : ''}${value.toFixed(1)}%</span>`;
}
function sentimentScoreCell(score) {
  const cls = score > 0.1 ? 'text-emerald-600' : score < -0.1 ? 'text-rose-600' : 'text-slate-500';
  return `<span class="font-semibold ${cls}">${score > 0 ? '+' : ''}${score.toFixed(2)}</span>`;
}

function buildStats(chatter) {
  const avgSentiment = chatter.trending.length ? chatter.trending.reduce((s, r) => s + r.sentimentScore, 0) / chatter.trending.length : 0;
  return [
    { label: 'ValuePickr threads', value: formatNumber(chatter.valuepickr.length) },
    { label: 'Telegram posts', value: formatNumber(chatter.telegram.length) },
    { label: 'Trending tickers', value: formatNumber(chatter.trending.length) },
    { label: 'Avg sentiment', value: (avgSentiment > 0 ? '+' : '') + avgSentiment.toFixed(2), deltaTone: avgSentiment > 0 ? 'positive' : avgSentiment < 0 ? 'negative' : 'neutral' },
  ];
}

export function render(ctx) {
  const chatter = scopedChatter(ctx);
  const activeRows = chatter[ctx.subview] || [];

  ctx.root.innerHTML = `
    <div>${sectionHeader({
      title: meta.title,
      description: meta.subtitle,
      meta: scopeSummary({ scope: ctx.scope, count: activeRows.length, noun: 'mentions' }),
    })}</div>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${buildStats(chatter)
      .map((s) => statCard(s))
      .join('')}</div>
    <div id="chatter-table"></div>
    ${comingSoonStrip(FEATURES)}
  `;

  const mount = ctx.root.querySelector('#chatter-table');
  const columns = ctx.subview === 'telegram' ? TELEGRAM_COLUMNS : ctx.subview === 'trending' ? TRENDING_COLUMNS : VALUEPICKR_COLUMNS;
  const initialSort = ctx.subview === 'trending' ? { key: 'mentions24h', dir: 'desc' } : ctx.subview === 'telegram' ? { key: 'forwards', dir: 'desc' } : { key: 'replies', dir: 'desc' };
  const table = dataTable({ columns, rows: activeRows, initialSort });
  mount.innerHTML = table.html;
  table.wire(mount);
}

export function destroy() {
  // No live pollers or global listeners registered by this tab.
}
