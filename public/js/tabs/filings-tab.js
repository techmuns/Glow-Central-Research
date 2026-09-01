// tabs/filings-tab.js — the shared body of the News, Corporate Announcements and Insider Trades tabs.
//
//   makeFilingsTab({ id, title, ... })  ->  { meta, render, destroy }
//
// THREE TABS, ONE RENDERER, because the reader is doing the same job in all three: scan a dated
// list of things that happened to the companies in scope, filter it, and click out to the source.
// What differs is the columns and the words, and both are arguments.
//
// NO SCORE AND NO SIGNALS ON ANY OF THEM, deliberately. There is no model behind these feeds, so
// `showScore` and `showSignals` stay off rather than rendering empty score furniture — see the
// honesty rules in CLAUDE.md. A "sentiment" or "importance" column here would be a judgement of
// ours dressed as a reading of theirs.
//
// EVERY ROW LINKS OUT AND NOTHING IS REPRODUCED IN FULL. These are headlines and filing subjects,
// which are the upstream's words; the article and the PDF stay where they are published. Same rule
// as the con-call tab: surface the index, link to the content.
//
// THE SCOPE TOGGLE IS THE POINT OF THE TAB. Portfolio narrows to the book's tickers, Watchlist to
// the companies the reader starred, and Universe widens to everything the snapshot covers. All
// three print their denominator — a list of 40 rows looks complete until you know how many
// companies were asked about.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { deliveryNote } from '../ui/sources.js';
import * as coverage from '../data/coverage.js';
import { scopeTickers, scopePossessive } from '../data/scope.js';
import * as watchlist from '../core/watchlist.js';
import * as refreshRegistry from '../core/refresh.js';

const REASONS = {
  'no-route': {
    title: 'This feed needs the Worker',
    body: 'This origin serves the static files only, so there is no <code>/api/</code> route to answer, and no committed snapshot has been written yet. Run <code>npx wrangler dev</code>, or open the deployed site.',
  },
  'no-token': {
    title: 'No API token is configured',
    body: 'These feeds need a bearer token and this deployment has none. An operator sets it with <code>npx wrangler secret put MUNS_TOKEN</code> — it lives on the Worker and never reaches the browser.',
  },
  unauthorised: {
    title: 'The API rejected the token',
    // Worth saying plainly: this one breaks on a day nobody changed anything.
    body: 'The token configured on the Worker was refused. These are <strong>session JWTs, so they expire</strong> — a deployment that worked yesterday can fail today with no change on our side. Renewing it is <code>npx wrangler secret put MUNS_TOKEN</code>.',
  },
  'rate-limited': {
    title: 'The API is rate limiting this deployment',
    body: 'These endpoints allow about 60 requests a minute and this deployment has passed that. It clears on its own; the committed snapshot exists so a normal visit does not spend that budget at all.',
  },
  timeout: { title: 'The API did not answer in time', body: 'The request was given its full budget and retried, and the upstream did not respond. The budget is deliberately short — a dead upstream that took ninety seconds per company is what made these tabs look broken rather than slow.' },
  unreachable: { title: 'The API could not be reached', body: 'The upstream did not answer. Nothing is wrong with this page; there is nothing to show until it does.' },
  upstream: { title: 'The API returned an error', body: 'The upstream answered, but not with data. This usually clears on its own.' },
  shape: { title: 'The API returned something unreadable', body: 'The response was not in a shape this dashboard could read. That is a change on their side worth looking at.' },
};

/**
 * @param {object} cfg
 * @param {string} cfg.id            tab id, as used in the URL
 * @param {string} cfg.title         tab label
 * @param {string} cfg.subtitle      one line under the title
 * @param {object} cfg.feed          a createFeed() instance from js/data/filings.js
 * @param {string} cfg.noun          what one row is, for the counts
 * @param {Function} cfg.columns     (meta) => scoreTable columns
 * @param {Function} cfg.searchable  (row) => string
 * @param {Function} cfg.provenance  (meta) => html for the pill's modal
 * @param {Function} [cfg.filters]   (rows) => scoreTable filters
 * @param {Function} [cfg.keyFor]    (row, i) => watchlist key
 */
