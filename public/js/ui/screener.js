// ui/screener.js — the screener kit. Five components every tab is assembled from.
//
//   statStrip(cards)      4-up KPI row; card 4 is always the gradient freshness hero
//   topCards(config)      the Top-N hero grid, click-through to the drill panel
//   scoreTable(config)    the workhorse table: search, filter, watchlist, sort, export
//   openDrill(config)     right-slide detail panel (singleton overlay in index.html)
//   openModal(html, opts) centred modal (singleton overlay in index.html)
//
// Every component returns `{ html, wire(root) }` unless noted. `wire()` returns a disposer
// when it registers anything global (document listeners), which the owning tab must call from
// destroy(). The two overlays are singletons — no tab mounts its own copy.
//
// Nothing here knows about any specific tab. Callers supply columns, accessors and formatters;
// the kit supplies the look. Score and Signals columns are opt-in, so tabs without a scoring
// model (all of them until prompt 3) render a clean table with no empty score furniture.

import { escapeHtml } from '../core/dom.js';
import { avatarFor, scoreTier, scoreBadgeClass, tierLabel, tierColor, statusPill, signalDots } from './visual.js';

// ---------------------------------------------------------------------------------------
// Watchlist — one shared, localStorage-backed set of company keys across every tab.
// ---------------------------------------------------------------------------------------

const WATCH_KEY = 'sattva:watchlist';

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCH_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveWatchlist(set) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Private mode / quota — the toggle still works for this session, it just won't persist.
  }
}

export const watchlist = {
  get: loadWatchlist,
  has: (key) => loadWatchlist().has(key),
  toggle(key) {
    const set = loadWatchlist();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    saveWatchlist(set);
    return set.has(key);
  },
  size: () => loadWatchlist().size,
};

// ---------------------------------------------------------------------------------------
// (b) statStrip — the 4-up KPI row that opens every tab.
// ---------------------------------------------------------------------------------------

/**
 * statStrip(cards)
 * `cards` is up to 4 entries. Cards 1–3 are white surfaces:
 *   { label, value, note?, help?: { title, body } }
 * Card 4 is ALWAYS the gradient freshness hero, declared as:
 *   { hero: true, label: 'Last Refresh', value: '5h ago', note: 'Yahoo Finance EOD' }
 * If the caller omits a hero card the strip renders 3 cards and leaves the slot empty rather
 * than inventing a freshness claim.
 *
 * A card's optional `help` adds a small ? button that opens a modal explaining that metric.
 */
export function statStrip(cards = []) {
  const helpRegistry = [];

  const html = `
    <section class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${cards
        .map((card, i) => {
          if (card.hero) {
            return `
              <div class="stat-card rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 p-4 text-white shadow-lg">
                <div class="text-xs font-medium uppercase tracking-wider opacity-90">${escapeHtml(card.label)}</div>
                <div class="mt-1 text-2xl font-bold">${escapeHtml(card.value)}</div>
                ${card.note ? `<div class="mt-0.5 text-xs opacity-90">${escapeHtml(card.note)}</div>` : ''}
              </div>`;
          }
          if (card.help) helpRegistry.push({ index: i, ...card.help });
          return `
            <div class="stat-card relative rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
              <div class="flex items-start justify-between gap-2">
                <div class="text-xs font-medium uppercase tracking-wider text-slate-500">${escapeHtml(card.label)}</div>
                ${
                  card.help
                    ? `<button type="button" data-stat-help="${i}" title="How this is measured"
                         class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-50 text-[11px] font-bold text-indigo-600 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-100 hover:text-indigo-700 hover:ring-indigo-300">?</button>`
                    : ''
                }
              </div>
              <div class="mt-1 text-2xl font-bold text-slate-900">${escapeHtml(card.value)}</div>
              ${card.note ? `<div class="mt-0.5 text-xs text-slate-500">${escapeHtml(card.note)}</div>` : ''}
            </div>`;
        })
        .join('')}
    </section>`;

  function wire(root) {
    root.querySelectorAll('[data-stat-help]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = helpRegistry.find((h) => String(h.index) === btn.dataset.statHelp);
        if (!entry) return;
        openModal(
          `<div class="px-7 py-6">
            <div class="mb-3 flex items-start justify-between gap-4">
              <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(entry.title)}</h2>
              <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
            </div>
            <div class="text-sm leading-relaxed text-slate-600">${entry.body}</div>
          </div>`,
          { size: 'default' }
        );
      });
    });
    return () => {};
  }

  return { html, wire };
}

