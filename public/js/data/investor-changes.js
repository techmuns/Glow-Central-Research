// Changes use dated trades for activity and dated observations for holdings. Never add the two.
import { deriveMoves, quarterOrder } from './finology-shared.js';

export const PERIODS = [
  { id: 'month', label: 'This month' }, { id: 'quarter', label: 'This quarter' },
  { id: '6m', label: '6 months' }, { id: 'year', label: '1 year' }, { id: 'itd', label: 'ITD' },
];
export const indiaDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const iso = (date) => date.toISOString().slice(0, 10);
export function periodRange(period, today = indiaDay()) {
  const [y, m, d] = today.split('-').map(Number);
  let from = null;
  if (period === 'month') from = iso(new Date(Date.UTC(y, m - 1, 1)));
  if (period === 'quarter') from = iso(new Date(Date.UTC(y, Math.floor((m - 1) / 3) * 3, 1)));
  if (period === '6m' || period === 'year') {
    const month = new Date(Date.UTC(y, m - 1 - (period === '6m' ? 6 : 12), 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    from = iso(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(d, last))));
  }
  return { from, to: today };
}
export const inPeriod = (row, range) => !!row.date && row.date <= range.to && (!range.from || row.date >= range.from);

// Full names only. Punctuation and equivalent legal suffixes are harmless; substring/fuzzy
// matches can attribute one person's trade to another. Ambiguous identities are left unmatched.
export const identity = (value) => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/\b(pvt|private)\b/g, 'private').replace(/\b(ltd|limited)\b/g, 'limited')
  .replace(/[^a-z0-9]/g, '');
export function identityIndex(people) {
  const index = new Map();
  for (const person of people) for (const name of [person.name, ...(person.aliases || [])]) {
    const key = identity(name);
    if (!key) continue;
    const prior = index.get(key);
    index.set(key, prior === undefined || prior?.id === person.id ? person : null);
  }
  return index;
}
const field = (cells, names) => {
  const key = Object.keys(cells || {}).find((key) => names.includes(key.toLowerCase()));
  return key ? String(cells[key] ?? '').trim() : '';
};
export const dealCategory = (row) => {
  const value = field(row.cells, ['trade category']).toLowerCase();
  return /^bulk(?: deal)?$/.test(value) ? 'Bulk deal' : /^block(?: deal)?$/.test(value) ? 'Block deal' : null;
};
export const bulkDealKey = (row) => [dealCategory(row), row.ticker, row.date, identity(row.cells?.Insider), row.cells?.Transaction,
  String(row.cells?.['Trade Shares'] || '').replace(/,/g, ''), String(row.cells?.Price || '').replace(/,/g, ''), row.cells?.Exchange || ''].join('|');
export function preserveBulkDeals(incoming, previous = []) {
  const result = [...incoming], seen = new Set(incoming.filter(dealCategory).map(bulkDealKey));
  for (const row of previous.filter(dealCategory)) {
    if (!seen.has(bulkDealKey(row))) { result.push(row); seen.add(bulkDealKey(row)); }
  }
  return result;
}
export function matchedDeals(rows, people) {
  const index = identityIndex(people), seen = new Map(), events = [];
  for (const row of rows) {
    const category = dealCategory(row);
    if (!category) continue; // A renamed tab does not turn SAST/insider filings into bulk deals.
    const reportedName = field(row.cells, ['insider', 'client name', 'client', 'person', 'name']);
    const person = index.get(identity(reportedName));
    if (!person) continue;
    const transaction = field(row.cells, ['transaction', 'buy/sell', 'side']).toLowerCase();
    const action = /^(buy|bought|purchase)$/.test(transaction) ? 'buy' : /^(sell|sold|sale)$/.test(transaction) ? 'sell' : null;
    if (!action) continue;
    const quantity = field(row.cells, ['trade shares', 'quantity']);
    const price = field(row.cells, ['price']);
    const key = [row.ticker, row.date, identity(reportedName), action, quantity.replace(/,/g, ''), price.replace(/,/g, ''), field(row.cells, ['exchange'])].join('|');
    if (seen.has(key)) {
      const event = seen.get(key);
      event.evidence.push(row);
      if (event.source !== category) event.source = 'Bulk / block deal';
      continue;
    }
    const event = { id: key, date: row.date, person: person.name, personId: person.id,
      company: field(row.cells, ['company']) || row.ticker, ticker: row.ticker,
      action, quantity: quantity || null, value: field(row.cells, ['trade value']) || null,
      source: category, reportedName, raw: row, evidence: [row], url: row.url || null };
    seen.set(key, event);
    events.push(event);
  }
  return events;
}
export function managerTrades(managers) {
  return managers.flatMap((m) => (m.transactions || []).map((t, i) => ({
    id: `statement|${m.id}|${i}`, date: t.date, person: m.name, personId: m.id,
    company: t.security, ticker: t.symbol, action: t.side, quantity: t.quantity,
    amount: t.amount, source: 'PMS statement', raw: t,
  })));
}
const quarterEnd = (label) => {
  const order = quarterOrder(label), year = Math.floor(order / 100), month = order % 100;
  return order && [3, 6, 9, 12].includes(month) ? iso(new Date(Date.UTC(year, month, 0))) : null;
};
export function investorHoldings(books, investors, today = indiaDay()) {
  const names = new Map(investors.map((i) => [i.slug, i.name])), events = [];
  for (const book of books) {
    const quarters = (book.quarters || []).filter((q) => quarterEnd(q) && quarterEnd(q) <= today)
      .sort((a, b) => quarterOrder(b) - quarterOrder(a));
    for (let i = 0; i < quarters.length - 1; i++) {
      const latest = quarters[i], prior = quarters[i + 1];
      for (const move of deriveMoves({ ...book, quarters: [latest, prior] }, today).moves) {
        if (['held', 'unknown', 'awaiting'].includes(move.action)) continue;
        events.push({ ...move, id: `holding|${book.slug}|${move.companySlug}|${latest}`,
          date: quarterEnd(latest), from: quarterEnd(prior), period: `${prior} → ${latest}`,
          person: names.get(book.slug) || book.name, personId: book.slug, source: 'Quarterly disclosure', unit: '% of company' });
      }
    }
  }
  return events;
}
export function managerHoldings(managers) {
  return managers.flatMap((m) => (m.moves || []).filter((move) => move.action !== 'held').map((move) => ({
    ...move, id: `holding|${m.id}|${move.securityKey}`, date: m.window?.to, from: m.window?.from,
    period: `${m.window?.from || '—'} → ${m.window?.to || '—'}`, company: move.security, ticker: move.symbol,
    person: m.name, personId: m.id, source: 'PMS statements', before: move.weightBefore, now: move.weightNow, unit: '% of mandate',
  })));
}
