// GLOW-OWNED: category selection and scheme search share the All Schemes search box.
// Categories are the feed's own labels. Several selections mean OR; free text narrows that set.
// The table consumes matches() for rows, counts and export, so they cannot disagree.

import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';

let sequence = 0;
const categoryOf = (row) => row.classification || 'Unclassified';
const normalise = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const wordsOf = (value) => normalise(value).split(/\s+/).filter(Boolean);
const containsWords = (text, words) => words.every((word) => text.includes(word));

export function fundSearch({ rows = [], selected = [], q = '', onFilterChange = null } = {}) {
  const id = `fund-search-${++sequence}`;
  const counts = new Map();
  rows.forEach((row) => counts.set(categoryOf(row), (counts.get(categoryOf(row)) || 0) + 1));
  const categories = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const view = { categories: [...new Set(selected || [])] };
  let picked = new Set(view.categories);
  const textOf = (row) => normalise(`${row.fundName} ${categoryOf(row)} ${(row.factors || []).join(' ')} ${row.option || ''}`);
  const textByRow = new Map(rows.map((row) => [row, textOf(row)]));
  let lastQuery;
  let words = [];
  const matches = (row, query) => {
    if (query !== lastQuery) {
      lastQuery = query;
      words = wordsOf(query);
    }
    // Facet counts also ask about schemes excluded by the current strategy. Apply the SAME
    // search/category predicate to those rows instead of treating an uncached row as empty text.
    if (!textByRow.has(row)) textByRow.set(row, textOf(row));
    return (!picked.size || picked.has(categoryOf(row))) && containsWords(textByRow.get(row), words);
  };

  const chipHtml = (category) => `
    <span class="inline-flex max-w-[12rem] items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">
      <span class="truncate" title="${escapeHtml(category)}">${escapeHtml(category)}</span>
      <button type="button" data-fund-category-remove="${escapeHtml(category)}" aria-label="Remove ${escapeHtml(category)}"
        class="leading-none text-indigo-400 hover:text-indigo-800">&times;</button>
    </span>`;
  const chipsHtml = () => view.categories.slice(0, 6).map(chipHtml).join('') + (picked.size > 6
    ? `<button type="button" data-fund-category-more class="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-500"
        aria-label="Show all ${picked.size} selected categories">+${formatNumber(picked.size - 6)} more</button>` : '');

  const html = `
    <div data-fund-search="${id}" class="relative min-w-0 flex-1 sm:max-w-xl">
      <span class="pointer-events-none absolute left-3 top-2.5 text-slate-400">🔍</span>
      <div data-fund-search-box class="flex w-full flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-500">
        <div data-fund-search-chips class="flex flex-wrap items-center gap-1">${chipsHtml()}</div>
        <input type="text" data-table-search role="combobox" aria-label="Search schemes or categories"
          aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" aria-controls="${id}-list"
          autocomplete="off" value="${escapeHtml(q)}" placeholder="Search schemes or pick categories…"
          class="min-w-0 flex-1 basis-28 bg-transparent py-1 text-sm outline-none placeholder:text-slate-400" />
      </div>
    </div>`;

  function wire(host, { onQuery, onChange }) {
    const root = host.querySelector(`[data-fund-search="${id}"]`);
    const input = root.querySelector('[data-table-search]');
    const box = root.querySelector('[data-fund-search-box]');
    const chips = root.querySelector('[data-fund-search-chips]');
    const queryChanged = (value) => {
      onQuery(value);
      onFilterChange?.(matches);
    };
    const selectionChanged = () => {
      onChange();
      onFilterChange?.(matches);
    };
    // A body portal escapes the table's rounded overflow clipping and the page's retained transform.
    const menu = document.createElement('div');
    menu.dataset.fundSearchMenu = id;
    menu.hidden = true;
    menu.className = 'fixed z-40 w-[26rem] max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200';
    menu.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
        <span data-fund-search-heading class="text-[11px] font-bold uppercase tracking-wide text-slate-400"></span>
        <span class="flex items-center gap-3">
          <button type="button" data-fund-search-all class="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800">Select matches</button>
          <button type="button" data-fund-search-clear class="text-[11px] font-semibold text-slate-400 hover:text-rose-600">Clear categories</button>
        </span>
      </div>
      <div id="${id}-list" role="listbox" aria-label="Fund categories" aria-multiselectable="true" data-fund-search-list class="scrollbar-thin max-h-72 overflow-y-auto"></div>
      <p class="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-slate-400">Choose one or more categories, then type to search within them. Counts follow the filters above.</p>`;
    document.body.appendChild(menu);
    const list = menu.querySelector('[data-fund-search-list]');
    const heading = menu.querySelector('[data-fund-search-heading]');
    const selectAll = menu.querySelector('[data-fund-search-all]');
    const clear = menu.querySelector('[data-fund-search-clear]');
    let shown = [];
    let active = -1;
    let onlyPicked = false;
    let frame = null;

    function renderList() {
      const queryWords = wordsOf(input.value);
      // Keep a selected category removable even when an asset/strategy filter leaves it no rows.
      const available = [...new Set([...categories, ...view.categories])];
      shown = available.filter((category) => (!onlyPicked || picked.has(category)) && containsWords(normalise(category), queryWords));
      active = -1;
      input.removeAttribute('aria-activedescendant');
      heading.textContent = `${onlyPicked ? 'Selected categories' : 'Categories'} · ${formatNumber(shown.length)}`;
      selectAll.disabled = !shown.length;
      selectAll.textContent = input.value.trim() ? `Select ${formatNumber(shown.length)} matches` : 'Select all';
      list.innerHTML = shown.length ? shown.map((category, i) => `
        <button type="button" role="option" tabindex="-1" id="${id}-option-${i}" data-fund-category="${escapeHtml(category)}" aria-selected="${picked.has(category)}"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50">
          <span aria-hidden="true" class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[10px] font-bold ${picked.has(category) ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-transparent'}">✓</span>
          <span class="min-w-0 flex-1 text-sm font-semibold text-slate-800">${escapeHtml(category)}</span>
          <span class="text-[11px] font-semibold tabular-nums text-slate-400">${formatNumber(counts.get(category) || 0)}</span>
        </button>`).join('') : '<p class="px-2 py-6 text-center text-sm text-slate-400">No matching categories. Your text still searches scheme names.</p>';
    }

    function place() {
      if (menu.hidden) return;
      const r = box.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 14;
      const above = r.top - 14;
      const upward = below < Math.min(menu.scrollHeight, 360) && above > below;
      list.style.maxHeight = `${Math.max(48, Math.min(288, (upward ? above : below) - 100))}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, upward ? r.top - menu.offsetHeight - 6 : r.bottom + 6)}px`;
    }

    function show() {
      if (!menu.hidden) return;
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      renderList();
      place();
    }
    function hide() {
      menu.hidden = true;
      active = -1;
      onlyPicked = false;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function commit(next, clearQuery = false) {
      view.categories = [...new Set(next)];
      picked = new Set(view.categories);
      chips.innerHTML = chipsHtml();
      if (clearQuery) {
        input.value = '';
        queryChanged('');
      } else selectionChanged();
      renderList();
      place();
    }
    function toggle(category) {
      commit(picked.has(category) ? view.categories.filter((value) => value !== category) : [...view.categories, category], true);
    }
    function highlight(next) {
      if (!shown.length) return;
      const nodes = list.querySelectorAll('[data-fund-category]');
      nodes[active]?.classList.remove('bg-slate-100');
      active = (next + nodes.length) % nodes.length;
      nodes[active].classList.add('bg-slate-100');
      input.setAttribute('aria-activedescendant', nodes[active].id);
      nodes[active].scrollIntoView({ block: 'nearest' });
    }

    const onInput = () => {
      onlyPicked = false;
      queryChanged(input.value);
      show();
      renderList();
      place();
    };
    const onBoxClick = (event) => {
      const remove = event.target.closest('[data-fund-category-remove]');
      if (remove) {
        commit(view.categories.filter((category) => category !== remove.dataset.fundCategoryRemove));
      } else if (event.target.closest('[data-fund-category-more]')) {
        onlyPicked = true;
        input.value = '';
        queryChanged('');
      }
      input.focus();
      show();
      renderList();
      place();
    };
    const onMenuClick = (event) => {
      const option = event.target.closest('[data-fund-category]');
      if (option) toggle(option.dataset.fundCategory);
      else if (event.target.closest('[data-fund-search-all]')) commit([...view.categories, ...shown], true);
      else if (event.target.closest('[data-fund-search-clear]')) {
        onlyPicked = false;
        commit([]);
      }
      input.focus();
    };
    const onKey = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        show();
        highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : shown.length - 1) : active + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' && !menu.hidden) {
        const category = shown[active] || (shown.length === 1 ? shown[0] : null);
        if (category) {
          event.preventDefault();
          toggle(category);
        }
      } else if (event.key === 'Backspace' && !input.value && picked.size) {
        event.preventDefault();
        commit(view.categories.slice(0, -1));
      } else if (event.key === 'Tab' && !menu.hidden) {
        if (event.shiftKey) hide();
        else {
          event.preventDefault();
          (selectAll.disabled ? clear : selectAll).focus();
        }
      }
    };
    // The portal is outside the toolbar's DOM order. Keep its two actions reachable by Tab,
    // then continue from the input to the next toolbar control instead of jumping to page end.
    const onMenuKey = (event) => {
      if (event.key !== 'Tab') return;
      if (event.shiftKey && (event.target === selectAll || (event.target === clear && selectAll.disabled))) {
        event.preventDefault();
        input.focus();
      } else if (!event.shiftKey && event.target === clear) {
        input.focus();
        hide();
      }
    };
    const onDocKey = (event) => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      hide();
    };
    const onOutside = (event) => {
      if (!root.contains(event.target) && !menu.contains(event.target)) hide();
    };
    const onReflow = () => {
      if (menu.hidden || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; place(); });
    };

    box.addEventListener('click', onBoxClick);
    input.addEventListener('focus', show);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKey);
    menu.addEventListener('click', onMenuClick);
    menu.addEventListener('keydown', onMenuKey);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      box.removeEventListener('click', onBoxClick);
      input.removeEventListener('focus', show);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKey);
      menu.removeEventListener('click', onMenuClick);
      menu.removeEventListener('keydown', onMenuKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onDocKey, true);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
      menu.remove();
    };
  }

  return { html, wire, matches, view };
}
