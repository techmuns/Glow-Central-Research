// ui/sources.js — the data-source registry behind the header's "Sources" button.
//
// This is presentation metadata, not a data source: it mirrors docs/DATA-CONTRACTS.md so a
// user can see, in one place, everything that feeds the dashboard and how fresh it is.
//
// KEEPING THIS ACCURATE IS PART OF ADDING A DATA SOURCE. When a real feed is wired,
// update three things together: the JSON contract in docs/DATA-CONTRACTS.md, the loader
// in js/app.js, and the entry here. `status` is the honest current state:
//   'live'    — a real feed is wired and refreshing on a schedule
//   'static'  — real data, committed to the repo, refreshed by hand rather than on a cron
//   'mock'    — placeholder data ships in the repo; the real source is named but not connected
//   'pending' — nothing exists yet; named so the gap is visible rather than hidden

import { escapeHtml } from '../core/dom.js';
import { formatRelativeTime } from '../core/format.js';

/**
 * "How this reached you" — the line every polled feed's provenance modal carries.
 *
 * A cached feed is the one case where the number on screen can be older than the moment you are
 * looking at it, so the reader is owed two separate facts, not one: when the upstream was actually
 * read (`fetchedAt`), and when we last confirmed that reading was still current (`checkedAt`). A
 * 304 moves the second and not the first, and collapsing them into a single "last updated" would
 * make a five-hour-old figure look like it arrived seconds ago.
 *
 * `origin` is where THIS paint came from: 'live' from the network, 'store' from this device's own
 * copy, 'snapshot' from the file committed to the repo.
 */
export function deliveryNote(meta, { poll } = {}) {
  if (!meta) return '';
  const stamp = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    return Number.isFinite(t) ? formatRelativeTime(t) : null;
  };
  const read = stamp(meta.fetchedAt);
  const checked = stamp(meta.checkedAt);
  const stale = meta.origin === 'store' && !checked;

  const where =
    meta.origin === 'snapshot'
      ? 'the snapshot committed to this repo'
      : meta.origin === 'store'
        ? 'this device&rsquo;s own cached copy'
        : 'the live feed';

  return `
    <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How this reached you</h3>
    <p class="mt-1 text-xs leading-relaxed text-slate-500">
      Painted from <strong>${where}</strong>${meta.persisted === false ? ' <span class="text-slate-400">(storage unavailable in this browser, so it lasts for this session only)</span>' : ''}.
      ${read ? `Upstream was read <strong>${escapeHtml(read)}</strong>` : 'The upstream read time is unknown'}${
        checked ? `, and last confirmed still current <strong>${escapeHtml(checked)}</strong>.` : '.'
      }
      ${stale ? '<span class="text-amber-700">The feed could not be reached this visit, so this copy has not been confirmed.</span>' : ''}
    </p>
    <p class="mt-1 text-xs leading-relaxed text-slate-500">
      ${poll ? `Polled every ${poll} seconds. ` : ''}Each poll sends the fingerprint of the copy already held, so an unchanged
      feed answers with <strong>no data at all</strong> rather than resending itself. The full payload crosses the wire only
      when something in it actually changed.
    </p>`;
}

