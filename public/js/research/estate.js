// research/estate.js — the bounded, runtime dashboard catalog behind Ask Research.
//
// Every source below is read through the same module the owning page uses. Adding a compatible
// page means adding one registry row and one evidence adapter, never teaching the assistant a
// question-specific answer. The packet always carries every catalog entry and source status; row
// samples are then selected for the current question so the model never receives a raw estate dump.

import { whenDeferredData } from '../core/state.js';
import * as watchlist from '../core/watchlist.js';
import * as scopeLists from '../core/scope-lists.js';
import * as coverage from '../data/coverage.js';
import { filterByScope } from '../data/scope.js';
import * as alerts from '../data/daily-alerts.js';
import * as earningsLive from '../data/earnings-live.js';
import * as earningsScored from '../data/earnings.js';
import * as earningsCalendar from '../data/earnings-calendar.js';
import * as concalls from '../data/concall-scans.js';
import * as chatter from '../data/chatter-live.js';
import * as technicals from '../data/technicals.js';
import * as investors from '../data/super-investors.js';
import * as institutions from '../data/institution-holdings.js';
import { news, announcements, insider } from '../data/filings.js';
import * as marketNews from '../data/market-news.js';
import * as portfolio from '../data/portfolio.js';

export const DASHBOARD_RESEARCH_SOURCES = [
  { id: 'daily-alerts', tab: 'General Alerts', route: '#/research/daily-alerts', description: 'Derived timeline across earnings, con-calls, chatter, technicals, investor activity, news, announcements and insider disclosures.' },
  { id: 'earnings-hub', tab: 'Earnings Hub', route: '#/research/earnings-hub', description: 'Reported quarterly figures, comparison periods, prices and result-date returns.' },
  { id: 'earnings-calendar', tab: 'Earnings Hub', route: '#/research/earnings-hub', description: 'Reported-date coverage and the currently loaded forward results calendar.' },
  { id: 'concall', tab: 'Con-call', route: '#/research/concall', description: 'Held and scheduled earnings calls with StockScans scores, sentiment tiers and source tags.' },
  { id: 'public-chatter', tab: 'Public Chatter', route: '#/research/public-chatter', description: 'Retail mention counts and sentiment across ValuePickr, TradingQnA and Google News.' },
  { id: 'technicals', tab: 'Breakouts / Technical', route: '#/research/breakouts/technical-scanner', description: 'The dashboard\'s 16-rule technical score and its underlying market readings.' },
  { id: 'earnings-surprise', tab: 'Breakouts / Technical', route: '#/research/breakouts/earnings-surprise', description: 'The explicitly mock earnings-scoring corpus used by the Earnings Surprise sub-view.' },
  { id: 'super-investors', tab: 'Super Investors', route: '#/research/super-investors/superstar-investors', description: 'Filed superstar-investor holdings and quarter-on-quarter disclosed changes.' },
  { id: 'institutions', tab: 'Super Investors', route: '#/research/super-investors/institutions', description: 'Institutional shareholding patterns and AMC portfolio disclosures.' },
  { id: 'company-news', tab: 'News', route: '#/research/news', description: 'Company-specific retained news for covered symbols.' },
  { id: 'market-news', tab: 'News', route: '#/research/news', description: 'Market-wide Moneycontrol stories; intentionally not company-scopeable.' },
  { id: 'announcements', tab: 'Corp Announcements', route: '#/research/corp-announcements', description: 'BSE filings in the exchange-wide retained capture.' },
  { id: 'insider-trades', tab: 'Insider Trades', route: '#/research/insider-trades', description: 'Insider and promoter disclosures in the upstream\'s own vocabulary.' },
  { id: 'portfolio', tab: 'Portfolio Analytics', route: '#/portfolio/overview/positions', description: 'FIFO positions, marked values, returns and drawdown from the hidden but routable portfolio workspace.' },
];

const SOURCE_BY_ID = new Map(DASHBOARD_RESEARCH_SOURCES.map((source) => [source.id, source]));
const LOADER_TIMEOUT_MS = 14_000;
const DEFAULT_ROW_LIMIT = 8;
const MATCH_ROW_LIMIT = 14;

