#!/usr/bin/env node
// scripts/verify-direct-equity-ui.mjs — the Family Book's two views in a real browser. GLOW-OWNED.
//
//   PLAYWRIGHT_ROOT=… node scripts/verify-direct-equity-ui.mjs
//
// Serves `public/` itself — no Worker, no egress — and drives the shipped book. It exists for the
// four things the offline suite cannot see, each of which has already been the shape of a real
// failure on this dashboard:
//
//   • A COLUMN THAT IS ALWAYS EMPTY READS AS MISSING DATA. `technicals.byTicker()` returns the
//     SCORED object and its measurements are one level down, so `.cmp` is `undefined` for every
//     ticker in the feed. The Family Book's EOD mark column asked for it and drew an em dash on all
//     166 listed holdings — nothing threw, no count was wrong, and its title said the symbols were
//     not in the capture. So the CMP column is asserted to be POPULATED, not merely present.
//   • A 630 KB FILE MUST NOT RIDE ON A VIEW THAT DOES NOT READ IT. `book-ledger.json` is fetched
//     when Direct Equity is opened and never by All Holdings.
//   • FOURTEEN COLUMNS MUST FIT. The same bar the Earnings Hub and Institutions are held to: no
//     scrollbar of the table's own at 1440, and the page never scrolls sideways at any width.
//   • THE SWITCH MUST ROUTE. An unknown or absent sub-view lands on All Holdings with the URL
//     corrected, and the view survives a reload — a shared link is the point of putting it in the
//     URL at all.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const ledgerRequests = [];
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path.includes('book-ledger.json')) ledgerRequests.push(path);
  try {
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + sep)) throw Error('outside public');
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];
const ok = (label, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleErrors = [];
// A static origin has no Worker, so every /api/* route 404s and the SDK bundle is absent. That is a
// SUPPORTED mode (CLAUDE.md), not a failure, and those are the only messages filtered.
const environmental = (t) => /404|ERR_CERT|Failed to load resource|MunshotDashboardSDK/.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !environmental(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => { if (!environmental(e.message)) consoleErrors.push(`pageerror: ${e.message}`); });

const settle = async () => {
  await page.locator('[data-score-table]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-rows-pending]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
};
const go = async (hash) => { await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' }); await settle(); };

// ---------------------------------------------------------------------------------------
// The switch, and which view a bare route lands on.
// ---------------------------------------------------------------------------------------
await go('#/research/family-book?scope=portfolio');
const landing = await page.evaluate(() => ({
  hash: location.hash,
  items: [...document.querySelectorAll('[data-view-switch-item]')].map((a) => `${a.textContent.trim()}${a.getAttribute('aria-current') ? '*' : ''}`),
  heads: [...document.querySelectorAll('[data-score-table] thead th')].map((t) => t.textContent.replace(/\s+/g, ' ').replace(/ [▴▾]$/, '').trim()),
  picker: !!document.querySelector('#subview-mount:not(.hidden)'),
}));
ok('a bare Family Book route lands on All Holdings and corrects the URL',
  landing.hash.includes('/family-book/all-holdings') && landing.items.join('|') === 'All Holdings*|Direct Equity', landing.hash);
ok('All Holdings is unchanged — it is still the per-statement table',
  landing.heads.includes('Security') && landing.heads.includes('Statement value (₹ Cr)') && landing.heads.includes('Class'));
ok('the shell draws no sub-view picker card — the switch is on the title row', landing.picker === false);
ok('no view fetches the 630 KB ledger before it is asked for', ledgerRequests.length === 0, `${ledgerRequests.length} request(s)`);

// ---------------------------------------------------------------------------------------
// Direct Equity.
// ---------------------------------------------------------------------------------------
await page.click('[data-view-switch-item="direct-equity"]');
await settle();
ok('opening Direct Equity fetches the ledger, once', ledgerRequests.length === 1, `${ledgerRequests.length} request(s)`);

const view = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-score-table] tbody tr')].filter((r) => !r.hasAttribute('aria-hidden') && r.offsetParent !== null);
  const heads = [...document.querySelectorAll('[data-score-table] thead th')].map((t) => t.textContent.replace(/\s+/g, ' ').replace(' ▾', '').replace(' ▴', '').trim());
  const cell = (label) => {
    const i = heads.indexOf(label);
    return i < 0 ? [] : rows.map((r) => r.querySelectorAll('td')[i]?.textContent.trim());
  };
  const sc = document.querySelector('[data-table-scroll]');
  return {
    hash: location.hash,
    heads,
    rows: rows.length,
    cmp: cell('CMP (EOD)'),
    marketCap: cell('Market cap'),
    value: cell('Value (₹ Cr)'),
    weight: cell('Weight'),
    over: sc.scrollWidth - sc.clientWidth,
    cards: [...document.querySelectorAll('.stat-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
    heroLast: [...document.querySelectorAll('.stat-card')].at(-1)?.className.includes('bg-gradient-to-br') || false,
    note: document.querySelector('[data-equity-note]')?.textContent.replace(/\s+/g, ' ').trim() || '',
  };
});

const EXPECTED = ['Company', 'CMP (EOD)', 'Market cap', 'Qty', 'Avg cost', 'Cost (₹ Cr)', 'Value (₹ Cr)', 'Weight', 'Unrealised (₹ Cr)', 'Return', 'Reported XIRR', 'Dividends (₹)', 'First buy', 'Last trade'];
ok('Direct Equity carries every requested column, in reading order',
  JSON.stringify(view.heads) === JSON.stringify(EXPECTED), view.heads.join(' | '));
ok('...and they fit 1440px with no scrollbar of the table\'s own', view.over <= 0, `${view.over}px over`);

// THE REGRESSION GUARD. An always-empty column reads as missing data, so this asks for figures.
const pricedRows = view.cmp.filter((t) => /₹/.test(t || '')).length;
ok('the CMP column is POPULATED from the technicals capture, not a column of dashes',
  pricedRows >= Math.floor(view.rows * 0.5), `${pricedRows} of ${view.rows} visible rows priced`);
ok('...and so is the market cap beside it',
  view.marketCap.filter((t) => /Cr/.test(t || '')).length >= Math.floor(view.rows * 0.4));
ok('every visible row carries a statement value and a weight',
  view.value.every((t) => /\d/.test(t || '')) && view.weight.every((t) => /%/.test(t || '')));

ok('the four summary cards are there, with the gradient freshness card last',
  view.cards.length === 4 && view.heroLast, `${view.cards.length} card(s), hero last: ${view.heroLast}`);
ok('the cost card says what the return is measured over, rather than implying the whole book',
  /over the .* lines that carry a cost/i.test(view.cards[1] || ''), view.cards[1]);
ok('the freshness card dates the trades AND says the window is not a holding period',
  /not a holding period/i.test(view.cards[3] || ''), view.cards[3]);
ok('the footnote separates the statements\' figures from the derived ones and from the market data',
  /statements’ own figures/i.test(view.note) && /derived/i.test(view.note) && /technicals capture/i.test(view.note));
ok('...and says a dash is never a zero', /never a zero/i.test(view.note));

// ---------------------------------------------------------------------------------------
// The consolidation: several accounts, one company row.
// ---------------------------------------------------------------------------------------
const search = '[data-score-table] input[placeholder*="Search"]';
await page.fill(search, 'State Bank');
await page.waitForTimeout(500);
const sbi = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-score-table] tbody tr')].filter((r) => !r.hasAttribute('aria-hidden') && r.offsetParent !== null);
  return { count: rows.length, text: rows[0]?.textContent.replace(/\s+/g, ' ').trim() || '' };
});
ok('a company held in several accounts is ONE row, and the sub-line says how many',
  sbi.count === 1 && /\d+ accounts/.test(sbi.text), `${sbi.count} row(s): ${sbi.text.slice(0, 120)}`);

