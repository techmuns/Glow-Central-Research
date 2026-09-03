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

import { scoreTable, sectionHead, openModal, closeModal, companySeededView } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { deliveryNote } from '../ui/sources.js';
import * as coverage from '../data/coverage.js';
import { filterByScope, scopePossessive, scopeLabel } from '../data/scope.js';
import * as watchlist from '../core/watchlist.js';
import * as trackedUniverse from '../data/tracked-universe.js';
import * as scopeLists from '../core/scope-lists.js';
import * as refreshRegistry from '../core/refresh.js';
import { RANGES, parseRange, rangeParam, applyRange, heldSpan, reachOf, describeRange, iso } from '../data/date-range.js';

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
 * @param {Function|false} [cfg.link] custom row-link getter, or false when the tab owns its link cell
 */
export function makeFilingsTab(cfg) {
  const meta = { id: cfg.id, title: cfg.title, subtitle: cfg.subtitle, subviews: [] };

  let token = 0;
  let disposers = [];
  let unsub = null;
  let unregister = null;
  let view = null;
  let routeCompany = null;
  let ctxRef = null;
  // The scope the company selection was made in. A selection is a list of companies IN A SCOPE, so
  // carrying it across the toggle would narrow the watchlist by book tickers and show nothing —
  // a control the reader cannot see the state of, filtering a view they did not filter.
  let lastScope = null;
  // What the tab's Refresh control should say right now. Module-level because it has to outlive the
  // repaints the refresh itself causes — see `wireRefresh`.
  let refreshLabel = 'Check for new';
  let labelReset = null;
  // The history window the reader is browsing. Lives in the URL, so it is shareable and survives a
  // reload; `render()` re-reads it on every route change.
  let range = parseRange(null);
  // Whether the custom from/to inputs are open. Not in the URL: a custom range in the URL opens
  // them by itself, and a reader who opened the pair and typed nothing has expressed no view worth
  // putting in a link.
  let customOpen = false;

  /**
   * The companies to ask about, as `{ ticker, name }`.
   *
   * THE NAME TRAVELS WITH THE TICKER because the news feed searches by it: `?q=JAYNECOIND` finds
   * three results, mostly quote pages, while `?q=Jayaswal Neco Industries` finds twenty about the
   * company. The other two feeds are per-ticker upstreams and ignore it.
   */
  function tickersFor(ctx) {
    const mcap = (t) => trackedUniverse.marketCapOf(t) ?? -1;
    const book = coverage.holdings().filter((h) => h.ticker).map((h) => ({ ticker: h.ticker, name: h.name }));
    // PORTFOLIO — the holdings, biggest first, so a bounded refresh covers the largest positions
    // before the smaller ones.
    if (ctx.scope === 'portfolio') return [...book].sort((a, b) => mcap(b.ticker) - mcap(a.ticker));
    // The watchlist carries the name the row was starred under, which is exactly what the news
    // search needs — and it is the only name we have for a watched company outside the book.
    if (ctx.scope === 'watchlist') return watchlist.all().map((w) => ({ ticker: w.ticker, name: w.name || w.ticker }));
    // UNIVERSE — the whole TRACKED MARKET UNIVERSE (js/data/tracked-universe.js: every listed company
    // above a market-cap floor, ~1,900 of them), BIGGEST MARKET CAP FIRST — RELIANCE, BHARTIARTL,
    // HDFCBANK… down the list — so a walk cut short by LIVE_LIMIT has covered the names where a
    // filing matters most. The book and every company the committed snapshot already covers are
    // appended, so a small-cap or BSE-only holding is never dropped from its own dashboard. This is
    // the SAME list the scheduled scrape walks, so the snapshot and an on-demand Refresh cannot
    // disagree about who is in scope. Until the universe file lands (it is deferred, and small) this
    // is the book plus the snapshot alone; render() re-declares the list when it does.
    const seen = new Set();
    const out = [];
    const add = (ticker, name) => {
      const t = String(ticker || '').toUpperCase();
      if (!t || seen.has(t)) return;
      seen.add(t);
      out.push({ ticker: t, name: name || null });
    };
    for (const c of trackedUniverse.all()) add(c.ticker, c.name);
    for (const b of book) add(b.ticker, b.name);
    for (const r of cfg.feed.rows()) add(r.ticker, null);
    return scopeLists.apply('universe', out);
  }

  function render(ctx) {
    const t = ++token;
    ctxRef = ctx;
    if (ctx.scope !== lastScope) {
      lastScope = ctx.scope;
      if (view) view = { ...view, companies: [] };
    }
    disposers.forEach((d) => d && d());
    disposers = [];
    // `exact: true` — these three tabs render the company multi-select, so a `?company=` deep link
    // becomes a removable CHIP rather than text in the search box: it narrows to that company and
    // nothing else, and the chip is what says so on screen. See companySeededView in ui/screener.js.
    const seeded = companySeededView(ctx, routeCompany, view, { exact: true });
    routeCompany = seeded.company;
    view = seeded.view;

    // THE RANGE COMES OUT OF THE URL, so a filtered view is a link somebody can send. `parseRange`
    // falls back rather than throwing, because a stale bookmark carrying a range this build no
    // longer offers must open the tab, not break it.
    range = parseRange(ctx.params?.range);
    customOpen = customOpen || range.custom;
    // AND IT DRIVES WHAT THE WALK ASKS FOR, which is what makes this more than a filter. These
    // routes take `from`/`to`, so selecting a year means a Refresh fetches a year rather than
    // painting a year-shaped label over thirty days of capture. `setWindow` only ever widens
    // within a session — see the note on it — so narrowing here can never shrink what is fetched.
    if (range.days) cfg.feed.setWindow(range.days);

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
    // THE TRACKED UNIVERSE IS DEFERRED, and Universe scope wants it. It is a small file that the
    // bootstrap's deferred pass has almost always landed before a reader reaches this tab; when it
    // has not, paint with what is known now and render again once it lands — render() is safe to
    // call repeatedly by contract, and `wanted` is what the freshness strip counts and Refresh walks,
    // so it must end up declared over the full list rather than the book alone.
    if (ctx.scope === 'universe' && !trackedUniverse.isLoaded()) {
      trackedUniverse.load().then((payload) => {
        if (payload && t === token && ctxRef) render(ctxRef);
      });
    }
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

    // WHAT THE CAPTURE HOLDS IS MEASURED OVER THE WHOLE FEED, not over the scoped subset, and the
    // difference decides whether the reach note below is true. A scoped list can be short because
    // those particular companies were quiet, which says nothing at all about how far back the
    // capture reaches — so reading the span off the scoped rows would print "we only hold back to
    // June" at a reader whose three watched companies simply had a quiet spring.
    const held = heldSpan(all);
    const reach = reachOf(range, held);

    const inScope = filterByScope(all, ctx.scope, coverage.holdings());
    // The window narrows what is DISPLAYED. `excluded` and `undated` are kept rather than dropped
    // so the control can account for the rows it is holding back — a table that silently shrank by
    // eleven hundred rows reads as a feed that lost them.
    const windowed = applyRange(inScope, range);
    const rows = windowed.rows;

    // WHAT WAS ASKED, versus what had something to say. A reader looking at "61 of 142 companies
    // with articles" cannot tell whether the other 81 were searched and had nothing or were never
    // searched at all — and those are opposite claims: one is the feed working, the other is the
    // feed incomplete. Measured on the shipped captures: news asked all 123 listed book companies
    // and 62 genuinely had none, while insider looked short only because a company answering "no
    // trades" was written nowhere. So the strip states the breakdown rather than leaving a
    // subtraction on screen for the reader to misread.
    const scoped = tickersFor(ctx);
    const cov = {
      inScope: scoped.length,
      withRows: new Set(rows.map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean)).size,
      askedEmpty: scoped.filter((c) => cfg.feed.wasAskedEmpty(c.ticker)).length,
      failed: scoped.filter((c) => cfg.feed.failureFor(c.ticker)).length,
      unlisted: ctx.scope === 'portfolio' ? coverage.meta().uncovered || 0 : 0,
      noun: cfg.noun,
      windowDays: m.windowDays,
      coversUniverse: m.coversUniverse,
    };

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
          meta: pill(m, ctx.scope, []),
          // THE RANGE CONTROL SURVIVES THE FAILURE STATE, for the same reason the company picker
          // had to: a control that selects what failed must outlive the failure, or a reader whose
          // one-year request could not be read has no way to ask for anything else.
          controls: rangeControls(range, { first: null, last: null, count: 0 }, reachOf(range, null), m, customOpen),
        })}
        ${unavailablePanel(m, refreshLabel === 'Check for new' ? 'Try again' : refreshLabel)}`;
      wireRefresh(ctx.root);
      wireRange(ctx.root, ctx);
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

    // ---- THE COMPANIES THIS TABLE CAN BE NARROWED TO ------------------------------------
    //
    // The reader's question on all three of these tabs is "show me these companies", and until now
    // the only way to ask it was to type a name into a free-text box — one company at a time, with
    // no list of what could be asked for and no help with the spelling. The search box is now a
    // multi-select over the scope's own company list, which is the SAME list the walk uses, so the
    // picker and the Refresh button cannot disagree about who is in scope.
    //
    // A COMPANY WITH NOTHING IN THIS CAPTURE STILL LISTS. It is in scope and can be asked about, and
    // it shows a dash rather than a zero — "no rows in this capture" and "never asked" are different
    // claims, and the one place that distinction is drawn is the coverage line behind the status
    // chip. Rows whose company is not in the scope list are appended so the picker can always name
    // everything on screen: a date-indexed announcements capture legitimately carries companies the
    // tracked universe does not.
    const rowCount = new Map();
    const rowName = new Map();
    for (const r of rows) {
      const t = String(r.ticker || '').toUpperCase();
      if (!t) continue;
      rowCount.set(t, (rowCount.get(t) || 0) + 1);
      if (!rowName.has(t) && r.company) rowName.set(t, r.company);
    }
    const seenOption = new Set();
    const companyOptions = [];
    for (const c of scoped) {
      const t = String(c.ticker || '').toUpperCase();
      if (!t || seenOption.has(t)) continue;
      seenOption.add(t);
      companyOptions.push({ ticker: t, name: c.name || rowName.get(t) || t, count: rowCount.get(t) || 0 });
    }
    for (const [t, n] of rowCount) {
      if (seenOption.has(t)) continue;
      seenOption.add(t);
      companyOptions.push({ ticker: t, name: rowName.get(t) || t, count: n });
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
      // THE SEARCH BOX IS THE PICKER. See ui/company-select.js — typing still filters rows by text,
      // so nothing the box did before is lost; what is added is the list of companies it can be
      // narrowed to and a chip for each one chosen.
      companyOptions,
      companyOf: (r) => r.ticker || null,
      companyScopeNoun: scopeLabel(ctx.scope),
      countNoun: cfg.noun,
      companyPlaceholder: `Pick companies or search ${cfg.noun}…`,
      companyHint:
        ctx.scope === 'universe'
          ? ''
          : `Switch the scope toggle to Universe to reach any company beyond ${scopePossessive(ctx.scope) || 'this list'}.`,
      link: cfg.link === false ? null : cfg.link || ((r) => r.url || null),
      initialSort: { key: 'Date', dir: 'desc' },
      initialView: view,
      // TWO UNITS, BOTH NAMED. Insider Trades can carry many disclosures for one portfolio
      // company, so a bare "1,295 of 1,295 shown" was understandably read as 1,295 companies.
      // Recompute both figures from the visible row DATA whenever search or a filter changes.
      countLabel: (visible) => {
        const companies = new Set(visible.map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean)).size;
        const rowNoun = visible.length === 1 ? cfg.noun.replace(/s$/, '') : cfg.noun;
        const companyNoun =
          ctx.scope === 'portfolio'
            ? `portfolio ${companies === 1 ? 'company' : 'companies'}`
            : ctx.scope === 'watchlist'
              ? `watchlist ${companies === 1 ? 'company' : 'companies'}`
              : companies === 1
                ? 'company'
                : 'companies';
        return `${formatNumber(visible.length)} ${rowNoun} from ${formatNumber(companies)} ${companyNoun}`;
      },
      exportName: `sattva-${cfg.id}`,
      // A WORKBOOK LEAVES THE PAGE WITHOUT THE CONTROL ON IT, so the window travels in the banner.
      // Nobody opening the file later can see which six months these rows are, and a sheet of
      // filings with no window on it is the one artefact where that cannot be recovered — the same
      // reason every mock and third-party disclosure here is stamped into row 1.
      onExport: (visible) => cfg.onExport(visible, m, { range, describeRange, held }),
      // AN EMPTY TABLE MUST NOT OVERSTATE WHAT WAS ASKED. With companies still outstanding, "no
      // articles in the last 30 days" is a claim about the upstream that nobody measured — these
      // routes have no index, so the only honest statement is how many were not asked about. The
      // strip above says the same thing; this stops the table contradicting it at a glance.
      // A FUNCTION, because the reader can narrow to a handful of companies without the table being
      // rebuilt, and "nothing for your holdings" is the wrong sentence the moment they have. Picked
      // companies are named by count so the message describes what was actually asked.
      // THE WINDOW NAMED IN EVERY BRANCH IS THE READER'S, not the capture's constant. Printing the
      // feed's own 30 or 365 under a six-month selection would answer a question nobody asked, and
      // would read as a contradiction of the history control sitting directly above it.
      emptyMessage: (v) =>
        v?.companies?.length
          ? `No ${cfg.noun} in ${describeRange(range)} for the ${v.companies.length === 1 ? 'company' : `${formatNumber(v.companies.length)} companies`} you picked.`
          : m.outstanding
            ? `Nothing in the capture for ${scopePossessive(ctx.scope) || 'these companies'} — and ${formatNumber(m.outstanding)} ${m.outstanding === 1 ? 'company has' : 'companies have'} not been checked since it ran. Refresh to search ${m.outstanding === 1 ? 'it' : 'them'}.`
            : scopePossessive(ctx.scope)
              ? `No ${cfg.noun} for ${scopePossessive(ctx.scope)} in ${describeRange(range)}.`
              : `No ${cfg.noun} matches your filters.`,
    });
    view = table.view;

    ctx.root.innerHTML = `
      ${sectionHead({
        title: cfg.title,
        description: cfg.subtitle,
        // ONE CHIP, THE SAME ONE THE MARKET-NEWS HALF OF THIS TAB ALREADY WEARS. The scope summary
        // that used to sit beside it — "Portfolio · 23 of 142 companies with articles" — has moved
        // into the modal, whole and worded exactly as it was. The DENOMINATOR RULE is not waived by
        // that: 23 rows still look complete until you know the book is 142, so the number still has
        // to be reachable, and the chip is what reaches it. What it stops doing is competing with
        // the table for the top of the page on every one of three tabs and three scopes.
        meta: pill(m, ctx.scope, rows),
        // A ROW OF ITS OWN, never the `meta` slot — `meta` sits in a justify-between row, so
        // whether it renders beside the title or wraps under it depends on how wide the chips and
        // the description happen to be, and both change as companies are added. A control that
        // moves when you use it reads as a different page. The range control is the reason that
        // matters here: it is pressed repeatedly, and a set of buttons that shifted sideways each
        // time the row count changed the pill's width would be unusable.
        controls: rangeControls(range, held, reach, m, customOpen, windowed),
      })}
      ${busyStrip(m)}
      ${table.html}`;

    disposers.push(table.wire(ctx.root));
    wireRange(ctx.root, ctx);
    // THE ACCOUNT MOVED BEHIND THE PILL, IT DID NOT GO. A permanent grey paragraph under the
    // heading — how old the capture is, how many companies were searched, what they answered —
    // was competing with the table it qualifies, which is the same trade the Earnings Hub ribbon,
    // Portfolio's four-line block and the market-news freshness card all made. What stays on the
    // face is the claim: a pill whose colour and word are earned by the data. What moves behind
    // the click is the explanation, and the Refresh control with it.
    wireRefresh(ctx.root);
  }

  /**
   * The tab's own Refresh, which is the header button's action scoped to this feed.
   *
   * IT SAYS WHAT IT FOUND. "Up to date" is a real answer and the common one; a spinner that vanishes
   * leaves the reader unsure whether anything was checked — the same rule the header button follows,
   * and the reason the label is restored on a timer rather than immediately.
   */
  /**
   * ONE refresh action, reached from two places: the button inside the provenance modal, and the
   * one on the failure panel — which stays in the page body, because a reader whose feed could not
   * be read must not have to open a modal to find the control that retries it.
   */
  async function doRefresh() {
    clearTimeout(labelReset);
    const out = await refreshRegistry.refreshOne(cfg.id);
    // THE RESULT LIVES IN `refreshLabel`, NOT ON A NODE. Rows land while the walk runs and every
    // arrival repaints the panel, so whichever button was pressed is long gone by the time there
    // is anything to report.
    refreshLabel = out.error ? 'Couldn’t check' : out.added ? `${formatNumber(out.added)} new` : 'Up to date';
    if (ctxRef) paint(ctxRef);
    labelReset = setTimeout(() => {
      refreshLabel = 'Check for new';
      if (ctxRef) paint(ctxRef);
    }, 6000);
  }

  const openProvenance = openProvenanceFactory(cfg, () => refreshLabel, doRefresh);

  /**
   * The range control: six presets, a custom pair, and nothing that fetches on its own.
   *
   * IT REPAINTS RATHER THAN RE-MOUNTING. `ctx.setParams` re-runs the shell's mount, which would
   * discard the table's own view — the reader's search text, their sort, their column filter — on
   * every press of a button that has nothing to do with any of them. `setParamsQuiet` writes the
   * URL and saves the route without re-mounting, and this repaints itself, which is the same shape
   * `openWorkspace` uses for its tab strip.
   *
   * AND IT SENDS NO REQUEST. Widening the range widens what the NEXT walk will ask for; it does not
   * start one. That is the on-demand rule these three tabs are built on — a control that quietly
   * dispatched sixty per-company requests because the reader clicked "1 year" would be the
   * page-load walk again, wearing a different hat. The Refresh button remains the only thing that
   * spends requests, and the reach note says when pressing it would buy anything.
   */
  function wireRange(root, ctx) {
    const host = root.querySelector('[data-range-control]');
    if (!host) return;

    const commit = (next) => {
      range = next;
      const params = { ...(ctx.params || {}) };
      params.range = rangeParam(next);
      if (next.days) cfg.feed.setWindow(next.days);
      ctx.setParamsQuiet(params);
      paint(ctx);
    };

    const onClick = (e) => {
      const preset = e.target.closest('[data-range-preset]');
      if (preset) {
        const picked = parseRange(preset.getAttribute('data-range-preset'));
        customOpen = false;
        commit(picked);
        return;
      }
      if (e.target.closest('[data-range-custom-toggle]')) {
        customOpen = !customOpen;
        paint(ctx);
        // Put the caret where the reader is going next. Repainting replaced the node the click
        // landed on, so this has to look the input up again rather than hold a reference.
        root.querySelector('[data-range-from]')?.focus();
      }
    };
    host.addEventListener('click', onClick);
    disposers.push(() => host.removeEventListener('click', onClick));

    // A PARTIAL PAIR IS NOT A RANGE, so nothing is committed until both dates are readable. The
    // alternative — treating a half-typed `2026-0` as a bound — repaints the table on every
    // keystroke and shows the reader a sequence of wrong answers on the way to the right one.
    const onChange = () => {
      const from = host.querySelector('[data-range-from]')?.value || '';
      const to = host.querySelector('[data-range-to]')?.value || '';
      if (!from || !to) return;
      commit(parseRange(`${from}..${to}`));
    };
    for (const el of host.querySelectorAll('[data-range-from], [data-range-to]')) {
      el.addEventListener('change', onChange);
      disposers.push(() => el.removeEventListener('change', onChange));
    }
  }

  function wireRefresh(root) {
    const btn = root.querySelector('[data-filings-refresh]');
    if (!btn) return;
    const onClick = async () => {
      if (btn.disabled) return;
      await doRefresh();
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
    routeCompany = null;
    // The URL is the range's home, and render() re-reads it on the way back in. Resetting the
    // module copy stops a stale one painting for the frame before that happens.
    range = parseRange(null);
    customOpen = false;
  }

  return { meta, render, destroy };
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------


/**
 * The history window, as a row of presets plus an optional custom pair.
 *
 * WHY THIS IS A CONTROL ROW AND NOT A COLUMN FILTER. `scoreTable`'s `filters` are questions about
 * a row — which outlet, which category — and they only ever narrow what is already on screen. The
 * window is a question about the FEED: it decides what the walk asks the upstream for, so it
 * belongs with the tab's framing rather than in the table's toolbar. It is also the control a
 * reader browsing "what happened in my stocks over six months" reaches for first, and burying it
 * among the column selects would put it behind the thing it governs.
 *
 * AND THE CONTROL STATES ITS OWN REACH, which is the part that makes it honest rather than merely
 * useful. Measured on the shipped captures: insider trades holds a full 365 days, company news
 * holds 30, and corporate announcements holds 3 — the announcements scrape prunes to `ANN_KEEP_DAYS`
 * because a month of the whole exchange is ~22,000 rows and roughly 16 MB that every visitor
 * downloads. So "1 year" over the announcements capture is a short list under a twelve-month
 * label, and a reader reads that as "almost nothing happened all year" rather than "we hold three
 * days". Naming the gap on the face of the control is the same rule as "never claim nothing is
 * new" on the Refresh strip: the honest statement is about US, and the reader decides what to do
 * with it.
 */
function rangeControls(range, held, reach, m, customOpen, windowed = null) {
  const active = (id) => (range.custom ? id === 'custom' : range.id === id);
  const btn = (id, label, title) => `
    <button type="button" data-range-preset="${escapeHtml(id)}" title="${escapeHtml(title)}"
      aria-pressed="${active(id) ? 'true' : 'false'}"
      class="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
        active(id)
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200'
      }">${escapeHtml(label)}</button>`;

  const today = iso(Date.now());
  const custom = customOpen
    ? `<span class="inline-flex items-center gap-1.5">
         <input type="date" data-range-from aria-label="From date" max="${escapeHtml(today)}"
           value="${escapeHtml(range.custom ? range.from : '')}"
           class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs tabular-nums text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
         <span class="text-xs text-slate-400">to</span>
         <input type="date" data-range-to aria-label="To date" max="${escapeHtml(today)}"
           value="${escapeHtml(range.custom ? range.to : today)}"
           class="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs tabular-nums text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
       </span>`
    : '';

  return `
    <div data-range-control class="flex flex-wrap items-center gap-1.5">
      <span class="mr-0.5 text-xs font-semibold uppercase tracking-wider text-slate-400">History</span>
      ${RANGES.map((r) => btn(r.id, r.short, `Show ${r.days ? `the last ${r.label}` : 'everything held'}`)).join('')}
      <button type="button" data-range-custom-toggle
        aria-pressed="${customOpen ? 'true' : 'false'}"
        title="Pick an exact from and to date"
        class="rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
          range.custom
            ? 'bg-indigo-600 text-white shadow-sm'
            : 'bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200'
        }">Custom</button>
      ${custom}
      ${reachNote(range, held, reach, m)}
      ${heldBackNote(windowed)}
    </div>`;
}

