// A renamed company keeps its history: HEG Ltd became HEG Advanced Materials (NSE symbol HEGAM) in
// September 2026. The book follows NSE, while Moneycontrol, Screener, StockScans and the BSE capture
// went on filing the company as HEG — so a Portfolio view asking for HEGAM dropped its insider trades,
// results, con-calls and even that day's BSE filings. These checks hold every reader to the one
// reviewed table in announcement-identity.js. Offline; needs no server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const { RENAMED_SYMBOLS, renamedTo, currentSymbol, filingTicker } = await import('../public/js/data/announcement-identity.js');

// ---- The table agrees with NSE's own equity directory -------------------------------------------
const nse = json('../public/data/filing-capture/nse-identities.json');
const listed = Object.values(nse.directories || {}).flatMap((directory) => directory.entries || []);
assert(Object.keys(RENAMED_SYMBOLS).length > 0);
for (const [old, current] of Object.entries(RENAMED_SYMBOLS)) {
  const owners = listed.filter((entry) => entry.ticker === current);
  assert.equal(owners.length, 1, `${current} is one company in NSE's directory`);
  assert(owners[0].aliases?.includes(old), `NSE's own directory lists ${old} as a former symbol of ${owners[0].isin}`);
  assert(!listed.some((entry) => entry.ticker === old), `${old} is no company's current NSE symbol`);
  assert(!listed.some((entry) => entry.isin !== owners[0].isin && entry.aliases?.includes(old)), `${old} belongs to no other ISIN`);
  assert.equal(renamedTo(current), null, `${current} is not itself renamed again`);
}
// Wherever the shipped book holds a renamed company, it files it under a symbol that folds to the
// current one — whether or not the book has caught up.
for (const holding of json('../public/data/portfolio-companies.json').holdings || []) {
  const isin = listed.find((entry) => Object.values(RENAMED_SYMBOLS).includes(entry.ticker) && entry.isin === holding.isin);
  if (isin && holding.ticker) assert.equal(currentSymbol(holding.ticker), isin.ticker);
}

// ---- The helpers ----------------------------------------------------------------------------------
assert.equal(currentSymbol('heg '), 'HEGAM');
assert.equal(currentSymbol('HEGAM'), 'HEGAM');
assert.equal(currentSymbol('TCS'), 'TCS');
assert.equal(currentSymbol(null), '');
assert.equal(renamedTo('TCS'), null);
assert.equal(filingTicker('HEG'), 'HEGAM', 'the scope fold carries the rename');
assert.equal(filingTicker('JAYBEE-SM'), 'JAYBEE', 'the reviewed SME aliases are unchanged');

// ---- Every scope filter joins both symbols to the holding -------------------------------------------
const { filterByScope } = await import('../public/js/data/scope.js');
const rows = [{ ticker: 'HEG', id: 'old' }, { ticker: 'HEGAM', id: 'new' }, { ticker: 'TCS', id: 'other' }];
assert.deepEqual(filterByScope(rows, 'portfolio', [{ ticker: 'HEGAM' }]).map((r) => r.id), ['old', 'new'], 'history filed under HEG stays in Portfolio');
assert.deepEqual(filterByScope(rows, 'portfolio', [{ ticker: 'HEG' }]).map((r) => r.id), ['old', 'new'], 'a book that lags the rename still reaches rows filed under HEGAM');
assert.deepEqual(filterByScope(rows, 'universe', [{ ticker: 'HEGAM' }]).map((r) => r.id), ['old', 'new', 'other']);

const coverage = await import('../public/js/data/coverage.js');
coverage.prime({ holdings: [{ ticker: 'HEGAM', name: 'HEG Advanced Materials Limited', isin: 'INE545A01024' }] });
assert.equal(coverage.has('HEG'), true, 'a result filed under HEG is a holding for the notification watcher');
assert.equal(coverage.has('HEGAM'), true);
assert.equal(coverage.has('TCS'), false);

// ---- One trade, whichever symbol filed it -------------------------------------------------------------
const { insiderTradeIdentity, mergeInsiderTrades } = await import('../public/js/data/insider-history.js');
const trade = { date: '2026-09-07', cells: { Insider: 'Promoter Group Trust', Transaction: 'Acquisition', 'Trade Shares': '1,000' } };
assert.equal(insiderTradeIdentity({ ...trade, ticker: 'HEG' }), insiderTradeIdentity({ ...trade, ticker: 'HEGAM' }));
assert.equal(mergeInsiderTrades([{ ...trade, ticker: 'HEG' }], [{ ...trade, ticker: 'HEGAM' }]).length, 1, 'Screener (HEG) and the Muns supplement (HEGAM) are one disclosure');