// ---------------------------------------------------------------------------------------
// The drill: position by owner/account, then the dated evidence.
// ---------------------------------------------------------------------------------------
await page.locator('[data-score-table] tbody tr:not([aria-hidden])').first().click();
await page.waitForTimeout(900);
const drill = await page.evaluate(() => {
  const d = document.getElementById('drill-panel') || document.querySelector('[role="dialog"]');
  return { text: d ? d.innerText : '', modal: d?.getAttribute('aria-modal') };
});
ok('the drill is modal to the keyboard', drill.modal === 'true');
ok('it lists the position by owner and account, one line per statement',
  /POSITION BY OWNER AND ACCOUNT · \d+ STATEMENT LINES/i.test(drill.text), drill.text.slice(0, 80));
ok('...with each line\'s own quantity, cost, P&L and statement date',
  /sh ·/.test(drill.text) && /statement \d/.test(drill.text));
ok('a line whose statement carries no cost says so rather than showing a zero',
  !/cost ₹0\.00 Cr/.test(drill.text));
ok('it carries a Transactions section, and says so in words when the window holds none',
  /TRANSACTIONS/i.test(drill.text)
    && (/No trade in this holding on the transaction statements/i.test(drill.text) || /· (Buy|Sell)/.test(drill.text)));
ok('...and states that the statements\' window is not a holding period wherever it is shown',
  !/No trade in this holding/i.test(drill.text) || /not a holding period/i.test(drill.text));
ok('the market-data group is headed as this dashboard\'s rather than the statements\'',
  /MARKET DATA · THIS DASHBOARD’S, NOT THE STATEMENTS’/i.test(drill.text));
ok('an unpublished IRR says one cannot be computed, rather than showing a zero',
  !/XIRR \(published\)\s*\n\s*—/.test(drill.text) || /cannot be computed without the cash flows/i.test(drill.text));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// A company that really was traded shows its trades, with the realised gain the statements determined.