/**
 * The one sentence that stops a window label being a false statement.
 *
 * It renders ONLY when the capture cannot reach as far back as the reader just asked, which is the
 * codebase's standing trade: the claim stays on the face, the explanation moves behind a click, and
 * a caveat that has nothing to qualify does not appear at all. A `full` reach says nothing, because
 * there the label is simply true.
 *
 * `unknown` is its own answer and not a shrug: with nothing dated in hand there is no evidence for
 * a reach claim in either direction, and asserting coverage on no evidence is the failure this
 * whole note exists to prevent.
 */
function reachNote(range, held, reach, m) {
  if (!reach || reach.kind === 'full') return '';
  const amber = 'inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200';

  if (reach.kind === 'unknown') {
    return `<span class="${amber}" title="Nothing dated has landed for this feed yet, so how far back it reaches cannot be stated either way.">
      Reach unknown</span>`;
  }

  // A DATE-INDEXED CAPTURE AND A PER-COMPANY WALK ARE SHORT FOR DIFFERENT REASONS, and only one of
  // them can be fixed by pressing Refresh. Announcements are read from the exchange by date and
  // trimmed to a size ceiling, so the missing months are not sitting behind a request — saying
  // "refresh to search further back" there would send the reader after something that is not there.
  const canWalkBack = !m.coversUniverse;
  const why = m.coversUniverse
    ? `This feed is captured from the exchange by date and kept to a size limit, so the earlier filings are not held here.`
    : `Refresh re-reads the companies in scope over this window, so pressing it fetches the earlier ${escapeHtml(m.kind === 'news' ? 'articles' : 'filings')}.`;

  return `<span class="${amber}"
      title="${escapeHtml(`You asked for ${describeRange(range)}. The capture on this device only reaches back to ${held.first}, which is ${reach.shortfallDays} day${reach.shortfallDays === 1 ? '' : 's'} short of it. ${why}`)}">
      Held back to ${escapeHtml(held.first || '—')}${canWalkBack ? ' · Refresh to go further' : ''}</span>`;
}

