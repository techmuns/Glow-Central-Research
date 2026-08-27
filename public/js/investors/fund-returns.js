// investors/fund-returns.js — the Institutions view, rebuilt on the AmfiBeas "Returns & Ranking" feed.
//
//   renderFundReturns(ctx, { disposers, repaint })   the scheme table, its pill and its export
//
// This REPLACES the old filed-shareholdings / AMC-portfolio view. One table: every tracked mutual
// fund and ETF, its point-to-point return for each period, and its rank within its own cohort.
//
// THE RETURNS AND THE RANKS ARE THEIRS — reproduced, never recomputed. `returns[p].return` is a
// percentage already (3.4852 → +3.5%): a simple return for 1M/3M/6M/1Y, a CAGR for 3Y/5Y/10Y.
// `rank`/`peerCount` is the scheme's rank WITHIN ITS COHORT, rendered "38/149". This is the same
// rule the con-call and chatter feeds follow: no re-banding, no re-ranking, no recomputation. The
// one thing this view decides is which period columns to show — a period null for every row is
// hidden — and that is a display choice, not a new number.
//
// A NULL IS NOT A ZERO. A null `return` is "no return for that period" and renders an em dash; a
// null `rank` is "the cohort was too small to rank" and may sit beside a real return. Neither is
// ever coloured or counted as though it were measured.

import { scoreTable, sectionHead, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatRelativeTime } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as fundReturns from '../data/fund-returns.js';

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

/**
 * Build the panel from the ALREADY-LOADED feed. The dispatcher awaits `fundReturns.load()` and shows
 * a skeleton first, exactly as it did for the filed view, so `all()` / `meta()` are primed here.
 *
 * Returns `{ html, wire(root) }`. On a named failure it returns the failure panel and a wire that
 * arms the "Try again" button, so a mis-configured or briefly-down upstream is recoverable without
 * leaving the tab.
 */
export function renderFundReturns(ctx, { disposers = [], repaint = null } = {}) {
  const m = fundReturns.meta();
  const funds = fundReturns.all();

  // A FAILED READ IS NEVER AN EMPTY TABLE. `meta().reason` is set on every failure and `funds` is
  // then []; render the named state rather than "no funds", which would read as an empty universe.
  if (!m || m.reason) {
    return { html: failurePanel(m), wire: (root) => wireRetry(root, repaint) };
  }

  const visiblePeriods = periodsWithData(funds, m.periods);
  const table = buildTable(funds, m, visiblePeriods);

  // ONE TABLE AND NOTHING ELSE, the way the filed view and the Earnings Hub are built. No stat strip,
  // no ranking grid: this is a listing the reader scans and sorts. The provenance is one click away
  // in the pill, which is the honesty rule the kit is built on — declutter the page, never delete
  // the accountability.
  const html = `
    ${sectionHead({
      title: 'Fund Returns & Ranking',
      description: descriptionFor(m),
      meta: `<div class="flex flex-wrap items-center justify-end gap-2">${livePill(m)}</div>`,
    })}
    ${table.html}
  `;

  return {
    html,
    wire(root) {
      const off = table.wire(root);
      if (off) disposers.push(off);
      root.querySelector('[data-fund-returns-info]')?.addEventListener('click', () => openProvenance(m));
    },
  };
}

// ---------------------------------------------------------------------------------------
// Which period columns to show
// ---------------------------------------------------------------------------------------

/**
 * Hide a period whose return AND rank are null for EVERY row — 10Y is empty for most cohorts, and a
 * column of em dashes is noise. This drops nothing a reader could have used: a period kept is a
 * period at least one scheme reports.
 */
function periodsWithData(funds, periods) {
  return periods.filter((p) =>
    funds.some((f) => {
      const cell = f.returns?.[p];
      return cell && (cell.return != null || cell.rank != null);
    }),
  );
}

// ---------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------

function buildTable(funds, m, visiblePeriods) {
  return scoreTable({
    rows: funds,
    // The scheme code is the stable, content-derived id — never a row index (see the perf notes in
    // CLAUDE.md: a positional key breaks the repaint fast path the moment the row set changes).
    key: (r) => r.schemecode,
    name: (r) => r.fundName,
    nameLabel: 'Scheme',
    sub: (r) => identitySub(r),
    // No leading rank counter: the list is alphabetical, so "#7" would number the current sort
    // rather than rank anything — and this table already carries a real, per-period rank.
    showRank: false,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    nameMaxPx: 300,
    stickyHead: 'max(320px, calc(100vh - 300px))',
    searchable: (r) => `${r.fundName} ${r.classification || ''} ${r.plan} ${r.option}`,
    // Alphabetical by name, exactly as the source lists them.
    initialSort: { key: 'name', dir: 'asc' },
    columns: columnsFor(visiblePeriods),
    filters: filtersFor(funds),
    exportName: `glow-fund-returns-${todayStamp()}`,
    onExport: (visible) => exportFunds(visible, m, visiblePeriods),
    emptyMessage: 'No scheme matches your filters.',
  });
}