export const SOURCE_GROUPS = [
  {
    title: 'Market data',
    icon: '💹',
    tabs: 'Breakouts / Technical · Portfolio Analytics',
    items: [
      {
        name: 'Yahoo Finance — EOD OHLCV',
        url: 'https://finance.yahoo.com',
        feeds: 'Daily close and volume for the NSE 500 plus the Nifty 500 index (^CRSLDX). Every technical indicator on the Breakouts tab — EMA/SMA, RSI, MACD, ADX, ATR, beta, relative strength, breakout and base patterns — is computed from this.',
        cadence: 'Weekdays 07:00 IST · GitHub Actions',
        status: 'live',
        file: 'public/data/technicals.json',
      },
      {
        name: 'NSE bhavcopy — delivery %',
        url: 'https://www.nseindia.com/all-reports',
        feeds: 'Daily DELIV_PER from sec_bhavdata_full over the last ~30 trading days, folded into the Delivery Percentage rule as a recent-half vs older-half trend.',
        cadence: 'Weekdays 07:00 IST, alongside the technicals scrape',
        status: 'live',
        file: 'public/data/technicals.json',
      },
      {
        name: 'ATR trend accumulator',
        url: null,
        feeds: 'A rolling 30-day history of each ticker\'s ATR%, appended one snapshot per scrape. The ATR Stability rule needs ≥10 days before it can call the trend declining, stable or rising.',
        cadence: 'One snapshot per technicals run',
        status: 'live',
        file: 'public/data/atr-history.json',
      },
      {
        name: 'Munshot quote API — live prices',
        url: 'https://muns.io',
        feeds: 'On-demand intraday quotes behind the Breakouts tab\'s "Refresh prices" button, proxied server-side by the Worker so no token reaches the browser. Session-only; nothing is written to the repo.',
        cadence: 'On demand · needs the Cloudflare Worker',
        status: 'live',
        file: 'worker/index.js · POST /api/live-prices',
      },
      {
        name: 'NSE 500 constituent list (Screener export)',
        url: 'https://www.screener.in/',
        feeds: 'The coverage universe — 535 companies with name, Screener URL, market cap, sector/industry and the FII/DII holding changes the Institutional Activity rule scores.',
        cadence: 'Manual re-export; constituents change quarterly',
        status: 'static',
        file: 'public/data/universe.json',
      },
      {
        name: 'TradingView — indicator overlay',
        url: 'https://in.tradingview.com/',
        feeds: 'Optional. When a scrape is wired up it overwrites RSI, ADX, EMA-50, SMA-50 and SMA-200 with the values an analyst sees on TradingView, and the drill panel re-points those rules\' Source chip accordingly. The file ships empty today.',
        cadence: 'Not yet scheduled',
        status: 'pending',
        file: 'public/data/technicals-source.json',
      },
    ],
  },
  {
    title: 'Earnings & filings',
    icon: '📊',
    tabs: 'Earnings Hub · Breakouts → Earnings Surprise',
    items: [
      {
        name: 'Moneycontrol — Rapid Results',
        url: 'https://www.moneycontrol.com/markets/earnings/latest-results/',
        feeds:
          'The Earnings Hub, live. Revenue, gross profit and net profit for every listed company that has reported this quarter, with the prior-year comparison — 1,319 companies in the current pull. Proxied through <code class="rounded bg-slate-100 px-1">/api/earnings</code> behind a 30-second edge cache and polled by the browser, so a company that files appears within about a minute without a rebuild or a page reload.',
        cadence: 'Live — 30s edge cache, 30s client poll. A daily snapshot is committed as the first paint and the offline fallback.',
        status: 'live',
        file: 'worker/index.js → /api/earnings · public/data/earnings-live.json · scripts/scrape-earnings.mjs',
      },
      {
        name: 'Moneycontrol price feed — identity and share count',
        url: 'https://www.moneycontrol.com/',
        feeds:
          'Resolves Moneycontrol\'s internal company code to an NSE ticker, and carries the industry and shares outstanding. This is the join that makes the results feed usable: upstream names are truncated to 15 characters, so the code is the only safe key. The share count is what lets market cap be computed live (shares × current price) rather than going stale between refreshes.',
        cadence: 'Incremental — only companies never seen before are resolved; refreshed in full weekly',
        status: 'live',
        file: 'public/data/mc-ticker-map.json · scripts/scrape-earnings.mjs',
      },
      {
        name: 'Yahoo Finance — result-day closes',
        url: 'https://finance.yahoo.com/',
        feeds:
          'The base price for the <strong>Return since result</strong> column: the close on the date each company reported. A past close never changes, so each is fetched once and cached forever; the current price arrives live with every poll, which is what makes the column move without refetching any history.',
        cadence: 'Incremental — one call per newly-reported company, on the daily refresh',
        status: 'live',
        file: 'public/data/result-returns.json · scripts/scrape-result-returns.mjs',
      },
      {
        name: 'BSE / NSE corporate filings',
        url: 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results',
        feeds:
          'Eight quarters of revenue, operating profit, PAT, EPS, other income, exceptional items and tax — the actuals behind the 15-rule quality score used by <strong>Breakouts → Earnings Surprise</strong>. <strong class="text-amber-700">Synthetic today:</strong> generated by <code class="rounded bg-amber-100 px-1">scripts/gen-mock-earnings.mjs</code> (seed 20260810), with real names, tickers, sectors and market caps. The Earnings Hub no longer uses this — it is live off Moneycontrol above.',
        cadence: 'Event-driven during results season — not yet connected',
        status: 'mock',
        file: 'public/data/mock/earnings.json · scripts/gen-mock-earnings.mjs',
      },
      {
        name: 'Screener.in / Trendlyne — consensus',
        url: 'https://www.screener.in/',
        feeds:
          'Street EPS and revenue estimates behind the two Surprise rules and the beat/miss tag in Breakouts. <strong class="text-amber-700">Synthetic today:</strong> generated alongside the actuals, so a beat is an artefact of the generator, not of the street.',
        cadence: 'Refreshed alongside each result — not yet connected',
        status: 'mock',
        file: 'public/data/mock/earnings.json · scripts/gen-mock-earnings.mjs',
      },
      {
        name: 'Moneycontrol — Results Calendar (counts)',
        url: 'https://www.moneycontrol.com/markets/earnings/results-calendar/',
        feeds:
          'The Earnings Hub\'s <strong>Earnings Calendar</strong> view: how many companies are scheduled to report on each date. Complete and unpaginated — this is the authoritative count behind every chip in the date strip.',
        cadence: 'Live — 5-minute edge cache. A schedule moves in hours, not ticks.',
        status: 'live',
        file: 'worker/index.js → /api/earnings-calendar · worker/mc.mjs → fetchCalendarStrip()',
      },
      {
        name: 'Moneycontrol — Results Calendar (company list)',
        url: 'https://www.moneycontrol.com/markets/earnings/results-calendar/',
        feeds:
          'The named companies for the selected date, with quarter, scheduled time, price and market cap. <strong>Partial by construction:</strong> Moneycontrol publishes the <strong>20 largest by market cap</strong> per date and offers no way to page past it — the JSON route its own "load more" uses is blocked to non-browser clients. So the table names 20 of however many the count says, and states that under itself. <strong>And it is read from a capture, not live, wherever the server is refused:</strong> this list exists only inside the calendar page\'s HTML, which sits behind Akamai and answers a Cloudflare Worker with a page carrying no data. The scheduled job captures it from a runner the page does answer, and the tab shows a <em>Captured</em> pill with the age instead of a Live one.',
        cadence: 'Live when the page answers; otherwise the daily capture, labelled with its age',
        status: 'live',
        file: 'worker/index.js → /api/earnings-calendar · worker/mc.mjs → fetchCalendarDay() · public/data/earnings-calendar.json · scripts/scrape-calendar.mjs',
      },
    ],
  },
  {
    title: 'Con-call scans',
    icon: '🎙️',
    tabs: 'Con-call',
    items: [
      {
        name: 'StockScans — Concall Scans',
        url: 'https://www.stockscans.in/concall-scans',
        feeds:
          'The whole Con-call tab: every earnings call held this quarter (877 in the current pull) with StockScans\' own <strong>result score</strong> (0–100), <strong>management sentiment tier</strong> (Bullish → Bearish) and three highlight bullets per call, plus the schedule of calls not yet held, behind the <strong>Upcoming Concalls</strong> button. <strong>These are StockScans\' numbers, not ours</strong> — reproduced unchanged, with their published tier bands, and this dashboard adds no scoring of its own on top. Full summaries and transcripts stay on StockScans; every row links to theirs.',
        cadence: 'Live — 30s edge cache on the newest page, 30s client poll. A call analysed at 14:32 is on screen by ~14:33.',
        status: 'live',
        file: 'worker/index.js → /api/concalls · worker/stockscans.mjs · public/data/concall-scans.json · scripts/scrape-concalls.mjs',
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
        feeds:
          'Thread titles, post bodies, participant counts and per-post sentiment for 40 company threads, plus the claims extracted from them. <strong class="text-amber-700">Synthetic today:</strong> generated by <code class="rounded bg-amber-100 px-1">scripts/gen-mock-chatter.mjs</code> (seed 20260812). <strong class="text-amber-700">Every handle is fictional</strong> and the thread URLs do not resolve — a forum handle belongs to a real person, and attaching invented opinions to one misattributes speech.',
        cadence: 'Every 15 minutes — not yet connected',
        status: 'mock',
        file: 'public/data/mock/chatter-valuepickr.json · scripts/gen-mock-chatter.mjs',
      },
      {
        name: 'Telegram channels (Bot API)',
        url: 'https://core.telegram.org/bots/api',
        feeds:
          'Message volume, distinct sender counts, forward ratios and sentiment across 25 public groups — the raw inputs the pump-risk flag is computed from. <strong class="text-amber-700">Synthetic today</strong>, with fictional group names and handles.',
        cadence: 'Near real-time — not yet connected',
        status: 'mock',
        file: 'public/data/mock/chatter-telegram.json · scripts/gen-mock-chatter.mjs',
      },
      {
        name: 'Pump-risk heuristic (computed)',
        url: null,
        feeds:
          '<strong>Not a feed — derived in the browser.</strong> A 0–3 flag from a volume gate plus three signals: sender concentration, forward ratio and uniform bullishness. Every row shows which criteria fired and their measured values, because a risk score nobody can check is just a verdict. Thresholds are named constants in the module.',
        cadence: 'Recomputed on every render and on every live tick',
        status: 'static',
        file: 'public/js/chatter/pump-risk.js',
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
        feeds:
          'Disclosed positions for eight tracked individual investors across four quarters: holding percentage, quantity and the quarter-on-quarter action. <strong class="text-amber-700">The names are real; the positions are not.</strong> These are real public investors whose genuine shareholdings appear in quarterly exchange filings. Every position here is synthetic, from <code class="rounded bg-amber-100 px-1">scripts/gen-mock-investors.mjs</code> (seed 20260813). The data set carries numbers only — no quote, view or rationale is attributed to any of them.',
        cadence: 'Quarterly, 3–6 weeks after quarter end — not yet connected',
        status: 'mock',
        file: 'public/data/mock/superinvestors.json · scripts/gen-mock-investors.mjs',
      },
      {
        name: 'AMFI — monthly portfolio disclosures',
        url: 'https://www.amfiindia.com/',
        feeds:
          'Mutual fund scheme holdings and monthly category flows (equity, large / mid / small cap). Feeds the category small-multiples and the not-yet-wired fund cards. <strong class="text-amber-700">Synthetic today</strong>, including the AUM and scheme counts shown against each real fund name.',
        cadence: 'Monthly — not yet connected',
        status: 'mock',
        file: 'public/data/mock/institutions.json · public/data/mock/fund-flows.json',
      },
      {
        name: 'Trendlyne — superstar shareholdings (filed)',
        url: 'https://trendlyne.com/portfolio/superstar-shareholders/54015/latest/smallcap-world-fund-inc/',
        feeds:
          '<strong>Real filings.</strong> Indian companies file their shareholding pattern with the exchanges every quarter, naming each holder above 1% with a share count and a percentage of the company; Trendlyne aggregate those filings by holder. Wired for <strong>Smallcap World Fund Inc</strong> (Capital Group) — 37 Indian holdings worth ₹35,818 Cr as of Jun 2026, with nine quarters of filed history each, plus 35 companies it previously held. <strong>Share counts and percentages are the filings; the ₹ value is Trendlyne\'s own derivation</strong> (holding % × market cap), reproduced unchanged and attributed rather than recomputed. A blank percentage means the company has not filed yet, not that the position was sold.',
        cadence: 'Quarterly, as filings arrive over the weeks after a quarter closes · re-run the scraper',
        status: 'live',
        file: 'public/data/institution-holdings.json · scripts/scrape-institution-holdings.mjs · scripts/lib/trendlyne.mjs',
      },
      {
        name: 'Trendlyne / BSE — the funds not yet wired',
        url: 'https://trendlyne.com/',
        feeds:
          'Seven more institutions and the FII/DII monthly net flow series. <strong class="text-amber-700">Synthetic today</strong>: real fund names, invented positions. They are <strong>not shown on the Institutions view</strong> — that page is the filed table above and nothing else — and now feed only Fund Flows\u2019 category charts. Wiring one for real is a single entry in <code class="rounded bg-slate-100 px-1">FUNDS</code> in the scraper above. Note the real FII/DII holding <em>changes</em> already reach the dashboard through the technicals scrape — Fund Flows joins to those and labels which columns are which.',
        cadence: 'Quarterly with the shareholding filings — not yet connected',
        status: 'mock',
        file: 'public/data/mock/institutions.json · public/data/mock/fund-flows.json',
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
        feeds:
          'The holdings list — tickers, names, sectors, conviction tiers. Quantity and average cost are NOT edited here: ' +
          'they are derived from a FIFO replay of the ledger below, so the position table and the ledger cannot disagree.',
        cadence: 'User-edited; qty/avgPrice regenerated with the ledger',
        status: 'mock',
        file: 'public/data/portfolio.json',
      },
      {
        name: 'Broker contract notes',
        url: null,
        feeds:
          'The buy/sell/dividend/corporate-action ledger behind the book. Which trades were made and when is synthetic; ' +
          'every execution price in it is a real Yahoo close on a real trading day. CSV import parses in-browser and lasts until reload.',
        cadence: 'Event-driven, per trade · regenerate with scripts/gen-mock-transactions.mjs',
        status: 'mock',
        file: 'public/data/mock/transactions.json',
      },
      {
        name: 'Yahoo Finance — daily closes, 3 years',
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/',
        feeds:
          'The equity curve and every drawdown figure. Daily closes for each ticker the ledger touches plus the Nifty 500 ' +
          '(^CRSLDX) benchmark. Tickers Yahoo will not serve are recorded in failures[] and named in the UI, never dropped.',
        cadence: 'Weekdays 07:00 IST via GitHub Actions, alongside the technicals refresh',
        status: 'live',
        file: 'public/data/portfolio-history.json',
      },
    ],
  },
];

