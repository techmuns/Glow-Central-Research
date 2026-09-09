// GLOW: one audience and period control, dated activity first, holdings evidence below it.
import { tabBar } from '../ui/components.js';
import { scoreTable, openModal, closeModal } from '../ui/screener.js';
import { escapeHtml as esc } from '../core/dom.js';
import { formatDate, formatNumber, formatCroreCompact } from '../core/format.js';
import * as managers from '../data/managers.js';
import * as investors from '../data/super-investors.js';
import { insider } from '../data/filings.js';
import { insiderTradeSourceUrl } from '../data/filings-shared.js';
import * as watchlist from '../core/watchlist.js';
import { scopeAllowsTicker } from '../data/scope.js';
import { openManager } from './my-managers.js';
import { exportRows } from '../ui/export.js';
import { PERIODS, periodRange, inPeriod, matchedDeals, managerTrades, managerHoldings, investorHoldings } from '../data/investor-changes.js';

const audiences = [{ id: 'my-managers', label: 'My Managers' }, { id: 'investors', label: 'All Investors' }];
const date = (value) => value ? formatDate(value) : '—';
const num = (value) => value == null ? '—' : typeof value === 'number' ? formatNumber(value, { decimals: Number.isInteger(value) ? 0 : 2 }) : value;
const pp = (value) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)} pp`;
const money = (value) => Math.abs(value) >= 1e7 ? formatCroreCompact(Math.abs(value) / 1e7)
  : `₹${formatNumber(Math.abs(value), { decimals: 2 })}`;
const pct = (value) => value == null ? '—' : `${value.toFixed(2)}%`;
const actionLabels = { new: 'Newly reported', added: 'Increased', trimmed: 'Reduced', exited: 'No longer reported' };

export function renderChanges(ctx, { view = {}, onView = () => {}, openInvestor, includeHolding } = {}) {
  const state = { audience: 'my-managers', period: 'quarter', ...view };
  let host, disposed = false, ready = false, tableDisposers = [];
  function paint(focus = null) {
    if (disposed || !host?.isConnected) return;
    tableDisposers.forEach((d) => d?.());
    tableDisposers = [];
    const mine = state.audience === 'my-managers';
    const allManagers = managers.all(), list = investors.list();
    const people = mine ? allManagers.map((m) => ({ id: m.id, name: m.name,
      aliases: [m.house, list.find((i) => i.slug === m.finologySlug)?.name].filter(Boolean) }))
      : list.map((i) => ({ id: i.slug, name: i.name }));
    const allows = (row) => mine ? ctx.scope !== 'watchlist' || watchlist.has(row.ticker)
      : row.ticker ? scopeAllowsTicker(ctx.scope, row.ticker) : !includeHolding || includeHolding(row.company);
    const deals = matchedDeals(insider.rows(), people);
    const activity = [...(mine ? managerTrades(allManagers) : []), ...deals].filter(allows);
    const holdings = (mine ? managerHoldings(allManagers) : investorHoldings(investors.books(), list)).filter(allows);
    const range = periodRange(state.period);
    const events = activity.filter((r) => inPeriod(r, range)).sort((a, b) => b.date.localeCompare(a.date));
    const observations = holdings.filter((r) => inPeriod(r, range)).sort((a, b) => b.date.localeCompare(a.date));
    const tabs = tabBar({ tabs: audiences, activeId: state.audience, onSelect: (audience) => {
      state.audience = audience; state.activityView = null; state.holdingsView = null;
      onView(state); paint('audience');
    } });
    const openPerson = (row) => mine ? openManager(row.personId) : openInvestor?.(row.personId);
    const table = scoreTable({
      rows: events, key: (r) => r.id, name: (r) => r.company, sub: (r) => r.person,
      watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
      nameMaxPx: 220, showAvatar: false, dense: true, stickyHead: '400px', fillMode: 'scroll',
      searchable: (r) => `${r.company} ${r.person} ${r.reportedName || ''} ${r.source}`,
      searchPlaceholder: 'Search company or investor...',
      initialView: state.activityView,
      onExport: (rows) => exportChanges(rows, state, range, false),
      filters: [{ label: 'Direction', options: [{ value: 'all', label: 'All activity' }, { value: 'buy', label: 'Buys' }, { value: 'sell', label: 'Sells' }], match: (r, v) => r.action === v }],
      emptyMessage: ready ? 'No matching trades in the available records for this period.' : 'Loading statement trades and bulk/block deals…',
      onRowClick: (r) => openEvidence(r, mine, openPerson),
      columns: [
        { label: 'Action', html: true, get: (r) => `<span class="font-semibold ${r.action === 'buy' ? 'text-emerald-700' : 'text-rose-700'}">${r.action === 'buy' ? 'Bought' : 'Sold'}</span>` },
        { label: 'Date', get: (r) => date(r.date), sortValue: (r) => r.date },
        { label: 'Shares / units', get: (r) => num(r.quantity) },
        { label: 'Trade value', get: (r) => r.amount == null ? r.value || '—' : money(r.amount) },
        { label: 'Evidence', get: (r) => r.source },
      ],
    });
    state.activityView = table.view;
    const holdingTable = scoreTable({ rows: observations, key: (r) => r.id, name: (r) => r.company, sub: (r) => r.person,
      watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
      nameMaxPx: 280, dense: true, showAvatar: false, stickyHead: '360px', fillMode: 'scroll', initialView: state.holdingsView,
      searchable: (r) => `${r.company} ${r.person}`, onRowClick: openPerson,
      searchPlaceholder: 'Search company or investor...', showWatchFilter: false,
      onExport: (rows) => exportChanges(rows, state, range, true),
      emptyMessage: 'No holdings comparison ends in this period. Reports may arrive after the period ends.',
      columns: [
        { label: 'Comparison', get: (r) => r.period },
        { label: 'Change', get: (r) => actionLabels[r.action] || r.action },
        { label: mine ? 'Prior weight' : 'Prior stake', get: (r) => pct(r.before) },
        { label: mine ? 'Latest weight' : 'Latest stake', get: (r) => pct(r.now) },
        { label: 'Change (derived)', get: (r) => pp(r.deltaPp) },
      ],
    });
    state.holdingsView = holdingTable.view;
    onView(state);
    const dates = activity.map((r) => r.date).filter(Boolean).sort();
    const bulk = insider.meta().bulkDeals;
    const buys = events.filter((r) => r.action === 'buy').length;
    const sells = events.filter((r) => r.action === 'sell').length;
    const earliest = dates[0], latest = dates.at(-1);
    host.dataset.changesReady = String(ready);
    host.innerHTML = `
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div data-changes-audience>${tabs.html}</div>
        <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">Period
          <select data-changes-period aria-label="Changes period" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            ${PERIODS.map((p) => `<option value="${p.id}" ${p.id === state.period ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div role="tabpanel" aria-label="${mine ? 'My Managers changes' : 'All Investors changes'}" data-changes-panel="${state.audience}" data-activity-total="${events.length}" data-holdings-total="${observations.length}">
        ${ready && mine && !managers.meta() ? '<p class="mb-3 text-sm text-amber-700">Manager statements could not be loaded. The activity below may contain only matched public deals.</p>' : ''}
        <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-display text-lg font-bold text-slate-900">${mine ? 'Your managers' : 'Tracked investors'} · buys &amp; sells</h2>
          <span class="text-xs text-slate-500">${buys} buys · ${sells} sells · ${new Set(events.map((r) => r.personId)).size} ${mine ? 'managers' : 'investors'}</span>
        </div>
        <p class="mb-3 text-xs text-slate-500">${range.from ? `${esc(date(range.from))} – ${esc(date(range.to))}` : 'ITD · all available captured history'} · ${mine ? 'PMS statement trades and matched bulk/block deals' : 'Matched bulk/block deals'}. Click a row for evidence.</p>
        <div data-changes-activity>${table.html}</div>
        <p class="my-3 text-xs text-slate-500" data-changes-coverage>${ready ? (earliest ? `Matching trade records: ${esc(date(earliest))} – ${esc(date(latest))}. ` : 'No matching trade records loaded. ') : 'Loading source records. '}${mine ? 'PMS activity covers the family’s accounts; public deals are at the named manager/fund level. ' : ''}ITD covers retained records, not necessarily inception. Deals do not establish total allocation.</p>
        <details class="mb-4 rounded-2xl bg-white p-4 ring-1 ring-slate-100" data-changes-holdings ${state.holdingsOpen ? 'open' : ''}>
          <summary class="cursor-pointer text-sm font-semibold text-slate-700">Holdings changes · ${observations.length} comparisons in this period</summary>
          <p class="my-3 text-xs text-slate-500">Filtered by the comparison’s end date, not a trade date. ${mine ? 'The two latest PMS statements compare quantities; weights are derived from statement values.' : 'Quarterly disclosures compare the stake in a company. A missing disclosure does not prove a sale.'} These comparisons are separate from the trades above.</p>
          <div data-changes-observations>${holdingTable.html}</div>
        </details>
        <details class="text-xs text-slate-500" data-changes-sources>
          <summary class="cursor-pointer font-semibold">Sources &amp; coverage</summary>
          <div class="mt-2 space-y-2 leading-relaxed">
            <p>${mine ? `PMS holdings and transactions come from the manager statements in GlowVentures. Only two holdings statements per account are retained here; the transaction archive can cover a longer period. AIF/fund-house activity appears only where a public deal matches the reported legal name. Manager data as of ${esc(date(managers.meta()?.asOf))}.` : `Holdings come from Ticker Finology’s retained quarterly disclosures. Public trading between reports is visible only where a captured bulk/block deal matches a tracked investor’s name. ${investors.meta().failed || 0} investor books could not be read.`}</p>
            <p>Bulk/block deals reuse the Bulk/Block Deal tab’s records. Exact full-name matches allow punctuation and equivalent legal suffixes; ambiguous and unmatched names are excluded. ${bulk ? `Bulk/block source captured ${esc(date(bulk.capturedAt))}; ${bulk.rows} retained deal records. ${esc(bulk.error || '')}` : 'Bulk/block coverage metadata is unavailable.'} ${insider.meta().failed ? `${insider.meta().failed} company lookups could not be read.` : ''}</p>
            <a href="#/research/insider-trades" class="font-semibold text-indigo-600">Open Bulk/Block Deal →</a>
          </div>
        </details>
      </div>`;
    tableDisposers.push(tabs.wire(host.querySelector('[data-changes-audience]')),
      table.wire(host.querySelector('[data-changes-activity]')), holdingTable.wire(host.querySelector('[data-changes-observations]')));
    host.querySelector('[data-changes-period]').addEventListener('change', (e) => {
      state.period = e.target.value; onView(state); paint('period');
    });
    host.querySelector('[data-changes-holdings]').addEventListener('toggle', (e) => { state.holdingsOpen = e.target.open; onView(state); });
    if (focus) host.querySelector(focus === 'period' ? '[data-changes-period]' : '[data-changes-audience] [aria-selected="true"]')?.focus();
  }
  return { html: '<div data-investor-changes></div>', wire(root, disposers) {
    host = root.querySelector('[data-investor-changes]');
    const unsubscribe = insider.onChange(() => paint());
    disposers.push(() => { disposed = true; unsubscribe(); tableDisposers.forEach((d) => d?.()); });
    paint();
    Promise.all([managers.load(), insider.isLoaded() ? insider.refreshSnapshot() : insider.seed()]).then(() => { ready = true; paint(); });
  } };
}

