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
// As shipped on 29 October 2026: HEG is the screener export's row (its metadata, but a Yahoo series
// cut to 70 bars), HEGAM the book's (the full series, none of the export's fields).
const exportRow = { ...base, ticker: 'HEG', name: 'HEG', listSource: 'nse500', screenerUrl: 'https://www.screener.in/company/HEG/consolidated/',
  marketCap: '13,007 Cr.', sector: 'Capital Goods', broadSector: 'Industrials', industry: 'Industrial Products', chg_fii_hold: -1.76, chg_dii_hold: 0.64, bars_count: 70 };
const bookRow = { ...base, ticker: 'HEGAM', name: 'HEG Advanced Materials Limited', listSource: 'book', screenerUrl: 'https://www.screener.in/company/HEGAM/',
  marketCap: null, sector: 'Unclassified', broadSector: 'Unclassified', industry: null, chg_fii_hold: null, chg_dii_hold: null, bars_count: 268 };
served = technicalsPayload([exportRow, bookRow, { ...base, ticker: 'TCS', name: 'TCS' }], '2026-10-29T08:00:00.000Z');
await technicals.load();
assert.deepEqual(technicals.all().map((s) => s.company.ticker).sort(), ['HEGAM', 'TCS'], 'the company is one Breakouts row, not two');
const merged = technicals.rowFor('HEGAM');
assert.equal(merged.name, 'HEG Advanced Materials Limited', "the current symbol's own row wins");
assert.equal(merged.bars_count, 268, "its measurements are the current symbol's full series");
assert.deepEqual([merged.listSource, merged.screenerUrl, merged.marketCap, merged.sector, merged.broadSector, merged.industry, merged.chg_fii_hold, merged.chg_dii_hold],
  ['nse500', exportRow.screenerUrl, '13,007 Cr.', 'Capital Goods', 'Industrials', 'Industrial Products', -1.76, 0.64], "and the export's own fields come from the export's row");
assert.equal(technicals.byTicker('HEG'), technicals.byTicker('HEGAM'), 'either symbol finds the one row');
served = technicalsPayload([{ ...exportRow, ticker: 'HEGAM', name: 'HEG Advanced Materials Ltd' }, { ...bookRow, ticker: 'HEG', listSource: 'book', marketCap: null }], '2026-10-29T08:30:00.000Z');
await technicals.refresh();
assert.deepEqual([technicals.rowFor('HEGAM').marketCap, technicals.rowFor('HEGAM').listSource], ['13,007 Cr.', 'nse500'], 'an export row under the current symbol is never overwritten');
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
// A checked positions snapshot still filed under HEG sizes the HEGAM card, and is not read as an exit.
const { withPositionSnapshot } = await import('../public/js/data/ai-alerts.js');
const positions = { sizes: { complete: true, basis: 'listed-market-value' }, holdings: [{ ticker: 'HEG', name: 'HEG Advanced Materials Limited', weightPct: 2.5 }, { ticker: 'TCS', name: 'TCS', weightPct: 97.5 }] };
const sized = rankReport(report, { holdings: positions.holdings, positionSizes: positions });
assert.equal(sized.allCards.find((card) => card.ticker === 'HEGAM')?.holdingWeightPct, 2.5, 'the completed rank keeps the holding weight');
const snapshotted = withPositionSnapshot(rankReport(report, { holdings: positions.holdings }), positions);
assert.equal(snapshotted.allCards.find((card) => card.ticker === 'HEGAM')?.holdingWeightPct, 2.5, 'a snapshot arriving later keeps the card and sizes it');

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

// ---- The team brief: filings, quotes and trades reach the holding ---------------------------------------------------
// worker/newsletter-brief.mjs is hash-locked with Sattva (docs/NEWSLETTER-SHARED-SOURCE.json); Sattva
// carries the same reads over an empty table.
const { readAnnouncements, readSessionQuotes, readTrades, readCalendar, readActions } = await import('../worker/newsletter-brief.mjs');
const { istInstant } = await import('../public/js/data/newsletter-shared.js');
const { expectedSession } = await import('../public/js/data/breakout-live-shared.js');
const holdings = [{ ticker: 'HEGAM', name: 'HEG Advanced Materials Limited', isin: 'INE545A01024', sector: 'Unclassified' }];
const assetsOf = (files) => ({ ASSETS: { fetch: async (request) => {
  const path = new URL(request.url).pathname;
  return path in files ? Response.json(files[path]) : new Response('missing', { status: 404 });
} } });
const blocked = async () => new Response('blocked', { status: 403 });
const window = { from: istInstant('2026-10-28', '16:00'), to: istInstant('2026-10-29', '16:00') };
const filing = { newsId: 'heg-q2-call', scripCode: '509631', company: 'HEG Advanced Materials Ltd', headline: 'Intimation of Q2 FY 27 Earnings Conference Call',
  category: 'Company Update', subCategory: 'Earnings Call', date: '2026-10-29', time: '11:05:00', url: 'https://www.bseindia.com/xml-data/corpfiling/heg-q2-call.pdf' };
