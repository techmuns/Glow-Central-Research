// tabs/family-book-equity.js — DIRECT EQUITY: the family's listed shareholdings, one row per
// COMPANY rather than one per statement line. GLOW-OWNED.
//
// All Holdings beside it is every row on every statement, every asset class. This is the narrowing
// the desk actually reads a book by: the listed equity only, with the five accounts that hold SBI
// collapsed into one line that says how much SBI the family owns. Both views read the same
// `counted()` rows through `js/data/book.js`, so they cannot disagree.
//
// EVERYTHING ON IT IS THE STATEMENTS', AND THE FEW DERIVED FIGURES SAY SO. Quantity, cost, market
// value, unrealised P&L, dividends and the published IRRs are each a wealth platform's own figure,
// summed where a sum is a sum of rupees or shares. Four things are derived, and every one is
// labelled on the column, in the cell's title and in the drill:
//
//   • RETURN — the summed unrealised P&L over the summed cost. Over a company held in one account
//     it reproduces that statement's own `returnPct` to the second decimal (asserted).
//   • AVERAGE COST — the summed cost over the shares that cost covers. Never over the whole
//     quantity, which would divide a partial cost by a complete holding and print an average
//     cheaper than anybody paid.
//   • WEIGHT — the company's share of the consolidated book, each duplicate report counted once.
//   • CMP AND MARKET CAP — not GlowVentures figures at all. The statements print a mark per
//     account on that account's own report date, which is not a price a reader can act on and is
//     not one number per company. These two come from this dashboard's own technicals capture and
//     carry its bar date on their face, exactly as the EOD mark on All Holdings does.
//
// AND THE FIELDS THE STATEMENTS DO NOT CARRY ARE DASHES, NOT GUESSES. First buy is `heldSince` —
// the oldest unit still held — which needs a dated lot register, and three positions in this corpus
// have one. Last trade is the newest row on the transaction tape, whose window is the statements'
// financial year to date and IS NOT A HOLDING PERIOD, so a company bought in 2019 and untouched
// since correctly shows no trade rather than a date that would read as when it was bought. Every
// one of those dashes carries the reason in its title.

import { sectionHead, statStrip, scoreTable, openDrill, openModal } from '../ui/screener.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatCrore, formatRupee, formatPct, formatDate } from '../core/format.js';
import { todayStamp } from '../ui/export.js';
import * as book from '../data/book.js';
import * as technicals from '../data/technicals.js';
import { viewSwitchHtml, DIRECT_EQUITY_VIEW } from './family-book-views.js';

const crore = (rupees) => (Number.isFinite(rupees) ? rupees / 1e7 : null);
const fmtCr = (rupees, decimals = 2) => (Number.isFinite(rupees) ? formatCrore(crore(rupees), { decimals }) : '—');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dash = (title) => `<span class="text-slate-400" title="${escapeHtml(title)}">—</span>`;
const toneOf = (v) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-700');
const cell = (text, { tone = '', title = '', weight = '' } = {}) =>
  `<span class="tabular-nums ${tone} ${weight}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(text)}</span>`;

