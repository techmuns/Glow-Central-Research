// tabs/public-chatter.js — retail chatter across ValuePickr, TradingQnA and Google News.
//
// ONE PAGE, TWO SIMPLE IN-PAGE TABS, ONE PROVENANCE.
//   Covered companies    entries whose slug resolves to an NSE symbol we cover. Scope-aware,
//                        joined to the technicals feed, rows open the technicals drill.
//   Not in our coverage  everything else, whole, in both scopes.
//
// The tab used to be three sub-views over a synthetic corpus — ValuePickr threads, Telegram groups
// and a Trending join — with fictional handles, because inventing words for a named person is not
// something a label can make acceptable. That corpus is gone. The words here are real people's
// actual posts, so the rule that applies instead is the StockScans one: LINK, DO NOT REPRODUCE.
// Rows carry counts and a link; the posts stay on the forum that hosts them.
//
// TELEGRAM AND THE PUMP-RISK FLAG WENT WITH IT, deliberately. There is no live Telegram source,
// and pump-risk's gate is `MIN_MESSAGES_24H = 120` — calibrated for a firehose. This feed carries
// ~600 posts per scrape across ~219 entries; the busiest entry in a real run had 22 mentions in
// THIRTY DAYS. Running the heuristic anyway would return "Clear" for every row, which is not a
// clean bill of health, it is a fabricated one. Both are in git history at `ce2aa18..`.
//
// TWO NUMBERS THAT ARE NOT WHAT THEY LOOK LIKE — see js/data/chatter-live.js. `mentionsChangePct`
// is mention volume between scrapes, never a price move, so it is never coloured like a P&L and
// the column says "Mentions Δ". `sparkline` is per-SCRAPE, not per-day, so it carries no time axis.

import { topCards, scoreTable, sectionHead } from '../ui/screener.js';
import { scopeSummary, pill, tabBar } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import * as chatter from '../data/chatter-live.js';
import * as technicals from '../data/technicals.js';
import { openTechnicalsDrillByTicker } from './breakouts-drill.js';
import * as coverage from '../data/coverage.js';

export const meta = {
  id: 'public-chatter',
  title: 'Public Chatter',
  subtitle: 'What retail is actually discussing, across ValuePickr, TradingQnA and Google News.',
  // No shell sub-view picker: Coverage and Not in coverage are simple tabs inside this page.
  // They remain one feed and one provenance.
  subviews: [],
};

let renderToken = 0;
let disposers = [];
let paintDisposers = [];
let tableViews = { covered: null, other: null };
let chatterSection = 'coverage';

const SECTIONS = [
  { id: 'coverage', label: 'Coverage' },
  { id: 'not-in-coverage', label: 'Not in coverage' },
];

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  const token = ++renderToken;
  cleanup();
  ctx.root.innerHTML = loadingHtml();

  // PAINT ON THE CHATTER FEED ALONE. This used to await the technicals feed as well, which the tab
  // never reads — it is needed only when somebody clicks a row and opens the drill. That made first
  // paint wait on 800KB of prices to show a table of mention counts, and on a slow link the reader
  // sat on "Loading chatter…" for as long as the larger, irrelevant feed took.
  chatter
    .load()
    .catch(() => null)
    .then(() => {
      if (token !== renderToken) return;
      paint(ctx);
      disposers.push(chatter.startLive(ctx.live));
      disposers.push(
        chatter.onChange(() => {
          if (token === renderToken) paint(ctx);
        }),
      );
    });

  // Warmed in the background so a click a few seconds from now opens instantly. Nothing waits on
  // it, and `openRow` below covers the case where somebody is faster than the network.
  technicals.load().catch(() => null);
}

export function destroy() {
  renderToken++;
  cleanup();
  chatterSection = 'coverage';
}

function cleanup() {
  clearPaint();
  for (const d of disposers.splice(0)) {
    try {
      d?.();
    } catch (err) {
      console.error('[chatter] cleanup failed', err);
    }
  }
  tableViews = { covered: null, other: null };
}

