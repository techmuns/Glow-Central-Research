// ui/company-select.js — THE COMPANY MULTI-SELECT, AND IT IS THE SEARCH BOX.
//
//   companyCombo({ options, selected, q, ... })  ->  { html, wire(host, handlers) }
//
// WHY IT IS NOT A SECOND CONTROL BESIDE THE SEARCH BOX. The reader's question on News, Corporate
// Announcements and Insider Trades is "show me these companies", and the only way to ask it was to
// type a name into a free-text box and hope the spelling matched — one company at a time, with no
// list of what could be asked for. A separate dropdown beside the box would have answered that and
// left two controls doing one job, which is the failure the market-news tab's two Refresh buttons
// already taught this codebase (see "IT WAS TWO BUTTONS FOR A WHILE" in CLAUDE.md).
//
// So this is one box that does both. Typing filters the suggestions AND still searches the rows, so
// nothing the search box did is lost; clicking a suggestion turns it into a removable chip and the
// table narrows to those companies. The chips live INSIDE the box, so what is being asked for is
// visible without opening anything.
//
// THE MENU IS PORTALED TO <body>, AND THAT IS NOT A STYLE CHOICE. `scoreTable`'s section carries
// `overflow-hidden` (it is what clips the table's rounded corners), so an absolutely-positioned
// menu is clipped into invisibility on a short table while every click handler goes on working —
// the exact failure CLAUDE.md records for the sub-view picker. `position: fixed` alone does not
// settle it either: `.fade-in` ends on `transform: translateY(0)` with `fill-mode: both`, and a
// retained transform makes an ancestor the containing block for fixed descendants, which puts the
// overflow-hidden section back between the menu and its containing block. Appending to <body>
// removes every ancestor from the question.
//
// NOTHING HERE INVENTS A COMPANY. The options are the companies in the reader's current scope, as
// the tab already computes them for the walk, and each carries the number of rows THIS capture
// holds for it. A company with none still lists — it is in scope and can be asked about — and shows
// a dash rather than a zero, because "no rows in this capture" and "we never asked" are different
// claims and the coverage line behind the status chip is where that distinction is made.

import { escapeHtml } from '../core/dom.js';
import { formatNumber } from '../core/format.js';

// How many options are rendered at once. The tracked universe is ~1,900 companies; painting all of
// them into a menu costs more than it buys, and the search field above the list is how the rest are
// reached. The footer says the list is capped rather than leaving the reader to guess.
const MAX_RENDERED = 200;

let seq = 0;

const up = (v) => String(v ?? '').trim().toUpperCase();

/**
 * @param {object} cfg
 * @param {Array}  cfg.options   [{ ticker, name, count }] — the companies that can be picked
 * @param {Array}  cfg.selected  tickers currently picked
 * @param {string} cfg.q         current free-text search
 * @param {string} cfg.noun      what a row is ("articles"), for the count wording
 * @param {string} cfg.scopeNoun the scope's name, for the menu head ("Portfolio")
 * @param {string} cfg.hint      one line under the list, e.g. how to reach a company not in scope
 */
