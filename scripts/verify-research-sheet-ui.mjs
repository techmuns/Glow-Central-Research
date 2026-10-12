#!/usr/bin/env node
// THE PORTFOLIO AND WATCHLIST TABS, DRIVEN THROUGH THE REAL UI AGAINST THE REAL STORES.
//
//   PLAYWRIGHT_ROOT=… node scripts/verify-research-sheet-ui.mjs
//
// The fixture server implements /api/research-sheet on `ResearchSheetStore` and /api/watchlist on
// `SharedWatchlistStore` — the classes the Worker runs — plus a minute-capture quote and a Nifty 500
// print, so the whole path (cell → editor → outbox → route → SQLite → the other device's paint) and
// every derived column are exercised without wrangler and without egress. Expected figures are
// computed here, independently, from the committed book and history files and the pure arithmetic
// module, then compared with what the page prints.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ResearchSheetStore } from '../worker/research-sheet-store.mjs';
import { SharedWatchlistStore } from '../worker/watchlist-store.mjs';
import { contentTag, stableJson } from '../worker/http.mjs';
import { closeOnOrBefore, istToday, xirr } from '../public/js/data/sheet-math.js';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const readData = (name) => JSON.parse(readFileSync(resolve(root, 'data', name), 'utf8'));

let failures = 0;
let checks = 0;
const ok = (name, pass, detail = '') => {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- what the page should show, computed from the committed files --------------------------
const book = readData('book.json');
const companies = readData('portfolio-companies.json');
const history = readData('sheet-history.json');
const listedByIsin = new Map(companies.holdings.map((h) => [h.isin, h]));
const direct = book.positions.filter((p) => p.assetClass === 'Equity' && p.engagement !== 'PMS' && listedByIsin.get(p.isin)?.listed !== false);
const expectedKeys = new Set(direct.map((p) => p.symbol || listedByIsin.get(p.isin)?.ticker || `ISIN:${p.isin}`));
const pmsOnly = [...new Set(book.positions.filter((p) => p.engagement === 'PMS' && p.symbol).map((p) => p.symbol))].filter((t) => !expectedKeys.has(t));
const sbinQty = direct.filter((p) => p.symbol === 'SBIN').reduce((s, p) => s + p.quantity, 0);

// ---- the stand-in Worker -------------------------------------------------------------------
const sqlStorage = () => {
  const db = new DatabaseSync(':memory:');
  return {
    sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
};
const sheetStore = new ResearchSheetStore(sqlStorage());
const watchStore = new SharedWatchlistStore(sqlStorage());

const now = Date.now();
const iso = (at) => new Date(at).toISOString();
const istDate = (at) => new Date(at + 19800000).toISOString().slice(0, 10);
const QUOTES = { SBIN: [1012.5, 1000], FRACTAL: [720.4, 707.6], INFY: [1500, 1490], TCS: [2200, 2156] };
const quoteRow = (ticker, [price, prevClose]) => ({
  ticker, name: ticker, price, prevClose, volume: 125000, quoteAt: iso(now - 60000), checkedAt: iso(now - 30000),
  sessionDate: istDate(now - 60000), provider: 'Upstox', exchange: 'NSE', kind: 'quote', base: null,
});
const capture = { version: 1, state: 'complete', rows: Object.entries(QUOTES).map(([t, q]) => quoteRow(t, q)), targets: Object.keys(QUOTES), failures: [] };
const BENCH = 22000;
const benchmark = { ok: true, id: 'nifty500', name: 'Nifty 500', last: BENCH, prev: 21900, changePct: 0.46, asOf: iso(now - 60000), sessionDate: istToday(now), state: 'live', origin: 'nse' };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};
const conditional = (req, res, payload) => {
  const tag = `"${contentTag(stableJson(payload))}"`;
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' }); res.end(); return; }
  json(res, 200, payload, { etag: tag, 'cache-control': 'private, max-age=0, must-revalidate' });
};
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };
let sheetWrites = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const staticOrigin = req.headers['x-fixture-static'] === '1';
  if (url.pathname === '/api/research-sheet' && !staticOrigin) {
    if (req.method === 'POST') {
      try {
        const result = sheetStore.apply((await readBody(req)).intents);
        sheetWrites++;
        return json(res, 200, { ok: true, ...result.snapshot, outcomes: result.outcomes });
      } catch { return json(res, 400, { ok: false, reason: 'invalid-request' }); }
    }
    return conditional(req, res, { ok: true, ...sheetStore.snapshot() });
  }
  if (url.pathname === '/api/watchlist' && !staticOrigin) {
    if (req.method === 'POST') {
      try {
        const result = watchStore.watchlistApply((await readBody(req)).intents);
        return json(res, 200, { ok: true, ...result.snapshot, outcomes: result.outcomes });
      } catch { return json(res, 400, { ok: false, reason: 'invalid-request' }); }
    }
    return conditional(req, res, { ok: true, ...watchStore.watchlistSnapshot() });
  }
  if (url.pathname === '/api/breakouts' && !staticOrigin) return json(res, 200, capture);
  if (url.pathname === '/api/benchmark-quote' && !staticOrigin) return json(res, 200, benchmark);
  if (url.pathname === '/api/stock-search' && !staticOrigin) {
    return json(res, 200, { ok: true, results: [{ ticker: 'SBIN', name: 'State Bank of India', country: 'India', industry: 'Banks' }] });
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('{}'); return; }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
  try {
    const content = readFileSync(file);
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[extname(file)] || 'text/plain');
    res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const pageErrors = [];

