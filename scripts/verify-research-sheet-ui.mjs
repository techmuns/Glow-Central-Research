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
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ResearchSheetStore } from '../worker/research-sheet-store.mjs';
import { SharedWatchlistStore } from '../worker/watchlist-store.mjs';
import { contentTag, stableJson } from '../worker/http.mjs';
import { closeOnOrBefore, istToday, xirr } from '../public/js/data/sheet-math.js';
import { SHEET_REQUEST_BYTES } from '../public/js/data/research-sheet-shared.js';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const excelBrowser = readFileSync(resolve(process.env.EXCELJS_ROOT || resolve(PW_ROOT, '../exceljs'), 'dist/exceljs.min.js'));
const output = resolve('.cache/sheet-upload');
mkdirSync(output, { recursive: true });
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
const sheetPayloadBytes = [];
const readBody = async (req) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const bytes = Buffer.concat(chunks);
  if (req.url === '/api/research-sheet') sheetPayloadBytes.push(bytes.length);
  return JSON.parse(bytes.toString('utf8') || '{}');
};
let sheetWrites = 0;
let writeFailure = null;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const staticOrigin = req.headers['x-fixture-static'] === '1';
  if (url.pathname === '/api/research-sheet' && !staticOrigin) {
    if (req.method === 'POST') {
      if (writeFailure) return json(res, writeFailure, { ok: false, reason: 'fixture-refusal' });
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
  await page.route('**/*', (route) => route.request().url().includes('/exceljs@4.4.0/')
    ? route.fulfill({ status: 200, contentType: 'text/javascript', body: excelBrowser })
    : route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort());
  return { context, page };
}

const table = (page, kind) => page.locator(`[data-sheet-table="${kind}"]`);
const cell = (page, kind, key, field) => table(page, kind).locator(`[data-sheet-edit][data-sheet-key="${key}"][data-sheet-field="${field}"]`);
const rowOf = (page, kind, key) => table(page, kind).locator(`tbody tr[data-row-key="${key}"]`);
const fillHandle = (page, kind, key, field) => table(page, kind).locator(`[data-sheet-fill-handle][data-sheet-key="${key}"][data-sheet-field="${field}"]`);
async function dragFill(page, kind, source, target, field, { cancel = false, during = null } = {}) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const handle = fillHandle(page, kind, source, field);
  await handle.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await handle.hover();
  const a = await handle.boundingBox();
  const b = await cell(page, kind, target, field).evaluate(el => { const r = el.closest('td').getBoundingClientRect(); return { y: r.y + r.height / 2 }; });
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, b.y, { steps: 8 });
  if (during) await during();
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}
async function pasteCells(page, kind, key, field, text, { editor = true, keyboard = false } = {}) {
  const button = cell(page, kind, key, field);
  if (editor) await button.click(); else await button.focus();
  const target = editor ? page.locator('.sheet-editor [data-sheet-input]') : button;
  if (keyboard) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  } else await target.evaluate((el, text) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  }, text);
}
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
  const isDate = await input.getAttribute('type') === 'date';
  if (name !== null) await page.locator('.sheet-editor [data-sheet-by]').fill(name);
  await input.fill(text);
  if (!isDate) await input.press('Enter');
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
  ok('Sattva navigation is retained with the two Glow sheets after Alerts', JSON.stringify(tabs) === JSON.stringify(['Alerts', 'Portfolio', 'Watchlist', 'Announcements', 'Earnings', 'Screens']), JSON.stringify(tabs));
  ok('Alerts is still the first navigation group', tabs[0] === 'Alerts');
  ok('the research scope selector stays visible beside the unchanged portfolio sheet', await a.page.locator('[data-scope-controls]').isVisible());

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
  ok('cell editors omit the explanatory paragraphs', await a.page.locator('.sheet-editor-hint, .sheet-editor-note').count() === 0);
  await a.page.locator('.sheet-editor [data-sheet-input]').fill('700');
  await a.page.locator('.sheet-editor [data-sheet-input]').press('Enter');
  ok('Date bought cells advertise a clickable calendar', await cell(a.page, 'portfolio', 'SBIN', 'dateBought').locator('.sheet-calendar-icon').count() === 1);
  await editCell(a.page, 'portfolio', 'SBIN', 'dateBought', '2099-01-01');
  const dateInput = a.page.locator('.sheet-editor [data-sheet-input]');
  ok('Date bought uses the native calendar with the supported date bounds', await dateInput.getAttribute('type') === 'date'
    && await dateInput.getAttribute('min') === '1950-01-01' && await dateInput.getAttribute('max') === istToday());
  ok('a purchase date in the future is refused', /future/.test(await a.page.locator('.sheet-editor [data-sheet-error]').innerText()));
  ok('the date editor has no separate Save button and an invalid date is not stored', await a.page.locator('.sheet-editor button[type="submit"]').count() === 0
    && !sheetStore.snapshot().values.SBIN?.dateBought);
  await a.page.locator('[data-sheet-cancel]').click();
  await a.page.evaluate(async () => (await import('/js/core/watchlist-people.js')).remember('Someone else'));
  await cell(a.page, 'portfolio', 'SBIN', 'dateBought').click();
  const dateBy = a.page.locator('[data-sheet-by]');
  ok('date attribution is reachable before the calendar opens', await dateBy.evaluate(el => document.activeElement === el)
    && await dateBy.inputValue() === 'Someone else');
  await dateBy.press('ControlOrMeta+A');
  await dateBy.pressSequentially('Ravi');
  await dateInput.fill('2025-05-16');
  ok('selecting a date saves it automatically and closes the editor', await waitFor(async () => sheetStore.snapshot().values.SBIN?.dateBought?.value === '2025-05-16'
    && /is-edited/.test(await cell(a.page, 'portfolio', 'SBIN', 'dateBought').getAttribute('class')) && await a.page.locator('.sheet-editor').count() === 0));
  ok('it is signed with the name typed in the panel', sheetStore.snapshot().values.SBIN?.buyPrice?.by === 'Ravi');
  ok('the automatically saved date keeps its editor attribution', sheetStore.snapshot().values.SBIN?.dateBought?.by === 'Ravi');
  ok('Date bought reads DD-MMM-YY', (await cell(a.page, 'portfolio', 'SBIN', 'dateBought').innerText()).trim() === '16-May-25');
  await cell(a.page, 'portfolio', 'SBIN', 'dateBought').click();
  ok('reopening selects the saved date in the calendar', await dateInput.inputValue() === '2025-05-16');
  await a.page.locator('.sheet-editor [data-sheet-cancel]').click();
  ok('closing without selecting a date preserves the saved date', sheetStore.snapshot().values.SBIN?.dateBought?.value === '2025-05-16');
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
  ok('confirmed shared values need no routine header badge', await b.page.evaluate(async () => (await import('/js/ui/sheet-chrome.js')).sheetStatus().tone === 'live')
    && await b.page.locator('[data-sheet-status]').count() === 0);

  console.log('\n— a colleague\'s edit reaches a sheet that is already open —');
  const stored = (field, value) => waitFor(async () => sheetStore.snapshot().values.SBIN?.[field]?.value === value);
  // Nothing on B is touched here: no reload, no focus, no click. Only its own check can bring it.
  await editCell(a.page, 'portfolio', 'SBIN', 'methodology', 'DCF — desk');
  await stored('methodology', 'DCF — desk');
  ok('an open sheet shows a colleague\'s edit by itself, within its twenty-second check',
    await waitFor(async () => (await cell(b.page, 'portfolio', 'SBIN', 'methodology').innerText()).includes('DCF — desk'), 25000));
  await new Promise((done) => setTimeout(done, 5200)); // past the re-check gap since B's last check
  // A financial-year note stored before the reference column gained its calendar.
  await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).set('SBIN', 'reference', 'FY27E · Oct-26', 'Ravi'));
  await stored('reference', 'FY27E · Oct-26');
  await b.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  ok('a window coming back into focus re-checks at once', await waitFor(async () => (await cell(b.page, 'portfolio', 'SBIN', 'reference').innerText()).includes('FY27E'), 2500));
  await cell(a.page, 'portfolio', 'SBIN', 'reference').click();
  const referenceInput = a.page.locator('.sheet-editor [data-sheet-input]');
  ok('Reference year and date offers a calendar with future years', await referenceInput.getAttribute('type') === 'date'
    && await referenceInput.getAttribute('max') === '2100-12-31');
  ok('an earlier financial-year note remains visible in the date editor', /FY27E · Oct-26/.test(await a.page.locator('[data-sheet-legacy]').innerText()));
  await a.page.locator('[data-sheet-cancel]').click();
  ok('closing without choosing a date preserves the earlier note', sheetStore.snapshot().values.SBIN?.reference?.value === 'FY27E · Oct-26');
  await editCell(a.page, 'portfolio', 'SBIN', 'reference', '2030-03-31');
  ok('a future reference date is saved and displayed as a date', await stored('reference', '2030-03-31')
    && (await cell(a.page, 'portfolio', 'SBIN', 'reference').innerText()).trim() === '31-Mar-30');
  await cell(a.page, 'portfolio', 'SBIN', 'reference').click();
  ok('reopening the reference calendar selects the saved future date', await referenceInput.inputValue() === '2030-03-31');
  await referenceInput.fill('');
  ok('clearing the native date input automatically clears the saved date', await stored('reference', undefined));
  await editCell(a.page, 'portfolio', 'SBIN', 'reference', '2030-03-31');
  await stored('reference', '2030-03-31');

  // An editor open on B while A changes the same cell.
  const syncB = () => b.page.evaluate(async () => { await (await import('/js/core/research-sheet.js')).syncNow({ force: true }); });
  const bInput = b.page.locator('.sheet-editor [data-sheet-input]');
  await cell(b.page, 'portfolio', 'SBIN', 'intrinsicValue').click();
  await bInput.waitFor();
  await editCell(a.page, 'portfolio', 'SBIN', 'intrinsicValue', '1250');
  await stored('intrinsicValue', 1250);
  await syncB();
  ok('an editor nobody has typed in follows the colleague\'s newer value', await waitFor(async () => (await bInput.inputValue()) === '1250'));
  ok('…and stays open on the same cell', (await b.page.locator('.sheet-editor').count()) === 1
    && /Intrinsic/i.test(await b.page.locator('.sheet-editor .sheet-editor-title').innerText()));
  await bInput.fill('1300');
  await editCell(a.page, 'portfolio', 'SBIN', 'intrinsicValue', '1275');
  await stored('intrinsicValue', 1275);
  await syncB();
  const changedNote = b.page.locator('.sheet-editor [data-sheet-changed]');
  ok('an editor somebody has typed in says who changed the cell, and to what', await waitFor(async () => (await changedNote.isVisible())
    && /1,275/.test(await changedNote.innerText()) && /Ravi/.test(await changedNote.innerText())), await changedNote.innerText().catch(() => ''));
  ok('…and keeps every character typed', (await bInput.inputValue()) === '1300');
  await bInput.press('Escape');
  ok('cancelling leaves the colleague\'s value on both devices', await waitFor(async () => (await cell(b.page, 'portfolio', 'SBIN', 'intrinsicValue').innerText()).trim() === '1,275.00')
    && (await cell(a.page, 'portfolio', 'SBIN', 'intrinsicValue').innerText()).trim() === '1,275.00');

  console.log('\n— the watchlist —');
  await a.page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await a.page.locator('[data-watchlist-sheet-empty]').waitFor({ timeout: 15000 });
  ok('an empty watchlist says so and offers the way to add', await a.page.locator('[data-watchlist-sheet-empty] [data-watchlist-sheet-add]').isVisible());
  ok('the research scope selector stays visible beside the unchanged watchlist sheet', await a.page.locator('[data-scope-controls]').isVisible());
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
  await cell(a.page, 'watchlist', 'SBIN', 'reference').click();
  ok('the Watchlist shares the reference date and its calendar', await a.page.locator('[data-sheet-input]').getAttribute('type') === 'date'
    && await a.page.locator('[data-sheet-input]').inputValue() === '2030-03-31');
  ok('the Watchlist date editor also omits Save', await a.page.locator('.sheet-editor button[type="submit"]').count() === 0);
  await a.page.locator('[data-sheet-input]').fill('2031-03-31');
  ok('selecting a Watchlist reference date saves it automatically', await stored('reference', '2031-03-31')
    && (await cell(a.page, 'watchlist', 'SBIN', 'reference').innerText()).trim() === '31-Mar-31');
  await editCell(a.page, 'watchlist', 'SBIN', 'source', 'Broker note — Kotak');
  await editCell(a.page, 'watchlist', 'SBIN', 'intrinsicValue', '1,150');
  ok('expected IRR waits for the buy price it is measured from', /set buy price/.test(await cell(a.page, 'watchlist', 'SBIN', 'entryPrice').innerText()));
  await editCell(a.page, 'watchlist', 'SBIN', 'entryPrice', '900');
  ok('expected IRR = intrinsic value ÷ buy price − 1', await waitFor(async () => Math.abs(pctOf((await columnText(a.page, 'watchlist', 'SBIN', 'Expected IRR')).split(' ')[0]) - (1150 / 900 - 1) * 100) < 0.051));
  ok('upside = intrinsic value ÷ CMP − 1', Math.abs(pctOf(await columnText(a.page, 'watchlist', 'SBIN', 'Upside available')) - (1150 / price - 1) * 100) < 0.051);
  ok('Source is stored on the shared sheet', await waitFor(async () => sheetStore.snapshot().values.SBIN?.source?.value === 'Broker note — Kotak'));
  ok('the watchlist\'s buy price does not touch the portfolio\'s', await waitFor(async () => sheetStore.snapshot().values.SBIN?.buyPrice?.value === 700 && sheetStore.snapshot().values.SBIN?.entryPrice?.value === 900));

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

  console.log('\n— Excel-style fill down —');
  const search = table(a.page, 'portfolio').locator('[data-table-search]');
  await search.fill('');
  await table(a.page, 'portfolio').locator('th[data-sort="name"]').click();
  const ordered = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(r => r.dataset.rowKey));
  const [first, second, third, fourth, fifth] = ordered;
  await editCell(a.page, 'portfolio', first, 'methodology', 'DCF', { name: 'Ravi' });
  const originalSecond = await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).entry(key, 'methodology')?.value ?? null, second);
  await fillHandle(a.page, 'portfolio', first, 'methodology').click();
  ok('clicking the handle without dragging does not edit or open an editor', await a.page.locator('.sheet-editor').count() === 0
    && await a.page.evaluate(async ({ key, old }) => (await import('/js/core/research-sheet.js')).value(key, 'methodology') === old, { key: second, old: originalSecond }));
  await dragFill(a.page, 'portfolio', first, third, 'methodology', { during: async () => {
    ok('drag highlights exactly the two destination cells', await a.page.locator('.sheet-fill-target').count() === 2);
    ok('drag preview has not saved any destination', await a.page.evaluate(async ({ key, old }) => (await import('/js/core/research-sheet.js')).value(key, 'methodology') === old, { key: second, old: originalSecond }));
    await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'reference', 'Unrelated edit', 'Ravi'), fourth);
  } });
  ok('release copies the entered text into just the selected rows', await waitFor(async () => [second, third].every(k => sheetStore.snapshot().values[k]?.methodology?.value === 'DCF'))
    && sheetStore.snapshot().values[fourth]?.methodology?.value !== 'DCF');
  await b.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  ok('filled values reach another device through the shared store', await waitFor(async () => (await cell(b.page, 'portfolio', second, 'methodology').innerText()).trim() === 'DCF'));
  ok('unrelated edits survive a drag and drop', sheetStore.snapshot().values[fourth]?.reference?.value === 'Unrelated edit');
  await a.page.locator('[data-sheet-fill-undo]').click();
  ok('Undo restores the previous typed value or default', await waitFor(async () => (await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).value(key, 'methodology'), second)) === originalSecond));
  await dragFill(a.page, 'portfolio', first, third, 'methodology', { cancel: true });
  ok('Escape cancels a drag without changing destination cells', (await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).value(key, 'methodology'), second)) === originalSecond
    && await a.page.locator('.sheet-fill-preview, .sheet-fill-target').count() === 0);
  await dragFill(a.page, 'portfolio', first, third, 'methodology', { during: async () => {
    await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'methodology', 'Colleague edit', 'Mira'), second);
  } });
  ok('a destination changed during the gesture cancels the fill', (await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).value(key, 'methodology'), second)) === 'Colleague edit'
    && /Cells changed/.test(await a.page.locator('.sheet-fill-feedback').innerText()));
  await waitFor(async () => (await cell(a.page, 'portfolio', second, 'methodology').innerText()).trim() === 'Colleague edit');
  await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'methodology', 'Prior target', 'Ravi'), third);
  await waitFor(async () => (await cell(a.page, 'portfolio', third, 'methodology').innerText()).trim() === 'Prior target');
  await dragFill(a.page, 'portfolio', first, third, 'methodology');
  await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'methodology', 'Later edit', 'Mira'), second);
  await a.page.locator('[data-sheet-fill-undo]').click();
  ok('Undo restores an overwritten value and preserves a later edit by another person', await a.page.evaluate(async ({ second, third }) => {
    const s = await import('/js/core/research-sheet.js'); return s.value(second, 'methodology') === 'Later edit' && s.value(third, 'methodology') === 'Prior target';
  }, { second, third }));

  await dragFill(a.page, 'portfolio', first, third, 'methodology', { during: () => search.fill(first) });
  ok('changing the filter while dragging never writes into hidden rows', await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).value(key, 'methodology') === 'Later edit', second));
  await search.fill('');

  await a.page.evaluate(async keys => {
    const s = await import('/js/core/research-sheet.js');
    s.editMany(keys.map(key => ({ op: 'set', key, field: 'sector', value: 'Fill subset', by: 'Ravi' })));
    s.set(keys[0], 'reference', 'FY28', 'Ravi');
  }, [first, third, fifth]);
  await search.fill('Fill subset');
  await a.page.waitForFunction(() => document.querySelectorAll('[data-sheet-table=portfolio] tbody tr[data-row-key]').length === 3);
  await dragFill(a.page, 'portfolio', first, fifth, 'reference');
  ok('filtered fill follows displayed order and skips hidden rows', await waitFor(async () => [third, fifth].every(k => sheetStore.snapshot().values[k]?.reference?.value === 'FY28'))
    && sheetStore.snapshot().values[fourth]?.reference?.value === 'Unrelated edit');
  await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'targetWeight', 0, 'Ravi'), first);
  await waitFor(async () => (await cell(a.page, 'portfolio', first, 'targetWeight').innerText()).trim() === '0.0%');
  await fillHandle(a.page, 'portfolio', first, 'targetWeight').focus();
  await a.page.keyboard.press('ArrowDown'); await a.page.keyboard.press('ArrowDown'); await a.page.keyboard.press('Enter');
  ok('keyboard fill copies numeric zero as a number', await waitFor(async () => [first, third, fifth].every(k => sheetStore.snapshot().values[k]?.targetWeight?.value === 0)));
  await a.page.evaluate(async key => (await import('/js/core/research-sheet.js')).set(key, 'dateBought', '2024-03-12', 'Ravi'), first);
  await waitFor(async () => (await cell(a.page, 'portfolio', first, 'dateBought').innerText()).trim() === '12-Mar-24');
  await fillHandle(a.page, 'portfolio', first, 'dateBought').focus();
  await a.page.keyboard.press('ArrowDown'); await a.page.keyboard.press('ArrowDown'); await a.page.keyboard.press('Enter');
  ok('dates copy their ISO value without reparsing the formatted cell', await waitFor(async () => [third, fifth].every(k => sheetStore.snapshot().values[k]?.dateBought?.value === '2024-03-12')),
    JSON.stringify([first, third, fifth].map(k => [k, sheetStore.snapshot().values[k]?.dateBought?.value])));
  ok('market-derived cells and company identity offer no fill handle', await table(a.page, 'portfolio').locator('[data-sheet-fill-handle][data-sheet-field="cmp"], [data-sheet-fill-handle][data-sheet-field="name"]').count() === 0);

  await search.fill('');
  await a.page.waitForFunction(n => document.querySelectorAll('[data-sheet-table=portfolio] tbody tr[data-row-key]').length === n, ordered.length);
  await editCell(a.page, 'portfolio', first, 'methodology', 'Scroll fill');
  const handle = fillHandle(a.page, 'portfolio', first, 'methodology');
  await handle.hover();
  const h = await handle.boundingBox(), area = await table(a.page, 'portfolio').locator('[data-table-scroll]').boundingBox();
  await a.page.mouse.move(h.x + 8, h.y + 8); await a.page.mouse.down();
  await a.page.mouse.move(h.x + 8, area.y + area.height - 3, { steps: 8 });
  ok('dragging at the lower edge scrolls and extends beyond the first viewport', await waitFor(async () => await a.page.locator('.sheet-fill-target').count() >= 15));
  await a.page.keyboard.press('Escape'); await a.page.mouse.up();
  ok('cancelling an auto-scrolled selection leaves no fill pending', await a.page.locator('.sheet-fill-target, .sheet-fill-preview').count() === 0);

  await a.page.evaluate(async () => {
    const w = await import('/js/core/watchlist.js');
    await w.add('INFY', 'Infosys'); await w.add('TCS', 'Tata Consultancy Services');
  });
  await a.page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await rowOf(a.page, 'watchlist', 'TCS').waitFor();
  await table(a.page, 'watchlist').locator('th[data-sort="name"]').click();
  const watched = await table(a.page, 'watchlist').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(r => r.dataset.rowKey));
  await editCell(a.page, 'watchlist', watched[0], 'methodology', 'Watchlist DCF');
  await dragFill(a.page, 'watchlist', watched[0], watched[2], 'methodology');
  ok('Watchlist uses the same fill behavior and shared research values', await waitFor(async () => watched.every(k => sheetStore.snapshot().values[k]?.methodology?.value === 'Watchlist DCF')));

  await waitFor(async () => await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).meta().pending === 0));
  const writesBeforeBatch = sheetWrites;
  const batch = await a.page.evaluate(async () => {
    const s = await import('/js/core/research-sheet.js');
    let signals = 0; const off = s.onChange(() => signals++);
    let invalid = false;
    try { s.editMany([{ op: 'set', key: 'FILLINVALID', field: 'methodology', value: 'Must not persist' }, { op: 'set', key: 'FILLINVALID', field: 'quantity', value: -1 }]); } catch { invalid = true; }
    const clean = !s.entry('FILLINVALID', 'methodology') && signals === 0;
    s.editMany(Array.from({ length: 75 }, (_, i) => ({ op: 'set', key: `FILLBATCH${i}`, field: 'methodology', value: 'Batch DCF', by: 'Ravi' })));
    off(); return { invalid, clean, signals };
  });
  ok('bulk edits validate the entire action before mutating any cell and notify once', batch.invalid && batch.clean && batch.signals === 1);
  ok('a fill exceeding one request drains in bounded shared-save batches', await waitFor(async () => Array.from({ length: 75 }, (_, i) => sheetStore.snapshot().values[`FILLBATCH${i}`]?.methodology?.value).every(v => v === 'Batch DCF')) && sheetWrites - writesBeforeBatch === 2);
  const beforeUnicode = sheetWrites, beforeBytes = sheetPayloadBytes.length;
  await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).editMany(Array.from({ length: 60 }, (_, i) => ({
    op: 'set', key: `FILLUTF${i}`, field: 'source', value: '研'.repeat(120), by: '名'.repeat(60),
  }))));
  ok('multibyte copied text splits by the UTF-8 request budget without losing cells', await waitFor(async () => Array.from({ length: 60 }, (_, i) => sheetStore.snapshot().values[`FILLUTF${i}`]?.source?.value).every(v => v === '研'.repeat(120)))
    && sheetWrites - beforeUnicode >= 2 && sheetPayloadBytes.slice(beforeBytes).every(n => n <= SHEET_REQUEST_BYTES));

  await a.page.evaluate(async () => {
    const { scoreTable } = await import('/js/ui/screener.js');
    const { editableCell } = await import('/js/ui/sheet-cells.js');
    const { wireSheetFill } = await import('/js/ui/sheet-fill.js');
    const s = await import('/js/core/research-sheet.js');
    s.set('FILLPAGE0', 'methodology', 'Paged fill', 'Ravi');
    const rows = () => Array.from({ length: 180 }, (_, i) => {
      const key = `FILLPAGE${i}`, entry = s.entry(key, 'methodology');
      return { key, methodology: { field: 'methodology', value: entry?.value ?? null, edited: !!entry, entry } };
    });
    const host = document.createElement('div'); host.dataset.sheetTable = 'fill-fixture';
    host.style.cssText = 'position:fixed;inset:80px 20px 20px;z-index:50;background:white';
    document.body.append(host);
    const t = scoreTable({ rows: rows(), key: r => r.key, name: r => r.key, showRank: false, showAvatar: false,
      showWatchFilter: false, stickyHead: '340px', initialSort: null,
      columns: [{ label: 'Methodology', html: true, get: r => editableCell(r, r.methodology, { label: 'Methodology', company: r.key }) }] });
    host.innerHTML = t.html; const release = t.wire(host);
    const fill = wireSheetFill(host, { viewRows: t.visibleRows, liveRows: rows });
    window.__fillFixtureCleanup = () => { fill.dispose(); release(); host.remove(); };
  });
  const paged = table(a.page, 'fill-fixture');
  ok('large-table fixture starts with only part of its rows mounted', await paged.locator('tbody tr[data-row-key]').count() < 180);
  await fillHandle(a.page, 'fill-fixture', 'FILLPAGE0', 'methodology').hover();
  const ph = await fillHandle(a.page, 'fill-fixture', 'FILLPAGE0', 'methodology').boundingBox();
  const ps = await paged.locator('[data-table-scroll]').boundingBox();
  await a.page.mouse.move(ph.x + 8, ph.y + 8); await a.page.mouse.down();
  await a.page.mouse.move(ph.x + 8, ps.y + ps.height + 30, { steps: 5 });
  ok('auto-scroll includes newly mounted rows through the final matching row', await waitFor(async () => (await a.page.locator('.sheet-fill-preview').innerText()) === '179 cells', 20000));
  await a.page.mouse.up();
  ok('the last page saves too, with no row lost at the render boundary', await waitFor(async () => Array.from({ length: 180 }, (_, i) => sheetStore.snapshot().values[`FILLPAGE${i}`]?.methodology?.value).every(v => v === 'Paged fill')));
  await paged.locator('[data-table-scroll]').evaluate(el => { el.scrollTop = 0; });
  await cell(a.page, 'fill-fixture', 'FILLPAGE0', 'methodology').waitFor();
  await pasteCells(a.page, 'fill-fixture', 'FILLPAGE0', 'methodology', Array.from({ length: 180 }, (_, i) => `Clipboard ${i}`).join('\r\n') + '\r\n', { editor: false });
  ok('clipboard paste reaches unmounted rows and drains all shared-save batches', await waitFor(async () => Array.from({ length: 180 }, (_, i) => sheetStore.snapshot().values[`FILLPAGE${i}`]?.methodology?.value).every((v, i) => v === `Clipboard ${i}`)));
  await a.page.evaluate(() => window.__fillFixtureCleanup());

  await a.page.locator('#tabbar-mount [data-tab-id="portfolio"]').click();
  await rowOf(a.page, 'portfolio', 'SBIN').waitFor();
  console.log('\n— direct Excel clipboard paste —');
  const pasteKeys = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.slice(0, 4).map(r => r.dataset.rowKey));
  const pasteFields = ['intrinsicValue', 'methodology', 'reference'];
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'methodology', 'Single Excel value\r\n');
  ok('a single Excel value keeps normal text editing instead of saving before Enter', await a.page.locator('[data-sheet-input]').inputValue() === 'Single Excel value'
    && sheetStore.snapshot().values[pasteKeys[0]]?.methodology?.value !== 'Single Excel value');
  await a.page.locator('[data-sheet-input]').press('Enter');
  await waitFor(async () => sheetStore.snapshot().values[pasteKeys[0]]?.methodology?.value === 'Single Excel value');
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'methodology', 'x'.repeat(61) + '\r\n');
  ok('a single pasted value cannot bypass the editor’s character limit', /at most 60/.test(await a.page.locator('.sheet-fill-feedback').innerText())
    && await a.page.locator('[data-sheet-input]').inputValue() === 'Single Excel value');
  await a.page.locator('[data-sheet-input]').press('Escape');
  const beforePaste = await a.page.evaluate(async ({ keys, fields }) => {
    const s = await import('/js/core/research-sheet.js'); return keys.map(k => fields.map(f => s.value(k, f)));
  }, { keys: pasteKeys, fields: pasteFields });
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'intrinsicValue', '₹ 1,250.50\tClipboard DCF\t12-Mar-2028\r\n1,300\tComparable\t15/04/2029\r\n1400\tSum of parts\tFY30E\r\n');
  ok('a 3×3 Excel range fills the exact Portfolio rectangle and normalizes its dates and numbers', await waitFor(async () => {
    const v = sheetStore.snapshot().values;
    return v[pasteKeys[0]]?.intrinsicValue?.value === 1250.5 && v[pasteKeys[0]]?.reference?.value === '2028-03-12'
      && v[pasteKeys[1]]?.methodology?.value === 'Comparable' && v[pasteKeys[1]]?.reference?.value === '2029-04-15'
      && v[pasteKeys[2]]?.intrinsicValue?.value === 1400 && v[pasteKeys[2]]?.reference?.value === 'FY30E';
  }));
  ok('a paste ends at the copied rectangle and closes the single-cell editor', await a.page.locator('.sheet-editor').count() === 0
    && JSON.stringify(await a.page.evaluate(async key => { const s = await import('/js/core/research-sheet.js'); return ['intrinsicValue', 'methodology', 'reference'].map(f => s.value(key, f)); }, pasteKeys[3])) === JSON.stringify(beforePaste[3]));
  await b.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  ok('pasted cells are shared with another device', await waitFor(async () => (await cell(b.page, 'portfolio', pasteKeys[0], 'methodology').innerText()).trim() === 'Clipboard DCF'));
  await a.page.locator('[data-sheet-cell-undo]').click();
  ok('one Undo restores every pasted field to its previous typed value or default', await waitFor(async () => JSON.stringify(await a.page.evaluate(async ({ keys, fields }) => {
    const s = await import('/js/core/research-sheet.js'); return keys.map(k => fields.map(f => s.value(k, f)));
  }, { keys: pasteKeys, fields: pasteFields })) === JSON.stringify(beforePaste)));

  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'methodology', 'Keyboard DCF\t2028-03-31\r\nKeyboard multiple\t2029-03-31\r\n', { keyboard: true });
  ok('the real Ctrl/Cmd+V clipboard shortcut pastes multiple rows and columns', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[1]]?.methodology?.value === 'Keyboard multiple'));
  await b.page.evaluate(async key => { const s = await import('/js/core/research-sheet.js'); s.set(key, 'methodology', 'Colleague after paste', 'Meera'); await s.syncNow({ force: true }); }, pasteKeys[1]);
  await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  await a.page.locator('[data-sheet-cell-undo]').click();
  ok('paste Undo preserves a colleague’s later edit', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[1]]?.methodology?.value === 'Colleague after paste'));

  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'dateBought', '12-Mar-24\t1,25,000\t₹ 750.50\r\n16/05/2025\t250\t1,200\r\n', { editor: false });
  ok('date, quantity and buy-price columns accept an Excel rectangle in their own units', await waitFor(async () => {
    const v = sheetStore.snapshot().values; return v[pasteKeys[0]]?.dateBought?.value === '2024-03-12' && v[pasteKeys[0]]?.quantity?.value === 125000
      && v[pasteKeys[1]]?.dateBought?.value === '2025-05-16' && v[pasteKeys[1]]?.buyPrice?.value === 1200;
  }));
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'dateBought', '13-Mar-24\r\n17-May-25\r\n');
  ok('multiple Excel dates can also be pasted while the native date editor is open', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[0]]?.dateBought?.value === '2024-03-13'
    && sheetStore.snapshot().values[pasteKeys[1]]?.dateBought?.value === '2025-05-17'));
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'targetWeight', '0%\r\n4.5%\r\n');
  ok('zero and Excel percentages remain zero and percentage points', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[0]]?.targetWeight?.value === 0 && sheetStore.snapshot().values[pasteKeys[1]]?.targetWeight?.value === 4.5));
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'methodology', '"DCF\twith quotes ""inside"""\r\n"Second\nline"\r\n');
  ok('quoted tabs, quotes and line breaks stay inside their Excel cells', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[0]]?.methodology?.value === 'DCF with quotes "inside"' && sheetStore.snapshot().values[pasteKeys[1]]?.methodology?.value === 'Second line'));
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'methodology', '\r\n\r\n');
  ok('blank Excel cells clear only the selected manual values', await waitFor(async () => !sheetStore.snapshot().values[pasteKeys[0]]?.methodology && !sheetStore.snapshot().values[pasteKeys[1]]?.methodology));
  await a.page.locator('[data-sheet-cell-undo]').click();
  ok('Undo also restores values cleared by blank pasted cells', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[1]]?.methodology?.value === 'Second line'));

  await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  const beforeBadPaste = JSON.stringify(sheetStore.snapshot().values);
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'quantity', '100\t750\r\n200\t-1\r\n');
  ok('one invalid value refuses the whole paste and names its row and column', /Row 2, Buy price/.test(await a.page.locator('.sheet-fill-feedback').innerText())
    && JSON.stringify(sheetStore.snapshot().values) === beforeBadPaste && await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).meta().pending === 0));
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'sector', 'Should not save\t999\r\n');
  ok('a rectangle crossing a market-derived column is refused without partial edits', /read-only/.test(await a.page.locator('.sheet-fill-feedback').innerText()) && JSON.stringify(sheetStore.snapshot().values) === beforeBadPaste);
  const finalKey = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').last().getAttribute('data-row-key');
  await pasteCells(a.page, 'portfolio', finalKey, 'methodology', 'Past end\r\nExtra row\r\n');
  ok('overflowing the matching rows is reported instead of truncating the paste', /last matching row/.test(await a.page.locator('.sheet-fill-feedback').innerText()) && JSON.stringify(sheetStore.snapshot().values) === beforeBadPaste);

  const referenceHead = table(a.page, 'portfolio').locator('th[data-sort="Reference year and date"]');
  await referenceHead.press('Alt+ArrowLeft');
  await pasteCells(a.page, 'portfolio', pasteKeys[0], 'intrinsicValue', '1550\t2030-03-31\tReordered DCF\r\n', { editor: false });
  ok('pasting follows the reader’s actual dragged column order', await waitFor(async () => sheetStore.snapshot().values[pasteKeys[0]]?.reference?.value === '2030-03-31' && sheetStore.snapshot().values[pasteKeys[0]]?.methodology?.value === 'Reordered DCF'));
  await referenceHead.press('Alt+Home');
  await editCell(a.page, 'portfolio', pasteKeys[0], 'sector', 'Clipboard selection');
  await editCell(a.page, 'portfolio', pasteKeys[2], 'sector', 'Clipboard selection');
  await table(a.page, 'portfolio').locator('[data-table-search]').fill('Clipboard selection');
  const matchingPasteKeys = await table(a.page, 'portfolio').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.map(r => r.dataset.rowKey));
  const hiddenBefore = sheetStore.snapshot().values[pasteKeys[1]]?.intrinsicValue?.value;
  await pasteCells(a.page, 'portfolio', matchingPasteKeys[0], 'intrinsicValue', '1660\r\n1770\r\n');
  ok('pasting uses the current filtered/sorted rows and leaves hidden rows alone', matchingPasteKeys.length === 2 && await waitFor(async () => sheetStore.snapshot().values[matchingPasteKeys[1]]?.intrinsicValue?.value === 1770)
    && sheetStore.snapshot().values[pasteKeys[1]]?.intrinsicValue?.value === hiddenBefore);
  await table(a.page, 'portfolio').locator('[data-table-search]').fill('');

  await a.page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await rowOf(a.page, 'watchlist', 'SBIN').waitFor();
  const watchPasteKeys = await table(a.page, 'watchlist').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.slice(0, 2).map(r => r.dataset.rowKey));
  await pasteCells(a.page, 'watchlist', watchPasteKeys[0], 'methodology', 'Watch clipboard DCF\t2028-03-31\r\nWatch clipboard peers\t2029-03-31\r\n');
  ok('Watchlist supports the same direct multi-column Excel paste', await waitFor(async () => sheetStore.snapshot().values[watchPasteKeys[1]]?.methodology?.value === 'Watch clipboard peers' && sheetStore.snapshot().values[watchPasteKeys[0]]?.reference?.value === '2028-03-31'));
  await pasteCells(a.page, 'watchlist', watchPasteKeys[0], 'source', 'Analyst note\r\nPublic report\r\n');
  await pasteCells(a.page, 'watchlist', watchPasteKeys[0], 'entryPrice', '810\r\n820\r\n');
  ok('Watchlist Source and planned entry-price cells accept pasted columns independently of Portfolio cost', await waitFor(async () => sheetStore.snapshot().values[watchPasteKeys[1]]?.source?.value === 'Public report' && sheetStore.snapshot().values[watchPasteKeys[1]]?.entryPrice?.value === 820));
  await a.page.locator('#tabbar-mount [data-tab-id="portfolio"]').click();
  await rowOf(a.page, 'portfolio', 'SBIN').waitFor();
  console.log('\n— Excel export, fill and upload —');
  const downloadBook = async (kind) => {
    const downloading = a.page.waitForEvent('download');
    await table(a.page, kind.toLowerCase()).locator('[data-export]').click();
    const download = await downloading;
    const path = resolve(output, download.suggestedFilename());
    await download.saveAs(path);
    return [...readFileSync(path)];
  };
  const rewriteBook = (bytes, edits) => a.page.evaluate(async ({ bytes, edits }) => {
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(new Uint8Array(bytes));
    const ws = wb.worksheets.find((s) => s.state === 'visible');
    const col = (head) => ws.getRow(2).values.indexOf(head);
    for (const edit of edits) {
      const row = edit.row || (() => {
        for (let n = 3; n <= ws.rowCount; n++) if (ws.getRow(n).getCell(2).value === edit.id) return n;
      })();
      const c = ws.getRow(row).getCell(edit.head ? col(edit.head) : edit.col);
      c.value = edit.value;
      if (edit.numFmt) c.numFmt = edit.numFmt;
    }
    return [...new Uint8Array(await wb.xlsx.writeBuffer())];
  }, { bytes, edits });
  const uploadBook = async (kind, bytes) => {
    await table(a.page, kind.toLowerCase()).locator('[data-sheet-upload-file]').setInputFiles({ name: `glow-${kind}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
    const status = table(a.page, kind.toLowerCase()).locator('[data-sheet-upload-status]');
    await waitFor(async () => !(await table(a.page, kind.toLowerCase()).locator('[data-sheet-upload]').isDisabled()), 15000);
    return status.innerText();
  };
  const upload = table(a.page, 'portfolio').locator('[data-sheet-upload]');
  ok('Upload latest is immediately beside Export Excel', await upload.evaluate((e) => e.previousElementSibling?.matches('[data-export]')));
  const exported = await downloadBook('Portfolio');
  const structure = await a.page.evaluate(async (bytes) => {
    const wb = new window.ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(bytes));
    return { visible: wb.worksheets.filter((s) => s.state === 'visible').map((s) => s.name),
      meta: wb.getWorksheet('_Glow upload').state, headers: wb.getWorksheet('Portfolio').getRow(2).values.slice(1) };
  }, exported);
  ok('export keeps the visible Portfolio layout and stores its upload baseline invisibly', structure.visible.join() === 'Portfolio' && structure.meta === 'veryHidden'
    && structure.headers[0] === 'Name of company' && structure.headers[1] === 'Ticker / ISIN');
  const noChangeRevision = sheetStore.snapshot().revision;
  ok('an unchanged upload preserves defaults and creates no edits', /No changed/.test(await uploadBook('Portfolio', exported)) && sheetStore.snapshot().revision === noChangeRevision);
  const unplaced = (await a.page.evaluate(async () => (await import('/js/data/research-sheets.js')).portfolioRows())).find((r) => !r.ticker);
  const edits = [
    { id: 'SBIN', head: 'Buy price (in Rs)', value: '₹ 725.50' },
    { id: 'SBIN', head: 'Target weight in portfolio (% of public direct)', value: 0.045, numFmt: '0.0%' },
    { id: 'SBIN', head: 'CMP (in Rs)', value: 999999 },
    { id: 'SBIN', head: 'Date bought', value: { formula: 'DATE(2025,5,17)', result: 45794 }, numFmt: 'dd-mmm-yy' },
    { id: 'SBIN', head: 'Reference year and date', value: { formula: 'DATE(2031,3,31)', result: (Date.UTC(2031, 2, 31) - Date.UTC(1899, 11, 30)) / 86400000 }, numFmt: 'dd-mmm-yy' },
    ...(unplaced ? [{ id: unplaced.isin || unplaced.key, head: 'Valuation methodology', value: 'ISIN upload' }] : []),
  ];
  const editedBook = await rewriteBook(exported, edits);
  const savedText = await uploadBook('Portfolio', editedBook);
  ok('changed manual fields are saved for everyone', /edits? saved for everyone/.test(savedText) && sheetStore.snapshot().values.SBIN.buyPrice.value === 725.5, savedText);
  ok('Excel percentage cells retain percent units', sheetStore.snapshot().values.SBIN.targetWeight.value === 4.5);
  ok('Excel date cells retain the purchase day', sheetStore.snapshot().values.SBIN.dateBought.value === '2025-05-17');
  ok('Excel reference dates retain their future year and day', sheetStore.snapshot().values.SBIN.reference.value === '2031-03-31');
  ok('uploaded market figures never become manual inputs', !sheetStore.snapshot().values.SBIN.cmp && pctOf(await columnText(a.page, 'portfolio', 'SBIN', 'CMP (in Rs)')) === cmpShown);
  ok('tickerless companies upload by ISIN', !!unplaced && sheetStore.snapshot().values[unplaced.key]?.methodology?.value === 'ISIN upload');
  await b.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  ok('the other device receives the uploaded value', await waitFor(async () => /725.50/.test(await cell(b.page, 'portfolio', 'SBIN', 'buyPrice').innerText())));
  const fresh = await downloadBook('Portfolio');
  const unchangedRevision = sheetStore.snapshot().revision;
  const bad = await rewriteBook(fresh, [{ id: 'SBIN', head: 'Buy price (in Rs)', value: 750 }, { id: 'FRACTAL', head: 'Buy price (in Rs)', value: -10 }]);
  ok('one invalid cell rejects the entire workbook with its row and column', /Row \d+, Buy price/.test(await uploadBook('Portfolio', bad)) && sheetStore.snapshot().revision === unchangedRevision);
  const duplicate = await rewriteBook(fresh, [{ row: 3, col: 2, value: 'SBIN' }, { row: 4, col: 2, value: 'SBIN' }]);
  ok('duplicate identities are refused before saving', /duplicate company/.test(await uploadBook('Portfolio', duplicate)) && sheetStore.snapshot().revision === unchangedRevision);
  const brokenHead = await rewriteBook(fresh, [{ row: 2, col: 3, value: 'Changed heading' }]);
  ok('changed column formats are refused before saving', /headings have changed/.test(await uploadBook('Portfolio', brokenHead)) && sheetStore.snapshot().revision === unchangedRevision);
  await editCell(b.page, 'portfolio', 'SBIN', 'buyPrice', '780');
  await stored('buyPrice', 780);
  const stale = await rewriteBook(fresh, [{ id: 'SBIN', head: 'Buy price (in Rs)', value: 790 }]);
  ok('a stale workbook cannot overwrite a colleague’s changed cell', /changed on the dashboard/.test(await uploadBook('Portfolio', stale)) && sheetStore.snapshot().values.SBIN.buyPrice.value === 780);
  const batchBook = await downloadBook('Portfolio');
  const bulkEdits = [...expectedKeys].flatMap((id) => [
    { id: id.startsWith('ISIN:') ? id.slice(5) : id, head: 'Valuation methodology', value: 'Excel bulk DCF' },
    { id: id.startsWith('ISIN:') ? id.slice(5) : id, head: 'Reference year and date', value: 'FY28E Excel' },
  ]);
  ok('uploads exceeding one server batch save every changed cell', /edits? saved for everyone/.test(await uploadBook('Portfolio', await rewriteBook(batchBook, bulkEdits)))
    && [...expectedKeys].every((key) => sheetStore.snapshot().values[key]?.methodology?.value === 'Excel bulk DCF' && sheetStore.snapshot().values[key]?.reference?.value === 'FY28E Excel'));
  await a.page.locator('#tabbar-mount [data-tab-id="watchlist"]').click();
  await rowOf(a.page, 'watchlist', 'SBIN').waitFor();
  const watchBook = await downloadBook('Watchlist');
  const watchEdits = await rewriteBook(watchBook, [{ id: 'SBIN', head: 'Source', value: 'Excel analyst note' }, { id: 'SBIN', head: 'Buy price for the expected IRR (in Rs)', value: 950 }]);
  ok('Watchlist supports the same round trip with its own entry price', /edits? saved for everyone/.test(await uploadBook('Watchlist', watchEdits))
    && sheetStore.snapshot().values.SBIN.source.value === 'Excel analyst note' && sheetStore.snapshot().values.SBIN.entryPrice.value === 950 && sheetStore.snapshot().values.SBIN.buyPrice.value === 780);
  const clearBook = await downloadBook('Watchlist');
  ok('blanking a typed Excel value clears that manual field', /edits? saved for everyone/.test(await uploadBook('Watchlist', await rewriteBook(clearBook, [{ id: 'SBIN', head: 'Source', value: null }])))
    && !sheetStore.snapshot().values.SBIN.source);
  const failureBook = await downloadBook('Watchlist');
  writeFailure = 503;
  const deferred = await rewriteBook(failureBook, [{ id: 'SBIN', head: 'Source', value: 'Retry this Excel note' }]);
  ok('a failed shared write keeps the upload queued and never reports success', !/saved for everyone/.test(await uploadBook('Watchlist', deferred))
    && !sheetStore.snapshot().values.SBIN.source && await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).meta().pending > 0));
  writeFailure = null;
  await a.page.evaluate(async () => (await import('/js/core/research-sheet.js')).syncNow({ force: true }));
  ok('queued upload edits reach the shared store after reconnection', sheetStore.snapshot().values.SBIN.source.value === 'Retry this Excel note');
  const refusalBook = await downloadBook('Watchlist');
  writeFailure = 400;
  ok('a server refusal cannot masquerade as a successful upload', /refused an edit/.test(await uploadBook('Watchlist', await rewriteBook(refusalBook,
    [{ id: 'SBIN', head: 'Source', value: 'Refuse this Excel note' }]))) && sheetStore.snapshot().values.SBIN.source.value === 'Retry this Excel note');
  writeFailure = null;
  await a.page.setViewportSize({ width: 390, height: 844 });
  await a.page.emulateMedia({ colorScheme: 'dark' });
  ok('Upload latest stays visible with no mobile page overflow', await a.page.locator('[data-sheet-upload]').isVisible()
    && await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await a.page.screenshot({ path: resolve(output, 'watchlist-mobile-dark.png') });
  await a.page.setViewportSize({ width: 1440, height: 900 });
  await a.page.emulateMedia({ colorScheme: 'light' });
  await a.page.locator('#tabbar-mount [data-tab-id="portfolio"]').click();
  await cell(a.page, 'portfolio', 'SBIN', 'buyPrice').click();
  await a.page.screenshot({ path: resolve(output, 'portfolio-editor.png') });
  await a.page.locator('.sheet-editor [data-sheet-input]').press('Escape');

  console.log('\n— a deployment with no shared sheet —');
  const fractalBefore = JSON.stringify(sheetStore.snapshot().values.FRACTAL);
  const c = await openDevice({ staticOrigin: true });
  await c.page.goto(`${origin}/#/research/portfolio`, { waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  ok('it says edits are kept in this browser only', await waitFor(async () => (await c.page.locator('[data-sheet-status]').getAttribute('data-sheet-status')) === 'local'));
  await editCell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue', '900');
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor({ timeout: 30000 });
  ok('…and keeps them across a reload', (await cell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue').innerText()).trim() === '900.00');
  ok('…marked as not on a shared sheet', /is-pending/.test(await cell(c.page, 'portfolio', 'FRACTAL', 'intrinsicValue').getAttribute('class')));
  ok('nothing it typed reached the shared store', JSON.stringify(sheetStore.snapshot().values.FRACTAL) === fractalBefore);
  const offlineKeys = await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').evaluateAll(rows => rows.slice(0, 3).map(r => r.dataset.rowKey));
  await editCell(c.page, 'portfolio', offlineKeys[0], 'reference', '2027-03-31');
  await dragFill(c.page, 'portfolio', offlineKeys[0], offlineKeys[2], 'reference');
  const offlineBeforeReload = await c.page.evaluate(async keys => {
    const s = await import('/js/core/research-sheet.js'); return keys.map(key => s.entry(key, 'reference')?.value);
  }, offlineKeys);
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor();
  ok('an offline filled range survives reload in the outbox', await c.page.evaluate(async keys => {
    const s = await import('/js/core/research-sheet.js'); return keys.every(key => s.entry(key, 'reference')?.value === '2027-03-31' && s.entry(key, 'reference').pending);
  }, offlineKeys) && offlineKeys.every(key => sheetStore.snapshot().values[key]?.reference?.value !== '2027-03-31'), JSON.stringify(offlineBeforeReload));

  await pasteCells(c.page, 'portfolio', offlineKeys[0], 'methodology', 'Offline clipboard one\r\nOffline clipboard two\r\n');
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await table(c.page, 'portfolio').locator('tbody tr[data-row-key]').first().waitFor();
  ok('an offline pasted range survives reload without reaching the shared store', await c.page.evaluate(async keys => {
    const s = await import('/js/core/research-sheet.js'); return s.value(keys[0], 'methodology') === 'Offline clipboard one' && s.value(keys[1], 'methodology') === 'Offline clipboard two';
  }, offlineKeys) && offlineKeys.every(key => !String(sheetStore.snapshot().values[key]?.methodology?.value).startsWith('Offline clipboard')));

  await c.page.setViewportSize({ width: 390, height: 844 });
  await c.page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await editCell(c.page, 'portfolio', offlineKeys[0], 'reference', '2028-03-31');
  await waitFor(async () => (await cell(c.page, 'portfolio', offlineKeys[0], 'reference').innerText()).trim() === '31-Mar-28');
  const touch = await c.context.newCDPSession(c.page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await table(c.page, 'portfolio').locator('[data-table-scroll]').evaluate(el => { el.scrollTop = 0; el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); });
  await fillHandle(c.page, 'portfolio', offlineKeys[0], 'reference').hover();
  const th = await fillHandle(c.page, 'portfolio', offlineKeys[0], 'reference').boundingBox();
  const ty = await cell(c.page, 'portfolio', offlineKeys[1], 'reference').evaluate(el => { const r = el.closest('td').getBoundingClientRect(); return r.y + r.height / 2; });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: th.x + 8, y: th.y + 8 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: th.x + 8, y: ty }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  ok('a touch drag works on the dark mobile sheet', await waitFor(async () => (await c.page.evaluate(async key => (await import('/js/core/research-sheet.js')).value(key, 'reference'), offlineKeys[1])) === '2028-03-31'),
    JSON.stringify({ source: th, targetY: ty, feedback: await c.page.locator('.sheet-fill-feedback').innerText().catch(() => '') }));
  await touch.detach();

  ok('zero page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

console.log(`\n${checks - failures} of ${checks} checks passed (${sheetWrites} shared-sheet writes)`);
if (failures) process.exit(1);