const chip = (label, title = '', tone = 'neutral') => {
  const cls =
    tone === 'good' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
      : tone === 'brand' ? 'bg-indigo-50 text-indigo-800 ring-indigo-200'
        : tone === 'warn' ? 'bg-amber-50 text-amber-700 ring-amber-200'
          : 'bg-slate-100 text-slate-600 ring-slate-200';
  return `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
};

/**
 * THE MARKET DATA IS THIS DASHBOARD'S, NOT THE BOOK'S, and it is kept visibly apart from it.
 *
 * `technicals.json` is the EOD capture every research tab already prices from. It carries the close
 * and its bar date, and Screener's own market-cap string — reproduced as printed, never re-parsed
 * into a number we would then have to explain the units of.
 */
function marketData(company) {
  if (!company.symbol || !technicals.isLoaded()) return null;
  // `rowFor`, not `byTicker` — see the note on it in js/data/technicals.js.
  const t = technicals.rowFor(company.symbol);
  if (!t) return null;
  return { cmp: num(t.cmp), marketCap: t.marketCap || null, date: t.bar_date || null };
}

/** The newest trade on the tape for this company, or null. Needs the ledger; absent before it lands. */
function lastTrade(company) {
  if (!book.isLedgerLoaded()) return null;
  const rows = company.securityKeys.flatMap((k) => book.transactionsFor(k));
  if (!rows.length) return null;
  return rows.reduce((a, b) => (b.date > a.date ? b : a));
}

/**
 * WHICH STAGE OF A DIVIDEND A ROW IS, READ OFF THE STATEMENT'S OWN COLUMNS.
 *
 * A dividend statement books one dividend three times: declared on the ex-date as a RECEIVABLE,
 * received weeks later net of TDS, and the receivable reversed on the same day by an equal
 * negative. All three are the statement's own rows and all three are reproduced — but three lines
 * reading "dividend", one of them for minus the whole amount, look like a feed printing a mistake.
 * The word is read from `received` and `netAmount`, which is the statement saying which it is; it
 * is not our judgement, and nothing here sums these (the Dividends column is the platform's own
 * cumulative `dividendReceived`, so a stage cannot be counted twice).
 */
function incomeStage(i) {
  if (i.kind && i.kind !== 'dividend') return '';
  if (num(i.received)) return 'received';
  if (num(i.netAmount) != null && i.netAmount < 0) return 'receivable reversed';
  if (num(i.receivable)) return 'declared';
  return '';
}

function ledgerRows(company) {
  const txns = company.securityKeys.flatMap((k) => book.transactionsFor(k));
  const income = company.securityKeys.flatMap((k) => book.incomeFor(k));
  const lots = company.securityKeys.flatMap((k) => book.lotsFor(k));
  return { txns, income, lots };
}

// ---- the table ---------------------------------------------------------------------------------

function columnsFor(lm) {
  const traded = lm?.securitiesTraded || new Set();
  const windowNote = lm?.window
    ? `The transaction statements cover ${lm.window.declaredFrom || '?'} to ${lm.window.declaredTo || '?'} — that is the statements' own window, not a holding period.`
    : 'The transaction statements have not been read.';
  return [
    {
      label: 'CMP (EOD)',
      align: 'right',
      sortable: true,
      sortValue: (c) => marketData(c)?.cmp ?? -Infinity,
      html: true,
      get: (c) => {
        const md = marketData(c);
        if (!md || md.cmp == null) {
          return dash(c.symbol
            ? (technicals.isLoaded() ? `${c.symbol} is not in this dashboard's technicals capture, so there is no EOD close to show` : 'EOD closes are still loading')
            : 'No NSE symbol on the statements — nothing to price');
        }
        return cell(formatRupee(md.cmp), { title: `EOD close on ${md.date || '?'} from this dashboard's technicals capture — not a figure from the statements` });
      },
    },
    {
      label: 'Market cap',
      align: 'right',
      sortable: true,
      // Screener's own string ("1,11,661 Cr."), reproduced. Sorted on the digits it prints so the
      // column orders correctly without a second, differently-rounded number of ours beside it.
      sortValue: (c) => {
        const raw = marketData(c)?.marketCap;
        if (!raw) return -Infinity;
        const n = Number(String(raw).replace(/[^\d.]/g, ''));
        return Number.isFinite(n) ? n : -Infinity;
      },
      html: true,
      get: (c) => {
        const md = marketData(c);
        if (!md?.marketCap) return dash(c.symbol ? 'No market capitalisation in this dashboard\'s technicals capture for this symbol' : 'No NSE symbol on the statements');
        return cell(String(md.marketCap), { title: `As the technicals capture prints it, dated ${md.date || '?'} — this dashboard's figure, not the statements'` });
      },
    },
    {
      label: 'Qty',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.quantity ?? -Infinity,
      html: true,
      get: (c) => (c.quantity == null
        ? dash('No statement carries a quantity for this holding')
        : cell(formatNumber(c.quantity, { decimals: Number.isInteger(c.quantity) ? 0 : 3 }), { title: c.rowCount > 1 ? `Summed across ${c.rowCount} statement lines` : '' })),
    },
    {
      label: 'Avg cost',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.avgCost ?? -Infinity,
      html: true,
      get: (c) => (c.avgCost == null
        ? dash('No statement carries a cost for this holding, so there is no average — not zero')
        : cell(formatRupee(c.avgCost), {
          title: c.costComplete
            ? 'Derived: the summed cost over the shares it covers'
            : `Derived over the ${c.costRows} of ${c.rowCount} statement line(s) that carry a cost — ${formatNumber(c.costedQty, { decimals: 0 })} of ${formatNumber(c.quantity, { decimals: 0 })} shares`,
        })),
    },
    {
      label: 'Cost (₹ Cr)',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.costBasis ?? -Infinity,
      html: true,
      get: (c) => (c.costBasis == null
        ? dash('No statement carries a cost basis for this holding. A depository does not know what shares cost — this is not zero.')
        : cell(formatNumber(crore(c.costBasis), { decimals: 2 }), {
          title: c.costComplete ? 'The statements\' own cost, summed' : `The statements' own cost over the ${c.costRows} of ${c.rowCount} line(s) that carry one`,
        })),
    },
    {
      label: 'Value (₹ Cr)',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.marketValue ?? -Infinity,
      html: true,
      get: (c) => cell(formatNumber(crore(c.marketValue), { decimals: 2 }), {
        weight: 'font-semibold',
        title: `Each platform's own mark on its report date${c.statementFrom !== c.statementTo ? `, ${c.statementFrom} to ${c.statementTo}` : ` (${c.statementTo || '?'})`}`,
      }),
    },
    {
      label: 'Weight',
      align: 'right',
      sortable: true,
      sortValue: (c) => book.weightOf(c.marketValue) ?? -Infinity,
      html: true,
      get: (c) => {
        const w = book.weightOf(c.marketValue);
        return w == null ? dash('No consolidated total to weigh against') : cell(formatPct(w, { decimals: 2, signed: false }), { title: 'Share of the consolidated book — every asset class, each duplicate report counted once' });
      },
    },
    {
      label: 'Unrealised (₹ Cr)',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.unrealizedPnL ?? -Infinity,
      html: true,
      get: (c) => (c.unrealizedPnL == null
        ? dash('No cost on any statement, so no P&L — not zero')
        : cell(formatNumber(crore(c.unrealizedPnL), { decimals: 2 }), {
          tone: toneOf(c.unrealizedPnL),
          title: c.costComplete
            ? 'The statements\' own unrealised P&L, summed'
            : `Over the ${c.costRows} of ${c.rowCount} line(s) that carry a cost — worth ${fmtCr(c.costedValue)} of this holding's ${fmtCr(c.marketValue)}`,
        })),
    },
    {
      label: 'Return',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.returnPct ?? -Infinity,
      html: true,
      get: (c) => (c.returnPct == null
        ? dash('No cost on any statement, so no return')
        : cell(formatPct(c.returnPct, { decimals: 1 }), {
          tone: toneOf(c.returnPct),
          title: `Derived: the summed unrealised P&L over the summed cost${c.costComplete ? '' : `, over the ${c.costRows} of ${c.rowCount} line(s) that carry one`}. Not annualised — that needs a purchase date.`,
        })),
    },
    {
      label: 'Reported XIRR',
      align: 'right',
      sortable: true,
      // Ordered on the highest published figure. There is no single number where the accounts
      // disagree, so there is nothing else honest to sort a range by.
      sortValue: (c) => c.irr.max ?? -Infinity,
      html: true,
      get: (c) => {
        if (!c.irr.values.length) {
          return dash('No statement behind this holding publishes a per-position IRR. Two of the family\'s providers do; the rest print no money-weighted return, and one cannot be computed without the cash flows.');
        }
        if (c.irr.agree) {
          return cell(formatPct(c.irr.single, { decimals: 1 }), {
            tone: toneOf(c.irr.single),
            title: `As published by ${c.irr.publishedBy === 1 ? 'the statement' : `all ${c.irr.publishedBy} statements that report one`}${c.irr.of > c.irr.publishedBy ? `, of ${c.irr.of} line(s)` : ''}. Reproduced, not computed here.`,
          });
        }
        // The range, compactly: one per-cent sign for two figures, because the column is already
        // the widest on a fourteen-column table and the title carries the whole claim.
        return cell(`${formatPct(c.irr.min, { decimals: 1 }).replace('%', '')} … ${formatPct(c.irr.max, { decimals: 1 })}`, {
          title: `${c.irr.publishedBy} accounts publish a per-position IRR for this holding and they differ — they bought on different days. A blended figure is not published and is not an IRR, so both ends are shown. Open the row for each account's own.`,
        });
      },
    },
    {
      label: 'Dividends (₹)',
      align: 'right',
      sortable: true,
      sortValue: (c) => c.dividends ?? -Infinity,
      html: true,
      get: (c) => (c.dividends == null
        ? dash('No statement behind this holding reports dividends received. Absent, not nil.')
        : cell(formatNumber(c.dividends, { decimals: 0 }), {
          title: c.dividendsComplete
            ? `Cumulative, as the statements report it${c.totalReturnPct == null ? '' : ` · total return including dividends ${formatPct(c.totalReturnPct, { decimals: 1 })}`}`
            : `Cumulative, over the ${c.dividendRows} of ${c.rowCount} line(s) that report dividends — so a total return over it would understate, and is not shown`,
        })),
    },
    {
      label: 'First buy',
      sortable: true,
      sortValue: (c) => c.heldSince || '',
      html: true,
      get: (c) => (c.heldSince
        ? cell(formatDate(c.heldSince), { title: 'The oldest unit still held, from a statement that publishes a dated lot register' })
        : dash('The statements behind this holding publish no dated lot register, so the date the oldest unit still held was bought is not in this corpus. It is not the first date on the transaction tape, which starts at the financial year.')),
    },
    {
      label: 'Last trade',
      sortable: true,
      sortValue: (c) => lastTrade(c)?.date || '',
      html: true,
      get: (c) => {
        const t = lastTrade(c);
        // THE DATE ANSWERS THE COLUMN. The side, size, price and account ride in the title and
        // every trade is in the drill: printing "· Sell" beside the date cost 55px on the widest
        // table here, and a Buy/Sell is not a pass/fail, so it cannot be a coloured glyph either.
        if (t) return cell(formatDate(t.date), { title: `${t.side} ${formatNumber(t.quantity, { decimals: 0 })} at ${t.price == null ? 'a price the statement did not print' : formatRupee(t.price)} in ${t.provider || '?'} ${t.accountNo || ''}. ${windowNote}` });
        if (!book.isLedgerLoaded()) return dash('The transaction statements are still loading');
        const everTraded = c.securityKeys.some((k) => traded.has(k));
        return dash(everTraded
          ? 'Traded in this window, but no row is filed under this holding'
          : `No trade in this holding appears on the transaction statements. ${windowNote} A holding bought earlier and untouched since correctly shows none.`);
      },
    },
  ];
}