/**
 * How many rows this window is holding back, so a shrinking table accounts for itself.
 *
 * A TABLE THAT SILENTLY LOST ELEVEN HUNDRED ROWS READS AS A FEED THAT LOST THEM. The count is the
 * reader's own selection working, and saying so is what separates it from a fetch that failed.
 * Undated rows are counted apart because they are a different fact: the publisher did not supply a
 * date, so they are in no window at all rather than outside this one — the same reason nothing here
 * ever stamps a missing date with today's.
 */
function heldBackNote(windowed) {
  if (!windowed) return '';
  const { excluded = 0, undated = 0 } = windowed;
  if (!excluded && !undated) return '';
  const bits = [];
  if (excluded) bits.push(`${formatNumber(excluded)} outside this window`);
  if (undated) bits.push(`${formatNumber(undated)} with no date published`);
  return `<span class="text-[11px] text-slate-400" title="${escapeHtml(
    undated
      ? 'A row whose source published no date is in no window at all. It is never stamped with today, and never swept into whichever range happens to be selected.'
      : 'These rows are held by this feed and fall outside the selected dates.'
  )}">${escapeHtml(bits.join(' · '))} hidden</span>`;
}

const loadingHtml = () => `
  <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
    ${Array.from({ length: 3 }).map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>').join('')}
  </div>
  <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;

/**
 * The section head is one chip, and it opens everything else.
 *
 * Same contract as the market-news chip: recent captures say `Up to date`; older captures show
 * their age. Coverage and retry details stay in provenance while the face uses calm customer
 * language. The demand-driven watchdog starts recovery automatically; an internal pipeline state
 * is not the label a customer needs above the table.
 */
function pill(m, scope, rows) {
  const at = m.capturedAt ? Date.parse(m.capturedAt) : NaN;
  const age = Number.isFinite(at) ? Date.now() - at : null;
  const maxAge = m.kind === 'announcements' ? 90 * 60 * 1000 : m.kind === 'news' ? 3 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const fresh = age !== null && age >= 0 && age <= maxAge;
  const tone = fresh ? 'text-emerald-700' : 'text-slate-500';
  // The face is calm and useful. Coverage/retry details remain in provenance while the watchdog
  // fixes them in the background; internal pipeline vocabulary is not customer guidance.
  const label = age === null ? 'Updating' : fresh ? 'Up to date' : `Updated ${formatRelativeTime(at)}`;
  return `<span data-filings-info
      title="${escapeHtml(scopeTitle(scope, rows, m))}"
      class="inline-flex items-center gap-1.5 text-xs font-semibold ${tone}">
      ${escapeHtml(label)}
    </span>`;
}

/**
 * The denominator, as the chip's tooltip and as a line in its modal.
 *
 * THE RULE IS THAT THE NUMBER STAYS REACHABLE, not that it stays on the page. Twenty-three rows
 * look complete until you know the book is a hundred and forty-two, and that is still true — so
 * `scopeSummary`'s sentence is reproduced here whole rather than dropped when its pill came off
 * the head. What changed is that it is one hover or one click away instead of occupying the top
 * of three tabs across three scopes.
 */
function scopeTitle(scope, rows, m) {
  const n = new Set((rows || []).map((r) => String(r.ticker || '').toUpperCase()).filter(Boolean)).size;
  const book = coverage.meta();
  if (scope === 'portfolio' && book?.count) {
    return `${formatNumber(n)} of the book's ${formatNumber(book.count)} companies appear on this feed.` +
      (book.uncovered ? ` ${formatNumber(book.uncovered)} carry no NSE symbol, so no feed here can ever show them.` : '') +
      '';
  }
  if (scope === 'watchlist') {
    const tracked = watchlist.size();
    return tracked
      ? `${formatNumber(n)} of the ${formatNumber(tracked)} companies you track appear on this feed.`
      : 'Nothing tracked yet.';
  }
  return `${formatNumber(n)} companies appear on this feed.`;
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
/**
 * How many companies in scope were actually asked, and what they answered.
 *
 * THE FAILURE THIS CLOSES is a reader counting the gap themselves and reading it as a fetch that
 * did not happen. "Portfolio · 61 of 142 companies with articles" is true and says nothing about
 * whether the other 81 were searched — and on the shipped captures they were: 123 of the book's
 * 142 lines carry an NSE symbol, all 123 were searched, and 62 genuinely had no news in the
 * window. The other 19 hold no symbol at all, so no feed here can ever reach them.
 *
 * Every clause is dropped when its number is zero rather than printed as a nil — a sentence built
 * around a number reads as broken prose the moment the number is not there, and a nil reads as a
 * measurement. A date-indexed capture says something different and says it in its own words: it
 * asked the exchange, not the companies, so "asked" is the wrong verb for it entirely.
 */
