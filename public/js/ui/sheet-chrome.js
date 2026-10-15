// ui/sheet-chrome.js — WHAT THE PORTFOLIO AND WATCHLIST TABS SAY ABOUT THEMSELVES. GLOW-OWNED.
//
//   sheetStatusPill()        whether the typed values on screen are the desk's shared sheet, this
//                            browser's unsent edits, or a deployment with no shared sheet at all
//   sheetHowModal(kind)      every column: what it is, the formula, where each input comes from,
//                            and how fresh each source is — the door CLAUDE.md asks every derived
//                            figure to have
//   companySearchHtml(...)   the body of the Add holding search
//
// The pill is passive, as every status pill here is: it states the condition on its face and opens
// nothing. The explanation lives behind the muted link under each table.

import { escapeHtml } from '../core/dom.js';
import * as sheet from '../core/research-sheet.js';
import * as book from '../data/book.js';
import * as market from '../data/sheet-market.js';
import * as people from '../core/watchlist-people.js';

const PILL = {
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  error: 'bg-rose-50 text-rose-700 ring-rose-200',
  local: 'bg-slate-100 text-slate-600 ring-slate-200',
  checking: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function sheetStatus() {
  const m = sheet.meta();
  if (m.mode === 'local') {
    return { tone: 'local', text: 'Edits saved in this browser only', title: 'This deployment serves no shared sheet, so typed values are kept in this browser and are sent to the shared sheet the first time one answers.' };
  }
  if (m.error) return { tone: 'error', text: m.pending ? `Not saved yet · ${m.pending} waiting` : 'Shared sheet unreachable', title: m.error };
  if (m.pending) return { tone: 'pending', text: `Saving ${m.pending} edit${m.pending === 1 ? '' : 's'}…`, title: 'Typed here and on the way to the shared sheet.' };
  if (m.origin === 'live') {
    const when = m.updatedAt ? ` Last edit ${new Date(m.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} IST.` : '';
    return { tone: 'live', text: 'Shared with the desk', title: `Typed values are the desk's shared sheet, confirmed just now — everyone sees the same figures.${when}` };
  }
  return { tone: 'checking', text: 'Checking the shared sheet…', title: 'Showing this browser’s copy of the typed values until the shared sheet answers.' };
}

export function sheetStatusPill() {
  const s = sheetStatus();
  // Routine sharing needs no header badge; unsaved or unavailable edits still need a status.
  if (s.tone === 'live') return '';
  return `<span data-sheet-status="${s.tone}" class="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${PILL[s.tone]}" title="${escapeHtml(s.title)}">${escapeHtml(s.text)}</span>`;
}

const li = (term, body) => `<li><strong class="text-slate-800">${escapeHtml(term)}</strong> — ${body}</li>`;

function freshness() {
  const h = market.historyMeta();
  const t = market.technicalsMeta();
  const bench = market.benchmarkNow();
  const status = market.benchmarkStatus();
  const lines = [];
  lines.push(`<li><strong class="text-slate-800">Prices</strong> — the minute price capture this dashboard runs for every holding and watchlist company (Upstox, with the 15-minute Yahoo capture as its fallback), read every 15 seconds while this tab is visible. Where no current quote exists the completed daily close stands in and says its date.</li>`);
  lines.push(`<li><strong class="text-slate-800">Daily history</strong> — the technicals capture${t?.price_date ? ` (closes to ${escapeHtml(t.price_date)})` : t?.error ? ` (could not be read: ${escapeHtml(t.error)})` : ''}: 120 completed sessions of adjusted closes per company, the base of the 1-month return.</li>`);
  lines.push(`<li><strong class="text-slate-800">Dividends, splits and the Nifty 500 history</strong> — <code class="rounded bg-slate-100 px-1">sheet-history.json</code>, captured from Yahoo Finance daily by <code class="rounded bg-slate-100 px-1">scripts/scrape-sheet-history.mjs</code>${h.generatedAt ? ` (last run ${escapeHtml(h.generatedAt.slice(0, 16).replace('T', ' '))} UTC; Nifty 500 closes to ${escapeHtml(h.benchmarkTo || '?')})` : h.error ? ` (could not be read: ${escapeHtml(h.error)})` : ''}.${h.failed?.length ? ` Not available for ${h.failed.length} compan${h.failed.length === 1 ? 'y' : 'ies'}: ${escapeHtml(h.failed.map((f) => f.ticker).join(', '))} — Yahoo carries no history for NSE SME listings, so their TSR is the price return and says so.` : ''}</li>`);
  lines.push(`<li><strong class="text-slate-800">Nifty 500 now</strong> — ${bench ? `${escapeHtml(bench.source)}, ${escapeHtml(bench.date)}: ${bench.level.toLocaleString('en-IN')}` : 'not read yet'}${status === 'unavailable' ? '. The live index could not be read this minute, so the latest captured close is used.' : status === 'no-worker' ? '. This deployment serves no live index route, so the latest captured close is used.' : '.'}</li>`);
  const asOf = book.meta()?.asOf;
  lines.push(`<li><strong class="text-slate-800">The family's statements</strong> — the consolidated book GlowVentures builds from each platform's statements${asOf ? `, as of ${escapeHtml(asOf)}` : ''}; each holding's own statement date is in its Quantity and Buy price defaults.</li>`);
  return lines.join('');
}

export function sheetHowModal(kind) {
  const portfolio = kind === 'portfolio';
  const liveCols = portfolio ? [
    li('CMP', 'the current market price (see Prices below).'),
    li('Market cap', 'shares outstanding × CMP, so it moves with the price; where no share count is held, Screener’s market cap at the daily close moved by the price change since. The cell says which.'),
    li('1 day return', 'CMP against the previous close.'),
    li('1 month return', 'CMP against the adjusted close on or before the same day last month — an adjusted close, so a dividend paid in the month is in the return.'),
    li('Current value', 'Quantity × CMP. A holding with no price shows its statement value, tagged <em>stmt</em>, until it has one.'),
    li('TSR % including dividend received', '(current value + dividends received − amount invested) ÷ amount invested. Dividends are every ex-date AFTER the date bought, per share × quantity, from Yahoo Finance. Without a date bought, or for a company with no dividend history, the cell shows the price return and is tagged <em>excl. div</em> — never a total return that is missing its dividends.'),
    li('Alpha over NSE 500', 'TSR minus the Nifty 500’s return from the close on or before the date bought to its latest level, in percentage points. The Nifty 500 series here is the price index, without dividends.'),
    li('XIRR (TSR)', 'the money-weighted annual return of: the amount invested on the date bought, each dividend on its ex-date, and the current value today (Excel’s XIRR, 365-day year). Tagged <em>&lt;1y</em> when it annualises a holding under a year.'),
    li('Weight in portfolio', 'current value ÷ the sum of current values of every public-direct holding. PMS mandates are not in the rows or the total.'),
    li('Upside available on CMP', 'intrinsic value ÷ CMP − 1.'),
    li('Expected IRR on buy price', 'intrinsic value ÷ buy price − 1, as the column heading defines it — a ratio, not annualised.'),
  ] : [
    li('CMP, Market cap, 1 day and 1 month return', 'read exactly as on the Portfolio tab.'),
    li('Upside available on CMP', 'intrinsic value ÷ CMP − 1.'),
    li('Expected IRR on buy price', 'intrinsic value ÷ the buy price typed into that cell − 1. A watched company has no purchase, so the buy price it is measured from is the desk’s to set; the cell is empty until it is.'),
  ];
  const typedCols = portfolio ? [
    li('Sector', 'defaults to NSE’s industry classification as Screener prints it.'),
    li('Date bought', 'defaults to the oldest unit still held where a statement prints a lot register (few do). Type it as 12-Mar-24.'),
    li('Quantity bought', 'defaults to the shares on the family’s statements, moved onto today’s share basis for any split or bonus after the statement date.'),
    li('Buy price', 'defaults to the average cost a statement prints; a depository statement does not know what shares cost, so most are empty until typed.'),
    li('Amount invested', 'defaults to quantity × buy price.'),
    li('Target amount / Target weight', 'type either; the other is derived against the public-direct value now until it is typed too.'),
    li('Pending amount to be invested', 'defaults to target amount − amount invested.'),
    li('Intrinsic value, Valuation methodology, Reference year and date', 'the desk’s own; no default.'),
  ] : [
    li('Sector', 'defaults to NSE’s industry classification as Screener prints it.'),
    li('Source', 'where the idea came from — the desk’s own note.'),
    li('Target amount / Target weight', 'type either; the other is derived against the Portfolio tab’s public-direct value now.'),
    li('Intrinsic value, Valuation methodology, Reference year and date', 'the desk’s own, and the SAME record the Portfolio tab reads — a company bought from the Watchlist keeps its fair value.'),
  ];
  const me = people.me();
  return `
    <div class="max-h-[80vh] overflow-y-auto px-6 py-5 text-sm leading-relaxed text-slate-600">
      <div class="flex items-start justify-between gap-4">
        <h2 class="font-display text-lg font-bold text-slate-900">How the ${portfolio ? 'Portfolio' : 'Watchlist'} columns are calculated</h2>
        <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
      </div>
      ${portfolio ? '<p class="mt-2">Every listed company the family holds outside a PMS mandate — the Direct and Execution accounts on the statements (PMS, AIF, mutual-fund, ETF and cash lines excluded; warrants and preference shares are not listed equity) — plus holdings added by hand for a purchase a statement does not show yet.</p>'
    : '<p class="mt-2">Every company on the desk’s shared watchlist — the same list the ☆ beside any company row adds to.</p>'}
      <h3 class="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">Live — never typed</h3>
      <ul class="mt-2 list-disc space-y-1.5 pl-5">${liveCols.join('')}</ul>
      <h3 class="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">Typed by the desk</h3>
      <ul class="mt-2 list-disc space-y-1.5 pl-5">${typedCols.join('')}</ul>
      <p class="mt-2">Typed values are one shared record per company: everyone sees the same figures, each cell says who edited it last and when, and two people editing different cells never overwrite each other. ${me ? `Edits from this browser are signed <strong>${escapeHtml(me)}</strong>.` : 'Add your name in the edit panel and your edits are signed with it.'}</p>
      <h3 class="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">Sources and freshness</h3>
      <ul class="mt-2 list-disc space-y-1.5 pl-5">${freshness()}</ul>
      <p class="mt-3 text-xs text-slate-400">A dash is never a zero: its tooltip names the missing input — a date bought, a buy price, a price — that stops the figure.</p>
    </div>`;
}

export function companySearchHtml({ id, title, intro }) {
  const me = people.me() || '';
  return `
    <div data-company-search="${escapeHtml(id)}">
      <div class="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
        <div>
          <h2 class="font-display text-xl font-extrabold text-slate-900">${escapeHtml(title)}</h2>
          <p class="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">${escapeHtml(intro)}</p>
        </div>
        <button type="button" data-modal-close aria-label="Close" class="text-2xl leading-none text-slate-400 hover:text-slate-700">×</button>
      </div>
      <div class="px-6 py-5">
        <label class="sr-only" for="${escapeHtml(id)}-input">Search company name or ticker</label>
        <input id="${escapeHtml(id)}-input" data-company-search-input type="search" autocomplete="off" placeholder="Search company name or ticker…"
          class="w-full rounded-xl bg-white px-3 py-3 text-sm text-slate-800 outline-none ring-1 ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-300" />
        <div data-company-search-results class="mt-2 max-h-72 overflow-y-auto rounded-2xl"></div>
        <label class="mt-4 flex items-center gap-2 text-xs text-slate-500">Added by
          <input data-company-search-by type="text" maxlength="60" value="${escapeHtml(me)}" placeholder="Your name (optional)"
            class="w-48 rounded-lg bg-white px-2 py-1.5 text-xs text-slate-800 outline-none ring-1 ring-slate-200 focus:ring-2 focus:ring-indigo-300" />
        </label>
      </div>
    </div>`;
}