// ---- the panel ---------------------------------------------------------------------------------

export function paintDirectEquity(ctx, { rows, scopePill, tableView, onView, provenanceButton }) {
  const m = book.meta();
  const lm = book.ledgerMeta();
  const companies = book.directEquity(rows);
  const totals = book.directEquityTotals(companies);
  const priced = companies.filter((c) => marketData(c)?.cmp != null).length;

  const stats = statStrip([
    {
      label: 'Direct equity · statement value',
      value: fmtCr(totals.value),
      note: `${formatNumber(totals.companies)} companies · ${formatNumber(totals.positions)} statement lines · ${book.weightOf(totals.value) == null ? '—' : formatPct(book.weightOf(totals.value), { decimals: 1, signed: false })} of the consolidated book`,
      help: {
        title: 'Direct equity',
        body: 'Every position the statements classify as Equity, consolidated by company: the five accounts holding SBI are one line here. Fund units, ETFs, AIF units and cash are not direct equity and are on All Holdings. The ring-fenced promoter holding is outside the book on both dashboards and is outside this too. The value is each platform’s own mark on its report date, summed — not a live figure.',
      },
    },
    {
      label: 'Cost basis · unrealised',
      value: totals.cost == null ? '—' : `${fmtCr(totals.cost, 1)} · ${fmtCr(totals.unrealised, 1)}`,
      note: totals.cost == null
        ? 'no statement behind these holdings carries a cost'
        : `${formatPct(totals.returnPct, { decimals: 1 })} over the ${formatNumber(totals.costRows)} of ${formatNumber(totals.positions)} lines that carry a cost, worth ${fmtCr(totals.costedValue, 1)}`,
      help: {
        title: 'What the return is measured over',
        body: 'The cost, the unrealised P&L and the return describe only the statement lines that carry a cost. A depository does not know what shares cost, so some lines have none — those are excluded from all three rather than counted as zero, which would report the whole market value as profit. The note says how many lines the figures cover and what those lines are worth, so the return is never read against a value it was not struck on. It is a simple return, not annualised: annualising needs a purchase date, and the statements publish one for three positions.',
      },
    },
    {
      label: 'Companies · accounts · owners',
      value: `${formatNumber(totals.companies)} · ${formatNumber(totals.accounts)} · ${formatNumber(totals.owners)}`,
      note: `${formatNumber(totals.companiesWithoutCost)} with no cost on any statement · ${formatNumber(totals.irrPublished)} with a published IRR · ${formatNumber(priced)} priced by the technicals capture`,
      help: {
        title: 'What is counted',
        body: 'One row per company across every owner and account. A company with no cost on any statement is shown with dashes in the cost, P&L and return columns — it is a real holding whose purchase price this corpus does not carry. A published IRR is a money-weighted return the provider itself computed; two of the family’s providers publish one and the rest do not, and nothing here averages or blends them. Priced means this dashboard’s own EOD technicals capture carries the symbol, which is where the CMP and market cap columns come from — neither is a GlowVentures figure.',
      },
    },
    {
      hero: true,
      label: 'Statements as of',
      value: m.asOf ? formatDate(m.asOf) : '—',
      note: lm?.window?.declaredFrom
        ? `trades ${lm.window.declaredFrom} → ${lm.window.declaredTo} · not a holding period`
        : `synced from GlowVentures${m.builtFrom ? `@${m.builtFrom}` : ''}`,
    },
  ]);

  const sectors = [...new Set(companies.map((c) => c.sector).filter(Boolean))].sort();
  const owners = [...new Set(companies.flatMap((c) => c.owners))].sort();
  const providers = [...new Set(companies.flatMap((c) => c.providers))].sort();

  const table = scoreTable({
    rows: companies,
    key: (c) => c.key,
    watchKey: (c) => c.symbol || null,
    watchName: (c) => c.name,
    name: (c) => c.name,
    nameLabel: 'Company',
    // The sector rides in the sub-line rather than in a column of its own: a column would be a
    // second copy of what is already under every name, and this table is wide. It keeps its filter
    // and its own column in the export.
    sub: (c) => `${c.symbol ? `${c.symbol} · ` : ''}${c.sector || c.providerSector || 'Sector not classified'}${c.rowCount > 1 ? ` · ${c.rowCount} accounts` : ''}`,
    nameMaxPx: 178,
    showAvatar: false,
    showRank: false,
    dense: true,
    wrapHeads: true,
    columns: columnsFor(lm),
    filters: [
      { label: 'Sector', options: [{ value: 'all', label: 'All sectors' }, ...sectors.map((s) => ({ value: s, label: s }))], match: (c, v) => c.sector === v },
      { label: 'Owner', options: [{ value: 'all', label: 'All owners' }, ...owners.map((o) => ({ value: o, label: o }))], match: (c, v) => c.owners.includes(v) },
      { label: 'Provider', options: [{ value: 'all', label: 'All providers' }, ...providers.map((p) => ({ value: p, label: p }))], match: (c, v) => c.providers.includes(v) },
    ],
    searchable: (c) => `${c.name} ${c.symbol || ''} ${c.sector || ''} ${c.providerSector || ''} ${c.owners.join(' ')} ${c.providers.join(' ')} ${c.rows.map((r) => r.security).join(' ')}`,
    initialSort: { key: 'Value (₹ Cr)', dir: 'desc' },
    initialView: tableView,
    countNoun: 'companies',
    emptyMessage: ctx.scope === 'watchlist' ? 'No direct-equity holding is filed under a starred symbol.' : 'No company matches your filters.',
    exportName: `glow-direct-equity-${todayStamp()}`,
    onRowClick: (c) => openCompanyDrill(c),
    stickyHead: 'max(360px, calc(100vh - 340px))',
  });

  ctx.root.innerHTML = `
    ${sectionHead({
      title: 'Family Book',
      compact: true,
      titleAside: viewSwitchHtml(ctx, DIRECT_EQUITY_VIEW),
      meta: `${scopePill}${chip(`Statements · as of ${m.asOf ? formatDate(m.asOf) : '?'}`, 'Every figure is a wealth platform’s own statement mark; this is the newest report date in the book.', 'good')}${provenanceButton}`,
    })}
    ${stats.html}
    <div class="mt-4 fade-in" data-equity-table>${table.html}</div>
    <p class="mt-3 text-xs text-slate-500" data-equity-note>
      ${escapeHtml('One row per company, across every owner and account. Quantity, cost, value, unrealised P&L, dividends and the published IRRs are the statements’ own figures; return, average cost and weight are derived from them and say so on every cell. CMP and market cap are this dashboard’s own EOD technicals capture, not the book’s. A dash is a figure the statements do not carry — never a zero.')}
      ${lm ? escapeHtml(` The transaction statements cover ${lm.window?.declaredFrom || '?'} to ${lm.window?.declaredTo || '?'} across ${lm.accountsWithStatement.length} of ${lm.accountsWithStatement.length + lm.accountsWithoutStatement.length} accounts — that window is the statements’ own and is not a holding period, so a company with no trade on it was simply not traded in it.`) : ''}
    </p>`;

  stats.wire(ctx.root);
  const dispose = table.wire(ctx.root);
  onView(table.view);
  return dispose;
}

