// concall/keyword-editor.js — the keyword set editor.
//
// A modal over the keyword engine's store. Add, rename, delete, edit aliases, recolour,
// reorder, reset, import/export. Every commit calls engine.setKeywords(), which persists to
// localStorage and fires onKeywordsChange — the Con-call tab is subscribed to that, so the
// matrix, the chips and the Deep Dive all recompute against the new set the moment you save.
// Nothing here caches a count; the engine rescans.
//
// The editor works on a DRAFT copy and commits on Save. Live-committing each keystroke would
// rescan 112 transcripts per character typed, and a half-typed alias would briefly wipe a
// column. Add / delete / reorder commit immediately, because those read as actions rather
// than as edits in progress.

import { openModal, closeModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import * as engine from './keyword-engine.js';

let draft = [];
let dirty = false;

export function openKeywordEditor() {
  draft = engine.getKeywords().map((k) => ({ ...k, terms: [...k.terms] }));
  dirty = false;
  openModal(shell(), { size: 'wide' });
  wire();
}

// ---------------------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------------------

function shell() {
  return `
    <div class="flex max-h-[85vh] flex-col">
      <div class="flex items-start justify-between gap-4 border-b border-slate-100 px-7 pb-4 pt-6">
        <div>
          <h2 class="font-display text-2xl font-bold text-slate-900">Keyword set</h2>
          <p class="mt-1 max-w-2xl text-sm text-slate-500">
            These terms are matched against transcript text every time the tab renders — nothing is precomputed.
            Change an alias and every count on the Con-call tab moves with it.
          </p>
        </div>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700" aria-label="Close">×</button>
      </div>

      <div class="scrollbar-thin flex-1 overflow-y-auto px-7 py-4">
        <div data-kw-list class="space-y-2">${rowsHtml()}</div>

        <button data-kw-add class="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 py-3 text-sm font-semibold text-slate-500 transition-colors hover:border-indigo-400 hover:text-indigo-600">
          <span class="text-lg leading-none">+</span> Add a keyword
        </button>

        <div data-kw-io class="mt-4"></div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-7 py-4">
        <div class="flex flex-wrap items-center gap-2">
          <button data-kw-reset class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-300 transition-colors hover:bg-white">Reset to defaults</button>
          <button data-kw-export class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-300 transition-colors hover:bg-white">Export JSON</button>
          <button data-kw-import class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-300 transition-colors hover:bg-white">Import JSON</button>
        </div>
        <div class="flex items-center gap-2">
          <span data-kw-status class="text-xs text-slate-400"></span>
          <button data-modal-close class="rounded-lg px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-white">Cancel</button>
          <button data-kw-save class="rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition-opacity hover:opacity-90">Save &amp; rescan</button>
        </div>
      </div>
    </div>`;
}

function rowsHtml() {
  if (!draft.length) {
    return `<div class="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500 ring-1 ring-slate-200">
      No keywords. Add one below, or reset to the shipped set.
    </div>`;
  }
  return draft.map((k, i) => rowHtml(k, i)).join('');
}

function rowHtml(k, i) {
  const c = engine.colorFor(k.color);
  return `
    <div class="rounded-xl bg-white p-3 ring-1 ring-slate-200" data-kw-row="${i}">
      <div class="flex items-start gap-3">
        <div class="flex flex-col gap-1 pt-1">
          <button data-kw-up="${i}" class="rounded px-1 text-xs leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button data-kw-down="${i}" class="rounded px-1 text-xs leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-25" ${i === draft.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
        </div>

        <div class="min-w-0 flex-1 space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="h-3 w-3 flex-shrink-0 rounded-full ${c.dot}"></span>
            <input data-kw-label="${i}" value="${escapeHtml(k.label)}" placeholder="Keyword name"
              class="min-w-[8rem] flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-semibold text-slate-900 focus:border-indigo-400 focus:outline-none" />
            <input data-kw-category="${i}" value="${escapeHtml(k.category || '')}" placeholder="Category"
              class="w-32 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 focus:border-indigo-400 focus:outline-none" />
            <button data-kw-delete="${i}" class="rounded-lg px-2 py-1.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-50" aria-label="Delete keyword">Delete</button>
          </div>

          <div>
            <label class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Match terms — comma separated</label>
            <input data-kw-terms="${i}" value="${escapeHtml(k.terms.join(', '))}" placeholder="capex, capital expenditure, capital outlay"
              class="mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono text-xs text-slate-700 focus:border-indigo-400 focus:outline-none" />
            <div class="mt-1 text-[11px] text-slate-400">
              Matched case-insensitively on whole words. Overlapping terms count once — "margin guidance" is one hit, not two.
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <span class="mr-1 text-[11px] font-bold uppercase tracking-wider text-slate-400">Colour</span>
            ${engine.COLOR_NAMES.map(
              (name) => `<button data-kw-color="${i}" data-color-name="${name}"
                class="h-5 w-5 rounded-full ${engine.KEYWORD_COLORS[name].dot} ring-offset-1 transition-all ${k.color === name ? 'ring-2 ring-slate-900' : 'ring-1 ring-transparent hover:ring-slate-300'}"
                aria-label="${name}"></button>`
            ).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------

function root() {
  return document.getElementById('modal-content');
}

function repaintRows() {
  const list = root()?.querySelector('[data-kw-list]');
  if (!list) return;
  list.innerHTML = rowsHtml();
  wireRows();
}

function setStatus(text, tone = 'slate') {
  const el = root()?.querySelector('[data-kw-status]');
  if (!el) return;
  el.textContent = text;
  el.className = `text-xs ${tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-slate-400'}`;
}

function markDirty() {
  dirty = true;
  setStatus('Unsaved changes');
}

function wireRows() {
  const r = root();
  if (!r) return;

  r.querySelectorAll('[data-kw-label]').forEach((el) =>
    el.addEventListener('input', () => {
      draft[Number(el.dataset.kwLabel)].label = el.value;
      markDirty();
    })
  );
  r.querySelectorAll('[data-kw-category]').forEach((el) =>
    el.addEventListener('input', () => {
      draft[Number(el.dataset.kwCategory)].category = el.value;
      markDirty();
    })
  );
  r.querySelectorAll('[data-kw-terms]').forEach((el) =>
    el.addEventListener('input', () => {
      draft[Number(el.dataset.kwTerms)].terms = el.value.split(',').map((t) => t.trim()).filter(Boolean);
      markDirty();
    })
  );
  r.querySelectorAll('[data-kw-color]').forEach((el) =>
    el.addEventListener('click', () => {
      draft[Number(el.dataset.kwColor)].color = el.dataset.colorName;
      markDirty();
      repaintRows();
    })
  );

  // Reorder commits straight away — it reads as an action, not an edit in progress, and the
  // matrix column order is the thing being changed.
  const move = (from, to) => {
    if (to < 0 || to >= draft.length) return;
    const [row] = draft.splice(from, 1);
    draft.splice(to, 0, row);
    commit('Order updated');
    repaintRows();
  };
  r.querySelectorAll('[data-kw-up]').forEach((el) =>
    el.addEventListener('click', () => move(Number(el.dataset.kwUp), Number(el.dataset.kwUp) - 1))
  );
  r.querySelectorAll('[data-kw-down]').forEach((el) =>
    el.addEventListener('click', () => move(Number(el.dataset.kwDown), Number(el.dataset.kwDown) + 1))
  );

  r.querySelectorAll('[data-kw-delete]').forEach((el) =>
    el.addEventListener('click', () => {
      const i = Number(el.dataset.kwDelete);
      const k = draft[i];
      // Warn before delete: a keyword carries an alias list somebody tuned, and there is no undo.
      const ok = window.confirm(
        `Delete "${k.label}"?\n\nIts ${k.terms.length} match term${k.terms.length === 1 ? '' : 's'} (${k.terms.join(', ')}) will be removed and its column will disappear from the keyword matrix.\n\nThis cannot be undone — export first if you want a copy.`
      );
      if (!ok) return;
      draft.splice(i, 1);
      commit(`Deleted "${k.label}"`);
      repaintRows();
    })
  );
}

function wire() {
  const r = root();
  if (!r) return;
  wireRows();

  r.querySelector('[data-kw-add]')?.addEventListener('click', () => {
    const label = 'New keyword';
    draft.push({ id: engine.slugId(label, draft), label, category: '', color: engine.COLOR_NAMES[draft.length % engine.COLOR_NAMES.length], terms: [] });
    commit('Keyword added');
    repaintRows();
    // Focus the new row's name so it can be typed over immediately.
    const inputs = r.querySelectorAll('[data-kw-label]');
    const last = inputs[inputs.length - 1];
    last?.focus();
    last?.select();
  });

  r.querySelector('[data-kw-save]')?.addEventListener('click', () => {
    commit('Saved — counts rescanned');
    setStatus('Saved — counts rescanned', 'emerald');
    closeModal();
  });

  r.querySelector('[data-kw-reset]')?.addEventListener('click', () => {
    if (!window.confirm('Reset to the nine shipped keywords?\n\nYour edits will be discarded. This cannot be undone.')) return;
    engine.resetKeywords();
    draft = engine.getKeywords().map((k) => ({ ...k, terms: [...k.terms] }));
    dirty = false;
    repaintRows();
    setStatus('Reset to defaults', 'emerald');
  });

  r.querySelector('[data-kw-export]')?.addEventListener('click', () => {
    // Committing first means the exported file matches what the dashboard is actually using.
    commit();
    const io = r.querySelector('[data-kw-io]');
    io.innerHTML = `
      <div class="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Export</span>
          <button data-kw-io-close class="text-xs text-slate-400 hover:text-slate-700">close</button>
        </div>
        <textarea readonly class="scrollbar-thin h-40 w-full rounded-lg border border-slate-200 p-2 font-mono text-[11px] text-slate-700">${escapeHtml(engine.exportKeywords())}</textarea>
        <div class="mt-1 text-[11px] text-slate-400">Copy this to move your set to another browser, or to hand it to whoever wires the server-side store.</div>
      </div>`;
    io.querySelector('textarea')?.select();
    io.querySelector('[data-kw-io-close]')?.addEventListener('click', () => (io.innerHTML = ''));
  });

  r.querySelector('[data-kw-import]')?.addEventListener('click', () => {
    const io = r.querySelector('[data-kw-io]');
    io.innerHTML = `
      <div class="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Import</span>
          <button data-kw-io-close class="text-xs text-slate-400 hover:text-slate-700">close</button>
        </div>
        <textarea data-kw-import-text placeholder='{ "keywords": [ { "id": "capex", "label": "Capex", "color": "indigo", "terms": ["capex"] } ] }'
          class="scrollbar-thin h-32 w-full rounded-lg border border-slate-200 p-2 font-mono text-[11px] text-slate-700 focus:border-indigo-400 focus:outline-none"></textarea>
        <div class="mt-2 flex items-center gap-2">
          <button data-kw-import-go class="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700">Replace my set</button>
          <span data-kw-import-msg class="text-[11px] text-slate-400">This replaces every keyword you have.</span>
        </div>
      </div>`;
    io.querySelector('[data-kw-io-close]')?.addEventListener('click', () => (io.innerHTML = ''));
    io.querySelector('[data-kw-import-go]')?.addEventListener('click', () => {
      const msg = io.querySelector('[data-kw-import-msg]');
      try {
        engine.importKeywords(io.querySelector('[data-kw-import-text]').value);
        draft = engine.getKeywords().map((k) => ({ ...k, terms: [...k.terms] }));
        dirty = false;
        io.innerHTML = '';
        repaintRows();
        setStatus('Imported — counts rescanned', 'emerald');
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'text-[11px] font-semibold text-rose-600';
      }
    });
  });
}

/**
 * Push the draft into the engine. Drops rows with no usable terms rather than storing a
 * keyword that can never match anything — a column of permanent zeros reads like a finding.
 */
function commit(status) {
  const clean = draft
    .map((k) => ({ ...k, label: k.label.trim() || k.id, terms: k.terms.filter(Boolean) }))
    .filter((k) => k.terms.length || k.label.trim());
  engine.setKeywords(clean);
  dirty = false;
  if (status) setStatus(status, 'emerald');
}

export function hasUnsavedEdits() {
  return dirty;
}