// ---- The technicals loader keeps one row per company ----------------------------------------------------
const base = json('../public/data/technicals.json').companies.find((row) => row.cmp != null && !row.error);
const technicalsPayload = (companies, at) => ({ generated_at: at, price_date: base.bar_date || null, companies: structuredClone(companies) });
let served = null;
globalThis.fetch = async (input) => {
  const path = String(input);
  if (path.startsWith('/api/')) return new Response('none', { status: 404 });
  if (path === 'data/technicals.json') return Response.json(served);
  return Response.json({});
};
const technicals = await import('../public/js/data/technicals.js');
served = technicalsPayload([{ ...base, ticker: 'HEG', name: 'HEG' }, { ...base, ticker: 'HEGAM', name: 'HEG Advanced Materials Limited' }, { ...base, ticker: 'TCS', name: 'TCS' }], '2026-10-29T08:00:00.000Z');
await technicals.load();
assert.deepEqual(technicals.all().map((s) => s.company.ticker).sort(), ['HEGAM', 'TCS'], 'the company is one Breakouts row, not two');
assert.equal(technicals.rowFor('HEGAM').name, 'HEG Advanced Materials Limited', "the current symbol's own row wins");
assert.equal(technicals.byTicker('HEG'), technicals.byTicker('HEGAM'), 'either symbol finds the one row');
served = technicalsPayload([{ ...base, ticker: 'HEG', name: 'HEG' }], '2026-10-29T09:00:00.000Z');
await technicals.refresh();
assert.deepEqual(technicals.all().map((s) => [s.company.ticker, s.company.filedTicker]), [['HEGAM', 'HEG']], 'an old symbol alone is filed under the current one and keeps its own');
assert.equal(technicals.forScope('portfolio', [{ ticker: 'HEGAM' }]).length, 1);

// ---- AI Alerts: one card, recognised as the holding --------------------------------------------------------
const { rankReport } = await import('../public/js/data/ai-alerts.js');
const feeds = ['announcements', 'insider', 'earnings'].map((id) => ({ id, status: 'ok', reachesToday: true }));
const day = '2026-10-29';
const report = { day, scope: 'portfolio', feeds, events: [
  { id: 'bse-call', ticker: 'HEG', company: 'HEG', feed: 'announcements', day, headline: 'Intimation of Q2 FY 27 Earnings Conference Call', importance: 'high', direction: 'neutral' },
  { id: 'insider-buy', ticker: 'HEGAM', company: 'HEG Advanced Materials Limited', feed: 'insider', day, headline: 'Promoter Group Trust — Buy', importance: 'high', direction: 'positive' },
  { id: 'result', ticker: 'HEG', company: 'HEG', feed: 'earnings', day, headline: 'Result filed (YOY)', importance: 'high', direction: 'positive' },
] };
const companyCards = (book) => {
  const ranked = rankReport(report, { holdings: [{ ticker: book, name: 'HEG Advanced Materials Limited', isin: 'INE545A01024' }] });
  return (ranked.allCards || ranked.cards).filter((card) => ['HEG', 'HEGAM'].includes(card.ticker));
};
const cards = companyCards('HEGAM');
assert.equal(cards.length, 1, 'one company, one card');
assert.equal(cards[0].ticker, 'HEGAM');
assert.equal(cards[0].holding, true, 'the card is recognised as the holding');
const laggingCards = companyCards('HEG');
assert.deepEqual(laggingCards.map((card) => [card.ticker, card.holding]), [['HEGAM', true]], 'a book still on HEG recognises the same card');

// ---- The alert assembly reads a renamed company's evidence under its current symbol ----------------------------
const { assembleInSlices } = await import('../public/js/data/daily-alerts.js');
const event = (id, feed, ticker) => ({ id, feed, ticker, company: ticker, day, headline: `${id} headline`, importance: 'high', direction: 'neutral' });
const settledFeeds = new Map([
  ['announcements', { id: 'announcements', label: 'Corp Announcements', status: 'ok', count: 2, events: [event('a1', 'announcements', 'HEG'), event('a2', 'announcements', 'TCS')] }],
  ['insider', { id: 'insider', label: 'Insider Trades', status: 'ok', count: 1, events: [event('i1', 'insider', 'HEGAM')] }],
]);
const assembled = await assembleInSlices({ day, scope: 'portfolio', holdings: [{ ticker: 'HEGAM', name: 'HEG Advanced Materials Limited' }], includeHistory: true, settledFeeds }, async () => {});
const held = assembled.events.filter((e) => ['a1', 'i1'].includes(e.id));
assert.deepEqual(held.map((e) => e.ticker).sort(), ['HEGAM', 'HEGAM'], 'Portfolio keeps both and reads both as HEGAM');
assert.equal(held.find((e) => e.id === 'a1').filedTicker, 'HEG', "the source's own symbol is kept");
assert(!assembled.events.some((e) => e.id === 'a2'), 'scope still narrows everything else');
const again = await assembleInSlices({ day, scope: 'universe', holdings: [], includeHistory: true, settledFeeds }, async () => {});
const original = settledFeeds.get('announcements').events.find((e) => e.id === 'a1');
assert.equal(original.ticker, 'HEG', 'the source record is never rewritten');
assert.equal(again.events.find((e) => e.id === 'a2').ticker, 'TCS');

// ---- The BSE identity directory files the company under its current symbol ---------------------------------------
const { buildAnnouncementIdentities } = await import('./lib/announcement-identities.mjs');
const master = [{ SCRIP_CD: '509631', ISIN_NUMBER: 'INE545A01024', scrip_id: 'HEGAM', Scrip_Name: 'HEG Advanced Materials Ltd', Status: 'Active' }];
const identity = buildAnnouncementIdentities(master, { HEG: { ticker: 'HEG', bseId: '509631' } }).entries.find((e) => e.isin === 'INE545A01024');
assert.equal(identity.ticker, 'HEGAM', "Moneycontrol's old symbol no longer names the company's BSE filings");

console.log('PASS renamed symbols: reviewed against NSE, scope, coverage, insider identity, technicals, AI Alerts, alert assembly and BSE identity');