async function openDevice({ staticOrigin = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  if (staticOrigin) await context.setExtraHTTPHeaders({ 'x-fixture-static': '1' });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  // Nothing leaves this fixture.
  await page.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort()));
  return { context, page };
}

const table = (page, kind) => page.locator(`[data-sheet-table="${kind}"]`);
const cell = (page, kind, key, field) => table(page, kind).locator(`[data-sheet-edit][data-sheet-key="${key}"][data-sheet-field="${field}"]`);
const rowOf = (page, kind, key) => table(page, kind).locator(`tbody tr[data-row-key="${key}"]`);
const pctOf = (text) => Number(String(text).replace(/[^0-9.+-]/g, ''));
async function columnText(page, kind, key, label) {
  const heads = (await table(page, kind).locator('thead th').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase());
  const index = heads.findIndex((h) => h === label.toLowerCase() || h.startsWith(label.toLowerCase()));
  if (index < 0) return null;
  return (await rowOf(page, kind, key).locator('td').nth(index).innerText()).replace(/\s+/g, ' ').trim();
}
async function editCell(page, kind, key, field, text, { name = null } = {}) {
  await cell(page, kind, key, field).click();
  const input = page.locator('.sheet-editor [data-sheet-input]');
  await input.waitFor();
  await input.fill(text);
  if (name !== null) await page.locator('.sheet-editor [data-sheet-by]').fill(name);
  await input.press('Enter');
}
const waitFor = async (fn, timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 120)); }
  return false;
};