const nseFiling = { ticker: 'HEG', company: 'HEG Advanced Materials Limited', subject: 'Board meeting outcome on dividend', publishedAt: '2026-10-29T06:00:00.000Z',
  url: 'https://nsearchives.nseindia.com/corporate/heg-board-outcome.pdf' };
const announcementsFor = (book) => readAnnouncements({ env: assetsOf({
  '/data/corp-announcements.json': { capturedAt: '2026-10-29T17:14:20.699Z', from: '2026-10-27', to: '2026-10-29', byTicker: { HEG: [filing] } },
  '/data/nse-filings/index.json': { capturedAt: '2026-10-29T10:00:00.000Z', days: [{ day: '2026-10-29' }] },
  '/data/nse-filings/2026-10-29.json': { rows: [nseFiling] },
}), fetcher: blocked, now: window.to, window, holdings: book });
const found = JSON.stringify(await announcementsFor(holdings));
assert(found.includes('Q2 FY 27 Earnings Conference Call'), "a BSE filing the capture filed under HEG reaches the holding's brief");
assert(found.includes('Board meeting outcome on dividend'), 'so does an NSE history row filed under HEG');
assert(!/"ticker":"HEG"/.test(found), 'both are filed under HEGAM there');
const lagging = JSON.stringify(await announcementsFor([{ ...holdings[0], ticker: 'HEG' }]));
assert(lagging.includes('Q2 FY 27 Earnings Conference Call') && !/"ticker":"HEG"/.test(lagging), 'a book still on HEG reaches it too, under HEGAM');

const session = expectedSession(istInstant('2026-10-29'));
const daily = (rows) => ({ price_date: session, generated_at: `${session}T12:00:00.000Z`, source: 'Yahoo Finance', companies: rows });
const quoteRow = (ticker) => ({ ticker, cmp: 215.27, pct_change_today: 6.1, bar_date: session });
const quotesFor = (rows, book = holdings) => readSessionQuotes({ env: assetsOf({ '/data/technicals.json': daily(rows) }), now: istInstant('2026-10-29', '08:00'), edition: 'morning', day: '2026-10-29', holdings: book });
assert.deepEqual((await quotesFor([quoteRow('HEG'), quoteRow('HEGAM'), quoteRow('TCS')])).rows.map((r) => r.ticker), ['HEGAM'], 'Portfolio today lists the holding once');
assert.deepEqual((await quotesFor([quoteRow('HEG')])).rows.map((r) => r.ticker), ['HEGAM'], 'a quote filed under the old symbol alone still prices the holding');
assert.deepEqual((await quotesFor([quoteRow('HEGAM')], [{ ...holdings[0], ticker: 'HEG' }])).rows.map((r) => r.ticker), ['HEGAM'], 'a book that still says HEG is priced by the HEGAM quote');