export function makeFilingsTab(cfg) {
  const meta = { id: cfg.id, title: cfg.title, subtitle: cfg.subtitle, subviews: [] };

  let token = 0;
  let disposers = [];
  let unsub = null;
  let unregister = null;
  let view = null;
  let ctxRef = null;
  // What the tab's Refresh control should say right now. Module-level because it has to outlive the
  // repaints the refresh itself causes — see `wireRefresh`.
  let refreshLabel = 'Check for new';
  let labelReset = null;

  /**
   * The companies to ask about, as `{ ticker, name }`.
   *
   * THE NAME TRAVELS WITH THE TICKER because the news feed searches by it: `?q=JAYNECOIND` finds
   * three results, mostly quote pages, while `?q=Jayaswal Neco Industries` finds twenty about the
   * company. The other two feeds are per-ticker upstreams and ignore it.
   */
  function tickersFor(ctx) {
    const book = coverage.holdings().filter((h) => h.ticker).map((h) => ({ ticker: h.ticker, name: h.name }));
    if (ctx.scope === 'portfolio') return book;
    // The watchlist carries the name the row was starred under, which is exactly what the news
    // search needs — and it is the only name we have for a watched company outside the book.
    if (ctx.scope === 'watchlist') return watchlist.all().map((w) => ({ ticker: w.ticker, name: w.name || w.ticker }));
    // Universe is the book plus every company the committed snapshot already covers. Deliberately
    // not the 1,300-company Moneycontrol map: a live walk is bounded anyway, and asking about
    // companies nothing else on this dashboard tracks would spend the rate limit on rows nobody can
    // act on. The book comes FIRST, so a walk cut short by LIVE_LIMIT has covered the holdings
    // rather than whatever the snapshot happens to list first — the same rule the scraper follows.
    const seen = new Set(book.map((b) => String(b.ticker).toUpperCase()));
    const out = [...book];
    for (const r of cfg.feed.rows()) {
      const t = String(r.ticker || '').toUpperCase();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push({ ticker: t, name: null });
      }
    }
    return out;
  }

  function render(ctx) {
    const t = ++token;
    ctxRef = ctx;
    disposers.forEach((d) => d && d());
    disposers = [];

    // SUBSCRIBE BEFORE THE EARLY RETURN, not after it.
    //
    // Rows arrive a few at a time while the walk runs and the tab has to repaint as they land. An
    // earlier version set this up below, after `paint()` — which the first visit never reaches,
    // because it returns early into `load().then(paint)`. The result was a tab that painted its
    // empty first frame and then froze: the walk completed, forty companies failed, and the screen
    // still said "reading 40 more" with a table of nothing. The state was right and only the paint
    // was stale, which is the worst version of this bug because nothing looks broken.
    //
    // AND THE GUARD IS `ctxRef`, NOT THE TOKEN. The token check was `mine !== token`, with `mine`
    // captured at subscribe time and the subscription created once — so the second `render()`, which
    // a scope toggle always causes and which is the entire point of these tabs, incremented `token`
    // and killed it. Measured: the feed went on to 40 companies and 4,583 rows while the screen sat
    // at 21 and the pill still read "21 companies". Nothing threw, nothing failed, and the tab
    // simply stopped. `ctxRef` is what the guard was for — it is set by every render and cleared by
    // destroy(), so it tracks "is this tab still mounted" without going stale.
    //
    // Released in destroy(), not by the next repaint — otherwise the first arrival tears down the
    // subscription that produced it.
    if (!unsub) unsub = cfg.feed.onChange(() => ctxRef && paint(ctxRef));

    // THE HEADER'S REFRESH BUTTON IS WHAT WALKS THESE ROUTES, and only while this tab is mounted.
    // Registration is per mounted tab on purpose: a reader on News should not pay for the other two
    // feeds' walks, so the button's cost stays bounded and predictable rather than a lottery.
    if (!unregister) {
      unregister = refreshRegistry.register(cfg.id, {
        label: cfg.title,
        refresh: () => cfg.feed.refresh(),
      });
    }

    // ALL THREE TABS LOAD THE SAME WAY: the committed snapshot and this device, no per-company
    // request. News used to be the exception — it made the reader name companies before it would
    // show anything, because a live walk of the universe is one search per company against a
    // sixty-a-minute cap. But the scrape already walks the book on a schedule and commits the
    // result, so the rows for a scoped view are sitting in the snapshot and cost one conditional
    // GET to paint. Asking the reader to pick first was spending their attention to avoid a cost
    // that had already been paid. The walk still exists for whatever the snapshot misses, and it is
    // still the Refresh button that starts it.
    // THE SCOPE IS RE-DECLARED ON EVERY RENDER, not just the first. The feed loads once and lives
    // at module level, but which companies are in scope changes with the toggle — and `wanted` is
    // what the freshness strip counts as unchecked and what Refresh walks. Setting it only inside
    // `load()` let the first scope to mount own the list for the life of the page.
    const items = tickersFor(ctx);
    cfg.feed.setWanted(items);

    if (!cfg.feed.isLoaded()) {
      ctx.root.innerHTML = `${sectionHead({ title: cfg.title, description: cfg.subtitle })}${loadingHtml()}`;
      cfg.feed.load(items).then(() => {
        if (t === token) paint(ctx);
      });
      return;
    }
    paint(ctx);
  }

  function paint(ctx) {
    const m = cfg.feed.meta();
    let all = cfg.feed.rows();

    // THE FEED OUTLIVES THE SCOPE, so the rows are narrowed by the scope on every paint.
    // `createFeed` is module-level and keeps every company it has ever loaded — which is what makes
    // a second visit instant, and which would otherwise paint a book company's rows into a
    // watchlist view long after the reader switched.
    // AN EMPTY SEARCH RESULT IS NOT AN ARTICLE. The news scrape writes one all-null row for a
    // company it searched and found nothing for — 62 of them in the shipped capture — and rendering
    // those as rows put 62 "(untitled)" articles in front of the reader that no upstream ever
    // published. The company was still COVERED, which is a different fact and one the coverage note
    // below still counts: searched-and-empty is not the same as never-asked, and neither is an
    // article. `keepRow` is where a tab says what a row of its own has to carry to be one.
    if (cfg.keepRow) all = all.filter(cfg.keepRow);

    const wantedTickers = scopeTickers(ctx.scope, coverage.holdings());
    const rows = wantedTickers ? all.filter((r) => r.ticker && wantedTickers.has(String(r.ticker).toUpperCase())) : all;

    // NOTHING AT ALL, AND A REASON WHY. Distinguished from "no rows in this window", which is a
    // real answer and renders as an empty table with its own message.
    if (!rows.length && m.reason) {
      // THE PICKER SURVIVES THE FAILURE STATE. It used to be dropped here, which meant a reader
      // whose search hit an unreachable route lost the only control that could change it — and a
      // reload with companies still in the URL painted no chips, so the address bar and the screen
      // disagreed about what had been asked for. A control that selects the thing that failed must
      // outlive the failure.
      ctx.root.innerHTML = `
        ${sectionHead({
          title: cfg.title,
          description: cfg.subtitle,
          meta: scopeSummary({ scope: ctx.scope, count: 0, noun: 'companies with ' + cfg.noun, book: coverage.meta() }),
        })}
        ${unavailablePanel(m, refreshLabel === 'Check for new' ? 'Try again' : refreshLabel)}`;
      wireRefresh(ctx.root);
      return;
    }

    // A ROW KEY MAY NEVER CONTAIN THE ROW'S POSITION. This is what made News look duplicated, and
    // the data was innocent throughout: 741 rows, zero repeated (ticker, headline) pairs, and 160
    // repeated pairs ON SCREEN — the same headline two and three times while others were missing,
    // and the row count still exactly right.
    //
    // `scoreTable` caches a row's markup by its key and, on a repaint whose row set the DOM already
    // holds, MOVES the existing `<tr>` nodes rather than re-parsing them (see "Performance on large
    // tables" in CLAUDE.md). That is correct only if a key identifies a row. The key here was
    // `ticker-date-INDEX`, and these tables grow while the walk runs — so every arrival shifted the
    // indices, key `RELIANCE-2026-08-12-7` came to mean a different article, and the cached `<tr>`
    // for the old one was moved into its place. A stable, content-derived key fixes it at source.
    //
    // Genuinely identical rows do exist — the insider feed carries same-day, same-size filings by
    // different people — so a collision suffix keeps the keys unique. It is safe precisely because
    // the rows it separates carry the same content: the failure mode being closed here is one key
    // meaning two DIFFERENT rows, never two keys meaning the same one.
    const rowKeys = new Map();
    const keySeen = new Map();
    for (const r of rows) {
      const base = cfg.keyFor ? cfg.keyFor(r) : `${r.ticker || ''}|${r.url || r.title || ''}|${r.date || ''}`;
      const n = (keySeen.get(base) || 0) + 1;
      keySeen.set(base, n);
      rowKeys.set(r, n === 1 ? base : `${base}#${n}`);
    }

    const table = scoreTable({
      rows,
      key: (r) => rowKeys.get(r) || '',
      // THE STAR MARKS THE COMPANY, NOT THE ROW. `key` above identifies the row and is not a
      // ticker here, so without this the watchlist would fill with row ids and the Watchlist scope
      // — which narrows every feed on this dashboard by symbol — would have nothing to match.
      watchKey: (r) => r.ticker || null,
      watchName: (r) => r.company || cfg.rowName(r) || r.ticker,
      name: (r) => cfg.rowName(r),
      nameLabel: cfg.nameLabel || 'Headline',
      sub: (r) => cfg.rowSub(r),
      showRank: false,
      showAvatar: false,
      dense: true,
      wrapHeads: true,
      nameMaxPx: cfg.nameMaxPx || 460,
      stickyHead: 'max(320px, calc(100vh - 300px))',
      columns: cfg.columns(m),
      filters: cfg.filters ? cfg.filters(rows) : null,
      searchable: cfg.searchable,
      link: (r) => r.url || null,
      initialSort: { key: 'Date', dir: 'desc' },
      initialView: view,
      exportName: `sattva-${cfg.id}`,
      onExport: (visible) => cfg.onExport(visible, m),
      // AN EMPTY TABLE MUST NOT OVERSTATE WHAT WAS ASKED. With companies still outstanding, "no
      // articles in the last 30 days" is a claim about the upstream that nobody measured — these
      // routes have no index, so the only honest statement is how many were not asked about. The
      // strip above says the same thing; this stops the table contradicting it at a glance.
      emptyMessage: m.outstanding
        ? `Nothing in the capture for ${scopePossessive(ctx.scope) || 'these companies'} — and ${formatNumber(m.outstanding)} ${m.outstanding === 1 ? 'company has' : 'companies have'} not been checked since it ran. Refresh to search ${m.outstanding === 1 ? 'it' : 'them'}.`
        : scopePossessive(ctx.scope)
          ? `No ${cfg.noun} for ${scopePossessive(ctx.scope)} in the last ${m.windowDays} days.`
          : `No ${cfg.noun} matches your filters.`,
    });
    view = table.view;

    ctx.root.innerHTML = `
      ${sectionHead({
        title: cfg.title,
        description: cfg.subtitle,
        // COUNT COMPANIES, NOT ROWS. `scopeSummary`'s denominator is the book's 142 companies (or
        // the watchlist's N), so passing a row count printed "Portfolio · 1,279 of 142 articles" —
        // two different units either side of an "of", which is not a ratio of anything. The table's
        // own "N of M shown" already reports the rows; what the pill is for is the denominator the
        // scope owes the reader, and that is measured in companies.
        meta: `<div class="flex flex-wrap items-center justify-end gap-2">${pill(m)}${scopeSummary({
          scope: ctx.scope,
          count: new Set(rows.map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean)).size,
          noun: 'companies with ' + cfg.noun,
          book: coverage.meta(),
        })}</div>`,
        // A ROW OF ITS OWN, never the `meta` slot — `meta` sits in a justify-between row, so
        // whether it renders beside the title or wraps under it depends on how wide the chips and
        // the description happen to be, and both change as companies are added. A control that
        // moves when you use it reads as a different page.
      })}
      ${freshnessStrip(m, refreshLabel)}
      ${table.html}`;

    disposers.push(table.wire(ctx.root));
    ctx.root.querySelector('[data-filings-info]')?.addEventListener('click', () => openModal(cfg.provenance(m), { size: 'default' }));
    wireRefresh(ctx.root);
  }

  /**
   * The tab's own Refresh, which is the header button's action scoped to this feed.
   *
   * IT SAYS WHAT IT FOUND. "Up to date" is a real answer and the common one; a spinner that vanishes
   * leaves the reader unsure whether anything was checked — the same rule the header button follows,
   * and the reason the label is restored on a timer rather than immediately.
   */
  function wireRefresh(root) {
    const btn = root.querySelector('[data-filings-refresh]');
    if (!btn) return;
    const onClick = async () => {
      if (btn.disabled) return;
      clearTimeout(labelReset);
      const out = await refreshRegistry.refreshOne(cfg.id);
      // THE RESULT LIVES IN `refreshLabel`, NOT ON THIS NODE. Rows land while the walk runs and
      // every arrival repaints the panel, so the button this handler is bound to is long gone by
      // the time there is anything to report. Holding the label in the module and letting the next
      // paint render it is the only version that survives its own repaints.
      refreshLabel = out.error ? 'Couldn’t check' : out.added ? `${formatNumber(out.added)} new` : 'Up to date';
      if (ctxRef) paint(ctxRef);
      labelReset = setTimeout(() => {
        refreshLabel = 'Check for new';
        if (ctxRef) paint(ctxRef);
      }, 6000);
    };
    btn.addEventListener('click', onClick);
    disposers.push(() => btn.removeEventListener('click', onClick));
  }

  function destroy() {
    token++;
    ctxRef = null;
    disposers.forEach((d) => d && d());
    disposers = [];
    unsub?.();
    unsub = null;
    unregister?.();
    unregister = null;
    clearTimeout(labelReset);
    refreshLabel = 'Check for new';
    view = null;
  }

  return { meta, render, destroy };
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------


