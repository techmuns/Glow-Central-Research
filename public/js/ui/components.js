// ui/components.js — shared UI primitives reused by every tab. Each primitive is a pure
// function: it returns either a plain HTML string, or `{ html, wire(root) }` when it needs
// event listeners / measurement after being inserted into the DOM. `wire()` never mutates
// global state on its own — it only wires the markup it was just handed.

import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime, toneForValue } from '../core/format.js';

const TONE_CLASSES = {
  positive: { text: 'text-emerald-700', bg: 'bg-emerald-50', ring: 'ring-emerald-100', dot: 'bg-emerald-500' },
  negative: { text: 'text-rose-700', bg: 'bg-rose-50', ring: 'ring-rose-100', dot: 'bg-rose-500' },
  caution: { text: 'text-amber-700', bg: 'bg-amber-50', ring: 'ring-amber-100', dot: 'bg-amber-500' },
  neutral: { text: 'text-slate-600', bg: 'bg-slate-100', ring: 'ring-slate-200', dot: 'bg-slate-400' },
  brand: { text: 'text-teal-700', bg: 'bg-teal-50', ring: 'ring-teal-100', dot: 'bg-teal-500' },
  accent: { text: 'text-violet-700', bg: 'bg-violet-50', ring: 'ring-violet-100', dot: 'bg-violet-500' },
};
function toneClasses(tone) {
  return TONE_CLASSES[tone] || TONE_CLASSES.neutral;
}

// A single KPI tile: label + big number + optional signed delta or sublabel.
export function statCard({ label, value, delta = null, deltaTone = null, sublabel = null }) {
  const tone = deltaTone || (delta != null ? toneForValue(parseFloat(delta)) : 'neutral');
  const c = toneClasses(tone);
  return `
    <div class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="text-xs font-medium text-slate-500">${escapeHtml(label)}</div>
      <div class="font-display mt-1 text-2xl font-extrabold tabular-nums text-slate-900">${escapeHtml(value)}</div>
      ${delta != null ? `<div class="mt-1 text-xs font-semibold tabular-nums ${c.text}">${escapeHtml(delta)}</div>` : sublabel ? `<div class="mt-1 text-xs text-slate-400">${escapeHtml(sublabel)}</div>` : ''}
    </div>`;
}

// Panel title + one-line description, with an optional right-aligned meta slot (e.g. a scope pill).
export function sectionHeader({ title, description = '', meta = '' }) {
  return `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="font-display text-xl font-bold text-slate-900">${escapeHtml(title)}</h2>
        ${description ? `<p class="mt-1 max-w-2xl text-sm text-slate-500">${escapeHtml(description)}</p>` : ''}
      </div>
      ${meta ? `<div class="shrink-0">${meta}</div>` : ''}
    </div>`;
}

// "Universe · 25 companies" / "Portfolio · 12 holdings" chip — reflects the global scope toggle.
export function scopeSummary({ scope, count, noun = 'companies' }) {
  const label = scope === 'portfolio' ? 'Portfolio' : 'Universe';
  const tone = scope === 'portfolio' ? 'accent' : 'brand';
  return pill({ label: `${label} · ${formatNumber(count)} ${noun}`, tone });
}