const STATUS_CHIP = {
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  static: 'bg-blue-50 text-blue-700 ring-blue-200',
  mock: 'bg-amber-50 text-amber-700 ring-amber-200',
  pending: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const STATUS_LABEL = { live: 'Live', static: 'Real · manual', mock: 'Mock data', pending: 'Not yet built' };

// Renders the Sources modal body. Kept here (beside the data) so the two never drift.
export function sourcesModalHtml() {
  const items = SOURCE_GROUPS.flatMap((g) => g.items);
  const total = items.length;
  const live = items.filter((i) => i.status === 'live').length;
  const realStatic = items.filter((i) => i.status === 'static').length;

  return `
    <div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
      <div class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">All Data Sources</h2>
          <p class="mt-1 text-sm text-slate-500">
            Every source that feeds this dashboard, grouped by the tabs it serves.
            <span class="font-semibold text-slate-700">${live} of ${total}</span> are wired to a live feed today,
            ${realStatic} more carry real data refreshed by hand — the rest ship with mock data and are labelled as such.
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
        <p><strong class="text-slate-500">Kept on this device.</strong> The results feed and the con-call scan are large and
        polled, so the copy last received is stored in this browser and reused on the next visit. Every poll sends its
        fingerprint and an unchanged feed replies with nothing at all, so what travels is only what actually changed.
        A cached paint is never presented as a live one — each of those tabs' Live pill says where the figures on screen
        came from and when the feed was last confirmed. Nothing is stored for a feed you have not opened, and clearing
        this site&rsquo;s data removes it.</p>
        <p class="mt-2">Full field-level contracts — exact JSON shapes, units and refresh cadence — live in
        <code class="rounded bg-slate-100 px-1 py-0.5">docs/DATA-CONTRACTS.md</code>.</p>
      </div>
    </div>`;
}
