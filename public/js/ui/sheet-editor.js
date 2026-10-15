// ui/sheet-editor.js — THE ONE CELL EDITOR BEHIND THE PORTFOLIO AND WATCHLIST TABS. GLOW-OWNED.
//
// A small panel that opens under the cell that was clicked: the value, what the cell shows when
// nothing is typed (its default, and where that comes from), who last edited it, and Save / Reset /
// Cancel. Enter saves, Escape cancels, and focus returns to the cell.
//
// IT LIVES ON <body>, NOT IN THE TABLE, and that is the design rather than a styling choice. The
// tables repaint every fifteen seconds as prices move, and a repaint replaces the cell an inline
// input would sit in — a reader typing an intrinsic value would lose it mid-number. Appended to the
// body and positioned `fixed` from the cell's rectangle, the panel survives every repaint; it finds
// its cell again by `data-sheet-key` / `data-sheet-field` after one. Same reason, and the same
// arrangement, as the Filing types checklist on Corp Announcements: the table card clips its
// overflow and `#dashboard-main` animates a transform, so a panel inside either would be clipped.
//
// A COLLEAGUE CAN CHANGE THE CELL WHILE IT IS OPEN HERE, because the sheet is the whole desk's. The
// owning tab hands every repaint to `refreshCellEditor`: a panel nobody has typed in yet is redrawn
// with the newer value, so what is about to be edited is what the desk now holds; a panel somebody
// HAS typed in keeps every character and says, in the panel, who changed the cell and to what —
// saving still replaces it, as the last edit to a shared cell always does, but never unannounced.

import { escapeHtml } from '../core/dom.js';
import { FIELDS, editedLabel, fieldValue } from '../data/research-sheet-shared.js';
import { parseDateInput, parseNumberInput, formatSheetDate, istToday } from '../data/sheet-math.js';
import * as people from '../core/watchlist-people.js';

let active = null;

/** How a stored value reads in the input box — plain, so it can be edited without unpicking commas. */
export function inputText(field, value) {
  if (value == null || value === '') return '';
  const spec = FIELDS[field];
  if (spec?.kind === 'date') return formatSheetDate(value);
  if (spec?.kind === 'number') return String(+Number(value).toFixed(spec.unit === 'crore' ? 4 : 4));
  return String(value);
}

/** What a person typed, as the value the contract stores — or an error sentence. */
export function readInput(field, text, now = Date.now()) {
  const spec = FIELDS[field];
  if (!spec) return { error: 'This cell cannot be edited.' };
  const raw = String(text ?? '').trim();
  if (!raw) return { empty: true };
  try {
    if (spec.kind === 'date') {
      const date = parseDateInput(raw, now);
      if (!date) return { error: 'Not a date this sheet can read. Try 12-Mar-24.' };
      if (date > istToday(now)) return { error: 'A purchase date cannot be in the future.' };
      return { value: fieldValue(field, date) };
    }
    if (spec.kind === 'number') {
      const n = parseNumberInput(raw);
      if (n == null) return { error: 'Not a number. Digits only — commas, ₹ and % are fine.' };
      return { value: fieldValue(field, n) };
    }
    return { value: fieldValue(field, raw) };
  } catch {
    const range = spec.kind === 'number'
      ? (spec.exclusiveMin ? 'It must be more than zero.' : spec.min < 0 ? 'That is outside the range this cell takes.' : 'It cannot be negative.')
      : '';
    return { error: `That value is not accepted. ${range}`.trim() };
  }
}