function coverageSentence(m, cov) {
  if (!cov || !cov.inScope) return '';
  const n = (x) => escapeHtml(formatNumber(x));
  const co = (x, one, many) => `${x === 1 ? one : many}`;

  if (cov.coversUniverse) {
    // Nothing was asked company by company here, so there is no company that went unasked. What
    // the reader is owed instead is that an absence in this feed is a real answer.
    return ` The capture reads the whole exchange by date, so a company with nothing here filed
      nothing in the last ${n(m.windowDays)} days — ${n(cov.withRows)} of ${n(cov.inScope)}
      ${co(cov.inScope, 'company', 'companies')} in scope filed something.`;
  }

  const parts = [];
  const asked = cov.withRows + cov.askedEmpty;
  if (asked) {
    parts.push(`<strong>${n(asked)}</strong> of ${n(cov.inScope)} ${co(cov.inScope, 'company', 'companies')} in scope
      ${co(asked, 'was', 'were')} searched`);
  }
  if (cov.askedEmpty) {
    parts.push(`${n(cov.askedEmpty)} of them had no ${escapeHtml(cov.noun)} in the last ${n(m.windowDays)} days`);
  }
  // TRIED AND FAILED IS NOT NEVER REACHED, and saying both about the same company says nothing
  // twice. The strip used to print "3 companies have not been checked since" and then "3 could not
  // be read" in the next breath — one backlog, two names for it, and the reader left to work out
  // whether that was three companies or six.
  if (cov.failed) parts.push(`${n(cov.failed)} could not be read and will be retried`);
  const unreached = Math.max(0, (m.outstanding || 0) - cov.failed);
  if (unreached) {
    parts.push(`${n(unreached)} ${co(unreached, 'has', 'have')} not been asked about since — these routes
      answer one company at a time and have no index, so that can only be found out by asking`);
  }
  if (!parts.length) return '';

  // The book's permanent gap, and only under Portfolio — a watchlist entry came from a feed, so
  // its gap is never "this line has no symbol".
  const unlisted = cov.unlisted
    ? ` A further ${n(cov.unlisted)} book ${co(cov.unlisted, 'line carries', 'lines carry')} no NSE symbol, so no feed here can show ${co(cov.unlisted, 'it', 'them')}.`
    : '';
  return ` ${parts.join(', ')}.${unlisted}`;
}