const loadingHtml = () => `
  <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
    ${Array.from({ length: 3 }).map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>').join('')}
  </div>
  <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;

/**
 * The pill, which is the one always-visible statement of where this came from.
 *
 * Sky for a snapshot, emerald for live, amber where some companies could not be read. It never says
 * "Live" for rows that came off a committed file — the same rule the calendar follows.
 */
function pill(m) {
  const bad = m.failed > 0 || !!m.reason;
  // `store` counts as a snapshot for colour AND for wording: those rows are bytes this device kept
  // from an earlier visit, and the server has not confirmed them in this session. Saying "Live"
  // over them is the one thing a freshness control may not do.
  const snap = m.origin === 'snapshot' || m.origin === 'store';
  const cls = bad
    ? 'bg-amber-50 text-amber-800 ring-amber-300 hover:bg-amber-100'
    : snap
      ? 'bg-sky-50 text-sky-800 ring-sky-300 hover:bg-sky-100'
      : 'bg-emerald-50 text-emerald-800 ring-emerald-300 hover:bg-emerald-100';
  const dot = bad
    ? '<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>'
    : snap
      ? '<span class="h-1.5 w-1.5 rounded-full bg-sky-500"></span>'
      : '<span class="relative flex h-1.5 w-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span></span>';
  const label = bad ? 'Partial' : m.origin === 'snapshot' ? 'Captured' : m.origin === 'store' ? 'Cached' : m.origin === 'mixed' ? 'Captured + live' : 'Live';
  return `
    <button type="button" data-filings-info title="Where this comes from, how far back it reaches, and what is missing"
      class="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${cls}">
      ${dot}<span>${escapeHtml(label)}</span>
      <span class="font-normal opacity-70">${escapeHtml(formatNumber(m.covered))} companies · ${escapeHtml(String(m.windowDays))}d</span>
    </button>`;
}

/**
 * How current this is, and what it would take to be more current.
 *
 * IT SAYS WHAT WE KNOW, NOT WHAT WE GUESS. These upstreams answer per company and have no index, so
 * "is there anything new?" cannot be answered without asking about every company — which is the
 * expensive thing this whole arrangement exists to keep off a page load. What CAN be said honestly
 * is when the data on screen was captured and how many companies nobody has asked about since, and
 * that is what this prints. The reader decides whether to spend the requests.
 *
 * It replaced a strip that read "Reading 40 more companies…" on every single visit. That was true
 * and it was also the problem: it described work nobody had asked for, and when the upstream was
 * down it counted forty companies down for a quarter of an hour over an empty table.
 */
function freshnessStrip(m, label = 'Check for new') {
  const busy = !!(m.pending || m.inFlight);

  // THE BUTTON IS IN BOTH BRANCHES. It used to be in neither while a walk ran, so the control the
  // reader had just pressed vanished, came back when the walk ended, and came back reading "Check
  // for new" — the one thing it could not truthfully say, because the check had just happened and
  // nothing on screen reported what it found.
  const button = `
    <button type="button" data-filings-refresh ${busy ? 'disabled' : ''}
      class="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 disabled:cursor-wait disabled:opacity-60">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="${busy ? 'spin-slow' : ''}">
        <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
      </svg>
      <span data-filings-refresh-label>${escapeHtml(busy ? 'Checking…' : label)}</span>
    </button>`;

  if (busy) {
    return `
      <div class="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">
        <p class="text-xs leading-relaxed text-slate-600">
          Reading <strong>${escapeHtml(formatNumber(m.pending))}</strong> more ${m.pending === 1 ? 'company' : 'companies'}. Each is a separate request upstream, so they arrive a few at a time.
          ${m.coldStart ? ' Nothing was cached for this deployment yet, so this first read is automatic.' : ''}
          ${m.truncated ? ` <strong>${escapeHtml(formatNumber(m.truncated))}</strong> more ${m.truncated === 1 ? 'is' : 'are'} in scope and will not be asked about in this pass.` : ''}
        </p>
        ${button}
      </div>`;
  }

  const captured = m.capturedAt ? `captured ${escapeHtml(formatRelativeTime(Date.parse(m.capturedAt)))}` : null;
  const refreshed = m.lastRefreshAt ? `read live ${escapeHtml(formatRelativeTime(m.lastRefreshAt))}` : null;
  const when = [refreshed, captured].filter(Boolean).join(' · ');
  if (!when && !m.outstanding) return '';

  return `
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100">
      <p class="text-xs leading-relaxed text-slate-600">
        ${when ? `Showing the ${escapeHtml(m.kind === 'news' ? 'news' : 'filings')} ${when}.` : ''}
        ${
          m.outstanding
            ? ` <strong>${escapeHtml(formatNumber(m.outstanding))}</strong> ${m.outstanding === 1 ? 'company has' : 'companies have'} not been checked since.
                These routes answer one company at a time and have no index, so whether anything new has been filed can only be found by asking.`
            : ''
        }
      </p>
      ${button}
    </div>`;
}

/**
 * Nothing to show, and why.
 *
 * Deliberately not `pendingPanel()`: that component means "not built yet" and draws shimmering
 * skeletons, which here would promise data that is not coming until an operator acts. It also
 * escapes its body, so the very command a reader needs would render as literal angle brackets.
 */
function unavailablePanel(m, label = 'Try again') {
  const r = REASONS[m.reason] || REASONS.upstream;
  const operator = ['no-token', 'unauthorised', 'rate-limited'].includes(m.reason);
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
      <div class="flex flex-wrap items-start gap-3">
        <span class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${operator ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' : 'bg-slate-100 text-slate-500'}" aria-hidden="true">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            ${operator ? '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>'}
          </svg>
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(r.title)}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-600">${r.body}</p>
          ${m.message ? `<p class="mt-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-500">${escapeHtml(m.message)}</p>` : ''}
          <p class="mt-3 text-xs leading-relaxed text-slate-500">
            <strong>Nothing is shown.</strong> Not "no news" and not last week's — there is nothing to display until the feed
            answers, and inventing rows to fill the space would be worse than the gap.
          </p>
          <button type="button" data-filings-refresh
            class="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 disabled:cursor-wait disabled:opacity-60">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
            </svg>
            <span data-filings-refresh-label>${escapeHtml(label)}</span>
          </button>
        </div>
      </div>
    </div>`;
}