try {
  console.log('\n— navigation —');
  const a = await openDevice();
  await a.page.goto(`${origin}/#/research/portfolio`, { waitUntil: 'domcontentloaded' });
  await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  const tabs = (await a.page.locator('#tabbar-mount [data-tab-id]').evaluateAll((els) => els.map((e) => e.textContent.trim()))).slice(0, 6);
  ok('the bar reads AI Alerts, Portfolio, Watchlist, Corp Announcements, News, All Alerts', JSON.stringify(tabs) === JSON.stringify(['AI Alerts', 'Portfolio', 'Watchlist', 'Corp Announcements', 'News', 'All Alerts']), JSON.stringify(tabs));
  ok('AI Alerts is still the first tab, so still the landing page', tabs[0] === 'AI Alerts');
  ok('the scope toggle is hidden: this tab IS the portfolio', await a.page.locator('[data-scope-controls]').evaluate((el) => el.hidden));

  console.log('\n— the portfolio rows —');
  const keys = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').evaluateAll((els) => els.map((e) => e.dataset.rowKey));
  ok('one row per public-direct holding on the statements', keys.length === expectedKeys.size && keys.every((k) => expectedKeys.has(k)), `${keys.length} rows, ${expectedKeys.size} expected`);
  ok('no PMS-only holding appears', pmsOnly.length > 0 && !pmsOnly.some((t) => keys.includes(t)), `${pmsOnly.length} PMS-only tickers checked`);
  const cmpShown = pctOf(await columnText(a.page, 'portfolio', 'SBIN', 'CMP (in Rs)'));
  const reader = await a.page.evaluate(async () => {
    const m = await import('/js/data/sheet-market.js');
    const q = m.quote('SBIN');
    return { price: q?.price, source: q?.source };
  });
  ok('CMP is the shared minute-capture reader\'s price', Math.abs(cmpShown - reader.price) < 0.006, `${cmpShown} vs ${reader.price}`);
  if (reader.source === 'Upstox') {
    ok('…which is the captured Upstox quote', Math.abs(reader.price - QUOTES.SBIN[0]) < 1e-9);
    const day = pctOf(await columnText(a.page, 'portfolio', 'SBIN', '1 day return'));
    ok('1-day return is the quote against its previous close', Math.abs(day - (QUOTES.SBIN[0] / QUOTES.SBIN[1] - 1) * 100) < 0.051, String(day));
  } else console.log('  SKIP  the daily close is newer than the captured quote today; the quote checks do not apply');
  const qtyCell = cell(a.page, 'portfolio', 'SBIN', 'quantity');
  ok('quantity defaults to the shares on the statements, shown as a default', (await qtyCell.innerText()).replace(/,/g, '').trim() === String(sbinQty) && /is-default/.test(await qtyCell.getAttribute('class')), await qtyCell.innerText());
  ok('a statement default says which statement it came from', /statement of/.test(await qtyCell.getAttribute('title')));
  ok('TSR waits for a buy price rather than printing a number', (await columnText(a.page, 'portfolio', 'SBIN', 'TSR % including')) === '—');

  console.log('\n— editing —');
  await editCell(a.page, 'portfolio', 'SBIN', 'buyPrice', 'abc', { name: 'Ravi' });
  ok('a value that is not a number is refused in the panel, by name', /Not a number/.test(await a.page.locator('.sheet-editor [data-sheet-error]').innerText()));
  await a.page.locator('.sheet-editor [data-sheet-input]').fill('700');
  await a.page.locator('.sheet-editor [data-sheet-input]').press('Enter');
  await editCell(a.page, 'portfolio', 'SBIN', 'dateBought', '01-Jan-2099');
  ok('a purchase date in the future is refused', /future/.test(await a.page.locator('.sheet-editor [data-sheet-error]').innerText()));
  await a.page.locator('.sheet-editor [data-sheet-input]').fill('16-May-25');
  await a.page.locator('.sheet-editor [data-sheet-input]').press('Enter');
  ok('the typed value reaches the shared sheet', await waitFor(async () => !!sheetStore.snapshot().values.SBIN?.dateBought && /is-edited/.test(await cell(a.page, 'portfolio', 'SBIN', 'dateBought').getAttribute('class'))));
  ok('it is signed with the name typed in the panel', sheetStore.snapshot().values.SBIN?.buyPrice?.by === 'Ravi');
  ok('Date bought reads DD-MMM-YY', (await cell(a.page, 'portfolio', 'SBIN', 'dateBought').innerText()).trim() === '16-May-25');
  ok('amount invested defaults to quantity × buy price', Math.abs(pctOf(await cell(a.page, 'portfolio', 'SBIN', 'amountInvested').innerText()) - (sbinQty * 700) / 1e7) < 0.006);

  // Expected figures, computed here from the history file and the page's own CMP.
  const price = reader.price;
  const today = istToday(Date.now());
  const ev = history.companies.SBIN;
  const divs = ev.dividends.filter(([d]) => d > '2025-05-16' && d <= today).map(([d, amt]) => ({ date: d, amount: Math.round(amt * sbinQty * 100) / 100 }));
  const divTotal = divs.reduce((s, f) => s + f.amount, 0);
  const invested = sbinQty * 700;
  const tsr = ((price * sbinQty + divTotal - invested) / invested) * 100;
  const tsrText = await columnText(a.page, 'portfolio', 'SBIN', 'TSR % including');
  ok('TSR = (current value + dividends after the ex-date − invested) ÷ invested', Math.abs(pctOf(tsrText) - tsr) < 0.051 && !/excl/.test(tsrText), `${tsrText} vs ${tsr.toFixed(2)} (${divs.length} dividend${divs.length === 1 ? '' : 's'})`);
  ok('the dividend on the purchase date itself is not counted', !divs.some((d) => d.date === '2025-05-16') && ev.dividends.some(([d]) => d === '2025-05-16'));
  await waitFor(async () => /live print/.test(await table(a.page, 'portfolio').locator('tbody tr[data-row-key="SBIN"] [title*="Nifty 500"]').first().getAttribute('title') || ''));
  const base = closeOnOrBefore(history.benchmark.rows, '2025-05-16');
  const alpha = tsr - (BENCH / base[1] - 1) * 100;
  ok('alpha = TSR − the Nifty 500 from the close on the date bought to its live print', Math.abs(pctOf(await columnText(a.page, 'portfolio', 'SBIN', 'Alpha over NSE 500')) - alpha) < 0.051, `${alpha.toFixed(2)}`);
  const rate = xirr([{ date: '2025-05-16', amount: -invested }, ...divs, { date: today, amount: price * sbinQty }]) * 100;
  ok('XIRR is the money-weighted return of the purchase, the dividends and today\'s value', Math.abs(pctOf(await columnText(a.page, 'portfolio', 'SBIN', 'XIRR (TSR)')) - rate) < 0.051, rate.toFixed(2));

  await editCell(a.page, 'portfolio', 'SBIN', 'targetAmount', '5');
  const totals = await a.page.evaluate(async () => (await import('/js/tabs/portfolio.js'))._rows().total);
  ok('target weight is derived from the target amount against the public-direct value', await waitFor(async () => Math.abs(pctOf(await cell(a.page, 'portfolio', 'SBIN', 'targetWeight').innerText()) - (5 / totals) * 100) < 0.051));
  ok('pending amount = target − amount invested', await waitFor(async () => Math.abs(pctOf(await cell(a.page, 'portfolio', 'SBIN', 'pendingAmount').innerText()) - (5 - invested / 1e7)) < 0.006));

  await editCell(a.page, 'portfolio', 'SBIN', 'quantity', '30000');
  await cell(a.page, 'portfolio', 'SBIN', 'quantity').click();
  await a.page.locator('.sheet-editor [data-sheet-clear]').click();
  ok('Reset to default restores the statement figure', await waitFor(async () => /is-default/.test(await cell(a.page, 'portfolio', 'SBIN', 'quantity').getAttribute('class'))
    && (await cell(a.page, 'portfolio', 'SBIN', 'quantity').innerText()).replace(/,/g, '').trim() === String(sbinQty)));

  console.log('\n— one sheet for the desk —');
  const b = await openDevice();
  await b.page.goto(`${origin}/#/research/portfolio`, { waitUntil: 'domcontentloaded' });
  await table(b.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  ok('a second device sees the buy price the first one typed, as a typed value', await waitFor(async () => (await cell(b.page, 'portfolio', 'SBIN', 'buyPrice').innerText()).trim() === '700.00'
    && /is-edited/.test(await cell(b.page, 'portfolio', 'SBIN', 'buyPrice').getAttribute('class'))));
  ok('…and who typed it', /Ravi/.test(await cell(b.page, 'portfolio', 'SBIN', 'buyPrice').getAttribute('title')));
  ok('the pill says the values are the desk\'s shared sheet', (await b.page.locator('[data-sheet-status]').getAttribute('data-sheet-status')) === 'live');

  console.log('\n— the watchlist —');
  await a.page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await a.page.locator('[data-watchlist-sheet-empty]').waitFor({ timeout: 15000 });
  ok('an empty watchlist says so and offers the way to add', await a.page.locator('[data-watchlist-sheet-empty] [data-watchlist-sheet-add]').isVisible());
  ok('the scope toggle is hidden here too', await a.page.locator('[data-scope-controls]').evaluate((el) => el.hidden));
  await a.page.locator('[data-watchlist-sheet-empty] [data-watchlist-sheet-add]').click();
  await a.page.locator('[data-scope-search]').fill('SBIN');
  await a.page.locator('[data-scope-result]').first().click();
  await a.page.locator('[data-watch-attribution]').waitFor();
  if (await a.page.locator('[data-attribution-input]').isVisible()) await a.page.locator('[data-attribution-input]').fill('Ravi');
  await a.page.locator('[data-attribution-confirm]').click();
  // The contributor prompt is a modal of its own; close the editor if it is still showing.
  await a.page.waitForTimeout(300);
  if (await a.page.locator('[data-scope-editor]').count()) await a.page.locator('[data-scope-editor] [data-modal-close]').last().click();
  await rowOf(a.page, 'watchlist', 'SBIN').waitFor({ timeout: 15000 });
  const heads = (await table(a.page, 'watchlist').locator('thead th').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase());
  ok('Source sits between Sector and CMP', heads[1] === 'sector' && heads[2] === 'source' && heads[3].startsWith('cmp'), JSON.stringify(heads.slice(0, 4)));
  ok('the watchlist has the desk\'s columns and no holding columns', !heads.some((h) => /quantity|date bought|xirr|tsr|current value/.test(h)) && heads.some((h) => /expected irr/.test(h)));
  ok('the company added through the shared list is a row', await waitFor(async () => watchStore.watchlistSnapshot().companies.some((c) => c.ticker === 'SBIN' && c.addedBy === 'Ravi')));
  ok('the fair value typed on the Portfolio is already here', (await cell(a.page, 'watchlist', 'SBIN', 'targetAmount').innerText()).trim() === '5.00');
  await editCell(a.page, 'watchlist', 'SBIN', 'source', 'Broker note — Kotak');
  await editCell(a.page, 'watchlist', 'SBIN', 'intrinsicValue', '1,150');
  ok('expected IRR waits for the buy price it is measured from', /set buy price/.test(await cell(a.page, 'watchlist', 'SBIN', 'entryPrice').innerText()));
  await editCell(a.page, 'watchlist', 'SBIN', 'entryPrice', '900');
  ok('expected IRR = intrinsic value ÷ buy price − 1', await waitFor(async () => Math.abs(pctOf((await columnText(a.page, 'watchlist', 'SBIN', 'Expected IRR')).split(' ')[0]) - (1150 / 900 - 1) * 100) < 0.051));
  ok('upside = intrinsic value ÷ CMP − 1', Math.abs(pctOf(await columnText(a.page, 'watchlist', 'SBIN', 'Upside available')) - (1150 / price - 1) * 100) < 0.051);
  ok('Source is stored on the shared sheet', await waitFor(async () => sheetStore.snapshot().values.SBIN?.source?.value === 'Broker note — Kotak'));
  ok('the watchlist\'s buy price does not touch the portfolio\'s', sheetStore.snapshot().values.SBIN?.buyPrice?.value === 700 && sheetStore.snapshot().values.SBIN?.entryPrice?.value === 900);

  await a.page.locator('#tabbar-mount [data-tab-id="portfolio"]').click();
  await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 15000 });
  ok('the fair value typed on the Watchlist is the Portfolio\'s too', (await cell(a.page, 'portfolio', 'SBIN', 'intrinsicValue').innerText()).trim() === '1,150.00');
  ok('expected IRR on the Portfolio uses the price paid', Math.abs(pctOf(await columnText(a.page, 'portfolio', 'SBIN', 'Expected IRR')) - (1150 / 700 - 1) * 100) < 0.051);

  console.log('\n— a holding the statements do not carry yet —');
  const before = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').count();
  await a.page.locator('[data-portfolio-add]').click();
  await a.page.locator('[data-company-search-input]').fill('INFY');
  await a.page.locator('[data-company-result]').first().waitFor();
  await a.page.locator('[data-company-result]:not([disabled])').first().click();
  ok('Add holding puts the company on the sheet', await waitFor(async () => (await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').count()) === before + 1));
  ok('…as a hand-added row on the shared sheet', await waitFor(async () => sheetStore.snapshot().rows.some((r) => r.key === 'INFY')));
  await rowOf(a.page, 'portfolio', 'INFY').hover();
  await rowOf(a.page, 'portfolio', 'INFY').locator('[data-sheet-remove]').click();
  ok('a hand-added holding can be removed again', await waitFor(async () => (await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').count()) === before && !sheetStore.snapshot().rows.some((r) => r.key === 'INFY')));

  console.log('\n— a deployment with no shared sheet —');
  const c = await openDevice({ staticOrigin: true });
  await c.page.goto(`${origin}/#/research/portfolio`, { waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  ok('it says edits are kept in this browser only', await waitFor(async () => (await c.page.locator('[data-sheet-status]').getAttribute('data-sheet-status')) === 'local'));
  await editCell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue', '900');
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  ok('…and keeps them across a reload', (await cell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue').innerText()).trim() === '900.00');
  ok('…marked as not on a shared sheet', /is-pending/.test(await cell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue').getAttribute('class')));
  ok('nothing it typed reached the shared store', !sheetStore.snapshot().values.FRACTAL);

  ok('zero page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

console.log(`\n${checks - failures} of ${checks} checks passed (${sheetWrites} shared-sheet writes)`);
if (failures) process.exit(1);
