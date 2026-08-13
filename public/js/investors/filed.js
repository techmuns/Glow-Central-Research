// investors/filed.js — the REAL half of the Institutions view.
//
//   renderFiled(ctx, { disposers })   the filed-holdings panel: fund picker, stats, table
//
// EVERY NUMBER IN HERE COMES FROM AN EXCHANGE FILING, except one that is labelled.
//   Share count and holding percentage are what the company filed. The rupee value is Trendlyne's
//   derivation (holding % × market cap) — reproduced unchanged, attributed on every surface it
//   reaches, and never recomputed here. Same rule as the StockScans con-call scores.
//
// NOT ONE FIGURE ON THIS PANEL IS AVERAGED WITH A SYNTHETIC ONE.
//   The Institutions view still lists funds we have not wired yet, and those are synthetic. They
//   live in their own section below, under their own ribbon, and are excluded from every headline
//   number here. A "combined book" that added a real ₹35,818 Cr to an invented ₹2.7 L Cr would be
//   the single most misleading number the dashboard could print.

import { scoreTable, sectionHead, openDrill, openModal } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCroreCompact, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as filed from '../data/institution-holdings.js';
import * as coverage from '../data/coverage.js';

const ATTRIBUTION = 'Share counts and holding percentages are exchange filings; the ₹ value is Trendlyne’s own derivation.';