function clearPaint() {
  for (const d of paintDisposers.splice(0)) {
    try {
      d?.();
    } catch (err) {
      console.error('[chatter] paint cleanup failed', err);
    }
  }
}

/**
 * The first paint, before the feed has answered.
 *
 * It carries the section head, not just a spinner. This tab is the one whose data comes from
 * ANOTHER ORIGIN, so its first paint waits on a cross-origin round trip rather than a local file —
 * long enough that a bare "Loading…" is what a reader actually sees on arrival, and long enough
 * that a route check with a short settle found an all-but-empty panel. Every other tab renders its
 * chrome immediately; this one now does too, and only the body arrives late.
 */
const loadingHtml = () => `
  ${sectionHead({
    title: 'Public Chatter',
    description:
      'Mention counts and sentiment across ValuePickr, TradingQnA and Google News, computed by SentimentDash over a rolling 30 days. The counts and the sentiment are theirs; the NSE symbol is ours.',
  })}
  <div class="rounded-2xl bg-white p-10 text-center text-sm text-slate-400 shadow-sm ring-1 ring-slate-100">
    Loading chatter…
  </div>`;

// ---------------------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------------------

function paint(ctx) {
  clearPaint();
  const m = chatter.meta();

  // A failed read is not an empty result. `unavailablePanel` names the state and, where an
  // operator can fix it, the command that does — the same split the Superstar Investors view
  // makes between "configure this" and "wait for this".
  if (!m?.ok) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: 'Public Chatter', description: meta.subtitle })}
      ${unavailablePanel(m?.reason, m?.url)}`;
    return;
  }

  const covered = chatter.forScope(ctx.scope);
  const other = chatter.uncovered();
  const activeSection = SECTIONS.some((item) => item.id === chatterSection) ? chatterSection : SECTIONS[0].id;
  const sectionTabs = tabBar({
    tabs: SECTIONS,
    activeId: activeSection,
    onSelect: (section) => {
      if (section === chatterSection) return;
      chatterSection = section;
      paint(ctx);
      ctx.root.querySelector('[data-chatter-section-tabs] [role="tab"][aria-selected="true"]')?.focus();
    },
  });
  const cards = activeSection === 'coverage' ? buildTopCards(covered) : null;
  const coveredTable = activeSection === 'coverage' ? buildCoveredTable(ctx, covered) : null;
  const otherTable = activeSection === 'not-in-coverage' ? buildOtherTable(other) : null;
  const panel =
    activeSection === 'coverage'
      ? `${cards ? cards.html : ''}${coveredTable ? coveredTable.html : emptyCovered(ctx.scope)}`
      : `${sectionHead({
          title: 'Not in our coverage',
          description:
            'Entries whose slug does not resolve to a symbol in our universe or the book. This is a statement about OUR coverage, not about them — the list mixes Indian companies we do not carry, foreign names and bare themes, and we do not guess which is which. Shown in full in every scope, because a holding cannot be filtered out of a list that has no tickers.',
        })}${otherTable.html}`;

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Public Chatter',
      description: `Mention counts and sentiment over a rolling ${escapeHtml(m.window)}, computed by SentimentDash across ValuePickr, TradingQnA and Google News. The counts and the sentiment are theirs; the NSE symbol is ours.`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}${scopeSummary({ scope: ctx.scope, count: covered.length, noun: `mentioned · ${m.window}`, book: coverage.meta() })}</div>`,
    })}
    <div class="mb-5 rounded-2xl bg-white px-3 shadow-sm ring-1 ring-slate-100" data-chatter-section-tabs>
      ${sectionTabs.html}
    </div>
    <div role="tabpanel" aria-label="${escapeHtml(SECTIONS.find((item) => item.id === activeSection)?.label || '')}" data-chatter-panel="${escapeHtml(activeSection)}">
      ${panel}
      ${chatterFootnotes(m)}
    </div>`;

  paintDisposers.push(sectionTabs.wire(ctx.root.querySelector('[data-chatter-section-tabs]')));
  if (cards) cards.wire(ctx.root);
  if (coveredTable) paintDisposers.push(coveredTable.wire(ctx.root));
  if (otherTable) paintDisposers.push(otherTable.wire(ctx.root));
}

/**
 * Open a company's technicals drill from a chatter row.
 *
 * `openTechnicalsDrillByTicker` reads the technicals cache synchronously and returns false when it
 * is not there yet. Since this tab no longer blocks its paint on that feed, a fast click can land
 * before it arrives — so the miss triggers the load and retries, rather than being a click that
 * silently does nothing. A ticker with no technicals row at all (a scrape failure, a company
 * outside the scraped universe) still opens nothing, which is correct: there is no panel to show.
 */
function openRow(ticker) {
  if (openTechnicalsDrillByTicker(ticker)) return;
  technicals
    .load()
    .then(() => openTechnicalsDrillByTicker(ticker))
    .catch(() => {});
}

// ---------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------

function chatterFootnotes(m) {
  const mood = chatter.overview()?.marketMood;
  const moodText = mood
    ? `${escapeHtml(mood.labelText)} (${escapeHtml(String(mood.percent.bullish))}% bullish, ${escapeHtml(String(mood.percent.bearish))}% bearish, ${escapeHtml(String(mood.percent.neutral))}% neutral)`
    : 'not reported';
  const scrapeText = m.generatedAt ? formatRelativeTime(new Date(m.generatedAt)) : 'not reported';
  const sourceAge = m.ageSeconds != null ? `${Math.round(m.ageSeconds / 3600)}h old by the source clock` : 'source age unavailable';
  return `
    <div data-chatter-footnotes class="mt-4 border-t border-slate-200 pt-3 text-[11px] leading-relaxed text-slate-500">
      <p><strong class="font-semibold text-slate-600">Footnotes.</strong>
        Coverage: ${escapeHtml(formatNumber(m.companies))} of ${escapeHtml(formatNumber(m.total))} feed entries resolve to a company we cover.
        Posts: ${m.totalPosts == null ? 'not reported' : escapeHtml(formatNumber(m.totalPosts))} over ${escapeHtml(m.window)}, across ${escapeHtml(sourceSummary(m.sourceTotals))}.
        Market mood: ${moodText}; keyword-scored by SentimentDash and reproduced unchanged.
        Last scrape: ${escapeHtml(scrapeText)} (${escapeHtml(sourceAge)}); scheduled at 01:30 and 13:30 UTC.
      </p>
    </div>`;
}

const sourceSummary = (totals) => {
  if (!totals) return 'three sources';
  return Object.entries(totals)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${chatter.sourceLabel(k)} ${formatNumber(n)}`)
    .join(' · ');
};

