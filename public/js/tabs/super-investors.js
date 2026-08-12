// tabs/super-investors.js — who owns what, and what the money is doing in aggregate.
//
//   Superstar Investors  investor-first: a card grid, then the all-moves table
//   Institutions         the same for funds, with AUM, category and a mandate view
//   Fund Flows           FII vs DII monthly nets, MF category flows, and a per-company table
//                        joined to the REAL technicals feed, plus the overlap heatmap
//
// ATTRIBUTION. The investor and fund names are REAL public figures; their genuine holdings are
// disclosed in quarterly filings and aggregated by Trendlyne / Ticker Finology / AMFI. Every
// position rendered here is SYNTHETIC. That is only defensible because it is labelled on every
// surface — the ribbon below, the workspace banner, the drill and row 1 of the export. There is
// no commentary, rationale or quote anywhere: the data set holds numbers and positions only,
// because attributing an invented opinion to a named person is a different thing entirely.

import { statStrip, topCards, scoreTable, openDrill, sectionHead, roadmapStrip } from '../ui/screener.js';
import { scopeSummary } from '../ui/components.js';
import { avatarFor } from '../ui/visual.js';
import { escapeHtml } from '../core/dom.js';
import { formatNumber, formatDate, formatCroreCompact } from '../core/format.js';
import { exportSheets, todayStamp } from '../ui/export.js';
import * as investors from '../data/investors.js';
import * as technicals from '../data/technicals.js';
import { openTechnicalsDrillByTicker } from './breakouts-drill.js';
import * as investorDive from '../investors/deep-dive.js';
import * as filed from '../data/institution-holdings.js';
import { renderFiled } from '../investors/filed.js';

export const meta = {
  id: 'super-investors',
  title: 'Super Investors',
  subtitle: 'Superstar-investor and institutional holdings, quarter on quarter, plus the aggregate flow picture.',
  subviews: [
    { id: 'superstar-investors', label: 'Superstar Investors' },
    { id: 'institutions', label: 'Institutions' },
    { id: 'fund-flows', label: 'Fund Flows' },
  ],
};

const FEATURES = [
  'Quarterly shareholding scrape (Ticker Finology / Trendlyne)',
  'AMFI monthly flow ingestion',
  'New-entry and full-exit alerting on portfolio names',
  'Conviction scoring: position size against the holder\'s own book',
  'Cost-basis estimation from the quarter\'s traded range',
];

let renderToken = 0;
let ctxRef = null;
// Disposers from the filed-holdings table's global listeners. `scoreTable.wire()` returns one when
// it registers anything on the document, and it has to be released on nav away or every visit
// stacks another.
let disposers = [];

// ---------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------

export function render(ctx) {
  const token = ++renderToken;
  ctxRef = ctx;

  if (!investors.isLoaded()) {
    ctx.root.innerHTML = `
      ${sectionHead({ title: meta.title, description: 'The investor data set could not be loaded.' })}
      <div class="rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-slate-100">
        <div class="text-3xl">⚠️</div>
        <div class="mt-2 text-sm font-semibold text-slate-700">Investor data is missing</div>
        <div class="mt-1 text-xs text-slate-500">superinvestors.json / institutions.json did not load at bootstrap.</div>
      </div>`;
    return;
  }

  // Fund Flows joins the real technicals feed; the other two views do not wait for it.
  if (ctx.subview === 'fund-flows' && !technicals.isLoaded()) {
    ctx.root.innerHTML = loadingHtml();
    technicals
      .load()
      .catch(() => null)
      .then(() => {
        if (token === renderToken) paint(ctx);
      });
    return;
  }
  paint(ctx);
}

export function destroy() {
  renderToken++;
  ctxRef = null;
  disposers.forEach((d) => d && d());
  disposers = [];
}

function loadingHtml() {
  return `
    ${sectionHead({ title: meta.title, description: meta.subtitle })}
    <div class="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      ${Array.from({ length: 4 }).map(() => '<div class="skeleton-shimmer h-24 rounded-2xl bg-slate-100"></div>').join('')}
    </div>
    <div class="skeleton-shimmer h-96 rounded-2xl bg-slate-100"></div>`;
}

function paint(ctx) {
  const view = { 'superstar-investors': renderIndividuals, institutions: renderInstitutions, 'fund-flows': renderFlows }[ctx.subview] || renderIndividuals;
  view(ctx);
  restoreWorkspaceFromUrl(ctx);
}

// ---------------------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------------------

function provenanceRibbon() {
  if (!investors.meta()?.isMock) return '';
  const m = investors.meta();
  return `
    <div data-mock-ribbon class="mb-5 flex flex-wrap items-start gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-300">
      <span class="flex-shrink-0 rounded-full bg-amber-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-900">Illustrative positions</span>
      <p class="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">
        <strong>The names are real; the holdings are not.</strong> These are real public investors and funds whose actual shareholdings
        are disclosed in quarterly exchange filings and aggregated by <strong>Ticker Finology</strong>, <strong>Trendlyne</strong> and
        <strong>AMFI</strong>. Every position, quantity and percentage shown here is <strong>synthetic</strong>, generated by
        <code class="rounded bg-amber-100 px-1">${escapeHtml(m.generator || 'scripts/gen-mock-investors.mjs')}</code> with seed
        <code class="rounded bg-amber-100 px-1">${escapeHtml(String(m.seed ?? '—'))}</code> — none of it reflects what anyone named here owns.
        Nothing on this tab is a quote, view or rationale attributed to any of them: the data set holds numbers only.
      </p>
    </div>`;
}

