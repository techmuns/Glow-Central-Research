// tabs/family-book.js — THE FAMILY OFFICE BOOK: every position the wealth platforms' statements
// carry, consolidated, as one table. GLOW-OWNED.
//
// The book is assembled offline in techmuns/GlowVentures from the PDF statements each platform
// issues, baked into `src/data/glowData.ts` there, and copied here daily as `public/data/book.json`
// by `scripts/build-book.mjs` (see `.github/workflows/series-refresh.yml`). This tab renders it and
// computes almost nothing:
//
//   • THE FIGURES ARE THE STATEMENTS'. Value, cost, P&L and return are each platform's own mark on
//     its report date, which is printed on every row. The one figure this tab derives is the EOD
//     mark — quantity × the technicals feed's close, listed symbols only — and it is headed
//     "EOD mark (derived)" so it can never be read as the statement's.
//   • A NULL IS NOT ZERO. A depository does not know what shares cost; an AIF unit has no price per
//     unit. Those cells are em dashes with the reason in the title, and the totals say how many
//     rows carried no figure.
//   • COUNT EACH dedupeGroup ONCE. The same AIF folio is reported on two members' statements. Both
//     rows are kept and flagged; the consolidated total and every weight count the holding once,
//     exactly as GlowVentures does — see `counted()` in js/data/book.js.
//   • THE RING-FENCED PROMOTER HOLDING IS OUTSIDE THE BOOK, on both dashboards. It is named in the
//     provenance modal with its value and is in no total here.
//
// Scope: the book is the book under Portfolio and Universe — there is no wider universe of the
// family's positions. Watchlist narrows to the starred symbols. The pill says which.

import { sectionHead, statStrip, scoreTable, openDrill, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCrore, formatRupee, formatPct, formatDate } from '../core/format.js';
import { todayStamp } from '../ui/export.js';
import * as watchlist from '../core/watchlist.js';
import * as book from '../data/book.js';
import * as technicals from '../data/technicals.js';

export const meta = {
  id: 'family-book',
  title: 'Family Book',
  subtitle: 'The family office book as the wealth platforms’ statements print it — every account, consolidated, synced daily from GlowVentures.',
  subviews: [],
  // An empty watchlist must not replace the book with the shell's "add companies" panel: the book
  // is there whether or not anything is starred, and the pill says the watchlist is empty.
  allowEmptyScope: true,
};

// ---- state ------------------------------------------------------------------------------------
let ctxRef = null;
let token = 0;
let tableView = null;
let unsubWatch = null;
let marksLoading = null;

// ---- helpers ----------------------------------------------------------------------------------
const crore = (rupees) => (Number.isFinite(rupees) ? rupees / 1e7 : null);
const fmtCr = (rupees, decimals = 2) => (Number.isFinite(rupees) ? formatCrore(crore(rupees), { decimals }) : '—');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const chip = (label, title = '', tone = 'neutral') => {
  const cls =
    tone === 'good' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : tone === 'brand' ? 'bg-indigo-50 text-indigo-800 ring-indigo-200'
        : tone === 'warn' ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : tone === 'bad' ? 'bg-rose-50 text-rose-700 ring-rose-200'
            : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
};

const dash = (title) => `<span class="text-slate-400" title="${escapeHtml(title)}">—</span>`;
const toneOf = (v) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-700');

/** The EOD mark, derived: quantity × the technicals feed's close. Null wherever either is missing. */
function eodMark(row) {
  if (!row.symbol || !technicals.isLoaded()) return null;
  const t = technicals.byTicker(row.symbol);
  const cmp = num(t?.cmp);
  const qty = num(row.quantity);
  if (!t || cmp == null || qty == null) return null;
  return { close: cmp, date: t.bar_date || null, value: qty * cmp };
}

function scopeRows(ctx) {
  return book.forScope(ctx.scope, ctx.scope === 'watchlist' ? watchlist.tickers() : null);
}

function scopePill(ctx, rows) {
  const m = book.meta();
  if (ctx.scope === 'watchlist') {
    const tracked = watchlist.size();
    if (!tracked) return chip('Watchlist · nothing starred yet', 'Star a company anywhere on the dashboard to narrow the book to it here.', 'brand');
    return chip(`Watchlist · ${formatNumber(rows.length)} of ${formatNumber(m.counted)} positions`, `${formatNumber(tracked)} starred symbol(s); ${formatNumber(rows.length)} book position(s) are filed under them.`, 'brand');
  }
  const label = ctx.scope === 'universe' ? 'Universe' : 'Portfolio';
  return chip(`${label} · the whole book · ${formatNumber(m.counted)} positions`, 'The book is the book under Portfolio and Universe alike — there is no wider universe of the family’s positions to widen to.', ctx.scope === 'universe' ? 'brand' : 'neutral');
}

