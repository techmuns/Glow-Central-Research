// tabs/portfolio.js — PORTFOLIO: the family's public direct holdings as one editable sheet. GLOW-OWNED.
//
// The desk's own table, in the columns it asked for (12 October 2026): every listed company the
// family holds OUTSIDE a PMS mandate, with the market's figures read live and the desk's figures
// typed into the cells.
//
//   LIVE, NEVER TYPED     CMP, market cap, 1-day and 1-month return, current value, TSR including
//                         dividends received, alpha over the NSE 500, XIRR, weight in the public-
//                         direct book, upside on CMP, expected IRR on the buy price. They move with
//                         the minute price capture (every 15 seconds while visible) and the Nifty 500.
//   TYPED BY THE DESK     sector, date bought, quantity, buy price, amount invested, target amount,
//                         target weight, pending amount, intrinsic value, methodology, reference.
//                         Where the family's statements carry a figure (shares held, the average
//                         cost a broker prints, the oldest lot's date) the cell shows it as a
//                         DEFAULT — muted and dotted — until somebody types over it.
//
// The typed values are shared desk state (core/research-sheet.js → /api/research-sheet), one record
// per company, so a fair value typed here is the same fair value on the Watchlist tab. See the
// *Portfolio and Watchlist* section of CLAUDE.md before changing what a column means.
//
// SCOPE DOES NOT APPLY, and the header says so by hiding the scope toggle (`scopeIndependent`), as
// Bookmarks does: this tab IS the portfolio, and a Watchlist or Universe reading of it would be a
// different table, not a narrower one.

