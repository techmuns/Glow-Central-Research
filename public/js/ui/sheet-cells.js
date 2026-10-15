// ui/sheet-cells.js — HOW A PORTFOLIO OR WATCHLIST CELL READS. GLOW-OWNED.
//
// Two kinds of cell, and a reader must be able to tell them apart without hovering:
//
//   EDITABLE   a button. Its value is either the desk's (a small gold dot says somebody typed it,
//              a hollow dot that it has not reached the shared sheet yet) or a default from the
//              statements or a formula (muted, italic, dotted underline). An empty one is a dash a
//              click fills in.
//   DERIVED    plain text the reader cannot type over: prices, returns, current value, weights.
//              Coloured only where the sign is the reading (a return), never for size.
//
// Every cell carries a title saying where its figure came from — the statement and its date, the
// formula and its inputs, or which missing input stops it — so nothing on the page is a bare number.

import { escapeHtml } from '../core/dom.js';
import { FIELDS, editedLabel } from '../data/research-sheet-shared.js';
import { formatSheetDate } from '../data/sheet-math.js';

const group = (v, decimals) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export const FORMAT = {
  rupee: (v) => group(v, 2),
  crore: (v) => group(v, 2),
  mcap: (v) => group(v, 0),
  shares: (v) => (Number.isInteger(+v) ? group(v, 0) : group(v, 2)),
  pct: (v) => `${v > 0 ? '+' : ''}${group(v, 1)}%`,
  weight: (v) => `${group(v, 1)}%`,
  date: (v) => formatSheetDate(v),
  text: (v) => String(v),
};

/** How an editable field prints, by its contract unit. */
export function formatField(field, value) {
  if (value == null || value === '') return '—';
  const spec = FIELDS[field];
  if (spec?.kind === 'date') return FORMAT.date(value);
  if (spec?.kind === 'text') return FORMAT.text(value);
  if (spec?.unit === 'crore') return FORMAT.crore(value);
  if (spec?.unit === 'pct') return FORMAT.weight(value);
  if (spec?.unit === 'rupee') return FORMAT.rupee(value);
  return FORMAT.shares(value);
}

const toneOf = (v) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-700');

/**
 * An editable cell. `cell` comes from data/research-sheets.js; `label` is the column heading, used
 * in the accessible name so a screen reader says what is being edited, not just the number.
 */
export function editableCell(row, cell, { label, company, align = 'left', display = null, sub = '', empty = '—' } = {}) {
  if (!cell) return '';
  const has = cell.value !== null && cell.value !== undefined && cell.value !== '';
  const isDate = FIELDS[cell.field]?.kind === 'date';
  const text = has ? (display ? display(cell.value) : formatField(cell.field, cell.value)) : empty;
  const state = !has ? 'is-empty' : cell.edited ? (cell.pending ? 'is-pending' : 'is-edited') : 'is-default';
  const title = [
    has ? `${label}: ${text}` : `${label}: empty`,
    cell.edited ? editedLabel(cell.entry) : has ? `Default — ${cell.fallbackLabel || 'derived'}` : 'Not filled in yet',
    isDate ? 'Click to choose a date' : 'Click to edit',
  ].filter(Boolean).join('\n');
  return `<button type="button" data-norow data-sheet-edit data-sheet-key="${escapeHtml(row.key)}" data-sheet-field="${escapeHtml(cell.field)}"
    class="sheet-cell ${state} ${isDate ? 'is-date' : ''} ${align === 'right' ? 'is-right' : 'is-text'}" title="${escapeHtml(title)}"
    aria-label="${escapeHtml(`Edit ${label} for ${company}${has ? `, currently ${text}` : ', empty'}`)}">
    ${isDate ? '<svg class="sheet-calendar-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>' : ''}<span class="sheet-cell-value">${escapeHtml(text)}</span>${cell.edited ? '<span class="sheet-cell-dot" aria-hidden="true"></span>' : ''}${sub ? `<span class="sheet-cell-sub">${escapeHtml(sub)}</span>` : ''}
  </button>`;
}

/**
 * A derived cell. A null prints a dash whose title names what is missing. `tags` are short words
 * printed beside the figure when the figure needs them on its face, not only in a tooltip — a TSR
 * without dividends, a value from the statement, an XIRR annualised from under a year.
 */
export function derivedCell(d, { format, tone = false, tags = [] } = {}) {
  if (!d || d.value === null || d.value === undefined) {
    return `<span class="sheet-derived is-missing" title="${escapeHtml(d?.title || 'Not available')}">—</span>`;
  }
  const chips = tags.filter(Boolean).map((t) => `<span class="sheet-tag" title="${escapeHtml(t.title || '')}">${escapeHtml(t.text)}</span>`).join('');
  return `<span class="sheet-derived tabular-nums ${tone ? toneOf(d.value) : ''}" title="${escapeHtml(d.title || '')}">${escapeHtml(format(d.value))}${chips}</span>`;
}

/** Sort value of a cell: its number, its ISO date, its lower-cased text, or null (sorted last). */
export function sortOf(cell) {
  const v = cell?.value;
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'string' ? v.toLowerCase() : v;
}

/** The value an export writes: the raw number or text, never a formatted string. */
export const exportOf = (cell) => {
  const v = cell?.value;
  return v === null || v === undefined || v === '' ? null : v;
};

/** "typed" / "default" / "" — the provenance an export writes beside a value. */
export const provenanceOf = (cell) => (!cell || cell.value == null || cell.value === '' ? '' : cell.edited ? (cell.pending ? 'typed (unsaved)' : 'typed') : 'default');

/**
 * The word a CMP carries on its face when it is not a current quote: `close` for the completed daily
 * close standing in (no quote captured), `saved` for the newest saved quote the live check could not
 * confirm. A current quote carries none.
 */
export function cmpTag(cmp) {
  if (!cmp || cmp.value == null) return null;
  if (cmp.source === 'Daily close') return { text: 'close', title: cmp.title };
  return cmp.stale ? { text: 'saved', title: `${cmp.title} — the newest saved quote; the live check could not confirm a newer one` } : null;
}
