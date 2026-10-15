// GLOW-OWNED. Preserve the visible export; hidden baselines distinguish spreadsheet edits from
// unchanged defaults and protect colleagues' newer values. Only changed editable cells are intents.
import { FIELDS, sameValue, sheetKey } from '../data/research-sheet-shared.js';
import { readInput } from './sheet-editor.js';
import { loadExcelJs } from './export.js';
import * as sheet from '../core/research-sheet.js';
import * as people from '../core/watchlist-people.js';

const BASELINE = '_Glow upload';
const VERSION = 'glow-research-sheet:v1';
const MAX_ROWS = 800;
const editable = (columns) => columns.filter((c) => Object.hasOwn(FIELDS, c.key));
const empty = (v) => v === null || v === undefined || v === '';
const equal = (a, b) => (empty(a) && empty(b)) || sameValue(a, b);

export function addSheetBaseline(wb, { kind, columns, rows }) {
  const ws = wb.addWorksheet(BASELINE, { state: 'veryHidden' });
  ws.addRow([VERSION, kind]);
  ws.addRow([JSON.stringify(columns.map((c) => c.header))]);
  for (const row of rows) {
    const fields = Object.fromEntries(editable(columns).map((c) => [c.key, {
      value: c.get(row), edited: !!row[c.key]?.edited,
    }]));
    ws.addRow([row.key, JSON.stringify(fields)]);
  }
}

function cellValue(cell, field, date1904 = false) {
  let value = cell.value;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) {
      if (value.result === undefined || value.result === null) throw new Error('Save the calculated workbook in Excel first.');
      value = value.result;
    } else if (value.richText) value = value.richText.map((part) => part.text).join('');
    else if (value.hyperlink) value = value.text;
    else throw new Error('Use a number, date or text value.');
  }
  if (empty(value)) return null;
  if (typeof value === 'number' && FIELDS[field].kind === 'date' && /[dy]/i.test(cell.numFmt || '')) {
    value = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(value) * 86400000);
  }
  if (value instanceof Date) {
    if (FIELDS[field].kind !== 'date' || !Number.isFinite(value.getTime())) throw new Error('Use a valid value for this column.');
    value = value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number' && FIELDS[field].unit === 'pct' && /%/.test(cell.numFmt || '')) value *= 100;
  return value;
}

function validatedValue(field, value) {
  if (FIELDS[field].kind === 'text' && String(value).trim().length > FIELDS[field].max) {
    throw new Error(`Use at most ${FIELDS[field].max} characters.`);
  }
  const parsed = readInput(field, value);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.empty ? null : parsed.value;
}

/** Pure planning: any malformed row or conflicting edit refuses the file before any cell is queued. */
export function planSheetUpload(wb, { kind, columns, rows, by = null }) {
  const ws = wb.getWorksheet(kind);
  const meta = wb.getWorksheet(BASELINE);
  if (!ws || !meta || meta.getCell('A1').value !== VERSION || meta.getCell('B1').value !== kind) {
    throw new Error(`Export a fresh ${kind} workbook, fill it in, and upload that file.`);
  }
  if (ws.rowCount > MAX_ROWS + 2 || meta.rowCount > MAX_ROWS + 2 || ws.columnCount !== columns.length) {
    throw new Error('Keep the exported rows and columns in their original format.');
  }
  const headers = columns.map((c) => c.header);
  if (meta.getCell('A2').value !== JSON.stringify(headers) || headers.some((h, i) => ws.getRow(2).getCell(i + 1).value !== h)) {
    throw new Error('The column headings have changed. Use the original exported format.');
  }
  const fields = editable(columns);
  const baselines = new Map();
  for (let n = 3; n <= meta.rowCount; n++) {
    const key = sheetKey(meta.getRow(n).getCell(1).value);
    let values;
    try { values = JSON.parse(meta.getRow(n).getCell(2).value); } catch { /* refused below */ }
    if (!key || baselines.has(key) || !values || fields.some((c) => !Object.hasOwn(values, c.key)
      || !values[c.key] || typeof values[c.key].edited !== 'boolean')) throw new Error('The workbook upload information is invalid. Export a fresh copy.');
    baselines.set(key, values);
  }
  const identity = columns.findIndex((c) => c.key === 'id' || c.key === 'ticker') + 1;
  const current = new Map(rows.map((r) => [String(r.ticker || r.isin || r.key).trim().toUpperCase(), r]));
  const seen = new Set();
  const intents = [];
  for (let n = 3; n <= ws.rowCount; n++) {
    const excelRow = ws.getRow(n);
    if (!excelRow.hasValues) continue;
    const id = String(excelRow.getCell(identity).value ?? '').trim().toUpperCase();
    const row = current.get(id);
    if (!row || !baselines.has(row.key)) throw new Error(`Row ${n}: ticker / ISIN is missing or no longer on this table. Export a fresh copy.`);
    if (seen.has(row.key)) throw new Error(`Row ${n}: duplicate company ${id}.`);
    seen.add(row.key);
    const base = baselines.get(row.key);
    for (const c of fields) {
      const before = base[c.key];
      let value;
      try {
        value = cellValue(excelRow.getCell(columns.indexOf(c) + 1), c.key, wb.properties.date1904);
        // Defaults can have greater precision than a manual field accepts. Compare the original
        // Excel value before rounding, so an untouched formula never turns into a typed override.
        if (equal(value, before.value)) continue;
        value = validatedValue(c.key, value);
      }
      catch (error) { throw new Error(`Row ${n}, ${c.header}: ${error.message}`); }
      if (equal(value, readInput(c.key, before.value).value ?? before.value)) continue;
      // Emptying a default does not erase the source figure. Emptying a typed value clears it.
      if (value === null && !before.edited) continue;
      const now = row[c.key];
      if (!now) throw new Error(`Row ${n}: this column cannot be edited.`);
      if (value === null ? !now.edited : now.edited && equal(now.value, value)) continue;
      if (!!now.edited !== before.edited || (before.edited && !equal(now.value, before.value))) {
        throw new Error(`Row ${n}, ${c.header}: changed on the dashboard since export. Export a fresh copy before uploading.`);
      }
      intents.push(value === null ? { op: 'clear', key: row.key, field: c.key, by }
        : { op: 'set', key: row.key, field: c.key, value, by });
    }
  }
  return intents;
}