// ---- the panel --------------------------------------------------------------------------------

function unavailablePanel(reason) {
  return `
    <div class="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100" data-book-unavailable>
      <div class="text-sm font-semibold text-slate-900">The book could not be read</div>
      <p class="mt-2 text-sm text-slate-600">${escapeHtml(reason)}</p>
      <p class="mt-2 text-xs text-slate-500">The file is <code class="rounded bg-slate-100 px-1">public/data/book.json</code>, written by <code class="rounded bg-slate-100 px-1">scripts/build-book.mjs</code> from techmuns/GlowVentures and refreshed daily by the GlowVentures copy workflow. Nothing is shown in its place — an empty table would claim the family holds nothing.</p>
    </div>`;
}

function paint(ctx) {
  const root = ctx.root;
  const m = book.meta();
  if (!m) {
    root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}${unavailablePanel('book.json did not load.')}`;
    return;
  }
  const rows = scopeRows(ctx);
  const value = book.valueOf(rows);
  const isWatchlist = ctx.scope === 'watchlist';
  const withSymbol = rows.filter((r) => r.symbol).length;
  const noCost = rows.filter((r) => num(r.costBasis) == null).length;
  const marked = rows.filter((r) => eodMark(r)).length;
  const reconciled = m.residual === 0;

  const stats = statStrip([
    {
      label: isWatchlist ? 'Starred positions · statement value' : 'Consolidated value',
      value: fmtCr(isWatchlist ? value : m.totalValue),
      note: isWatchlist
        ? `${formatNumber(rows.length)} positions filed under starred symbols`
        : `each duplicate report counted once · ${fmtCr(m.doubleCounted)} collapsed`,
      help: {
        title: 'Consolidated value',
        body: 'The sum of every position’s statement mark, counting a holding reported on two members’ statements once — exactly as GlowVentures computes its headline. It is the statements’ figure, not a live one: each account’s report date is on its rows, and the newest is on the freshness card. The ring-fenced promoter holding is outside it on both dashboards.',
      },
    },
    {
      label: 'Listed · private',
      value: isWatchlist ? fmtCr(book.valueOf(rows.filter((r) => !book.isPrivate(r.assetClass)))) : `${fmtCr(m.listedValue, 1)} · ${fmtCr(m.privateValue, 1)}`,
      note: isWatchlist ? 'listed only — starred symbols are listed by definition' : 'split by what each holding IS: an exchange mark, or a manager’s',
      help: {
        title: 'Listed versus private',
        body: 'Listed is equity, ETFs, mutual funds and cash — anything with an exchange or a daily NAV behind it. Private is AIF units, unlisted holdings and structured products, marked by their manager. The class list mirrors GlowVentures’ own, and the private figure is summed from the rows, never total minus listed, so an unnamed class cannot silently become private.',
      },
    },
    {
      label: 'Positions · accounts · owners',
      value: `${formatNumber(rows.length)} · ${formatNumber(isWatchlist ? new Set(rows.map((r) => r.accountId)).size : m.accounts)} · ${formatNumber(isWatchlist ? new Set(rows.map((r) => r.ownerId)).size : m.owners)}`,
      note: `${formatNumber(withSymbol)} filed under an NSE symbol · ${formatNumber(noCost)} with no cost on the statement${m.accountsWithoutPositions && !isWatchlist ? ` · ${formatNumber(m.accountsWithoutPositions)} accounts carry no valuation` : ''}`,
      help: {
        title: 'What is counted',
        body: 'Positions are rows on a platform statement. A row with no NSE symbol is a fund unit, an AIF, cash or an unlisted holding — it is in every total and gets no live mark. A missing cost is a statement that did not carry one (a depository does not know what shares cost); it is a dash, never a zero, and never a 100% gain. Accounts with no valuation are ones whose documents report income and distributions only; their units are marked in another account.',
      },
    },
    {
      hero: true,
      label: 'Statements as of',
      value: m.asOf ? formatDate(m.asOf) : '—',
      note: `synced from GlowVentures${m.builtFrom ? `@${m.builtFrom}` : ''} · ${reconciled ? 'sums reconcile to the upstream headline' : `residual ${fmtCr(m.residual)} vs upstream`}`,
    },
  ]);

  const columns = [
    { label: 'Class', get: (r) => r.assetClass || '—', sortable: true },
    { label: 'Owner', get: (r) => r.owner || '—', sortable: true },
    { label: 'Provider · account', get: (r) => `${r.provider || '—'}${r.strategy ? ` · ${r.strategy}` : ''}`, sortable: true },
    { label: 'Qty', align: 'right', sortable: true, sortValue: (r) => num(r.quantity) ?? -Infinity, html: true, get: (r) => (num(r.quantity) == null ? dash('The statement carries no quantity for this line') : `<span class="tabular-nums">${formatNumber(r.quantity, { decimals: Number.isInteger(r.quantity) ? 0 : 3 })}</span>`) },
    { label: 'Statement value (₹ Cr)', align: 'right', sortable: true, sortValue: (r) => num(r.marketValue) ?? -Infinity, html: true, get: (r) => `<span class="tabular-nums font-semibold" title="The platform’s own mark on ${escapeHtml(r.accountAsOf || 'its report date')}">${escapeHtml(formatNumber(crore(r.marketValue), { decimals: 2 }))}</span>` },
    { label: 'Weight', align: 'right', sortable: true, sortValue: (r) => book.weightPct(r) ?? -Infinity, html: true, get: (r) => { const w = book.weightPct(r); return w == null ? dash('No consolidated total to weigh against') : `<span class="tabular-nums" title="Share of the consolidated book, each duplicate counted once">${escapeHtml(formatPct(w, { decimals: 2, signed: false }))}</span>`; } },
    { label: 'Cost (₹ Cr)', align: 'right', sortable: true, sortValue: (r) => num(r.costBasis) ?? -Infinity, html: true, get: (r) => (num(r.costBasis) == null ? dash('The statement carries no cost basis for this line — not zero') : `<span class="tabular-nums">${escapeHtml(formatNumber(crore(r.costBasis), { decimals: 2 }))}</span>`) },
    { label: 'Unrealised (₹ Cr)', align: 'right', sortable: true, sortValue: (r) => num(r.unrealizedPnL) ?? -Infinity, html: true, get: (r) => (num(r.unrealizedPnL) == null ? dash('No cost on the statement, so no P&L — not zero') : `<span class="tabular-nums ${toneOf(r.unrealizedPnL)}">${escapeHtml(formatNumber(crore(r.unrealizedPnL), { decimals: 2 }))}</span>`) },
    { label: 'Return', align: 'right', sortable: true, sortValue: (r) => num(r.returnPct) ?? -Infinity, html: true, get: (r) => (num(r.returnPct) == null ? dash('The statement carries no return for this line') : `<span class="tabular-nums ${toneOf(r.returnPct)}">${escapeHtml(formatPct(r.returnPct, { decimals: 1 }))}</span>`) },
    { label: 'EOD mark (derived)', align: 'right', sortable: true, sortValue: (r) => eodMark(r)?.value ?? -Infinity, html: true, get: (r) => { const mk = eodMark(r); if (!mk) return dash(r.symbol ? (technicals.isLoaded() ? 'Not in the technicals feed — no EOD close to mark against' : 'EOD closes are still loading') : 'No NSE symbol — nothing to mark against'); return `<span class="tabular-nums text-slate-600" title="quantity × EOD close ${escapeHtml(formatRupee(mk.close))} on ${escapeHtml(mk.date || '?')} — derived here, not the statement’s figure">${escapeHtml(formatNumber(crore(mk.value), { decimals: 2 }))}</span>`; } },
    { label: 'Statement date', get: (r) => (r.accountAsOf ? formatDate(r.accountAsOf) : '—'), sortable: true, sortValue: (r) => r.accountAsOf || '' },
  ];

  const classes = [...new Set(rows.map((r) => r.assetClass).filter(Boolean))].sort();
  const owners = [...new Set(rows.map((r) => r.owner).filter(Boolean))].sort();
  const providers = [...new Set(rows.map((r) => r.provider).filter(Boolean))].sort();

  const table = scoreTable({
    rows,
    key: (r) => `${r.securityKey || r.security}|${r.accountId}${r.memberId ? `|${r.memberId}` : ''}`,
    watchKey: (r) => r.symbol || null,
    watchName: (r) => r.security,
    name: (r) => r.security,
    nameLabel: 'Security',
    // "Unclassified" is the upstream's word for a sector it could not map; the provider's own
    // sector label is more use on the row than that word.
    sub: (r) => `${r.symbol ? `${r.symbol} · ` : ''}${(r.sector && r.sector !== 'Unclassified' ? r.sector : r.providerSector) || r.assetClass || ''}${r.alsoReportedUnder?.length ? ' · also reported under another member' : ''}`,
    nameMaxPx: 260,
    showAvatar: false,
    dense: true,
    wrapHeads: true,
    columns,
    // The kit's "no filter" value is `'all'`, and the <select> shows whichever option carries it —
    // so every list leads with one, or the control displays its first real option while filtering
    // nothing, which is a control disagreeing with its state.
    filters: [
      { label: 'Asset class', options: [{ value: 'all', label: 'All classes' }, ...classes.map((c) => ({ value: c, label: c }))], match: (r, v) => r.assetClass === v },
      { label: 'Owner', options: [{ value: 'all', label: 'All owners' }, ...owners.map((o) => ({ value: o, label: o }))], match: (r, v) => r.owner === v },
      { label: 'Provider', options: [{ value: 'all', label: 'All providers' }, ...providers.map((p) => ({ value: p, label: p }))], match: (r, v) => r.provider === v },
    ],
    searchable: (r) => `${r.security} ${r.symbol || ''} ${r.owner || ''} ${r.provider || ''} ${r.strategy || ''} ${r.sector || ''}`,
    initialSort: { key: 'Statement value (₹ Cr)', dir: 'desc' },
    initialView: tableView,
    countNoun: 'positions',
    emptyMessage: isWatchlist ? 'No book position is filed under a starred symbol.' : 'No position matches your filters.',
    exportName: `glow-family-book-${todayStamp()}`,
    onRowClick: (r) => openPositionDrill(r),
    stickyHead: 'max(360px, calc(100vh - 340px))',
  });

  root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: meta.subtitle,
      meta: `${scopePill(ctx, rows)}${chip(`Statements · as of ${m.asOf ? formatDate(m.asOf) : '?'}`, 'Every figure is a wealth platform’s own statement mark; this is the newest report date in the book.', 'good')}${marked ? chip(`${formatNumber(marked)} EOD-marked`, 'Rows with a derived EOD mark beside the statement value — listed symbols the technicals feed carries.') : ''}<button type="button" data-book-info class="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" title="Where these figures come from">Sources ?</button>`,
    })}
    ${stats.html}
    <div class="mt-4 fade-in" data-book-table>${table.html}</div>
    <p class="mt-3 text-xs text-slate-500" data-book-note>
      ${escapeHtml(`Statement value, cost, unrealised and return are each platform’s own figures on its report date. Weight is the row’s share of the consolidated value with each duplicate report counted once. EOD mark is derived here — quantity × the technicals feed’s close — for listed symbols only; a dash is a figure the statement does not carry, never a zero.`)}
      ${book.ringFenced().length ? escapeHtml(` The ring-fenced promoter holding (${book.ringFenced().map((p) => p.symbol || p.security).join(', ')}, ${fmtCr(m.ringFencedValue, 1)}) is outside every figure on this page, as it is upstream.`) : ''}
    </p>`;

  stats.wire(root);
  const disposeTable = table.wire(root);
  root.__disposeTable = disposeTable;
  tableView = table.view;

  root.querySelector('[data-book-info]')?.addEventListener('click', () => openProvenance());
}

