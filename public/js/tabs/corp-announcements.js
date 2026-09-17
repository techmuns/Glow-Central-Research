// tabs/corp-announcements.js — ONE TAB, TWO VIEWS: Announcements and Corporate Actions.
//
// The Announcements view is a continuous, scoped stream of source announcements. BSE date captures,
// live NSE filings and retained Muns company documents share one table and keep their source labels.
// Captured history loads automatically; publication and capture gaps remain in provenance.
//
// CORPORATE ACTIONS USED TO BE A TAB OF ITS OWN, beside this one in the bar. Both are exchange
// filings about the same companies, read the same way — a dated list, filtered, linked out to the
// source — and two adjacent top-level tabs that differ only in which kind of filing they list is
// the sub-view picker's job, not the tab bar's. So `tabs/corporate-actions.js` is now the second
// view of this tab, unchanged inside: its feed, its columns, its provenance and its export are all
// still its own, and `scripts/verify-corporate-actions-ui.mjs` still drives that module directly.
//
// `render()` dispatches on `ctx.subview` exactly as News dispatches on the scope: the view that is
// leaving is torn down BEFORE the other mounts, because `destroy()` is only called when the reader
// leaves the tab entirely — too late to stop an unmounted view's subscription repainting into a
// root that now belongs to the other feed. An old `#/research/corporate-actions` link still lands
// on that view; the shell aliases the retired tab id (see LEGACY_TABS in js/ui/shell.js).

import { escapeHtml } from '../core/dom.js';
import { formatDate, formatNumber } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { corporateAnnouncements as feed } from '../data/corporate-announcements.js';
import * as corporateActions from './corporate-actions.js';
import { announcementSources, announcementSourceUrls } from '../data/announcements-shared.js';
import { captureCoverageHtml } from '../ui/capture-coverage.js';
import { classifyStory, groupLabel } from '../data/news-keywords.js';
import { newsDay, newsPeriodBounds, inNewsWindow } from '../data/news-window.js';
import {
  ANNOUNCEMENT_TYPES, announcementTypeOf, countTypes, loadHiddenTypes, saveHiddenTypes,
  isDefaultSelection, DEFAULT_HIDDEN_TYPES, typeLabel,
} from '../data/announcement-types.js';

