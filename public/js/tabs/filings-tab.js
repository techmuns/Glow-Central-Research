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
// THE SCOPE TOGGLE IS THE POINT OF THE TAB. Portfolio narrows to the book's tickers and Universe
// widens to everything the snapshot covers, and both print their denominator — a list of 40 rows
// looks complete until you know how many companies were asked about.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { deliveryNote } from '../ui/sources.js';
import * as coverage from '../data/coverage.js';

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
  timeout: { title: 'The API did not answer in time', body: 'The request was given 30 seconds and retried, and the upstream did not respond.' },
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
  let view = null;
  let ctxRef = null;

  // ---- manual refresh (Corp Announcements, Insider Trades) -----------------------------
  // These two are cache-first: the mount paints what is stored and the live walk runs only when the
  // reader presses Refresh. See render()/paint()/doRefresh below.
  let refreshing = false;
  let refreshMsg = null; // { text, tone } — a transient result shown on the button after a refresh
  let refreshTimer = null;

  // ---- picker mode (News only) --------------------------------------------------------
  //
  // When `cfg.picker` is set the tab does NOT auto-walk everything in scope. Instead the reader
  // chooses companies and the results are GATED on that selection: nothing is fetched or shown
  // until at least one company is picked and "Search news" is pressed. Everything below render()
  // that is picker-specific keys off this being set; the other two filings tabs leave it null and
  // keep their scope-driven behaviour untouched. See renderPicker/paintPicker below.
  const picker = cfg.picker || null;
  let selection = picker ? loadSelection() : []; // [{ ticker, name }]
  let searched = null; // the selection last run through the feed THIS page-load (Set of tickers), or null
  let searching = false; // a walk is in flight for the current selection

  function loadSelection() {
    try {
      const raw = JSON.parse(localStorage.getItem(cfg.picker.storageKey) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((c) => c && c.ticker)
        .map((c) => ({ ticker: String(c.ticker).toUpperCase(), name: c.name || null }))
        .slice(0, cfg.picker.max || 20);
    } catch {
      return [];
    }
  }
  function saveSelection() {
    try {
      localStorage.setItem(cfg.picker.storageKey, JSON.stringify(selection));
    } catch {
      // localStorage unavailable (private mode, quota) — the selection just won't survive a reload.
    }
  }

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

    // PICKER MODE — gated on the reader's selection, so no walk fires on mount. The subscription is
    // still set up before any early return (same reasoning as below), guarded by `ctxRef` so a
    // scope change — which re-runs render() — cannot orphan it. A persisted selection is searched
    // once per page-load (searched === null) so a reload restores the results; a return to the tab
    // within the same page-load just repaints from what the feed already holds.
    if (picker) {
      if (!unsub) unsub = cfg.feed.onChange(() => ctxRef && paintPicker(ctxRef));
      if (searched === null && selection.length) runSearch(ctx);
      else paintPicker(ctx);
      return;
    }

    // ANNOUNCEMENTS & INSIDER TRADES — cache-first, refreshed on demand.
    //
    // These two used to run a live walk on every visit, a few companies at a time, repainting the
    // table as each one landed — the flicker the reader sees, and somebody else's rate limit spent on
    // every navigation. Now the mount paints the cache alone (instant, identical on every return) and
    // the walk happens only when Refresh is pressed: one quiet pass, one repaint at the end (see
    // doRefresh + feed.refresh).
    //
    // THERE IS NO onChange SUBSCRIPTION HERE, unlike the picker path above. Nothing arrives
    // asynchronously to react to any more — load() is cache-only and refresh() is quiet — so the tab
    // paints explicitly at each step, which is what keeps the table from rebuilding company by
    // company. It also sidesteps the failure mode the picker's ctxRef-guarded subscription defends
    // against: with no subscription, a re-render cannot orphan one.
    if (!cfg.feed.isLoaded()) {
      ctx.root.innerHTML = `${sectionHead({ title: cfg.title, description: cfg.subtitle })}${loadingHtml()}`;
      cfg.feed.load(tickersFor(ctx)).then(() => {
        if (t === token) paint(ctx);
      });
      return;
    }
    paint(ctx);
  }

  function paint(ctx) {
    // paint() is called on mount, on scope change, and from doRefresh — so it owns its cleanup rather
    // than leaning on render()'s, and never lets a previous table's listeners accumulate.
    disposers.forEach((d) => d && d());
    disposers = [];

    const m = cfg.feed.meta();
    const book = new Set(coverage.holdings().map((h) => h.ticker).filter(Boolean));
    const all = cfg.feed.rows();
    const rows = ctx.scope === 'portfolio' ? all.filter((r) => r.ticker && book.has(String(r.ticker).toUpperCase())) : all;
    const headMeta = `<div class="flex flex-wrap items-center justify-end gap-2">${pill(m)}${refreshButton()}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: cfg.noun, book: coverage.meta() })}</div>`;
    const head = sectionHead({ title: cfg.title, description: cfg.subtitle, meta: headMeta });

    // NOTHING AT ALL, AND A REASON WHY. The refresh button stays, so a reader who fixes the cause
    // (a renewed token, the Worker coming up) can retry in place.
    if (!rows.length && m.reason) {
      ctx.root.innerHTML = `${head}${unavailablePanel(m)}`;
      wireRefresh(ctx);
      return;
    }

    // NOTHING CACHED YET, and no failure — the cold-cache state. Invite a fetch rather than showing an
    // empty table that reads as "no filings exist". Once fetched, the device store makes the return
    // visit land here with rows and skip this panel.
    if (!rows.length && m.covered === 0) {
      ctx.root.innerHTML = `${head}${emptyCachePanel()}`;
      wireRefresh(ctx);
      return;
    }

    const table = tableFor(ctx, rows, m);
    ctx.root.innerHTML = `
      ${head}
      ${refreshableStrip(m)}
      ${table.html}`;
    disposers.push(table.wire(ctx.root));
    ctx.root.querySelector('[data-filings-info]')?.addEventListener('click', () => openModal(cfg.provenance(m), { size: 'default' }));
    wireRefresh(ctx);
  }

  // ---- the Refresh control ------------------------------------------------------------

  /** The Refresh control beside the freshness pill — it runs the manual walk and reports the result. */
  function refreshButton() {
    const label = refreshing ? 'Checking…' : refreshMsg ? refreshMsg.text : 'Refresh';
    const tone = !refreshing && refreshMsg ? (refreshMsg.tone === 'good' ? 'text-emerald-700' : refreshMsg.tone === 'bad' ? 'text-rose-700' : 'text-slate-600') : 'text-slate-600';
    return `
      <button type="button" data-refresh ${refreshing ? 'disabled' : ''}
        title="Fetch newly filed ${escapeHtml(cfg.noun)} for the companies in scope. Only companies whose data may have changed are re-checked, and results are stored on this device."
        class="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold ${tone} ring-1 ring-slate-200 transition-colors hover:bg-indigo-50 hover:text-indigo-700 hover:ring-indigo-200 disabled:cursor-wait disabled:opacity-70">
        <svg data-refresh-icon class="${refreshing ? 'spin-slow' : ''}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
        </svg>
        <span data-refresh-label>${escapeHtml(label)}</span>
      </button>`;
  }

  function wireRefresh(ctx) {
    const btn = ctx.root.querySelector('[data-refresh]');
    if (btn) btn.addEventListener('click', () => doRefresh(ctx));
  }

  /**
   * Run the manual walk: spin the button IN PLACE (no repaint, so nothing flickers), fetch quietly,
   * then repaint ONCE with everything that landed and report the result on the button. This is the
   * whole point of the change — the reader sees a small spinner, then the finished table, never the
   * table rebuilding company by company.
   */
  async function doRefresh(ctx) {
    if (refreshing) return;
    refreshing = true;
    refreshMsg = null;
    const btn = ctx.root.querySelector('[data-refresh]');
    if (btn) {
      btn.disabled = true;
      btn.querySelector('[data-refresh-icon]')?.classList.add('spin-slow');
      const lbl = btn.querySelector('[data-refresh-label]');
      if (lbl) lbl.textContent = 'Checking…';
    }
    let summary = null;
    try {
      summary = await cfg.feed.refresh(tickersFor(ctx));
    } catch {
      summary = null;
    }
    refreshing = false;
    // Paint the CURRENT ctx, not the one captured before the await. A scope toggle mid-walk swaps
    // ctxRef, and bailing on a ctx mismatch would leave the button stuck spinning (the re-render
    // painted it while the walk was still in flight) and the freshly fetched rows unpainted. ctxRef
    // is null only once the tab is fully unmounted, where there is nothing to paint.
    if (!ctxRef) return;
    refreshMsg = summarizeRefresh(summary);
    paint(ctxRef); // ONE repaint, all the new data at once
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshMsg = null;
      // Reset the label AND its success/fail colour — clearing only the text would leave an idle
      // "Refresh" painted emerald or rose.
      const b = ctxRef?.root?.querySelector('[data-refresh]');
      if (b) {
        b.classList.remove('text-emerald-700', 'text-rose-700');
        b.classList.add('text-slate-600');
        const lbl = b.querySelector('[data-refresh-label]');
        if (lbl) lbl.textContent = 'Refresh';
      }
    }, 6000);
  }

  function summarizeRefresh(summary) {
    // New rows win the label even if some companies also failed — the failures are already named in
    // the panel and pill, and "12 new" is the more useful thing to say when data did land. Only when
    // nothing landed does a feed-level failure (no route, expired token) get the button.
    if (summary && summary.newRows > 0) return { text: `${formatNumber(summary.newRows)} new`, tone: 'good' };
    if (!summary || cfg.feed.meta().reason) return { text: "Couldn't refresh", tone: 'bad' };
    return { text: 'Up to date', tone: 'neutral' };
  }

  /** The cold-cache face: nothing stored yet, so nothing has been fetched. */
  function emptyCachePanel() {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500 ring-1 ring-indigo-100">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">Nothing cached yet</h3>
        <p class="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500">
          Press <strong>Refresh</strong> to fetch the latest ${escapeHtml(cfg.noun)} for the companies in scope. They are then
          stored on this device, so coming back here is instant — and Refresh only ever re-checks what may have changed.
        </p>
      </div>`;
  }

  /** After a bounded refresh, say how many companies are still in scope but were not fetched this time. */
  function refreshableStrip(m) {
    if (!m.truncated) return '';
    return `
      <div class="mb-4 flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 ring-1 ring-slate-100">
        <span class="mt-0.5 flex-shrink-0 text-slate-400" aria-hidden="true">ℹ</span>
        <span><strong>${escapeHtml(formatNumber(m.truncated))}</strong> more ${m.truncated === 1 ? 'company is' : 'companies are'} in scope but ${
          m.truncated === 1 ? 'was' : 'were'
        } not fetched this time — these upstreams allow about sixty requests a minute, so each Refresh fetches a batch. Press <strong>Refresh</strong> again to fetch more.</span>
      </div>`;
  }

  /**
   * The results table — one config, shared by the scope-driven paint() and the picker's paintPicker().
   *
   * A ROW KEY MAY NEVER CONTAIN THE ROW'S POSITION. This is what made News look duplicated, and the
   * data was innocent throughout: 741 rows, zero repeated (ticker, headline) pairs, and 160 repeated
   * pairs ON SCREEN. `scoreTable` caches a row's markup by key and, on a repaint whose row set the
   * DOM already holds, MOVES the existing `<tr>` nodes rather than re-parsing them — correct only if
   * a key identifies a row. The old key was `ticker-date-INDEX`, and these tables grow while the walk
   * runs, so every arrival shifted the indices and a cached `<tr>` was moved onto a different article.
   * A stable, content-derived key fixes it at source; a collision suffix keeps genuinely identical
   * rows (the insider feed's same-day, same-size filings) unique without reintroducing the position.
   */
  function tableFor(ctx, rows, m) {
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
      exportName: `glow-${cfg.id}`,
      onExport: (visible) => cfg.onExport(visible, m),
      emptyMessage: picker
        ? `No ${cfg.noun} for the selected ${selection.length === 1 ? 'company' : 'companies'} in the last ${m.windowDays} days.`
        : ctx.scope === 'portfolio'
          ? `No ${cfg.noun} for your holdings in the last ${m.windowDays} days.`
          : `No ${cfg.noun} matches your filters.`,
    });
    view = table.view;
    return table;
  }

  // ---- picker mode rendering ----------------------------------------------------------

  /** Run the feed for the current selection, painting the loading state first and results after. */
  function runSearch(ctx) {
    const sel = selection.slice();
    if (!sel.length) return;
    searched = new Set(sel.map((c) => c.ticker.toUpperCase()));
    searching = true;
    paintPicker(ctx);
    cfg.feed
      .ensure(sel)
      .catch(() => {})
      .then(() => {
        searching = false;
        // Guard on the LATEST ctx, not the one captured here: a scope change swaps ctxRef while the
        // walk runs, and painting the stale ctx would write into a torn-down root. ctxRef is null
        // once the tab is unmounted, so this simply does nothing then.
        if (ctxRef) paintPicker(ctxRef);
      });
  }

  /** Empty the selection and forget its results. The gate closes again. */
  function clearSelection(ctx) {
    selection = [];
    searched = null;
    searching = false;
    saveSelection();
    cfg.feed.ensure([]); // prune the feed so a later, unrelated read cannot resurface these rows
    paintPicker(ctx);
  }

  /** The company universe the picker searches: the book, plus the NSE-500 universe once it lands. */
  function companyList(ctx) {
    const seen = new Map();
    for (const h of coverage.tracked()) {
      const t = String(h.ticker).toUpperCase();
      if (!seen.has(t)) seen.set(t, { ticker: h.ticker, name: h.name || null });
    }
    const uni = ctx.data && Array.isArray(ctx.data.universe) ? ctx.data.universe : [];
    for (const u of uni) {
      if (!u || !u.ticker) continue;
      const t = String(u.ticker).toUpperCase();
      if (!seen.has(t)) seen.set(t, { ticker: u.ticker, name: u.name || null });
    }
    return [...seen.values()].sort((a, b) => String(a.name || a.ticker).localeCompare(String(b.name || b.ticker)));
  }

  function paintPicker(ctx) {
    // paintPicker is called directly on every add/remove/search, not only through render(), so it
    // owns its own listener cleanup — the picker installs a document-level click handler that would
    // otherwise leak on each repaint.
    disposers.forEach((d) => d && d());
    disposers = [];

    const m = cfg.feed.meta();
    const selSet = new Set(selection.map((c) => c.ticker.toUpperCase()));
    const rows = cfg.feed.rows().filter((r) => selSet.has(String(r.ticker).toUpperCase()));
    const headHtml = sectionHead({
      title: cfg.title,
      description: cfg.subtitle,
      meta: selection.length ? `<div class="flex flex-wrap items-center justify-end gap-2">${pill(m)}</div>` : '',
    });

    // The gate: nothing chosen, so nothing has been fetched and nothing is shown but the prompt.
    if (!selection.length) {
      ctx.root.innerHTML = `${headHtml}${pickerBar(ctx)}${promptPanel()}`;
      disposers.push(wirePicker(ctx.root, ctx));
      return;
    }

    // Chosen, but the feed cannot answer at all — a static origin with no /api/news, or an
    // operator-level failure. Keep the picker so the reader can still change the selection.
    if (!rows.length && m.reason) {
      ctx.root.innerHTML = `${headHtml}${pickerBar(ctx)}${unavailablePanel(m)}`;
      disposers.push(wirePicker(ctx.root, ctx));
      return;
    }

    const table = tableFor(ctx, rows, m);
    ctx.root.innerHTML = `
      ${headHtml}
      ${pickerBar(ctx)}
      ${walkStrip(m)}
      ${pendingHint()}
      ${accountingNote(m)}
      ${table.html}`;
    disposers.push(wirePicker(ctx.root, ctx));
    disposers.push(table.wire(ctx.root));
    ctx.root.querySelector('[data-filings-info]')?.addEventListener('click', () => openModal(cfg.provenance(m), { size: 'default' }));
  }

  /** The COMPANIES card: selected chips, the name/symbol search, and Search / Clear. */
  function pickerBar(ctx) {
    const canSearch = selection.some((c) => !(searched && searched.has(c.ticker.toUpperCase())));
    const atMax = selection.length >= (picker.max || 20);
    const chips = selection
      .map(
        (c) => `
        <span class="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-2.5 pr-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
          <span title="${escapeHtml(c.name || c.ticker)}">${escapeHtml(c.ticker)}</span>
          <button type="button" data-picker-remove="${escapeHtml(c.ticker)}" aria-label="Remove ${escapeHtml(c.name || c.ticker)}"
            class="flex h-4 w-4 items-center justify-center rounded-full text-indigo-400 transition-colors hover:bg-indigo-100 hover:text-indigo-700">&times;</button>
        </span>`
      )
      .join('');
    return `
      <div data-picker class="mb-5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Companies</span>
          ${chips || '<span class="text-xs text-slate-400">none selected yet</span>'}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <div class="relative min-w-[240px] max-w-md flex-1" data-picker-search-root>
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-picker-input autocomplete="off" ${atMax ? 'disabled' : ''}
              placeholder="${atMax ? `Limit of ${picker.max} reached — remove one to add another` : 'Search a company by name or symbol…'}"
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60" />
            <div data-picker-results class="scrollbar-thin absolute left-0 right-0 top-full z-40 mt-1 hidden max-h-72 overflow-y-auto rounded-lg bg-white shadow-xl ring-1 ring-slate-200"></div>
          </div>
          <button type="button" data-picker-search ${canSearch && !searching ? '' : 'disabled'}
            class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none">
            ${searching ? 'Searching…' : 'Search news'}
          </button>
          <button type="button" data-picker-clear ${selection.length ? '' : 'disabled'}
            class="rounded-lg px-2 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800 disabled:opacity-40">Clear</button>
          <span class="ml-auto text-xs tabular-nums text-slate-400">${selection.length} of ${picker.max} max</span>
        </div>
      </div>`;
  }

  function wirePicker(root, ctx) {
    const el = root.querySelector('[data-picker]');
    if (!el) return () => {};
    const input = el.querySelector('[data-picker-input]');
    const results = el.querySelector('[data-picker-results]');
    // Recomputed on demand rather than captured once: the NSE-500 universe is a DEFERRED bootstrap
    // file, so the very first render of this tab may see the book alone. Reading it live means the
    // suggestions widen to the full universe as soon as it lands, without a rebuild of the picker.
    const currentList = () => companyList(ctx);
    const selectedSet = () => new Set(selection.map((c) => c.ticker.toUpperCase()));

    const closeResults = () => {
      if (results) {
        results.classList.add('hidden');
        results.innerHTML = '';
      }
    };
    function renderResults(q) {
      if (!results) return;
      const sel = selectedSet();
      const ql = q.toLowerCase();
      const matches = currentList()
        .filter((c) => !sel.has(c.ticker.toUpperCase()) && (c.ticker.toLowerCase().includes(ql) || String(c.name || '').toLowerCase().includes(ql)))
        .slice(0, 8);
      results.innerHTML = matches.length
        ? matches
            .map(
              (c) => `
          <button type="button" data-picker-add="${escapeHtml(c.ticker)}" class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-indigo-50/60">
            <span class="font-semibold text-slate-800">${escapeHtml(c.ticker)}</span>
            <span class="truncate text-slate-400">${escapeHtml(c.name || '')}</span>
          </button>`
            )
            .join('')
        : '<div class="px-3 py-2 text-xs text-slate-400">No matching company in your book or the NSE-500 universe.</div>';
      results.classList.remove('hidden');
    }

    function addByTicker(ticker) {
      const t = String(ticker).toUpperCase();
      if (!t || selection.some((c) => c.ticker.toUpperCase() === t)) return;
      if (selection.length >= (picker.max || 20)) return;
      const found = currentList().find((c) => c.ticker.toUpperCase() === t) || { ticker: t, name: null };
      selection = [...selection, { ticker: found.ticker, name: found.name || null }];
      saveSelection();
      if (input) input.value = '';
      closeResults();
      paintPicker(ctx);
    }
    function removeByTicker(ticker) {
      const t = String(ticker).toUpperCase();
      selection = selection.filter((c) => c.ticker.toUpperCase() !== t);
      saveSelection();
      paintPicker(ctx);
    }

    input?.addEventListener('input', () => {
      const q = input.value.trim();
      if (!q) return closeResults();
      renderResults(q);
    });
    input?.addEventListener('focus', () => {
      const q = input.value.trim();
      if (q) renderResults(q);
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results?.querySelector('[data-picker-add]');
        if (first) {
          e.preventDefault();
          addByTicker(first.dataset.pickerAdd);
        }
      } else if (e.key === 'Escape') {
        closeResults();
      }
    });
    // mousedown, not click, so the add fires before the input's blur can hide the dropdown.
    results?.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('[data-picker-add]');
      if (btn) {
        e.preventDefault();
        addByTicker(btn.dataset.pickerAdd);
      }
    });
    el.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-picker-remove]');
      if (rm) return removeByTicker(rm.dataset.pickerRemove);
      if (e.target.closest('[data-picker-search]')) return void (selection.length && runSearch(ctx));
      if (e.target.closest('[data-picker-clear]')) return clearSelection(ctx);
    });

    const onDocClick = (e) => {
      if (!el.contains(e.target)) closeResults();
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }

  /** The gate's face: no company chosen, so no request has been made. */
  function promptPanel() {
    return `
      <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500 ring-1 ring-indigo-100">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </div>
        <h3 class="font-display mt-4 text-lg font-bold text-slate-900">Pick the companies you want news for</h3>
        <p class="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500">
          Search a company by name or symbol above and add up to ${picker.max}, then press
          <strong>Search news</strong> to pull their recent headlines — one live search per company,
          newest first. Nothing is loaded until you choose, so the results are only ever the companies you asked for.
        </p>
      </div>`;
  }

  /** Selected companies not yet run through the feed — a nudge to press Search. */
  function pendingHint() {
    if (searching || !searched) return '';
    const adds = selection.filter((c) => !searched.has(c.ticker.toUpperCase()));
    if (!adds.length) return '';
    return `
      <div class="mb-4 flex items-center gap-2 rounded-xl bg-indigo-50/70 p-3 text-xs text-indigo-700 ring-1 ring-indigo-100">
        <span class="text-indigo-500">↻</span>
        <span>You've added <strong>${adds.length}</strong> ${adds.length === 1 ? 'company' : 'companies'} — press <strong>Search news</strong> to load ${adds.length === 1 ? 'it' : 'them'}.</span>
      </div>`;
  }

  /**
   * The honest tally for selected companies that produced no article rows.
   *
   * Two states, kept distinct as everywhere else in this feed: a company with no news in the window,
   * and a company that could not be read at all. Neither is invented as a table row — an em-dash
   * "headline" would read as a broken article — so they are named here instead. Suppressed while the
   * walk is still running, because a company with no rows YET is pending, not empty.
   */
  function accountingNote(m) {
    if (searching || m.pending) return '';
    const withRows = new Set(cfg.feed.rows().map((r) => String(r.ticker).toUpperCase()));
    const empty = [];
    const failed = [];
    for (const c of selection) {
      const t = c.ticker.toUpperCase();
      if (withRows.has(t)) continue;
      (cfg.feed.failureFor(t) ? failed : empty).push(c);
    }
    if (!empty.length && !failed.length) return '';
    const names = (cs) => cs.map((c) => `<span class="font-medium">${escapeHtml(c.ticker)}</span>`).join(', ');
    const parts = [];
    if (empty.length)
      parts.push(
        `<p class="text-xs text-slate-500"><strong>${empty.length}</strong> of your ${selection.length} selected ${
          selection.length === 1 ? 'company' : 'companies'
        } had no news in the last ${escapeHtml(String(m.windowDays))} days: ${names(empty)}.</p>`
      );
    if (failed.length)
      parts.push(
        `<p class="mt-1 text-xs text-amber-700"><strong>${failed.length}</strong> could not be read just now and ${
          failed.length === 1 ? 'is' : 'are'
        } not shown as empty: ${names(failed)}.</p>`
      );
    return `<div class="mb-4 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">${parts.join('')}</div>`;
  }

  function destroy() {
    token++;
    ctxRef = null;
    searching = false;
    refreshing = false;
    refreshMsg = null;
    clearTimeout(refreshTimer);
    disposers.forEach((d) => d && d());
    disposers = [];
    unsub?.();
    unsub = null;
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
  // NOTHING LOADED IS NOT "LIVE". With cache-first mount a tab can sit at zero companies before its
  // first Refresh, and `origin` is null there — which the label logic below would otherwise spell as
  // "Live". A freshness control may never claim a freshness it has not got, so the empty state gets
  // its own neutral chip that says exactly what is true: nothing has been fetched yet.
  if (!bad && !m.covered) {
    return `
      <button type="button" data-filings-info title="Where this comes from, how far back it reaches, and what is missing"
        class="inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-100">
        <span class="h-1.5 w-1.5 rounded-full bg-slate-300"></span><span>Not fetched</span>
        <span class="font-normal opacity-70">${escapeHtml(String(m.windowDays))}d window</span>
      </button>`;
  }
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

/** While a live walk is running, say so — a half-filled table should explain itself. */
function walkStrip(m) {
  if (!m.pending && !m.inFlight && !m.truncated) return '';
  return `
    <div class="mb-5 flex items-start gap-3 rounded-2xl bg-indigo-50/70 p-3 ring-1 ring-indigo-100">
      <span class="relative mt-1 flex h-2 w-2 flex-shrink-0">
        ${m.pending ? '<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75"></span>' : ''}
        <span class="relative inline-flex h-2 w-2 rounded-full bg-indigo-600"></span>
      </span>
      <p class="text-xs leading-relaxed text-slate-600">
        ${m.pending ? `Reading <strong>${escapeHtml(formatNumber(m.pending))}</strong> more ${m.pending === 1 ? 'company' : 'companies'}. Each is a separate request upstream, so they arrive a few at a time.` : ''}
        ${
          m.truncated
            ? ` <strong>${escapeHtml(formatNumber(m.truncated))}</strong> more ${m.truncated === 1 ? 'company is' : 'companies are'} in scope but were not asked about on this visit —
                these upstreams allow about sixty requests a minute, so a live walk is bounded and the committed snapshot is what covers the rest.`
            : ''
        }
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
function unavailablePanel(m) {
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
    <p class="mt-2 text-xs">A company with no rows had <em>nothing in this window</em>; a company that could not be read is not
       listed at all. Those are different states and the pill counts them separately.</p>
    ${deliveryNote({ origin: m.origin === 'live' || m.origin === 'mixed' ? 'live' : 'store', checkedAt: m.checkedAt, fetchedAt: m.capturedAt ? Date.parse(m.capturedAt) : null, persisted: m.persisted })}`;
}
