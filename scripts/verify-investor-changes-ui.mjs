import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function verifyChangesUI(page, { base = 'http://127.0.0.1:8089' } = {}) {
  const nav = '[data-live-section-tabs]';
  const audience = '[data-changes-audience]';
  const settled = () => page.waitForSelector('[data-investor-changes][data-changes-ready="true"]');
  await page.goto(`${base}/#/research/super-investors/superstar-investors?scope=portfolio`);
  await settled();
  assert.deepEqual(await page.locator(`${nav} [role=tab]`).allTextContents().then((xs) => xs.map((s) => s.trim())), ['Changes', 'My Managers', 'All Investors', 'Data Table']);
  assert.equal(await page.locator(`${nav} [aria-selected=true]`).innerText(), 'Changes');
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-changes-panel'), 'my-managers');
  assert.equal(await page.locator('[data-changes-period]').inputValue(), 'quarter');
  assert.deepEqual(await page.locator('[data-changes-period] option').allTextContents(), ['This month', 'This quarter', '6 months', '1 year', 'ITD']);
  for (const period of ['month', 'quarter', '6m', 'year', 'itd']) {
    await page.locator('[data-changes-period]').selectOption(period);
    const expected = await page.evaluate(async (period) => {
      const model = await import('/js/data/investor-changes.js');
      const managers = await import('/js/data/managers.js');
      const investors = await import('/js/data/super-investors.js');
      const { insider } = await import('/js/data/filings.js');
      const people = managers.all().map((m) => ({ id: m.id, name: m.name, aliases: [m.house, investors.list().find((i) => i.slug === m.finologySlug)?.name].filter(Boolean) }));
      const range = model.periodRange(period);
      return [...model.managerTrades(managers.all()), ...model.matchedDeals(insider.rows(), people)].filter((r) => model.inPeriod(r, range)).length;
    }, period);
    assert.equal(Number(await page.locator('[data-changes-panel]').getAttribute('data-activity-total')), expected, period);
    assert(await page.locator('[data-changes-coverage]').innerText().then((s) => s.includes('not necessarily inception')));
  }
  await page.locator('[data-changes-activity] tr[data-row-key]').first().click();
  await page.waitForSelector('#modal-overlay.is-open');
  assert.match(await page.locator('#modal-content').innerText(), /Statement|Bulk|Block/i);
  await page.keyboard.press('Escape');
  await page.locator('[data-changes-holdings] summary').click();
  assert(await page.locator('[data-changes-observations] tr[data-row-key]').count() > 0);
  await page.locator(`${nav} [data-tab-id=my-managers]`).click();
  await page.waitForSelector('[data-managers-panel]:not([data-managers-loading])');
  assert(await page.locator('[data-open-manager]').count() > 0);
  await page.locator(`${nav} [data-tab-id=investors]`).click();
  assert(await page.locator('[data-open-investor]').count() > 0);
  await page.locator(`${nav} [data-tab-id=quarterly-changes]`).click();
  await settled();
  assert.equal(await page.locator('[data-changes-period]').inputValue(), 'itd');
  await page.locator(`${audience} [data-tab-id=investors]`).click();
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-changes-panel'), 'investors');
  assert.equal(await page.locator('[data-changes-period]').inputValue(), 'itd');
  assert.match(await page.locator('[data-changes-panel]').innerText(), /Tracked investors/);
  await page.evaluate(() => { location.hash = '#/research/super-investors/superstar-investors?scope=universe'; });
  await settled();
  assert.equal(await page.locator('[data-changes-panel]').getAttribute('data-changes-panel'), 'investors');
  assert(Number(await page.locator('[data-changes-panel]').getAttribute('data-activity-total')) > 0);
  assert(Number(await page.locator('[data-changes-panel]').getAttribute('data-holdings-total')) > 0);
  assert.equal(await page.locator('[data-changes-observations] [data-watch]').count(), 0, 'public comparison IDs must not become watchlist tickers');
  await page.locator('[data-changes-period]').selectOption('month');
  assert.equal(await page.locator('[data-changes-period]').evaluate((el) => el === document.activeElement), true);
  await page.locator(`${audience} [data-tab-id=my-managers]`).click();
  assert.equal(await page.locator(`${audience} [aria-selected=true]`).evaluate((el) => el === document.activeElement), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page must not overflow');
  assert(await page.locator('[data-changes-period]').isVisible());
  await page.screenshot({ path: '/tmp/glow-changes-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/glow-changes-desktop.png', fullPage: true });
  await page.goto(`${base}/#/research/super-investors/institutions?scope=universe`);
  await page.waitForSelector('[data-filed-section-tabs]');
  await page.goto(`${base}/#/research/super-investors/superstar-investors?scope=universe`);
  await settled();
  assert.equal(await page.locator(`${nav} [aria-selected=true]`).innerText(), 'Changes');
  assert.equal(await page.locator('[data-changes-period]').inputValue(), 'quarter');
  await page.locator('[data-holdings-integrity] summary').click();
  const expectedCoverage = await page.evaluate(async () => {
    const investors = await import('/js/data/super-investors.js');
    const managers = await import('/js/data/managers.js');
    return investors.list().length + managers.all().length;
  });
  assert.equal(await page.locator('[data-integrity-person]').count(), expectedCoverage, 'coverage must include every investor and every manager');
  await page.locator('[data-integrity-search]').fill('Madhusudan');
  assert.equal(await page.locator('[data-integrity-person]').count(), 1);
  await page.locator('[data-integrity-person]').click();
  await page.waitForSelector('[data-associated-evidence]');
  assert.match(await page.locator('[data-associated-evidence]').innerText(), /TIL.*Singularity Equity Fund I.*1.35%/s);
  assert.match(await page.locator('[data-associated-evidence]').innerText(), /not evidence of personal ownership/);
  assert.match(await page.locator('#workspace-panel').innerText(), /Unconfirmed/);
  await page.locator('[data-ws-tab=moves]').click();
  const periods = await page.evaluate(async () => (await import('/js/data/super-investors.js')).movesFor('madhusudan-kela'));
  assert((await page.locator('#workspace-panel').innerText()).includes(`${periods.latest} minus ${periods.prior}`));
  assert.doesNotMatch(await page.locator('#workspace-panel').innerText(), /Aug 2026 minus/);
  await page.keyboard.press('Escape');
  await page.locator('[data-integrity-search]').fill('Mukul');
  await page.locator('[data-integrity-person]').click();
  await page.locator('[data-ws-tab=moves]').click();
  const mukulPeriods = await page.evaluate(async () => (await import('/js/data/super-investors.js')).movesFor('mukul-agrawal'));
  assert((await page.locator('#workspace-panel').innerText()).includes(`${mukulPeriods.latest} minus ${mukulPeriods.prior}`));
  await page.keyboard.press('Escape');
  await page.locator('[data-integrity-search]').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'expanded coverage must stay within the mobile page');
  await page.screenshot({ path: '/tmp/glow-holdings-integrity-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/glow-holdings-integrity-desktop.png', fullPage: true });
  console.log('PASS Changes UI: default/order, independent audiences, five periods, directory navigation, source details, preserved state, keyboard focus and mobile overflow');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
  const { chromium } = await import(`${root}/index.mjs`);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await verifyChangesUI(page, { base: process.argv[2] || 'http://127.0.0.1:8089' });
    assert.deepEqual(errors, [], 'no browser runtime errors');
  } finally { await browser.close(); }
}