const STOP_WORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'compare', 'dashboard', 'did', 'do', 'for', 'from', 'give', 'has', 'have', 'how', 'i',
  'in', 'inside', 'is', 'it', 'latest', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'research', 'show', 'summarise', 'summarize', 'tell', 'that', 'the', 'their',
  'this', 'to', 'today', 'what', 'where', 'which', 'who', 'why', 'with', 'you',
]);

const round = (value, places = 2) => {
  if (!Number.isFinite(value)) return value ?? null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const clipped = (value, max = 420) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function queryTokens(question) {
  return [...new Set(String(question || '').toLowerCase().match(/[a-z0-9&.-]{2,}/g) || [])].filter((token) => !STOP_WORDS.has(token));
}

function rowScore(row, tokens) {
  if (!tokens.length) return 0;
  const haystack = JSON.stringify(row).toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(`"${token}"`) ? 5 : haystack.includes(token) ? 1 : 0), 0);
}

function chooseRows(rows, tokens, mapRow, compare = null) {
  const mapped = (rows || []).map(mapRow).filter(Boolean);
  const scored = mapped.map((row, index) => ({ row, index, score: rowScore(row, tokens) }));
  const hits = scored.filter((item) => item.score > 0);
  const pool = hits.length ? hits.sort((a, b) => b.score - a.score || a.index - b.index) : scored;
  if (!hits.length && compare) pool.sort((a, b) => compare(a.row, b.row));
  const limit = hits.length ? MATCH_ROW_LIMIT : DEFAULT_ROW_LIMIT;
  return {
    rows: pool.slice(0, limit).map((item) => item.row),
    matchedRows: hits.length,
    omittedRows: Math.max(0, mapped.length - Math.min(mapped.length, limit)),
  };
}

function sourcePacket(id, details) {
  const source = SOURCE_BY_ID.get(id);
  return {
    id,
    tab: source.tab,
    route: source.route,
    description: source.description,
    status: 'ready',
    ...details,
  };
}

function failedPacket(id, error) {
  const source = SOURCE_BY_ID.get(id);
  return {
    ...source,
    status: 'unavailable',
    error: clipped(error?.message || error || 'This source could not be read.', 220),
    rowCount: null,
    rows: [],
  };
}