// Horizontal top-level tabs with an animated underline indicator (scaleX-style slide via translateX + width).
export function tabBar({ tabs, activeId, onSelect }) {
  // The underline lives INSIDE the scrolling list (not the outer wrapper) so it tracks the
  // active tab when the bar scrolls horizontally, and never juts past the viewport on mobile.
  const html = `
    <div class="border-b border-slate-200" data-tab-bar>
      <div class="relative flex gap-6 overflow-x-auto" role="tablist" data-tab-list>
        ${tabs
          .map(
            (t) => `
          <button type="button" role="tab" data-tab-id="${escapeHtml(t.id)}" aria-selected="${t.id === activeId}"
            class="relative shrink-0 whitespace-nowrap py-3 text-sm font-semibold transition-colors ${t.id === activeId ? 'text-teal-700' : 'text-slate-500 hover:text-slate-700'}">
            ${escapeHtml(t.label)}
          </button>`
          )
          .join('')}
        <span data-tab-underline class="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-gradient-to-r from-teal-600 to-emerald-600 transition-transform duration-300 ease-out" style="width:0px;transform:translateX(0px);"></span>
      </div>
    </div>`;

  function wire(root) {
    const bar = root.querySelector('[data-tab-bar]');
    const list = bar.querySelector('[data-tab-list]');
    const underline = bar.querySelector('[data-tab-underline]');

    function position() {
      const active = list.querySelector(`[data-tab-id="${cssEscape(activeId)}"]`);
      if (!active) return;
      underline.style.width = `${active.offsetWidth}px`;
      underline.style.transform = `translateX(${active.offsetLeft}px)`;
      // On narrow screens the active tab may sit outside the scrolled view — pull it in.
      if (active.offsetLeft < list.scrollLeft || active.offsetLeft + active.offsetWidth > list.scrollLeft + list.clientWidth) {
        list.scrollTo({ left: Math.max(0, active.offsetLeft - 16), behavior: 'smooth' });
      }
    }

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab-id]');
      if (btn) onSelect(btn.dataset.tabId);
    });

    requestAnimationFrame(position);
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }

  return { html, wire };
}

// Vertical sub-view list rendered under the workspace dropdown — active pill + optional count badge.
export function railNav({ items, activeId, onSelect }) {
  const html = `
    <nav class="flex flex-col gap-0.5" data-rail-nav>
      ${items
        .map(
          (item) => `
        <button type="button" data-rail-id="${escapeHtml(item.id)}"
          class="flex items-center justify-between rounded-xl border-l-2 px-3 py-2 text-left text-sm font-medium transition-colors ${
            item.id === activeId ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900'
          }">
          <span>${escapeHtml(item.label)}</span>
          ${
            item.badge !== undefined && item.badge !== null
              ? `<span class="ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${item.id === activeId ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-500'}">${escapeHtml(item.badge)}</span>`
              : ''
          }
        </button>`
        )
        .join('')}
    </nav>`;

  function wire(root) {
    const nav = root.querySelector('[data-rail-nav]');
    function handler(e) {
      const btn = e.target.closest('[data-rail-id]');
      if (btn) onSelect(btn.dataset.railId);
    }
    nav.addEventListener('click', handler);
    return () => nav.removeEventListener('click', handler);
  }

  return { html, wire };
}