function anchorFor(key, field) {
  const esc = (v) => (window.CSS?.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"'));
  return document.querySelector(`[data-sheet-edit][data-sheet-key="${esc(key)}"][data-sheet-field="${esc(field)}"]`);
}

function place(panel, anchor) {
  if (!anchor || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const gap = 6;
  let left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - 8 && rect.top - gap - height >= 8) top = rect.top - gap - height;
  top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
  left = Math.max(8, left);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}

export function closeCellEditor({ restoreFocus = true } = {}) {
  if (!active) return;
  const { panel, cleanup, key, field } = active;
  active = null;
  cleanup();
  panel.remove();
  if (restoreFocus) anchorFor(key, field)?.focus({ preventScroll: true });
}

export const isEditorOpen = () => !!active;

// What the panel was opened over: whether the cell held a typed value, which one, and when it was
// typed. Not the default: a target amount's default moves with every price tick, and a panel that
// redrew itself every fifteen seconds would take the cursor from somebody about to type.
const shownOf = (cell) => JSON.stringify([!!cell?.edited, cell?.edited ? cell.value : null, cell?.entry?.at || null]);
const typedOf = (cell) => JSON.stringify([!!cell?.edited, cell?.edited ? cell.value : null]);

/**
 * The owning tab repainted: if the open cell's shared value moved underneath the panel, follow it.
 * `cellFor(key, field)` returns the cell as the tab now paints it.
 */
export function refreshCellEditor(cellFor) {
  if (!active) return;
  const next = cellFor(active.key, active.field);
  if (!next || next.pending || shownOf(next) === active.shown) return;
  const { panel, options } = active;
  const input = panel.querySelector('[data-sheet-input]');
  const byInput = panel.querySelector('[data-sheet-by]');
  if (input.value === active.initialText) {
    // Nothing typed yet: redraw over the newer value, keeping the name and the panel where it was.
    const { left, top } = panel.style;
    const byText = byInput.value;
    const byFocused = document.activeElement === byInput;
    openCellEditor({ ...options, anchor: anchorFor(options.key, options.field) || options.anchor, cell: next });
    if (!active) return;
    if (!active.panel.style.left) Object.assign(active.panel.style, { left, top });
    const freshBy = active.panel.querySelector('[data-sheet-by]');
    freshBy.value = byText;
    if (byFocused) freshBy.focus();
    return;
  }
  const changedTyped = typedOf(next) !== active.typed;
  active.shown = shownOf(next);
  if (!changedTyped) return;
  active.typed = typedOf(next);
  const note = panel.querySelector('[data-sheet-changed]');
  const format = options.format || ((v) => String(v));
  note.textContent = next.edited
    ? `Changed meanwhile to ${format(next.value)} — ${editedLabel(next.entry)}. Saving replaces it.`
    : 'Cleared by someone else meanwhile. Saving sets it again.';
  note.hidden = false;
}

/**
 * Open the editor for one cell.
 *
 *   anchor     the cell button that was clicked
 *   key/field  which cell, so the panel can find it again after a repaint
 *   company    the company's name, for the heading
 *   cell       { value, edited, pending, entry, fallback, fallbackLabel } from data/research-sheets.js
 *   format     (value) -> string, how the default prints
 *   onSave     (value, by) -> void   onClear (by) -> void
 */
export function openCellEditor(options) {
  const { anchor, key, field, company, cell, onSave, onClear, label = null } = options;
  closeCellEditor({ restoreFocus: false });
  const spec = FIELDS[field];
  if (!spec) return;
  const roster = people.roster().map((p) => p.name);
  const me = people.me() || '';
  const fallback = cell?.fallback;
  const hasFallback = fallback !== null && fallback !== undefined && fallback !== '';
  const listId = `sheet-people-${Math.random().toString(36).slice(2, 8)}`;
  const panel = document.createElement('div');
  panel.className = 'sheet-editor';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', `Edit ${label || spec.label} for ${company}`);
  panel.innerHTML = `
    <form class="sheet-editor-form" novalidate>
      <div class="sheet-editor-head">
        <div class="sheet-editor-title">${escapeHtml(label || spec.label)}</div>
        <div class="sheet-editor-company">${escapeHtml(company)}</div>
      </div>
      <label class="sheet-editor-field">
        <span class="sr-only">${escapeHtml(label || spec.label)}</span>
        <input data-sheet-input type="text" autocomplete="off" spellcheck="${spec.kind === 'text' ? 'true' : 'false'}"
          ${spec.kind === 'number' ? 'inputmode="decimal"' : ''} maxlength="${spec.kind === 'text' ? spec.max : 40}"
          value="${escapeHtml(cell?.edited ? inputText(field, cell.value) : '')}"
          placeholder="${escapeHtml(hasFallback ? inputText(field, fallback) : '')}" />
      </label>
      <p class="sheet-editor-error" data-sheet-error role="alert" hidden></p>
      <p class="sheet-editor-changed" data-sheet-changed role="status" hidden></p>
      <label class="sheet-editor-name">
        <span>Edited by</span>
        <input data-sheet-by type="text" list="${listId}" maxlength="60" value="${escapeHtml(me)}" placeholder="Your name (optional)" autocomplete="off" />
        <datalist id="${listId}">${roster.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist>
      </label>
      <div class="sheet-editor-actions">
        ${cell?.edited ? `<button type="button" data-sheet-clear class="sheet-editor-secondary">${hasFallback ? 'Reset to default' : 'Clear'}</button>` : '<span></span>'}
        <span class="sheet-editor-buttons">
          <button type="button" data-sheet-cancel class="sheet-editor-secondary">Cancel</button>
          <button type="submit" class="sheet-editor-primary">Save</button>
        </span>
      </div>
    </form>`;
  document.body.appendChild(panel);
  const input = panel.querySelector('[data-sheet-input]');
  const byInput = panel.querySelector('[data-sheet-by]');
  const error = panel.querySelector('[data-sheet-error]');
  place(panel, anchor);

  // The name signs the edit, and becomes this browser's name for the next one — the same identity
  // the watchlist's "Who is adding this?" prompt preselects, so one person is one name everywhere.
  const by = () => {
    const name = byInput.value.trim();
    if (name) people.remember(name);
    return name || null;
  };
  const showError = (text) => { error.textContent = text; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); };

  const onSubmit = (event) => {
    event.preventDefault();
    const read = readInput(field, input.value);
    if (read.error) return showError(read.error);
    if (read.empty) {
      // An empty box on Save means "nothing typed": clear an edit if there was one, else just close.
      if (cell?.edited) onClear?.(by());
      closeCellEditor();
      return;
    }
    onSave?.(read.value, by());
    closeCellEditor();
  };
  const onClick = (event) => {
    if (event.target.closest('[data-sheet-cancel]')) closeCellEditor();
    else if (event.target.closest('[data-sheet-clear]')) { onClear?.(by()); closeCellEditor(); }
  };
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCellEditor(); return; }
    if (event.key !== 'Tab') return;
    // Keep Tab inside the panel while it is open; Escape is always the way out.
    const focusable = [...panel.querySelectorAll('input, button')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const onDown = (event) => {
    if (panel.contains(event.target)) return;
    // A press on another editable cell opens that one; anywhere else simply closes this one.
    closeCellEditor({ restoreFocus: false });
  };
  const reposition = () => place(panel, anchorFor(key, field) || anchor);

  panel.addEventListener('submit', onSubmit);
  panel.addEventListener('click', onClick);
  panel.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  active = {
    panel, key, field, options,
    initialText: input.value,
    shown: shownOf(cell),
    typed: typedOf(cell),
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    },
  };
  input.focus();
  input.select();
}
