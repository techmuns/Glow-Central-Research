#!/usr/bin/env node
// scripts/verify-fpi-activity-ui.mjs — the FPI Activity view, driven in a browser.
//
//   python3 -m http.server 8080 -d public
//   node scripts/verify-fpi-activity-ui.mjs [http://127.0.0.1:8080]
//
// `verify-fpi-activity.mjs` proves the figures; this proves the page. The checks that matter most
// are the lifecycle ones: `render()` runs again on every scope and sub-view change, so a view that
// paints once and then stops is the failure this codebase keeps having to un-write, and it is
// invisible from the data side.

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(PW_ROOT));
} catch {
  console.error(`Playwright not found at ${PW_ROOT}. Set PLAYWRIGHT_ROOT, e.g. PLAYWRIGHT_ROOT=$(npm root -g)/playwright`);
  process.exit(1);
}

// Serves `public/` itself on an ephemeral port when no base URL is given, so this runs in CI's
// browser job with no separate server step — the same arrangement as `verify-theme-ui.mjs`. Pass
// a URL to drive an already-running origin (`npx wrangler dev`, say) instead.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const root = fileURLToPath(new URL('../public', import.meta.url));
let server = null;
let BASE = process.argv[2];
if (!BASE) {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('cache-control', 'no-store');
    // No Worker here, and that is the point: the view must paint from the committed capture alone.
    if (path.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false,"error":"No Worker in this test"}');
      return;
    }
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      res.setHeader('content-type', MIME[extname(file)] || 'text/plain');
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  BASE = `http://127.0.0.1:${server.address().port}`;
}

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failed += 1;
};

// The sandbox reaches no CDN and serves no Worker, so these are the environment failing rather
// than the page. THE FILTER IS ON THE URL, not on the console text: Chromium's message for a 404
// is "Failed to load resource: the server responded with a status of 404" and carries no URL at
// all, so a filter written on that string would swallow a real 404 of one of this view's own files
// — which is the one thing this check exists to catch. Network failures are therefore judged from
// the request events, which do carry a URL, and the console is only asked about the rest.