const tradesFor = async (rows) => JSON.stringify(await readTrades({ env: assetsOf({
  '/data/insider-archive/index.json': { version: 1, months: { '2026-10': rows.length }, rowCount: rows.length, updatedAt: '2026-10-29T10:00:00.000Z' },
  '/data/insider-archive/2026-10.json': { kind: 'insider', rows },
}), window, holdings }));
assert((await tradesFor([{ ...trade, ticker: 'HEG', date: '2026-10-29' }])).includes('Promoter Group Trust'), 'a trade filed only under HEG reaches the holding');
const bothTrades = await tradesFor([{ ...trade, ticker: 'HEG', date: '2026-10-29' }, { ...trade, ticker: 'HEGAM', date: '2026-10-29' }]);
assert.equal(new Set(bothTrades.match(/"trade:[^"]+"/g) || []).size, 1, 'and the same trade under both symbols is reported once');

// The week ahead: a calendar row and a corporate action filed under HEG. The rows carry no name the
// book resolves, so only the symbol can place them.
const calendar = await readCalendar({ env: assetsOf({ '/data/earnings-calendar.json': { capturedAt: '2026-10-29T06:00:00.000Z', from: '2026-10-29', to: '2026-11-05',
  byDate: { '2026-10-31': { rows: [{ ticker: 'HEG', name: '', time: '15:00' }] } } } }), day: '2026-10-29', holdings,
  screener: async () => ({ capture: { portfolioUpcoming: [{ ticker: 'HEG', name: '', date: '2026-10-31', eventType: 'Results', time: '15:00' }] }, source: { checkedAt: '2026-10-29T06:00:00.000Z' } }) });
assert.deepEqual(calendar.rows.map((r) => [r.ticker, r.date, r.sources.join('+')]), [['HEGAM', '2026-10-31', 'Screener+Moneycontrol']], 'a scheduled result filed under HEG reaches the holding, once');
const actionsFor = (book) => readActions({ env: assetsOf({ '/data/corporate-actions.json': { capturedAt: '2026-10-29T06:00:00.000Z',
  rows: [{ id: 'heg-dividend', ticker: 'HEG', actionType: 'Dividend', purpose: 'Interim Dividend - Rs 5 Per Share', exDate: '2026-11-03', source: 'BSE' }] } }), day: '2026-10-29', holdings: book });
assert.deepEqual((await actionsFor(holdings)).rows.map((r) => r.ticker), ['HEGAM'], 'a corporate action filed under HEG reaches the holding');
assert.deepEqual((await actionsFor([{ ...holdings[0], ticker: 'HEG' }])).rows.map((r) => r.ticker), ['HEGAM'], 'and is filed under HEGAM for a book still on HEG');

// ---- The announcement projection keeps the symbol BSE filed a row under -------------------------------------------
// Corporate announcements reach the assembly through the identity directory's row(), which already
// moves a renamed company to the directory's symbol once the directory is rebuilt.
const { createAnnouncementIdentity } = await import('../public/js/data/announcement-identity.js');
const { announcementEvent } = await import('../public/js/data/daily-alerts.js');
const bseRow = { newsId: 'heg-q2-call', scripCode: '509631', ticker: 'HEG', company: 'HEG Advanced Materials Ltd', headline: 'Intimation of Q2 FY 27 Earnings Conference Call', date: '2026-10-29' };
const directory = (ticker) => createAnnouncementIdentity([{ isin: 'INE545A01024', bseCode: '509631', bseSymbol: 'HEGAM', ticker, name: 'HEG Advanced Materials Ltd' }]);
const projectedRow = directory('HEGAM').row(bseRow);
assert.deepEqual([projectedRow.ticker, projectedRow.filedTicker], ['HEGAM', 'HEG'], 'a rebuilt directory files the row under HEGAM and keeps the symbol BSE used');
const filedEvent = announcementEvent(projectedRow);
assert.deepEqual([filedEvent.ticker, filedEvent.filedTicker], ['HEGAM', 'HEG'], "the alert keeps the source's own symbol");
assert.equal(bseRow.ticker, 'HEG', 'the capture row itself is untouched');
assert.equal(directory('HEG').row(bseRow).filedTicker, undefined, 'a directory still on HEG leaves the row as filed, for the assembly to read');
assert.equal(directory('HEGAM').row({ ...bseRow, ticker: 'TCS', scripCode: '532540' }).filedTicker, undefined, 'no other company carries a filed symbol');

// ---- The BSE identity directory files the company under its current symbol ---------------------------------------
const { buildAnnouncementIdentities } = await import('./lib/announcement-identities.mjs');
const master = [{ SCRIP_CD: '509631', ISIN_NUMBER: 'INE545A01024', scrip_id: 'HEGAM', Scrip_Name: 'HEG Advanced Materials Ltd', Status: 'Active' }];
const identity = buildAnnouncementIdentities(master, { HEG: { ticker: 'HEG', bseId: '509631' } }).entries.find((e) => e.isin === 'INE545A01024');
assert.equal(identity.ticker, 'HEGAM', "Moneycontrol's old symbol no longer names the company's BSE filings");

console.log('PASS renamed symbols: reviewed against NSE, scope, coverage, insider identity, technicals (one row, export fields kept), AI Alerts (holding and position sizes), alert assembly, the team brief, announcement provenance and BSE identity');