// ---------------------------------------------------------------------------------------
// (c) topCards — the Top-N hero grid.
// ---------------------------------------------------------------------------------------

/**
 * topCards({ title, items, valueFormat, onSelect, limit })
 *
 *  title        e.g. "Top 10 by Earnings Surprise" (a 🏆 is prepended)
 *  items        [{ name, sub?, value, max?, tone?, warn?, payload? }]
 *  valueFormat  'score'  → renders `value/max` and colours by tier (needs `max`)
 *               'metric' → renders `value` verbatim, coloured by `tone`
 *  tone         for 'metric': 'positive' | 'negative' | 'caution' | 'neutral' | 'brand'
 *  onSelect     (item, index) => void — fired on card click, wire up the drill panel here
 *  limit        default 10
 */
const METRIC_TONE = {
  positive: 'text-emerald-600',
  negative: 'text-rose-600',
  caution: 'text-amber-600',
  brand: 'text-indigo-600',
  neutral: 'text-slate-700',
};

export function topCards({ title, items = [], valueFormat = 'metric', onSelect = null, limit = 10 }) {
  const shown = items.slice(0, limit);

  const html = `
    <section class="mb-8" data-top-cards>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="font-display flex items-center gap-2 text-lg font-bold text-slate-900">
          <span class="text-amber-500">🏆</span> ${escapeHtml(title)}
        </h2>
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        ${shown
          .map((item, i) => {
            const { color, initials } = avatarFor(item.name);
            const isScore = valueFormat === 'score';
            const tier = item.warn ? 'hardfail' : isScore ? scoreTier(item.max ? (item.value / item.max) * 100 : 0) : null;
            const valueClass = isScore ? tierColor(tier) : METRIC_TONE[item.tone] || METRIC_TONE.neutral;
            const valueHtml = isScore
              ? `${escapeHtml(item.value)}<span class="text-base text-slate-400">/${escapeHtml(item.max)}</span>`
              : escapeHtml(item.value);
            const caption = isScore ? tierLabel(tier) : item.caption || '';
            return `
              <button type="button" data-top-idx="${i}"
                class="group relative overflow-hidden rounded-2xl bg-white p-4 text-left shadow-sm ring-1 ring-slate-100 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
                <div class="absolute right-3 top-3 text-xs font-bold text-slate-400">#${i + 1}</div>
                <div class="mb-3 flex items-center gap-3">
                  <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-sm font-bold text-white shadow-md">${escapeHtml(initials)}</div>
                  <div class="min-w-0 flex-1 pr-6">
                    <div class="truncate text-sm font-semibold text-slate-900">${escapeHtml(item.name)}</div>
                    ${item.sub ? `<div class="truncate text-xs text-slate-500">${escapeHtml(item.sub)}</div>` : ''}
                  </div>
                </div>
                <div class="flex items-end justify-between">
                  <div class="min-w-0">
                    <div class="truncate text-3xl font-bold tabular-nums ${valueClass}">${valueHtml}</div>
                    ${caption ? `<div class="mt-0.5 truncate text-xs text-slate-500">${escapeHtml(caption)}</div>` : ''}
                  </div>
                  ${item.warn ? `<div class="flex-shrink-0 text-xl text-rose-500" title="${escapeHtml(item.warn)}">⚠</div>` : ''}
                </div>
              </button>`;
          })
          .join('')}
      </div>
    </section>`;

  function wire(root) {
    const host = root.querySelector('[data-top-cards]');
    if (!host || !onSelect) return () => {};
    host.querySelectorAll('[data-top-idx]').forEach((el) => {
      el.addEventListener('click', () => onSelect(shown[Number(el.dataset.topIdx)], Number(el.dataset.topIdx)));
    });
    return () => {};
  }

  return { html, wire };
}