function openPositionDrill(r) {
  const mk = eodMark(r);
  const items = (pairs) => pairs.map(([label, value, note]) => ({ label, value: value ?? '—', note }));
  openDrill({
    name: r.security,
    sub: `${r.symbol ? `${r.symbol} · ` : ''}${r.assetClass || ''}${r.sector ? ` · ${r.sector}` : ''}`,
    headerStats: [
      { label: 'Statement value', value: fmtCr(r.marketValue) },
      { label: 'Weight', value: book.weightPct(r) == null ? '—' : formatPct(book.weightPct(r), { decimals: 2, signed: false }) },
      { label: 'Return', value: num(r.returnPct) == null ? '—' : formatPct(r.returnPct, { decimals: 1 }) },
    ],
    banner: r.alsoReportedUnder?.length
      ? { title: 'Reported on more than one statement', body: `Also reported under ${r.alsoReportedUnder.join(', ')} with identical figures. Both rows are shown; the consolidated total counts this holding once.` }
      : null,
    groups: [
      {
        category: 'The statement',
        items: items([
          ['Owner', r.owner],
          ['Provider · account', `${r.provider || '—'}${r.strategy ? ` · ${r.strategy}` : ''}`, r.engagement ? `Engagement: ${r.engagement}` : null],
          ['Report date', r.accountAsOf ? formatDate(r.accountAsOf) : '—', 'The platform’s own valuation date for this account'],
          ['Quantity', num(r.quantity) == null ? '—' : formatNumber(r.quantity, { decimals: Number.isInteger(r.quantity) ? 0 : 3 })],
          ['Statement value', fmtCr(r.marketValue), 'The platform’s mark — not a live price'],
          ['Cost basis', num(r.costBasis) == null ? '—' : fmtCr(r.costBasis), num(r.costBasis) == null ? 'The statement carries no cost for this line. Not zero.' : (r.costBasisSource ? `Source: ${r.costBasisSource}` : null)],
          ['Unrealised P&L', num(r.unrealizedPnL) == null ? '—' : fmtCr(r.unrealizedPnL), num(r.unrealizedPnL) == null ? 'No cost, so no P&L' : null],
          ['Average cost · statement price', `${num(r.avgCost) == null ? '—' : formatRupee(r.avgCost)} · ${num(r.currentPrice) == null ? '—' : formatRupee(r.currentPrice)}`],
          ['Dividends received', num(r.dividendReceived) == null ? '—' : formatRupee(r.dividendReceived, { decimals: 0 })],
          ['Position IRR', num(r.positionIrrPct) == null ? '—' : formatPct(r.positionIrrPct, { decimals: 1 }), num(r.positionIrrPct) == null ? 'Not reported for this line' : 'As the platform reports it'],
        ]),
      },
      {
        category: 'Derived here',
        items: items([
          ['EOD mark', mk ? fmtCr(mk.value) : '—', mk ? `quantity × ${formatRupee(mk.close)} EOD close on ${mk.date || '?'} from the technicals feed` : (r.symbol ? 'Not in the technicals feed' : 'No NSE symbol to mark against')],
          ['Weight in the book', book.weightPct(r) == null ? '—' : formatPct(book.weightPct(r), { decimals: 2, signed: false }), 'Share of the consolidated value, each duplicate counted once'],
        ]),
      },
      {
        category: 'Provenance',
        items: items([
          ['Source', 'techmuns/GlowVentures · src/data/glowData.ts', 'Generated there from the PDF statements in its archive; copied here daily as public/data/book.json'],
          ['Synced from', book.meta()?.builtFrom ? `GlowVentures@${book.meta().builtFrom}` : 'GlowVentures'],
        ]),
      },
    ],
  });
}

