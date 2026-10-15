// tabs/watchlist.js — WATCHLIST: the desk's shared watchlist as one editable sheet. GLOW-OWNED.
//
// Every company on the shared watchlist (core/watchlist.js — the same list the ☆ beside any company
// row adds to, one list for the whole desk), in the columns the desk asked for: the Portfolio tab's
// research columns without the holding ones, plus SOURCE — where the idea came from — between Sector
// and CMP.
//
// The typed values are the SAME record per company the Portfolio tab reads (core/research-sheet.js):
// an intrinsic value, target or methodology typed here is already there when the company is bought.
// The one field kept apart is the buy price the Expected IRR is measured from (`entryPrice`): a
// planned entry is not the price paid, and sharing one field would let a Watchlist edit rewrite the
// Portfolio's cost.
//
// Scope does not apply (`scopeIndependent`): this tab IS the watchlist, under any scope.

import { sectionHead, scoreTable, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import * as sheet from '../core/research-sheet.js';
import * as watchlist from '../core/watchlist.js';
import * as book from '../data/book.js';
import * as coverage from '../data/coverage.js';
import * as market from '../data/sheet-market.js';
import { watchlistRows } from '../data/research-sheets.js';
import { editableCell, derivedCell, FORMAT, sortOf, exportOf, provenanceOf, formatField, cmpTag } from '../ui/sheet-cells.js';
import { openCellEditor, closeCellEditor, isEditorOpen, refreshCellEditor } from '../ui/sheet-editor.js';
import { sheetStatusPill, sheetHowModal } from '../ui/sheet-chrome.js';
import { openScopeEditor } from '../ui/scope-editor.js';
import { exportSheets, todayStamp } from '../ui/export.js';

export const meta = {
  id: 'watchlist',
  title: 'Watchlist',
  subviews: [],
  allowEmptyScope: true,
  scopeIndependent: true,
};

export const HEAD = {
  sector: 'Sector',
  source: 'Source',
  cmp: 'CMP (in Rs)',
  mcap: 'Market cap (in Rs cr)',
  day: '1 day return (in %)',
  month: '1 month return (in %)',
  targetAmount: 'Target amount to be invested (in Rs cr)',
  targetWeight: 'Target weight in portfolio (% of public direct)',
  intrinsicValue: 'Intrinsic value/fair value per share (in Rs)',
  methodology: 'Valuation methodology',
  reference: 'Reference year and date',
  upside: 'Upside available on CMP (Intrinsic value / CMP)',
  expectedIrr: 'Expected IRR on buy price (Intrinsic value / Buy price)',
};

let ctxRef = null;
let table = null;
let tableView = null;
let tableRoot = null;
let rowsNow = [];
let disposers = [];
let paintQueued = false;
let releaseTable = null;
let releaseRoot = null;

const company = (r) => r.name.value || r.ticker;

function subLine(r) {
  return [r.ticker, r.addedBy ? `added by ${r.addedBy}` : 'added before names were recorded'].join(' · ');
}

function afterSub(r) {
  return `<div class="sheet-row-actions"><button type="button" data-norow data-sheet-edit data-sheet-key="${escapeHtml(r.key)}" data-sheet-field="name" class="sheet-row-action" title="Rename ${escapeHtml(company(r))} on this sheet">Rename</button></div>`;
}

const edit = (field, opts = {}) => ({
  label: HEAD[field],
  html: true,
  align: opts.align || 'right',
  sortValue: (r) => sortOf(r[field]),
  get: (r) => editableCell(r, r[field], { label: HEAD[field], company: company(r), align: opts.align || 'right' }),
});

const live = (field, format, opts = {}) => ({
  label: HEAD[field],
  html: true,
  align: 'right',
  sortValue: (r) => r[field]?.value ?? null,
  get: (r) => derivedCell(r[field], { format, tone: !!opts.tone, tags: opts.tags ? opts.tags(r) : [] }),
});

// THE EXPECTED IRR CELL CARRIES ITS OWN INPUT. A watched company has no purchase, so the buy price
// this ratio is measured from is the desk's to set — and the desk asked for no extra column. The
// figure prints on top, and the buy price it was measured from sits under it as an editable line.
function irrCell(r) {
  const figure = derivedCell(r.expectedIrr, { format: FORMAT.pct, tone: true });
  const priceLine = editableCell(r, r.entryPrice, {
    label: 'Buy price for the expected IRR (in Rs)', company: company(r), align: 'right',
    display: (v) => `on ₹${FORMAT.rupee(v)}`, empty: 'set buy price',
  });
  return `<div class="sheet-irr">${figure}${priceLine}</div>`;
}

function columns() {
  return [
    edit('sector', { align: 'left' }),
    edit('source', { align: 'left' }),
    live('cmp', FORMAT.rupee, { tags: (r) => [cmpTag(r.cmp)] }),
    live('mcap', FORMAT.mcap),
    live('day', FORMAT.pct, { tone: true }),
    live('month', FORMAT.pct, { tone: true }),
    edit('targetAmount'),
    edit('targetWeight'),
    edit('intrinsicValue'),
    edit('methodology', { align: 'left' }),
    edit('reference', { align: 'left' }),
    live('upside', FORMAT.pct, { tone: true }),
    { label: HEAD.expectedIrr, html: true, align: 'right', sortValue: (r) => r.expectedIrr.value ?? null, get: irrCell },
  ];
}

const searchText = (r) => [r.name.value, r.ticker, r.sector.value, r.source.value, r.methodology.value, r.reference.value, r.addedBy]
  .filter(Boolean).join(' ').toLowerCase();

function headMeta(rows) {
  const m = watchlist.meta();
  const origin = m.origin === 'live' ? 'the desk’s shared watchlist, confirmed just now' : m.origin === 'pending' ? 'the shared watchlist, with this browser’s edits on the way' : 'this browser’s copy of the shared watchlist';
  return `<div class="flex flex-wrap items-center justify-end gap-2">
    <span class="inline-flex items-center rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200" title="${escapeHtml(`Companies on ${origin}. Target weights are measured against the Portfolio tab’s public-direct value.`)}" data-watchlist-summary>${rows.length} compan${rows.length === 1 ? 'y' : 'ies'} watched</span>
    ${sheetStatusPill()}
  </div>`;
}

function controlsHtml() {
  return `
    <button type="button" data-watchlist-sheet-add class="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">
      <span aria-hidden="true">＋</span> Add companies
    </button>`;
}

function emptyHtml() {
  return `
    <div class="fade-in rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100" data-watchlist-sheet-empty>
      <div class="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-2xl text-amber-400 ring-1 ring-amber-100">☆</div>
      <h3 class="font-display mt-4 text-lg font-bold text-slate-900">The desk's watchlist is empty</h3>
      <p class="mx-auto mt-2 max-w-xl text-sm text-slate-500">Add a company by name or ticker, or press ☆ beside any company row on another tab. It appears here with its price, returns and market cap, ready for a fair value, a target and a source.</p>
      <button type="button" data-watchlist-sheet-add class="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">Add companies to watchlist</button>
    </div>`;
}

function tableConfig(rows) {
  return {
    rows,
    key: (r) => r.key,
    watchKey: (r) => r.ticker,
    watchName: (r) => company(r),
    name: (r) => company(r),
    nameLabel: 'Name of company',
    sub: subLine,
    afterSub,
    columns: columns(),
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 230,
    showWatchFilter: false,
    searchable: searchText,
    searchPlaceholder: 'Search company, sector or source…',
    countNoun: 'companies',
    emptyMessage: 'No watched company matches this search.',
    initialView: tableView,
    stickyHead: 'max(360px, calc(100vh - 300px))',
    columnLayoutKey: 'glow-watchlist-sheet',
    exportName: `glow-watchlist-${todayStamp()}`,
    onExport: (visible) => exportWatchlist(visible),
    bookmarkSection: 'watchlist',
  };
}

function exportWatchlist(visible) {
  const value = (field) => ({ header: HEAD[field], key: field, width: 16, get: (r) => exportOf(r[field]) });
  const typed = (field) => [value(field), { header: `${HEAD[field]} — typed or default`, key: `${field}-p`, width: 14, get: (r) => provenanceOf(r[field]) }];
  const columns = [
    { header: 'Name of company', key: 'name', width: 34, get: (r) => company(r) },
    { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
    ...typed('sector'), ...typed('source'), value('cmp'), value('mcap'), value('day'), value('month'),
    ...typed('targetAmount'), ...typed('targetWeight'), ...typed('intrinsicValue'), ...typed('methodology'), ...typed('reference'),
    value('upside'),
    { header: 'Buy price for the expected IRR (in Rs)', key: 'entry', width: 16, get: (r) => exportOf(r.entryPrice) },
    value('expectedIrr'),
    { header: 'Added to the watchlist by', key: 'by', width: 18, get: (r) => r.addedBy || 'not recorded' },
  ];
  const banner = `Glow Central Research · Watchlist · exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. `
    + 'CMP, market cap, returns and upside are derived at export time from the minute price capture; typed values are the desk\'s. Target weights are measured against the public-direct portfolio value.';
  void exportSheets({ filename: `glow-watchlist-${todayStamp()}`, banner, sheets: [{ name: 'Watchlist', columns, rows: visible }] });
}

// ---- painting ------------------------------------------------------------------------------

function cleanup() {
  for (const off of disposers.splice(0)) { try { off(); } catch { /* already gone */ } }
  releaseTable?.(); releaseTable = null;
  releaseRoot?.(); releaseRoot = null;
  if (table) tableView = table.view;
  table = null;
  tableRoot = null;
}

function schedule() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    const ctx = ctxRef;
    if (!ctx) return;
    paint(ctx);
    // A colleague's edit to the cell open in the editor reaches the panel as well as the table.
    refreshCellEditor((key, field) => rowsNow.find((r) => r.key === key)?.[field] || null);
  });
}