export function renderFiled(ctx, { disposers = [] } = {}) {
  const funds = filed.all();
  const m = filed.meta();
  if (!funds.length) return { html: '', wire: () => {} };

  // One fund today. The picker is here because the file is a list and the next fund added to
  // FUNDS in the scraper should need no UI change at all.
  const wanted = ctx.params?.fund;
  const fund = funds.find((f) => f.investorId === wanted) || funds[0];
  const rows = filed.holdingsForScope(ctx.scope, coverage.holdings(), fund.holdings);
  const label0 = fund.quarterLabels[0];

  // THE COLUMN SET IS TRENDLYNE'S, IN TRENDLYNE'S ORDER.
  //   Stock · Holding Value · Qty Held · <latest> Change % · <latest> Holding % · then the eight
  //   prior quarters. Every one sortable, which `scoreTable` gives by default — a column opts OUT
  //   with `sortable: false`, and none of these do.
  //
  // Quarter labels are shortened to "Mar 26" in the header. Thirteen columns is a lot to fit at
  // 1440px, and "MAR 2026 %" spelled out costs ~30px eight times over; the full label lives in
  // each cell's title attribute. `verify-ui.mjs` asserts the table does not overflow.
  const shortQ = (label) => label.replace(/\s(\d{2})(\d{2})$/, ' $2');

  const historyColumns = fund.quarters.slice(1).map((q, i) => {
    const label = fund.quarterLabels[i + 1];
    const prev = fund.quarters[i + 2] || null; // the quarter BEFORE this one, for the shading
    return {
      label: `${shortQ(label)} %`,
      get: (r) => pctCell(r.pctByQuarter?.[q], prev ? r.pctByQuarter?.[prev] : null, label),
      html: true,
      align: 'right',
      sortValue: (r) => r.pctByQuarter?.[q] ?? -1,
    };
  });

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    nameLabel: 'Stock',
    // Trendlyne's Stock column is the company name alone. The ticker earns its place as the
    // sub-line because it is the join key everywhere else in the dashboard; the sector does not,
    // and dropping it is what buys the thirteen columns their headroom. It is still searchable.
    sub: (r) => r.ticker,
    // No rank column: this is a portfolio, and "#7" against a value-sorted list is a position in
    // the current sort rather than a ranking of anything. The watchlist star moves into the
    // identity cell, which is what `showRank: false` does.
    showRank: false,
    dense: true,
    wrapHeads: true,
    // No gradient mark: Trendlyne's Stock column is text, and the ~46px it costs is exactly what
    // thirteen columns need to stop truncating company names.
    showAvatar: false,
    nameMaxPx: 165,
    stickyHead: 'max(320px, calc(100vh - 300px))',
    columns: [
      {
        label: 'Holding Value',
        get: (r) => (r.valueCr == null ? dash('no value published') : `<span class="tabular-nums" title="Trendlyne&rsquo;s derivation: holding % × market cap">${escapeHtml(formatCrore(r.valueCr))}</span>`),
        html: true,
        align: 'right',
        sortValue: (r) => r.valueCr ?? -1,
      },
      {
        label: 'Qty Held',
        get: (r) => (r.qty == null ? dash('no share count filed') : `<span class="tabular-nums" title="Shares held, as filed">${escapeHtml(groupInt(r.qty))}</span>`),
        html: true,
        align: 'right',
        sortValue: (r) => r.qty ?? -1,
      },
      {
        label: `${shortQ(label0)} Change %`,
        get: (r) => changeCell(r),
        html: true,
        align: 'right',
        // A label sorts below every number but above a blank, so "New" rows group together at the
        // bottom of a descending sort instead of scattering.
        sortValue: (r) => (r.changePp != null ? r.changePp : r.changeNote ? -998 : -999),
      },
      {
        label: `${shortQ(label0)} Holding %`,
        get: (r) => pctCell(r.holdingPct, r.pctByQuarter?.[fund.quarters[1]], label0, { bold: true }),
        html: true,
        align: 'right',
        sortValue: (r) => r.holdingPct ?? -1,
      },
      ...historyColumns,
    ],
    filters: [
      {
        label: 'Position',
        options: [
          { value: 'all', label: 'All positions' },
          { value: 'up', label: 'Increased' },
          { value: 'down', label: 'Trimmed' },
          { value: 'new', label: 'Newly disclosed' },
          { value: 'pending', label: 'Awaiting filing' },
        ],
        match: (r, v) => {
          if (v === 'up') return r.pctDelta != null && r.pctDelta > 0;
          if (v === 'down') return r.pctDelta != null && r.pctDelta < 0;
          if (v === 'new') return r.changeNote === 'New';
          if (v === 'pending') return r.holdingPct == null;
          return true;
        },
      },
    ],
    searchable: (r) => `${r.name} ${r.ticker} ${r.sector || ''} ${r.industry || ''}`,
    initialSort: { key: 'Holding Value', dir: 'desc' },
    onRowClick: (r) => drillHolding(r, fund),
    exportName: `sattva-${fund.investorId}-holdings`,
    onExport: (visible) => exportFiled(visible, fund),
    emptyMessage: ctx.scope === 'portfolio' ? 'This fund holds none of your positions.' : 'No holding matches your filters.',
  });

  // ONE TABLE AND NOTHING ELSE, the way the Earnings Hub is built. No stat strip, no ranking grid:
  // this is a portfolio listing and the reader came for the rows. The provenance did not go away —
  // it moved behind the Filed pill, which is one click from anywhere on the page. See the
  // "honesty rules for the kit" section of CLAUDE.md: decluttering is fine, deleting the
  // accountability is not.
  const html = `
    ${sectionHead({
      title: 'Institutions',
      description: `Indian shareholdings as filed with the exchanges, quarter by quarter. ${ATTRIBUTION}`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${filedPill(fund, m)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'holdings', book: coverage.meta() })}</div>`,
    })}
    ${funds.length > 1 ? fundPicker(funds, fund) : ''}
    <div class="mb-4 flex flex-wrap items-center gap-3">
      ${avatarBlock(fund)}
      <div class="min-w-0 flex-1">
        <div class="font-display text-base font-bold text-slate-900">${escapeHtml(fund.name)}</div>
        <div class="text-xs text-slate-500">${escapeHtml(fund.house || '')}${fund.category ? ` · ${escapeHtml(fund.category)}` : ''} · ${escapeHtml(formatNumber(fund.stocksHeld))} holdings worth ${escapeHtml(formatCrore(fund.portfolioValueCr))} as of ${escapeHtml(label0)}${fund.former.length ? ` · ${escapeHtml(formatNumber(fund.former.length))} previously held` : ''}</div>
      </div>
      <a href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener"
         class="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">Trendlyne source ↗</a>
    </div>
    ${table.html}
    <p class="mb-6 mt-3 text-[11px] leading-relaxed text-slate-500">
      Every heading sorts. Share counts and percentages are the filings themselves;
      <strong>Holding Value is Trendlyne's own derivation</strong> (holding % × market cap) — a filing never discloses a
      rupee amount. Companies file within weeks of a quarter closing and not all at once, so
      <strong>${escapeHtml(formatNumber(fund.filedThisQuarter))}</strong> of ${escapeHtml(formatNumber(fund.stocksHeld))}
      have filed for ${escapeHtml(label0)}; a dash there means <em>not filed</em>, never sold — the share count and value
      are still present, and the Change column says <em>Filing Awaited</em>.
      A holder is only named above 1%, so crossing that line either way is a disclosure event rather than necessarily a trade.
      ${filed.all().length === 1 ? 'One fund is wired to filings so far; the rest need one entry each in the scraper.' : ''}
    </p>`;

  return {
    html,
    wire(root) {
      const off = table.wire(root);
      if (off) disposers.push(off);
      root.querySelector('[data-filed-info]')?.addEventListener('click', () => openProvenance(fund, m));
      for (const btn of root.querySelectorAll('[data-fund]')) {
        btn.addEventListener('click', () => ctx.setParams({ ...ctx.params, fund: btn.dataset.fund }));
      }
    },
  };
}

// Trendlyne group share counts internationally — 14,947,573, not the Indian 1,49,47,573 — and
// matching them keeps the column both faithful and two characters narrower.
const groupInt = (n) => n.toLocaleString('en-US');

/** A dash that says why it is a dash. Never a zero — see the header of this file. */
const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

/** "1,104.2 Cr" — Trendlyne's own unit, so the column reads the same as their page. */
function formatCrore(v) {
  if (v == null) return '—';
  return `${v.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Cr`;
}

/**
 * One quarter's filed percentage, tinted against the quarter before it.
 *
 * The tint is arithmetic on two filed numbers, not a judgement: higher than last quarter is
 * emerald, lower is rose. Trendlyne shade their grid the same way and it is what makes a
 * two-year row readable at a glance instead of nine numbers to diff by eye.
 */
function pctCell(v, prev, label, { bold = false } = {}) {
  if (v == null) return dash(`${label}: not filed`);
  const tint = prev == null ? '' : v > prev ? 'bg-emerald-50' : v < prev ? 'bg-rose-50' : '';
  return `<span class="-mx-1 inline-block rounded px-1 tabular-nums ${tint} ${bold ? 'font-semibold text-slate-900' : 'text-slate-700'}" title="${escapeHtml(label)}${prev == null ? '' : ` · was ${prev}% the quarter before`}">${v.toFixed(1)}%</span>`;
}

/**
 * The change column, as Trendlyne print it: a signed number, or their own label where no number
 * applies. "New" and "Below 1% first time" are disclosure events, not measurements, so they stay
 * words — turning them into a percentage would invent a figure the filing does not contain.
 */
function changeCell(r) {
  if (r.changePp == null) {
    if (!r.changeNote) return dash('no change published');
    const tone = r.changeNote === 'New' ? 'text-emerald-700' : r.changeNote === 'Filing Awaited' ? 'text-amber-700' : 'text-slate-500';
    return `<span class="whitespace-nowrap font-medium ${tone}" title="Trendlyne&rsquo;s own label for this row">${escapeHtml(r.changeNote)}</span>`;
  }
  if (r.changePp === 0) return '<span class="tabular-nums text-slate-400">0.0</span>';
  const cls = r.changePp > 0 ? 'text-emerald-700' : 'text-rose-700';
  return `<span class="font-semibold tabular-nums ${cls}" title="Change in percentage points against the previous quarter">${r.changePp > 0 ? '' : ''}${r.changePp.toFixed(1)}</span>`;
}

function avatarBlock(fund) {
  const { color, initials } = avatarFor(fund.name);
  return `<span class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-sm font-bold text-white">${escapeHtml(initials)}</span>`;
}