await page.fill(search, 'Aditya Birla Capital');
await page.waitForTimeout(500);
await page.locator('[data-score-table] tbody tr:not([aria-hidden])').first().click();
await page.waitForTimeout(900);
const traded = await page.evaluate(() => (document.getElementById('drill-panel') || document.querySelector('[role="dialog"]')).innerText);
ok('a traded company lists its dated trades with side, size and price',
  /TRANSACTIONS · \d/.test(traded) && /· (Buy|Sell)/.test(traded) && /sh · at ₹/.test(traded), traded.slice(traded.indexOf('TRANSACTIONS'), traded.indexOf('TRANSACTIONS') + 140));
ok('...and a sell carries the realised gain the capital gain statement determined',
  /realised ₹/.test(traded) || /realised — \(/.test(traded));
ok('...and the lots name the purchase date the sale was settled against',
  !/CAPITAL-GAIN LOTS/.test(traded) || /bought \d{2} \w{3} \d{4}/.test(traded));
await page.keyboard.press('Escape');
await page.fill(search, '');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// Filters, export and the URL.
// ---------------------------------------------------------------------------------------
const selects = await page.evaluate(() => [...document.querySelectorAll('[data-score-table] select')].map((s) => [...s.options].map((o) => o.textContent.trim())[0]));
ok('the toolbar offers sector, owner and provider filters, each leading with an "all" option',
  selects.length >= 3 && selects.every((first) => /^All /.test(first)), selects.join(' | '));
const beforeFilter = await page.evaluate(() => document.querySelectorAll('[data-score-table] tbody tr:not([aria-hidden])').length);
await page.selectOption('[data-score-table] select >> nth=0', { index: 1 });
await page.waitForTimeout(500);
const afterFilter = await page.evaluate(() => ({
  rows: document.querySelectorAll('[data-score-table] tbody tr:not([aria-hidden])').length,
  label: document.body.textContent.match(/\d+ of \d+ companies shown/)?.[0] || '',
}));
ok('choosing a sector narrows the table and the count says so',
  afterFilter.rows < beforeFilter && /of \d+ companies shown/.test(afterFilter.label), `${beforeFilter} → ${afterFilter.rows}, "${afterFilter.label}"`);
await page.selectOption('[data-score-table] select >> nth=0', { index: 0 });
await page.waitForTimeout(400);
ok('an Export Excel control is offered', await page.locator('[data-score-table] button:has-text("Export")').count() > 0);

// A shared link must land where it says, and survive a reload.
await go('#/research/family-book/direct-equity?scope=portfolio');
ok('a Direct Equity link opens Direct Equity after a full reload',
  (await page.evaluate(() => document.querySelector('[data-view-switch-item="direct-equity"]')?.getAttribute('aria-current'))) === 'page');
await go('#/research/family-book/not-a-view?scope=portfolio');
ok('an unknown sub-view falls through to All Holdings rather than an empty page',
  (await page.evaluate(() => !!document.querySelector('[data-score-table] thead th')))
    && (await page.evaluate(() => [...document.querySelectorAll('[data-score-table] thead th')].some((t) => /Security/.test(t.textContent)))));

// ---------------------------------------------------------------------------------------
// Scope, and the layout at three widths.
// ---------------------------------------------------------------------------------------
await go('#/research/family-book/direct-equity?scope=watchlist');
const watchlist = await page.evaluate(() => document.body.innerText);
ok('an empty Watchlist keeps the book on screen and says the list is empty, rather than the shell\'s add-companies panel',
  /nothing starred yet/i.test(watchlist) && !/Add companies to watchlist/i.test(watchlist));

await go('#/research/family-book/direct-equity?scope=universe');
for (const width of [1440, 1024, 390]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(400);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  ok(`the page never scrolls sideways at ${width}px`, fits);
  if (process.env.GLOW_SCREENSHOT_PREFIX) await page.screenshot({ path: `${process.env.GLOW_SCREENSHOT_PREFIX}-direct-equity-${width}.png` });
}
await page.setViewportSize({ width: 1440, height: 1100 });
await page.waitForTimeout(300);

// The provenance door, on both views.
await page.click('[data-book-info]');
await page.waitForTimeout(600);
const prov = await page.evaluate(() => document.getElementById('modal-content')?.innerText || '');
ok('the Sources door explains the Direct Equity derivations and names the dated evidence',
  /Direct Equity/i.test(prov) && /dated evidence/i.test(prov) && /reproduced, never blended/i.test(prov));
ok('...and says CMP and market cap are not GlowVentures figures',
  /not GlowVentures figures/i.test(prov));
ok('...and states the statements\' window is not a holding period',
  /not a holding period/i.test(prov));

ok('zero console errors across the whole run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  • ${f}`);
  process.exit(1);
}
console.log('Direct Equity: the switch routes, the ledger loads only where it is read, fourteen columns fit, the market-data columns carry figures, and every dash says why.');
