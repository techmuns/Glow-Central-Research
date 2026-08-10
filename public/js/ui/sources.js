// ui/sources.js — the data-source registry behind the header's "Sources" button.
//
// This is presentation metadata, not a data source: it mirrors docs/DATA-CONTRACTS.md so a
// user can see, in one place, everything that feeds the dashboard and how fresh it is.
//
// KEEPING THIS ACCURATE IS PART OF ADDING A DATA SOURCE. When a later prompt wires a real
// feed, update three things together: the JSON contract in docs/DATA-CONTRACTS.md, the loader
// in js/app.js, and the entry here. `status` is the honest current state:
//   'live'    — a real feed is wired and refreshing
//   'mock'    — placeholder data ships in the repo; the real source is named but not connected
//   'pending' — nothing exists yet; named so the gap is visible rather than hidden

export const SOURCE_GROUPS = [
  {
    title: 'Market data',
    icon: '💹',
    tabs: 'Breakouts / Technical · Portfolio Analytics',
    items: [
      {
        name: 'Yahoo Finance — EOD OHLCV',
        url: 'https://finance.yahoo.com',
        feeds: 'Daily close, volume, 50/100/200-DMA and 52-week range for the NSE 500. Also becomes the mark-to-market price behind portfolio P&L and drawdown.',
        cadence: 'Daily after close · GitHub Actions',
        status: 'pending',
        file: 'public/data/technicals.json',
      },
      {
        name: 'NSE 500 constituent list',
        url: 'https://www.nseindia.com/products-services/indices-nifty500-index',
        feeds: 'The coverage universe — ticker, name, sector, industry and market cap.',
        cadence: 'Quarterly for constituents, daily for market cap',
        status: 'mock',
        file: 'public/data/universe.json',
      },
    ],
  },
  {
    title: 'Earnings & filings',
    icon: '📊',
    tabs: 'Earnings Hub · Breakouts → Earnings Surprise',
    items: [
      {
        name: 'BSE / NSE corporate filings',
        url: 'https://www.bseindia.com/corporates/Comp_Resultsnew.aspx',
        feeds: 'Reported quarterly revenue, PAT and EPS — the actuals behind every result row.',
        cadence: 'Event-driven during results season (Jan/Apr/Jul/Oct)',
        status: 'mock',
        file: 'public/data/mock/earnings.json',
      },
      {
        name: 'Screener.in / Trendlyne — consensus',
        url: 'https://www.screener.in/',
        feeds: 'Street EPS estimates, used to compute the beat/miss surprise percentage.',
        cadence: 'Refreshed alongside each result',
        status: 'mock',
        file: 'public/data/mock/earnings.json',
      },
    ],
  },
  {
    title: 'Con-call transcripts',
    icon: '🎙️',
    tabs: 'Con-call',
    items: [
      {
        name: 'Exchange filing transcripts',
        url: 'https://www.bseindia.com/corporates/Comp_Resultsnew.aspx',
        feeds: 'Management commentary lines, keyword hits, catalyst tagging and the Deep Dive transcript.',
        cadence: 'Polled every 12s while the tab is open (mock today)',
        status: 'mock',
        file: 'public/data/mock/concall-feed.json',
      },
      {
        name: 'Keyword set (user-owned)',
        url: null,
        feeds: 'The 9 default scan keywords — guidance, margin, capex, order book, attrition, debt reduction, capacity expansion, management change, pricing pressure.',
        cadence: 'User-edited; hit counts recomputed with the feed',
        status: 'mock',
        file: 'public/data/mock/concall-keywords.json',
      },
    ],
  },
  {
    title: 'Public chatter',
    icon: '💬',
    tabs: 'Public Chatter',
    items: [
      {
        name: 'ValuePickr forum',
        url: 'https://forum.valuepickr.com/',
        feeds: 'Thread titles, post excerpts, reply counts and per-post sentiment.',
        cadence: 'Every 15 minutes',
        status: 'mock',
        file: 'public/data/mock/chatter.json',
      },
      {
        name: 'Telegram channels (Bot API)',
        url: 'https://core.telegram.org/bots/api',
        feeds: 'Messages and forward counts from subscribed research channels.',
        cadence: 'Near real-time',
        status: 'mock',
        file: 'public/data/mock/chatter.json',
      },
    ],
  },
  {
    title: 'Shareholding & flows',
    icon: '🤝',
    tabs: 'Super Investors · Breakouts → FII Accumulation',
    items: [
      {
        name: 'Ticker Finology — superstar investors',
        url: 'https://ticker.finology.in/',
        feeds: 'Disclosed superstar-investor positions: action, quantity change and holding percentage.',
        cadence: 'Quarterly, 3–6 weeks after quarter end',
        status: 'mock',
        file: 'public/data/mock/superinvestors.json',
      },
      {
        name: 'AMFI — monthly portfolio disclosures',
        url: 'https://www.amfiindia.com/',
        feeds: 'Mutual fund holdings, the MF slice of domestic institutional ownership.',
        cadence: 'Monthly',
        status: 'mock',
        file: 'public/data/mock/institutions.json',
      },
      {
        name: 'Trendlyne / BSE shareholding patterns',
        url: 'https://trendlyne.com/',
        feeds: 'FII and DII holding percentages and their quarter-on-quarter change.',
        cadence: 'Quarterly with the shareholding filings',
        status: 'mock',
        file: 'public/data/mock/institutions.json',
      },
    ],
  },
  {
    title: 'Portfolio',
    icon: '💼',
    tabs: 'Portfolio Analytics',
    items: [
      {
        name: 'Holdings (user-maintained)',
        url: null,
        feeds: 'Tracked positions: quantity, average cost, sector and conviction tier.',
        cadence: 'User-edited; no automated refresh',
        status: 'mock',
        file: 'public/data/portfolio.json',
      },
      {
        name: 'Broker contract notes',
        url: null,
        feeds: 'The buy/sell ledger behind the book — Zerodha / Groww / ICICI Direct import.',
        cadence: 'Event-driven, per trade',
        status: 'mock',
        file: 'public/data/mock/transactions.json',
      },
    ],
  },
];