function paint(ctx) {
  if (ctxRef !== ctx || !ctx.root.isConnected) return;
  const rows = watchlistRows();
  rowsNow = rows;
  if (!rows.length) {
    if (table) { releaseTable?.(); releaseTable = null; tableView = table.view; table = null; tableRoot = null; }
    ctx.root.innerHTML = `
      <div data-sheet-tab="watchlist">
        ${sectionHead({ title: 'Watchlist', compact: true, meta: `<div data-watchlist-head-meta>${headMeta(rows)}</div>` })}
        ${emptyHtml()}
      </div>`;
    return;
  }
  if (table && tableRoot === ctx.root && ctx.root.querySelector('[data-score-table]')) {
    table.updateData(rows);
    const head = ctx.root.querySelector('[data-watchlist-head-meta]');
    if (head) head.innerHTML = headMeta(rows);
    return;
  }
  releaseTable?.();
  table = scoreTable(tableConfig(rows));
  tableRoot = ctx.root;
  ctx.root.innerHTML = `
    <div class="fade-in" data-sheet-tab="watchlist">
      ${sectionHead({ title: 'Watchlist', compact: true, meta: `<div data-watchlist-head-meta>${headMeta(rows)}</div>`, controls: controlsHtml() })}
      <div data-sheet-table="watchlist">${table.html}</div>
      <div class="mt-3 text-center"><button type="button" data-sheet-how class="text-xs font-semibold text-slate-400 underline decoration-slate-200 underline-offset-4 transition-colors hover:text-indigo-600">How each column is calculated, and where its figures come from</button></div>
    </div>`;
  releaseTable = table.wire(ctx.root);
}

