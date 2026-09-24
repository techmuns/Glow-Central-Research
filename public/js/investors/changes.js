// Public exchange trades and dated quarterly observations are separate evidence.
import { scoreTable, openModal, closeModal } from '../ui/screener.js';
import { escapeHtml as esc } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import * as investors from '../data/super-investors.js';
import { insider } from '../data/filings.js';
import { insiderTradeSourceUrl } from '../data/filings-shared.js';
import { scopeAllowsTicker } from '../data/scope.js';
import { exportRows } from '../ui/export.js';
import { withVerifiedEntities } from '../data/holdings-integrity.js';
import { loadEvidence, evidence } from '../data/holding-evidence.js';
import { PERIODS, periodRange, inPeriod, matchedDeals, investorHoldings } from '../data/investor-changes.js';

const date = (value) => value ? formatDate(value) : '—';
const pct = (value) => value == null ? '—' : `${value.toFixed(2)}%`;
const pp = (value) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)} pp`;
const actions = { new: 'Newly disclosed', added: 'Increased', trimmed: 'Reduced', exited: 'No longer disclosed' };

export function renderChanges(ctx, { view = {}, onView = () => {}, openInvestor, includeHolding } = {}) {
  const state = { period: 'quarter', ...view };
  if (!PERIODS.some((p) => p.id === state.period)) state.period = 'quarter';
  let host, disposed = false, ready = false, tableDisposers = [];
  function remember() {
    for (const [selector, key] of [['sources', 'sourcesOpen'], ['holdings', 'holdingsOpen']]) {
      const item = host?.querySelector(`[data-changes-${selector}]`);
      if (item) state[key] = item.open;
    }
  }
  function paint(focus = false) {
    if (disposed || !host?.isConnected) return;
    remember(); tableDisposers.forEach((d) => d?.()); tableDisposers = [];
    const list = investors.list();
    const people = withVerifiedEntities(list.map((i) => ({ id: i.slug, name: i.name })), evidence(), 'investor');
    const allows = (r) => r.ticker ? scopeAllowsTicker(ctx.scope, r.ticker) : !includeHolding || includeHolding(r.company, r);
    const activity = matchedDeals(insider.rows(), people).filter(allows);
    const range = periodRange(state.period);
    const events = activity.filter((r) => inPeriod(r, range)).sort((a, b) => b.date.localeCompare(a.date));
    const observations = investorHoldings(investors.books(), list).filter(allows).filter((r) => inPeriod(r, range)).sort((a, b) => b.date.localeCompare(a.date));
    const openPerson = (r) => openInvestor?.(r.personId);
    const table = scoreTable({ rows: events, key: (r) => r.id, name: (r) => r.company,
      sub: (r) => r.reportedName?.toLowerCase() !== r.person.toLowerCase() ? `${r.person} · reported: ${r.reportedName}` : r.person,
      watchKey: (r) => r.ticker || null, watchName: (r) => r.company,
      nameMaxPx: 240, showAvatar: false, dense: true, stickyHead: '400px', fillMode: 'scroll',
      searchable: (r) => `${r.company} ${r.person} ${r.reportedName || ''} ${r.source}`,
      searchPlaceholder: 'Search company or investor...', initialView: state.activityView,
      onExport: (rows) => exportChanges(rows, state, range, false, ctx.scope),
      filters: [{ label: 'Direction', options: [{ value: 'all', label: 'All activity' }, { value: 'buy', label: 'Buys' }, { value: 'sell', label: 'Sells' }], match: (r, v) => r.action === v }],
      emptyMessage: ready ? 'No matching trades in the available records for this period.' : 'Loading captured bulk/block deals…',
      onRowClick: (r) => openEvidence(r, openPerson),
      columns: [
        { label: 'Action', get: (r) => r.action === 'buy' ? 'Bought' : 'Sold' },
        { label: 'Trade date', get: (r) => date(r.date), sortValue: (r) => r.date },
        { label: 'Shares', get: (r) => r.quantity || '—' },
        { label: 'Reported value', get: (r) => r.value || '—' },
        { label: 'Evidence', get: (r) => r.source },
      ],
    });
    state.activityView = table.view;
    const holdingTable = scoreTable({ rows: observations, key: (r) => r.id, name: (r) => r.company, sub: (r) => r.person,
      watchKey: (r) => r.ticker || null, watchName: (r) => r.company, nameMaxPx: 260,
      dense: true, showAvatar: false, stickyHead: '360px', fillMode: 'scroll', initialView: state.holdingsView,
      searchable: (r) => `${r.company} ${r.person}`, onRowClick: openPerson,
      searchPlaceholder: 'Search company or investor...', showWatchFilter: false,
      onExport: (rows) => exportChanges(rows, state, range, true, ctx.scope),
      emptyMessage: 'No confirmed holdings change ends in this period. Reports may arrive after the period ends.',
      columns: [
        { label: 'Pattern dates', get: (r) => `${date(r.from)} → ${date(r.date)}`, sortValue: (r) => r.date },
        { label: 'Change', get: (r) => actions[r.action] || r.action },
        { label: 'Prior stake', get: (r) => pct(r.before) },
        { label: 'Latest stake', get: (r) => pct(r.now) },
        { label: 'Change (derived)', get: (r) => pp(r.deltaPp) },
        { label: 'Source checked', get: (r) => date(r.sourceCheckedAt), sortValue: (r) => r.sourceCheckedAt || '' },
      ],
    });
    state.holdingsView = holdingTable.view; onView(state);
    const meta = insider.meta(), exchanges = meta.exchanges;
    const dates = activity.map((r) => r.date).filter(Boolean).sort();
    host.dataset.changesReady = String(ready);
    host.innerHTML = `
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-display text-lg font-bold text-slate-900">Tracked investors · reported trades</h2>
        <label class="flex items-center gap-2 text-xs font-semibold text-slate-500">Period
          <select data-changes-period aria-label="Changes period" class="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            ${PERIODS.map((p) => `<option value="${p.id}" ${p.id === state.period ? 'selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </label>
      </div>
      <div data-changes-panel="investors" data-activity-total="${events.length}" data-holdings-total="${observations.length}">
        <p class="mb-3 text-xs text-slate-500">${range.from ? `${esc(date(range.from))} – ${esc(date(range.to))}` : 'ITD · all available captured history'} · matched public bulk/block deals. Click a row for evidence.</p>
        <p class="mb-3 text-xs text-slate-500" data-exchange-status>${esc(exchanges?.summary || (ready ? 'Exchange coverage has not been verified.' : 'NSE / BSE reports are loading.'))}</p>
        <div data-changes-activity>${table.html}</div>
        <p class="my-3 text-xs text-slate-500" data-changes-coverage>${ready ? dates.length ? `Matching retained records: ${esc(date(dates[0]))} – ${esc(date(dates.at(-1)))}. ` : 'No matching trade records loaded. ' : 'Loading source records. '}ITD covers retained records and may not reach inception. Deals do not establish total allocation.</p>
        <details class="mb-4 rounded-2xl bg-white p-4 ring-1 ring-slate-100" data-changes-holdings ${state.holdingsOpen ? 'open' : ''}>
          <summary class="cursor-pointer text-sm font-semibold text-slate-700">Holdings changes · ${observations.length} dated comparisons</summary>
          <p class="my-3 text-xs text-slate-500">Both quarter-end dates are shown. The period filter uses the later date; these are holdings observations, not trade dates. A missing or unavailable disclosure does not prove a purchase or sale. Unknown comparisons remain in the holding book and coverage review.</p>
          <div data-changes-observations>${holdingTable.html}</div>
        </details>
        <details class="text-xs text-slate-500" data-changes-sources ${state.sourcesOpen ? 'open' : ''}>
          <summary class="cursor-pointer font-semibold">Sources &amp; coverage</summary>
          <div class="mt-2 space-y-2 leading-relaxed">
            <p>Holdings come from Ticker Finology’s retained quarterly disclosures. ${investors.meta().failedBooks || 0} investor books could not be read. Public deals are matched by exact full name, allowing punctuation and equivalent legal suffixes. Associated entities require a current, evidenced relationship; ambiguous names remain unmatched.</p>
            <p>Bulk/block deals share the captured NSE/BSE and supplementary Screener records with Insider Trades. This view rechecks saved captures every minute while visible. A successful delivery does not establish complete exchange coverage. ${esc(meta.bulkDeals?.error || '')}</p>
            ${exchanges ? `<ul>${(exchanges.sources || []).map((s) => `<li>${esc(s.id.toUpperCase())}: ${(s.coverage || []).map((w) => `${esc(date(w.from))} – ${esc(date(w.to))}`).join(', ') || 'No successful capture'} · ${s.ok ? 'read successfully' : esc(s.error || 'unavailable')}; latest reported deal ${esc(date(s.latestDate))}.</li>`).join('')}</ul>` : ''}
            <p>Identical reports are grouped only within the same exchange and report type. NSE and BSE, and buy and sell sides, stay separate. An estimated exchange trade value is quantity × reported weighted average price.</p>
            <a href="#/research/insider-trades" class="font-semibold text-indigo-600">Open Insider Trades →</a>
          </div>
        </details>
      </div>`;
    tableDisposers.push(table.wire(host.querySelector('[data-changes-activity]')), holdingTable.wire(host.querySelector('[data-changes-observations]')));
    host.querySelector('[data-changes-period]').addEventListener('change', (e) => { state.period = e.target.value; onView(state); paint(true); });
    host.querySelectorAll('[data-changes-holdings], [data-changes-sources]').forEach((el) => el.addEventListener('toggle', () => { if (!disposed && el.isConnected) { remember(); onView(state); } }));
    if (focus) host.querySelector('[data-changes-period]')?.focus();
  }
  return { html: '<div data-investor-changes></div>', wire(root, disposers) {
    host = root.querySelector('[data-investor-changes]');
    const unsubscribe = insider.onChange(() => paint());
    let pending = false;
    async function refresh() {
      if (pending || disposed || document.hidden) return;
      pending = true;
      try { await Promise.all([loadEvidence(), insider.isLoaded() ? insider.refreshSnapshot() : insider.seed()]); }
      finally { pending = false; ready = true; paint(); }
    }
    const onVisible = () => { if (!document.hidden) refresh().catch(() => {}); };
    const timer = setInterval(onVisible, 60000);
    document.addEventListener('visibilitychange', onVisible); window.addEventListener('focus', onVisible);
    disposers.push(() => { remember(); disposed = true; unsubscribe(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); tableDisposers.forEach((d) => d?.()); });
    paint(); refresh().catch(() => {});
  } };
}

function openEvidence(row, openPerson) {
  const raw = row.raw;
  openModal(`<div class="scrollbar-thin max-h-[80vh] overflow-y-auto px-7 py-6">
    <div class="mb-4 flex justify-between gap-3"><div><h2 class="font-display text-xl font-bold text-slate-900">${esc(row.company)}</h2><p class="text-sm text-slate-500">${esc(row.person)} · ${esc(row.source)}</p></div><button data-modal-close aria-label="Close" class="text-2xl text-slate-400">×</button></div>
    <p class="mb-4 text-xs text-slate-500">The source’s reported fields are shown below.${row.evidence.length > 1 ? ` ${row.evidence.length} identical reports are grouped in this row.` : ''}</p>
    <dl class="space-y-2 text-sm">${Object.entries(raw.cells || {}).map(([key, value]) => `<div><dt class="font-semibold text-slate-500">${esc(key)}</dt><dd class="text-slate-800">${esc(value == null || value === '' ? '—' : String(value))}</dd></div>`).join('')}</dl>
    <div class="mt-4 flex flex-wrap gap-4">${row.evidence.map((e) => `<a href="${esc(insiderTradeSourceUrl(e))}" target="_blank" rel="noopener noreferrer" class="font-semibold text-indigo-600">${esc(e.cells?.['Trade Category'] || 'Open source')} ↗</a>`).join('')}<button data-change-person class="font-semibold text-indigo-600">Open investor</button></div>
  </div>`, { size: 'wide' });
  document.querySelector('#modal-content [data-change-person]')?.addEventListener('click', () => { closeModal(); openPerson(row); });
}

function exportChanges(rows, state, range, holdings, scope) {
  const keys = holdings ? ['from', 'date', 'period', 'person', 'company', 'action', 'before', 'now', 'deltaPp', 'unit', 'source', 'sourceCheckedAt']
    : ['date', 'person', 'company', 'ticker', 'action', 'quantity', 'value', 'source', 'reportedName'];
  const headers = { from: 'Prior quarter end', date: holdings ? 'Latest quarter end' : 'Trade date', deltaPp: 'Change (percentage points)', sourceCheckedAt: 'Source checked' };
  return exportRows({ filename: `sattva-investors-${holdings ? 'holdings' : 'activity'}-${state.period}`, sheetName: holdings ? 'Holdings comparisons' : 'Trades',
    columns: [...keys.map((key) => ({ header: headers[key] || key, key, width: 24, get: (r) => r[key] ?? null })),
      { header: 'Evidence', key: 'evidence', width: 60, get: (r) => r.raw?.cells ? insiderTradeSourceUrl(r.raw) : `https://ticker.finology.in/investor/${encodeURIComponent(r.personId)}` },
      { header: 'Period and scope', key: 'periodNote', width: 70, get: () => `${scope}; ${range.from || 'All retained history'} to ${range.to}. ${holdings ? 'Measured on the two quarter ends; changes in disclosed stakes do not establish trades.' : 'Reported public deals; identical reports grouped within exchange/category.'} ITD may not reach inception.` }], rows });
}
