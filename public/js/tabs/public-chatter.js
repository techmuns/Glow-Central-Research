// tabs/public-chatter.js — retail chatter across ValuePickr and Telegram.
//
//   ValuePickr   forum threads, momentum, and a thread drill with claims split by kind
//   Telegram     public groups with the pump-risk flag and its reasons
//   Trending     the cross-source view, joined to the REAL technicals feed
//
// The point of this tab is that volume is not interest. A spike from six accounts forwarding
// the same note is not the market noticing something, and the pump-risk column exists so the
// table says that out loud rather than ranking it at the top. See js/chatter/pump-risk.js.
//
// PROVENANCE: threads, posts, groups, messages and handles are all synthetic (handles are
// fictional by design — a handle belongs to a person). The technical scores on Trending are
// REAL, from the daily scrape, and the sub-header says which axis is which.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatDate, formatRelativeTime } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { spark } from '../ui/components.js';
import * as chatter from '../data/chatter.js';
import * as technicals from '../data/technicals.js';
import { openTechnicalsDrillByTicker } from './breakouts-drill.js';
import { riskPillClass, riskRowClass, THRESHOLDS } from '../chatter/pump-risk.js';
import * as coverage from '../data/coverage.js';

export const meta = {
  id: 'public-chatter',
  title: 'Public Chatter',
  subtitle: 'What retail is actually discussing — with the volume-versus-interest distinction made explicit.',
  subviews: [
    { id: 'valuepickr', label: 'ValuePickr' },
    { id: 'telegram', label: 'Telegram' },
    { id: 'trending', label: 'Trending' },
  ],
};

const FEATURES = [
  'ValuePickr crawler with per-post sentiment scoring',
  'Telegram Bot API ingestion across subscribed groups',
  'Named-entity linking so a post about "the Halol plant" attaches to the right ticker',
  'Claim extraction with a source link back to the originating post',
  'Alerting when a portfolio name crosses a chatter-momentum threshold',
];