const ANNOUNCEMENT_PERIODS = [
  { value: 'today', label: 'Today' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' },
];

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// Existing committed captures may predate the upstream normaliser fix. Clean on read as well so a
// deploy repairs visible `<BR><BR>` immediately, without waiting for the next scheduled capture.
export const cleanFilingText = (value) => String(value || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Topic labels use the same subject/sub-category keyword reading as the other news views.
// They do not summarize or score the underlying documents.
const readings = new WeakMap();
function readingFor(row) {
  let reading = readings.get(row);
  if (!reading) {
    reading = classifyStory({ title: cleanFilingText(row.title || row.headline), summary: row.subCategory || '' });
    readings.set(row, reading);
  }
  return reading;
}

// ---------------------------------------------------------------------------------------
// FILING TYPES — the multi-select that keeps routine filings out of the way.
//
// The desk's complaint was exact: "somebody has lost their physical shares, so the company has to
// upload a document saying that we have been converting physical shares into demat" — and that is
// one filing among 981 newspaper copies and 436 NAV declarations in the retained stream. So every
// row carries one TYPE (js/data/announcement-types.js: read from the exchange's own sub-category or
// subject, never from the document), the chip row above the table switches types on and off, and
// the choice is remembered on this device. Routine & administrative starts switched off.
//
// THE FILTER IS A TABLE FILTER. It is the second entry in `filters`, marked `hidden` so the kit draws
// no <select> for it: the chips are its control, and they re-apply it by dispatching `change` on the
// hidden slot. That is what lets the count label, the empty message, search and the export all read
// one predicate rather than a chip row that agrees with the table on most days.
//
// THE HIDING IS VISIBLE. A switched-off chip still prints its count for the selected period, the
// note beside the chips says how many rows the selection hides, and Reset appears whenever the
// selection differs from the default — a control that makes rows disappear with nothing on screen
// saying so is indistinguishable from a broken feed.
// ---------------------------------------------------------------------------------------
const TYPE_FILTER_VALUE = 'selected';
let hiddenTypes = loadHiddenTypes();
let lastScopedRows = null;
const typeReadings = new WeakMap();
function typeOf(row) {
  let reading = typeReadings.get(row);
  if (!reading) {
    reading = announcementTypeOf(row);
    typeReadings.set(row, reading);
  }
  return reading;
}
const periodLabelOf = (period) => ANNOUNCEMENT_PERIODS.find((p) => p.value === period)?.label || 'All time';
function periodKeep(period) {
  if (!period || period === 'all') return null;
  const bounds = newsPeriodBounds(period);
  return (row) => inNewsWindow(row, bounds);
}
const FROM_WORDS = {
  'sub-category': "the exchange's own sub-category",
  subject: "the filing's subject line",
  description: "NSE's description of the filing",
  category: "BSE's category",
};
function typeTitle(t) {
  const read = t.from
    ? `Read from ${FROM_WORDS[t.from]}: “${t.text}”.`
    : 'No rule matched the exchange’s label or the subject line, so it is listed as Other updates.';
  return `Type (derived): ${t.label}. ${read} No document was opened.`;
}
const hiddenNote = (n, period) => n
  ? `${formatNumber(n)} ${n === 1 ? 'filing' : 'filings'} hidden by the types switched off (${periodLabelOf(period).toLowerCase()})`
  : `Nothing hidden (${periodLabelOf(period).toLowerCase()})`;
const typeChip = (t, on, n) =>
  `<button type="button" role="switch" aria-checked="${on}" data-announcement-type="${escapeHtml(t.id)}"
     title="${escapeHtml(`${t.hint} ${on ? 'Shown — click to hide.' : 'Hidden — click to show.'} The count is for the selected period in this scope, before search.`)}"
     class="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${
       on ? 'bg-indigo-50 text-indigo-800 ring-indigo-200' : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'
     }">${escapeHtml(t.label)} <span data-announcement-type-count class="tabular-nums ${on ? 'text-indigo-600' : 'text-slate-400'}">${formatNumber(n)}</span></button>`;
function typeChipsHtml(rows, period) {
  if (!rows) return '';
  lastScopedRows = rows;
  const counts = countTypes(rows, periodKeep(period), typeOf);
  const hidden = [...hiddenTypes].reduce((sum, id) => sum + (counts.get(id) || 0), 0);
  return `<div data-announcement-types class="mb-3 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-slate-100">
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[10px] font-bold uppercase tracking-wide text-slate-400" title="Filing types, read from the exchange's own labels. Switch a type off to hide it; the choice is remembered on this device.">Show</span>
      ${ANNOUNCEMENT_TYPES.map((t) => typeChip(t, !hiddenTypes.has(t.id), counts.get(t.id) || 0)).join('')}
      <span class="ml-auto inline-flex items-center gap-2 text-xs text-slate-500">
        <span data-announcement-hidden-count>${escapeHtml(hiddenNote(hidden, period))}</span>
        ${isDefaultSelection(hiddenTypes) ? '' : '<button type="button" data-announcement-types-reset class="font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-800" title="Show every type except Routine & administrative">Reset</button>'}
      </span>
    </div>
  </div>`;
}
function wireTypeChips(root) {
  if (!root.querySelector('[data-announcement-types]')) return null;
  const periodEl = root.querySelector('[data-table-filter="0"]');
  const currentPeriod = () => periodEl?.value || 'all';
  const redraw = () => {
    const box = root.querySelector('[data-announcement-types]');
    if (box) box.outerHTML = typeChipsHtml(lastScopedRows || [], currentPeriod());
  };
  const onClick = (e) => {
    const reset = e.target.closest('[data-announcement-types-reset]');
    const chip = e.target.closest('[data-announcement-type]');
    if (!reset && !chip) return;
    if (!root.contains(reset || chip)) return;
    if (reset) hiddenTypes = new Set(DEFAULT_HIDDEN_TYPES);
    else if (hiddenTypes.has(chip.dataset.announcementType)) hiddenTypes.delete(chip.dataset.announcementType);
    else hiddenTypes.add(chip.dataset.announcementType);
    saveHiddenTypes(hiddenTypes);
    redraw();
    // The chips are the control; the hidden slot is the filter. Re-apply it through the table's own
    // change path so search, counts, the empty message and the export all move together.
    root.querySelector('[data-table-filter-hidden]')?.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Delegated on the content host: the chip row is replaced wholesale on every toggle.
  root.addEventListener('click', onClick);
  periodEl?.addEventListener('change', redraw);
  return () => {
    root.removeEventListener('click', onClick);
    periodEl?.removeEventListener('change', redraw);
  };
}

// Category is identity, not judgement, so the palette is the brand ramp rather than anything
// semantic — an AGM notice is not "worse" than a result. `Result` and `Board Meeting` get the two
// strongest tints only because they are what a reader scans for.
const CATEGORY_STYLE = {
  Result: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  'Board Meeting': 'bg-purple-50 text-purple-700 ring-purple-200',
  'Corp. Action': 'bg-pink-50 text-pink-700 ring-pink-200',
  'Company Update': 'bg-slate-100 text-slate-600 ring-slate-200',
  'AGM/EGM': 'bg-slate-100 text-slate-600 ring-slate-200',
  'New Listing': 'bg-slate-100 text-slate-600 ring-slate-200',
};
const categoryBadge = (c) => {
  if (!c) return dash('the filing was not categorised');
  const cls = CATEGORY_STYLE[c] || 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(String(c))}</span>`;
};

const announcements = makeFilingsTab({
  id: 'corp-announcements',
  title: 'Corp Announcements',
  subtitle:
    'The latest company announcements from BSE, NSE and captured filings, newest first.',
  feed,
  filterByScope: feed.filterByScope,
  countLabel: (rows) => {
    const companies = new Set(rows.map(r => r.isin || r.ticker || r.company).filter(Boolean)).size;
    return `${formatNumber(rows.length)} ${rows.length === 1 ? 'announcement' : 'announcements'} · ${formatNumber(companies)} ${companies === 1 ? 'company' : 'companies'} with filings`;
  },
  showWatchFilter: false,
  fillMode: 'auto',
  preserveReadingPosition: true,
  renderRevision: () => newsDay(),
  filters: () => {
    // Bounds are computed once per paint, not once per historical filing. The day revision
    // also reapplies the period on an unchanged source refresh after midnight in IST.
    const windows = Object.fromEntries(ANNOUNCEMENT_PERIODS.filter(p => p.value !== 'all')
      .map(p => [p.value, newsPeriodBounds(p.value)]));
    return [
      {
        label: 'Announcement period (IST)', value: 'all', options: ANNOUNCEMENT_PERIODS,
        match: (row, period) => period === 'all' || inNewsWindow(row, windows[period]),
      },
      // The filing-type multi-select. `hidden`: the chip row above the table is its control.
      {
        hidden: true, label: 'Filing types', value: TYPE_FILTER_VALUE,
        options: [{ value: TYPE_FILTER_VALUE, label: 'Filing types' }],
        match: (row) => !hiddenTypes.has(typeOf(row).id),
      },
    ];
  },
  aboveTable: (ctx, m, rows, view) => typeChipsHtml(rows, view?.filters?.[0] || 'all'),
  wireAboveTable: (root) => wireTypeChips(root),
  status: () => '<span data-filings-info class="text-xs font-semibold text-slate-500">Updates automatically</span>',
  emptyMessage: 'No captured announcements match this scope, period or search.',
  stickyHead: 'max(320px, calc(100vh - 260px))',
  noun: 'announcements',
  nameLabel: 'Subject',
  nameMaxPx: 520,
  rowName: (r) => cleanFilingText(r.title || r.headline) || '(no subject)',
  // The company name leads, because a date-indexed feed covers companies this dashboard has no
  // ticker for and a bare scrip code identifies nothing to a reader.
  rowSub: (r) => [r.company, r.ticker, r.subCategory].filter(Boolean).join(' · '),
  searchable: (r) =>
    `${cleanFilingText(r.title)} ${cleanFilingText(r.headline)} ${cleanFilingText(r.subject)} ${r.company || ''} ${r.ticker || ''} ${r.scripCode || ''} ${r.category || ''} ${r.subCategory || ''} ${typeOf(r).label}`,
  columns: () => [
    { label: 'Source', get: (r) => announcementSources(r).join(' / ') || 'Not specified' },
    {
      label: 'Date',
      get: (r) =>
        r.date
          ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}${r.time ? `<span class="ml-1 text-[10px] text-slate-400">${escapeHtml(r.time.slice(0, 5))}</span>` : ''}</span>`
          : dash('the filing carried no readable date'),
      html: true,
      // A filing with no readable date sorts last rather than first. It is never today's.
      sortValue: (r) => `${r.date || ''}${r.time || ''}`,
    },
    {
      label: 'Category',
      get: (r) => categoryBadge(r.category),
      html: true,
      sortValue: (r) => r.category || '',
    },
    {
      // THE TYPE IS DERIVED AND SAYS SO ON HOVER. Category above is the exchange's own word and stays
      // untouched (NSE rows carry none, so it reads as a dash there); Type is this dashboard's reading
      // of that word or of the subject line, and its tooltip names which — never a claim about the
      // document. Routine rows are muted because they are the ones the reader chose to see anyway.
      label: 'Type',
      get: (r) => {
        const t = typeOf(r);
        return `<span class="whitespace-nowrap text-xs ${t.routine ? 'text-slate-400' : 'text-slate-600'}" title="${escapeHtml(typeTitle(t))}">${escapeHtml(t.label)}</span>`;
      },
      html: true,
      sortValue: (r) => typeOf(r).label,
    },
    {
      // THE TOPIC COLUMN TOOK THE SUB-CATEGORY COLUMN'S PLACE, for the reason the News tab's took
      // the Outlet column's: `rowSub` already prints the sub-category under every subject, so the
      // column was a second copy of it — and this table's subject line is capped at 520px, which is
      // where two different filings start truncating to the same string. The sub-category keeps its
      // place in the export; what it gives up is a column that said nothing new.
      label: 'Topic',
      get: (r) => {
        const reading = readingFor(r);
        if (!reading.tracked) {
          return `<span class="text-slate-300" title="No tracked keyword matched this filing's subject or BSE's sub-category for it. Most filings are routine — the whole exchange files roughly 900 a weekday.">untracked</span>`;
        }
        const CHIPS = 2;
        const shown = reading.keywords.slice(0, CHIPS);
        const rest = reading.keywords.length - shown.length;
        const chip = (k) =>
          `<span class="mr-1 inline-block whitespace-nowrap rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700 ring-1 ring-indigo-100" title="${escapeHtml(
            `${groupLabel(k.group)} · matched in the ${k.where === 'title' ? "filing's subject" : "exchange's sub-category"}${k.note ? `. ${k.note}` : ''}`
          )}">${escapeHtml(k.label)}</span>`;
        const more = rest
          ? `<span class="text-[10px] font-semibold text-slate-400" title="${escapeHtml(`Also: ${reading.labels.slice(CHIPS).join(', ')}`)}">+${rest}</span>`
          : '';
        return shown.map(chip).join('') + more;
      },
      html: true,
      sortValue: (r) => {
        const reading = readingFor(r);
        return reading.tracked ? `1${reading.labels[0]}` : '0';
      },
    },
  ],
  provenance: (m) => `<div class="px-7 py-6">
    <div class="mb-3 flex items-start justify-between gap-4">
      <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
      <button data-modal-close class="text-2xl text-slate-400">&times;</button>
    </div>
    <div class="space-y-3 text-sm leading-relaxed text-slate-600">
      <p><strong>BSE:</strong> exchange-wide announcements are captured every two hours, with retained monthly history.
        Latest capture: ${escapeHtml(m.capturedAt || 'unavailable')}.</p>
      <p><strong>NSE:</strong> the live exchange feed and up to 90 days of retained captures join this table.
        Latest source capture: ${escapeHtml(m.nse?.capturedAt || 'unavailable')}.
        ${escapeHtml(m.nse?.error || m.nse?.degraded || '')}</p>
      <p><strong>Company history:</strong> scheduled direct BSE company captures, Muns BSE/NSE/DRHP captures and earlier
        saved lookups join the same stream. Each source keeps its own successful date coverage; one source failing does not
        erase rows or advance the other source's coverage.</p>
      <p>The feed checks for updates every 90 seconds while visible, pauses when hidden and checks again on return.
        Retained history loads automatically. Source publication and scheduled captures can lag; this is not a complete exchange archive.</p>
      <p>Time filters use source publication dates in IST. Last 3 and 7 days include today; This month runs from the first
        day through today. All time includes every retained filing, including undated records. Filtering never deletes history.</p>
      <p>The Source column preserves every exchange label. BSE and NSE rows merge only when the captured PDFs have the same
        SHA-256 content hash for that company and date; separate or unreadable documents remain separate rows. Every retained
        exchange document link is included in the export.</p>
      <p>Portfolio matching uses exchange ISINs and BSE scrip codes as well as ticker aliases, including renamed and newly listed holdings.
        The table count describes companies with loaded filings, not the number checked or complete portfolio coverage.
        Exchange identities checked: ${escapeHtml(m.identity?.capturedAt || 'unavailable')}.
        ${escapeHtml(m.identity?.error || '')}</p>
      <p><strong>Topic</strong> is the desk’s keyword reading of the filing subject and sub-category.
        No PDF is summarized or scored. Missing fields remain blank.</p>
      <p><strong>Type</strong> is one label per filing, read from the exchange’s own sub-category (BSE) or subject (NSE)
        where that says something, and otherwise from the filing’s subject line — the first matching rule wins, no
        document is opened and nothing is scored. The <strong>Show</strong> row above the table lists every type with its
        count for the selected period; switching a type off hides its rows from this view only, the note beside the
        chips says how many, and the choice is remembered on this device. <strong>Routine &amp; administrative</strong>
        starts switched off. Search, counts and export follow the same selection; nothing is deleted or left uncollected.</p>
      <ul class="list-disc space-y-1 pl-5 text-xs">
        ${ANNOUNCEMENT_TYPES.map((t) => `<li><strong>${escapeHtml(t.label)}</strong>${hiddenTypes.has(t.id) ? ' (switched off)' : ''} — ${escapeHtml(t.hint)}</li>`).join('')}
      </ul>
      ${m.archive?.error ? `<p>${escapeHtml(m.archive.error)}</p>` : ''}
      ${m.nse?.historyUnavailable || m.nse?.allMissingDays?.length ? '<p>Some retained NSE history could not be loaded; existing records remain visible.</p>' : ''}
      ${captureCoverageHtml('announcements')}
      ${coverageBlock(m)}
    </div>
  </div>`,
  onExport: async (visible, m) => {
    await exportRows({
      filename: 'glow-corp-announcements',
      sheetName: 'Announcements',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `SOURCE DISCLOSURES. BSE exchange-wide capture: ${m.windowDays} day(s), captured ${m.capturedAt || 'at an unknown time'}. ` +
                `Live NSE announcements, retained NSE history, scheduled direct-BSE company history, and Muns BSE/NSE/DRHP company captures are merged with older saved lookups. Coverage is limited to successful source reads. ` +
                `Subjects and categories are the sources' own words; Topic is the dashboard's keyword reading and Type is its reading of the exchange's sub-category or the subject line. No document contents are summarized. ` +
                (hiddenTypes.size
                  ? `Filing types switched off by the reader and NOT in this export: ${[...hiddenTypes].map(typeLabel).join(', ')}. `
                  : 'No filing type was switched off. ') +
                `Exported ${new Date().toISOString()}.`
              : r.date || '',
        },
        { header: 'Time', key: 'tm', width: 10, get: (r) => (r.__banner ? '' : r.time || '') },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'BSE scrip code', key: 'sc', width: 14, get: (r) => (r.__banner ? '' : r.scripCode || '') },
        { header: 'Company (as filed)', key: 'co', width: 38, get: (r) => (r.__banner ? '' : r.company || '') },
        { header: 'Subject (as filed)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : cleanFilingText(r.title || r.headline)) },
        { header: 'Category (as filed)', key: 'c', width: 22, get: (r) => (r.__banner ? '' : r.category || '') },
        { header: 'Sub-category (as filed)', key: 'sb', width: 30, get: (r) => (r.__banner ? '' : r.subCategory || '') },
        { header: 'Type (derived)', key: 'ty', width: 26, get: (r) => (r.__banner ? '' : typeOf(r).label) },
        { header: 'Source', key: 'src', width: 20, get: (r) => r.__banner ? '' : announcementSources(r).join(' / ') },
        { header: 'Retrieved through', key: 'via', width: 35, get: (r) => r.__banner ? '' : (r.providers || []).join(' / ') },
        { header: 'Document URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
        { header: 'All source document URLs', key: 'su', width: 80, get: (r) => r.__banner ? '' :
          announcementSourceUrls(r).map(({ source, url }) => `${source}: ${url}`).join('\n') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const ANNOUNCEMENTS_VIEW = 'announcements';
export const CORPORATE_ACTIONS_VIEW = 'corporate-actions';

// Announcements is first, and first is what the shell opens the tab on: `handleRoute` resolves a
// missing or unknown sub-view to `subviews[0]`, so `#/research/corp-announcements` still lands on
// the stream it always did.
export const meta = {
  id: announcements.meta.id,
  title: announcements.meta.title,
  subtitle: announcements.meta.subtitle,
  subviews: [
    { id: ANNOUNCEMENTS_VIEW, label: 'Announcements' },
    { id: CORPORATE_ACTIONS_VIEW, label: 'Corporate Actions' },
  ],
};

let mounted = null; // ANNOUNCEMENTS_VIEW | CORPORATE_ACTIONS_VIEW | null
let liveRef = null;

function unmountAnnouncements() {
  if (liveRef) feed.stopLive(liveRef);
  liveRef = null;
  announcements.destroy();
}

export function render(ctx) {
  // A caller that names no sub-view — the stream's own browser check drives this module with a
  // bare ctx — gets the Announcements view, the same one the shell resolves to.
  const wanted = ctx.subview === CORPORATE_ACTIONS_VIEW ? CORPORATE_ACTIONS_VIEW : ANNOUNCEMENTS_VIEW;
  if (mounted && mounted !== wanted) {
    if (mounted === CORPORATE_ACTIONS_VIEW) corporateActions.destroy();
    else unmountAnnouncements();
  }
  mounted = wanted;
  if (wanted === CORPORATE_ACTIONS_VIEW) {
    corporateActions.render(ctx);
    return;
  }
  announcements.render(ctx);
  liveRef = ctx.live;
  if (liveRef) feed.startLive(liveRef);
}

export function destroy() {
  if (mounted === CORPORATE_ACTIONS_VIEW) corporateActions.destroy();
  else if (mounted === ANNOUNCEMENTS_VIEW) unmountAnnouncements();
  mounted = null;
}