import { sectionHead, scoreTable, openModal, closeModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import * as sheet from '../core/research-sheet.js';
import * as book from '../data/book.js';
import * as coverage from '../data/coverage.js';
import * as market from '../data/sheet-market.js';
import * as technicals from '../data/technicals.js';
import { portfolioRows } from '../data/research-sheets.js';
import { sheetKey } from '../data/research-sheet-shared.js';
import { searchCompanies } from '../data/stock-search.js';
import { editableCell, derivedCell, FORMAT, sortOf, exportOf, provenanceOf, formatField, cmpTag } from '../ui/sheet-cells.js';
import { openCellEditor, closeCellEditor, isEditorOpen, refreshCellEditor } from '../ui/sheet-editor.js';
import { wireSheetFill } from '../ui/sheet-fill.js';
import { sheetStatusPill, sheetHowModal, companySearchHtml } from '../ui/sheet-chrome.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import { addSheetBaseline, sheetUploadHtml, wireSheetUpload } from '../ui/sheet-workbook.js';

export const meta = {
  id: 'portfolio',
  title: 'Portfolio',
  subviews: [],
  allowEmptyScope: true,
  scopeIndependent: true,
};

// Column headings are the desk's own wording. They are also the sort keys and the column-order
// identity (ui/column-order.js), so each must stay unique and stable.
export const HEAD = {
  sector: 'Sector',
  cmp: 'CMP (in Rs)',
  mcap: 'Market cap (in Rs cr)',
  day: '1 day return (in %)',
  month: '1 month return (in %)',
  dateBought: 'Date bought',
  quantity: 'Quantity bought (number of shares)',
  buyPrice: 'Buy price (in Rs)',
  tsr: 'TSR % including dividend received',
  alpha: 'Alpha over NSE 500',
  amountInvested: 'Amount invested (in Rs cr)',
  currentValue: 'Current value (in Rs cr)',
  xirr: 'XIRR (TSR)',
  weight: 'Weight in portfolio (% of public direct, excl. PMS)',
  targetAmount: 'Target amount to be invested (in Rs cr)',
  targetWeight: 'Target weight in portfolio (% of public direct)',
  pendingAmount: 'Pending amount to be invested (in Rs cr)',
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
let fill = null;

const company = (r) => r.name.value || r.ticker || r.key;

function subLine(r) {
  const parts = [r.ticker || (r.isin ? `ISIN ${r.isin}` : null)];
  if (r.kind === 'manual') parts.push(`added by hand${r.manual?.addedBy ? ` · ${r.manual.addedBy}` : ''}`);
  else if (r.statement?.where) parts.push(r.statement.where.split('; ').map((w) => w.split(' · ')[1]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '));
  return parts.filter(Boolean).join(' · ');
}

function afterSub(r) {
  const label = escapeHtml(company(r));
  const rename = `<button type="button" data-norow data-sheet-edit data-sheet-key="${escapeHtml(r.key)}" data-sheet-field="name" class="sheet-row-action" title="Rename ${label} on this sheet">Rename</button>`;
  const remove = r.kind === 'manual'
    ? `<button type="button" data-norow data-sheet-remove="${escapeHtml(r.key)}" class="sheet-row-action is-danger" title="Remove ${label}, added by hand, from the portfolio sheet">Remove</button>`
    : '';
  return `<div class="sheet-row-actions">${rename}${remove}</div>`;
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

function columns() {
  return [
    edit('sector', { align: 'left' }),
    live('cmp', FORMAT.rupee, { tags: (r) => [cmpTag(r.cmp)] }),
    live('mcap', FORMAT.mcap),
    live('day', FORMAT.pct, { tone: true }),
    live('month', FORMAT.pct, { tone: true }),
    edit('dateBought'),
    edit('quantity'),
    edit('buyPrice'),
    live('tsr', FORMAT.pct, { tone: true, tags: (r) => [r.tsr.value != null && !r.tsr.dividendsIncluded ? { text: 'excl. div', title: r.dividends.title } : null] }),
    live('alpha', FORMAT.pct, { tone: true }),
    edit('amountInvested'),
    live('currentValue', FORMAT.crore, { tags: (r) => [r.currentValue.basis === 'statement' ? { text: 'stmt', title: r.currentValue.title } : null] }),
    live('xirr', FORMAT.pct, { tone: true, tags: (r) => [r.xirr.value != null && r.xirr.short ? { text: '<1y', title: 'Annualised from a holding period under a year' } : null] }),
    live('weight', FORMAT.weight),
    edit('targetAmount'),
    edit('targetWeight'),
    edit('pendingAmount'),
    edit('intrinsicValue'),
    edit('methodology', { align: 'left' }),
    edit('reference', { align: 'left' }),
    live('upside', FORMAT.pct, { tone: true }),
    live('expectedIrr', FORMAT.pct, { tone: true }),
  ];
}

function searchText(r) {
  return [r.name.value, r.ticker, r.isin, r.sector.value, r.methodology.value, r.reference.value, r.manual?.addedBy,
    r.statement?.where].filter(Boolean).join(' ').toLowerCase();
}

function addHoldingHtml() {
  return `
    <button type="button" data-portfolio-add class="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">
      <span aria-hidden="true">＋</span> Add holding
    </button>`;
}

function footerHtml() {
  return `<div class="mt-3 text-center"><button type="button" data-sheet-how class="text-xs font-semibold text-slate-400 underline decoration-slate-200 underline-offset-4 transition-colors hover:text-indigo-600">How each column is calculated, and where its figures come from</button></div>`;
}

function tableConfig(rows) {
  return {
    rows,
    key: (r) => r.key,
    watchKey: (r) => r.ticker || null,
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
    searchPlaceholder: 'Search company, sector or methodology…',
    countNoun: 'holdings',
    emptyMessage: 'No holding matches this search.',
    initialSort: { key: HEAD.currentValue, dir: 'desc' },
    initialView: tableView,
    stickyHead: 'max(360px, calc(100vh - 300px))',
    columnLayoutKey: 'glow-portfolio-sheet',
    exportName: `glow-portfolio-${todayStamp()}`,
    onExport: (visible) => exportPortfolio(visible),
    toolbarControls: {
      html: addHoldingHtml() + sheetUploadHtml(),
      wire: (host) => {
        host.querySelector('[data-export]').before(host.querySelector('[data-portfolio-add]'));
        return wireSheetUpload(host, { kind: 'Portfolio', columns: portfolioExportColumns(), getRows: portfolioRows });
      },
    },
    bookmarkSection: 'portfolio',
  };
}

export function portfolioExportColumns() {
  const value = (field) => ({ header: HEAD[field], key: field, width: 16, get: (r) => exportOf(r[field]) });
  const typed = (field) => [value(field), { header: `${HEAD[field]} — typed or default`, key: `${field}-p`, width: 14, get: (r) => provenanceOf(r[field]) }];
  return [
    { header: 'Name of company', key: 'name', width: 34, get: (r) => company(r) },
    { header: 'Ticker / ISIN', key: 'id', width: 14, get: (r) => r.ticker || r.isin || r.key },
    ...typed('sector'), value('cmp'), value('mcap'), value('day'), value('month'),
    ...typed('dateBought'), ...typed('quantity'), ...typed('buyPrice'),
    value('tsr'), { header: 'Dividends counted in TSR', key: 'div', width: 40, get: (r) => r.dividends.title },
    value('alpha'), ...typed('amountInvested'), value('currentValue'),
    { header: 'Current value basis', key: 'cvb', width: 14, get: (r) => r.currentValue.basis || '' },
    value('xirr'), value('weight'), ...typed('targetAmount'), ...typed('targetWeight'), ...typed('pendingAmount'),
    ...typed('intrinsicValue'), ...typed('methodology'), ...typed('reference'), value('upside'), value('expectedIrr'),
    { header: 'Statement', key: 'stmt', width: 50, get: (r) => (r.statement ? `${r.statement.where}, statement of ${r.statement.asOf}` : r.kind === 'manual' ? 'Added by hand' : '') },
  ];
}

function exportPortfolio(visible) {
  const columns = portfolioExportColumns();
  const banner = `Glow Central Research · Portfolio (public direct, PMS excluded) · exported ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST. `
    + 'CMP, market cap, returns, current value, TSR, alpha, XIRR, weight and upside are derived at export time from the minute price capture and the Nifty 500; '
    + 'typed values are the desk\'s, and defaults come from the family\'s statements or the formula named in the column. Percentages are in percent; ₹ Cr columns are in crore.';
  void exportSheets({ filename: `glow-portfolio-${todayStamp()}`, banner, sheets: [{ name: 'Portfolio', columns, rows: visible }],
    prepareWorkbook: (wb) => addSheetBaseline(wb, { kind: 'Portfolio', columns, rows: visible }) });
}

// ---- painting ------------------------------------------------------------------------------

function cleanup() {
  fill?.dispose(); fill = null;
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
  if (fill?.active()) return; // Keep the selected row order and pointer target stable until release.
  const rows = portfolioRows();
  rowsNow = rows;
  if (table && tableRoot === ctx.root && ctx.root.querySelector('[data-score-table]')) {
    // A live price or a typed value landed on the mounted table: swap the rows in place so the
    // reader's search, sort and scroll position are untouched.
    table.updateData(rows);
    const head = ctx.root.querySelector('[data-portfolio-head-meta]');
    if (head) head.innerHTML = sheetStatusPill();
    return;
  }
  releaseTable?.();
  fill?.dispose();
  table = scoreTable(tableConfig(rows));
  tableRoot = ctx.root;
  ctx.root.innerHTML = `
    <div class="fade-in" data-sheet-tab="portfolio">
      ${sectionHead({ title: 'Portfolio', compact: true, meta: `<div data-portfolio-head-meta>${sheetStatusPill()}</div>` })}
      <div data-sheet-table="portfolio">${table.html}</div>
      ${footerHtml()}
    </div>`;
  releaseTable = table.wire(ctx.root);
  fill = wireSheetFill(ctx.root, { viewRows: () => table.visibleRows(), liveRows: portfolioRows,
    closeEditor: () => closeCellEditor({ restoreFocus: false }), onEnd: schedule });
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
      label: field === 'name' ? 'Name of company' : HEAD[field],
      format: (v) => formatField(field, v),
      onSave: (v, by) => sheet.set(key, field, v, by),
      onClear: (by) => sheet.clear(key, field, by),
    });
    return;
  }
  const removeButton = event.target.closest('[data-sheet-remove]');
  if (removeButton) {
    const row = rowsNow.find((r) => r.key === removeButton.dataset.sheetRemove);
    if (row && window.confirm(`Remove ${company(row)} from the portfolio sheet? Its typed values are kept.`)) sheet.removeRow(row.key);
    return;
  }
  if (event.target.closest('[data-portfolio-add]')) { openAddHolding(); return; }
  if (event.target.closest('[data-sheet-how]')) openModal(sheetHowModal('portfolio'), { size: 'wide' });
}

// ---- adding a holding the statements do not carry yet --------------------------------------

function localCompanies() {
  const out = new Map();
  for (const row of technicals.isLoaded() ? technicals.all() : []) {
    const c = row.company || {};
    if (c.ticker) out.set(c.ticker.toUpperCase(), { ticker: c.ticker.toUpperCase(), name: c.name || c.ticker, industry: c.industry || c.sector || null });
  }
  for (const h of coverage.holdings()) if (h.ticker && !out.has(h.ticker.toUpperCase())) out.set(h.ticker.toUpperCase(), { ticker: h.ticker.toUpperCase(), name: h.name, industry: h.sector || null });
  return [...out.values()];
}

function openAddHolding() {
  closeCellEditor({ restoreFocus: false });
  openModal(companySearchHtml({ id: 'portfolio-add', title: 'Add a holding' }), { size: 'wide' });
  const root = document.querySelector('[data-company-search="portfolio-add"]');
  if (!root) return;
  const input = root.querySelector('[data-company-search-input]');
  const box = root.querySelector('[data-company-search-results]');
  const by = root.querySelector('[data-company-search-by]');
  let results = [];
  let timer = null;
  let abort = null;
  const held = () => new Set(rowsNow.map((r) => r.key));
  const paintResults = (note = '') => {
    const have = held();
    box.innerHTML = note || (results.length
      ? results.map((r, i) => `<button type="button" data-company-result="${i}" ${have.has(r.ticker) ? 'disabled' : ''}
          class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
          <span class="min-w-0"><span class="block truncate text-sm font-semibold text-slate-800">${escapeHtml(r.name || r.ticker)}</span>
          <span class="block truncate text-[11px] text-slate-400">${escapeHtml([r.ticker, r.industry].filter(Boolean).join(' · '))}</span></span>
          <span class="shrink-0 text-xs font-bold text-indigo-600">${have.has(r.ticker) ? 'Already on the sheet' : 'Add'}</span></button>`).join('')
      : '<div class="px-3 py-4 text-center text-sm text-slate-400">No matching company.</div>');
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    abort?.abort();
    const q = input.value.trim();
    if (q.length < 2) { results = []; box.innerHTML = ''; return; }
    const needle = q.toLowerCase();
    const local = localCompanies().filter((c) => `${c.ticker} ${c.name}`.toLowerCase().includes(needle)).slice(0, 12);
    results = local;
    paintResults();
    timer = setTimeout(async () => {
      abort = new AbortController();
      try {
        const remote = await searchCompanies(q, { signal: abort.signal });
        if (input.value.trim() !== q) return;
        const merged = new Map(local.map((c) => [c.ticker, c]));
        for (const r of remote) {
          const ticker = sheetKey(r.ticker);
          if (!ticker || r.validTicker === false || (r.country && !/^india$/i.test(r.country))) continue;
          if (!merged.has(ticker)) merged.set(ticker, { ticker, name: r.name || ticker, industry: r.industry || null });
        }
        results = [...merged.values()].slice(0, 20);
        paintResults();
      } catch { /* the local matches stay; the remote search is a supplement */ }
    }, 250);
  });
  box.addEventListener('click', (event) => {
    const button = event.target.closest('[data-company-result]');
    if (!button || button.disabled) return;
    const chosen = results[Number(button.dataset.companyResult)];
    const key = sheetKey(chosen?.ticker);
    if (!key) return;
    try {
      sheet.addRow(key, chosen.name || key, by.value.trim() || null);
    } catch (error) {
      paintResults(`<div class="px-3 py-4 text-sm text-rose-600">${escapeHtml(error?.message || 'Could not add this company.')}</div>`);
      return;
    }
    closeModal();
  });
  input.focus();
}

// ---- the module contract ---------------------------------------------------------------------

export function render(ctx) {
  ctxRef = ctx;
  cleanup();
  ctx.root.innerHTML = `<div class="rounded-2xl bg-white p-8 text-center text-sm text-slate-400 shadow-sm ring-1 ring-slate-100" data-portfolio-loading>Reading the family's statements and today's prices…</div>`;
  ctx.root.addEventListener('click', onRootClick);
  releaseRoot = () => ctx.root.removeEventListener('click', onRootClick);
  disposers.push(sheet.start());
  disposers.push(sheet.onChange(schedule));
  disposers.push(market.watch(schedule));
  disposers.push(coverage.onChange(schedule));
  Promise.allSettled([book.load(), market.load()]).then(([bookRead]) => {
    if (ctxRef !== ctx) return;
    if (bookRead.status === 'rejected' && !book.isLoaded()) {
      ctx.root.innerHTML = `<div class="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-100">
        <div class="text-sm font-semibold text-slate-700">The family's statement book could not be read.</div>
        <div class="mt-1 text-xs text-slate-500">${escapeHtml(bookRead.reason?.message || 'Unavailable')} — reload to try again. Holdings added by hand are still kept.</div></div>`;
      return;
    }
    paint(ctx);
  });
}

export function destroy() {
  closeCellEditor({ restoreFocus: false });
  cleanup();
  ctxRef = null;
  rowsNow = [];
}

/** For the browser suite: the rows as last painted. */
export const _rows = () => rowsNow;
export const _editorOpen = () => isEditorOpen();