function openEvidence(row, mine, openPerson) {
  const raw = row.raw;
  const fields = raw.cells || { Date: raw.date, Quantity: raw.quantity, 'Statement amount (₹)': raw.amount,
    'Statement document': raw.source, Account: raw.accountId, Owner: raw.owner };
  const source = raw.cells ? insiderTradeSourceUrl(raw) : null;
  openModal(`<div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
    <div class="mb-4 flex justify-between gap-3"><div><h2 class="font-display text-xl font-bold text-slate-900">${esc(row.company)}</h2><p class="text-sm text-slate-500">${esc(row.person)} · ${esc(row.source)}</p></div><button data-modal-close aria-label="Close" class="text-2xl text-slate-400">×</button></div>
    <p class="mb-4 text-xs text-slate-500">${mine && raw.cells ? 'This is the named entity’s public deal. It is not proof of a trade in the family’s PMS account.' : 'The source’s reported fields are shown below.'}${row.evidence?.length > 1 ? ` ${row.evidence.length} reports with identical trade details are shown as one activity row.` : ''}</p>
    <dl class="space-y-2 text-sm">${Object.entries(fields).map(([key, value]) => `<div><dt class="font-semibold text-slate-500">${esc(key)}</dt><dd class="text-slate-800">${esc(value == null || value === '' ? '—' : String(value))}</dd></div>`).join('')}</dl>
    <div class="mt-4 flex flex-wrap gap-4">${source ? (row.evidence || [raw]).map((e) => `<a href="${esc(insiderTradeSourceUrl(e))}" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-600">${esc(e.cells?.['Trade Category'] || 'Open source')} ↗</a>`).join('') : ''}<button data-change-person class="font-semibold text-indigo-600">Open ${mine ? 'manager' : 'investor'}</button></div>
  </div>`, { size: 'wide' });
  document.querySelector('#modal-content [data-change-person]')?.addEventListener('click', () => { closeModal(); openPerson(row); });
}

function exportChanges(rows, state, range, holdings) {
  const keys = holdings ? ['date', 'from', 'period', 'person', 'company', 'action', 'before', 'now', 'deltaPp', 'unit', 'source']
    : ['date', 'person', 'company', 'ticker', 'action', 'quantity', 'amount', 'value', 'source', 'reportedName'];
  return exportRows({ filename: `${state.audience}-${holdings ? 'holdings' : 'activity'}-${state.period}`, sheetName: holdings ? 'Holdings comparisons' : 'Trades',
    columns: [...keys.map((key) => ({ header: key === 'amount' ? 'Statement amount (INR)' : key, key, width: 24, get: (r) => r[key] ?? null })),
      { header: 'Evidence', key: 'evidence', width: 60, get: (r) => r.raw?.cells ? insiderTradeSourceUrl(r.raw) : r.raw?.source || r.period || '' },
      { header: 'Period and scope', key: 'periodNote', width: 70, get: () => `${state.audience}; ${range.from || 'All retained history'} to ${range.to}. ${holdings ? 'Comparison end dates; weights/stakes are derived observations, not trade sizes.' : 'Reported trades only; public deals are not family account trades. Duplicate identical reports grouped.'} ITD may not reach inception.` }], rows });
}