/** The sub-line under a scheme name: its classification and plan/option, whatever it carries. */
function identitySub(r) {
  const plan = r.plan && r.plan !== 'unknown' ? cap(r.plan) : null;
  const option = r.option && r.option !== 'unknown' ? cap(r.option === 'idcw' ? 'IDCW' : r.option) : null;
  return [r.classification, [plan, option].filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------------------
// Columns — two per visible period: the return, then the rank
// ---------------------------------------------------------------------------------------

function columnsFor(periods) {
  const cols = [];
  for (const p of periods) {
    const label = fundReturns.PERIOD_LABEL[p] || p;
    cols.push({
      label, // "1M", "3Y CAGR", …
      get: (r) => returnCell(r.returns?.[p]),
      html: true,
      align: 'right',
      sortable: true,
      sortValue: (r) => valueOrNull(r.returns?.[p]?.return),
    });
    cols.push({
      // The rank sub-column. `wrapHeads` lets "3Y CAGR Rank" stack instead of forcing the column
      // as wide as the label — the headings, not the "38/149" figures, are what would overflow.
      label: `${label} Rank`,
      get: (r) => rankCell(r.returns?.[p]),
      html: true,
      align: 'right',
      sortable: true,
      // Ascending rank is "best first"; a null rank sorts last, which scoreTable's comparator does
      // for null on its own.
      sortValue: (r) => valueOrNull(r.returns?.[p]?.rank),
    });
  }
  return cols;
}

const valueOrNull = (v) => (v == null || Number.isNaN(v) ? null : v);

/**
 * One period's return: one decimal, sign-prefixed, green above zero and rose below it, an em dash
 * where the source carried no return. Never coloured for a null — a missing return is not a loss.
 */
function returnCell(cell) {
  const v = cell?.return;
  if (v == null || Number.isNaN(v)) return dash('no return for this period');
  const sign = v > 0 ? '+' : '';
  const tone = v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500';
  return `<span class="font-semibold tabular-nums ${tone}">${sign}${v.toFixed(1)}%</span>`;
}

/**
 * The peer rank: "rank/peerCount" within the scheme's own cohort, an em dash where the cohort was
 * too small to rank. Reproduced, not computed — the same rule the con-call score follows.
 */
function rankCell(cell) {
  if (!cell || cell.rank == null) return dash('the cohort was too small to rank');
  const peers = cell.peerCount != null ? cell.peerCount : '—';
  return `<span class="tabular-nums text-slate-600" title="Rank within the scheme’s own cohort">${escapeHtml(String(cell.rank))}/${escapeHtml(String(peers))}</span>`;
}

/** A dash that says why it is a dash — never a zero. */
const dash = (why) => `<span class="text-slate-300" title="${escapeHtml(why)}">—</span>`;

// ---------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------

function filtersFor(funds) {
  const out = [];

  const classes = [...new Set(funds.map((f) => f.classification).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (classes.length > 1) {
    out.push({
      label: 'Classification',
      options: [{ value: 'all', label: 'All classifications' }, ...classes.map((c) => ({ value: c, label: c }))],
      match: (r, v) => r.classification === v,
    });
  }

  const plans = [...new Set(funds.map((f) => f.plan).filter((p) => p && p !== 'unknown'))].sort();
  if (plans.length > 1) {
    out.push({
      label: 'Plan',
      options: [{ value: 'all', label: 'Regular & Direct' }, ...plans.map((p) => ({ value: p, label: cap(p) }))],
      match: (r, v) => r.plan === v,
    });
  }

  return out.length ? out : null;
}

// ---------------------------------------------------------------------------------------
// Chrome — the pill and the provenance modal
// ---------------------------------------------------------------------------------------

function descriptionFor(m) {
  const asOf = m.asOfDate ? ` as of ${formatDateLabel(m.asOfDate)}` : '';
  return (
    `Point-to-point returns and same-cohort peer rank for every tracked mutual fund and ETF${asOf}, from AmfiBeas over AMFI’s daily NAV snapshot. ` +
    `The returns and the ranks are theirs, reproduced unchanged; this view adds no scoring of its own.`
  );
}

/** The green Live pill — the always-visible statement of what the figures are and how fresh. */
function livePill(m) {
  const freshness = originLabel(m);
  return `
    <button type="button" data-fund-returns-info title="Where these figures come from, and what the rank measures"
      class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-100 transition-colors hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
      <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
      <span>${escapeHtml(freshness)}</span>
      <span class="font-medium text-emerald-600">${escapeHtml(formatNumber(m.total || m.count))} schemes${m.asOfDate ? ` · as of ${escapeHtml(formatDateLabel(m.asOfDate))}` : ''}</span>
    </button>`;
}

/**
 * The pill's leading word states WHERE this paint came from, never claims a freshness it has not
 * confirmed — the same rule the store rests on. `live` was read from the network this session,
 * `store` is a 304-confirmed device copy; both are real reads, so both say "Live", but a reader can
 * tell which via the modal.
 */
function originLabel(m) {
  return m.origin === 'store' ? 'Cached' : 'Live';
}

function openProvenance(m) {
  openModal(
    `<div class="p-6 sm:p-8">
      <h3 class="font-display text-xl font-bold text-slate-900">Where this comes from</h3>
      <p class="mt-2 text-sm leading-relaxed text-slate-600">
        Live from the <strong>AmfiBeas</strong> Returns &amp; Ranking API, called <strong>directly from your browser</strong>
        rather than through this site’s Worker — the feed is CORS-open and read-only, so there is no credential to hold and
        nothing to proxy for (and Cloudflare refuses a Worker-to-Worker request inside one account anyway). It computes
        point-to-point returns from AMFI’s daily NAV snapshot and ranks each scheme within its own cohort.
      </p>
      <dl class="mt-5 space-y-3 text-sm">
        <div><dt class="font-semibold text-slate-800">Theirs, reproduced unchanged</dt>
          <dd class="text-slate-600">Every return and every rank. A return is a percentage already — a simple return for 1M/3M/6M/1Y and a CAGR for 3Y/5Y/10Y. Nothing here is re-banded, re-ranked or recomputed.</dd></div>
        <div><dt class="font-semibold text-slate-800">What the rank measures</dt>
          <dd class="text-slate-600">The scheme’s rank <strong>within its own cohort</strong>, shown <code>rank/peerCount</code> — e.g. <code>38/149</code>. It is a rank against comparable schemes, not against the whole list.</dd></div>
        <div><dt class="font-semibold text-slate-800">A dash is not a zero</dt>
          <dd class="text-slate-600">A missing <strong>return</strong> means the scheme has no return for that period; a missing <strong>rank</strong> means the cohort was too small to rank, and it can sit beside a real return. Neither is counted or coloured as a measured value.</dd></div>
        <div><dt class="font-semibold text-slate-800">Which periods are shown</dt>
          <dd class="text-slate-600">A period that is empty for every scheme is hidden — that is the only display choice this view makes. ${escapeHtml(String((m.periods || []).length))} periods are carried in the feed.</dd></div>
        <div><dt class="font-semibold text-slate-800">Freshness</dt>
          <dd class="text-slate-600">${provenanceFreshness(m)}</dd></div>
      </dl>
      <div class="mt-6 flex justify-end">
        <button data-modal-close class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">Close</button>
      </div>
    </div>`,
    { size: 'wide' },
  );
}

function provenanceFreshness(m) {
  const asOf = m.asOfDate ? `As of <strong>${escapeHtml(formatDateLabel(m.asOfDate))}</strong> (the AMFI NAV date the returns were computed to). ` : '';
  const origin =
    m.origin === 'store'
      ? 'This paint came from your device’s cache, revalidated against the upstream’s ETag'
      : 'This paint was read live from the upstream this session';
  const checked = m.checkedAt ? `, last confirmed ${escapeHtml(formatRelativeTime(new Date(m.checkedAt)))}` : '';
  return `${asOf}${origin}${checked}. The API refreshes daily; this page revalidates and reuses your cached copy when nothing changed.`;
}

// A NAV date is "YYYY-MM-DD"; render it as "12 Aug 2026" without inventing a timezone.
function formatDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

// ---------------------------------------------------------------------------------------
// Failure panel — a named state, never an empty table, with a way back
// ---------------------------------------------------------------------------------------

function failurePanel(m) {
  const reason = m?.reason || 'unknown';
  const url = m?.url || null;
  const REASONS = {
    'no-url': {
      title: 'The fund-returns feed has no address',
      body:
        'No upstream is configured. Set <code>window.AMFIBEAS_API_BASE</code> in <code>public/index.html</code> to the AmfiBeas host ' +
        '(or <code>localStorage["sattva:amfibeas-base"]</code> for a one-off), then reload. The API is not yet deployed to a fixed host.',
    },
    'not-found': {
      title: 'The fund-returns upstream answered 404',
      body: 'The host resolved but <code>/api/returns-ranking</code> was not there. Check the base URL, and that the API branch is deployed.',
    },
    unreachable: {
      title: 'The fund-returns upstream could not be reached',
      body: 'The request never completed — the host is down, the network is offline, or a CORS preflight was refused.',
    },
    upstream: {
      title: 'The fund-returns upstream returned an error',
      body: 'It answered, but with an error status. Try again shortly.',
    },
    shape: {
      title: 'The fund-returns upstream returned something unexpected',
      body: 'It answered, but not in the documented shape — the <code>funds</code> array was missing. Their contract may have changed.',
    },
  };
  const r = REASONS[reason] || { title: 'The fund-returns feed could not be read', body: 'No further detail was reported.' };
  return `
    ${sectionHead({ title: 'Fund Returns & Ranking', description: 'Point-to-point returns and same-cohort peer rank for every tracked mutual fund and ETF, from AmfiBeas.' })}
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100">
      <div class="flex items-start gap-3">
        <span class="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-amber-400"></span>
        <div class="min-w-0">
          <h3 class="font-display text-base font-bold text-slate-900">${escapeHtml(r.title)}</h3>
          <p class="mt-1.5 text-sm leading-relaxed text-slate-600">${r.body}</p>
          ${url ? `<p class="mt-3 text-xs text-slate-500">Requested <code class="rounded bg-slate-100 px-1">${escapeHtml(url)}</code> — the exact address, so this can be diagnosed without guessing at it.</p>` : ''}
          <p class="mt-3 text-xs text-slate-400">Nothing is shown rather than a zero: an empty list and a list we could not read must never look the same.</p>
          <button type="button" data-fund-returns-retry
            class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60">
            Try again
          </button>
        </div>
      </div>
    </div>`;
}

function wireRetry(root, repaint) {
  const btn = root.querySelector('[data-fund-returns-retry]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
    try {
      await fundReturns.reload();
    } catch {
      /* reload never rejects on a named failure; a thrown one falls through to the repaint below */
    }
    if (repaint) repaint();
  });
}

// ---------------------------------------------------------------------------------------
// Export — the one artefact that leaves without the page's chrome, so the banner carries the source
// ---------------------------------------------------------------------------------------

async function exportFunds(visible, m, periods) {
  const banner =
    `THIRD-PARTY DATA, REPRODUCED. Fund returns and same-cohort peer ranks from the AmfiBeas Returns & Ranking API ` +
    `(computed over AMFI’s daily NAV snapshot)${m.asOfDate ? `, as of ${formatDateLabel(m.asOfDate)}` : ''}. ` +
    `THE RETURNS AND THE RANKS ARE THEIRS — reproduced unchanged, not recomputed or re-ranked here. ` +
    `A return is a percentage already: a simple return for 1M/3M/6M/1Y and a CAGR for 3Y/5Y/10Y. ` +
    `A rank is "rank of peerCount" WITHIN THE SCHEME'S OWN COHORT, not against the whole list. ` +
    `A blank return means no return for that period; a blank rank means the cohort was too small to rank — NEITHER IS A ZERO. ` +
    `Source: ${m.source || 'AmfiBeas'}. Exported ${new Date().toISOString()}.`;

  const columns = [
    { header: 'Scheme code', key: 'code', width: 14, get: (r) => r.schemecode },
    { header: 'Scheme', key: 'name', width: 46, get: (r) => r.fundName },
    { header: 'Classification', key: 'cls', width: 26, get: (r) => r.classification || '' },
    { header: 'Plan', key: 'plan', width: 10, get: (r) => (r.plan && r.plan !== 'unknown' ? cap(r.plan) : '') },
    { header: 'Option', key: 'opt', width: 10, get: (r) => (r.option && r.option !== 'unknown' ? (r.option === 'idcw' ? 'IDCW' : cap(r.option)) : '') },
  ];
  for (const p of periods) {
    const label = fundReturns.PERIOD_LABEL[p] || p;
    columns.push({
      header: `${label} return %`,
      key: `r_${p}`,
      width: 16,
      get: (r) => {
        const v = r.returns?.[p]?.return;
        return v == null ? '' : Number(v.toFixed(2));
      },
    });
    columns.push({
      header: `${label} rank`,
      key: `k_${p}`,
      width: 14,
      get: (r) => {
        const cell = r.returns?.[p];
        return !cell || cell.rank == null ? '' : `${cell.rank}/${cell.peerCount ?? ''}`;
      },
    });
  }

  await exportSheets({
    filename: `glow-fund-returns-${todayStamp()}`,
    banner,
    sheets: [{ name: 'Returns & Ranking', columns, rows: visible }],
  });
}