// ---------------------------------------------------------------------------------------
// (d) scoreTable — the workhorse.
// ---------------------------------------------------------------------------------------

/**
 * scoreTable(config)
 *
 *  rows          array of row objects (already scoped/filtered by the tab)
 *  key           (row) => stable string id, used for the watchlist. Defaults to row.ticker.
 *  name          (row) => company display name (drives the avatar)
 *  sub           (row) => the small grey line under the name (market cap, sector…)
 *  columns       [{ label, get(row), html?, align?, sortable?, sortValue?(row) }]
 *                `html: true` means get() returns trusted markup — escape inside it yourself.
 *  showScore     default false. When true, supply score(row) => { points, max, pct, redFlag? }
 *  showSignals   default false. When true, supply signals(row) => [{ label, status }]
 *  link          (row) => url for the right-aligned ↗, or null to omit the column
 *  onRowClick    (row) => void
 *  filters       { label, options: [{ value, label }], match(row, value) } — the <select>
 *  searchable    (row) => haystack string. Defaults to name(row).
 *  initialSort   { key, dir } where key is a column label, 'name', or 'score'
 *  emptyMessage  string shown when nothing matches
 *  exportName    file stem used by the Export button (a stub until prompt 3)
 *
 * Sorting, search, watchlist-only and the filter select are all handled internally; the table
 * re-renders its own tbody without the tab getting involved.
 */