function freshnessCard(note) {
  const m = investors.meta();
  return {
    hero: true,
    label: 'Last refresh',
    value: m?.isMock ? 'Mock data' : formatDate(m?.generated_at),
    note: m?.isMock
      ? `Generated ${formatDate(m?.generated_at)} · not a filing date${note ? ` · ${note}` : ''}`
      : `Shareholding filings as of ${formatDate(m?.as_of)}${note ? ` · ${note}` : ''}`,
  };
}

const ACTION_PILL = {
  New: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  Buy: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  Hold: 'bg-slate-100 text-slate-600 ring-slate-200',
  Sell: 'bg-amber-50 text-amber-700 ring-amber-200',
  Exit: 'bg-rose-50 text-rose-700 ring-rose-200',
};
const actionPill = (a) => `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${ACTION_PILL[a] || ACTION_PILL.Hold}">${escapeHtml(a)}</span>`;
const signedPp = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}pp`);

// ---- the workspace, and its URL mirror -------------------------------------------------------

function openHolder(ctx, investorId, tab = 'portfolio') {
  const holder = investors.byId(investorId);
  if (!holder) return;
  const writeUrl = (view) => ctx.setParamsQuiet({ ...(ctx.params || {}), holder: investorId, hview: view });
  investorDive.open(holder, {
    tab,
    onTabChange: writeUrl,
    onSwitch: (nextId) => openHolder(ctx, nextId, 'portfolio'),
    onClose: () => {
      const next = { ...(ctx.params || {}) };
      delete next.holder;
      delete next.hview;
      ctx.setParamsQuiet(next);
    },
  });
  writeUrl(tab);
}

/** ?holder=dolly-khanna&hview=activity must survive a reload and work as a shared link. */
function restoreWorkspaceFromUrl(ctx) {
  const id = ctx.params?.holder;
  if (!id || investorDive.currentId() === id) return;
  if (!investors.byId(id)) return;
  openHolder(ctx, id, ctx.params.hview || 'portfolio');
}

function wireHolderButtons(ctx, root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-holder]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openHolder(ctx, btn.dataset.openHolder, btn.dataset.holderView || 'portfolio');
  });
}

// ---- the investor card grid ------------------------------------------------------------------

function holderCard(h) {
  const { color, initials } = avatarFor(h.name);
  const change = h.valueChangePct;
  const scoped = h.scopedHoldings;
  return `
    <div data-holder-card="${escapeHtml(h.investorId)}" class="flex flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100 transition-all hover:-translate-y-0.5 hover:shadow-md hover:ring-indigo-200">
      <div class="flex items-start gap-3">
        <div class="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${color} text-sm font-bold text-white shadow-sm">${escapeHtml(initials)}</div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-bold text-slate-900">${escapeHtml(h.name)}</div>
          <div class="truncate text-[11px] text-slate-400">
            ${h.type === 'institution' ? escapeHtml([h.house, h.category].filter(Boolean).join(' · ')) : `tracked since ${escapeHtml(h.since || '—')}`}
          </div>
        </div>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2 text-center">
        <div class="rounded-xl bg-slate-50 p-2">
          <div class="text-lg font-bold tabular-nums text-slate-900">${h.stocksHeld}</div>
          <div class="text-[10px] uppercase tracking-wide text-slate-400">holdings</div>
        </div>
        <div class="rounded-xl bg-slate-50 p-2">
          <div class="text-lg font-bold tabular-nums text-slate-900">${formatCroreCompact(h.portfolioValueCr)}</div>
          <div class="text-[10px] uppercase tracking-wide text-slate-400">book value</div>
        </div>
      </div>

      ${
        h.type === 'institution'
          ? `<div class="mt-2 flex items-center justify-between rounded-xl bg-purple-50/60 px-2.5 py-1.5 text-[11px] ring-1 ring-purple-100">
               <span class="text-purple-700">AUM <strong class="tabular-nums">${formatCroreCompact(h.aumCr)}</strong></span>
               <span class="text-purple-600">${h.schemeCount} scheme${h.schemeCount === 1 ? '' : 's'}</span>
             </div>`
          : ''
      }

      <div class="mt-2 flex items-center justify-between text-[11px]">
        <span class="text-slate-400">QoQ book change</span>
        <span class="font-bold tabular-nums ${change > 0 ? 'text-emerald-600' : change < 0 ? 'text-rose-600' : 'text-slate-400'}">${change == null ? '—' : `${change > 0 ? '+' : ''}${change}%`}</span>
      </div>
      <div class="mt-1 truncate text-[11px] text-slate-500">Top holding · <span class="font-semibold text-slate-700">${escapeHtml(h.topHolding || '—')}</span></div>

      ${
        scoped
          ? scoped.length
            ? `<div class="mt-2 rounded-lg bg-indigo-50/70 px-2 py-1 text-[10px] text-indigo-700 ring-1 ring-indigo-100">${scoped.length} of your holdings: ${escapeHtml(scoped.slice(0, 3).map((s) => s.ticker).join(', '))}${scoped.length > 3 ? '…' : ''}</div>`
            : '<div class="mt-2 rounded-lg bg-slate-50 px-2 py-1 text-[10px] text-slate-500 ring-1 ring-slate-200">None of your holdings</div>'
          : ''
      }

      <button data-open-holder="${escapeHtml(h.investorId)}"
        class="mt-3 w-full rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-3 py-2 text-xs font-bold text-white shadow-sm transition-opacity hover:opacity-90">
        View portfolio
      </button>
    </div>`;
}

// ---- the all-moves table ----------------------------------------------------------------------

const MOVE_FILTERS = {
  act: {
    label: 'Action',
    options: () => [{ id: 'any', label: 'Any' }, ...['New', 'Buy', 'Hold', 'Sell', 'Exit'].map((a) => ({ id: a, label: a }))],
    test: (r, id) => id === 'any' || r.action === id,
  },
  sec: {
    label: 'Sector',
    options: (rows) => [{ id: 'any', label: 'All sectors' }, ...[...new Set(rows.map((r) => r.sector).filter(Boolean))].sort().slice(0, 8).map((s) => ({ id: s, label: s.length > 20 ? `${s.slice(0, 18)}…` : s }))],
    test: (r, id) => id === 'any' || r.sector === id,
  },
  who: {
    label: 'Holder',
    options: (rows) => [{ id: 'any', label: 'Anyone' }, ...[...new Map(rows.map((r) => [r.investorId, r.investor])).entries()].map(([id, label]) => ({ id, label: label.length > 20 ? `${label.slice(0, 18)}…` : label }))],
    test: (r, id) => id === 'any' || r.investorId === id,
  },
  only: {
    label: 'Only',
    options: () => [
      { id: 'any', label: 'Everything' },
      { id: 'new', label: 'New entries' },
      { id: 'exit', label: 'Full exits' },
    ],
    test: (r, id) => id === 'any' || (id === 'new' ? r.action === 'New' : r.action === 'Exit'),
  },
};
const MOVE_DEFAULTS = { act: 'any', sec: 'any', who: 'any', only: 'any' };

function filterBar(defs, defaults, allRows, params, attr) {
  const state = {};
  for (const [k, d] of Object.entries(defaults)) state[k] = params?.[k] || d;
  return {
    state,
    html: `
      <div class="mb-5 space-y-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100" data-${attr}-bar>
        ${Object.entries(defs)
          .map(([key, f]) => {
            const opts = f.options(allRows);
            return `
            <div class="flex flex-wrap items-center gap-2">
              <span class="w-20 flex-shrink-0 text-[11px] font-bold uppercase tracking-wider text-slate-400">${escapeHtml(f.label)}</span>
              ${opts
                .map((o) => {
                  const active = state[key] === o.id;
                  const trial = { ...state, [key]: o.id };
                  const n = allRows.filter((r) => Object.entries(defs).every(([k2, f2]) => f2.test(r, trial[k2]))).length;
                  return `<button type="button" data-${attr}-filter="${escapeHtml(key)}" data-${attr}-value="${escapeHtml(o.id)}"
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                      active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }">
                    <span>${escapeHtml(o.label)}</span>
                    <span class="rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${active ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500'}">${n}</span>
                  </button>`;
                })
                .join('')}
            </div>`;
          })
          .join('')}
      </div>`,
  };
}

function movesTable(ctx, rows, exportName, onExport) {
  return scoreTable({
    rows,
    key: (r) => `${r.investorId}:${r.ticker}`,
    name: (r) => r.name,
    nameLabel: 'Company',
    sub: (r) => [r.ticker, r.sector].filter(Boolean).join(' · '),
    searchable: (r) => `${r.name} ${r.ticker} ${r.investor} ${r.sector}`,
    initialSort: { key: 'Value', dir: 'desc' },
    exportName,
    onExport,
    onRowClick: (r) => openHolder(ctx, r.investorId, 'portfolio'),
    columns: [
      {
        label: 'Investor',
        html: true,
        sortValue: (r) => r.investor,
        get: (r) => `<button data-open-holder="${escapeHtml(r.investorId)}" class="text-left text-sm font-semibold text-indigo-700 hover:text-indigo-900">${escapeHtml(r.investor)}</button>${r.house ? `<span class="block text-[10px] text-slate-400">${escapeHtml(r.house)}</span>` : ''}`,
      },
      { label: 'Action', html: true, sortValue: (r) => r.action, get: (r) => actionPill(r.action) },
      {
        label: 'Qty Δ',
        align: 'right',
        html: true,
        sortValue: (r) => r.qtyDelta,
        get: (r) => (r.qtyDelta === 0 ? '<span class="text-xs text-slate-400">—</span>' : `<span class="text-xs font-semibold tabular-nums ${r.qtyDelta > 0 ? 'text-emerald-600' : 'text-rose-600'}">${r.qtyDelta > 0 ? '+' : ''}${formatNumber(r.qtyDelta)}</span>`),
      },
      { label: 'Holding %', align: 'right', html: true, sortValue: (r) => r.holdingPct, get: (r) => `<span class="font-bold tabular-nums text-slate-900">${r.holdingPct}%</span>` },
      {
        label: 'Δ QoQ',
        align: 'right',
        html: true,
        sortValue: (r) => r.holdingPctDelta,
        get: (r) => `<span class="text-xs font-semibold tabular-nums ${r.holdingPctDelta > 0 ? 'text-emerald-600' : r.holdingPctDelta < 0 ? 'text-rose-600' : 'text-slate-400'}">${r.holdingPctDelta === 0 ? '—' : signedPp(r.holdingPctDelta)}</span>`,
      },
      { label: 'Value', align: 'right', html: true, sortValue: (r) => r.valueCr, get: (r) => `<span class="tabular-nums text-slate-700" title="Derived: holding % × market cap">${formatCroreCompact(r.valueCr)}</span>` },
    ],
  });
}

// ---------------------------------------------------------------------------------------
// (a) SUPERSTAR INVESTORS
// ---------------------------------------------------------------------------------------

function renderIndividuals(ctx) {
  renderHolderView(ctx, {
    pool: investors.individuals(),
    type: 'individual',
    noun: 'investors',
    description: 'Eight tracked individual investors, their books and every position change this quarter.',
    exportName: `sattva-superinvestors-${todayStamp()}`,
  });
}

/**
 * Institutions — REAL filed shareholdings first, and the not-yet-wired funds strictly below them.
 *
 * THE TWO HALVES SHARE A SUB-VIEW AND NOTHING ELSE. The filed panel is built from exchange
 * filings; the funds under it are synthetic placeholders for institutions nobody has scraped yet.
 * No headline number spans both — a "combined book" adding a real ₹35,818 Cr to an invented
 * ₹2.7 L Cr would be the most misleading figure this dashboard could print — and each half
 * carries its own provenance chrome: a green Filed pill above, the amber ribbon below.
 *
 * When the last placeholder is replaced by a real scrape, the whole lower half goes and this
 * becomes one panel with one provenance, the way the Con-call tab did.
 */
function renderInstitutions(ctx) {
  disposers.forEach((d) => d && d());
  disposers = [];
  const panel = renderFiled(ctx, { disposers });
  if (!panel.html) {
    // No real file on disk. Fall back to the synthetic view rather than an empty tab, and let its
    // own amber ribbon do the explaining.
    return renderHolderView(ctx, {
      pool: investors.institutions(),
      type: 'institution',
      noun: 'funds',
      description: 'Tracked fund houses and foreign institutions, with AUM, mandate and every position change this quarter.',
      exportName: `sattva-institutions-${todayStamp()}`,
      extraHtml: mandateStrip(investors.institutions()),
    });
  }

  const wired = new Set(filed.all().map((f) => normaliseName(f.name)));
  const pending = investors.institutions().filter((h) => !wired.has(normaliseName(h.name)));

  ctx.root.innerHTML = `
    ${panel.html}
    ${pendingFundsSection(pending)}`;
  panel.wire(ctx.root);
}

/** "Small Cap World Fund" and "Smallcap World Fund Inc" are the same institution. */
function normaliseName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/\b(inc|ltd|limited|plc|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The funds we have NOT wired to filings yet. Cards only — no aggregate, no book value, no move
 * table. They are here so the gap is visible rather than hidden, which is the same reason the
 * roadmap strips exist, and the ribbon says plainly that the numbers on them are invented.
 */
function pendingFundsSection(pending) {
  if (!pending.length) return '';
  return `
    <div class="mt-8 border-t border-slate-200 pt-6">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Not wired to filings yet</div>
      <p class="mb-4 text-xs text-slate-500">
        ${escapeHtml(formatNumber(pending.length))} more institutions are tracked in this build without real filing data behind them.
        Nothing above this line is affected by them: they are excluded from every figure on this page.
      </p>
      <div data-mock-ribbon class="mb-4 flex flex-wrap items-start gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-300">
        <span class="flex-shrink-0 rounded-full bg-amber-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-900">Illustrative positions</span>
        <p class="min-w-0 flex-1 text-xs leading-relaxed text-amber-900">
          <strong>The names are real; the holdings are not.</strong> These funds exist and file real shareholdings, but every
          position, quantity and percentage shown on their cards is <strong>synthetic</strong>, generated by
          <code class="rounded bg-amber-100 px-1">scripts/gen-mock-investors.mjs</code>. Wiring one for real is one entry in
          <code class="rounded bg-amber-100 px-1">FUNDS</code> in <code class="rounded bg-amber-100 px-1">scripts/scrape-institution-holdings.mjs</code>.
        </p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${pending.map(holderCard).join('')}</div>
    </div>`;
}

function renderHolderView(ctx, { pool, type, noun, description, exportName, extraHtml = '' }) {
  const scoped = investors.holdersForScope(ctx.scope, ctx.data?.portfolio?.holdings || [], pool);
  const allMoves = investors.moves(undefined, { type }).filter((m) => (ctx.scope === 'portfolio' ? (ctx.data?.portfolio?.holdings || []).some((h) => h.ticker === m.ticker) : true));
  const bar = filterBar(MOVE_FILTERS, MOVE_DEFAULTS, allMoves, ctx.params, 'mv');
  const rows = allMoves.filter((r) => Object.entries(MOVE_FILTERS).every(([k, f]) => f.test(r, bar.state[k])));

  const totalValue = scoped.reduce((s, h) => s + h.portfolioValueCr, 0);
  const newEntries = allMoves.filter((m) => m.action === 'New').length;
  const exits = allMoves.filter((m) => m.action === 'Exit').length;

  const stats = statStrip([
    { label: type === 'institution' ? 'Funds tracked' : 'Investors tracked', value: formatNumber(scoped.length), note: `${scoped.reduce((s, h) => s + h.stocksHeld, 0)} positions combined` },
    {
      label: 'Combined book',
      value: formatCroreCompact(totalValue),
      note: 'derived: holding % × market cap',
      help: {
        title: 'Why book value is derived',
        body: `<p>A shareholding filing discloses a <strong>percentage of the company</strong>, never a rupee amount. Every ₹ figure on this tab is that percentage applied to the company's current market cap.</p>
               <p class="mt-3">So the number moves for two different reasons — the holder changing their position, and the market repricing the company — and it is not a statement of what anyone paid or what they are up.</p>
               <p class="mt-3 text-slate-500">On top of that, the positions themselves are <strong>synthetic</strong> in this build. The names are real; the holdings are not. See the amber ribbon.</p>`,
      },
    },
    { label: 'This quarter', value: `${newEntries} new · ${exits} exits`, note: `${allMoves.filter((m) => m.action === 'Buy').length} added, ${allMoves.filter((m) => m.action === 'Sell').length} trimmed` },
    freshnessCard(`as of ${investors.meta()?.quarter || ''}`),
  ]);

  const cards = topCards({
    title: `Top 10 by ${type === 'institution' ? 'Fund' : 'Investor'} Position Size`,
    items: allMoves
      .filter((m) => m.holdingPct > 0)
      .sort((a, b) => b.valueCr - a.valueCr)
      .slice(0, 10)
      // topCards renders `value` verbatim, so it must already carry its unit.
      .map((m) => ({ key: `${m.investorId}:${m.ticker}`, name: m.name, sub: `${m.investor} · ${m.holdingPct}%`, value: formatCroreCompact(m.valueCr), tone: 'brand' })),
    valueFormat: 'metric',
    onSelect: (item) => openHolder(ctx, String(item.key).split(':')[0], 'portfolio'),
  });

  const table = movesTable(ctx, rows, exportName, () => runInvestorExport(ctx, type));

  ctx.root.innerHTML = `
    ${sectionHead({ title: meta.title, description, meta: scopeSummary({ scope: ctx.scope, count: scoped.length, noun }) })}
    ${provenanceRibbon()}
    ${stats.html}
    <div class="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${scoped.map(holderCard).join('')}</div>
    ${extraHtml}
    ${cards.html}
    <div class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">All moves · ${escapeHtml(investors.meta()?.quarter || '')}</div>
    ${bar.html}
    ${table.html}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  cards.wire(ctx.root);
  table.wire(ctx.root);
  wireHolderButtons(ctx, ctx.root);
  ctx.root.querySelector('[data-mv-bar]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mv-filter]');
    if (btn) ctx.setParams({ ...(ctx.params || {}), [btn.dataset.mvFilter]: btn.dataset.mvValue });
  });
}