function withTimeout(promise, title) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${title} did not answer within ${Math.round(LOADER_TIMEOUT_MS / 1000)} seconds.`)), LOADER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scopeHoldings(scope) {
  if (scope === 'watchlist') return watchlist.all();
  return coverage.holdings();
}

// Superstar Investors exposes company names rather than exchange symbols, so this intentionally
// mirrors that page's name-based scope predicate. Using the same twelve-character comparison keeps
// the assistant's evidence set aligned with what the reader sees in the tab.
function investorScopeFilter(scope) {
  if (scope === 'universe') {
    const removed = scopeLists.removed('universe').map((entry) => String(entry.name || '').toLowerCase()).filter(Boolean);
    if (!removed.length) return null;
    return (company) => !removed.some((name) => String(company || '').toLowerCase().includes(name.slice(0, 12)));
  }
  const names = (scope === 'watchlist' ? watchlist.all() : coverage.holdings())
    .map((entry) => String(entry.name || '').toLowerCase())
    .filter(Boolean);
  return (company) => names.some((name) => String(company || '').toLowerCase().includes(name.slice(0, 12)));
}

function earningsRow(row) {
  return {
    ticker: row.ticker || null,
    company: clipped(row.company || row.fullName || row.name, 120),
    resultDate: row.resultDate || null,
    basis: row.basis || null,
    currentPeriod: earningsLive.meta()?.currentPeriod || null,
    priorPeriod: earningsLive.meta()?.priorPeriod || null,
    revenueCr: { current: row.revenue?.current ?? null, prior: row.revenue?.prior ?? null, growthPct: row.revenue?.pct ?? null },
    grossProfitCr: { current: row.grossProfit?.current ?? null, prior: row.grossProfit?.prior ?? null, growthPct: row.grossProfit?.pct ?? null },
    netProfitCr: { current: row.netProfit?.current ?? null, prior: row.netProfit?.prior ?? null, growthPct: row.netProfit?.pct ?? null },
    ltpRupees: row.ltp ?? null,
    priceChangePct: row.changePct ?? null,
    returnSinceResultPct: round(row.returnSinceResult),
    marketCapCr: round(row.marketCap),
  };
}

function technicalRow(scored) {
  const row = scored.company || {};
  return {
    ticker: row.ticker || null,
    company: clipped(row.name || row.ticker, 120),
    sector: row.sector || row.broadSector || null,
    score: { points: scored.totalPoints ?? null, max: scored.totalMax ?? null, pct: round(scored.scorePct) },
    hardFails: (scored.hardFails || []).map((item) => clipped(item.label || item.key || item, 120)).slice(0, 6),
    closeRupees: row.cmp ?? null,
    oneDayMovePct: row.pct_change_today ?? null,
    sixMonthReturnPct: Number.isFinite(row.return_6m) ? round(row.return_6m * 100) : null,
    relativeStrengthSixMonthPct: Number.isFinite(row.relative_strength_6m) ? round(row.relative_strength_6m * 100) : null,
    rsi14: row.rsi14 ?? null,
    adx14: row.adx14 ?? null,
    volumeRatio: row.volume_ratio_today ?? null,
    deliveryTrendPp: row.delivery_trend_diff ?? null,
    fiiHoldingChangePp: row.chg_fii_hold ?? null,
    above200DayAverage: row.above_200dma ?? null,
    breakout: row.consolidation_breakout?.breaks_out ?? null,
  };
}

function alertRow(row) {
  return {
    date: row.day || String(row.at || '').slice(0, 10) || null,
    time: row.time || null,
    ticker: row.ticker || null,
    company: clipped(row.company, 120),
    feed: row.feedLabel || row.feed || null,
    severity: row.severity || null,
    headline: clipped(row.headline),
    detail: clipped(row.detail),
    reason: clipped(row.reason),
  };
}

function chatterRow(row) {
  return {
    ticker: row.ticker || null,
    topic: clipped(row.name || row.slug, 120),
    mentions: row.mentions ?? null,
    mentionCountChangePct: row.mentionsChangePct ?? null,
    sentiment: row.sentiment ?? row.sentimentLabel ?? null,
    sentimentScore: row.sentimentScore ?? null,
    sources: row.sources || row.sourceTotals || null,
  };
}

function filingRow(row) {
  return {
    date: row.date || null,
    time: row.time || null,
    ticker: row.ticker || null,
    company: clipped(row.company || row.cells?.Company || row.ticker, 120),
    title: clipped(row.title || row.headline || row.cells?.Transaction || 'Disclosure'),
    category: clipped(row.category || row.cells?.Category, 120),
    subCategory: clipped(row.subCategory, 120),
    insider: clipped(row.cells?.Insider, 120),
    transaction: clipped(row.cells?.Transaction || row.cells?.['Acq/Disp'] || row.cells?.Mode, 120),
    tradeShares: row.cells?.['Trade Shares'] ?? null,
    tradePct: row.cells?.['Trade %'] ?? null,
    postHoldingPct: row.cells?.['Post Holding %'] ?? null,
    source: row.source || row.cells?.Source || null,
  };
}

function moveRow(row) {
  return {
    investor: clipped(row.investor, 120),
    company: clipped(row.company, 140),
    action: row.action || null,
    latestPeriod: row.latest || null,
    priorPeriod: row.prior || null,
    latestHoldingPct: row.now ?? null,
    priorHoldingPct: row.priorValue ?? row.before ?? null,
    changePp: row.deltaPp ?? null,
    latestValueCr: row.valueCr ?? null,
  };
}

function institutionRow(fund, holding) {
  return {
    institution: clipped(fund.name, 130),
    disclosure: fund.disclosure,
    period: fund.latestPeriodLabel || fund.latestPeriod || null,
    ticker: holding.ticker || null,
    company: clipped(holding.name || holding.ticker, 130),
    holdingPct: holding.pct ?? holding.holdingPct ?? holding.weightPct ?? null,
    valueCr: holding.valueCr ?? null,
    changePp: holding.changePp ?? holding.pctDelta ?? null,
    filingStatus: holding.changeNote || null,
  };
}

function portfolioRow(row) {
  return {
    ticker: row.ticker,
    company: clipped(row.name, 120),
    sector: row.sector || null,
    conviction: row.convictionTier || null,
    quantity: row.qty,
    averageCostRupees: round(row.avgPrice),
    lastPriceRupees: round(row.lastPrice),
    livePriced: !!row.priced,
    investedRupees: round(row.invested),
    marketValueRupees: round(row.marketValue),
    weightPct: round(row.weight),
    unrealisedPnlRupees: round(row.unrealised),
    unrealisedPnlPct: round(row.unrealisedPct),
    realisedPnlRupees: round(row.realised),
    totalPnlRupees: round(row.totalPnl),
  };
}

function portfolioScopeSummary(rows) {
  const open = rows.filter((row) => row.qty > 0);
  const total = (set, key) => round(set.reduce((sum, row) => sum + (Number(row[key]) || 0), 0));
  const invested = total(open, 'invested');
  const marketValue = total(open, 'marketValue');
  const unrealised = total(open, 'unrealised');
  const realised = total(rows, 'realised');
  const dividends = total(rows, 'dividends');
  const charges = total(rows, 'charges');
  const totalPnl = round(unrealised + realised + dividends);
  const unpriced = open.filter((row) => !row.priced);
  return {
    invested,
    marketValue,
    unrealised,
    unrealisedPct: invested ? round((unrealised / invested) * 100) : 0,
    realised,
    realisedShort: total(rows, 'realisedShort'),
    realisedLong: total(rows, 'realisedLong'),
    dividends,
    charges,
    totalPnl,
    totalPnlPct: invested ? round((totalPnl / invested) * 100) : 0,
    positionCount: open.length,
    closedCount: rows.filter((row) => row.isClosed).length,
    winnerCount: open.filter((row) => row.priced && row.unrealised > 0).length,
    loserCount: open.filter((row) => row.priced && row.unrealised < 0).length,
    unpricedCount: unpriced.length,
    lotCount: open.reduce((sum, row) => sum + (row.lots?.length || 0), 0),
    reconciliation: {
      realised,
      unrealised,
      dividends,
      totalPnl,
      residual: round(totalPnl - (realised + unrealised + dividends)),
      lotsBalance: rows.every((row) => (row.lots || []).reduce((sum, lot) => sum + (lot.openQty || 0), 0) === row.qty),
      unpricedCount: unpriced.length,
      unpricedTickers: unpriced.map((row) => row.ticker),
    },
  };
}

const BUILDERS = [
  {
    id: 'earnings-hub',
    async read({ scope, holdings, tokens }) {
      await earningsLive.load();
      const rows = earningsLive.forScope(scope, holdings);
      const picked = chooseRows(rows, tokens, earningsRow, (a, b) => String(b.resultDate || '').localeCompare(String(a.resultDate || '')));
      const meta = earningsLive.meta() || {};
      return sourcePacket(this.id, {
        source: meta.source || 'Moneycontrol Rapid Results',
        asOf: meta.fetchedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { allReportedRows: meta.count ?? earningsLive.all().length, mappedTickers: meta.mappedTickers ?? null, scope },
        definition: `${meta.quarter || 'Current quarter'} · ${meta.currentPeriod || 'current period'} vs ${meta.priorPeriod || 'prior period'} · ${String(meta.subType || '').toUpperCase() || 'reported comparison'}`,
        ...picked,
      });
    },
  },
  {
    id: 'earnings-calendar',
    async read() {
      // Builders run concurrently. The calendar's reported-date coverage and freshness come from
      // the live results feed, so wait for that shared load before snapshotting its metadata.
      await earningsLive.load();
      const range = earningsLive.dateRange();
      const strip = earningsCalendar.strip();
      return sourcePacket(this.id, {
        source: 'Moneycontrol results calendar and the reported-results index',
        asOf: earningsLive.meta()?.checkedAt || earningsLive.meta()?.fetchedAt || null,
        rowCount: strip.length,
        summary: {
          reportedDateRange: range,
          loadedScheduleDates: strip.map((item) => ({ date: item.date, scheduledCount: item.count })).slice(0, 14),
          note: strip.length ? 'Only calendar dates already loaded in this browser are included; reported results remain available from the Earnings Hub source.' : 'No forward calendar date has been opened in this browser yet.',
        },
        rows: [],
        matchedRows: 0,
        omittedRows: Math.max(0, strip.length - 14),
      });
    },
  },
  {
    id: 'concall',
    async read({ scope, holdings, tokens }) {
      await concalls.load();
      const rows = concalls.forScope(scope, holdings);
      const picked = chooseRows(rows, tokens, (row) => ({
        ticker: row.ticker || null,
        company: clipped(row.name, 130),
        industry: clipped(row.industry, 120),
        when: row.when || null,
        date: row.date || null,
        notesReady: row.notesReady ?? null,
        resultScore: row.resultScore ?? null,
        resultTier: row.resultTier?.label || row.resultTier || null,
        sentiment: row.sentiment?.label || row.sentiment || null,
        sourceTags: (row.tags || []).map((tag) => clipped(tag, 180)).slice(0, 6),
      }), (a, b) => String(b.when || '').localeCompare(String(a.when || '')));
      const meta = concalls.meta() || {};
      return sourcePacket(this.id, { source: meta.source || 'StockScans Concall Scans', asOf: meta.fetchedAt || meta.checkedAt || null, rowCount: rows.length, coverage: { scope, total: meta.count, analysed: meta.analysed }, ...picked });
    },
  },
  {
    id: 'public-chatter',
    async read({ scope, tokens }) {
      await chatter.load();
      const meta = chatter.meta() || {};
      if (meta.ok !== true) throw new Error(`Public Chatter could not be read (${meta.reason || 'unknown upstream state'}).`);
      const rows = chatter.forScope(scope);
      const unresolved = chatter.uncovered();
      const picked = chooseRows(rows, tokens, chatterRow, (a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
      const unresolvedPicked = chooseRows(unresolved, tokens, chatterRow, (a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
      return sourcePacket(this.id, {
        source: 'SentimentDash — ValuePickr, TradingQnA and Google News',
        asOf: meta.generatedAt || meta.checkedAt || null,
        rowCount: rows.length + unresolved.length,
        coverage: { scope, coveredRowsInScope: rows.length, coveredCompanies: meta.companies, unresolvedTopics: unresolved.length, totalTopics: meta.total, window: meta.window },
        definition: 'mentionsChangePct is a change in mention count between scrapes, not a price return; sparkline points are scrape runs, not days. Unresolved topics have no reliable dashboard ticker, so they remain separately labelled and are not silently assigned to a company scope.',
        unresolvedTopics: {
          status: 'unresolved-company-mapping',
          rowCount: unresolved.length,
          note: 'Shown by the owning Public Chatter page in every scope because these topics cannot be reliably narrowed by ticker.',
          ...unresolvedPicked,
        },
        ...picked,
      });
    },
  },
  {
    id: 'technicals',
    async read({ scope, holdings, tokens }) {
      await technicals.load();
      const rows = technicals.forScope(scope, holdings);
      const picked = chooseRows(rows, tokens, technicalRow, (a, b) => (b.score?.points ?? -Infinity) - (a.score?.points ?? -Infinity));
      const meta = technicals.meta() || {};
      return sourcePacket(this.id, { source: meta.source || 'Yahoo Finance EOD + NSE delivery', asOf: meta.generated_at || null, rowCount: rows.length, coverage: { scope, ...technicals.coverage(), scored: meta.scored_count, failures: meta.failures }, definition: '16 registered rules, 24 maximum points. Returns are converted to percentage points in this packet.', ...picked });
    },
  },
  {
    id: 'earnings-surprise',
    async read({ scope, holdings, tokens }) {
      await earningsScored.load();
      const rows = earningsScored.forScope(scope, holdings);
      const picked = chooseRows(rows, tokens, (row) => {
        const company = row.company || {};
        const latest = company.quarters?.at?.(-1) || null;
        return {
          ticker: company.ticker || null,
          company: clipped(company.name || company.ticker, 120),
          quarter: company.quarter || latest?.quarter || null,
          reportedOn: company.reportedOn || null,
          score: { points: row.totalPoints ?? null, max: row.totalMax ?? null, pct: round(row.scorePct) },
          hardFails: (row.hardFails || []).map((item) => clipped(item.label || item.key || item, 120)).slice(0, 6),
          revenueCr: latest?.revenue ?? null,
          netProfitCr: latest?.netProfit ?? null,
          epsRupees: latest?.eps ?? null,
          operatingMarginPct: latest?.opm ?? null,
          consensusEpsRupees: company.consensus?.eps ?? null,
        };
      }, (a, b) => (b.score?.points ?? -Infinity) - (a.score?.points ?? -Infinity));
      const meta = earningsScored.meta() || {};
      return sourcePacket(this.id, { source: meta.source || 'Mock earnings corpus', asOf: meta.generated_at || null, rowCount: rows.length, coverage: { scope, total: meta.company_count }, definition: 'Synthetic financial figures on real company identities. This source must always be labelled mock and must not be blended into factual company financials.', dataQuality: 'mock', ...picked });
    },
  },
  {
    id: 'super-investors',
    async read({ scope, tokens }) {
      await investors.load();
      const include = investorScopeFilter(scope);
      const rows = include ? investors.allMoves().filter((row) => include(row.company)) : investors.allMoves();
      const picked = chooseRows(rows, tokens, moveRow, (a, b) => Math.abs(b.changePp ?? 0) - Math.abs(a.changePp ?? 0));
      const meta = investors.meta() || {};
      const summary = investors.quarterSummary({ include, limit: 5 });
      return sourcePacket(this.id, {
        source: meta.source || 'Ticker Finology filed portfolios',
        asOf: meta.capturedAt || meta.checkedAt || null,
        rowCount: rows.length,
        coverage: { scope, trackedInvestors: investors.list().length, loadedBooks: investors.books().length, latestQuarter: investors.latestQuarter(), failedBooks: meta.failed },
        summary: {
          counts: summary.counts,
          comparableBooks: summary.comparableBooks,
          contributingBooks: summary.contributingBooks,
          periodPairs: summary.pairs,
          mostCommonHoldings: investors.overlaps().filter((item) => !include || include(item.company)).slice(0, 5).map((item) => ({ company: item.company, holders: item.holders.length })),
        },
        definition: 'Holding changes are percentage-point changes in disclosed company stakes. Exited means no longer disclosed, not necessarily sold. Current value is not trade value.',
        ...picked,
      });
    },
  },
  {
    id: 'institutions',
    async read({ scope, holdings, tokens }) {
      await institutions.load();
      const funds = institutions.all();
      const rows = [];
      for (const fund of funds) {
        for (const holding of institutions.holdingsForScope(scope, holdings, fund.holdings || [])) rows.push(institutionRow(fund, holding));
      }
      const picked = chooseRows(rows, tokens, (row) => row, (a, b) => (b.valueCr ?? 0) - (a.valueCr ?? 0));
      const meta = institutions.meta() || {};
      return sourcePacket(this.id, { source: meta.source || 'Trendlyne and AMC portfolio disclosures', asOf: meta.generatedAt || null, rowCount: rows.length, coverage: { scope, funds: funds.length }, definition: 'Shareholding percentages are stakes in companies; AMC portfolio percentages are weights to fund NAV. They are kept separate and are not comparable as one measure.', ...picked });
    },
  },
  {
    id: 'company-news',
    async read({ scope, holdings, tokens }) {
      await news.seed();
      const rows = filterByScope(news.rows(), scope, holdings);
      const picked = chooseRows(rows, tokens, (row) => ({ date: row.date || null, ticker: row.ticker || null, company: clipped(row.query || row.company || row.ticker, 120), title: clipped(row.title), summary: clipped(row.summary, 520), publisher: row.source || null, url: row.url || null }), (a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const meta = news.meta();
      return sourcePacket(this.id, { source: 'Retained company news snapshot', asOf: meta.capturedAt || meta.checkedAt || null, rowCount: rows.length, coverage: { scope, coveredCompanies: meta.covered, failedCompanies: meta.failed, windowDays: meta.windowDays, outstanding: meta.outstanding }, ...picked });
    },
  },
  {
    id: 'market-news',
    async read({ scope, tokens }) {
      await marketNews.load();
      const allRows = marketNews.rows();
      const rows = scope === 'universe' ? allRows : [];
      const picked = chooseRows(rows, tokens, (row) => ({ publishedAt: row.publishedAt || null, title: clipped(row.title), summary: clipped(row.summary, 620), url: row.url || null, premium: row.premium ?? null }), (a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      const meta = marketNews.meta();
      return sourcePacket(this.id, { source: 'Moneycontrol market-wide news capture', asOf: meta.capturedAt || meta.checkedAt || null, rowCount: rows.length, coverage: { scope, totalStories: allRows.length, note: scope === 'universe' ? 'Market-wide stories included.' : 'Market-wide stories have no company ticker and are excluded from narrowed scopes rather than silently assigned.' }, ...picked });
    },
  },
  {
    id: 'announcements',
    async read({ scope, holdings, tokens }) {
      await announcements.seed();
      const rows = filterByScope(announcements.rows(), scope, holdings);
      const picked = chooseRows(rows, tokens, filingRow, (a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
      const meta = announcements.meta();
      return sourcePacket(this.id, { source: 'BSE date-indexed corporate announcement feed', asOf: meta.capturedAt || meta.checkedAt || null, rowCount: rows.length, coverage: { scope, coversUniverse: meta.coversUniverse, exchangeCompanies: meta.exchangeCompanies, windowDays: meta.windowDays, unnamedRows: meta.unnamedRows }, definition: 'BSE categories are taxonomy, not a dashboard materiality or sentiment judgement.', ...picked });
    },
  },
  {
    id: 'insider-trades',
    async read({ scope, holdings, tokens }) {
      await insider.seed();
      const rows = filterByScope(insider.rows(), scope, holdings);
      const picked = chooseRows(rows, tokens, filingRow, (a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      const meta = insider.meta();
      return sourcePacket(this.id, { source: 'NSE, BSE and Trendlyne retained insider disclosures', asOf: meta.capturedAt || meta.checkedAt || null, rowCount: rows.length, coverage: { scope, coveredCompanies: meta.covered, failedCompanies: meta.failed, windowDays: meta.windowDays }, definition: 'The transaction wording is the upstream\'s. No dashboard sentiment or materiality score is attached.', ...picked });
    },
  },
  {
    id: 'portfolio',
    async read({ scope, tokens }) {
      await portfolio.load();
      const wanted = scope === 'watchlist' ? watchlist.tickers() : null;
      const base = portfolio.forScope(scope);
      const rows = wanted ? base.filter((row) => wanted.has(row.ticker)) : base;
      const picked = chooseRows(rows, tokens, portfolioRow, (a, b) => (b.marketValueRupees ?? 0) - (a.marketValueRupees ?? 0));
      const meta = portfolio.meta() || {};
      const summary = scope === 'watchlist' ? portfolioScopeSummary(rows) : portfolio.summary();
      return sourcePacket(this.id, {
        source: `Portfolio ledger + ${meta.priceSource || 'technical marks'} + ${meta.historySource || 'price history'}`,
        asOf: meta.asOf || meta.pricedAt || null,
        rowCount: rows.length,
        coverage: { scope, openPositions: summary?.positionCount, unpricedPositions: summary?.unpricedCount, tradingDays: meta.tradingDays, curveCoveragePct: scope === 'watchlist' ? null : round(meta.coverage) },
        summary,
        definition: `The ledger is mock; execution prices and the price history are real closes; current marks come from the technicals feed. Unpriced positions are carried at cost, not zero.${scope === 'watchlist' ? ' Watchlist totals are recomputed only from its filtered ticker rows; portfolio-wide XIRR, TWR, benchmark and drawdown are omitted.' : ''}`,
        dataQuality: 'mixed real and mock, explicitly separated',
        ...picked,
      });
    },
  },
  {
    id: 'daily-alerts',
    async read({ scope, tokens }) {
      const report = await alerts.collect({ scope, holdings: scopeHoldings(scope), includeHistory: true });
      const picked = chooseRows(report.events, tokens, alertRow, (a, b) => `${b.date || ''} ${b.time || ''}`.localeCompare(`${a.date || ''} ${a.time || ''}`));
      return sourcePacket(this.id, {
        source: 'Derived from Breakouts / Technical, News, Corp Announcements and Insider Trades',
        asOf: report.meta.newestRead || null,
        rowCount: report.events.length,
        coverage: { scope, ...report.meta, feeds: report.feeds.map((feed) => ({ id: feed.id, status: feed.status, count: feed.count, asOf: feed.asOf, reachesToday: feed.reachesToday })) },
        definition: `Red alerts are only price falls beyond ${report.meta.moveThreshold}% at the retained close. Other events are updates, not severity judgements.`,
        ...picked,
      });
    },
  },
];

export async function buildResearchEvidence({ question, scope = 'portfolio', onProgress = null } = {}) {
  await whenDeferredData();
  const tokens = queryTokens(question);
  const holdings = scopeHoldings(scope);
  let completed = 0;

  const packets = await Promise.all(
    BUILDERS.map(async (builder) => {
      try {
        return await withTimeout(builder.read({ question, scope, holdings, tokens }), SOURCE_BY_ID.get(builder.id)?.tab || builder.id);
      } catch (error) {
        return failedPacket(builder.id, error);
      } finally {
        completed += 1;
        try {
          onProgress?.({ completed, total: BUILDERS.length, source: SOURCE_BY_ID.get(builder.id)?.tab || builder.id });
        } catch (error) {
          console.error('[research] progress callback failed', error);
        }
      }
    })
  );

  const ready = packets.filter((packet) => packet.status === 'ready');
  const unavailable = packets.filter((packet) => packet.status !== 'ready');
  return {
    generatedAt: new Date().toISOString(),
    scope,
    scopeDefinition:
      scope === 'portfolio'
        ? `The family's configured book (${coverage.holdings().length} lines; not every line has a listed symbol).`
        : scope === 'watchlist'
          ? `The reader's device watchlist (${watchlist.size()} companies).`
          : 'The broadest company set each source currently carries.',
    selection: {
      method: 'Every registered source contributes catalog, coverage and provenance. Rows are bounded and ranked by exact question-token matches; when none match, each source contributes its own current/default ordering.',
      tokens,
      sourcesRegistered: DASHBOARD_RESEARCH_SOURCES.length,
      sourcesReady: ready.length,
      sourcesUnavailable: unavailable.length,
    },
    catalog: DASHBOARD_RESEARCH_SOURCES.map((source) => {
      const packet = packets.find((item) => item.id === source.id);
      return { ...source, status: packet?.status || 'unavailable', rowCount: packet?.rowCount ?? null, error: packet?.error || null };
    }),
    sources: packets,
  };
}

export function researchSuggestions(scope = 'portfolio') {
  const possessive = scope === 'universe' ? 'the listed universe' : scope === 'watchlist' ? 'my watchlist' : 'my portfolio';
  return [
    `What needs my attention across ${possessive} today?`,
    `Where do earnings, technicals and public chatter agree or conflict in ${possessive}?`,
    `Which companies in ${possessive} have the strongest recent evidence across multiple tabs?`,
    `Summarise the most important filings, calls and investor activity for ${possessive}.`,
  ];
}