export function scoreTable(config) {
  const {
    rows = [],
    key = (r) => r.ticker,
    name = (r) => r.name,
    nameLabel = 'Company', // header for the identity column — set it when rows aren't companies
    sub = () => '',
    columns = [],
    showScore = false,
    score = null,
    showSignals = false,
    signals = null,
    link = null,
    onRowClick = null,
    filters = null,
    searchable = null,
    initialSort = null,
    emptyMessage = 'No companies match your filters.',
    exportName = 'sattva-export',
    onExport = null, // (visibleRows, exportName) => void — see ui/export.js
  } = config;

  // Internal view state — search text, filter value, watchlist-only, sort.
  const view = {
    q: '',
    filter: filters ? 'all' : null,
    watchOnly: false,
    sort: initialSort ? { ...initialSort } : null,
  };

  const totalCount = rows.length;

  function haystack(row) {
    return (searchable ? searchable(row) : `${name(row)} ${key(row)}`).toLowerCase();
  }

  function sortValueFor(row, sortKey) {
    if (sortKey === 'name') return String(name(row)).toLowerCase();
    if (sortKey === 'score') return score ? score(row).pct : 0;
    const col = columns.find((c) => c.label === sortKey);
    if (!col) return 0;
    if (col.sortValue) return col.sortValue(row);
    const raw = col.get(row);
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
    return Number.isNaN(num) ? String(raw).toLowerCase() : num;
  }

  function visibleRows() {
    const watched = view.watchOnly ? loadWatchlist() : null;
    let out = rows.filter((row) => {
      if (view.q && !haystack(row).includes(view.q)) return false;
      if (watched && !watched.has(String(key(row)))) return false;
      if (filters && view.filter !== 'all' && !filters.match(row, view.filter)) return false;
      return true;
    });
    if (view.sort) {
      const { key: sk, dir } = view.sort;
      const mul = dir === 'asc' ? 1 : -1;
      out = out.slice().sort((a, b) => {
        const av = sortValueFor(a, sk);
        const bv = sortValueFor(b, sk);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * mul;
      });
    }
    return out;
  }

  // ---- markup -------------------------------------------------------------------------

  const colCount = 2 + (showScore ? 1 : 0) + (showSignals ? 1 : 0) + columns.length + (link ? 1 : 0);

  function headHtml() {
    const th = (label, sortKey, align = 'left') => {
      const sortable = sortKey !== null;
      const active = view.sort && view.sort.key === sortKey;
      return `<th class="whitespace-nowrap px-4 py-3 text-${align} text-xs font-bold uppercase tracking-wider text-slate-600 ${sortable ? 'cursor-pointer select-none hover:text-indigo-600' : ''}"
        ${sortable ? `data-sort="${escapeHtml(sortKey)}"` : ''}>${escapeHtml(label)}${active ? (view.sort.dir === 'asc' ? ' ▴' : ' ▾') : ''}</th>`;
    };
    return `
      <tr>
        <th class="w-12 px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">#</th>
        ${th(nameLabel, 'name')}
        ${showScore ? th('Score', 'score') : ''}
        ${showSignals ? `<th class="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Signals</th>` : ''}
        ${columns.map((c) => th(c.label, c.sortable === false ? null : c.label, c.align === 'right' ? 'right' : 'left')).join('')}
        ${link ? `<th class="px-4 py-3 text-right text-xs font-bold uppercase tracking-wider text-slate-600">Link</th>` : ''}
      </tr>`;
  }

  // Per-row markup is CACHED by row key. Rows are position-independent — the rank number is
  // drawn by a CSS counter and the click target carries the row's key, not its index — so a
  // sort is just "reorder cached strings and re-join", not "rebuild 535 rows". The cache is
  // dropped whenever the watchlist changes (that's the only per-row state in the markup).
  const rowHtmlCache = new Map();

  function bodyHtml(list) {
    if (!list.length) {
      return `<tr><td colspan="${colCount}" class="px-4 py-12 text-center text-slate-400">${escapeHtml(emptyMessage)}</td></tr>`;
    }
    const watched = loadWatchlist();
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const slug = String(key(row));
      let html = rowHtmlCache.get(slug);
      if (html === undefined) {
        html = rowHtml(row, slug, watched.has(slug));
        rowHtmlCache.set(slug, html);
      }
      out[i] = html;
    }
    return out.join('');
  }

  function rowHtml(row, slug, isWatched) {
        const label = String(name(row));
        const { color, initials } = avatarFor(label);
        const sc = showScore && score ? score(row) : null;
        const redFlag = !!(sc && sc.redFlag);
        return `
          <tr data-row-key="${escapeHtml(slug)}" class="row-line border-b border-slate-100 transition-colors ${onRowClick ? 'cursor-pointer' : ''} ${redFlag ? 'bg-rose-50/40 hover:bg-rose-50' : 'hover:bg-slate-50'}"
            ${redFlag ? 'style="box-shadow: inset 3px 0 0 #f43f5e"' : ''}>
            <td class="px-4 py-3 text-sm font-medium text-slate-500">
              <div class="flex items-center gap-1">
                <button type="button" data-watch="${escapeHtml(slug)}" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}"
                  class="watch-star text-base leading-none transition-colors ${isWatched ? 'text-amber-400' : 'text-slate-300 hover:text-amber-400'}">${isWatched ? '★' : '☆'}</button>
                <span class="row-rank"></span>
              </div>
            </td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-3">
                <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${color} text-xs font-bold text-white shadow-sm">${escapeHtml(initials)}</div>
                <div class="min-w-0">
                  <div class="truncate font-semibold text-slate-900">${escapeHtml(label)}</div>
                  <div class="truncate text-xs text-slate-500">${escapeHtml(sub(row))}</div>
                </div>
              </div>
            </td>
            ${
              sc
                ? `<td class="px-4 py-3">
                     <div class="flex items-center gap-2">
                       <span class="inline-flex min-w-[78px] items-center justify-center rounded-lg px-2.5 py-1 text-sm font-bold tabular-nums ${scoreBadgeClass(sc.pct)}">${escapeHtml(sc.points)}/${escapeHtml(sc.max)}</span>
                       ${redFlag ? `<span class="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700 ring-1 ring-rose-200" title="${escapeHtml(sc.redFlag)}">⚠ Red Flag</span>` : ''}
                     </div>
                   </td>`
                : ''
            }
            ${showSignals ? `<td class="px-4 py-3"><div class="flex items-center gap-1">${signals ? signalDots(signals(row)) : ''}</div></td>` : ''}
            ${columns
              .map(
                (c) =>
                  `<td class="whitespace-nowrap px-4 py-3 text-sm text-slate-700 ${c.align === 'right' ? 'text-right tabular-nums' : ''}">${c.html ? c.get(row) : escapeHtml(c.get(row))}</td>`
              )
              .join('')}
            ${link ? `<td class="px-4 py-3 text-right"><a href="${escapeHtml(link(row) || '#')}" target="_blank" rel="noopener" data-stop class="text-sm font-medium text-indigo-600 hover:text-indigo-800">↗</a></td>` : ''}
          </tr>`;
  }

  const initialList = visibleRows();

  const html = `
    <section class="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100" data-score-table>
      <div class="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center">
        <div class="flex flex-1 flex-wrap items-center gap-2">
          <div class="relative max-w-md flex-1">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input type="text" data-table-search placeholder="Search company..."
              class="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          ${
            filters
              ? `<select data-table-filter class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                   ${filters.options.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')}
                 </select>`
              : ''
          }
          <button type="button" data-watch-toggle title="Show only watchlisted companies"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm transition-colors hover:border-amber-200 hover:bg-amber-50">
            <span data-watch-icon class="text-amber-400">☆</span>
            <span>Watchlist</span>
            <span data-watch-count class="min-w-[18px] rounded-full bg-slate-200/70 px-1.5 py-0.5 text-center text-[10px] font-bold text-slate-500">${watchlist.size()}</span>
          </button>
        </div>
        <div class="flex items-center gap-3">
          <div class="hidden text-xs text-slate-500 sm:block">
            <span data-row-count class="font-semibold text-slate-700">${initialList.length} of ${totalCount}</span> shown
          </div>
          <button type="button" data-export
            class="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-emerald-700 hover:shadow">
            <span>📊</span> Export Excel
          </button>
        </div>
      </div>

      <div class="scrollbar-thin overflow-x-auto" data-table-scroll>
        <table class="w-full text-sm">
          <thead data-table-head class="sticky top-0 z-10 bg-slate-50/70">${headHtml()}</thead>
          <tbody data-table-body>${bodyHtml(initialList)}</tbody>
        </table>
      </div>
    </section>`;

  function wire(root) {
    const host = root.querySelector('[data-score-table]');
    if (!host) return () => {};
    const head = host.querySelector('[data-table-head]');
    const body = host.querySelector('[data-table-body]');
    const countEl = host.querySelector('[data-row-count]');
    const searchEl = host.querySelector('[data-table-search]');
    const filterEl = host.querySelector('[data-table-filter]');
    const watchBtn = host.querySelector('[data-watch-toggle]');
    const watchIcon = host.querySelector('[data-watch-icon]');
    const watchCount = host.querySelector('[data-watch-count]');

    let current = initialList;

    // Repaint has a fast path. Sorting and narrowing a filter both leave a row SET the DOM
    // already contains, so we reorder the existing <tr> nodes (appendChild moves a node) and
    // drop the ones that fell out — no HTML re-parse. Only a genuinely new row forces the
    // innerHTML path. On 535 rows this is the difference between ~150ms and ~10ms per sort.
    // Listeners are delegated, so neither path re-binds anything.
    function repaint() {
      current = visibleRows();
      head.innerHTML = headHtml();

      const existing = new Map();
      for (const tr of body.children) if (tr.dataset?.rowKey) existing.set(tr.dataset.rowKey, tr);

      const nextKeys = current.map((r) => String(key(r)));
      const canReorder = current.length > 0 && existing.size > 0 && nextKeys.every((k) => existing.has(k));

      if (canReorder) {
        const keep = new Set(nextKeys);
        for (const [k, tr] of existing) if (!keep.has(k)) tr.remove();
        const frag = document.createDocumentFragment();
        for (const k of nextKeys) frag.appendChild(existing.get(k)); // moves, doesn't clone
        body.appendChild(frag);
      } else {
        body.innerHTML = bodyHtml(current);
      }

      countEl.textContent = `${current.length} of ${totalCount}`;
      watchCount.textContent = String(watchlist.size());
    }

    // Delegated: header sort.
    head.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th || !head.contains(th)) return;
      const k = th.dataset.sort;
      if (view.sort && view.sort.key === k) view.sort.dir = view.sort.dir === 'asc' ? 'desc' : 'asc';
      else view.sort = { key: k, dir: 'desc' };
      repaint();
    });

    // Delegated: watchlist star, external link, row click — in that priority order.
    body.addEventListener('click', (e) => {
      const star = e.target.closest('[data-watch]');
      if (star) {
        e.stopPropagation();
        const slug = star.dataset.watch;
        watchlist.toggle(slug);
        rowHtmlCache.delete(slug); // its star changed — rebuild just that row next paint
        repaint();
        return;
      }
      if (e.target.closest('[data-stop]')) {
        e.stopPropagation();
        return;
      }
      if (!onRowClick) return;
      const tr = e.target.closest('tr[data-row-key]');
      if (!tr) return;
      const row = current.find((r) => String(key(r)) === tr.dataset.rowKey);
      if (row) onRowClick(row);
    });

    searchEl.addEventListener('input', () => {
      view.q = searchEl.value.trim().toLowerCase();
      repaint();
    });

    filterEl?.addEventListener('change', () => {
      view.filter = filterEl.value;
      repaint();
    });

    watchBtn.addEventListener('click', () => {
      view.watchOnly = !view.watchOnly;
      rowHtmlCache.clear(); // star styling is baked into the cached markup
      watchIcon.textContent = view.watchOnly ? '★' : '☆';
      watchBtn.classList.toggle('bg-amber-100', view.watchOnly);
      watchBtn.classList.toggle('border-amber-300', view.watchOnly);
      watchBtn.classList.toggle('text-amber-800', view.watchOnly);
      repaint();
    });

    // Export: `onExport` receives the currently visible rows. Tabs that haven't adopted the
    // real exporter yet fall back to logging intent rather than silently doing nothing.
    host.querySelector('[data-export]').addEventListener('click', () => {
      if (onExport) onExport(current, exportName);
      else console.info(`[stub] Export Excel → "${exportName}" (${current.length} rows).`);
    });

    return () => {};
  }

  return { html, wire };
}

// ---------------------------------------------------------------------------------------
// (e) drill panel + modal — singleton overlays declared in index.html.
// ---------------------------------------------------------------------------------------

let drillKeyHandler = null;

/**
 * openDrill({ name, sub, link, linkLabel, headerStats, groups, banner })
 *
 *  name         company / entity name (drives the gradient avatar)
 *  sub          small line under the name (sector · industry)
 *  link         optional external url shown under the title
 *  headerStats  [{ label, value, caption?, tone? }] — rendered as a 2-up block
 *  groups       [{ category, items: [{ label, criteria?, status, value, note?, points?, max?, extraHtml? }] }]
 *               `extraHtml` is trusted markup appended inside the card (e.g. provenance chips).
 *  banner       optional { tone: 'rose'|'amber'|'slate', title, body } strip under the header
 */
export function openDrill({ name = '', sub = '', link = null, linkLabel = 'Open source ↗', headerStats = [], groups = [], banner = null }) {
  const panel = document.getElementById('drill-panel');
  const overlay = document.getElementById('drill-overlay');
  const content = document.getElementById('drill-content');
  if (!panel || !overlay || !content) return;

  const { color, initials } = avatarFor(name);

  const bannerTone = {
    rose: 'bg-rose-50 ring-rose-100 text-rose-800',
    amber: 'bg-amber-50 ring-amber-100 text-amber-800',
    slate: 'bg-slate-100 ring-slate-200 text-slate-700',
  };

  content.innerHTML = `
    <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 p-5 backdrop-blur-sm">
      <button data-drill-close class="absolute right-4 top-4 text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      <div class="flex items-center gap-4 pr-8">
        <div class="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-lg font-bold text-white shadow-md">${escapeHtml(initials)}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-xl font-bold text-slate-900">${escapeHtml(name)}</div>
          ${sub ? `<div class="mt-0.5 truncate text-xs text-slate-500">${escapeHtml(sub)}</div>` : ''}
          ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="text-xs text-indigo-600 hover:text-indigo-800">${escapeHtml(linkLabel)}</a>` : ''}
        </div>
      </div>
      ${
        headerStats.length
          ? `<div class="mt-4 grid grid-cols-2 gap-3">
               ${headerStats
                 .map(
                   (hs) => `
                 <div class="rounded-lg bg-slate-50 p-3">
                   <div class="text-xs font-medium text-slate-500">${escapeHtml(hs.label)}</div>
                   <div class="text-2xl font-bold tabular-nums ${METRIC_TONE[hs.tone] || 'text-slate-900'}">${escapeHtml(hs.value)}</div>
                   ${hs.caption ? `<div class="truncate text-xs text-slate-500">${escapeHtml(hs.caption)}</div>` : ''}
                 </div>`
                 )
                 .join('')}
             </div>`
          : ''
      }
      ${
        banner
          ? `<div class="mt-3 rounded-lg p-3 ring-1 ${bannerTone[banner.tone] || bannerTone.slate}">
               <div class="text-sm font-semibold">${escapeHtml(banner.title)}</div>
               <div class="mt-0.5 text-xs opacity-90">${escapeHtml(banner.body)}</div>
             </div>`
          : ''
      }
    </div>
    <div class="p-5">
      ${groups
        .map(
          (g) => `
        <div class="mb-5">
          <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">${escapeHtml(g.category)}</div>
          <div class="space-y-2">
            ${g.items
              .map(
                (item) => `
              <div class="rounded-xl bg-white p-3 ring-1 ring-slate-100 transition-shadow hover:ring-slate-200">
                <div class="mb-1 flex items-start justify-between gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-semibold text-slate-900">${escapeHtml(item.label)}</div>
                    ${item.criteria ? `<div class="text-xs text-slate-500">Criteria: <span class="font-medium">${escapeHtml(item.criteria)}</span></div>` : ''}
                  </div>
                  <div class="flex flex-shrink-0 items-center gap-2">
                    ${item.status ? statusPill(item.status) : ''}
                    ${item.points !== undefined && item.max !== undefined ? `<span class="text-sm font-bold tabular-nums text-slate-700">${escapeHtml(item.points)}/${escapeHtml(item.max)}</span>` : ''}
                  </div>
                </div>
                ${item.value == null || item.value === '' ? '' : `<div class="mt-2 text-sm tabular-nums text-slate-700">${escapeHtml(item.value)}</div>`}
                ${item.note ? `<div class="mt-1 text-xs italic text-slate-500">${escapeHtml(item.note)}</div>` : ''}
                ${item.extraHtml || ''}
              </div>`
              )
              .join('')}
          </div>
        </div>`
        )
        .join('')}
    </div>`;

  panel.classList.remove('translate-x-full');
  overlay.classList.remove('hidden');

  content.querySelector('[data-drill-close]')?.addEventListener('click', closeDrill);
  overlay.addEventListener('click', closeDrill, { once: true });

  drillKeyHandler = (e) => {
    if (e.key === 'Escape') closeDrill();
  };
  document.addEventListener('keydown', drillKeyHandler);
}