const ENVIRONMENT_URL = [/fonts\.googleapis|fonts\.gstatic/i, /munshot\.s3|dashboard-sdk/i, /workers\.dev/i, /\/api\//i];
const isEnvironmentUrl = (url) => ENVIRONMENT_URL.some((re) => re.test(url));

const route = (view) => `${BASE}/#/research/macro-research/${view}`;

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  let dropped = 0;
  let cancelled = 0;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Network failures are judged from the request events below, which name the URL.
    if (/Failed to load resource/i.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    // A CANCELLED REQUEST IS NOT A FAILED ONE. `net::ERR_ABORTED` is what the browser reports when
    // a request is torn down rather than answered — which is exactly what this test does to the
    // bootstrap loads by reloading the page and then closing the browser while the deferred ones
    // are still in flight. Measured: it fired on roughly one run in three, on
    // `data/portfolio-companies.json` and `data/book.json`, and never on anything this view reads.
    // Nothing this check exists to catch is lost by excluding it: a genuinely missing file answers
    // HTTP 404, which the response handler below sees, and an unreachable server reports
    // ERR_CONNECTION_REFUSED, which is not an abort. They are counted so a run cannot hide behind
    // the exclusion.
    if (/ERR_ABORTED/i.test(why)) cancelled += 1;
    else if (isEnvironmentUrl(r.url())) dropped += 1;
    else errors.push(`request failed: ${r.url()} (${why})`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (isEnvironmentUrl(r.url())) dropped += 1;
    else errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto(route('fpi'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fpi-scroll] table', { timeout: 30000 });

  // ---- it is offered, and it is not the landing view --------------------------------------------
  const subviews = await page.$$eval('#subview-mount [data-dd-menu] [data-dd-id]', (els) => els.map((e) => e.dataset.ddId));
  ok('the sub-view picker offers FPI Activity', subviews.includes('fpi'), subviews.join(' · '));
  ok('...and it does not displace Commodities as the first view', subviews[0] === 'commodities', subviews[0]);
  ok('...and the trigger names the view now shown', /FPI Activity/.test(await page.textContent('#subview-mount [data-dd-trigger]')));

  // ---- the template's shape ---------------------------------------------------------------------
  const shape = await page.$eval('[data-fpi-scroll] table', (t) => ({
    groups: [...t.querySelectorAll('thead tr:first-child th')].map((th) => th.innerText.trim()),
    columns: [...t.querySelectorAll('thead tr:nth-child(2) th')].slice(1).map((th) => th.innerText.trim()),
    rows: [...t.querySelectorAll('tbody tr')].map((tr) => ({
      label: tr.querySelector('th').innerText.split('\n')[0].trim(),
      cells: [...tr.querySelectorAll('td')].map((td) => ({ text: td.innerText.trim(), title: td.getAttribute('title') || '' })),
    })),
    unscoped: [...t.querySelectorAll('th')].filter((th) => !th.getAttribute('scope')).length,
  }));
  ok('the five template rows, in order', shape.rows.map((r) => r.label).join(',') === 'G Sec,SDLs,Corp Bonds,Equity,Debt + Equity', shape.rows.map((r) => r.label).join(','));
  ok('eleven windows: three days, three months, two FYs, two CYs and the holding', shape.columns.length === 11, shape.columns.join(' | '));
  ok('the windows are grouped by kind', shape.groups.join(',').toLowerCase().includes('reporting day') && shape.groups.join(',').toLowerCase().includes('held now'), shape.groups.join(' | '));
  ok('every <th> carries a scope', shape.unscoped === 0, `${shape.unscoped} without one`);

  // ---- the honesty rules, on screen -------------------------------------------------------------
  const equity = shape.rows.find((r) => r.label === 'Equity');
  const total = shape.rows.find((r) => r.label === 'Debt + Equity');
  ok('equity carries no outstanding figure, and its cell says why', equity.cells.at(-1).text === '—' && /do not publish an outstanding equity holding/i.test(equity.cells.at(-1).title), JSON.stringify(equity.cells.at(-1)));
  ok('and the debt lines are not totalled with it', total.cells.at(-1).text === '—');
  ok('a debt cell says its figure is a change in outstanding investment', shape.rows[0].cells.some((c) => /change in outstanding investment/i.test(c.title)));
  ok('and that this is not net purchases', shape.rows[0].cells.some((c) => /not the same measurement as net purchases/i.test(c.title)));
  ok('an equity cell names it as NSDL\'s published net investment', equity.cells.some((c) => /published net investment/i.test(c.title)));
  ok('no cell is blank — a figure or an em dash, never nothing', shape.rows.every((r) => r.cells.every((c) => c.text.length > 0)));
  ok('negatives are in brackets', shape.rows.some((r) => r.cells.some((c) => /^\(.*\)$/.test(c.text))));

  const footnote = (await page.textContent('#dashboard-main')).replace(/\s+/g, ' ');
  for (const claim of ["The equity row is NSDL's own net investment", 'The three debt rows are derived', 'change in that holding', 'general investment route', 'Equity carries no outstanding figure']) {
    ok(`the footnote states: ${claim}`, footnote.includes(claim));
  }

  // ---- the provenance door ----------------------------------------------------------------------
  await page.click('[data-fpi-info]');
  await page.waitForSelector('#modal-content', { timeout: 8000 });
  const modal = (await page.textContent('#modal-content')).replace(/\s+/g, ' ');
  ok('the Sources modal names NSDL and each report it reads', /NSDL/.test(modal) && /Debt Utilisation Status/.test(modal) && /Daily Trends/.test(modal));
  ok('...and states the derivation and the reconciliation guard', /Debt is derived/.test(modal) && /published month/.test(modal));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal-content', { state: 'hidden', timeout: 8000 }).catch(() => {});

  // ---- the export leaves with its provenance ----------------------------------------------------
  const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.click('[data-fpi-csv]');
  const file = await download;
  if (!file) ok('the CSV downloads', false);
  else {
    const stream = await file.createReadStream();
    const text = await new Promise((res) => {
      let s = '';
      stream.on('data', (c) => { s += c; });
      stream.on('end', () => res(s));
    });
    ok('the CSV downloads', true, file.suggestedFilename());
    ok('...and row 1 carries the provenance a workbook leaves the page without', /not the same measurement as net purchases/i.test(text) && /NSDL/.test(text));
    ok('...and every template row is in it', ['G Sec', 'SDLs', 'Corp Bonds', 'Equity', 'Debt + Equity'].every((r) => text.includes(r)));
    ok('...and a window it cannot measure is blank, never a zero', !/,0,0,0,0,0,0,0,0,0,0/.test(text));
  }

  // ---- THE LIFECYCLE: render() runs again on every scope and sub-view change ----------------------
  const asOn = await page.textContent('[data-fpi-scroll] table thead');
  await page.click('[data-scope="watchlist"], [data-scope-option="watchlist"]').catch(() => {});
  await page.waitForTimeout(600);
  const stillThere = await page.$('[data-fpi-scroll] table');
  ok('a scope change repaints the view rather than killing it', !!stillThere);
  const afterScope = stillThere ? await page.textContent('[data-fpi-scroll] table thead') : '';
  ok('...and it still shows the same market-wide windows (scope does not narrow it)', afterScope === asOn);
  ok('...and the head says scope does not apply', (await page.textContent('#dashboard-main')).includes('scope does not apply'));

  await page.goto(route('commodities'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-macro-chart-card]', { timeout: 30000 });
  ok('switching to a series view drops the FPI table and draws the chart', !(await page.$('[data-fpi-scroll]')));
  await page.goto(route('fpi'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fpi-scroll] table', { timeout: 30000 });
  ok('and switching back rebuilds it', !!(await page.$('[data-fpi-scroll] table')));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-fpi-scroll] table', { timeout: 30000 });
  ok('a reload restores the FPI view from the URL', (await page.evaluate(() => location.hash)).includes('/fpi'));
  // Let the shell's bootstrap and deferred loads settle before the rest of the run tears the page
  // down around them, so the cancellations above stay rare rather than being manufactured here.
  await page.waitForLoadState('networkidle').catch(() => {});

  // ---- layout ------------------------------------------------------------------------------------
  for (const [w, h] of [[1440, 900], [1024, 800], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth));
    ok(`no sideways page scroll at ${w}px`, over <= 0, `${over}px`);
  }
  const inner = await page.evaluate(() => { const e = document.querySelector('[data-fpi-scroll]'); return e.scrollWidth - e.clientWidth; });
  ok('the table scrolls inside its own container at phone width', inner > 0, `${inner}px`);

  // ---- dark mode ----------------------------------------------------------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.querySelector('[data-theme-toggle]')?.click());
  await page.waitForTimeout(400);
  const dark = await page.evaluate(() => {
    const th = document.querySelector('[data-fpi-scroll] tbody th');
    const parse = (c) => (c.match(/\d+/g) || []).map(Number);
    const bg = parse(getComputedStyle(th).backgroundColor);
    const fg = parse(getComputedStyle(th.querySelector('span')).color);
    return { theme: document.documentElement.getAttribute('data-theme'), bgLuma: (bg[0] + bg[1] + bg[2]) / 3, fgLuma: (fg[0] + fg[1] + fg[2]) / 3 };
  });
  ok('dark mode repaints the sticky row header rather than leaving it white', dark.theme === 'dark' && dark.bgLuma < 90 && dark.fgLuma > 160, JSON.stringify(dark));

  ok('zero console errors and no failed request for a file of our own', errors.length === 0, errors.slice(0, 4).join(' | '));
  console.log(`\n(${dropped} environment failure(s) filtered by URL: no CDN and no Worker in this sandbox; ${cancelled} request(s) cancelled by this test's own teardown.)`);
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll FPI Activity UI checks passed.');
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