function buildTopCards(rows) {
  const ranked = rows.filter((r) => r.mentions > 0).slice(0, 10);
  if (ranked.length < 3) return null;
  return topCards({
    title: 'Most discussed — companies we cover',
    items: ranked.map((r) => ({
      key: r.ticker,
      name: r.name,
      sub: `${r.ticker} · ${r.sentiment.labelText}`,
      value: r.mentions,
      tone: 'neutral',
    })),
    valueFormat: 'metric',
    onSelect: (key) => openRow(key),
  });
}

/** The passive green Live status label. */
const livePill = (m) => `
  <span data-chatter-live
    class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100">
    <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
    <span>Live</span>
    <span class="font-medium text-emerald-600">${escapeHtml(formatNumber(m.total))} entries · ${escapeHtml(m.window)}</span>
  </span>`;

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

const sentimentPill = (s) => {
  const tone = s.label === 'bullish' ? 'positive' : s.label === 'bearish' ? 'negative' : 'neutral';
  return pill({ label: s.labelText, tone });
};

/**
 * The mention-change cell.
 *
 * NEVER coloured like a return. It is a change in how often people mentioned something, and a
 * green +200% here would read as a price move to anyone glancing — which is exactly what the
 * integration spec warns about, and what `classifyChange()` guards against on the results feed.
 * Slate, with an arrow for direction and the two counts behind it.
 */