function openProvenance() {
  const m = book.meta() || {};
  const ring = book.ringFenced();
  const row = (label, value) => `<div class="flex items-start justify-between gap-4 py-1.5"><dt class="text-xs text-slate-500">${escapeHtml(label)}</dt><dd class="text-right text-sm tabular-nums text-slate-800">${escapeHtml(value)}</dd></div>`;
  openModal(
    `
    <div class="p-6">
      <div class="text-xs font-bold uppercase tracking-wider text-slate-400">Family Book · sources</div>
      <h3 class="font-display mt-1 text-xl font-bold text-slate-900">Where these figures come from</h3>
      <p class="mt-3 text-sm text-slate-600"><strong>Real, and not computed here.</strong> Every position is a row on a statement issued by one of the family’s wealth platforms. techmuns/GlowVentures reads those PDF statements, reconciles them and bakes the consolidated book into a generated file; <code class="rounded bg-slate-100 px-1">scripts/build-book.mjs</code> copies that file here as <code class="rounded bg-slate-100 px-1">public/data/book.json</code>, daily, with the same nulls in the same places.</p>
      <dl class="mt-4 divide-y divide-slate-100 rounded-xl bg-slate-50 px-4 py-1 ring-1 ring-slate-100">
        ${row('Statements as of', m.asOf ? formatDate(m.asOf) : '—')}
        ${row('Synced from', m.builtFrom ? `techmuns/GlowVentures@${m.builtFrom}` : 'techmuns/GlowVentures')}
        ${row('Consolidated value (upstream headline)', fmtCr(m.totalValue))}
        ${row('Consolidated value (summed here, each duplicate once)', fmtCr(m.countedValue))}
        ${row('Reconciliation residual', m.residual == null ? '—' : m.residual === 0 ? '0 — reconciles' : fmtCr(m.residual))}
        ${row('Duplicate reports collapsed', `${fmtCr(m.doubleCounted)} across ${formatNumber((m.positions || 0) - (m.counted || 0))} row(s)`)}
        ${row('Positions · counted once', `${formatNumber(m.positions)} · ${formatNumber(m.counted)}`)}
        ${row('Accounts · with no valuation', `${formatNumber(m.accounts)} · ${formatNumber(m.accountsWithoutPositions)}`)}
        ${row('Rows with no cost on the statement', formatNumber(m.unpricedCost))}
        ${row('Ring-fenced, outside every figure', ring.length ? `${ring.map((p) => p.symbol || p.security).join(', ')} · ${fmtCr(m.ringFencedValue, 1)}` : 'none')}
      </dl>
      <div class="mt-4 space-y-2 text-sm text-slate-600">
        <p><strong>Statement value, cost, unrealised, return</strong> — the platform’s own figures on its report date; nothing is re-marked. <strong>Weight</strong> — the row’s share of the consolidated value. <strong>EOD mark (derived)</strong> — quantity × the technicals feed’s EOD close, listed symbols only, so a statement dated weeks ago can be read beside a recent close without either being mistaken for the other.</p>
        <p><strong>A dash is a figure the statement does not carry</strong> — a depository does not know what shares cost, an AIF unit has no price per unit — and is never rendered as zero, summed as zero, or read as a 100% gain.</p>
        <p><strong>The ring-fenced promoter holding</strong> is kept on its own page upstream and out of every book-wide figure there; it is carried here the same way and is in no total on this dashboard.</p>
        <p><strong>Ask Research</strong> answers portfolio questions from this same file — the illustrative FIFO ledger under Portfolio Analytics is no longer its source.</p>
        <p class="text-xs text-slate-500">Refresh: <code class="rounded bg-slate-100 px-1">.github/workflows/series-refresh.yml</code>, 03:30 UTC daily, needs <code class="rounded bg-slate-100 px-1">GLOWVENTURES_READ_TOKEN</code>. By hand: <code class="rounded bg-slate-100 px-1">GLOWVENTURES_DIR=… node scripts/build-book.mjs</code>.</p>
      </div>
    </div>`,
    { size: 'wide' }
  );
}