// Two-option segmented control (Portfolio ⇄ Universe) with a sliding white "thumb".
export function segmentedToggle({ options, activeValue, onChange }) {
  const html = `
    <div class="relative inline-flex items-center rounded-full bg-slate-100 p-1" data-segmented>
      <span data-segmented-thumb class="absolute inset-y-1 rounded-full bg-white shadow-sm transition-all duration-200 ease-out" style="width:0px;transform:translateX(0px);"></span>
      ${options
        .map(
          (o) => `
        <button type="button" data-value="${escapeHtml(o.value)}"
          class="relative z-10 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${o.value === activeValue ? 'text-teal-700' : 'text-slate-500 hover:text-slate-700'}">
          ${escapeHtml(o.label)}
        </button>`
        )
        .join('')}
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-segmented]');
    const thumb = wrap.querySelector('[data-segmented-thumb]');

    function position() {
      const active = wrap.querySelector(`[data-value="${cssEscape(activeValue)}"]`);
      if (!active) return;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.transform = `translateX(${active.offsetLeft - 4}px)`;
    }

    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (btn) onChange(btn.dataset.value);
    });

    requestAnimationFrame(position);
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }

  return { html, wire };
}

// Sortable, sticky-header data table. Horizontal-scrolls inside its own container so the page
// body never scrolls sideways. Zebra-free — rows differentiate on hover only.
export function dataTable({ columns, rows, sortable = true, initialSort = null, emptyMessage = 'No data yet.' }) {
  function cellValue(row, col) {
    return col.render ? col.render(row) : escapeHtml(row[col.key] ?? '—');
  }

  function renderRows(list) {
    if (!list.length) {
      return `<tr><td colspan="${columns.length}">${emptyState({ title: emptyMessage })}</td></tr>`;
    }
    return list
      .map(
        (row) => `
      <tr class="border-t border-slate-50 transition-colors hover:bg-slate-50/70">
        ${columns.map((col) => `<td class="whitespace-nowrap px-3 py-2.5 text-sm text-slate-700 ${col.align === 'right' ? 'text-right tabular-nums' : ''}">${cellValue(row, col)}</td>`).join('')}
      </tr>`
      )
      .join('');
  }

  const html = `
    <div class="overflow-x-auto rounded-2xl ring-1 ring-slate-100" data-table-wrap>
      <table class="w-full min-w-max border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-slate-50/95 backdrop-blur">
          <tr>
            ${columns
              .map(
                (col) => `
              <th scope="col" data-col-key="${escapeHtml(col.key)}"
                class="whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 ${col.align === 'right' ? 'text-right' : 'text-left'} ${sortable && col.sortable !== false ? 'cursor-pointer select-none hover:text-slate-700' : ''}">
                <span class="inline-flex items-center gap-1">${escapeHtml(col.label)}${sortable && col.sortable !== false ? '<span class="sort-caret text-[10px] text-slate-300" data-caret>↕</span>' : ''}</span>
              </th>`
              )
              .join('')}
          </tr>
        </thead>
        <tbody data-table-body>${renderRows(rows)}</tbody>
      </table>
    </div>`;

  function wire(root) {
    if (!sortable) return () => {};
    const wrap = root.querySelector('[data-table-wrap]');
    const tbody = wrap.querySelector('[data-table-body]');
    let sortState = initialSort; // { key, dir: 'asc'|'desc' }
    let data = rows.slice();

    function applySort() {
      if (!sortState) return;
      const { key, dir } = sortState;
      const mul = dir === 'asc' ? 1 : -1;
      data = data.slice().sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av > bv ? 1 : -1) * mul;
      });
    }

    function updateCarets() {
      wrap.querySelectorAll('[data-col-key]').forEach((th) => {
        const caret = th.querySelector('[data-caret]');
        if (!caret) return;
        if (sortState && th.dataset.colKey === sortState.key) {
          caret.textContent = sortState.dir === 'asc' ? '▲' : '▼';
          caret.classList.remove('text-slate-300');
          caret.classList.add('text-teal-600');
        } else {
          caret.textContent = '↕';
          caret.classList.add('text-slate-300');
          caret.classList.remove('text-teal-600');
        }
      });
    }

    applySort();
    updateCarets();

    wrap.querySelectorAll('th[data-col-key]').forEach((th) => {
      const key = th.dataset.colKey;
      const col = columns.find((c) => c.key === key);
      if (!col || col.sortable === false) return;
      th.addEventListener('click', () => {
        const dir = sortState && sortState.key === key && sortState.dir === 'asc' ? 'desc' : 'asc';
        sortState = { key, dir };
        applySort();
        tbody.innerHTML = renderRows(data);
        updateCarets();
      });
    });

    return () => {};
  }

  return { html, wire };
}

// Small rounded label — status/tone chips (positive, negative, caution, neutral, brand, accent).
export function pill({ label, tone = 'neutral' }) {
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center gap-1 rounded-full ${c.bg} ${c.text} ring-1 ${c.ring} px-2.5 py-1 text-xs font-semibold">${escapeHtml(label)}</span>`;
}

// Compact numeric/status tag for inline table use (smaller than `pill`).
export function badge({ label, tone = 'neutral' }) {
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center rounded-md ${c.bg} ${c.text} px-1.5 py-0.5 text-[11px] font-bold tabular-nums">${escapeHtml(label)}</span>`;
}