// ---- the drill ---------------------------------------------------------------------------------

function positionsGroup(company) {
  return {
    category: `Position by owner and account · ${company.rowCount} statement line${company.rowCount === 1 ? '' : 's'}`,
    items: company.rows
      .slice()
      .sort((a, b) => (num(b.marketValue) ?? 0) - (num(a.marketValue) ?? 0))
      .map((r) => ({
        label: `${r.owner || '—'} · ${r.provider || '—'}${r.strategy ? ` · ${r.strategy}` : ''}`,
        value: fmtCr(r.marketValue),
        note: [
          `${num(r.quantity) == null ? '—' : formatNumber(r.quantity, { decimals: Number.isInteger(r.quantity) ? 0 : 3 })} sh`,
          `avg ${num(r.avgCost) == null ? '—' : formatRupee(r.avgCost)}`,
          `cost ${num(r.costBasis) == null ? '— (the statement carries none)' : fmtCr(r.costBasis)}`,
          `P&L ${num(r.unrealizedPnL) == null ? '—' : fmtCr(r.unrealizedPnL)}`,
          num(r.returnPct) == null ? null : `return ${formatPct(r.returnPct, { decimals: 1 })}`,
          num(r.positionIrrPct) == null ? null : `IRR ${formatPct(r.positionIrrPct, { decimals: 1 })} (published)`,
          num(r.dividendReceived) == null ? null : `dividends ${formatRupee(r.dividendReceived, { decimals: 0 })}`,
          `statement ${r.accountAsOf ? formatDate(r.accountAsOf) : '—'}`,
        ].filter(Boolean).join(' · '),
      })),
  };
}

