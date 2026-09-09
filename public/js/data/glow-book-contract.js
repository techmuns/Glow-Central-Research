// Glow's statement book adapts to the shared research interfaces without borrowing
// Sattva's workbook, membership, quantities or source dates.
import { boundedJson, validateResolvedPortfolio } from './family-book-contract.js';

const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));

export async function glowPortfolio(companies, book, { now = Date.now() } = {}) {
  if (!companies?.source?.startsWith('techmuns/GlowVentures') || !book?.source?.startsWith('techmuns/GlowVentures') ||
      !Array.isArray(companies.holdings) || !companies.holdings.length || !Array.isArray(book.positions) ||
      !date(book.asOf) || companies.asOf !== book.asOf || !book.builtFrom || companies.sourceCommit?.sha !== book.builtFrom)
    throw Error('The Glow statement book and company list do not describe the same source revision');
  const revision = await digest(JSON.stringify([book.builtFrom, book.asOf, companies.holdings]));
  const published = book.sourcePublishedAt;
  if (!Number.isFinite(Date.parse(published))) throw Error('The Glow source revision has no publication timestamp');
  const holdings = companies.holdings.map(h => ({ ...h }));
  const portfolio = validateResolvedPortfolio({ ok: true, syncStatus: 'live', storage: 'shared',
    source: 'GlowVentures consolidated platform statements', sourceKind: 'glow-statements',
    sourceRevision: revision, asOf: book.asOf, syncedAt: new Date(now).toISOString(),
    sourceWorkbook: { fileKey: `glow-${book.builtFrom}`, label: `GlowVentures statements · ${book.asOf}`, uploadedAt: published },
    count: holdings.length, resolved: holdings.filter(h => h.ticker).length, holdings,
    unlisted: companies.unlisted, bseOnly: companies.bseOnly, unresolved: companies.unresolved,
    excluded: companies.excluded, sourceCommit: companies.sourceCommit });
  return portfolio;
}

export async function readGlowBook(fetcher = fetch, { signal, now = Date.now() } = {}) {
  const read = async name => boundedJson(await fetcher(`/data/${name}.json`, {
    cache: 'no-cache', redirect: 'manual', signal: signal || AbortSignal.timeout(15000),
  }), 8 * 1024 * 1024);
  const [companies, book] = await Promise.all([read('portfolio-companies'), read('book')]);
  return { portfolio: await glowPortfolio(companies, book, { now }), book };
}

export function glowPositionReply(portfolio, book) {
  const seen = new Set();
  const rows = book.positions.filter(p => {
    if (p.dedupeGroup) { if (seen.has(p.dedupeGroup)) return false; seen.add(p.dedupeGroup); }
    return p.assetClass === 'Equity';
  });
  const matched = new Set();
  let complete = true;
  const holdings = portfolio.holdings.map(h => {
    const positions = rows.filter(p => h.ticker && p.symbol === h.ticker || h.isin && p.isin === h.isin || !p.symbol && p.security === h.bookName);
    if (!positions.length || positions.some(p => !Number.isFinite(p.marketValue) || p.marketValue < 0)) complete = false;
    positions.forEach(p => { if (matched.has(p)) complete = false; matched.add(p); });
    return { isin: h.isin, ticker: h.ticker, name: h.name, sector: h.sector || 'Unclassified',
      value: positions.reduce((sum, p) => sum + (Number.isFinite(p.marketValue) ? p.marketValue : 0), 0) };
  });
  if (matched.size !== rows.length) complete = false;
  const total = holdings.reduce((sum, h) => sum + h.value, 0);
  if (total <= 0) complete = false;
  return { holdings: holdings.map(({ value, ...h }) => ({ ...h, weightPct: complete ? value / total * 100 : null })),
    sizes: { basis: 'statement-equity-value', complete, valuation: 'statements', sourceKind: 'glow-statements',
      bookAsOf: book.asOf, checkedAt: portfolio.syncedAt,
      archiveVersion: parseInt(portfolio.sourceRevision.slice(0, 12), 16), sourceRevision: portfolio.sourceRevision,
      sourceErrors: complete ? [] : ['Some equity statement values could not be reconciled; weights are unavailable.'],
      quotes: { refreshed: false, note: 'Statement values on each account report date; no live quote claim.' } } };
}

export function glowReading(portfolio, book, sizes) {
  return { status: 'limited', mode: 'verified-holdings', bookAsOf: book.asOf,
    checkedAt: portfolio.syncedAt, archiveVersion: sizes.archiveVersion,
    valuation: 'statements', sourceKind: 'glow-statements', sourceRevision: portfolio.sourceRevision,
    answer: `GlowVentures statement book, re-read from the currently published dashboard snapshot. Statements as of ${book.asOf}; source revision ${book.builtFrom}. This is not a live broker book. Equity weights use the complete research equity statement book, including held but uncovered lines, not total family NAV. Consolidated statement totals (INR): ${JSON.stringify(book.summary)}. Duplicate reports are counted once. The ring-fenced promoter holding is outside these totals. Null cost or P&L is unavailable, never zero. Use the Family Book evidence for individual positions and account dates.`,
    sourceErrors: sizes.sourceErrors, quotes: sizes.quotes };
}