export function companyCombo({ options = [], selected = [], q = '', noun = 'rows', scopeNoun = '', hint = '', placeholder = '' } = {}) {
  const id = `combo-${++seq}`;
  const opts = options
    .map((o) => ({ ticker: up(o.ticker), name: String(o.name || o.ticker || ''), count: Number.isFinite(o.count) ? o.count : 0 }))
    .filter((o) => o.ticker);
  const byTicker = new Map(opts.map((o) => [o.ticker, o]));
  // Companies that actually have rows in this capture first, then the scope's own order — which is
  // market-cap descending for both the book and the universe, so the biggest names lead the rest.
  const ordered = opts.map((o, i) => ({ o, i })).sort((a, b) => b.o.count - a.o.count || a.i - b.i).map((x) => x.o);

  let picked = [...new Set(selected.map(up).filter(Boolean))];
  let text = String(q || '');

  const label = (t) => byTicker.get(t)?.name || t;

  const chipHtml = (t) => `
    <span class="inline-flex max-w-[12rem] items-center gap-1 rounded-md bg-indigo-50 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-100">
      <span class="truncate" title="${escapeHtml(label(t))}">${escapeHtml(label(t))}</span>
      <button type="button" data-combo-remove="${escapeHtml(t)}" aria-label="Remove ${escapeHtml(label(t))}"
        class="leading-none text-indigo-400 transition-colors hover:text-indigo-800">&times;</button>
    </span>`;

  // A reader who types "bank" and takes every match can pick a hundred companies in one click, and
  // a hundred chips is a search box taller than the table under it. The overflow is COUNTED rather
  // than dropped — the count is the honest statement of what the table is narrowed by, and Clear is
  // one click away in the menu.
  const CHIP_CAP = 12;
  const chipsHtml = () =>
    picked.slice(0, CHIP_CAP).map(chipHtml).join('') +
    (picked.length > CHIP_CAP
      ? `<span class="inline-flex items-center rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-500"
           title="${escapeHtml(picked.slice(CHIP_CAP).map(label).join(', '))}">+${escapeHtml(formatNumber(picked.length - CHIP_CAP))} more</span>`
      : '');

  const optionHtml = (o) => {
    const on = picked.includes(o.ticker);
    return `
      <button type="button" role="option" data-combo-opt="${escapeHtml(o.ticker)}" aria-selected="${on}"
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-slate-50">
        <span class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[10px] font-bold ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-transparent'}">✓</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold text-slate-800">${escapeHtml(o.name)}</span>
          <span class="block truncate text-[11px] text-slate-400">${escapeHtml(o.ticker)}</span>
        </span>
        <span class="flex-shrink-0 text-[11px] font-semibold tabular-nums text-slate-400">${o.count ? escapeHtml(formatNumber(o.count)) : '—'}</span>
      </button>`;
  };

  const html = `
    <div class="relative min-w-0 flex-1 sm:max-w-xl" data-company-combo="${escapeHtml(id)}">
      <span class="pointer-events-none absolute left-3 top-2.5 text-slate-400">🔍</span>
      <div data-combo-box role="combobox" aria-expanded="false" aria-haspopup="listbox"
        class="flex w-full flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-500">
        <div data-combo-chips class="flex flex-wrap items-center gap-1">${chipsHtml()}</div>
        <input type="text" data-table-search autocomplete="off" value="${escapeHtml(text)}"
          placeholder="${escapeHtml(placeholder || 'Search or pick companies…')}"
          class="min-w-0 flex-1 basis-28 bg-transparent py-1 text-sm outline-none placeholder:text-slate-400" />
      </div>
    </div>`;

  function wire(host, { onQuery = () => {}, onCompanies = () => {} } = {}) {
    const root = host.querySelector(`[data-company-combo="${id}"]`);
    if (!root) return () => {};
    const box = root.querySelector('[data-combo-box]');
    const chips = root.querySelector('[data-combo-chips]');
    const input = root.querySelector('[data-table-search]');

    // A paint replaces the toolbar without running this instance's disposer (the filings tabs
    // repaint on every arrival), so a portaled menu from an earlier paint would be left behind.
    // Removing any menu already carrying this tab's marker makes the wiring idempotent whatever
    // order things happen in; the disposer below is still the normal path.
    document.querySelectorAll('[data-combo-portal]').forEach((n) => n.remove());

    const menu = document.createElement('div');
    menu.setAttribute('data-combo-portal', id);
    menu.setAttribute('role', 'listbox');
    menu.className =
      'fixed z-40 hidden w-[26rem] max-w-[calc(100vw-2rem)] rounded-2xl bg-white p-2 shadow-xl ring-1 ring-slate-200';
    menu.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <span data-combo-head class="truncate text-[11px] font-bold uppercase tracking-wide text-slate-400"></span>
        <span class="flex items-center gap-3">
          <button type="button" data-combo-all class="text-[11px] font-semibold text-indigo-600 transition-colors hover:text-indigo-800">Select all</button>
          <button type="button" data-combo-none class="text-[11px] font-semibold text-slate-400 transition-colors hover:text-rose-600">Clear</button>
        </span>
      </div>
      <div data-combo-list class="scrollbar-thin max-h-72 overflow-y-auto"></div>
      <p data-combo-foot class="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-slate-400"></p>`;
    document.body.appendChild(menu);

    const list = menu.querySelector('[data-combo-list]');
    const selectAll = menu.querySelector('[data-combo-all]');
    const head = menu.querySelector('[data-combo-head]');
    const foot = menu.querySelector('[data-combo-foot]');
    let open = false;
    let active = -1;
    let shown = [];

    const matches = () => {
      const needle = input.value.trim().toLowerCase();
      if (!needle) return ordered;
      return ordered.filter((o) => o.name.toLowerCase().includes(needle) || o.ticker.toLowerCase().includes(needle));
    };

    function renderList() {
      const all = matches();
      shown = all.slice(0, MAX_RENDERED);
      active = -1;
      list.innerHTML = shown.length
        ? shown.map(optionHtml).join('')
        : `<p class="px-2 py-6 text-center text-sm text-slate-400">No company in this scope matches “${escapeHtml(input.value.trim())}”.</p>`;
      head.textContent = `${scopeNoun ? `${scopeNoun} · ` : ''}${formatNumber(opts.length)} ${opts.length === 1 ? 'company' : 'companies'}${picked.length ? ` · ${formatNumber(picked.length)} picked` : ''}`;
      const capped = all.length > shown.length ? `Showing the first ${formatNumber(shown.length)} of ${formatNumber(all.length)} — type to narrow. ` : '';
      foot.textContent = `${capped}Companies with the most ${noun} in this capture are listed first.${hint ? ` ${hint}` : ''}`;
      // SELECT ALL MEANS EVERY MATCH, NOT EVERY ROW ON SCREEN. The list is capped at 200 for the
      // DOM's sake; taking only what happens to be rendered would quietly pick a different set from
      // the one the label names, which is the whole failure class of counting the DOM.
      selectAll.textContent = input.value.trim() ? `Select all ${formatNumber(all.length)}` : 'Select all';
    }

    function renderChips() {
      chips.innerHTML = chipsHtml();
    }

    function place() {
      const r = box.getBoundingClientRect();
      const width = menu.offsetWidth || 384;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      // Flip above the box when there is not room below it — a menu that opens off the bottom of a
      // short window is a control that looks broken.
      const below = window.innerHeight - r.bottom;
      const h = menu.offsetHeight || 320;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = below < h + 12 && r.top > h + 12 ? `${Math.round(r.top - h - 6)}px` : `${Math.round(r.bottom + 6)}px`;
    }

    function show() {
      if (open) return;
      open = true;
      box.setAttribute('aria-expanded', 'true');
      menu.classList.remove('hidden');
      renderList();
      place();
    }

    function hide() {
      if (!open) return;
      open = false;
      active = -1;
      box.setAttribute('aria-expanded', 'false');
      menu.classList.add('hidden');
    }

    function highlight(next) {
      const nodes = [...list.querySelectorAll('[data-combo-opt]')];
      if (!nodes.length) return;
      nodes[active]?.classList.remove('bg-slate-100');
      active = (next + nodes.length) % nodes.length;
      nodes[active].classList.add('bg-slate-100');
      nodes[active].scrollIntoView({ block: 'nearest' });
    }

    function commit(next) {
      picked = next;
      renderChips();
      if (open) renderList();
      onCompanies([...picked]);
    }

    const toggle = (ticker) => {
      const t = up(ticker);
      if (!t) return;
      commit(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);
    };

    // ---- events -------------------------------------------------------------------------
    const onBoxClick = (e) => {
      const rm = e.target.closest('[data-combo-remove]');
      if (rm) {
        e.preventDefault();
        e.stopPropagation();
        toggle(rm.dataset.comboRemove);
        return;
      }
      input.focus();
      show();
    };

    const onInput = () => {
      onQuery(input.value.trim().toLowerCase());
      show();
      renderList();
      place();
    };

    const onKey = (e) => {
      if (e.key === 'Backspace' && !input.value && picked.length) {
        commit(picked.slice(0, -1));
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) show();
        highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Enter') {
        const nodes = [...list.querySelectorAll('[data-combo-opt]')];
        // With nothing highlighted, Enter takes the single remaining match — the natural end of
        // typing a company's name. With several matches and no choice made it does nothing, rather
        // than picking one of them on the reader's behalf.
        const node = active >= 0 ? nodes[active] : nodes.length === 1 ? nodes[0] : null;
        if (!node) return;
        e.preventDefault();
        toggle(node.dataset.comboOpt);
        input.value = '';
        onQuery('');
        renderList();
      }
    };

    const onMenuClick = (e) => {
      if (e.target.closest('[data-combo-all]')) {
        commit(matches().map((o) => o.ticker));
        input.focus();
        return;
      }
      if (e.target.closest('[data-combo-none]')) {
        commit([]);
        input.focus();
        return;
      }
      const opt = e.target.closest('[data-combo-opt]');
      if (!opt) return;
      toggle(opt.dataset.comboOpt);
      input.focus();
    };

    // ESCAPE IS A DOCUMENT LISTENER, IN THE CAPTURE PHASE, and both halves of that matter. Focus is
    // not necessarily in the input — clicking Clear or an option puts it on a button inside the
    // portaled menu — so a keydown bound to the input misses the press entirely. And the drill panel,
    // the modal and the workspace all close on a bubbling Escape of their own: capturing lets an open
    // menu take the key first and stop there, so one press closes one thing.
    const onDocKey = (e) => {
      if (e.key !== 'Escape' || !open) return;
      e.stopPropagation();
      hide();
      input.focus();
    };

    const onDocDown = (e) => {
      if (root.contains(e.target) || menu.contains(e.target)) return;
      hide();
    };

    let queued = false;
    const onReflow = () => {
      if (!open || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (open) place();
      });
    };

    box.addEventListener('click', onBoxClick);
    input.addEventListener('input', onInput);
    input.addEventListener('focus', show);
    input.addEventListener('keydown', onKey);
    menu.addEventListener('click', onMenuClick);
    document.addEventListener('keydown', onDocKey, true);
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);

    return () => {
      box.removeEventListener('click', onBoxClick);
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', show);
      input.removeEventListener('keydown', onKey);
      menu.removeEventListener('click', onMenuClick);
      document.removeEventListener('keydown', onDocKey, true);
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
      menu.remove();
    };
  }

  return { html, wire };
}
