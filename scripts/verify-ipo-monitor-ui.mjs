#!/usr/bin/env node
// Isolated local browser. Real imported artifacts, mocked API and no outbound browser requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const data = (path) => JSON.parse(readFileSync(resolve(root, `data/ipo-monitor/${path}`)));
let failure = false,
  indexUnavailable = false,
  malformed = false,
  requests = [];
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tailwind.css"></head><body style="padding:16px;background:#f6f7fb"><main id="root"></main><div id="modal-overlay" class="hidden"><div id="modal-container"><div id="modal-content"></div></div></div><script type="module">
import * as tab from '/js/tabs/ipos.js';
window.showIpos=(params={})=>{tab.destroy();tab.render({root:document.querySelector('#root'),params,scope:'watchlist',data:{universe:[]}});};
window.destroyIpos=()=>{tab.destroy();document.querySelector('#root').innerHTML='Destroyed';};
window.showIpos();
</script></body></html>`;
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, method: req.method });
    res.setHeader('cache-control', 'no-store');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(html);
      return;
    }
    if (url.pathname === '/api/ipo-monitor') {
      res.setHeader('content-type', 'application/json');
      if (failure) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      const day = url.searchParams.get('snapshot');
      const latest = data('latest.json');
      if (malformed) latest.filings[0].company_name = '<img src=x onerror="window.ipoXss=1">';
      res.end(
        JSON.stringify(
          day
            ? { ok: true, snapshot: data(`snapshots/${day}.json`) }
            : {
                ok: true,
                latest,
                config: data('scoring_config.json'),
                historyDates: indexUnavailable ? [] : data('index.json').historyDates,
                historyAvailable: !indexUnavailable,
                checkedAt: '2026-09-04T08:00:00Z',
              },
        ),
      );
      return;
    }
    const path = resolve(root, `.${url.pathname}`);
    if (!path.startsWith(root + sep)) throw Error();
    res.setHeader(
      'content-type',
      { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(path)] ||
        'application/octet-stream',
    );
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser,
  checks = 0;
const check = (name, value) => {
  assert.ok(value, name);
  checks++;
  console.log(`PASS ${name}`);
};
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route
      .request()
      .url()
      .startsWith(origin + '/')
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.locator('.ipo-card').first().waitFor();
  check(
    'weekly KPIs match the reference screenshot and retain source dates',
    (await page.locator('.ipo-card strong').allTextContents()).join(',') === '3,4,4,5' &&
      /2026-08-31.*weekly/.test(await page.locator('[data-ipo-freshness]').innerText()),
  );
  check(
    'IPOs is a registered primary tab independent of an empty watchlist',
    await page.evaluate(async () => {
      const s = await fetch('/js/ui/shell.js').then((r) => r.text());
      const t = await import('/js/tabs/ipos.js');
      return s.includes("from '../tabs/ipos.js'") && t.meta.allowEmptyScope;
    }),
  );
  if (process.env.IPO_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.IPO_SCREENSHOT_DIR}/ipo-weekly.png`, fullPage: true });
  await page.locator('[data-ipo-mode="tracker"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ipo-history]')?.textContent.startsWith('9 of 9'),
  );
  check(
    'all 121 issuers from saved history and the supplement are available',
    /121 of 121/.test(await page.locator('[data-ipo-count]').innerText()),
  );
  await page.locator('[data-ipo-search]').fill('EAAA');
  check(
    'EAAA is searchable even without a listed ticker or portfolio membership',
    (await page.locator('[data-ipo-row]').count()) === 1 &&
      /EAAA India Alternatives/.test(await page.locator('[data-ipo-table]').innerText()),
  );
  await page.locator('[data-ipo-detail]').click();
  check(
    'EAAA expands to official DRHP and addendum dates with an explicit X coverage gap',
    /2026-01-19/.test(await page.locator('.ipo-detail').innerText()) &&
      /2026-08-13/.test(await page.locator('.ipo-detail').innerText()) &&
      /not independently captured/.test(await page.locator('.ipo-detail').innerText()) &&
      (await page.locator('.ipo-detail a[href="https://www.eaaa.in/ipo-page/"]').count()) > 0,
  );
  check(
    'EAAA has no inferred score or IPO timetable',
    /AWAITING DATA/.test(await page.locator('[data-ipo-row]').innerText()) &&
      /Open —/.test(await page.locator('[data-ipo-row]').innerText()),
  );
  if (process.env.IPO_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.IPO_SCREENSHOT_DIR}/ipo-eaaa.png`, fullPage: true });
  await page.locator('[data-ipo-search]').fill('Edelweiss Alternatives');
  check('company aliases resolve the same issuer', (await page.locator('[data-ipo-row]').count()) === 1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-ipo-export]').click();
  const download = await downloadPromise;
  check(
    'CSV exports the filtered tracker',
    /sattva-ipo-tracker/.test(download.suggestedFilename()) &&
      readFileSync(await download.path(), 'utf8').includes('EAAA India Alternatives'),
  );
  await page.locator('[data-ipo-score]').click();
  check(
    'score breakdown explicitly excludes missing inputs',
    /Unprovided inputs are excluded/.test(await page.locator('#modal-content').innerText()),
  );
  await page.keyboard.press('Escape');
  await page.locator('[data-ipo-settings]').click();
  await page.locator('[data-component][data-field="weight"]').first().fill('999');
  await page.locator('[data-ipo-score-settings] button[type="submit"]').click();
  check(
    'invalid weights cannot silently change the model',
    /Weights must total 100/.test(await page.locator('[data-score-error]').innerText()),
  );
  await page.locator('[data-score-reset]').click();
  await page.locator('[data-ipo-reset]').click();
  await page.locator('[data-ipo-filter="type"]').selectOption('Prospectus');
  check(
    'filing filters work without claiming prospectus means listed',
    (await page.locator('[data-ipo-row]').count()) > 0 &&
      /Prospectus filed/.test(await page.locator('[data-ipo-table]').innerText()),
  );
  await page.locator('[data-ipo-metrics]').check();
  check(
    'review metrics are available on demand',
    (await page.locator('[data-ipo-table] thead').innerText()).includes('EBITDA'),
  );
  await page.locator('[data-ipo-reset]').click();
  await page.locator('[data-ipo-search]').fill('EAAA');
  await page.locator('[data-ipo-documents]').click();
  check(
    'company documents prefill the exact issuer but require the reader session',
    (await page.locator('[data-drhp-company]').inputValue()) === 'EAAA India Alternatives Limited' &&
      /Sign in/.test(await page.locator('[data-drhp-status]').innerText()),
  );
  check(
    'opening tracker/documents never starts upstream sync or changes portfolios',
    requests.every((r) => r.method === 'GET' && !/sync|capture|portfolio/.test(r.path)),
  );
  await page.locator('[data-ipo-mode="news"]').click();
  await page.locator('[data-ipo-news-query]').waitFor();
  await page.locator('[data-ipo-news-query]').fill('EAAA');
  check(
    'News & X says the buzz is unverified, not that no discussion exists',
    /No successful capture yet/.test(await page.locator('[data-ipo-view]').innerText()) &&
      /does not mean/.test(await page.locator('[data-ipo-stories]').innerText()),
  );
  await page.locator('[data-ipo-mode="tracker"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    'mobile controls fit the viewport; wide tables scroll internally',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  if (process.env.IPO_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.IPO_SCREENSHOT_DIR}/ipo-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  failure = true;
  await page.locator('[data-ipo-refresh]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-ipo-freshness]').textContent.startsWith('Bundled capture'),
  );
  check(
    'source failure is visible and does not erase captured companies',
    /could not be read/.test(await page.locator('[data-ipo-freshness]').innerText()) &&
      (await page.locator('[data-ipo-row]').count()) === 1,
  );
  failure = false;
  indexUnavailable = true;
  await page.evaluate(() => window.showIpos({view: 'tracker'}));
  await page.waitForFunction(() => document.querySelector('[data-ipo-history]')?.textContent.startsWith('9 of 9'));
  check('GitHub index failure retains all imported issuers with a visible fallback warning',
    /121 of 121/.test(await page.locator('[data-ipo-count]').innerText()) &&
    /bundled archive index/.test(await page.locator('[data-ipo-freshness]').innerText()));
  indexUnavailable = false;
  malformed = true;
  await page.evaluate(() => window.showIpos());
  await page.locator('.ipo-card').first().waitFor();
  check(
    'upstream company strings are escaped, never executable markup',
    (await page.evaluate(() => !window.ipoXss)) && (await page.locator('.ipo-company img').count()) === 0,
  );
  await page.evaluate(() => window.destroyIpos());
  check(
    'teardown leaves no late rendering or browser exceptions',
    errors.length === 0 && (await page.locator('#root').innerText()) === 'Destroyed',
  );
  console.log(`\n${checks} IPO browser checks passed.`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
