import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Different volume windows deliberately disagree: these chips use the same 30-session
// confirmation as Strong Breakouts, not the scoring model's separate 20-session ratio.
const seed = JSON.parse(readFileSync(new URL('../public/data/technicals.json', import.meta.url))).companies.find(c => !c.error && c.cmp);
const cases = [
  ['ALPHA', 1.5, .95, true, 1, 1, 'no_breakout'],
  ['BETA', 1.49, .90, true, .6, -1, 'weak_base'],
  ['GAMMA', 1, .80, false, 2.5, 1, 'strong'],
  ['DELTA', .8, .7999, true, -1, 1, 'low_volume'],
  ['EPSILON', 2, .98, false, 1.5, -1, 'no_breakout'],
  ['ZETA', 2, .90, true, 0, 0, 'no_breakout'],
  ['MISSING', null, null, null, 1, 1, null],
  ['ERROR', null, null, null, null, null, null],
];
const companies = cases.map(([ticker, volume, proximity, above, fii, dii, quality]) => ({
  ...structuredClone(seed), ticker, name: `${ticker} fixture`, sector: 'Verification',
  cmp: 100, sma200: above ? 90 : 110, above_200dma: above,
  high_proximity_pct: proximity, chg_fii_hold: fii, chg_dii_hold: dii,
  volume_ratio_today: volume == null ? null : 3 - volume,
  consolidation_breakout: quality ? { ...seed.consolidation_breakout, quality, today_volume_ratio: volume } : null,
  error: ticker === 'ERROR' ? 'No price history in fixture' : null,
}));

