// Reconcile deployment metadata only. Retained filing documents, source checks,
// publication times and archive watermarks are never rewritten by this adapter.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureCompanies } from './lib/company-capture.mjs';
import { glowPortfolio } from '../public/js/data/glow-book-contract.js';
export async function rebuildGlowCaptureIndex(dataDir = resolve('public/data')) {
  const path = join(dataDir, 'filing-capture/index.json');
  if (!existsSync(path)) return { changed: false };
  const read = file => JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
  const index = read('filing-capture/index.json'), list = read('portfolio-companies.json'), book = read('book.json');
  const portfolio = await glowPortfolio(list, book);
  if (index.deployment === 'glow-central-research' && index.portfolio?.revision === portfolio.sourceRevision) return { changed: false };
  const savedRegistrations = existsSync(join(dataDir, 'filing-capture/registrations.json')) ? read('filing-capture/registrations.json') : null;
  const registrations = savedRegistrations?.deployment === 'glow-central-research' ? savedRegistrations.companies : [];
  const scope = captureCompanies(dataDir, { announcements: true, holdings: list.holdings, registrations });
  const held = new Set(list.holdings.map(h => h.isin));
  const eligible = new Set([...held, ...registrations.map(c => c.isin)]);
  const fresh = scope.companies.map(c => ({ ...c, priority: c.priority && eligible.has(c.isin) }));
  const byTicker = new Map((index.companies || []).map(c => [c.ticker, { ...c, priority: false }]));
  for (const c of fresh) byTicker.set(c.ticker, c);
  index.companies = [...byTicker.values()];
  const priority = new Map(fresh.filter(c => c.priority).map(c => [c.ticker, c]));
  for (const kind of ['announcements', 'domestic']) {
    const entries = index.sources[kind] ||= {};
    for (const entry of Object.values(entries)) entry.priority = false;
    for (const [ticker, company] of priority) {
      entries[ticker] ||= { rowCount: 0, ranges: [] };
      entries[ticker].priority = true;
      entries[ticker].isin = company.isin;
    }
  }
  const represented = new Set([...priority.values()].map(c => c.isin));
  index.unresolved = [...new Set([...scope.unresolved, ...list.holdings.filter(h => !represented.has(h.isin)).map(h => h.name)])];
  index.deployment = 'glow-central-research';
  index.portfolio = { status: 'snapshot', liveRequested: false, error: null, attemptedAt: null, checkedAt: null,
    revision: portfolio.sourceRevision, sourceKind: portfolio.sourceKind, source: 'techmuns/GlowVentures',
    count: list.holdings.length, unresolvedHoldings: list.holdings.filter(h => !represented.has(h.isin)).map(h => ({ isin: h.isin, name: h.name })) };
  if (index.registration?.deployment !== 'glow-central-research') index.registration = { liveRequested: false, checkedAt: null,
    error: 'Glow registrations have not been checked yet.', count: 0, deployment: 'glow-central-research' };
  writeFileSync(path, `${JSON.stringify(index)}\n`);
  return { changed: true, count: list.holdings.length, priority: priority.size, unresolved: index.portfolio.unresolvedHoldings.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(await rebuildGlowCaptureIndex());