export function closeDrill() {
  const panel = document.getElementById('drill-panel');
  const overlay = document.getElementById('drill-overlay');
  panel?.classList.add('translate-x-full');
  overlay?.classList.add('hidden');
  if (drillKeyHandler) {
    document.removeEventListener('keydown', drillKeyHandler);
    drillKeyHandler = null;
  }
}

let modalKeyHandler = null;

/**
 * openModal(innerHtml, { size }) — centred modal. `size` is 'default' | 'wide' | 'magazine'.
 * Any element inside `innerHtml` carrying `data-modal-close` closes it, as do ESC and a
 * backdrop click.
 */
export function openModal(innerHtml, { size = 'default' } = {}) {
  const overlay = document.getElementById('modal-overlay');
  const container = document.getElementById('modal-container');
  const content = document.getElementById('modal-content');
  if (!overlay || !container || !content) return;

  const sizeClass = size === 'magazine' ? 'max-w-6xl' : size === 'wide' ? 'max-w-5xl' : 'max-w-4xl';
  container.className = `relative bg-white rounded-3xl shadow-2xl w-full ${sizeClass} my-8 scale-95 opacity-0 transition-all duration-200 overflow-hidden`;
  content.innerHTML = innerHtml;
  overlay.classList.remove('hidden');
  overlay.classList.add('is-open');
  requestAnimationFrame(() => container.classList.replace('scale-95', 'scale-100'));

  content.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', closeModal));
  overlay.addEventListener('click', onBackdrop);

  modalKeyHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', modalKeyHandler);
}