/** Mandate: what each fund is actually for — category, AUM, schemes and where the money sits. */
function mandateStrip(funds) {
  if (!funds.length) return '';
  return `
    <div class="mb-6 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Mandates</div>
      <div class="mb-3 text-[11px] text-slate-400">What each vehicle is for. A small-cap fund holding a mega-cap is a different signal from a flexi-cap doing the same.</div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[720px] text-sm">
          <thead class="border-b border-slate-100 bg-slate-50/70">
            <tr class="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <th scope="col" class="px-3 py-2">Fund</th><th scope="col" class="px-3 py-2">House</th><th scope="col" class="px-3 py-2">Category</th>
              <th scope="col" class="px-3 py-2 text-right">AUM</th><th scope="col" class="px-3 py-2 text-right">Schemes</th><th scope="col" class="px-3 py-2">Top sectors</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${funds
              .map(
                (f) => `
              <tr class="cursor-pointer hover:bg-slate-50/70" data-open-holder="${escapeHtml(f.investorId)}">
                <td class="px-3 py-2 font-semibold text-slate-800">${escapeHtml(f.name)}${f.manager ? `<span class="block text-[10px] font-normal text-slate-400">managed by ${escapeHtml(f.manager)}</span>` : ''}</td>
                <td class="px-3 py-2 text-xs text-slate-600">${escapeHtml(f.house || '—')}</td>
                <td class="px-3 py-2"><span class="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-bold text-purple-700 ring-1 ring-purple-200">${escapeHtml(f.category)}</span></td>
                <td class="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">${formatCroreCompact(f.aumCr)}</td>
                <td class="px-3 py-2 text-right tabular-nums text-slate-600">${f.schemeCount}</td>
                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    ${(f.topSectors || []).map((s) => `<span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">${escapeHtml(s.sector)} ${s.sharePct}%</span>`).join('')}
                  </div>
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// (c) FUND FLOWS
// ---------------------------------------------------------------------------------------

function renderFlows(ctx) {
  const months = investors.flows();
  const interest = investors.companyInterest().filter((r) => (ctx.scope === 'portfolio' ? (ctx.data?.portfolio?.holdings || []).some((h) => h.ticker === r.ticker) : true));
  const latest = months.at(-1);
  const fiiYtd = months.slice(-12).reduce((s, m) => s + m.fiiNetCr, 0);
  const diiYtd = months.slice(-12).reduce((s, m) => s + m.diiNetCr, 0);

  const stats = statStrip([
    { label: 'FII net · last 12m', value: formatCroreCompact(fiiYtd), note: `${latest ? `${latest.month}: ${formatCroreCompact(latest.fiiNetCr)}` : ''}` },
    { label: 'DII net · last 12m', value: formatCroreCompact(diiYtd), note: `${latest ? `${latest.month}: ${formatCroreCompact(latest.diiNetCr)}` : ''}` },
    { label: 'Companies with tracked interest', value: formatNumber(interest.length), note: 'held by at least one tracked holder' },
    freshnessCard(`${months.length} months`),
  ]);

  ctx.root.innerHTML = `
    ${sectionHead({
      title: meta.title,
      description: 'The aggregate picture: who is buying the market, which fund categories are being fed, and where the tracked money is concentrated.',
      meta: scopeSummary({ scope: ctx.scope, count: interest.length, noun: 'companies' }),
    })}
    ${provenanceRibbon()}
    ${stats.html}
    ${flowsChart(months)}
    ${categoryStrip(months)}
    ${institutionalTable(interest)}
    ${overlapHeatmap()}
    ${roadmapStrip(FEATURES)}`;

  stats.wire(ctx.root);
  wireHolderButtons(ctx, ctx.root);
  ctx.root.querySelectorAll('[data-open-tech]').forEach((el) => el.addEventListener('click', () => openTechnicalsDrillByTicker(el.dataset.openTech)));
}

/** FII vs DII monthly nets as grouped bars. Sign handling is the whole point: outflows go below zero. */
function flowsChart(months) {
  if (!months.length) return '';
  const W = 940;
  const H = 300;
  const PAD = { l: 62, r: 14, t: 16, b: 44 };
  const vals = months.flatMap((m) => [m.fiiNetCr, m.diiNetCr]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const y = (v) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const zero = y(0);
  const slot = (W - PAD.l - PAD.r) / months.length;
  const bw = Math.max(3, slot / 2 - 2);

  const ticks = [hi, hi / 2, 0, lo / 2, lo].map((v) => Math.round(v / 1000) * 1000).filter((v, i, a) => a.indexOf(v) === i);

  return `
    <div class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-sm font-bold text-slate-900">FII vs DII monthly net flows</h3>
        <div class="flex items-center gap-3 text-[11px]">
          <span class="flex items-center gap-1.5"><span class="h-2 w-3 rounded-sm bg-indigo-500"></span>FII net</span>
          <span class="flex items-center gap-1.5"><span class="h-2 w-3 rounded-sm bg-purple-400"></span>DII net</span>
          <span class="text-slate-400">₹ crore · ${months.length} months</span>
        </div>
      </div>
      <div class="mb-2 text-[11px] text-slate-400">Bars below the zero line are net selling. The two series usually run against each other.</div>
      <div class="overflow-x-auto">
        <svg viewBox="0 0 ${W} ${H}" class="w-full min-w-[820px]" role="img" aria-label="FII versus DII monthly net flows">
          ${ticks
            .map(
              (t) => `<line x1="${PAD.l}" y1="${y(t).toFixed(1)}" x2="${W - PAD.r}" y2="${y(t).toFixed(1)}" stroke="${t === 0 ? '#94a3b8' : '#f1f5f9'}" stroke-width="${t === 0 ? 1.5 : 1}"/>
                      <text x="${PAD.l - 8}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#94a3b8">${(t / 1000).toFixed(0)}k</text>`
            )
            .join('')}
          ${months
            .map((m, i) => {
              const x = PAD.l + i * slot;
              const bar = (v, dx, fill) => {
                const top = v >= 0 ? y(v) : zero;
                const h = Math.abs(y(v) - zero);
                return `<rect x="${(x + dx).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1.5" fill="${fill}" opacity="0.9">
                  <title>${m.month} — ${v >= 0 ? 'net buying' : 'net selling'} ₹${Math.abs(v).toLocaleString('en-IN')} Cr</title></rect>`;
              };
              return bar(m.fiiNetCr, 1, '#6366f1') + bar(m.diiNetCr, bw + 2, '#c084fc');
            })
            .join('')}
          ${months
            .map((m, i) => (i % 3 === 0 ? `<text x="${(PAD.l + i * slot + slot / 2).toFixed(1)}" y="${H - 24}" text-anchor="middle" font-size="8" fill="#94a3b8" transform="rotate(-40 ${(PAD.l + i * slot + slot / 2).toFixed(1)} ${H - 24})">${m.month}</text>` : ''))
            .join('')}
          <text x="14" y="${(PAD.t + H - PAD.b) / 2}" text-anchor="middle" font-size="10" fill="#64748b" transform="rotate(-90 14 ${(PAD.t + H - PAD.b) / 2})">₹ crore, net</text>
        </svg>
      </div>
    </div>`;
}

/** MF category flows as small multiples. */
function categoryStrip(months) {
  if (!months.length) return '';
  const cats = [
    { key: 'equityCr', label: 'Equity (all)', color: '#4f46e5' },
    { key: 'largeCapCr', label: 'Large cap', color: '#8b5cf6' },
    { key: 'midCapCr', label: 'Mid cap', color: '#a855f7' },
    { key: 'smallCapCr', label: 'Small cap', color: '#ec4899' },
  ];
  return `
    <div class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 text-xs font-bold uppercase tracking-wider text-slate-500">Mutual fund category flows</div>
      <div class="mb-3 text-[11px] text-slate-400">Net inflow per month, ₹ crore. Same 24 months, same vertical scale within each panel.</div>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        ${cats
          .map((c) => {
            const vals = months.map((m) => m.mf[c.key]);
            const max = Math.max(...vals, 1);
            const last = vals.at(-1);
            return `
            <div>
              <div class="mb-1 flex items-baseline justify-between">
                <span class="text-[11px] font-semibold text-slate-700">${escapeHtml(c.label)}</span>
                <span class="text-[11px] font-bold tabular-nums" style="color:${c.color}">${formatCroreCompact(last)}</span>
              </div>
              <svg viewBox="0 0 200 52" class="w-full" role="img" aria-label="${escapeHtml(c.label)} monthly flows">
                ${vals
                  .map((v, i) => {
                    const w = 200 / vals.length;
                    const h = (v / max) * 46;
                    return `<rect x="${(i * w).toFixed(2)}" y="${(50 - h).toFixed(2)}" width="${(w - 0.8).toFixed(2)}" height="${h.toFixed(2)}" rx="0.8" fill="${c.color}" opacity="${i === vals.length - 1 ? 1 : 0.42}"><title>${months[i].month}: ₹${v.toLocaleString('en-IN')} Cr</title></rect>`;
                  })
                  .join('')}
              </svg>
              <div class="flex justify-between text-[9px] text-slate-400"><span>${months[0].month}</span><span>${months.at(-1).month}</span></div>
            </div>`;
          })
          .join('')}
      </div>
    </div>`;
}

/**
 * Per-company institutional interest, joined to the REAL technicals feed.
 * Same fields Breakouts → FII Accumulation uses, and clicking a row opens that tab's drill.
 */
function institutionalTable(rows) {
  if (!rows.length) return '';
  const joined = rows
    .map((r) => {
      const t = technicals.byTicker(r.ticker);
      const c = t?.company;
      return {
        ...r,
        fii: c?.chg_fii_hold ?? null,
        dii: c?.chg_dii_hold ?? null,
        combined: c?.chg_fii_hold != null && c?.chg_dii_hold != null ? Math.round((c.chg_fii_hold + c.chg_dii_hold) * 100) / 100 : null,
        delivery: c?.delivery_trend_diff ?? null,
        techScore: t && !t.tickerError ? t.totalPoints : null,
        techMax: t?.totalMax ?? null,
        techPct: t && !t.tickerError ? t.scorePct : null,
      };
    })
    .sort((a, b) => (b.combined ?? -99) - (a.combined ?? -99))
    .slice(0, 30);

  const num = (v, suffix = 'pp') =>
    v == null ? '<span class="text-[11px] text-slate-300">—</span>' : `<span class="text-xs font-semibold tabular-nums ${v > 0 ? 'text-emerald-600' : v < 0 ? 'text-rose-600' : 'text-slate-500'}">${v > 0 ? '+' : ''}${v}${suffix}</span>`;

  return `
    <div class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-sm font-bold text-slate-900">Institutional interest, against the real ownership data</h3>
        <span class="text-[11px] text-slate-400">click a row to open the technicals drill</span>
      </div>
      <div class="mb-3 rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-200">
        <span class="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">Synthetic</span> tracked holders and their stakes
        <span class="mx-1.5 text-slate-300">|</span>
        <span class="mr-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-800">Real</span> FII/DII holding change, delivery trend and technical score — the same fields Breakouts → FII Accumulation scores.
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[800px] text-sm">
          <thead class="border-b border-slate-100 bg-slate-50/70">
            <tr class="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <th scope="col" class="px-3 py-2">Company</th>
              <th scope="col" class="px-3 py-2 text-right">Tracked holders</th>
              <th scope="col" class="px-3 py-2 text-right">Combined stake</th>
              <th scope="col" class="px-3 py-2 text-right">Net action</th>
              <th scope="col" class="px-3 py-2 text-right">Δ FII (real)</th>
              <th scope="col" class="px-3 py-2 text-right">Δ DII (real)</th>
              <th scope="col" class="px-3 py-2 text-right">Combined (real)</th>
              <th scope="col" class="px-3 py-2 text-right">Delivery trend</th>
              <th scope="col" class="px-3 py-2 text-right">Tech score</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-50">
            ${joined
              .map(
                (r) => `
              <tr data-open-tech="${escapeHtml(r.ticker)}" class="cursor-pointer hover:bg-slate-50/70">
                <td class="px-3 py-2">
                  <div class="font-semibold text-slate-800">${escapeHtml(r.name)}</div>
                  <div class="text-[10px] text-slate-400">${escapeHtml(r.ticker)} · ${escapeHtml(r.sector)}</div>
                </td>
                <td class="px-3 py-2 text-right">
                  <span class="font-bold tabular-nums text-slate-800">${r.holderCount}</span>
                  <span class="block truncate text-[10px] text-slate-400" title="${escapeHtml(r.holders.map((h) => h.investor).join(', '))}">${escapeHtml(r.holders.slice(0, 2).map((h) => h.investor.split(' ')[0]).join(', '))}${r.holderCount > 2 ? ` +${r.holderCount - 2}` : ''}</span>
                </td>
                <td class="px-3 py-2 text-right font-semibold tabular-nums text-slate-700">${r.totalPct}%</td>
                <td class="px-3 py-2 text-right"><span class="text-xs font-bold tabular-nums ${r.netAction > 0 ? 'text-emerald-600' : r.netAction < 0 ? 'text-rose-600' : 'text-slate-400'}">${r.netAction > 0 ? '+' : ''}${r.netAction}</span></td>
                <td class="px-3 py-2 text-right">${num(r.fii)}</td>
                <td class="px-3 py-2 text-right">${num(r.dii)}</td>
                <td class="px-3 py-2 text-right">${num(r.combined)}</td>
                <td class="px-3 py-2 text-right">${num(r.delivery, '%')}</td>
                <td class="px-3 py-2 text-right">${
                  r.techScore == null
                    ? '<span class="text-[11px] text-slate-300">—</span>'
                    : `<span class="rounded px-1.5 py-0.5 text-xs font-bold tabular-nums ${r.techPct >= 70 ? 'bg-emerald-50 text-emerald-700' : r.techPct >= 45 ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}">${r.techScore}/${r.techMax}</span>`
                }</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/** Tracked holders × most-held companies, shaded by holding %. */
function overlapHeatmap() {
  const { companies, grid, maxPct, quarter } = investors.overlapMatrix({ limit: 14 });
  if (!companies.length) return '';

  const shade = (pct) => {
    if (pct == null) return 'background:#f8fafc';
    const t = Math.min(1, pct / maxPct);
    // A single-hue ramp: intensity is the only variable, so the eye reads size not category.
    return `background:rgba(79,70,229,${(0.08 + t * 0.82).toFixed(3)});color:${t > 0.55 ? '#fff' : '#312e81'}`;
  };

  return `
    <div class="mb-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-100">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 class="font-display text-sm font-bold text-slate-900">Overlap — who owns the same names</h3>
        <span class="text-[11px] text-slate-400">${escapeHtml(quarter || '')} · shade = holding % · click a cell to open that holder's book</span>
      </div>
      <div class="mb-3 text-[11px] text-slate-400">The ${companies.length} companies held by the most tracked holders. A dense column is a crowded trade.</div>
      <div class="scrollbar-thin overflow-x-auto">
        <table class="w-full min-w-[860px] border-separate" style="border-spacing:2px" data-heatmap>
          <thead>
            <tr>
              <th scope="col" class="sticky left-0 z-10 bg-white px-2 py-1 text-left text-[10px] font-bold uppercase tracking-wider text-slate-400">Holder</th>
              ${companies.map((c) => `<th scope="col" class="px-1 py-1 text-center align-bottom"><span class="block max-w-[64px] truncate text-[9px] leading-tight text-slate-500" title="${escapeHtml(c.name)}">${escapeHtml(c.ticker)}</span><span class="block text-[9px] text-slate-300">${c.holders}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${grid
              .map(
                (row) => `
              <tr>
                <td class="sticky left-0 z-[1] bg-white px-2 py-1">
                  <span class="block max-w-[150px] truncate text-[11px] font-semibold text-slate-700" title="${escapeHtml(row.holder.name)}">${escapeHtml(row.holder.name)}</span>
                </td>
                ${row.cells
                  .map((cell) =>
                    cell.holdingPct == null
                      ? '<td class="rounded px-1 py-1.5 text-center text-[10px] text-slate-200" style="background:#f8fafc">·</td>'
                      : `<td><button data-open-holder="${escapeHtml(row.holder.investorId)}" data-holder-view="portfolio"
                           class="w-full rounded px-1 py-1.5 text-center text-[10px] font-bold tabular-nums transition-transform hover:scale-105"
                           style="${shade(cell.holdingPct)}"
                           title="${escapeHtml(row.holder.name)} — ${escapeHtml(cell.name)}: ${cell.holdingPct}%">${cell.holdingPct}</button></td>`
                  )
                  .join('')}
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------------------
// Export — three sheets, provenance banner as row 1
// ---------------------------------------------------------------------------------------

async function runInvestorExport(ctx, type) {
  const m = investors.meta();
  const banner = m?.isMock
    ? 'ILLUSTRATIVE POSITIONS — the investor and fund names in this workbook are REAL public figures whose genuine shareholdings are disclosed in quarterly exchange filings (Ticker Finology / Trendlyne / AMFI). EVERY POSITION, QUANTITY AND PERCENTAGE HERE IS SYNTHETIC (scripts/gen-mock-investors.mjs) and does not reflect what any named person or fund owns. Value columns are derived: holding % × market cap, since filings disclose a percentage and never a rupee amount.'
    : `Shareholding data as of ${formatDate(m?.as_of)}.`;

  const holderRows = investors.moves(undefined, { type });
  const activityRows = (type === 'institution' ? investors.institutions() : investors.individuals()).flatMap((h) => {
    const a = investors.activity(h);
    return [
      ...a.newEntries.map((r) => ({ ...r, bucket: 'New entry', investor: h.name })),
      ...a.adds.map((r) => ({ ...r, bucket: 'Added', investor: h.name })),
      ...a.trims.map((r) => ({ ...r, bucket: 'Trimmed', investor: h.name })),
      ...a.exits.map((r) => ({ ...r, bucket: 'Full exit', investor: h.name })),
    ];
  });

  await exportSheets({
    filename: `sattva-investors-${todayStamp()}`,
    banner,
    sheets: [
      {
        name: 'Holdings',
        columns: [
          { header: 'Holder (REAL NAME)', key: 'inv', width: 30, get: (r) => r.investor },
          { header: 'Type', key: 'type', width: 12, get: (r) => r.investorType },
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Sector', key: 'sector', width: 26, get: (r) => r.sector },
          { header: 'Quarter', key: 'q', width: 10, get: (r) => r.quarter },
          { header: 'Holding % (SYNTHETIC)', key: 'pct', width: 21, get: (r) => r.holdingPct },
          { header: 'Δ QoQ (pp)', key: 'd', width: 12, get: (r) => r.holdingPctDelta },
          { header: 'Quantity (SYNTHETIC)', key: 'qty', width: 20, get: (r) => r.qty },
          { header: 'Quantity Δ', key: 'qd', width: 14, get: (r) => r.qtyDelta },
          { header: 'Value ₹ Cr (DERIVED)', key: 'v', width: 21, get: (r) => r.valueCr },
          { header: 'Action', key: 'act', width: 10, get: (r) => r.action },
        ],
        rows: holderRows,
      },
      {
        name: 'Activity',
        columns: [
          { header: 'Holder (REAL NAME)', key: 'inv', width: 30, get: (r) => r.investor },
          { header: 'Bucket', key: 'b', width: 14, get: (r) => r.bucket },
          { header: 'Company', key: 'name', width: 30, get: (r) => r.name },
          { header: 'Ticker', key: 'ticker', width: 14, get: (r) => r.ticker },
          { header: 'Quantity Δ', key: 'qd', width: 16, get: (r) => r.qtyDelta },
          { header: 'Holding %', key: 'pct', width: 12, get: (r) => r.holdingPct },
          { header: 'Δ QoQ (pp)', key: 'd', width: 12, get: (r) => r.holdingPctDelta },
          { header: 'Value ₹ Cr (DERIVED)', key: 'v', width: 21, get: (r) => r.valueCr },
        ],
        rows: activityRows,
      },
      {
        name: 'Fund flows',
        columns: [
          { header: 'Month', key: 'm', width: 12, get: (r) => r.month },
          { header: 'FII net ₹ Cr', key: 'fii', width: 15, get: (r) => r.fiiNetCr },
          { header: 'DII net ₹ Cr', key: 'dii', width: 15, get: (r) => r.diiNetCr },
          { header: 'MF equity ₹ Cr', key: 'eq', width: 16, get: (r) => r.mf.equityCr },
          { header: 'MF large cap ₹ Cr', key: 'lc', width: 18, get: (r) => r.mf.largeCapCr },
          { header: 'MF mid cap ₹ Cr', key: 'mc', width: 17, get: (r) => r.mf.midCapCr },
          { header: 'MF small cap ₹ Cr', key: 'sc', width: 18, get: (r) => r.mf.smallCapCr },
        ],
        rows: investors.flows(),
      },
    ],
  });
  void ctx;
}

void openDrill;
