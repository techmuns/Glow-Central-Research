// tabs/news.js — recent news for the companies in scope.
//
// IT LOADS ON ITS OWN, AND IT DID NOT USED TO. This tab once opened on a company picker: the news
// upstream is a per-company SEARCH with no date index to flip to (announcements had one and moved
// to it), so a live walk of the universe is 603 requests against a sixty-a-minute cap, and asking
// the reader to name companies was the honest way to spend a budget that could not cover everyone.
//
// What changed is not the budget but where the rows come from. `scripts/scrape-filings.mjs` already
// walks THE BOOK FIRST on a schedule and commits the result, so the rows a scoped view needs are in
// `public/data/news.json` and cost one conditional GET — the same deal Corp Announcements and
// Insider Trades get. Measured on the shipped capture: all 123 book tickers covered, 1,217 articles,
// no failures. Making the reader pick first was spending their attention to avoid a cost that had
// already been paid.
//
// The on-demand rule is intact, which is the part worth checking if you touch this: NOTHING WALKS
// ON A PAGE LOAD. The snapshot paints, the strip says how many companies the capture has not
// checked since, and the header's Refresh button is still the only thing that sends a request per
// company.
//
// The articles are somebody else's and stay that way: the headline, the outlet and the date are
// reproduced, the article is linked, and nothing is summarised into our own words. See the header
// of tabs/filings-tab.js for the machinery all three of these tabs share.
//
// NO SENTIMENT COLUMN AND NO RANKING. The upstream returns articles in its own relevance order and
// this preserves it as the tie-break; scoring a headline as positive or negative would be a
// judgement of ours presented beside somebody else's reporting. Public Chatter already carries
// sentiment, and it is StockScans' — computed, attributed, and about forum volume rather than news.

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { withoutPublisherName } from '../core/source-copy.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { news as feed } from '../data/filings.js';
import * as marketNews from './market-news-view.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