let renderToken = 0;
let unsubscribeLive = null;
let liveRef = null;

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  const token = ++renderToken;
  cleanup();
  liveRef = ctx.live;
  ctx.root.innerHTML = loadingHtml();

  // The technicals feed powers the Trending join. It is loaded lazily and may already be
  // cached from the Breakouts tab; either way the chatter views render without waiting for it.
  Promise.all([chatter.load(), technicals.load().catch(() => null)])
    .then(() => {
      if (token !== renderToken) return;
      chatter.registerPoller(ctx.live, { intervalMs: 8000 });
      paint(ctx);
    })
    .catch((err) => {
      if (token !== renderToken) return;
      console.error('[chatter] load failed', err);
      ctx.root.innerHTML = `
        ${sectionHead({ title: meta.title, description: 'The chatter data set could not be loaded.' })}
        <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
          <div class="text-3xl">⚠️</div>
          <div class="mt-2 text-sm font-semibold text-slate-700">Could not load the chatter feeds</div>
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
  liveRef?.stop(chatter.LIVE_ID);
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  const view = { valuepickr: renderValuePickr, telegram: renderTelegram, trending: renderTrending }[ctx.subview] || renderValuePickr;
  view(ctx);
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------

function provenanceRibbon() {
  if (!chatter.meta()?.isMock) return '';
  const m = chatter.meta();
  return `
    <div data-mock-ribbon class="mb-5 flex flex-wrap items-start gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
      <span class="flex-shrink-0 rounded-full bg-amber-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-900">Illustrative data</span>
      <p class="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">
        Every thread, post, group and message here is <strong>synthetic</strong>, and
        <strong>every handle is fictional</strong> — no real forum member or group participant wrote any of this, and the thread
        links do not resolve. Company names, tickers and sectors are real. Generated by
        <code class="rounded bg-amber-100 px-1">${escapeHtml(m.generator || 'scripts/gen-mock-chatter.mjs')}</code>
        with seed <code class="rounded bg-amber-100 px-1">${escapeHtml(String(m.seed ?? '—'))}</code>.
        <em class="not-italic text-amber-800">Momentum and the pump-risk flag are computed from those counts at render time</em>, not stored.
      </p>
    </div>`;
}

function freshnessCard(note) {
  const m = chatter.meta();
  const arrivals = chatter.totalArrivals();
  return {
    hero: true,
    label: 'Last refresh',
    value: m?.isMock ? 'Mock data' : formatDate(m?.generated_at),
    note: m?.isMock
      ? `Generated ${formatDate(m?.generated_at)} · not a live crawl${arrivals ? ` · ${arrivals} arrived this session` : ''}${note ? ` · ${note}` : ''}`
      : `Crawler${note ? ` · ${note}` : ''}`,
  };
}

/** A −1..+1 sentiment bar. Emerald/rose here are semantic: bullish vs bearish is a verdict. */
function sentimentBar(value) {
  if (value == null) return '<span class="text-xs text-slate-300">—</span>';
  const v = Math.max(-1, Math.min(1, value));
  const pct = Math.abs(v) * 50;
  const pos = v >= 0;
  return `
    <span class="inline-flex items-center gap-1.5" title="sentiment ${v > 0 ? '+' : ''}${v.toFixed(2)}">
      <span class="relative h-1.5 w-16 rounded-full bg-slate-100">
        <span class="absolute inset-y-0 left-1/2 w-px bg-slate-300"></span>
        <span class="absolute inset-y-0 rounded-full ${pos ? 'bg-emerald-500 left-1/2' : 'bg-rose-500'}"
          style="width:${pct}%;${pos ? '' : `left:${50 - pct}%`}"></span>
      </span>
      <span class="w-9 text-[11px] font-semibold tabular-nums ${pos ? 'text-emerald-600' : 'text-rose-600'}">${v > 0 ? '+' : ''}${v.toFixed(2)}</span>
    </span>`;
}

function momentumCell(m) {
  if (!m) return '<span class="text-xs text-slate-300">—</span>';
  if (m.isNew) return '<span class="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-bold text-indigo-700">new</span>';
  if (m.abs === 0) return '<span class="text-xs tabular-nums text-slate-400">0</span>';
  const up = m.abs > 0;
  return `<span class="inline-flex items-center gap-1 text-xs font-bold tabular-nums ${up ? 'text-indigo-700' : 'text-slate-500'}">
    ${up ? '▲' : '▼'} ${Math.abs(m.abs)}${m.pct != null ? `<span class="font-medium opacity-70">${up ? '+' : ''}${m.pct}%</span>` : ''}</span>`;
}

/** Rows that came back from forScope() as placeholders. */
function noChatterPanel(rows, noun) {
  const missing = rows.filter((r) => r.noChatter);
  if (!missing.length) return '';
  return `
    <div class="mb-6 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div class="text-xs font-bold uppercase tracking-wider text-slate-500">No ${noun} tracked (${missing.length})</div>
      <div class="mt-1 text-[11px] text-slate-500">
        Nobody is discussing these holdings in the tracked sources. They are listed rather than dropped — silence is a finding.
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        ${missing.map((r) => `<span class="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">${escapeHtml(r.name)}</span>`).join('')}
      </div>
    </div>`;
}

function scopedThreads(ctx) {
  return chatter.forScope(chatter.threads(), ctx.scope, coverage.holdings());
}
function scopedGroups(ctx) {
  return chatter.forScope(chatter.groups(), ctx.scope, coverage.holdings());
}

/** Subscribe the current view to the poller and repaint the counters it changes. */
function wireLive(ctx, onTick) {
  unsubscribeLive?.();
  unsubscribeLive = liveRef.subscribe(chatter.LIVE_ID, (payload) => {
    try {
      onTick(payload);
    } catch (err) {
      console.error('[chatter] live tick handler threw', err);
    }
  });
  liveRef.start(chatter.LIVE_ID);
}

// ---------------------------------------------------------------------------------------
// (a) VALUEPICKR
// ---------------------------------------------------------------------------------------

function renderValuePickr(ctx) {
  const rows = scopedThreads(ctx);
  const live = rows.filter((r) => !r.noChatter);
  const posts7d = live.reduce((s, t) => s + t.posts7d, 0);
  const busiest = live.slice().sort((a, b) => b.posts7d - a.posts7d)[0];

  const stats = statStrip([
    { label: 'Threads tracked', value: formatNumber(live.length), note: `${live.filter((t) => t.momentum.abs > 0).length} accelerating` },
    { label: 'Posts this week', value: formatNumber(posts7d), note: `${formatNumber(live.reduce((s, t) => s + t.postsPrior7d, 0))} the week before` },
    { label: 'Most discussed', value: busiest ? busiest.name.slice(0, 16) : '—', note: busiest ? `${busiest.posts7d} posts this week` : 'nothing tracked' },
    freshnessCard('polls every 8s'),
  ]);

  const cards = topCards({
    title: 'Top 10 by Chatter Momentum',
    items: live
      .filter((t) => t.momentum.abs !== 0)
      .sort((a, b) => b.momentum.abs - a.momentum.abs)
      .slice(0, 10)
      .map((t) => ({
        key: t.threadId,
        name: t.name,
        sub: t.sector,
        value: `${t.momentum.abs > 0 ? '+' : ''}${t.momentum.abs}`,
        tone: t.momentum.abs > 0 ? 'positive' : 'negative',
      })),
    valueFormat: 'metric',
    onSelect: (item) => openThreadDrill(chatter.threadById(item.key)),
  });

  const table = scoreTable({
    rows: live,
    key: (t) => t.threadId,
    name: (t) => t.name,
    sub: (t) => [t.ticker, t.sector].filter(Boolean).join(' · '),
    searchable: (t) => `${t.name} ${t.ticker} ${t.title} ${t.category}`,
    initialSort: { key: 'Posts 7d', dir: 'desc' },
    exportName: `sattva-valuepickr-${todayStamp()}`,
    onRowClick: (t) => openThreadDrill(t),
    onExport: () => runExport(ctx),
    columns: [
      { label: 'Thread', html: true, sortValue: (t) => t.title, get: (t) => `<span class="text-sm text-slate-700">${escapeHtml(t.title)}</span>` },
      { label: 'Posts 7d', align: 'right', get: (t) => t.posts7d, sortValue: (t) => t.posts7d },
      { label: 'Momentum', align: 'right', html: true, sortValue: (t) => t.momentum.abs, get: (t) => momentumCell(t.momentum) },
      { label: 'Participants', align: 'right', get: (t) => t.participantCount, sortValue: (t) => t.participantCount },
      { label: 'Sentiment', html: true, sortValue: (t) => t.sentiment, get: (t) => sentimentBar(t.sentiment) },
      { label: 'Last post', align: 'right', html: true, sortValue: (t) => t.lastPostAt, get: (t) => `<span class="text-[11px] text-slate-500">${escapeHtml(formatRelativeTime(t.lastPostAt))}</span>` },
      {
        label: '',
        html: true,
        get: (t) =>
          `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener" data-norow
             class="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800" title="Synthetic link — does not resolve">open ↗</a>`,
      },
    ],
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'ValuePickr threads by how much they are actually moving, not by how big they already are.',
      meta: scopeSummary({ scope: ctx.scope, count: live.length, noun: 'threads', book: coverage.meta() }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${cards.html}
    ${table.html}
    ${noChatterPanel(rows, 'threads')}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);

  // Arrivals land as a small badge on the stat card rather than a full repaint — a table that
  // reshuffles under the cursor while you are reading it is worse than one that is a tick stale.
  wireLive(ctx, () => {
    const el = ctx.root.querySelector('[data-live-arrivals]');
    if (el) el.textContent = chatter.totalArrivals();
  });
}

function claimPill(kind) {
  const cls = { fact: 'bg-slate-100 text-slate-700 ring-slate-300', speculation: 'bg-amber-50 text-amber-700 ring-amber-200', question: 'bg-sky-50 text-sky-700 ring-sky-200' }[kind];
  return `<span class="inline-flex flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(kind)}</span>`;
}

function openThreadDrill(thread) {
  if (!thread) return;
  const byKind = { fact: [], speculation: [], question: [] };
  for (const c of thread.claims || []) (byKind[c.kind] ||= []).push(c);

  const sentimentTint = (s) => (s > 0.15 ? 'border-emerald-300 bg-emerald-50/40' : s < -0.15 ? 'border-rose-300 bg-rose-50/40' : 'border-slate-200 bg-white');

  openDrill({
    name: thread.name,
    sub: [thread.ticker, thread.sector, thread.category].filter(Boolean).join(' · '),
    link: thread.url,
    linkLabel: 'Open thread ↗',
    headerStats: [
      { label: 'Posts this week', value: String(thread.posts7d), caption: `${thread.postsPrior7d} the week before`, tone: thread.momentum.abs > 0 ? 'positive' : 'neutral' },
      { label: 'Participants', value: String(thread.participantCount), caption: `${thread.postsPerParticipant} posts each`, tone: 'neutral' },
    ],
    banner: chatter.meta()?.isMock
      ? {
          tone: 'amber',
          title: 'Illustrative thread',
          body: 'The company is real. The thread, every post below and every handle are synthetic — no real forum member wrote any of this, and the link does not resolve.',
        }
      : null,
    beforeGroupsHtml: `
      <div class="mb-5">
        <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Posts per week · 12 weeks</div>
        <div class="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
          ${spark({ values: thread.weeklyPosts12w || [], width: 400, height: 44, tone: 'brand' })}
          <div class="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>12 weeks ago</span><span class="font-semibold text-slate-600">this week: ${thread.posts7d}</span>
          </div>
        </div>
      </div>

      <div class="mb-5">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Top contributors</div>
        <div class="space-y-1.5">
          ${(thread.topContributors || [])
            .map(
              (c) => `
            <div class="flex items-center gap-2">
              <span class="w-40 truncate font-mono text-[11px] text-slate-600">${escapeHtml(c.handle)}</span>
              <div class="h-1.5 flex-1 rounded-full bg-slate-100">
                <div class="h-1.5 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500" style="width:${Math.min(100, (c.posts / Math.max(1, thread.topContributors[0].posts)) * 100)}%"></div>
              </div>
              <span class="w-8 text-right text-[11px] font-bold tabular-nums text-slate-500">${c.posts}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>

      <div class="mb-5">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Extracted claims</div>
        <div class="mb-2 text-[11px] text-slate-400">
          Split by what kind of statement it is. A forum post asserting something is not the same as one wondering about it,
          and a dashboard that flattened the three would make speculation look like research.
        </div>
        ${['fact', 'speculation', 'question']
          .map((kind) =>
            byKind[kind]?.length
              ? `<div class="mb-2">
                   ${byKind[kind]
                     .map(
                       (c) => `
                     <div class="mb-1 flex items-start gap-2 rounded-lg bg-white p-2 ring-1 ring-slate-100">
                       ${claimPill(kind)}
                       <span class="min-w-0 flex-1 text-[11px] leading-snug text-slate-600">${escapeHtml(c.text)}</span>
                     </div>`
                     )
                     .join('')}
                 </div>`
              : ''
          )
          .join('')}
      </div>

      <div class="mb-5">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Recent posts</div>
        <div class="space-y-2">
          ${(thread.recentPosts || [])
            .map(
              (p) => `
            <div class="rounded-xl border-l-2 ${sentimentTint(p.sentiment)} p-2.5 ring-1 ring-slate-100">
              <div class="mb-1 flex flex-wrap items-baseline gap-2">
                <span class="font-mono text-[11px] font-semibold text-slate-700">${escapeHtml(p.handle)}</span>
                <span class="text-[10px] text-slate-400">${escapeHtml(formatRelativeTime(p.at))}</span>
                <span class="ml-auto text-[10px] text-slate-400">♥ ${p.likes}</span>
              </div>
              <p class="text-[11px] leading-relaxed text-slate-600">${escapeHtml(p.text)}</p>
            </div>`
            )
            .join('')}
        </div>
      </div>`,
    groups: [],
  });
}

// ---------------------------------------------------------------------------------------
// (b) TELEGRAM
// ---------------------------------------------------------------------------------------

const TG_FILTERS = {
  risk: {
    label: 'Pump risk',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: '0', label: 'Clear' },
      { id: '1', label: 'Watch' },
      { id: '2', label: 'Elevated' },
      { id: '3', label: 'High' },
      { id: 'flagged', label: 'Flagged (2+)' },
    ],
    test: (g, id) => id === 'any' || (id === 'flagged' ? g.risk.level >= 2 : g.risk.level === Number(id)),
  },
  sent: {
    label: 'Sentiment',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'bull', label: 'Bullish' },
      { id: 'neutral', label: 'Neutral' },
      { id: 'bear', label: 'Bearish' },
    ],
    test: (g, id) => id === 'any' || (id === 'bull' ? g.sentiment > 0.15 : id === 'bear' ? g.sentiment < -0.15 : Math.abs(g.sentiment) <= 0.15),
  },
  sec: {
    label: 'Sector',
    options: (rows) => [{ id: 'any', label: 'All sectors' }, ...[...new Set(rows.map((g) => g.sector).filter(Boolean))].sort().slice(0, 8).map((s) => ({ id: s, label: s.length > 20 ? `${s.slice(0, 18)}…` : s }))],
    test: (g, id) => id === 'any' || g.sector === id,
  },
  vol: {
    label: 'Volume',
    options: () => [
      { id: 'any', label: 'Any' },
      { id: 'high', label: '200+ /24h' },
      { id: 'mid', label: '50–199' },
      { id: 'low', label: 'Under 50' },
    ],
    test: (g, id) => id === 'any' || (id === 'high' ? g.messages24h >= 200 : id === 'mid' ? g.messages24h >= 50 && g.messages24h < 200 : g.messages24h < 50),
  },
};
const TG_DEFAULTS = { risk: 'any', sent: 'any', sec: 'any', vol: 'any' };

function filterBar(defs, defaults, allRows, params, attr) {
  const state = {};
  for (const [k, d] of Object.entries(defaults)) state[k] = params?.[k] || d;
  return {
    state,
    html: `
      <div class="mb-5 space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-${attr}-bar>
        ${Object.entries(defs)
          .map(([key, f]) => {
            const opts = f.options(allRows);
            return `
            <div class="flex flex-wrap items-center gap-2">
              <span class="w-24 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(f.label)}</span>
              ${opts
                .map((o) => {
                  const active = state[key] === o.id;
                  const trial = { ...state, [key]: o.id };
                  const n = allRows.filter((r) => Object.entries(defs).every(([k2, f2]) => f2.test(r, trial[k2]))).length;
                  return `<button type="button" data-${attr}-filter="${escapeHtml(key)}" data-${attr}-value="${escapeHtml(o.id)}"
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
      </div>`,
  };
}

function renderTelegram(ctx) {
  const all = scopedGroups(ctx).filter((g) => !g.noChatter);
  const bar = filterBar(TG_FILTERS, TG_DEFAULTS, all, ctx.params, 'tg');
  const rows = all.filter((g) => Object.entries(TG_FILTERS).every(([k, f]) => f.test(g, bar.state[k])));
  const flagged = all.filter((g) => g.risk.level >= 2);

  const stats = statStrip([
    { label: 'Groups tracked', value: formatNumber(all.length), note: `${formatNumber(all.reduce((s, g) => s + g.memberCount, 0))} members combined` },
    { label: 'Messages 24h', value: formatNumber(all.reduce((s, g) => s + g.messages24h, 0)), note: `${formatNumber(all.reduce((s, g) => s + g.uniqueSenders24h, 0))} distinct senders` },
    {
      label: 'Flagged for pump risk',
      value: formatNumber(flagged.length),
      note: flagged.length ? `${all.filter((g) => g.risk.level === 3).length} at the top level` : 'nothing above Watch',
      help: {
        title: 'How pump risk is computed',
        body: `<p>A volume spike on its own is not interest. This flag exists so a wall of messages from six accounts is not ranked as though the market noticed something.</p>
               <p class="mt-3">A group must first clear a <strong>volume gate</strong> — at least ${THRESHOLDS.MIN_MESSAGES_24H} messages in 24h <em>and</em> at least ${THRESHOLDS.MIN_VOLUME_SPIKE}× the previous day. Without that, the ratios below are meaningless and the level is 0 whatever they say.</p>
               <p class="mt-3">Past the gate, each of three signals adds one level:</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Few senders, many messages</strong> — ${THRESHOLDS.CONCENTRATION_MSGS_PER_SENDER}+ messages per distinct sender.</li>
                 <li><strong>Mostly forwarded</strong> — ${Math.round(THRESHOLDS.FORWARD_RATIO * 100)}%+ of messages are forwards rather than original posts.</li>
                 <li><strong>Uniformly bullish</strong> — mean sentiment at or above +${THRESHOLDS.UNIFORM_BULLISH}, i.e. nobody in the room disagrees.</li>
               </ul>
               <p class="mt-3 text-slate-500">It is a <strong>heuristic, not a finding</strong> — it says a pattern is consistent with coordinated posting, never that a pump is happening. Every row shows which criteria fired and their measured values; open a group to see them. Thresholds live in <code class="rounded bg-slate-100 px-1">js/chatter/pump-risk.js</code>.</p>`,
      },
    },
    freshnessCard('polls every 8s'),
  ]);

  const table = scoreTable({
    rows,
    key: (g) => g.groupId,
    name: (g) => g.companyName,
    sub: (g) => [g.ticker, g.sector].filter(Boolean).join(' · '),
    searchable: (g) => `${g.companyName} ${g.ticker} ${g.name}`,
    initialSort: { key: 'Msgs 24h', dir: 'desc' },
    exportName: `sattva-telegram-${todayStamp()}`,
    onRowClick: (g) => openGroupDrill(g),
    onExport: () => runExport(ctx),
    rowClass: (g) => riskRowClass(g.risk.level),
    columns: [
      { label: 'Group', html: true, sortValue: (g) => g.name, get: (g) => `<span class="text-sm text-slate-700">${escapeHtml(g.name)}</span><span class="block text-[10px] text-slate-400">${formatNumber(g.memberCount)} members</span>` },
      {
        label: 'Pump risk',
        html: true,
        sortValue: (g) => g.risk.level,
        get: (g) =>
          `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${riskPillClass(g.risk.level)}" title="${escapeHtml(g.risk.reasons.filter((r) => r.fired).map((r) => r.label).join(' · ') || 'no criteria fired')}">
             ${g.risk.level}/3 ${escapeHtml(g.risk.label)}</span>`,
      },
      { label: 'Msgs 24h', align: 'right', get: (g) => g.messages24h, sortValue: (g) => g.messages24h },
      { label: 'Δ vs prior', align: 'right', html: true, sortValue: (g) => g.momentum.abs, get: (g) => momentumCell(g.momentum) },
      { label: 'Unique senders', align: 'right', html: true, sortValue: (g) => g.uniqueSenders24h, get: (g) => `<span class="tabular-nums ${g.risk.msgsPerSender >= THRESHOLDS.CONCENTRATION_MSGS_PER_SENDER ? 'font-bold text-rose-600' : 'text-slate-600'}">${g.uniqueSenders24h}</span><span class="block text-[10px] text-slate-400">${g.risk.msgsPerSender}/sender</span>` },
      { label: 'Forward ratio', align: 'right', html: true, sortValue: (g) => g.forwardRatio, get: (g) => `<span class="tabular-nums ${g.forwardRatio >= THRESHOLDS.FORWARD_RATIO ? 'font-bold text-rose-600' : 'text-slate-600'}">${Math.round(g.forwardRatio * 100)}%</span>` },
      { label: 'Sentiment', html: true, sortValue: (g) => g.sentiment, get: (g) => sentimentBar(g.sentiment) },
    ],
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Public Telegram groups, with a transparent pump-risk flag — because message volume and genuine interest are different things.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'groups', book: coverage.meta() }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${bar.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  table.wire(ctx.root);
  ctx.root.querySelector('[data-tg-bar]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tg-filter]');
    if (btn) ctx.setParams({ ...(ctx.params || {}), [btn.dataset.tgFilter]: btn.dataset.tgValue });
  });
  wireLive(ctx, () => {
    const el = ctx.root.querySelector('[data-live-arrivals]');
    if (el) el.textContent = chatter.totalArrivals();
  });
}

function openGroupDrill(group) {
  if (!group) return;
  const r = group.risk;
  openDrill({
    name: group.companyName,
    sub: [group.ticker, group.sector, group.name].filter(Boolean).join(' · '),
    headerStats: [
      { label: 'Messages 24h', value: String(group.messages24h), caption: `${group.uniqueSenders24h} senders · ${r.msgsPerSender} each`, tone: 'neutral' },
      { label: 'Pump risk', value: `${r.level}/3`, caption: r.label, tone: r.level >= 3 ? 'negative' : r.level === 2 ? 'caution' : 'neutral' },
    ],
    banner: chatter.meta()?.isMock
      ? { tone: 'amber', title: 'Illustrative group', body: 'The company is real. The group, its members, every message and every count are synthetic. No real Telegram group is represented here.' }
      : null,
    beforeGroupsHtml: `
      <div class="mb-5">
        <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Why this is rated ${r.level}/3</div>
        <div class="mb-2 text-[11px] text-slate-400">
          Every criterion is shown, fired or not, with what it measured. The flag is a heuristic about posting
          <em>pattern</em> — it says this looks like coordinated posting, never that a pump is happening.
        </div>
        <div class="space-y-1.5">
          ${r.reasons
            .map(
              (reason) => `
            <div class="flex items-start gap-2 rounded-xl p-2.5 ring-1 ${reason.fired ? 'bg-rose-50/60 ring-rose-200' : 'bg-slate-50 ring-slate-200'}">
              <span class="mt-0.5 flex-shrink-0 text-xs ${reason.fired ? 'text-rose-600' : 'text-slate-300'}">${reason.fired ? '●' : '○'}</span>
              <div class="min-w-0 flex-1">
                <div class="text-[11px] font-bold ${reason.fired ? 'text-rose-800' : 'text-slate-500'}">${escapeHtml(reason.label)}${reason.id === 'volume' ? ' (gate)' : ''}</div>
                <div class="text-[11px] leading-snug ${reason.fired ? 'text-rose-700' : 'text-slate-500'}">${escapeHtml(reason.detail)}</div>
              </div>
            </div>`
            )
            .join('')}
        </div>
        ${
          !r.gate.fired
            ? '<div class="mt-2 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500 ring-1 ring-slate-200">The volume gate did not fire, so the level is 0 regardless of the other criteria — ratios on a quiet group are noise.</div>'
            : ''
        }
      </div>

      <div class="mb-5">
        <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Recent messages</div>
        <div class="space-y-2">
          ${(group.recentMessages || [])
            .map(
              (m) => `
            <div class="rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-100">
              <div class="mb-1 flex items-baseline gap-2">
                <span class="font-mono text-[11px] font-semibold text-slate-700">${escapeHtml(m.handle)}</span>
                <span class="text-[10px] text-slate-400">${escapeHtml(formatRelativeTime(m.at))}</span>
              </div>
              <p class="text-[11px] leading-relaxed text-slate-600">${escapeHtml(m.text)}</p>
            </div>`
            )
            .join('')}
        </div>
      </div>`,
    groups: [],
  });
}

// ---------------------------------------------------------------------------------------
// (c) TRENDING — the cross-source view, joined to the real technicals feed
// ---------------------------------------------------------------------------------------

/**
 * Join chatter to technicals.
 *
 * Chatter is synthetic; the technical score, the day's move and 52-week proximity are REAL,
 * from the daily scrape. The sub-header says so, because a chart with one invented axis and
 * one measured axis is exactly the kind of thing that gets screenshotted without its caption.
 */
function joinTrending(ctx) {
  const rows = chatter.trending();
  const scopeRows = ctx.scope === 'portfolio' ? chatter.forScope(rows, ctx.scope, coverage.holdings()) : rows;

  return scopeRows.map((row) => {
    if (row.noChatter) return row;
    const tech = technicals.byTicker(row.ticker);
    const c = tech?.company;
    return {
      ...row,
      tech: tech || null,
      techScore: tech && !tech.tickerError ? tech.totalPoints : null,
      techMax: tech?.totalMax ?? null,
      techPct: tech && !tech.tickerError ? tech.scorePct : null,
      pctChangeToday: c?.pct_change_today ?? null,
      from52wHigh: c?.high_52w && c?.cmp ? Math.round(((c.cmp - c.high_52w) / c.high_52w) * 1000) / 10 : null,
      // Relative strength vs the Nifty 500 over 6 months, as a percentage.
      rs6m: c?.relative_strength_6m != null ? Math.round(c.relative_strength_6m * 1000) / 10 : null,
    };
  });
}

function renderTrending(ctx) {
  const all = joinTrending(ctx);
  const rows = all.filter((r) => !r.noChatter);
  const joined = rows.filter((r) => r.techScore != null);

  const stats = statStrip([
    { label: 'Companies discussed', value: formatNumber(rows.length), note: `across ${chatter.threads().length} threads and ${chatter.groups().length} groups` },
    { label: 'Total mentions', value: formatNumber(rows.reduce((s, r) => s + r.totalMentions, 0)), note: 'posts (7d) + messages (24h)' },
    {
      label: 'Joined to technicals',
      value: `${joined.length} / ${rows.length}`,
      note: 'have a live technical score',
      help: {
        title: 'What this view joins',
        body: `<p>Two data sets with very different provenance sit side by side here, and the distinction matters:</p>
               <ul class="mt-2 list-disc space-y-1 pl-5">
                 <li><strong>Chatter columns are SYNTHETIC</strong> — mentions, momentum, sentiment and the source split all come from <code class="rounded bg-slate-100 px-1">scripts/gen-mock-chatter.mjs</code>.</li>
                 <li><strong>Technical columns are REAL</strong> — the score out of 24, the day's move and 52-week proximity come from <code class="rounded bg-slate-100 px-1">public/data/technicals.json</code>, scraped from Yahoo Finance on a weekday schedule and scored by the same 16-rule model the Breakouts tab uses.</li>
               </ul>
               <p class="mt-3">The join key is the ticker. A company discussed but absent from the NSE-500 universe shows "—" in the technical columns rather than a zero.</p>
               <p class="mt-3 text-slate-500">So the quadrant below has one invented axis and one measured one. That is fine for demonstrating the shape of the analysis, and useless as a signal until the crawlers are wired.</p>`,
      },
    },
    freshnessCard(),
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => [r.ticker, r.sector].filter(Boolean).join(' · '),
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector}`,
    initialSort: { key: 'Mentions', dir: 'desc' },
    exportName: `sattva-trending-${todayStamp()}`,
    onRowClick: (r) => openTechnicalsDrillByTicker(r.ticker),
    onExport: () => runExport(ctx),
    columns: [
      { label: 'Mentions', align: 'right', get: (r) => r.totalMentions, sortValue: (r) => r.totalMentions },
      {
        label: 'Source split',
        html: true,
        sortValue: (r) => r.sourceSplit.tg,
        get: (r) => `
          <div class="flex items-center gap-1.5" title="ValuePickr ${r.vpPosts} posts · Telegram ${r.tgMessages} messages">
            <span class="flex h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
              <span class="bg-indigo-500" style="width:${r.sourceSplit.vp}%"></span>
              <span class="bg-sky-400" style="width:${r.sourceSplit.tg}%"></span>
            </span>
            <span class="text-[10px] tabular-nums text-slate-400">${r.sourceSplit.vp}/${r.sourceSplit.tg}</span>
          </div>`,
      },
      { label: 'Momentum', align: 'right', html: true, sortValue: (r) => r.momentum.abs, get: (r) => momentumCell(r.momentum) },
      { label: 'Sentiment', html: true, sortValue: (r) => r.sentiment ?? -2, get: (r) => sentimentBar(r.sentiment) },
      {
        label: 'Tech score',
        align: 'right',
        html: true,
        sortValue: (r) => r.techPct ?? -1,
        get: (r) =>
          r.techScore == null
            ? '<span class="text-[11px] text-slate-300">—</span>'
            : `<span class="rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${r.techPct >= 70 ? 'bg-emerald-50 text-emerald-700' : r.techPct >= 45 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}">${r.techScore}/${r.techMax}</span>`,
      },
      {
        label: '1D %',
        align: 'right',
        html: true,
        sortValue: (r) => r.pctChangeToday ?? -999,
        get: (r) =>
          r.pctChangeToday == null
            ? '<span class="text-[11px] text-slate-300">—</span>'
            : `<span class="text-xs font-semibold tabular-nums ${r.pctChangeToday > 0 ? 'text-emerald-600' : r.pctChangeToday < 0 ? 'text-rose-600' : 'text-slate-500'}">${r.pctChangeToday > 0 ? '+' : ''}${r.pctChangeToday}%</span>`,
      },
      {
        label: 'From 52W high',
        align: 'right',
        html: true,
        sortValue: (r) => r.from52wHigh ?? -999,
        get: (r) => (r.from52wHigh == null ? '<span class="text-[11px] text-slate-300">—</span>' : `<span class="text-xs tabular-nums text-slate-600">${r.from52wHigh}%</span>`),
      },
      { label: 'First mention', align: 'right', html: true, sortValue: (r) => r.firstMentionAt || '', get: (r) => `<span class="text-[11px] text-slate-500">${r.firstMentionAt ? escapeHtml(formatDate(r.firstMentionAt)) : '—'}</span>` },
    ],
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'Every company being discussed, across both sources, set against what the price has actually done.',
      meta: scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'companies', book: coverage.meta() }),
    })}
    ${provenanceRibbon()}
    <div class="mb-5 rounded-2xl bg-white p-3 text-xs leading-relaxed text-slate-600 shadow-sm ring-1 ring-slate-100">
      <span class="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">Synthetic</span>
      mentions · momentum · sentiment · source split
      <span class="mx-2 text-slate-300">|</span>
      <span class="mr-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">Real</span>
      technical score · 1-day move · 52-week proximity · 6-month relative strength
      <span class="block text-[11px] text-slate-400">The chatter axis is invented; the price axis is measured. Read the quadrant as a demonstration of the analysis, not as a signal.</span>
    </div>
    ${stats.html}
    ${quadrantHtml(joined)}
    ${table.html}
    ${noChatterPanel(all, 'chatter')}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  table.wire(ctx.root);
  wireQuadrant(ctx.root);
  wireLive(ctx, () => {
    const el = ctx.root.querySelector('[data-live-arrivals]');
    if (el) el.textContent = chatter.totalArrivals();
  });
}

/** Chatter momentum (x, synthetic) vs 6-month relative strength (y, real). */
function quadrantHtml(rows) {
  const pts = rows
    .filter((r) => r.rs6m != null && r.momentum?.abs != null)
    .map((r) => ({ ticker: r.ticker, name: r.name, x: r.momentum.abs, y: r.rs6m, mentions: r.totalMentions }));
  if (!pts.length) return '';

  const W = 760;
  const H = 380;
  const PAD = { l: 58, r: 18, t: 26, b: 52 };

  // Chatter momentum is heavy-tailed — one thread going from 30 posts to 700 flattens every
  // other company against the axis. A signed square root compresses the tail while keeping the
  // sign and, crucially, keeping zero at zero, so the quadrant boundaries still mean what they
  // say. The axis label states the scale rather than letting it pass as linear.
  const sqrtSigned = (v) => Math.sign(v) * Math.sqrt(Math.abs(v));
  const xs = pts.map((p) => sqrtSigned(p.x));
  const ys = pts.map((p) => p.y);
  const xMin = Math.min(-3, Math.min(...xs));
  const xMax = Math.max(3, Math.max(...xs));
  const yMin = Math.min(-20, Math.min(...ys));
  const yMax = Math.max(20, Math.max(...ys));
  const sx = (v) => PAD.l + ((sqrtSigned(v) - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const sy = (v) => H - PAD.b - ((v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  const x0 = PAD.l + ((0 - xMin) / (xMax - xMin)) * (W - PAD.l - PAD.r);
  const y0 = sy(0);
  const rMax = Math.max(...pts.map((p) => p.mentions));

  const quad = (label, sub, x, y, anchor, tone) => `
    <text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" font-weight="700" fill="${tone}">${label}</text>
    <text x="${x}" y="${y + 12}" text-anchor="${anchor}" font-size="9" fill="#94a3b8">${sub}</text>`;

  return `
    <div class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-sm font-bold text-slate-900">Chatter vs price</h3>
        <span class="text-[11px] text-slate-400">${pts.length} companies · dot size = total mentions · click to open the technicals drill</span>
      </div>
      <div class="overflow-x-auto">
        <svg viewBox="0 0 ${W} ${H}" class="w-full min-w-[680px]" role="img" aria-label="Chatter momentum versus 6-month relative strength">
          <rect x="${x0}" y="${PAD.t}" width="${W - PAD.r - x0}" height="${y0 - PAD.t}" fill="#ecfdf5" opacity="0.6"/>
          <rect x="${PAD.l}" y="${PAD.t}" width="${x0 - PAD.l}" height="${y0 - PAD.t}" fill="#f8fafc" opacity="0.8"/>
          <rect x="${x0}" y="${y0}" width="${W - PAD.r - x0}" height="${H - PAD.b - y0}" fill="#eef2ff" opacity="0.7"/>
          <rect x="${PAD.l}" y="${y0}" width="${x0 - PAD.l}" height="${H - PAD.b - y0}" fill="#f8fafc" opacity="0.5"/>

          <line x1="${x0}" y1="${PAD.t}" x2="${x0}" y2="${H - PAD.b}" stroke="#cbd5e1" stroke-dasharray="3 3"/>
          <line x1="${PAD.l}" y1="${y0}" x2="${W - PAD.r}" y2="${y0}" stroke="#cbd5e1" stroke-dasharray="3 3"/>

          ${quad('Confirmed', 'chatter and strength together', W - PAD.r - 8, PAD.t + 12, 'end', '#059669')}
          ${quad('Fading', 'price moved, nobody talking', PAD.l + 8, PAD.t + 12, 'start', '#64748b')}
          ${quad('Early', 'chatter, no move yet', W - PAD.r - 8, H - PAD.b - 14, 'end', '#4f46e5')}
          ${quad('Quiet', 'neither', PAD.l + 8, H - PAD.b - 14, 'start', '#94a3b8')}

          ${pts
            .map((p) => {
              const r = 4 + (p.mentions / Math.max(1, rMax)) * 10;
              const fill = p.x > 0 && p.y > 0 ? '#059669' : p.x > 0 ? '#4f46e5' : p.y > 0 ? '#64748b' : '#cbd5e1';
              return `<circle data-quad-point="${escapeHtml(p.ticker)}" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${r.toFixed(1)}"
                fill="${fill}" fill-opacity="0.62" stroke="${fill}" stroke-width="1.2" class="cursor-pointer hover:fill-opacity-90">
                <title>${escapeHtml(p.name)} — chatter momentum ${p.x > 0 ? '+' : ''}${p.x}, relative strength ${p.y > 0 ? '+' : ''}${p.y}%, ${p.mentions} mentions</title>
              </circle>`;
            })
            .join('')}

          <text x="${(PAD.l + W - PAD.r) / 2}" y="${H - 16}" text-anchor="middle" font-size="10" fill="#64748b">chatter momentum, posts + messages vs prior period (synthetic)</text>
          <text x="${(PAD.l + W - PAD.r) / 2}" y="${H - 4}" text-anchor="middle" font-size="8.5" fill="#94a3b8">square-root scale — one thread can add 600 posts and would otherwise flatten everything else</text>
          <text x="14" y="${(PAD.t + H - PAD.b) / 2}" text-anchor="middle" font-size="10" fill="#64748b" transform="rotate(-90 14 ${(PAD.t + H - PAD.b) / 2})">6-month relative strength vs Nifty 500 (real)</text>
        </svg>
      </div>
    </div>`;
}

function wireQuadrant(root) {
  root.querySelectorAll('[data-quad-point]').forEach((pt) => pt.addEventListener('click', () => openTechnicalsDrillByTicker(pt.dataset.quadPoint)));
}

// ---------------------------------------------------------------------------------------
// Export — three sheets, provenance banner as row 1
// ---------------------------------------------------------------------------------------

async function runExport(ctx) {
  const m = chatter.meta();
  const banner = m?.isMock
    ? 'ILLUSTRATIVE DATA — company names, tickers and sectors are real; every thread, post, group, message and handle is synthetic (scripts/gen-mock-chatter.mjs). Handles are fictional: no real forum member or group participant wrote any of this. Technical scores on the Trending sheet ARE real, from public/data/technicals.json.'
    : `Public chatter as of ${formatDate(m?.generated_at)}.`;

  const threads = scopedThreads(ctx).filter((t) => !t.noChatter);
  const groups = scopedGroups(ctx).filter((g) => !g.noChatter);
  const trend = joinTrending(ctx).filter((r) => !r.noChatter);

  await exportSheets({
    filename: `sattva-chatter-${todayStamp()}`,
    banner,
    sheets: [
      {
        name: 'ValuePickr threads',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (t) => t.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (t) => t.ticker },
          { header: 'Sector', key: 'sector', width: 26, get: (t) => t.sector },
          { header: 'Thread', key: 'title', width: 52, get: (t) => t.title },
          { header: 'Category', key: 'cat', width: 18, get: (t) => t.category },
          { header: 'Posts 7d', key: 'p7', width: 10, get: (t) => t.posts7d },
          { header: 'Posts prior 7d', key: 'pp', width: 13, get: (t) => t.postsPrior7d },
          { header: 'Momentum', key: 'mom', width: 11, get: (t) => t.momentum.abs },
          { header: 'Momentum %', key: 'momp', width: 12, get: (t) => t.momentum.pct ?? '' },
          { header: 'Participants', key: 'part', width: 12, get: (t) => t.participantCount },
          { header: 'Sentiment', key: 'sent', width: 11, get: (t) => t.sentiment },
          { header: 'Last post', key: 'last', width: 22, get: (t) => t.lastPostAt },
        ],
        rows: threads,
      },
      {
        name: 'Telegram groups',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (g) => g.companyName },
          { header: 'Ticker', key: 'ticker', width: 14, get: (g) => g.ticker },
          { header: 'Group', key: 'group', width: 28, get: (g) => g.name },
          { header: 'Members', key: 'mem', width: 12, get: (g) => g.memberCount },
          { header: 'Msgs 24h', key: 'm24', width: 11, get: (g) => g.messages24h },
          { header: 'Msgs prior 24h', key: 'mp', width: 14, get: (g) => g.messagesPrior24h },
          { header: 'Unique senders', key: 'us', width: 14, get: (g) => g.uniqueSenders24h },
          { header: 'Msgs per sender', key: 'mps', width: 15, get: (g) => g.risk.msgsPerSender },
          { header: 'Forward ratio', key: 'fr', width: 13, get: (g) => g.forwardRatio },
          { header: 'Sentiment', key: 'sent', width: 11, get: (g) => g.sentiment },
          { header: 'Pump risk', key: 'risk', width: 11, get: (g) => g.risk.level },
          { header: 'Risk label', key: 'rl', width: 12, get: (g) => g.risk.label },
          { header: 'Criteria fired', key: 'why', width: 64, get: (g) => g.risk.reasons.filter((r) => r.fired).map((r) => `${r.label} (${r.detail})`).join('; ') || 'none' },
        ],
        rows: groups,
      },
      {
        name: 'Trending',
        columns: [
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Sector', key: 'sector', width: 26, get: (r) => r.sector },
          { header: 'Total mentions (synthetic)', key: 'tm', width: 24, get: (r) => r.totalMentions },
          { header: 'ValuePickr posts', key: 'vp', width: 16, get: (r) => r.vpPosts },
          { header: 'Telegram messages', key: 'tg', width: 18, get: (r) => r.tgMessages },
          { header: 'Momentum', key: 'mom', width: 11, get: (r) => r.momentum.abs },
          { header: 'Sentiment', key: 'sent', width: 11, get: (r) => r.sentiment ?? '' },
          { header: 'Technical score (REAL)', key: 'ts', width: 21, get: (r) => (r.techScore == null ? '' : `${r.techScore}/${r.techMax}`) },
          { header: '1D % (REAL)', key: 'd1', width: 13, get: (r) => r.pctChangeToday ?? '' },
          { header: 'From 52W high % (REAL)', key: 'h52', width: 22, get: (r) => r.from52wHigh ?? '' },
          { header: '6M relative strength % (REAL)', key: 'rs', width: 28, get: (r) => r.rs6m ?? '' },
        ],
        rows: trend,
      },
    ],
  });
}
