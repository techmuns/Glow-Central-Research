// ui/export.js — generic "Export Excel" helper for any scoreTable.
//
// exceljs is loaded on demand from the CDN the first time an export runs, so the initial page
// load doesn't carry ~900KB nobody may use. No bundler involved: it's a plain <script> tag
// that publishes `window.ExcelJS`.
//
//   import { exportRows } from '../ui/export.js';
//   exportRows({ filename: 'sattva-technicals', sheetName: 'Technicals', columns, rows });
//
// `columns` is `[{ header, key, width?, get(row) }]`. Everything is a caller decision — this
// file knows nothing about technicals or any other tab, so prompts 4–7 can adopt it as-is.

const EXCELJS_CDN = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

let loaderPromise = null;

function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (loaderPromise) return loaderPromise;
  loaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = EXCELJS_CDN;
    script.async = true;
    script.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('exceljs loaded but window.ExcelJS is missing')));
    script.onerror = () => {
      loaderPromise = null;
      reject(new Error('Could not load exceljs from the CDN'));
    };
    document.head.appendChild(script);
  });
  return loaderPromise;
}

/**
 * Build and download a single-sheet .xlsx.
 * Returns true on success, false if the export could not run (offline, CDN blocked) — the
 * caller decides how loudly to complain. Never throws into a click handler.
 */
export async function exportRows({ filename = 'export', sheetName = 'Sheet1', columns = [], rows = [] }) {
  let ExcelJS;
  try {
    ExcelJS = await loadExcelJs();
  } catch (err) {
    console.error('[export] exceljs unavailable', err);
    return false;
  }

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sattva Central Research';
    wb.created = new Date();
    const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));

    for (const row of rows) {
      const record = {};
      for (const c of columns) record[c.key] = c.get(row);
      ws.addRow(record);
    }

    // Header styling — indigo band, white bold text, matching the dashboard's brand ramp.
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
    header.alignment = { vertical: 'middle', horizontal: 'left' };
    header.height = 22;
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

    const buffer = await wb.xlsx.writeBuffer();
    triggerDownload(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${filename}.xlsx`);
    return true;
  } catch (err) {
    console.error('[export] failed to build workbook', err);
    return false;
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Today's date as YYYY-MM-DD, for stamping export filenames.
export function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}