/**
 * The ONLY thing left in the page body, and only while a walk is actually running.
 *
 * A permanent freshness paragraph is chrome; a progress line for work the reader just asked for is
 * feedback, and without it a Refresh press would have no visible effect at all until rows landed.
 * It disappears the moment the walk settles, which is what makes it not the thing that was removed.
 */
/**
 * The provenance modal, which is now also where the freshness line and the Refresh control live.
 *
 * The button is wired on `#modal-content` rather than on the tab root, because `openModal` mounts
 * outside it — the same shape `market-news-view.js` uses for its Fetch control. Pressing it closes
 * the modal, so the reader is returned to the page where the progress strip and the arriving rows
 * actually are; leaving them looking at a static panel while the work happened behind it was the
 * one way this could be worse than the strip it replaces.
 */
function openProvenanceFactory(cfg, refreshLabelRef, onRefresh) {
  return function openProvenance(m, cov, scope, rows) {
    openModal(
      `${cfg.provenance(m)}
       <div class="border-t border-slate-100 px-7 py-5">
         <p class="text-xs leading-relaxed text-slate-600">${freshnessLine(m)}${coverageSentence(m, cov)}</p>
         <p class="mt-2 text-xs leading-relaxed text-slate-600">${escapeHtml(scopeTitle(scope, rows, m).replace(' Click for where this comes from.', ''))}</p>
         <button type="button" data-filings-refresh
           class="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 disabled:cursor-wait disabled:opacity-60"
           ${m.pending || m.inFlight ? 'disabled' : ''}>
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
           </svg>
           <span>${escapeHtml(m.pending || m.inFlight ? 'Checking…' : refreshLabelRef())}</span>
         </button>
       </div>`,
      { size: 'default' }
    );
    const host = document.getElementById('modal-content');
    host?.querySelector('[data-filings-refresh]')?.addEventListener('click', () => {
      closeModal();
      onRefresh();
    });
  };
}

