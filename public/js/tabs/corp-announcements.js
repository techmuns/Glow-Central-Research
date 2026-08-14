// tabs/corp-announcements.js — what the companies in scope have filed with the exchanges.
//
// BSE is the primary source, NSE the fallback, and DRHP documents come through the same route. Which
// of them a row came from is a column rather than something flattened away: a board-meeting notice
// filed with BSE and a draft prospectus are different kinds of document, and a reader sorting by
// source is asking a real question.
//
// THE SUBJECT LINE IS THE FILING'S OWN. Nothing here classifies an announcement as material or
// routine, or summarises a PDF — the row carries what the exchange published and links to the
// document. See the header of tabs/filings-tab.js for the shared machinery.

import { escapeHtml } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import { makeFilingsTab, coverageBlock } from './filings-tab.js';
import { announcements as feed } from '../data/filings.js';

const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// The exchange badges. Colour carries no judgement here — it is identity, so each source keeps one
// stable colour rather than anything that could read as good or bad.
const SOURCE_STYLE = {
  bse: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  nse: 'bg-purple-50 text-purple-700 ring-purple-200',
  drhp: 'bg-slate-100 text-slate-600 ring-slate-200',
};
const sourceBadge = (s) => {
  if (!s) return dash('the record did not name a source');
  const key = String(s).toLowerCase().replace(/[^a-z]/g, '');
  const cls = SOURCE_STYLE[key] || 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${cls}">${escapeHtml(String(s))}</span>`;
};

const tab = makeFilingsTab({
  id: 'corp-announcements',
  title: 'Corp Announcements',
  subtitle: 'Everything the companies in scope have filed with the exchanges — BSE first, NSE as fallback, plus DRHP documents. Subjects are the filings’ own; the document is linked, not reproduced.',
  feed,
  noun: 'announcements',
  nameLabel: 'Subject',
  nameMaxPx: 460,
  rowName: (r) => r.title || '(no subject)',
  rowSub: (r) => [r.ticker, r.category].filter(Boolean).join(' · '),
  searchable: (r) => `${r.title || ''} ${r.ticker || ''} ${r.category || ''} ${r.source || ''} ${r.summary || ''}`,
  columns: () => [
    {
      label: 'Date',
      get: (r) => (r.date ? `<span class="whitespace-nowrap tabular-nums text-slate-600">${escapeHtml(formatDate(r.date))}</span>` : dash('the filing carried no readable date')),
      html: true,
      sortValue: (r) => r.date || '',
    },
    {
      label: 'Source',
      get: (r) => sourceBadge(r.source),
      html: true,
      sortValue: (r) => r.source || '',
    },
    {
      label: 'Category',
      get: (r) => (r.category ? `<span class="text-slate-600">${escapeHtml(r.category)}</span>` : dash('the filing was not categorised')),
      html: true,
      sortValue: (r) => r.category || '',
    },
  ],
  filters: (rows) => {
    const out = [];
    const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))].sort();
    if (sources.length > 1) {
      out.push({
        label: 'Source',
        options: [{ value: 'all', label: 'All sources' }, ...sources.map((s) => ({ value: s, label: String(s).toUpperCase() }))],
        match: (r, v) => r.source === v,
      });
    }
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    if (cats.length > 1) {
      out.push({
        label: 'Category',
        options: [{ value: 'all', label: 'All categories' }, ...cats.slice(0, 40).map((c) => ({ value: c, label: c }))],
        match: (r, v) => r.category === v,
      });
    }
    return out.length ? out : null;
  },
  provenance: (m) => `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Corporate announcements</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real filings.</strong> Indian listed companies file announcements with the exchanges continuously — board
           meetings, results, corporate actions, clarifications. These come through the Muns filings API
           (<code class="rounded bg-slate-100 px-1">GET /filings/corp/announcements/{ticker}</code>), which reads
           <strong>BSE first, NSE as fallback</strong>, and also returns DRHP documents.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Which source said it is a column, not a detail</h3>
        <p class="mt-1 text-xs">The upstream groups its results by source and that grouping is kept on every row. A
           board-meeting notice filed with BSE and a draft prospectus are different kinds of document, and flattening them
           into one undifferentiated list would lose the only field that distinguishes them. <strong>A company can also
           appear under both exchanges for the same event</strong> — that is two filings, not a duplicate.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">What is ours</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Nothing in the subject or the category</strong> — both are the filing's own words.</li>
          <li><strong>No materiality judgement.</strong> Nothing here marks an announcement important or routine; that would
              be an assessment of ours on somebody else's disclosure.</li>
          <li><strong>The date normalisation only.</strong> Exchanges publish dates in several formats and they are read into
              one; a date that cannot be read stays blank and the row sorts last, rather than being given today's.</li>
        </ul>

        ${coverageBlock(m)}

        <p class="mt-4 text-xs text-slate-500">A dash means <em>the filing did not carry it</em> — never zero.</p>
      </div>
    </div>`,
  onExport: async (visible, m) => {
    await exportRows({
      filename: 'sattva-corp-announcements',
      sheetName: 'Announcements',
      columns: [
        {
          header: 'Date',
          key: 'd',
          width: 14,
          get: (r) =>
            r.__banner
              ? `REAL FILINGS, NOT OURS. Corporate announcements via the Muns filings API (BSE primary, NSE fallback, plus DRHP), ` +
                `reaching back ${m.windowDays} days, exported ${new Date().toISOString()}. ` +
                `SUBJECTS AND CATEGORIES ARE THE FILINGS' OWN WORDS — nothing here judges an announcement material or routine, and no document is summarised. ` +
                `THE SOURCE COLUMN MATTERS: a company can file the same event with both exchanges, which is two filings and not a duplicate. ` +
                `${m.covered} companies covered${m.failed ? `; ${m.failed} could not be read and are ABSENT rather than shown as having filed nothing` : ''}. ` +
                `A blank date means the filing's date could not be read, never that it is undated today.`
              : r.date || '',
        },
        { header: 'Ticker', key: 't', width: 14, get: (r) => (r.__banner ? '' : r.ticker || '') },
        { header: 'Source', key: 'x', width: 10, get: (r) => (r.__banner ? '' : r.source || '') },
        { header: 'Subject (as filed)', key: 'h', width: 70, get: (r) => (r.__banner ? '' : r.title || '') },
        { header: 'Category (as filed)', key: 'c', width: 26, get: (r) => (r.__banner ? '' : r.category || '') },
        { header: 'Document URL', key: 'u', width: 60, get: (r) => (r.__banner ? '' : r.url || '') },
      ],
      rows: [{ __banner: true }, ...visible],
    });
  },
});

export const meta = tab.meta;
export const render = tab.render;
export const destroy = tab.destroy;