/** The block every provenance modal ends with: how much landed, how much did not, and how fresh. */
export function coverageBlock(m) {
  return `
    <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is here, and what is not</h3>
    <p class="mt-1 text-xs">
      <strong>${escapeHtml(formatNumber(m.rowCount))}</strong> rows across
      <strong>${escapeHtml(formatNumber(m.covered))}</strong> companies, reaching back
      <strong>${escapeHtml(String(m.windowDays))} days</strong>.
      ${m.snapshotCount ? `${escapeHtml(formatNumber(m.snapshotCount))} came from the committed snapshot${m.capturedAt ? `, captured ${escapeHtml(formatRelativeTime(Date.parse(m.capturedAt)))}` : ''}.` : 'No committed snapshot has been written yet, so everything here was read live.'}
      ${m.failed ? ` <strong class="text-amber-700">${escapeHtml(formatNumber(m.failed))}</strong> ${m.failed === 1 ? 'company' : 'companies'} could not be read and ${m.failed === 1 ? 'is' : 'are'} absent rather than shown as having nothing.` : ''}
      ${m.truncated ? ` ${escapeHtml(formatNumber(m.truncated))} more were in scope but not asked about on this visit — these upstreams allow about sixty requests a minute.` : ''}
    </p>
    ${
      m.coversUniverse
        ? `<p class="mt-2 text-xs"><strong>Read by date, not by company.</strong> The question asked was <em>what was filed on
             these dates</em>, across ${m.exchangeCompanies ? `all <strong>${escapeHtml(formatNumber(m.exchangeCompanies))}</strong> active listings` : 'the whole exchange'} —
             not <em>what did these companies file</em>. So <strong>a company absent from this file filed nothing in the
             window</strong>, rather than being one there was no request budget to ask about. That distinction is the entire
             reason this feed changed source.</p>`
        : `<p class="mt-2 text-xs">A company with no rows had <em>nothing in this window</em>; a company that could not be read is not
       listed at all. Those are different states and the pill counts them separately.</p>`
    }
    ${deliveryNote({ origin: m.origin === 'live' || m.origin === 'mixed' ? 'live' : 'store', checkedAt: m.checkedAt, fetchedAt: m.capturedAt ? Date.parse(m.capturedAt) : null, persisted: m.persisted })}`;
}