// Score-out-of-max pill, colour-scaled green/amber/red by ratio (quality scores, technical scores…).
export function scorePill({ score, max = 100 }) {
  const ratio = max ? score / max : 0;
  const tone = ratio >= 0.7 ? 'positive' : ratio >= 0.4 ? 'caution' : 'negative';
  const c = toneClasses(tone);
  return `<span class="inline-flex items-center rounded-full ${c.bg} ${c.text} ring-1 ${c.ring} px-2 py-0.5 text-xs font-bold tabular-nums">${formatNumber(score)}${max ? `<span class="ml-0.5 font-medium opacity-60">/${formatNumber(max)}</span>` : ''}</span>`;
}

// Row of toggleable filter chips (single- or multi-select, caller decides via onToggle logic).
export function filterChips({ options, activeIds = [], onToggle }) {
  const html = `
    <div class="flex flex-wrap gap-2" data-filter-chips>
      ${options
        .map(
          (o) => `
        <button type="button" data-chip-id="${escapeHtml(o.id)}"
          class="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
            activeIds.includes(o.id) ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }">
          ${escapeHtml(o.label)}
        </button>`
        )
        .join('')}
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-filter-chips]');
    function handler(e) {
      const btn = e.target.closest('[data-chip-id]');
      if (btn) onToggle(btn.dataset.chipId);
    }
    wrap.addEventListener('click', handler);
    return () => wrap.removeEventListener('click', handler);
  }

  return { html, wire };
}

// Global search box with a ⌘K / Ctrl-K shortcut badge and a typeahead results dropdown.
export function searchInput({ placeholder = 'Search…', shortcutLabel = '⌘K', options = [], onSelect }) {
  const html = `
    <div class="relative w-full max-w-md" data-search-root>
      <div class="relative">
        <svg class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="9" cy="9" r="6" /><path d="m17 17-4-4" stroke-linecap="round" />
        </svg>
        <input type="text" data-search-input autocomplete="off" placeholder="${escapeHtml(placeholder)}"
          class="w-full rounded-xl border border-slate-200 bg-white/70 py-2 pl-9 pr-14 text-sm text-slate-700 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20" />
        <kbd data-search-kbd class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">${escapeHtml(shortcutLabel)}</kbd>
      </div>
      <div data-search-results class="absolute z-40 mt-2 hidden w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-100"></div>
    </div>`;

  function wire(root) {
    const wrap = root.querySelector('[data-search-root]');
    const input = wrap.querySelector('[data-search-input]');
    const results = wrap.querySelector('[data-search-results]');

    function renderResults(matches) {
      if (!matches.length) {
        results.classList.add('hidden');
        results.innerHTML = '';
        return;
      }
      results.innerHTML = matches
        .slice(0, 8)
        .map(
          (m) => `
        <button type="button" data-result-ticker="${escapeHtml(m.ticker)}" class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50">
          <span class="font-semibold text-slate-700">${escapeHtml(m.ticker)}</span>
          <span class="truncate text-slate-400">${escapeHtml(m.name)}</span>
        </button>`
        )
        .join('');
      results.classList.remove('hidden');
    }

    function close() {
      results.classList.add('hidden');
    }

    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return close();
      const matches = options.filter((o) => o.ticker.toLowerCase().includes(q) || o.name.toLowerCase().includes(q));
      renderResults(matches);
    });

    results.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-result-ticker]');
      if (!btn) return;
      // Stub hook — later prompts will make this open the company detail view.
      openCompany(btn.dataset.resultTicker);
      if (onSelect) onSelect(btn.dataset.resultTicker);
      input.value = '';
      close();
    });

    function onKeydown(e) {
      const isShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isShortcut) {
        e.preventDefault();
        input.focus();
        input.select();
      } else if (e.key === 'Escape' && document.activeElement === input) {
        input.blur();
        close();
      }
    }
    document.addEventListener('keydown', onKeydown);

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) close();
    });

    return () => document.removeEventListener('keydown', onKeydown);
  }

  return { html, wire };
}

// TODO(later prompt): wire this up to actually open a company detail drill-down/route.
function openCompany(ticker) {
  console.info(`[stub] openCompany("${ticker}") — company detail view lands in a later prompt.`);
}

// Layout row: left-aligned control group + right-aligned control group (chips, search, buttons…).
export function toolbar({ left = [], right = [] }) {
  return `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">${left.join('')}</div>
      <div class="flex flex-wrap items-center gap-2">${right.join('')}</div>
    </div>`;
}

// Right-slide drill-in panel: backdrop + sliding surface, closes on ESC or backdrop click.
// Mount once (its html should live in a dedicated overlay root), then use the returned
// `{ open({title, content}), close() }` API from anywhere.
export function drillPanel() {
  const html = `
    <div data-drill-panel class="pointer-events-none fixed inset-0 z-[60]">
      <div data-drill-backdrop class="absolute inset-0 bg-slate-900/30 opacity-0 transition-opacity duration-200"></div>
      <aside data-drill-surface class="absolute right-0 top-0 h-full w-full max-w-md translate-x-full transform bg-white shadow-2xl ring-1 ring-slate-100 transition-transform duration-300 ease-out">
        <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 data-drill-title class="font-display text-base font-bold text-slate-900"></h3>
          <button type="button" data-drill-close class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">✕</button>
        </div>
        <div data-drill-body class="h-[calc(100%-57px)] overflow-y-auto px-5 py-4"></div>
      </aside>
    </div>`;

  function wire(root) {
    const panel = root.querySelector('[data-drill-panel]');
    const backdrop = panel.querySelector('[data-drill-backdrop]');
    const surface = panel.querySelector('[data-drill-surface]');
    const titleEl = panel.querySelector('[data-drill-title]');
    const bodyEl = panel.querySelector('[data-drill-body]');

    function open({ title = '', content = '' } = {}) {
      titleEl.textContent = title;
      bodyEl.innerHTML = content;
      panel.classList.remove('pointer-events-none');
      backdrop.classList.remove('opacity-0');
      surface.classList.remove('translate-x-full');
      document.addEventListener('keydown', onKeydown);
    }
    function close() {
      backdrop.classList.add('opacity-0');
      surface.classList.add('translate-x-full');
      panel.classList.add('pointer-events-none');
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    backdrop.addEventListener('click', close);
    panel.querySelector('[data-drill-close]').addEventListener('click', close);

    return { open, close };
  }

  return { html, wire };
}

// Centred modal dialog: backdrop + scale-in surface, closes on ESC, backdrop click, or the ✕.
export function modal() {
  const html = `
    <div data-modal class="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div data-modal-backdrop class="absolute inset-0 bg-slate-900/40 opacity-0 transition-opacity duration-200"></div>
      <div data-modal-surface class="relative w-full max-w-lg scale-95 rounded-2xl bg-white p-5 opacity-0 shadow-2xl ring-1 ring-slate-100 transition-all duration-200">
        <div class="flex items-center justify-between">
          <h3 data-modal-title class="font-display text-base font-bold text-slate-900"></h3>
          <button type="button" data-modal-close class="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">✕</button>
        </div>
        <div data-modal-body class="mt-3"></div>
      </div>
    </div>`;

  function wire(root) {
    const modalEl = root.querySelector('[data-modal]');
    const backdrop = modalEl.querySelector('[data-modal-backdrop]');
    const surface = modalEl.querySelector('[data-modal-surface]');
    const titleEl = modalEl.querySelector('[data-modal-title]');
    const bodyEl = modalEl.querySelector('[data-modal-body]');

    function open({ title = '', content = '' } = {}) {
      titleEl.textContent = title;
      bodyEl.innerHTML = content;
      modalEl.classList.remove('pointer-events-none');
      backdrop.classList.remove('opacity-0');
      surface.classList.remove('scale-95', 'opacity-0');
      document.addEventListener('keydown', onKeydown);
    }
    function close() {
      backdrop.classList.add('opacity-0');
      surface.classList.add('scale-95', 'opacity-0');
      modalEl.classList.add('pointer-events-none');
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    backdrop.addEventListener('click', close);
    modalEl.querySelector('[data-modal-close]').addEventListener('click', close);

    return { open, close };
  }

  return { html, wire };
}

// Centred placeholder for a panel/table with no data yet.
export function emptyState({ title = 'Nothing here yet', message = '', icon = '🗂️' }) {
  return `
    <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div class="text-3xl">${icon}</div>
      <div class="text-sm font-semibold text-slate-600">${escapeHtml(title)}</div>
      ${message ? `<div class="max-w-sm text-xs text-slate-400">${escapeHtml(message)}</div>` : ''}
    </div>`;
}

// Shimmering loading placeholder — `variant: 'rows'` for table-shaped skeletons, `'cards'` for stat cards.
export function skeleton({ rows = 4, variant = 'rows' } = {}) {
  if (variant === 'cards') {
    return `<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">${Array.from({ length: rows })
      .map(() => '<div class="skeleton-shimmer h-20 rounded-2xl bg-slate-100"></div>')
      .join('')}</div>`;
  }
  return `<div class="flex flex-col gap-2">${Array.from({ length: rows })
    .map(() => '<div class="skeleton-shimmer h-9 rounded-lg bg-slate-100"></div>')
    .join('')}</div>`;
}

// Pulsing-dot "Live" indicator + relative last-update time. Refreshes on every poller tick via
// `subscribeTick`, plus on a slow interval so the relative time ("2m ago") keeps ageing.
export function liveBadge({ label = 'Live', getTimestamp, subscribeTick = null }) {
  const html = `
    <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100" data-live-badge>
      <span class="relative flex h-1.5 w-1.5">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
        <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      </span>
      <span>${escapeHtml(label)}</span>
      <span class="text-emerald-300">·</span>
      <span data-live-time class="tabular-nums text-emerald-600">—</span>
    </span>`;

  function wire(root) {
    const timeEl = root.querySelector('[data-live-time]');
    function refresh() {
      const ts = getTimestamp ? getTimestamp() : null;
      timeEl.textContent = ts ? formatRelativeTime(ts) : 'waiting…';
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    const unsubscribe = subscribeTick ? subscribeTick(refresh) : null;
    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }

  return { html, wire };
}

// Tiny inline SVG sparkline — no chart library, just a polyline scaled to fit the box.
export function spark({ values = [], width = 64, height = 24, tone = 'brand' } = {}) {
  const strokeByTone = { brand: '#0d9488', accent: '#7c3aed', positive: '#059669', negative: '#e11d48', neutral: '#64748b' };
  const stroke = strokeByTone[tone] || strokeByTone.brand;
  if (!values.length) return `<svg width="${width}" height="${height}" aria-hidden="true"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

// Hover tooltip: wraps `trigger` markup and reveals `content` above/below it on hover/focus.
export function tooltip({ trigger, content, position = 'top' }) {
  const sideClass = position === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5';
  return `
    <span class="group relative inline-flex items-center">
      ${trigger}
      <span class="pointer-events-none absolute left-1/2 ${sideClass} z-50 -translate-x-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
        ${escapeHtml(content)}
      </span>
    </span>`;
}

// Dashed-outline strip listing features planned for a later prompt — used at the bottom of every placeholder panel.
export function comingSoonStrip(features = [], { note = 'Coming in a later prompt' } = {}) {
  return `
    <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-4">
      <div class="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
        <span>🚧</span><span>${escapeHtml(note)}</span>
      </div>
      <ul class="grid gap-1.5 sm:grid-cols-2">
        ${features.map((f) => `<li class="flex items-start gap-1.5 text-xs text-slate-500"><span class="mt-0.5 text-slate-300">›</span><span>${escapeHtml(f)}</span></li>`).join('')}
      </ul>
    </div>`;
}

// Minimal CSS.escape polyfill fallback (CSS.escape is supported everywhere we target, but this
// keeps attribute selectors safe even if a ticker/id ever contains a quote-breaking character).
function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}
