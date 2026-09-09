import { normalisePortfolio, quarterOrder } from '../../public/js/data/finology-shared.js';

export function validateBook(body, slug, previous = null) {
  if (!body || body.ok === false || body.stale === true) throw new Error('Book unavailable or served stale');
  if (body.slug !== slug || !Array.isArray(body.holdings) || !Array.isArray(body.quarters) || !body.quarters.length) throw new Error('Invalid portfolio shape or identity');
  if (body.holdings.some((h) => !h.company || !h.quarterlyHoldings) || body.quarters.some((q) => !quarterOrder(q))) throw new Error('Invalid holding or period');
  if (!body.holdings.length && (body.totalStocks > 0 || previous?.holdings?.length)) throw new Error('Unexpected empty portfolio');
  if (previous?.fetchedAt && (!body.fetchedAt || Date.parse(body.fetchedAt) < Date.parse(previous.fetchedAt))) throw new Error('Source response is older than the retained book');
  if (previous?.quarters?.length && Math.max(...body.quarters.map(quarterOrder)) < Math.max(...previous.quarters.map(quarterOrder))) throw new Error('Source periods regressed');
  return body;
}

// Retain older columns when the upstream rolling window drops them. A missing company in the
// incoming response is history, not an invented current position or a confirmed sale.
export function retainHistory(incoming, previous) {
  const book = normalisePortfolio(incoming, incoming.slug);
  if (!previous) return { ...incoming, ...book };
  const old = normalisePortfolio(previous, previous.slug);
  const key = (h) => h.companySlug || h.company;
  const rows = new Map(book.holdings.map((h) => [key(h), h]));
  const older = old.quarters.filter((q) => !book.quarters.includes(q));
  for (const h of old.holdings) {
    let next = rows.get(key(h));
    if (!next) {
      next = { ...h, valueCr: null, quarterlyHoldings: { ...h.quarterlyHoldings }, quarterlyStatus: { ...h.quarterlyStatus } };
      for (const q of book.quarters.filter((q) => !old.quarters.includes(q))) { next.quarterlyHoldings[q] = null; next.quarterlyStatus[q] = 'unknown'; }
      rows.set(key(h), next);
    }
    for (const q of older) { next.quarterlyHoldings[q] = h.quarterlyHoldings[q]; next.quarterlyStatus[q] = h.quarterlyStatus[q]; }
  }
  return { ...incoming, ...book, quarters: [...book.quarters, ...older].sort((a, b) => quarterOrder(b) - quarterOrder(a)), holdings: [...rows.values()] };
}

export function assembleSnapshot({ list, books, failed, previous = {}, capturedAt }) {
  const merged = {}, retained = [];
  const missing = (previous.investors || []).filter((i) => !list.investors.some((next) => next.slug === i.slug));
  const investors = [...list.investors, ...missing];
  failed = { ...failed };
  for (const investor of missing) failed[investor.slug] = { reason: 'missing-from-list', message: 'Previously tracked investor disappeared from the source list; retained pending review.' };
  for (const investor of investors) {
    const slug = investor.slug;
    if (books[slug]) merged[slug] = retainHistory(books[slug], previous.books?.[slug]);
    else if (previous.books?.[slug]) { merged[slug] = previous.books[slug]; retained.push(slug); }
  }
  return { capturedAt, source: 'Ticker Finology via the dashboard Worker; scheduled every six hours',
    count: investors.length, dropped: list.dropped || 0, investors,
    covered: Object.keys(merged).length, refreshed: Object.keys(books).length, retained,
    positions: Object.values(merged).reduce((n, b) => n + b.holdings.length, 0),
    failedCount: Object.keys(failed).length, books: merged, failed };
}