export async function verifyTechnicalFiltersUI(browser, { base = 'http://127.0.0.1:8080' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors = [], refreshes = [];
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/data/technicals.json') return route.fulfill({ json: { generated_at: new Date().toISOString(), source: 'Local verification fixture', companies } });
      if (url.pathname === '/data/portfolio-companies.json') return route.fulfill({ json: { holdings: companies.filter(c => ['ALPHA', 'GAMMA', 'DELTA', 'MISSING'].includes(c.ticker)) } });
      if (url.pathname === '/js/ui/export.js') return route.fulfill({ contentType: 'application/javascript', body: `
        export async function exportRows({rows}) { window.__filterExport = rows.map(r => r.company.ticker); return true; }
        export async function exportSheets() { return true; }
        export function todayStamp() { return 'fixture'; }
      ` });
      if (url.pathname === '/api/live-prices') {
        refreshes.push(route.request().postDataJSON().tickers);
        return route.fulfill({ json: { quotes: {}, missing: [], requested: refreshes.at(-1).length, generated_at: new Date().toISOString() } });
      }
      if (url.origin === base && !url.pathname.startsWith('/api/')) return route.continue();
      if (route.request().resourceType() === 'script') return route.fulfill({ contentType: 'application/javascript', body: '' });
      if (route.request().resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
      return route.fulfill({ status: 404, json: { ok: false, reason: 'no-route' }, headers: { 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const chip = (group, id) => page.locator(`[data-chip-group="${group}"][data-chip-id="${id}"]`);
    const count = async (group, id) => Number(await chip(group, id).locator('span').last().innerText());
    const expectRows = async (expected) => {
      await page.waitForFunction(expected => {
        const actual = [...document.querySelectorAll('#content-host tr[data-row-key]')].map(r => r.dataset.rowKey).sort();
        return JSON.stringify(actual) === JSON.stringify(expected);
      }, [...expected].sort());
    };
    const go = async (sub, expected, query = 'scope=universe') => {
      await page.goto(`${base}/#/research/breakouts/${sub}?${query}`);
      await page.locator('[data-chip-bar]').waitFor();
      await expectRows(expected);
    };
    const click = async (group, id, expected) => {
      await chip(group, id).click();
      await page.waitForFunction(({group, id}) => document.querySelector(`[data-chip-group="${group}"][data-chip-id="${id}"]`)?.classList.contains('border-indigo-500'), {group, id});
      await expectRows(expected);
    };
    const all = cases.map(c => c[0]);
    await go('technical-scanner', all);
    for (const group of ['volume', 'proximity', 'trend']) assert(await chip(group, 'all').evaluate(el => el.classList.contains('border-indigo-500')));
    assert.equal(await count('volume', 'all'), 8);
    assert.equal(await count('volume', '1.5'), 3);
    assert.equal(await count('proximity', '5'), 2, 'exactly 5% below the high is included');
    assert.equal(await count('proximity', '10'), 4, '10% boundary is included');
    assert.equal(await count('proximity', '20'), 5, '20% boundary is included');
    assert.equal(await count('trend', 'above'), 4);

    // A chip click must not erase the table's existing controls.
    await page.locator('[data-table-search]').fill('ALPHA');
    const tier = await page.evaluate(async () => {
      const p = (await import('/js/data/technicals.js')).byTicker('ALPHA').scorePct;
      return p >= 80 ? 'excellent' : p >= 60 ? 'good' : p >= 40 ? 'average' : 'weak';
    });
    await page.locator('[data-table-filter]').selectOption(tier);
    await click('volume', '1.5', ['ALPHA']);
    assert.match(await page.locator('[data-table-search]').inputValue(), /^alpha$/i);
    assert.equal(await page.locator('[data-table-filter]').inputValue(), tier);
    await page.locator('[data-table-search]').fill('');
    await page.locator('[data-table-filter]').selectOption('all');
    await expectRows(['ALPHA', 'EPSILON', 'ZETA']);
    await click('proximity', '5', ['ALPHA', 'EPSILON']);
    assert.equal(await count('trend', 'above'), 1);
    await click('trend', 'above', ['ALPHA']);
    assert.equal(await count('proximity', 'all'), 2, 'alternative counts hold the other groups fixed');
    assert.equal(await page.locator('[data-top-idx]').count(), 1);
    assert.match(await page.locator('[data-top-cards]').innerText(), /ALPHA/);
    await page.locator('[data-export]').click();
    assert.deepEqual(await page.evaluate(() => window.__filterExport), ['ALPHA']);
    await page.locator('[data-refresh-btn]').click();
    await page.waitForFunction(() => !document.querySelector('[data-refresh-btn]').disabled);
    assert.deepEqual(refreshes.at(-1), ['ALPHA']);
    await page.screenshot({ path: '/tmp/glow-technical-filters-scanner.png' });
    await page.reload();
    await expectRows(['ALPHA']);

    await go('technical-scanner', ['ALPHA', 'GAMMA', 'DELTA', 'MISSING'], 'scope=portfolio');
    assert.equal(await count('volume', '1.5'), 1, 'counts use the current portfolio scope');
    await page.evaluate(async () => { const w = await import('/js/core/watchlist.js'); w.add('ALPHA'); w.add('BETA'); });
    await go('technical-scanner', ['ALPHA', 'BETA'], 'scope=watchlist');
    assert.equal(await count('volume', 'all'), 2);
    assert.equal(await count('volume', '1.5'), 1);
    await page.evaluate(async () => (await import('/js/core/watchlist.js')).remove('ALPHA'));
    await click('volume', '1.5', []);
    assert(await page.locator('[data-refresh-btn]').isDisabled(), 'empty filters cannot dispatch an empty quote request');
    await go('technical-scanner', all, 'scope=universe&vol=any&near=invalid&dma=any');
    for (const group of ['volume', 'proximity', 'trend']) assert(await chip(group, 'all').evaluate(el => el.classList.contains('border-indigo-500')));

    await go('fii-accumulation', ['ALPHA', 'BETA', 'GAMMA', 'EPSILON', 'MISSING']);
    assert.equal(await count('volume', 'all'), 5);
    assert.equal(await count('volume', '1.5'), 2, 'FII counts include the existing holding filters');
    await click('volume', '1.5', ['ALPHA', 'EPSILON']);
    await click('proximity', '5', ['ALPHA', 'EPSILON']);
    await click('trend', 'above', ['ALPHA']);
    assert.equal(await count('magnitude', '1'), 0);
    await click('magnitude', '1', []);
    assert.equal(await count('trend', 'all'), 1);
    await click('trend', 'all', ['EPSILON']);
    await click('side', 'both', []);
    await click('side', 'fii', ['EPSILON']);
    await page.locator('[data-export]').click();
    assert.deepEqual(await page.evaluate(() => window.__filterExport), ['EPSILON']);
    await page.reload();
    await expectRows(['EPSILON']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: '/tmp/glow-technical-filters-fii-mobile.png' });

    // Sharing the predicates must retain the separate Strong Breakouts qualification.
    await go('strong-breakouts', ['BETA', 'GAMMA', 'DELTA']);
    await click('proximity', '10', ['BETA']);
    assert.deepEqual(errors, []);
    console.log('PASS technical filters: shared thresholds, boundaries, facet counts, scope, missing data, search/score retention, cards, export, refresh, URL restore, FII combinations and mobile layout');
  } finally { await context.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
  const { chromium } = await import(`${root}/index.mjs`);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try { await verifyTechnicalFiltersUI(browser, { base: process.argv[2] || 'http://127.0.0.1:8080' }); }
  finally { await browser.close(); }
}