/** How old this is, in one clause, with nothing claimed that was not measured. */
function freshnessLine(m) {
  const captured = m.capturedAt ? `captured ${escapeHtml(formatRelativeTime(Date.parse(m.capturedAt)))}` : null;
  const refreshed = m.lastRefreshAt ? `checked directly ${escapeHtml(formatRelativeTime(m.lastRefreshAt))}` : null;
  const when = [refreshed, captured].filter(Boolean).join(' · ');
  const retained = m.fallbackCount && m.oldestDataAt
    ? ` The oldest retained company answer was captured ${escapeHtml(formatRelativeTime(Date.parse(m.oldestDataAt)))}.`
    : '';
  return when ? `Showing the ${escapeHtml(m.kind === 'news' ? 'news' : 'filings')} ${when}.${retained}` : '';
}

function busyStrip(m) {
  if (!(m.pending || m.inFlight)) return '';
  return `
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">
      <p class="text-xs leading-relaxed text-slate-600">
        Reading <strong>${escapeHtml(formatNumber(m.pending))}</strong> more ${m.pending === 1 ? 'company' : 'companies'}. Each is a separate request upstream, so they arrive a few at a time.
        ${m.coldStart ? ' Nothing was cached for this deployment yet, so this first read is automatic.' : ''}
        ${m.truncated ? ` <strong>${escapeHtml(formatNumber(m.truncated))}</strong> more ${m.truncated === 1 ? 'is' : 'are'} in scope and will not be asked about in this pass.` : ''}
      </p>
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
      ${m.snapshotCount ? `${escapeHtml(formatNumber(m.snapshotCount))} came from the committed snapshot${m.capturedAt ? `, captured ${escapeHtml(formatRelativeTime(Date.parse(m.capturedAt)))}` : ''}.` : 'No committed snapshot has been written yet, so everything here was checked directly.'}
      ${m.fallbackCount ? ` ${escapeHtml(formatNumber(m.fallbackCount))} ${m.fallbackCount === 1 ? 'company retains' : 'companies retain'} its last successful answer while the current read is retried.` : ''}
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