// Reject large expanded ZIPs before ExcelJS decompresses them (xlsx is a ZIP archive).
function checkArchive(buffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error('Choose an exported .xlsx workbook.');
  const entries = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true), size = 0;
  if (entries > 2000) throw new Error('This workbook is too large.');
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The workbook archive is invalid.');
    size += view.getUint32(offset + 24, true);
    if (size > 20 * 1024 * 1024) throw new Error('This workbook is too large.');
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

export const sheetUploadHtml = () => `<button type="button" data-sheet-upload class="sheet-upload-button"><span aria-hidden="true">↑</span> Upload latest</button>
  <input data-sheet-upload-file type="file" accept=".xlsx" hidden />
  <span data-sheet-upload-status class="sheet-upload-status" role="status" hidden></span>`;

export function wireSheetUpload(host, { kind, columns, getRows }) {
  const button = host.querySelector('[data-sheet-upload]');
  const input = host.querySelector('[data-sheet-upload-file]');
  const status = host.querySelector('[data-sheet-upload-status]');
  host.querySelector('[data-export]').after(button);
  button.after(status);
  let busy = false, disposed = false;
  const tell = (text, error = false) => {
    status.textContent = text; status.hidden = false;
    status.classList.toggle('is-error', error);
  };
  const choose = () => { if (!busy) input.click(); };
  const upload = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = true; button.disabled = true;
    tell('Reading workbook…');
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error('Choose an exported .xlsx workbook under 5 MB.');
      const buffer = await file.arrayBuffer();
      checkArchive(buffer);
      const ExcelJS = await loadExcelJs();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      await sheet.syncNow({ force: true });
      if (disposed) return;
      const state = sheet.meta();
      if (!state.shared || state.error || state.pending) throw new Error('The shared sheet is unavailable or has unsaved edits. Try again after it reconnects.');
      const intents = planSheetUpload(wb, { kind, columns, rows: getRows(), by: people.me() || null });
      if (!intents.length) { tell('No changed manual fields.'); return; }
      sheet.applyEdits(intents);
      tell(`Saving ${intents.length} edits…`);
      const saved = await sheet.syncNow({ force: true });
      if (disposed) return;
      if (saved.error || saved.pending || !saved.shared) {
        tell(saved.error || 'Not saved yet. Edits will retry when connected.', true);
      } else tell(`${intents.length} edits saved for everyone.`);
    } catch (error) {
      if (!disposed) tell(error.message || 'Could not read this workbook.', true);
    } finally {
      busy = false; button.disabled = false;
    }
  };
  button.addEventListener('click', choose);
  input.addEventListener('change', upload);
  return () => { disposed = true; button.removeEventListener('click', choose); input.removeEventListener('change', upload); };
}
