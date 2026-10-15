// Excel-style fill down for the two Glow sheets. Preview first; one shared edit on release.
import * as sheet from '../core/research-sheet.js';
import * as people from '../core/watchlist-people.js';
import { FIELDS } from '../data/research-sheet-shared.js';

const hasValue = (v) => v !== null && v !== undefined && v !== '';
const typed = (cell) => JSON.stringify([!!cell?.edited, cell?.edited ? cell.value : null]);
const esc = (v) => CSS.escape(String(v));

export function wireSheetFill(root, { viewRows, liveRows, closeEditor, onEnd }) {
  let drag = null, frame = 0, feedback = null, feedbackTimer = 0, disposed = false;

  function notify(text, undo = null) {
    feedback?.remove();
    clearTimeout(feedbackTimer);
    feedback = document.createElement('div');
    feedback.className = 'sheet-fill-feedback';
    feedback.setAttribute('role', 'status');
    feedback.textContent = text;
    if (undo) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Undo'; button.dataset.sheetFillUndo = '';
      button.addEventListener('click', undo, { once: true });
      feedback.append(button);
    }
    document.body.append(feedback);
    feedbackTimer = setTimeout(() => { feedback?.remove(); feedback = null; }, 30000);
  }

  const findHandle = (key, field) => root.querySelector(`[data-sheet-fill-handle][data-sheet-key="${esc(key)}"][data-sheet-field="${esc(field)}"]`);
  const findCell = (key, field) => root.querySelector(`[data-sheet-edit][data-sheet-key="${esc(key)}"][data-sheet-field="${esc(field)}"]`);

  function marks() {
    if (!drag) return;
    const s = drag;
    for (const cell of root.querySelectorAll(`[data-sheet-edit][data-sheet-field="${esc(s.field)}"]`)) {
      const index = s.index.get(cell.dataset.sheetKey), td = cell.closest('td');
      td?.classList.toggle('sheet-fill-source', index === s.start);
      td?.classList.toggle('sheet-fill-target', index > s.start && index <= s.end);
    }
    const count = s.end - s.start;
    const text = count ? `${count} cell${count === 1 ? '' : 's'}` : 'Drag down to copy';
    if (s.preview.textContent !== text) s.preview.textContent = text;
    s.preview.style.left = `${Math.max(8, Math.min(innerWidth - 145, s.x + 14))}px`;
    s.preview.style.top = `${Math.max(8, Math.min(innerHeight - 40, s.y + 14))}px`;
  }

  function end({ silent = false } = {}) {
    if (!drag) return;
    const s = drag; drag = null;
    cancelAnimationFrame(frame); frame = 0;
    try { if (s.pointerId != null && root.hasPointerCapture(s.pointerId)) root.releasePointerCapture(s.pointerId); } catch { /* pointer already ended */ }
    s.preview.remove(); document.body.classList.remove('sheet-filling');
    for (const td of root.querySelectorAll('.sheet-fill-source, .sheet-fill-target')) td.classList.remove('sheet-fill-source', 'sheet-fill-target');
    if (!silent) {
      onEnd?.();
      requestAnimationFrame(() => {
        // A repaint may remove the focused handle. Restore only lost focus, never steal it
        // from a cell or control the reader has already moved to (or from a new gesture).
        if (!drag && !disposed && root.isConnected && document.activeElement === document.body)
          findHandle(s.key, s.field)?.focus({ preventScroll: true });
      });
    }
  }

  function cancel(message = '') { end(); if (message) notify(message); }

  function begin(handle, pointer = null) {
    end();
    const field = handle.dataset.sheetField, key = handle.dataset.sheetKey;
    if (!FIELDS[field] || field === 'name') return false;
    const rows = viewRows(), start = rows.findIndex(r => r.key === key), cell = rows[start]?.[field];
    if (start < 0 || !hasValue(cell?.value)) return false;
    closeEditor?.();
    const rect = handle.getBoundingClientRect(), preview = document.createElement('div');
    preview.className = 'sheet-fill-preview'; preview.setAttribute('role', 'status');
    document.body.append(preview);
    drag = { field, key, rows, keys: rows.map(r => r.key), index: new Map(rows.map((r, i) => [r.key, i])),
      start, end: start, value: cell.value, source: typed(cell), pointerId: pointer?.pointerId ?? null,
      x: pointer?.clientX ?? rect.right, y: pointer?.clientY ?? rect.bottom, preview,
      startX: pointer?.clientX, startY: pointer?.clientY, moved: false,
      scroll: handle.closest('[data-table-scroll]') };
    document.body.classList.add('sheet-filling');
    marks();
    return true;
  }

  function updateTarget() {
    if (!drag?.scroll) return;
    const s = drag, rect = s.scroll.getBoundingClientRect();
    const top = rect.top + Math.min(s.scroll.querySelector('thead')?.offsetHeight || 0, rect.height / 2);
    const y = Math.max(top + 1, Math.min(rect.bottom - 2, s.y));
    const rows = [...s.scroll.querySelectorAll('tbody tr[data-row-key]')];
    const hit = rows.find(row => { const r = row.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
    if (hit && s.index.has(hit.dataset.rowKey)) s.end = Math.max(s.start, s.index.get(hit.dataset.rowKey));
    marks();
  }

  function tick() {
    frame = 0;
    if (!drag || drag.pointerId == null) return;
    const s = drag, rect = s.scroll.getBoundingClientRect();
    const top = rect.top + Math.min(s.scroll.querySelector('thead')?.offsetHeight || 0, rect.height / 2);
    if (s.moved) {
      if (s.y > rect.bottom - 30) s.scroll.scrollTop += Math.min(22, Math.max(2, (s.y - rect.bottom + 30) / 2));
      else if (s.y < top + 30) s.scroll.scrollTop -= Math.min(22, Math.max(2, (top + 30 - s.y) / 2));
      updateTarget();
    }
    frame = requestAnimationFrame(tick);
  }

  function commit() {
    const s = drag;
    if (!s) return;
    if (s.end === s.start) { end(); return; }
    let order, current;
    try {
      order = viewRows().map(r => r.key);
      current = new Map(liveRows().map(r => [r.key, r]));
    } catch { cancel('Cells unavailable. Try filling again.'); return; }
    const selected = s.rows.slice(s.start + 1, s.end + 1);
    if (order.length !== s.keys.length || order.some((key, i) => key !== s.keys[i]) ||
        !current.has(s.key) || current.get(s.key)[s.field]?.value !== s.value || typed(current.get(s.key)[s.field]) !== s.source ||
        selected.some(row => !current.has(row.key) || typed(current.get(row.key)[s.field]) !== typed(row[s.field]))) {
      cancel('Cells changed. Try filling again.'); return;
    }
    const by = people.me() || null;
    const previous = selected.map(row => {
      const entry = sheet.entry(row.key, s.field);
      return entry ? { op: 'set', key: row.key, field: s.field, value: entry.value, by }
        : { op: 'clear', key: row.key, field: s.field, by };
    });
    try {
      const written = sheet.editMany(selected.map(row => ({ op: 'set', key: row.key, field: s.field, value: s.value, by })));
      const filled = written[0]; // Match the contract's canonical precision/text/editor on Undo.
      end();
      notify(`Filled ${selected.length} cell${selected.length === 1 ? '' : 's'}`, () => {
        // Restore only cells that still carry this fill's value and editor.
        const restore = previous.filter(item => { const entry = sheet.entry(item.key, item.field); return entry?.value === filled.value && entry.by === filled.by; });
        sheet.editMany(restore);
        notify(restore.length === previous.length ? 'Fill undone' : `Restored ${restore.length} cells; other cells changed since filling.`);
      });
    } catch { cancel('This value could not be filled.'); }
  }

  function pointerDown(event) {
    const handle = event.target.closest?.('[data-sheet-fill-handle]');
    if (!handle || !root.contains(handle)) { if (drag?.pointerId == null) end(); return; }
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (!begin(handle, event)) return;
    try { root.setPointerCapture(event.pointerId); } catch { /* synthetic events have no active pointer */ }
    frame = requestAnimationFrame(tick);
  }
  function pointerMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4;
    if (drag.moved) updateTarget();
  }
  function pointerUp(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    // Browsers may coalesce the final touch/mouse move. The release point is authoritative.
    drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4;
    if (drag.moved) { updateTarget(); commit(); } else end();
  }
  function pointerCancel(event) { if (drag?.pointerId === event.pointerId) end(); }
  function click(event) { if (drag || event.target.closest?.('[data-sheet-fill-handle]')) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function keyDown(event) {
    const handle = event.target.closest?.('[data-sheet-fill-handle]');
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); end(); return; }
    if (drag && event.key === 'Tab') { end(); return; }
    if (!handle || !root.contains(handle) || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (drag && (event.key === 'Enter' || event.key === ' ')) { commit(); return; }
    if (!drag && !begin(handle)) return;
    drag.end = Math.max(drag.start, Math.min(drag.rows.length - 1, drag.end + (event.key === 'ArrowUp' ? -1 : 1)));
    findCell(drag.keys[drag.end], drag.field)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    marks();
  }
  const blur = () => end();
  const hidden = () => { if (document.hidden) end(); };
  document.addEventListener('pointerdown', pointerDown, true);
  document.addEventListener('pointermove', pointerMove, { capture: true, passive: false });
  document.addEventListener('pointerup', pointerUp, true);
  document.addEventListener('pointercancel', pointerCancel, true);
  document.addEventListener('keydown', keyDown, true);
  root.addEventListener('lostpointercapture', pointerCancel);
  root.addEventListener('click', click, true);
  window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', hidden);
  return {
    active: () => !!drag,
    dispose() {
      disposed = true; end({ silent: true }); feedback?.remove(); clearTimeout(feedbackTimer);
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('pointermove', pointerMove, true);
      document.removeEventListener('pointerup', pointerUp, true);
      document.removeEventListener('pointercancel', pointerCancel, true);
      document.removeEventListener('keydown', keyDown, true);
      root.removeEventListener('lostpointercapture', pointerCancel);
      root.removeEventListener('click', click, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', hidden);
    },
  };
}