// ---- lifecycle --------------------------------------------------------------------------------

export function render(ctx) {
  ctxRef = ctx;
  const mine = ++token;
  ctx.root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}<div class="rounded-2xl bg-white p-6 text-sm text-slate-500 shadow-sm ring-1 ring-slate-100">Reading the book…</div>`;

  book.load()
    .then(() => {
      if (mine !== token || !ctxRef) return;
      paint(ctxRef);
      // The EOD marks are a second, optional pass: the statements' figures paint first, and the
      // derived column fills in when the technicals feed lands — never the other way round.
      if (!technicals.isLoaded()) {
        marksLoading = marksLoading || technicals.load().catch(() => null).finally(() => { marksLoading = null; });
        marksLoading.then(() => { if (mine === token && ctxRef && technicals.isLoaded()) paint(ctxRef); });
      }
    })
    .catch((err) => {
      if (mine !== token || !ctxRef) return;
      ctxRef.root.innerHTML = `${sectionHead({ title: meta.title, description: meta.subtitle })}${unavailablePanel(err?.message || 'book.json could not be read.')}`;
    });

  // Guard on what the lifecycle owns (ctxRef), never on a token captured at subscribe time — the
  // rule CLAUDE.md records the filings tabs breaking.
  if (!unsubWatch) {
    unsubWatch = watchlist.onChange(() => {
      if (ctxRef && ctxRef.scope === 'watchlist' && book.isLoaded()) paint(ctxRef);
    });
  }
}

export function destroy() {
  token += 1;
  if (ctxRef?.root?.__disposeTable) {
    try { ctxRef.root.__disposeTable(); } catch { /* already gone */ }
  }
  ctxRef = null;
  tableView = null;
  if (unsubWatch) { unsubWatch(); unsubWatch = null; }
}
