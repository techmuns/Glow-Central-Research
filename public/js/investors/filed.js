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
import { statStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCroreCompact, formatRelativeTime } from '../core/format.js';
import { exportRows } from '../ui/export.js';
import * as filed from '../data/institution-holdings.js';

const ATTRIBUTION = 'Share counts and holding percentages are exchange filings; the ₹ value is Trendlyne’s own derivation.';

/** A signed percentage-point figure. A gap between two percentages is measured in pp, not %. */
function ppCell(v, note) {
  if (v == null) {
    return note
      ? `<span class="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200" title="Trendlyne’s own label for this row">${escapeHtml(note)}</span>`
      : '<span class="text-slate-300">—</span>';
  }
  if (v === 0) return '<span class="tabular-nums text-slate-400">0.0 pp</span>';
  const cls = v > 0 ? 'text-emerald-700' : 'text-rose-700';
  return `<span class="font-semibold tabular-nums ${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)} pp</span>`;
}

/** Nine quarters of filed percentage as a bar strip — the shape of the position over two years. */
function historyStrip(h, quarters, labels) {
  const vals = quarters.map((q) => h.pctByQuarter?.[q] ?? null);
  const max = Math.max(...vals.filter((v) => v != null), 0.1);
  // Oldest on the left, so it reads left-to-right like every other time series on the dashboard.
  return `<span class="inline-flex items-end gap-0.5" title="${escapeHtml(quarters.map((q, i) => `${labels[i]}: ${vals[i] == null ? 'not filed' : `${vals[i]}%`}`).reverse().join(' · '))}">
    ${[...vals]
      .reverse()
      .map((v, i) =>
        v == null
          ? '<span class="inline-block w-1 rounded-sm bg-slate-200" style="height:2px" aria-hidden="true"></span>'
          : `<span class="inline-block w-1 rounded-sm ${i === vals.length - 1 ? 'bg-indigo-600' : 'bg-indigo-200'}" style="height:${Math.max(2, Math.round((v / max) * 18))}px" aria-hidden="true"></span>`
      )
      .join('')}
  </span>`;
}