function onRootClick(event) {
  const ctx = ctxRef;
  if (!ctx) return;
  const cellButton = event.target.closest('[data-sheet-edit]');
  if (cellButton && ctx.root.contains(cellButton)) {
    const key = cellButton.dataset.sheetKey;
    const field = cellButton.dataset.sheetField;
    const row = rowsNow.find((r) => r.key === key);
    if (!row || !row[field]) return;
    // Edit the desk's latest value, not this browser's last poll: a check that brings a newer one
    // redraws the panel before anybody has typed in it.
    void sheet.freshen();
    openCellEditor({
      anchor: cellButton, key, field, company: company(row), cell: row[field],
      label: field === 'name' ? 'Name of company' : field === 'entryPrice' ? 'Buy price for the expected IRR (in Rs)' : HEAD[field],
      format: (v) => formatField(field, v),
      onSave: (v, by) => sheet.set(key, field, v, by),
      onClear: (by) => sheet.clear(key, field, by),
    });
    return;
  }
  if (event.target.closest('[data-watchlist-sheet-add]')) {
    closeCellEditor({ restoreFocus: false });
    openScopeEditor({ scope: 'watchlist', onChanged: schedule });
    return;
  }
  if (event.target.closest('[data-sheet-how]')) openModal(sheetHowModal('watchlist'), { size: 'wide' });
}

export function render(ctx) {
  ctxRef = ctx;
  cleanup();
  ctx.root.innerHTML = `<div class="rounded-2xl bg-white p-8 text-center text-sm text-slate-400 shadow-sm ring-1 ring-slate-100" data-watchlist-loading>Reading the shared watchlist and today's prices…</div>`;
  ctx.root.addEventListener('click', onRootClick);
  releaseRoot = () => ctx.root.removeEventListener('click', onRootClick);
  disposers.push(sheet.start());
  disposers.push(sheet.onChange(schedule));
  disposers.push(market.watch(schedule));
  disposers.push(watchlist.onChange(schedule));
  disposers.push(coverage.onChange(schedule));
  void watchlist.syncNow({ force: true });
  // The book is read for one figure here — the public-direct value target weights are measured
  // against — so a failure to read it leaves those defaults empty rather than stopping the tab.
  Promise.allSettled([book.load(), market.load()]).then(() => {
    if (ctxRef !== ctx) return;
    paint(ctx);
  });
}

export function destroy() {
  closeCellEditor({ restoreFocus: false });
  cleanup();
  ctxRef = null;
  rowsNow = [];
}

export const _rows = () => rowsNow;
export const _editorOpen = () => isEditorOpen();
