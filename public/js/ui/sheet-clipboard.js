// Excel's plain-text clipboard is TSV, including quoted tabs/newlines and doubled quotes.
// Plan the whole rectangle before the shared sheet receives a single edit.
import { FIELDS, SHEET_COMPANY_LIMIT } from '../data/research-sheet-shared.js';
import { readInput } from './sheet-editor.js';

export function readSheetClipboard(text) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('The copied range is too large. Paste a smaller range.');
  const source = text.replace(/^\uFEFF/, '');
  const rows = [], row = [];
  let value = '', quoted = false, closed = false, endedRow = false;
  const cell = () => {
    row.push(value); value = ''; closed = false;
    if (row.length > 200) throw new Error('The copied range has too many columns. Paste a smaller range.');
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    endedRow = false;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else value += ch;
    } else if (ch === '\t') cell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      cell(); rows.push(row.splice(0)); endedRow = true;
      if (rows.length > SHEET_COMPANY_LIMIT) throw new Error('The copied range has too many rows. Paste a smaller range.');
    } else if (ch === '"' && !value && !closed) quoted = true;
    else {
      if (closed) throw new Error('The copied cells have invalid quotes. Copy the range from Excel again.');
      value += ch;
    }
  }
  if (quoted) throw new Error('The copied cells have an unfinished quote. Copy the range from Excel again.');
  // Excel ends a range with one row separator; it is not an additional blank destination row.
  if (!endedRow || !rows.length) { cell(); rows.push(row); }
  if (rows.length > SHEET_COMPANY_LIMIT) throw new Error('The copied range has too many rows. Paste a smaller range.');
  if (rows.some(r => r.length !== rows[0].length)) throw new Error('The copied cells must form a rectangle. Copy one Excel range.');
  return rows;
}

export function planSheetPaste(matrix, { rows, columns, key, field, by = null }) {
  const startRow = rows.findIndex(row => row.key === key);
  const startColumn = columns.findIndex(column => column.field === field);
  if (startRow < 0 || startColumn < 0) throw new Error('The starting cell changed. Select it again.');
  if (startRow + matrix.length > rows.length) throw new Error('The copied range extends beyond the last matching row. Nothing was pasted.');
  if (startColumn + matrix[0].length > columns.length) throw new Error('The copied range extends beyond the last column. Nothing was pasted.');
  const intents = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = rows[startRow + r];
    for (let c = 0; c < matrix[r].length; c++) {
      const column = columns[startColumn + c], spec = FIELDS[column.field];
      const where = `Row ${r + 1}, ${column.label}`;
      if (!spec || !row[column.field]) throw new Error(`${where} is read-only. Paste into editable columns.`);
      const text = matrix[r][c];
      if (spec.kind === 'text' && text.replace(/\s+/g, ' ').trim().length > spec.max)
        throw new Error(`${where}: use at most ${spec.max} characters.`);
      const read = readInput(column.field, text);
      if (read.error) throw new Error(`${where}: ${read.error}`);
      const prior = row[column.field];
      if (read.empty) {
        if (prior.edited) intents.push({ op: 'clear', key: row.key, field: column.field, by });
      } else if (!prior.edited || prior.value !== read.value) {
        intents.push({ op: 'set', key: row.key, field: column.field, value: read.value, by });
      }
    }
  }
  return intents;
}