export function renderFiled(ctx, { disposers = [] } = {}) {
  const funds = filed.all();
  const m = filed.meta();
  if (!funds.length) return { html: '', wire: () => {} };

  // One fund today. The picker is here because the file is a list and the next fund added to
  // FUNDS in the scraper should need no UI change at all.
  const wanted = ctx.params?.fund;
  const fund = funds.find((f) => f.investorId === wanted) || funds[0];
  const rows = filed.holdingsForScope(ctx.scope, ctx.data?.portfolio?.holdings || [], fund.holdings);

  const q0 = fund.quarters[0];
  const q1 = fund.quarters[1];
  const label0 = fund.quarterLabels[0];
  const label1 = fund.quarterLabels[1];

  const added = rows.filter((h) => h.pctDelta != null && h.pctDelta > 0).length;
  const trimmed = rows.filter((h) => h.pctDelta != null && h.pctDelta < 0).length;
  const fresh = rows.filter((h) => h.changeNote === 'New').length;
  const scopedValue = rows.reduce((s, h) => s + (h.valueCr ?? 0), 0);

  const stats = statStrip([
    {
      label: 'Companies held',
      value: formatNumber(rows.length),
      note: ctx.scope === 'portfolio' ? `of ${formatNumber(fund.stocksHeld)} — narrowed to your holdings` : `${formatNumber(fund.filedThisQuarter)} filed for ${escapeHtml(label0)}`,
    },
    {
      label: 'Disclosed book',
      value: formatCroreCompact(scopedValue),
      note: 'Trendlyne’s figure, not ours',
      help: {
        title: 'Whose number this is, and what it means',
        body: `<p>A shareholding filing discloses a <strong>share count and a percentage of the company</strong> — never a rupee amount. The ₹ figure is <strong>Trendlyne's</strong> derivation: that percentage applied to the company's market cap.</p>
               <p class="mt-3">It is reproduced here unchanged and attributed, not recomputed — a number of our own printed under their label would read as theirs. It moves for two reasons, the holder changing the position and the market repricing the company, and it is not what anyone paid.</p>
               <p class="mt-3">The share counts and percentages beside it <strong>are</strong> the filings, and those are the numbers to trust.</p>`,
      },
    },
    {
      label: `Moved in ${escapeHtml(label0)}`,
      value: `${added} up · ${trimmed} down`,
      note: fresh ? `${fresh} newly disclosed above 1%` : `measured against ${escapeHtml(label1)}`,
    },
    {
      hero: true,
      label: 'Filed shareholding',
      value: escapeHtml(label0),
      note: `Real exchange filings · read ${m?.generatedAt ? escapeHtml(formatRelativeTime(Date.parse(m.generatedAt))) : '—'}${fund.awaitingFiling.length ? ` · ${fund.awaitingFiling.length} still to file` : ''}`,
    },
  ]);

  const table = scoreTable({
    rows,
    key: (r) => r.ticker,
    name: (r) => r.name,
    nameLabel: 'Company',
    sub: (r) => `${r.ticker} · ${r.sector || 'outside the NSE 500'}`,
    showRank: false,
    dense: true,
    nameMaxPx: 240,
    stickyHead: 'max(300px, calc(100vh - 420px))',
    columns: [
      {
        label: 'Shares held',
        get: (r) => (r.qty == null ? '<span class="text-slate-300">—</span>' : `<span class="tabular-nums">${escapeHtml(formatNumber(r.qty))}</span>`),
        html: true,
        align: 'right',
        sortValue: (r) => r.qty ?? -1,
      },
      {
        label: `${label0} holding`,
        get: (r) =>
          r.holdingPct == null
            ? `<span class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200" title="The company has not filed its ${escapeHtml(label0)} shareholding pattern yet. The position is still held — there is a share count and a value — the percentage is simply not published.">not filed yet</span>`
            : `<span class="font-semibold tabular-nums text-slate-900">${r.holdingPct.toFixed(1)}%</span>`,
        html: true,
        align: 'right',
        sortValue: (r) => r.holdingPct ?? -1,
      },
      { label: 'Change', get: (r) => ppCell(r.pctDelta, r.changeNote), html: true, align: 'right', sortValue: (r) => r.pctDelta ?? -99 },
      {
        label: 'Value (Trendlyne)',
        get: (r) => (r.valueCr == null ? '<span class="text-slate-300">—</span>' : `<span class="tabular-nums">${escapeHtml(formatCroreCompact(r.valueCr))}</span>`),
        html: true,
        align: 'right',
        sortValue: (r) => r.valueCr ?? -1,
      },
      {
        label: 'Since ' + escapeHtml(fund.quarterLabels[fund.quarterLabels.length - 1]),
        get: (r) => historyStrip(r, fund.quarters, fund.quarterLabels),
        html: true,
        align: 'right',
        sortable: false,
      },
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
    initialSort: { key: 'Value (Trendlyne)', dir: 'desc' },
    onRowClick: (r) => drillHolding(r, fund),
    exportName: `sattva-${fund.investorId}-holdings`,
    onExport: (visible) => exportFiled(visible, fund),
    emptyMessage: ctx.scope === 'portfolio' ? 'This fund holds none of your positions.' : 'No holding matches your filters.',
  });

  const html = `
    ${sectionHead({
      title: 'Institutions',
      description: `Filed shareholdings for the funds we track, quarter by quarter. ${ATTRIBUTION}`,
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${filedPill(fund, m)}${scopeSummary({ scope: ctx.scope, count: rows.length, noun: 'holdings' })}</div>`,
    })}
    ${funds.length > 1 ? fundPicker(funds, fund) : ''}
    <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      ${avatarBlock(fund)}
      <div class="min-w-0 flex-1">
        <div class="font-display text-base font-bold text-slate-900">${escapeHtml(fund.name)}</div>
        <div class="text-xs text-slate-500">${escapeHtml(fund.house || '')}${fund.category ? ` · ${escapeHtml(fund.category)}` : ''} · ${escapeHtml(formatNumber(fund.stocksHeld))} Indian holdings disclosed${fund.former.length ? ` · ${escapeHtml(formatNumber(fund.former.length))} previously held` : ''}</div>
      </div>
      <a href="${escapeHtml(fund.sourceUrl)}" target="_blank" rel="noopener"
         class="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 transition-colors hover:bg-indigo-50">Trendlyne source ↗</a>
    </div>
    ${stats.html}
    ${table.html}
    <p class="mb-6 mt-3 text-[11px] leading-relaxed text-slate-500">
      Companies file their shareholding pattern within weeks of a quarter closing, and they do not all file at once —
      <strong>${escapeHtml(formatNumber(fund.filedThisQuarter))}</strong> of ${escapeHtml(formatNumber(fund.stocksHeld))} have filed for ${escapeHtml(label0)}.
      A row reading <em>not filed yet</em> is still held: the share count and the value are there, the percentage is not published.
      ${fund.former.length ? `A further <strong>${escapeHtml(formatNumber(fund.former.length))}</strong> companies appear in the fund's history with no current position.` : ''}
      Sector comes from the NSE-500 export where the company is in it; ${escapeHtml(formatNumber(rows.filter((r) => !r.inUniverse).length))} of these sit outside it and show none.
    </p>`;

  return {
    html,
    wire(root) {
      stats.wire(root);
      const off = table.wire(root);
      if (off) disposers.push(off);
      root.querySelector('[data-filed-info]')?.addEventListener('click', () => openProvenance(fund, m));
      for (const btn of root.querySelectorAll('[data-fund]')) {
        btn.addEventListener('click', () => ctx.setParams({ ...ctx.params, fund: btn.dataset.fund }));
      }
    },
  };
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