const STATUS_CHIP = {
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  mock: 'bg-amber-50 text-amber-700 ring-amber-200',
  pending: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const STATUS_LABEL = { live: 'Live', mock: 'Mock data', pending: 'Not yet built' };

// Renders the Sources modal body. Kept here (beside the data) so the two never drift.
export function sourcesModalHtml() {
  const total = SOURCE_GROUPS.reduce((n, g) => n + g.items.length, 0);
  const live = SOURCE_GROUPS.flatMap((g) => g.items).filter((i) => i.status === 'live').length;

  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">All Data Sources</h2>
          <p class="mt-1 text-sm text-slate-500">
            Every source that feeds this dashboard, grouped by the tabs it serves.
            <span class="font-semibold text-slate-700">${live} of ${total}</span> are wired to a live feed today —
            the rest ship with mock data and are labelled as such.
          </p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      </div>

      <div class="space-y-5">
        ${SOURCE_GROUPS.map(
          (g) => `
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <span class="text-base">${g.icon}</span>
              <h3 class="text-xs font-bold uppercase tracking-wider text-indigo-700">${g.title}</h3>
              <span class="text-[11px] text-slate-400">${g.tabs}</span>
            </div>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              ${g.items
                .map((it) => {
                  const inner = `
                    <div class="mb-1 flex items-start justify-between gap-2">
                      <span class="text-sm font-semibold text-slate-900 ${it.url ? 'group-hover:text-indigo-700' : ''}">${it.name}</span>
                      <span class="inline-flex flex-shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1 ${STATUS_CHIP[it.status]}">${STATUS_LABEL[it.status]}</span>
                    </div>
                    <div class="text-[11px] leading-snug text-slate-500">${it.feeds}</div>
                    <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400">
                      <span class="font-medium text-slate-500">${it.cadence}</span>
                      <span>·</span>
                      <code class="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">${it.file}</code>
                    </div>`;
                  return it.url
                    ? `<a href="${it.url}" target="_blank" rel="noopener"
                         class="group block rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70 transition hover:bg-indigo-50/60 hover:ring-indigo-200">${inner}</a>`
                    : `<div class="block rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">${inner}</div>`;
                })
                .join('')}
            </div>
          </div>`
        ).join('')}
      </div>

      <div class="mt-6 border-t border-slate-100 pt-4 text-[11px] leading-relaxed text-slate-400">
        Full field-level contracts — exact JSON shapes, units and refresh cadence — live in
        <code class="rounded bg-slate-100 px-1 py-0.5">docs/DATA-CONTRACTS.md</code>.
      </div>
    </div>`;
}