function mentionsDeltaCell(r) {
  if (r.mentionsChangePct == null) return '<span class="text-slate-300">—</span>';
  const arrow = r.direction === 'up' ? '▲' : r.direction === 'down' ? '▼' : '·';
  const pct = `${r.mentionsChangePct > 0 ? '+' : ''}${Math.round(r.mentionsChangePct)}%`;
  return `<span class="tabular-nums text-slate-600" title="${escapeHtml(`${r.mentionsPrev} mentions last scrape → ${r.mentions} this scrape`)}">${arrow} ${escapeHtml(pct)}</span>`;
}

const sourceCell = (r) =>
  r.sourceLabel
    ? `<span class="text-xs text-slate-500">${escapeHtml(r.sourceLabel)}</span>`
    : '<span class="text-slate-300">—</span>';

function buildCoveredTable(ctx, rows) {
  if (!rows.length) return null;
  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    sub: (r) => `${r.ticker}${r.matchedName && r.matchedName !== r.name ? ` · ${r.matchedName}` : ''}`,
    searchable: true,
    dense: true,
    wrapHeads: true,
    initialSort: { key: 'Mentions', dir: 'desc' },
    initialView: tableViews.covered,
    exportName: 'chatter-companies',
    onRowClick: (r) => openRow(r.ticker),
    filters: [
      {
        label: 'Sentiment',
        options: [
          { value: 'all', label: 'All sentiment' },
          { value: 'bullish', label: 'Bullish' },
          { value: 'bearish', label: 'Bearish' },
          { value: 'neutral', label: 'Neutral' },
        ],
        match: (r, v) => r.sentiment.label === v,
      },
    ],
    columns: [
      { label: 'Mentions', get: (r) => r.mentions, align: 'right', sortable: true, sortValue: (r) => r.mentions },
      {
        label: 'Mentions Δ',
        get: mentionsDeltaCell,
        html: true,
        align: 'right',
        sortable: true,
        sortValue: (r) => r.mentionsChangePct ?? -Infinity,
      },
      {
        label: 'Sentiment',
        get: (r) => sentimentPill(r.sentiment),
        html: true,
        sortable: true,
        sortValue: (r) => r.sentiment.score ?? 0,
      },
      {
        label: 'Bull / Bear',
        get: (r) => `<span class="tabular-nums text-xs text-slate-500">${r.sentiment.bullish} / ${r.sentiment.bearish}</span>`,
        html: true,
        align: 'right',
        sortable: true,
        sortValue: (r) => r.sentiment.bullish - r.sentiment.bearish,
      },
      { label: 'Sources', get: sourceCell, html: true },
    ],
  });
  // The table rebuilds on every live tick, so its search/sort/filter state has to survive that or
  // the reader's view is discarded each time a scrape lands.
  return {
    html: table.html,
    wire: (root) => {
      const off = table.wire(root);
      return () => {
        // `scoreTable` returns `view` as a live OBJECT, not a getter. Calling it threw a
        // TypeError on every teardown, so the reader's search and sort were silently discarded on
        // each live tick — the exact thing this disposer exists to prevent. It went unseen because
        // the console was already noisy with the Tailwind CDN failing in the sandbox.
        tableViews.covered = table.view ?? tableViews.covered;
        off?.();
      };
    },
  };
}

/**
 * Not `pendingPanel` — that stamps "Pending · not yet wired", which would be false. Nothing is
 * pending here: the feed was read successfully and nothing in it matched. "Nobody is discussing
 * your holdings" is a finding, and dressing it as a missing feature would hide a real answer.
 */
const emptyCovered = (scope) => `
  <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
    <h3 class="font-display text-base font-bold text-slate-900">${
      scope === 'portfolio' ? 'No book holding appears in this scrape' : scope === 'watchlist' ? 'None of your watchlist companies appears in this scrape' : 'Nothing resolved to a company we cover'
    }</h3>
    <p class="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">${
      scope === 'portfolio'
        ? 'The feed was read successfully; none of its entries resolved to a company in the book. That is an answer, not a gap — switch to Universe to see everything it did carry.'
        : 'The feed was read successfully; no entry resolved to a symbol in our universe or the book. Everything it carried is in the section below.'
    }</p>
  </div>`;