function fundPicker(funds, active) {
  return `
    <div class="mb-4 flex flex-wrap gap-2">
      ${funds
        .map(
          (f) => `<button type="button" data-fund="${escapeHtml(f.investorId)}" aria-pressed="${f.investorId === active.investorId}"
            class="rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${
              f.investorId === active.investorId ? 'bg-indigo-600 text-white ring-indigo-600' : 'bg-white text-slate-600 ring-slate-200 hover:bg-indigo-50'
            }">${escapeHtml(f.name)}</button>`
        )
        .join('')}
    </div>`;
}

function filedPill(fund, m) {
  return `
    <button type="button" data-filed-info title="Where these figures come from, and which of them are filings"
      class="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-300 transition-colors hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span>Filed</span>
      <span class="font-normal opacity-70">${escapeHtml(fund.quarterLabels[0])} · exchange filings</span>
    </button>`;
}

function openProvenance(fund, m) {
  openModal(
    `<div class="px-7 py-6">
      <div class="mb-3 flex items-start justify-between gap-4">
        <h2 class="font-display text-xl font-bold text-slate-900">Filed shareholdings</h2>
        <button data-modal-close class="text-2xl leading-none text-slate-400 hover:text-slate-700">&times;</button>
      </div>
      <div class="text-sm leading-relaxed text-slate-600">
        <p><strong>Real data.</strong> Indian listed companies file their shareholding pattern with the exchanges every
           quarter, naming each holder above 1% with the number of shares and the percentage of the company held.
           <a class="font-semibold text-indigo-600 hover:underline" href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener">Trendlyne</a>
           aggregate those filings by holder, which is how one page can list every Indian company
           <strong>${escapeHtml(fund.name)}</strong> appears in.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Which numbers are filings, and which is not</h3>
        <ul class="mt-1 list-disc space-y-1 pl-5 text-xs">
          <li><strong>Shares held</strong> and <strong>holding %</strong> — the filing itself, as submitted by the company.</li>
          <li><strong>Change</strong> — the difference between two filed percentages, in percentage points. Trendlyne publish
              their own change figure for the quarter and the two agree on every row of this pull; where no number applies
              they print a label instead (<em>New</em>, <em>Below 1% first time</em>, <em>Filing Awaited</em>) and so do we.</li>
          <li><strong>Value</strong> — <strong>Trendlyne's derivation</strong>, holding % × market cap, reproduced unchanged.
              A filing never discloses a rupee amount. We do not recompute it: a number of ours under their label would
              read as theirs. Our total and theirs agree to the rupee — ₹${escapeHtml(formatNumber(fund.portfolioValueCr))} Cr
              across ${escapeHtml(formatNumber(fund.stocksHeld))} holdings.</li>
          <li><strong>Sector</strong> — from the NSE-500 export, so companies outside it show none.</li>
        </ul>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">Why a percentage can be missing</h3>
        <p class="mt-1 text-xs">Companies file within weeks of a quarter closing, not on the same day.
           <strong>${escapeHtml(formatNumber(fund.filedThisQuarter))}</strong> of ${escapeHtml(formatNumber(fund.stocksHeld))}
           have filed for ${escapeHtml(fund.quarterLabels[0])}${fund.awaitingFiling.length ? `; ${fund.awaitingFiling.map((t) => `<strong>${escapeHtml(t)}</strong>`).join(', ')} ${fund.awaitingFiling.length === 1 ? 'has' : 'have'} not` : ''}.
           Those rows read <em>not filed yet</em> and keep their share count and value. A zero there would report a position
           that is still held as sold.</p>

        <h3 class="font-display mt-4 text-sm font-bold text-slate-900">How fresh it is</h3>
        <p class="mt-1 text-xs">Shareholding is a quarterly disclosure, so this is scraped on a schedule and committed, not
           polled. Last read ${m?.generatedAt ? escapeHtml(formatRelativeTime(Date.parse(m.generatedAt))) : '—'} by
           <code class="rounded bg-slate-100 px-1">${escapeHtml(m?.generator || 'scripts/scrape-institution-holdings.mjs')}</code>,
           which refuses to write the file unless its own totals match Trendlyne's stated figures.</p>

        <p class="mt-4 text-xs text-slate-500">A dash means <em>not disclosed</em> — never zero.</p>
      </div>
    </div>`,
    { size: 'default' }
  );
}

function drillHolding(h, fund) {
  const rows = fund.quarters.map((q, i) => ({ q, label: fund.quarterLabels[i], pct: h.pctByQuarter?.[q] ?? null }));
  openDrill({
    name: h.name,
    sub: `${h.ticker}${h.sector ? ` · ${h.sector}` : ''}`,
    link: h.url,
    linkLabel: 'Shareholding on Trendlyne ↗',
    headerStats: [
      { label: `${fund.quarterLabels[0]} holding`, value: h.holdingPct == null ? 'not filed' : `${h.holdingPct.toFixed(1)}%`, caption: h.holdingPct == null ? 'the company has not filed yet' : 'of the company, as filed', tone: 'neutral' },
      { label: 'Shares held', value: h.qty == null ? '—' : formatNumber(h.qty), caption: 'as filed', tone: 'neutral' },
      { label: 'Value', value: h.valueCr == null ? '—' : formatCroreCompact(h.valueCr), caption: 'Trendlyne’s derivation', tone: 'neutral' },
    ],
    groups: [
      {
        category: `Filed holding · ${fund.quarterLabels[fund.quarterLabels.length - 1]} to ${fund.quarterLabels[0]}`,
        items: rows.map((r, i) => ({
          label: r.label,
          value: r.pct == null ? 'not filed' : `${r.pct.toFixed(1)}% of the company`,
          // `na` rather than a zero: the company has not filed, which is not the same as a holder
          // who sold. The drill is the one place that distinction has room to be spelled out.
          status: r.pct == null ? 'na' : 'pass',
          note: r.pct == null ? 'the company had not filed for this quarter when this was read' : i === 0 ? 'most recent filing' : null,
        })),
      },
      {
        category: 'Provenance',
        items: [
          { label: 'Shares held and holding %', value: 'exchange filing, as submitted by the company', status: 'pass' },
          { label: 'Rupee value', value: 'Trendlyne’s derivation: holding % × market cap', status: 'partial', note: 'a filing never discloses a rupee amount; this is reproduced, not recomputed' },
          { label: 'Change in pp', value: 'the difference between two filed percentages', status: 'pass' },
          { label: 'Sector', value: h.sector || 'not in the NSE-500 export', status: h.sector ? 'pass' : 'na' },
          { label: 'Holder', value: fund.name, status: 'pass' },
        ],
      },
    ],
  });
}

async function exportFiled(visible, fund) {
  const banner = {
    __banner:
      `REAL DATA. ${fund.name} — Indian shareholdings as filed with the exchanges, quarter ending ${fund.quarterLabels[0]}. ` +
      `Share counts and holding percentages are the filings. THE RUPEE VALUE IS TRENDLYNE'S OWN DERIVATION (holding % x market cap), ` +
      `reproduced unchanged, not recomputed — a filing never discloses a rupee amount. ` +
      `${fund.filedThisQuarter} of ${fund.stocksHeld} holdings have filed for ${fund.quarterLabels[0]}; a blank percentage means NOT YET FILED, not sold. ` +
      `Source: ${fund.sourceUrl}. Exported ${new Date().toISOString()}.`,
  };
  await exportRows({
    filename: `sattva-${fund.investorId}-holdings`,
    sheetName: 'Filed holdings',
    columns: [
      { header: 'Ticker', key: 't', width: 16, get: (r) => (r.__banner ? r.__banner : r.ticker) },
      { header: 'Company', key: 'c', width: 34, get: (r) => (r.__banner ? '' : r.name) },
      { header: 'Sector', key: 's', width: 26, get: (r) => (r.__banner ? '' : r.sector || '') },
      { header: 'Shares held (filed)', key: 'q', width: 20, get: (r) => (r.__banner ? '' : r.qty ?? '') },
      { header: `${fund.quarterLabels[0]} holding % (filed)`, key: 'p', width: 24, get: (r) => (r.__banner ? '' : r.holdingPct ?? '') },
      { header: 'Change (pp)', key: 'd', width: 14, get: (r) => (r.__banner ? '' : r.pctDelta ?? '') },
      { header: 'Trendlyne label', key: 'n', width: 20, get: (r) => (r.__banner ? '' : r.changeNote || '') },
      { header: 'Value Rs Cr (Trendlyne derived)', key: 'v', width: 30, get: (r) => (r.__banner ? '' : r.valueCr ?? '') },
      ...fund.quarters.map((q, i) => ({ header: `${fund.quarterLabels[i]} %`, key: `h${i}`, width: 12, get: (r) => (r.__banner ? '' : r.pctByQuarter?.[q] ?? '') })),
    ],
    rows: [banner, ...visible],
  });
}
