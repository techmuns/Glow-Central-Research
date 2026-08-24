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

  // ---------------------------------------------------------------------------------------
  // The company picker (news only)
  // ---------------------------------------------------------------------------------------

  /** How many companies one search may ask about. Each is a live request against a ~60/min cap. */
  const MAX_PICK = 20;

  /**
   * Everything the reader may pick from: the book first, then the rest of the coverage universe.
   *
   * THE NAME IS THE POINT, not the ticker. The news upstream is searched by company NAME —
   * `?q=JAYNECOIND` returns three results, most of them quote pages, while
   * `?q=Jayaswal Neco Industries` returns twenty about the company. A candidate with no name is
   * still offered, and searches by its symbol, which is a worse search and still a search.
   */
  function candidatesFor(ctx) {
    const out = [];
    const seen = new Set();
    for (const h of coverage.holdings()) {
      const t = String(h.ticker || '').toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ ticker: t, name: h.name || t, held: true });
    }
    for (const u of ctx.data?.universe || []) {
      const t = String(u.ticker || '').toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ ticker: t, name: u.name || t, held: false });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The current selection, read from the URL so a search is shareable and survives a reload.
   *
   * A ticker in the URL that is not in the candidate list is KEPT rather than dropped — the list is
   * this dashboard's coverage, and a reader who pasted a symbol we do not track has still asked a
   * real question. It searches by symbol and the chip says so by carrying no name.
   */
  function selectionFrom(ctx) {
    const raw = String(ctx.params?.co || '').trim();
    if (!raw) return [];
    const byTicker = new Map(candidatesFor(ctx).map((c) => [c.ticker, c]));
    const out = [];
    const seen = new Set();
    for (const part of raw.split(',')) {
      const t = part.trim().toUpperCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const hit = byTicker.get(t);
      out.push({ ticker: t, name: hit?.name || null, known: !!hit });
      if (out.length >= MAX_PICK) break;
    }
    return out;
  }

  const chip = (c) => `
    <span class="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-2.5 pr-1 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200">
      <span title="${escapeHtml(c.name || 'Not in this dashboard\'s coverage — searched by symbol')}">${escapeHtml(c.ticker)}</span>
      <button type="button" data-pick-remove="${escapeHtml(c.ticker)}" aria-label="Remove ${escapeHtml(c.ticker)}"
              class="flex h-4 w-4 items-center justify-center rounded-full text-indigo-400 hover:bg-indigo-100 hover:text-indigo-700">&times;</button>
    </span>`;

  function pickerHtml(ctx, selected) {
    const n = selected.length;
    return `
      <div data-picker class="w-full rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-100">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Companies</span>
          <div data-pick-chips class="flex flex-wrap items-center gap-1.5">${selected.map(chip).join('') || '<span class="text-xs text-slate-400">none selected</span>'}</div>
        </div>
        <div class="relative mt-2 flex flex-wrap items-center gap-2">
          <div class="relative min-w-[240px] flex-1">
            <input type="text" data-pick-search autocomplete="off" placeholder="Search a company by name or symbol…"
                   class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
            <div data-pick-list class="absolute left-0 right-0 top-full z-20 mt-1 hidden max-h-72 overflow-y-auto rounded-xl bg-white py-1 shadow-lg ring-1 ring-slate-200 scrollbar-thin"></div>
          </div>
          <button type="button" data-pick-go
                  class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
            Search news
          </button>
          <button type="button" data-pick-clear
                  class="rounded-xl px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800 ${n ? '' : 'hidden'}">Clear</button>
          <span data-pick-count class="text-xs text-slate-400">${n} of ${MAX_PICK} max</span>
        </div>
      </div>`;
  }

  /**
   * Selection is edited in the DOM and committed to the URL only on "Search news".
   *
   * Writing every add straight to `ctx.setParams` would re-mount the tab on each keystroke's worth
   * of clicking, tearing down the input the reader is typing into — and would fire a search for a
   * half-built list. The two-step is what the reader asked for: choose, then search.
   */
  function wirePicker(ctx, selected) {
    const root = ctx.root.querySelector('[data-picker]');
    if (!root) return;
    const pending = selected.map((c) => ({ ...c }));
    const chips = root.querySelector('[data-pick-chips]');
    const search = root.querySelector('[data-pick-search]');
    const list = root.querySelector('[data-pick-list]');
    const go = root.querySelector('[data-pick-go]');
    const clear = root.querySelector('[data-pick-clear]');
    const count = root.querySelector('[data-pick-count]');
    const candidates = candidatesFor(ctx);
    const current = selected.map((c) => c.ticker).join(',');

    const paintChips = () => {
      chips.innerHTML = pending.map(chip).join('') || '<span class="text-xs text-slate-400">none selected</span>';
      count.textContent = `${pending.length} of ${MAX_PICK} max`;
      clear.classList.toggle('hidden', !pending.length);
      // Disabled when nothing is selected, and when the selection is what is already on screen —
      // re-running an identical search would spend the budget to redraw the same rows.
      go.disabled = !pending.length || pending.map((c) => c.ticker).join(',') === current;
    };

    const closeList = () => {
      list.classList.add('hidden');
      list.innerHTML = '';
    };

    const openList = (q) => {
      const term = q.trim().toLowerCase();
      if (!term) return closeList();
      const picked = new Set(pending.map((c) => c.ticker));
      const hits = candidates
        .filter((c) => !picked.has(c.ticker) && (c.name.toLowerCase().includes(term) || c.ticker.toLowerCase().includes(term)))
        .slice(0, 50);
      if (!hits.length) {
        list.innerHTML = `<div class="px-3 py-2 text-xs text-slate-400">No company in coverage matches “${escapeHtml(q)}”.</div>`;
        list.classList.remove('hidden');
        return;
      }
      list.innerHTML = hits
        .map(
          (c) => `<button type="button" data-pick-add="${escapeHtml(c.ticker)}" data-pick-name="${escapeHtml(c.name)}"
                    class="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-indigo-50">
                    <span class="truncate text-slate-700">${escapeHtml(c.name)}</span>
                    <span class="flex-shrink-0 text-[11px] font-semibold text-slate-400">${escapeHtml(c.ticker)}${c.held ? ' · held' : ''}</span>
                  </button>`,
        )
        .join('');
      list.classList.remove('hidden');
    };

    const onSearch = () => openList(search.value);
    const onListClick = (e) => {
      const btn = e.target.closest('[data-pick-add]');
      if (!btn) return;
      const ticker = btn.getAttribute('data-pick-add');
      if (pending.length >= MAX_PICK || pending.some((c) => c.ticker === ticker)) return;
      pending.push({ ticker, name: btn.getAttribute('data-pick-name'), known: true });
      search.value = '';
      closeList();
      paintChips();
      search.focus();
    };
    const onChipClick = (e) => {
      const btn = e.target.closest('[data-pick-remove]');
      if (!btn) return;
      const ticker = btn.getAttribute('data-pick-remove');
      const i = pending.findIndex((c) => c.ticker === ticker);
      if (i >= 0) pending.splice(i, 1);
      paintChips();
    };
    const commit = () => {
      const next = { ...(ctx.params || {}) };
      if (pending.length) next.co = pending.map((c) => c.ticker).join(',');
      else delete next.co;
      ctx.setParams(next);
    };
    const onClear = () => {
      pending.length = 0;
      paintChips();
      commit();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return closeList();
      if (e.key === 'Enter') {
        const first = list.querySelector('[data-pick-add]');
        if (first) {
          e.preventDefault();
          first.click();
        } else if (!go.disabled) commit();
      }
    };
    const onDocClick = (e) => {
      if (!root.contains(e.target)) closeList();
    };

    search.addEventListener('input', onSearch);
    search.addEventListener('keydown', onKey);
    list.addEventListener('click', onListClick);
    chips.addEventListener('click', onChipClick);
    go.addEventListener('click', commit);
    clear.addEventListener('click', onClear);
    document.addEventListener('click', onDocClick);

    paintChips();
    // The document listener is global, so it must be released when the tab goes away.
    disposers.push(() => document.removeEventListener('click', onDocClick));
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

    // NEWS ASKS BEFORE IT SEARCHES, AND THAT IS NOT A LIMITATION DRESSED AS A FEATURE.
    //
    // The news upstream is a SEARCH endpoint — one request per company name — so "the whole
    // universe" is 603 requests against a sixty-a-minute cap, which is why this tab used to walk a
    // bounded forty and report the rest as unread. Announcements moved to a date-indexed source and
    // stopped needing a walk at all; news has no such index, because there is no "everyone's news
    // today" endpoint to ask. So the request budget goes where the reader actually wants it: they
    // name the companies, and every one they named is searched in full rather than forty arbitrary
    // ones being searched on their behalf.
    if (cfg.requireSelection) {
      const selected = selectionFrom(ctx);
      if (!selected.length) {
        ctx.root.innerHTML = `
          ${sectionHead({ title: cfg.title, description: cfg.subtitle, controls: pickerHtml(ctx, selected) })}
          ${chooseCompaniesPanel(cfg)}`;
        wirePicker(ctx, selected);
        return;
      }
      const items = selected.map((t2) => ({ ticker: t2.ticker, name: t2.name }));
      ctx.root.innerHTML = `
        ${sectionHead({ title: cfg.title, description: cfg.subtitle, controls: pickerHtml(ctx, selected) })}
        ${loadingHtml()}`;
      wirePicker(ctx, selected);
      cfg.feed.load(items).then(() => {
        if (t === token) paint(ctx);
      });
      return;
    }

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
    const m = cfg.feed.meta();
    const book = new Set(coverage.holdings().map((h) => h.ticker).filter(Boolean));
    let all = cfg.feed.rows();

    // THE FEED OUTLIVES THE SELECTION, so the rows must be narrowed to what was asked for.
    // `createFeed` is module-level and keeps every company it has ever loaded — which is what makes
    // a second visit instant. Painting all of it after the reader narrowed to two companies would
    // show them rows they did not ask for and count them in the pill.
    const selected = cfg.requireSelection ? selectionFrom(ctx) : null;
    if (selected) {
      const want = new Set(selected.map((s2) => s2.ticker));
      all = all.filter((r) => r.ticker && want.has(String(r.ticker).toUpperCase()));
    }
    const rows = ctx.scope === 'portfolio' ? all.filter((r) => r.ticker && book.has(String(r.ticker).toUpperCase())) : all;

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
          meta: scopeSummary({ scope: ctx.scope, count: 0, noun: cfg.noun, book: coverage.meta() }),
          controls: cfg.requireSelection ? pickerHtml(ctx, selected || []) : '',
        })}
        ${unavailablePanel(m)}`;
      if (cfg.requireSelection) wirePicker(ctx, selected || []);
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
      emptyMessage:
        ctx.scope === 'portfolio'
          ? `No ${cfg.noun} for your holdings in the last ${m.windowDays} days.`
          : `No ${cfg.noun} matches your filters.`,
    });
    view = table.view;

    ctx.root.innerHTML = `
      ${sectionHead({
        title: cfg.title,
        description: cfg.subtitle,
        meta: `<div class="flex flex-wrap items-center justify-end gap-2">${pill(m)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: cfg.noun, book: coverage.meta() })}</div>`,
        // A ROW OF ITS OWN, never the `meta` slot — `meta` sits in a justify-between row, so
        // whether it renders beside the title or wraps under it depends on how wide the chips and
        // the description happen to be, and both change as companies are added. A control that
        // moves when you use it reads as a different page.
        controls: cfg.requireSelection ? pickerHtml(ctx, selected || []) : '',
      })}
      ${walkStrip(m)}
      ${table.html}`;

    disposers.push(table.wire(ctx.root));
    if (cfg.requireSelection) wirePicker(ctx, selected || []);
    ctx.root.querySelector('[data-filings-info]')?.addEventListener('click', () => openModal(cfg.provenance(m), { size: 'default' }));
  }

  function destroy() {
    token++;
    ctxRef = null;
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

/**
 * The empty state before a company has been chosen.
 *
 * IT SAYS WHY, because a screen that asks for input without explaining itself reads as broken. The
 * reason is real and worth one sentence: the news upstream is a per-company search with no
 * "everyone's news" index to ask, so the choice is between forty arbitrary companies searched on
 * the reader's behalf and the ones they actually want, searched in full.
 */
const chooseCompaniesPanel = (cfg) => `
  <div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
    <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-xl">🔍</div>
    <h3 class="font-display text-lg font-bold text-slate-900">Choose the companies to search</h3>
    <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">
      ${escapeHtml(cfg.title)} is searched one company at a time — the upstream is a search endpoint, not a feed of
      everything published today, so there is no “all companies” request to make. Pick the companies you want and each one
      is searched in full.
    </p>
    <p class="mx-auto mt-3 max-w-xl text-xs text-slate-400">
      Your selection rides in the address bar, so a search can be bookmarked or shared.
    </p>
  </div>`;

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
