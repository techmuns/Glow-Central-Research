// tabs/news.js — recent news for the companies in scope.
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
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { news as feed } from '../data/filings.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

const tab = makeFilingsTab({
  id: 'news',
  title: 'News',
  subtitle: 'Choose one or more companies and each is searched in full. Headlines and outlets are the publishers’ own; the article stays where it is published.',
  feed,
  // THE READER NAMES THE COMPANIES. See the header of filings-tab.js: the news upstream is a
  // per-company search with no date index to flip to, so the request budget goes where it was
  // asked to go rather than to forty companies chosen for the reader.
  requireSelection: true,
  noun: 'articles',
  nameLabel: 'Headline',
  // WIDE, BECAUSE THE HEADLINE IS THE ROW. At 520px two genuinely different stories truncated to
  // the same string — "Buy Prestige Estates Projects; target of Rs 1…" was Prabhudas Lilladher at
  // ₹1,800 and Motilal Oswal at ₹1,830, on different days — and a table that shows the same words
  // three times reads as duplicated even when every row is a distinct article. The three columns
  // beside it are a date, an outlet and a link icon, so there is room; 1440px still fits without a
  // scrollbar of its own, which `verify-ui.mjs` measures.
  nameMaxPx: 780,
  rowName: (r) => r.title || '(untitled)',
  rowSub: (r) => [r.ticker, r.source].filter(Boolean).join(' · '),
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
      get: (r) => (r.source ? `<span class="text-slate-600">${escapeHtml(r.source)}</span>` : dash('the article named no outlet')),
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
        options: [{ value: 'all', label: 'All outlets' }, ...outlets.slice(0, 40).map((o) => ({ value: o, label: o }))],
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
  onExport: async (visible, m) => {
    await exportRows({
      filename: 'sattva-news',
      sheetName: 'News',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `REAL DATA, NOT OURS. Company news via the Muns news API, reaching back ${m.windowDays} days, exported ${new Date().toISOString()}. ` +
                `HEADLINES, OUTLETS AND DATES ARE THE PUBLISHERS' — reproduced unchanged, never summarised into our words, and carrying no sentiment or ranking of ours. ` +
                `The company each story is filed under is OUR search term, not a claim by the article: a story about several companies appears under whichever was asked about. ` +
                `${m.covered} companies covered${m.failed ? `; ${m.failed} could not be read and are ABSENT rather than shown as having no news` : ''}. ` +
                `A blank means the article did not carry that field.`
              : r.date || '',
        },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Headline', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.title || '') },
        { header: 'Outlet', key: 'o', width: 24, get: (r) => (r.__banner ? '' : r.source || '') },
        { header: 'URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
        { header: 'Summary (publisher)', key: 's', width: 80, get: (r) => (r.__banner ? '' : r.summary || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;
export const render = tab.render;
export const destroy = tab.destroy;