const tab = makeFilingsTab({
  id: 'news',
  title: 'News',
  subtitle:
    'The latest stories for every company in scope, from the scheduled capture — no company to pick first. ' +
    'Refresh re-searches whatever the capture has not covered. Switch to Universe for the complete market-wide publisher feed.',
  feed,
  noun: 'articles',
  // The scrape records a company it searched and found nothing for as a single all-null row. That
  // is a statement about the SEARCH, not an article, and it must not become a row: the company is
  // still counted as covered by the note under the table.
  keepRow: (r) => !!(r.title || r.url),
  nameLabel: 'Headline',
  // WIDE, BECAUSE THE HEADLINE IS THE ROW. At 520px two genuinely different stories truncated to
  // the same string — "Buy Prestige Estates Projects; target of Rs 1…" was Prabhudas Lilladher at
  // ₹1,800 and Motilal Oswal at ₹1,830, on different days — and a table that shows the same words
  // three times reads as duplicated even when every row is a distinct article. The three columns
  // beside it are a date, an outlet and a link icon, so there is room; 1440px still fits without a
  // scrollbar of its own, which `verify-ui.mjs` measures.
  nameMaxPx: 780,
  rowName: (r) => withoutPublisherName(r.title) || '(untitled)',
  rowSub: (r) => [r.ticker, withoutPublisherName(r.source)].filter(Boolean).join(' · '),
  searchable: (r) => `${r.title || ''} ${r.source || ''} ${r.ticker || ''} ${r.summary || ''}`,
  columns: () => [
    {
      label: 'Date',
      get: (r) => (r.date ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}</span>` : dash('the article carried no readable date')),
      html: true,
      // A row with no date sorts last rather than first. An unreadable date is not "today".
      sortValue: (r) => r.date || '',
    },
    {
      label: 'Outlet',
      get: (r) => (r.source ? `<span class="text-slate-600">${escapeHtml(withoutPublisherName(r.source))}</span>` : dash('the article named no outlet')),
      html: true,
      sortValue: (r) => r.source || '',
    },
  ],
  filters: (rows) => {
    const outlets = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
    if (outlets.length < 2) return null;
    return [
      {
        label: 'Outlet',
        options: [{ value: 'all', label: 'All outlets' }, ...outlets.slice(0, 40).map((o) => ({ value: o, label: withoutPublisherName(o) }))],
        match: (r, v) => r.source === v,
      },
    ];
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Company news</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real, and not ours.</strong> Articles come from the Muns news API
           (<code class="rounded bg-slate-100 px-1">POST /tools/news-search</code>), one search per company, read through this
           dashboard's Worker because the API needs a credential the browser must never hold.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why this tab asks before it searches</h3>
        <p class="mt-1 text-xs">It is a <strong>search endpoint, not a feed</strong> — there is no request that returns
           everything published today, only one that answers “what has been written about this company”. At roughly sixty
           requests a minute, searching the whole universe would take ten minutes on every visit, so this tab used to walk a
           bounded forty companies and report the rest as unread. Naming the companies spends the same budget on the ones
           you actually want, and <strong>every company you name is searched in full</strong>. Corporate Announcements does
           not ask, because BSE publish that one indexed by date and the whole exchange fits in a couple of dozen requests.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is reproduced and what is not</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Headline, outlet and date</strong> — the upstream's, unchanged.</li>
          <li><strong>The article itself</strong> — not here. Every row links to the publisher, and nothing is summarised
              into our words.</li>
          <li><strong>No sentiment, no ranking of ours.</strong> Articles keep the order the API returned them in. Scoring a
              headline would put our judgement beside somebody else's reporting.</li>
          <li><strong>The company a story is filed under</strong> is ours — it is the search term, not something the article
              declares. A story can be about several companies and will appear under whichever we asked about.</li>
        </ul>

        ${coverageBlock(m)}

        <p class="mt-4 text-xs text-slate-500">A dash means <em>the article did not carry it</em> — never zero, and never a
           date we guessed.</p>
      </div>
    </div>`,
  onExport: async (visible, m, win) => {
    await exportRows({
      filename: 'glow-news',
      sheetName: 'News',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `REAL DATA, NOT OURS. Company news via the Muns news API, exported ${new Date().toISOString()}. ` +
                `THESE ROWS ARE THE HISTORY WINDOW THE READER SELECTED: ${win.describeRange(win.range)}${win.range.from ? ` (${win.range.from} to ${win.range.to})` : ''}. ` +
                `The capture this device holds runs ${win.held.first || 'no dated rows'}${win.held.first ? ` to ${win.held.last}` : ''}, so anything earlier than that was never captured rather than absent. ` +
                `HEADLINES, OUTLETS AND DATES ARE THE PUBLISHERS' — reproduced unchanged, never summarised into our words, and carrying no sentiment or ranking of ours. ` +
                `The company each story is filed under is OUR search term, not a claim by the article: a story about several companies appears under whichever was asked about. ` +
                `${m.covered} companies covered${m.failed ? `; ${m.failed} could not be read and are ABSENT rather than shown as having no news` : ''}. ` +
                `A blank means the article did not carry that field.`
              : r.date || '',
        },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Headline', key: 'h', width: 70, get: (r) => (r.__banner ? '' : withoutPublisherName(r.title)) },
        { header: 'Outlet', key: 'o', width: 24, get: (r) => (r.__banner ? '' : withoutPublisherName(r.source)) },
        { header: 'URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
        { header: 'Summary (publisher)', key: 's', width: 80, get: (r) => (r.__banner ? '' : withoutPublisherName(r.summary)) },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;

// ---------------------------------------------------------------------------------------
// TWO FEEDS UNDER ONE TAB, CHOSEN BY THE SCOPE TOGGLE
//
// Portfolio scope keeps the per-company search: the Muns news API answers one company at a time,
// so the reader names the companies and each is searched in full.
//
// Universe scope cannot work that way — 603 searches is ten minutes of somebody else's service —
// so it asks a different question entirely: not "what has been written about these companies" but
// "what has been published". Moneycontrol publish exactly that, market-wide, and a scheduled
// Action captures it because neither the browser nor the Worker can read their site (403 by TLS
// fingerprint, measured both ways — see js/data/market-news.js).
//
// The two halves are DIFFERENT PUBLISHERS ANSWERING DIFFERENT QUESTIONS, and each says so in its
// own description. A reader flipping the toggle must never have to guess why the rows changed
// completely; that is also why neither half is presented as a subset of the other.
//
// `render()` runs on every scope change, so it must tear the OTHER half down — otherwise the
// unmounted view keeps its subscription and repaints into a root that now belongs to the other
// feed. `destroy()` is only called when leaving the tab entirely, which is too late for that.
// ---------------------------------------------------------------------------------------

let mounted = null; // 'universe' | 'companies'

export function render(ctx) {
  // MARKET-WIDE NEWS CARRIES NO COMPANY, so it cannot be narrowed to a book or a watchlist — see
  // the chatter rule in CLAUDE.md: filtering rows that have no ticker BY ticker would report "your
  // companies are not in the news" when the truth is that nothing on those rows says whose they
  // are. Universe gets the market-wide capture; both narrowed scopes get the per-company search.
  const wanted = ctx.scope === 'universe' ? 'universe' : 'companies';
  if (mounted && mounted !== wanted) {
    if (mounted === 'universe') marketNews.destroy();
    else tab.destroy();
  }
  mounted = wanted;
  if (wanted === 'universe') marketNews.render(ctx);
  else tab.render(ctx);
}

export function destroy() {
  if (mounted === 'universe') marketNews.destroy();
  else if (mounted === 'companies') tab.destroy();
  mounted = null;
}