function buildOtherTable(rows) {
  return scoreTable({
    rows,
    key: (r) => r.slug,
    // The uncovered half is BY DEFINITION the entries that resolved to no company — that is what
    // puts them in this table — so there is nothing to star.
    watchKey: () => null,
    name: (r) => r.name,
    sub: (r) => r.slug,
    searchable: true,
    dense: true,
    wrapHeads: true,
    showAvatar: false,
    showRank: false,
    initialSort: { key: 'Mentions', dir: 'desc' },
    initialView: tableViews.other,
    exportName: 'chatter-uncovered',
    stickyHead: 'max(320px, calc(100vh - 420px))',
    columns: [
      { label: 'Mentions', get: (r) => r.mentions, align: 'right', sortable: true, sortValue: (r) => r.mentions },
      { label: 'Mentions Δ', get: mentionsDeltaCell, html: true, align: 'right', sortable: true, sortValue: (r) => r.mentionsChangePct ?? -Infinity },
      { label: 'Sentiment', get: (r) => sentimentPill(r.sentiment), html: true, sortable: true, sortValue: (r) => r.sentiment.score ?? 0 },
      { label: 'Sources', get: sourceCell, html: true },
    ],
  });
}

function unavailablePanel(reason, url) {
  // Every message here has to point at the thing that is actually wrong. The first version of this
  // map said, for `not-found`, "check that it ends in /v1 and that the API is deployed" — and the
  // API was deployed, reachable, and answering 200 to curl. The 404 came from Cloudflare refusing a
  // Worker-to-Worker subrequest, so that wording sent diagnosis to the one place with no problem.
  // A named state that names the wrong thing is worse than an unnamed one.
  const REASONS = {
    'no-url': {
      title: 'The chatter feed has no address',
      body: 'No upstream is configured. Set <code>window.SATTVA_CHATTER_URL</code> in <code>public/index.html</code> — it should end in <code>/v1</code>.',
      fix: null,
    },
    'not-found': {
      title: 'The chatter upstream answered 404',
      body:
        'The host resolved but the route was not there. Check the URL ends in <code>/v1</code>. ' +
        'If this page is being served BY a Cloudflare Worker and the upstream is another Worker on ' +
        'the same account, a 404 here may not be the upstream at all — Cloudflare blocks ' +
        'Worker-to-Worker fetches within one zone and reports it as a 404. This feed is called ' +
        'straight from the browser for that reason.',
      fix: null,
    },
    unreachable: {
      title: 'The chatter upstream could not be reached',
      body: 'The request never completed — the host is down, the network is offline, or a CORS preflight was refused. This page will retry on its own.',
      fix: null,
    },
    upstream: {
      title: 'The chatter upstream returned an error',
      body: 'It answered, but with an error status. This page will retry on its own.',
      fix: null,
    },
    shape: {
      title: 'The chatter upstream returned something unexpected',
      body: 'It answered, but not in the documented shape — their contract may have changed.',
      fix: null,
    },
  };
  const r = REASONS[reason] || {
    title: 'The chatter feed could not be read',
    body: 'No further detail was reported.',
    fix: null,
  };
  // Deliberately NOT `pendingPanel`: that draws shimmer skeletons, which promise data is on its
  // way, and it escapes its body so the command below would render as literal markup.
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
      <div class="flex items-start gap-3">
        <span class="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-amber-400"></span>
        <div class="min-w-0">
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(r.title)}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-600">${r.body}</p>
          ${r.fix ? `<pre class="mt-3 overflow-x-auto rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200">${escapeHtml(r.fix)}</pre>` : ''}
          ${url ? `<p class="mt-3 text-xs text-slate-500">Requested <code class="rounded bg-slate-100 px-1">${escapeHtml(url)}</code> — the exact address, so this can be diagnosed without guessing at it.</p>` : ''}
          <p class="mt-3 text-xs text-slate-400">Nothing is shown rather than a zero: an empty list and a list we could not read must never look the same.</p>
        </div>
      </div>
    </div>`;
}