/**
 * THE DATED ROWS — and where there are none, WHY there are none.
 *
 * A transaction list that renders nothing for a company held since 2019 reads as a broken feed.
 * The window is the statements' financial year to date, so "no trades" is the ordinary answer for
 * most of the book and the panel says so in those words rather than drawing an empty list.
 */
function ledgerGroups(company) {
  const lm = book.ledgerMeta();
  const groups = [];
  if (!book.isLedgerLoaded()) {
    groups.push({
      category: 'Transactions',
      items: [{ label: lm?.state === 'failed' ? 'The transaction statements could not be read' : 'Reading the transaction statements…', value: '—', note: lm?.error || 'They are in public/data/book-ledger.json, fetched only by this view.' }],
    });
    return groups;
  }
  const { txns, income, lots } = ledgerRows(company);
  const w = lm?.window;
  const windowLine = `The transaction statements cover ${w?.declaredFrom || '?'} to ${w?.declaredTo || '?'}. That is the statements' own window, not a holding period.`;
  groups.push({
    category: `Transactions · ${txns.length || 'none in the statements’ window'}`,
    items: txns.length
      ? txns.slice().sort((a, b) => b.date.localeCompare(a.date)).map((t) => ({
        label: `${formatDate(t.date)} · ${t.side}`,
        value: t.amount == null ? '—' : fmtCr(t.amount, 4),
        note: [
          `${formatNumber(t.quantity, { decimals: Number.isInteger(t.quantity) ? 0 : 3 })} sh`,
          t.price == null ? 'no price printed' : `at ${formatRupee(t.price)}`,
          `${t.owner || '—'} · ${t.provider || '—'} ${t.accountNo || ''}`,
          t.side === 'Sell' ? (t.realized == null ? `realised — (${t.realizedNote || 'not determined'})` : `realised ${fmtCr(t.realized, 4)}`) : null,
          t.amount == null ? 'the statement printed no settlement amount' : null,
        ].filter(Boolean).join(' · '),
      }))
      : [{ label: 'No trade in this holding on the transaction statements', value: '—', note: windowLine }],
  });
  if (lots.length) {
    groups.push({
      category: `Capital-gain lots · ${lots.length}`,
      items: lots.slice().sort((a, b) => String(b.saleDate).localeCompare(String(a.saleDate))).map((l) => ({
        label: `${l.saleDate ? formatDate(l.saleDate) : '—'} · sold ${formatNumber(l.quantity, { decimals: 0 })}`,
        value: fmtCr((l.shortTerm || 0) + (l.longTerm || 0), 4),
        note: `bought ${l.purchaseDate ? formatDate(l.purchaseDate) : '—'} at ${l.purchaseRate == null ? '—' : formatRupee(l.purchaseRate)}, sold at ${l.saleRate == null ? '—' : formatRupee(l.saleRate)} · ${l.daysHeld == null ? '—' : `${formatNumber(l.daysHeld)} days`} · ${l.owner || '—'} · ${l.provider || '—'} · the capital gain statement's own determination`,
      })),
    });
  }
  if (income.length) {
    groups.push({
      category: `Dividends and corporate actions · ${income.length}`,
      items: income.slice().sort((a, b) => String(b.exDate).localeCompare(String(a.exDate))).map((i) => ({
        label: `${i.exDate ? formatDate(i.exDate) : '—'} · ${i.kind || 'income'}${incomeStage(i) ? ` · ${incomeStage(i)}` : ''}`,
        value: i.netAmount == null ? (i.entitlement || '—') : formatRupee(i.netAmount, { decimals: 0 }),
        note: [
          i.quantity == null ? null : `on ${formatNumber(i.quantity, { decimals: 0 })} sh`,
          i.ratePerUnit == null ? null : `at ${formatRupee(i.ratePerUnit)}`,
          i.tds ? `TDS ${formatRupee(i.tds, { decimals: 0 })}` : null,
          i.entitlement || null,
          `${i.owner || '—'} · ${i.provider || '—'}`,
        ].filter(Boolean).join(' · '),
      })),
    });
  }
  return groups;
}