function onBackdrop(e) {
  if (e.target === e.currentTarget) closeModal();
}

export function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay) return;
  overlay.classList.remove('is-open');
  overlay.classList.add('hidden');
  overlay.removeEventListener('click', onBackdrop);
  if (content) content.innerHTML = '';
  if (modalKeyHandler) {
    document.removeEventListener('keydown', modalKeyHandler);
    modalKeyHandler = null;
  }
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------

/**
 * sectionHead({ title, description, meta }) — the title block above every tab's stat strip.
 * `meta` is trusted markup (usually a scope pill).
 */
export function sectionHead({ title, description = '', meta = '' }) {
  return `
    <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
        ${description ? `<p class="mt-1 max-w-2xl text-sm text-slate-500">${escapeHtml(description)}</p>` : ''}
      </div>
      ${meta ? `<div class="flex-shrink-0">${meta}</div>` : ''}
    </div>`;
}

/**
 * roadmapStrip(features, opts) — the dashed "coming in a later prompt" card that closes
 * every tab, restyled to slate-200 dashed with indigo bullet arrows.
 */
export function roadmapStrip(features = [], { note = 'Coming in a later prompt' } = {}) {
  return `
    <div class="mt-6 rounded-2xl border border-dashed border-slate-200 bg-white/60 p-4">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500">
        <span>🚧</span><span>${escapeHtml(note)}</span>
      </div>
      <ul class="grid gap-1.5 sm:grid-cols-2">
        ${features
          .map(
            (f) =>
              `<li class="flex items-start gap-1.5 text-xs text-slate-500"><span class="mt-0.5 font-bold text-indigo-400">›</span><span>${escapeHtml(f)}</span></li>`
          )
          .join('')}
      </ul>
    </div>`;
}

/**
 * pendingPanel({ title, body, arriving }) — the honest placeholder used where a genuine data
 * feed has not landed yet. Never fabricate numbers into a chart; render this instead.
 */
export function pendingPanel({ title, body, arriving = 'a later prompt' }) {
  return `
    <div class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div class="text-xs font-bold uppercase tracking-wider text-slate-400">${escapeHtml(title)}</div>
        <span class="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">Pending · ${escapeHtml(arriving)}</span>
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        ${Array.from({ length: 4 })
          .map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>')
          .join('')}
      </div>
      ${body ? `<p class="mt-3 text-xs text-slate-400">${escapeHtml(body)}</p>` : ''}
    </div>`;
}