export function openCompanyDrill(company) {
  const md = marketData(company);
  const lm = book.ledgerMeta();
  const items = (pairs) => pairs.map(([label, value, note]) => ({ label, value: value ?? '—', note }));
  openDrill({
    name: company.name,
    sub: `${company.symbol ? `${company.symbol} · ` : ''}${company.sector || company.providerSector || 'Sector not classified'} · held in ${company.rowCount} account${company.rowCount === 1 ? '' : 's'}`,
    headerStats: [
      { label: 'Value', value: fmtCr(company.marketValue) },
      { label: 'Return', value: company.returnPct == null ? '—' : formatPct(company.returnPct, { decimals: 1 }) },
      { label: 'Weight', value: book.weightOf(company.marketValue) == null ? '—' : formatPct(book.weightOf(company.marketValue), { decimals: 2, signed: false }) },
    ],
    banner: company.costComplete || company.costBasis == null
      ? (company.costBasis == null
        ? { title: 'No cost on any statement behind this holding', body: 'A depository reports what is held, not what it cost. The cost, P&L and return columns are dashes for this company rather than zeros — a zero cost would report its whole market value as profit.' }
        : null)
      : { title: `Cost is on ${company.costRows} of ${company.rowCount} statement lines`, body: `The cost, unrealised P&L and return below describe only those lines, which are worth ${fmtCr(company.costedValue)} of this holding's ${fmtCr(company.marketValue)}. The rest is a real holding whose purchase price this corpus does not carry.` },
    groups: [
      {
        category: 'Consolidated · the statements’ own figures, summed',
        items: items([
          ['Quantity', company.quantity == null ? '—' : formatNumber(company.quantity, { decimals: Number.isInteger(company.quantity) ? 0 : 3 }), company.rowCount > 1 ? `Across ${company.rowCount} statement lines in ${company.accounts.length} account(s)` : null],
          ['Statement value', fmtCr(company.marketValue), `Each platform's own mark on its report date${company.statementFrom !== company.statementTo ? `, ${company.statementFrom} to ${company.statementTo}` : ''}`],
          ['Cost basis', company.costBasis == null ? '—' : fmtCr(company.costBasis), company.costBasis == null ? 'No statement carries one. Not zero.' : (company.costComplete ? null : `Over ${company.costRows} of ${company.rowCount} lines`)],
          ['Unrealised P&L', company.unrealizedPnL == null ? '—' : fmtCr(company.unrealizedPnL), company.unrealizedPnL == null ? 'No cost, so no P&L' : null],
          ['Dividends received', company.dividends == null ? '—' : formatRupee(company.dividends, { decimals: 0 }), company.dividends == null ? 'No statement behind this holding reports dividends. Absent, not nil.' : (company.dividendsComplete ? 'Cumulative, as the statements report it' : `Over ${company.dividendRows} of ${company.rowCount} lines, so a total return over it would understate`)],
          ['XIRR (published)', company.irr.values.length === 0 ? '—' : company.irr.agree ? formatPct(company.irr.single, { decimals: 1 }) : `${formatPct(company.irr.min, { decimals: 1 })} … ${formatPct(company.irr.max, { decimals: 1 })}`,
            company.irr.values.length === 0
              ? 'No statement behind this holding publishes a per-position IRR, and one cannot be computed without the cash flows.'
              : company.irr.values.map((v) => `${v.owner || v.provider}: ${formatPct(v.pct, { decimals: 1 })}`).join(' · ')],
          ['First buy', company.heldSince ? formatDate(company.heldSince) : '—', company.heldSince ? 'The oldest unit still held, from a dated lot register' : 'The statements behind this holding publish no dated lot register, so this corpus cannot say when the oldest unit still held was bought.'],
        ]),
      },
      {
        category: 'Derived here',
        items: items([
          ['Average cost', company.avgCost == null ? '—' : formatRupee(company.avgCost), company.avgCost == null ? null : 'The summed cost over the shares it covers'],
          ['Return', company.returnPct == null ? '—' : formatPct(company.returnPct, { decimals: 1 }), 'The summed unrealised P&L over the summed cost. Not annualised — that needs a purchase date.'],
          ['Total return incl. dividends', company.totalReturnPct == null ? '—' : formatPct(company.totalReturnPct, { decimals: 1 }), company.totalReturnPct == null ? 'Shown only where every line of this holding carries both a cost and a dividend figure — otherwise it would understate while looking complete.' : 'Unrealised P&L plus cumulative dividends, over the cost'],
          ['Weight in the book', book.weightOf(company.marketValue) == null ? '—' : formatPct(book.weightOf(company.marketValue), { decimals: 2, signed: false }), 'Share of the consolidated value, every asset class, each duplicate counted once'],
        ]),
      },
      {
        category: 'Market data · this dashboard’s, not the statements’',
        items: items([
          ['CMP (EOD)', md?.cmp == null ? '—' : formatRupee(md.cmp), md?.cmp == null ? (company.symbol ? 'Not in this dashboard’s technicals capture' : 'No NSE symbol on the statements') : `EOD close on ${md.date || '?'} from the technicals capture`],
          ['Market cap', md?.marketCap || '—', md?.marketCap ? `As the technicals capture prints it, dated ${md.date || '?'}` : null],
          ['EOD mark (derived)', md?.cmp == null || company.quantity == null ? '—' : fmtCr(company.quantity * md.cmp), md?.cmp == null ? null : `quantity × the ${md.date || '?'} close — derived here, not the statements’ figure`],
        ]),
      },
      positionsGroup(company),
      ...ledgerGroups(company),
      {
        category: 'Provenance',
        items: items([
          ['Source', 'techmuns/GlowVentures · src/data/glowData.ts', 'Generated there from the PDF statements in its archive; copied here daily as public/data/book.json'],
          ['Dated evidence', lm ? `${lm.transactionCount} trades · ${lm.lotCount} lots · ${lm.incomeCount} income rows` : '—', lm ? `From the same repository’s statement archive (public/audit/), carried across as public/data/book-ledger.json. Statements declare ${lm.window?.declaredFrom || '?'} to ${lm.window?.declaredTo || '?'}; ${lm.accountsWithoutStatement.length} account(s) issued no transaction statement at all.` : null],
          ['Synced from', book.meta()?.builtFrom ? `GlowVentures@${book.meta().builtFrom}` : 'GlowVentures'],
        ]),
      },
    ],
  });
}

/** The Direct Equity half of the provenance modal — appended to the tab's own. */
export function equityProvenanceHtml() {
  const lm = book.ledgerMeta();
  if (!lm) return '';
  const w = lm.window || {};
  return `
    <p><strong>Direct Equity</strong> consolidates the statements' equity lines by company. Quantity, cost, value, unrealised P&amp;L, dividends and the per-position IRRs are the platforms' own figures; <strong>return</strong>, <strong>average cost</strong> and <strong>weight</strong> are derived from them and are labelled on every cell. <strong>CMP and market cap are not GlowVentures figures at all</strong> — they come from this dashboard's own EOD technicals capture and carry its bar date.</p>
    <p><strong>The dated evidence</strong> — ${escapeHtml(formatNumber(lm.transactionCount))} trades, ${escapeHtml(formatNumber(lm.lotCount))} capital-gain lots and ${escapeHtml(formatNumber(lm.incomeCount))} dividend and corporate-action rows — is read from the same repository's statement archive and carried across as <code class="rounded bg-slate-100 px-1">public/data/book-ledger.json</code>, fetched only by this view. The transaction statements declare <strong>${escapeHtml(w.declaredFrom || '?')} to ${escapeHtml(w.declaredTo || '?')}</strong>, and ${escapeHtml(formatNumber(lm.accountsWithoutStatement.length))} of the book's accounts issued no transaction statement at all. <strong>That window is the statements' own and is not a holding period</strong>: a company bought years ago and untouched since has no trade on it, which is why <em>First buy</em> reads the statements' dated lot register instead and is a dash wherever no statement publishes one.</p>
    <p><strong>A published IRR is reproduced, never blended.</strong> Two of the family's providers compute a per-position money-weighted return; where a company sits in several of their accounts each publishes its own, and the range is shown rather than an average nobody computed.${lm.realised ? ` The capital gain statements determine <strong>${escapeHtml(fmtCr(lm.realised.inLots, 2))}</strong> of realised gain; <strong>${escapeHtml(fmtCr(lm.realised.onTape, 2))}</strong> of it is attributable to a printed sale row, and the rest belongs to sales the transaction statements do not print.` : ''}</p>`;
}
