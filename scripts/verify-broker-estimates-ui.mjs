#!/usr/bin/env node
// scripts/verify-broker-estimates-ui.mjs — the "What brokers say" block (#452) in the real app.
//
// Opens a one-pager for a company brokers HAVE covered and asserts the block renders — a consensus
// line, a per-broker row with a rating or target, and a source link — with zero uncaught errors;
// then opens one a broker has NOT covered and asserts the block is ABSENT, never an empty shell.
//
// Which companies those are is read from the committed broker-reports.json at run time, not
// hard-coded, so the check cannot go stale as the broker capture moves. Serves the committed
// public/ (data included); no API and no egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// The companies brokers have (and have not) covered, straight from the file the page reads.
const brokerFile = JSON.parse(await readFileP(`${root}/data/broker-reports.json`, 'utf8'));
const covered = new Set((brokerFile.reports || []).filter((r) => r.ticker).map((r) => String(r.ticker).toUpperCase()));
assert.ok(covered.size > 0, 'the committed broker-reports.json names at least one covered company');

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/') || req.method !== 'GET') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  readFile(file, (err, bytes) => {
    if (err) { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  });
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const playwrightRoot = process.env.PLAYWRIGHT_ROOT || '/opt/node-tools/node_modules/playwright';
const { chromium } = await import(`${playwrightRoot}/index.mjs`);
let browser;
let failed = false;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : { args: ['--no-sandbox'] });
  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'light', viewport: { width: 1280, height: 1600 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${origin}/#/research/ai-insights?scope=universe`);
  await page.locator('#content-host[data-active-tab="ai-insights"]').waitFor();
  await page.waitForLoadState('networkidle');       // broker-reports.json has loaded by here
  await page.locator('[data-open]').first().waitFor();

  // The companies the AI Insights tab actually lists, split by broker coverage.
  const shown = await page.locator('[data-open]').evaluateAll((els) => els.map((e) => e.dataset.open));
  const withCoverage = shown.filter((t) => covered.has(String(t).toUpperCase()));
  const without = shown.filter((t) => !covered.has(String(t).toUpperCase()));
  assert.ok(shown.length > 0, 'the AI Insights tab lists at least one company');

  const openPager = async (ticker) => {
    await page.locator(`[data-open="${ticker}"]`).first().click();
    const pager = page.locator(`#modal-content .gi-pager[data-ticker="${ticker}"]`);
    await pager.waitFor();
    return pager;
  };
  const closePager = async () => { await page.keyboard.press('Escape'); await page.locator('#modal-content .gi-pager').waitFor({ state: 'detached' }).catch(() => {}); };

  let ranPresent = false;
  let ranAbsent = false;

  // ── A company brokers have covered: the block renders, reproducing their calls ──
  if (withCoverage.length) {
    const ticker = withCoverage[0];
    const pager = await openPager(ticker);
    const heading = pager.getByRole('heading', { name: /What brokers say/ });
    await heading.waitFor();
    assert.equal(await heading.count(), 1, `the block appears once on ${ticker}`);
    const rows = pager.locator('.gi-brotable tbody tr');
    const rowCount = await rows.count();
    assert.ok(rowCount >= 1, `at least one named broker row is shown for ${ticker}`);
    assert.ok((await rows.first().innerText()).trim().length > 0, 'a broker row is not blank');
    assert.ok(await pager.locator('.gi-brotable td a[href^="https://t.me/"]').count() >= 1, 'a broker row links to its source post');
    assert.ok(/broker/i.test(await pager.locator('.gi-iv-read').last().innerText()), 'the consensus line names the brokers');
    console.log(`ok   ${ticker} shows the broker block: ${rowCount} broker row(s)`);
    ranPresent = true;
    await closePager();
  } else {
    console.log('skip present case — no listed company currently has broker coverage');
  }

  // ── A company brokers have NOT covered: no block at all, not an empty shell ──
  if (without.length) {
    const ticker = without[0];
    const pager = await openPager(ticker);
    await pager.getByRole('heading', { name: /What it's worth|The fundamentals|Our view|financials/i }).first().waitFor();
    assert.equal(await pager.getByRole('heading', { name: /What brokers say/ }).count(), 0, `${ticker} (no coverage) shows no broker block`);
    assert.equal(await pager.locator('.gi-brotable').count(), 0, 'and no empty broker table');
    console.log(`ok   ${ticker} (no broker coverage) shows no broker block — absent, not empty`);
    ranAbsent = true;
    await closePager();
  } else {
    console.log('skip absent case — every listed company currently has broker coverage');
  }

  assert.ok(ranPresent || ranAbsent, 'at least one of the present/absent cases was exercised');
  assert.deepEqual(errors, [], `zero uncaught page errors (saw: ${errors.join(' | ')})`);
  console.log('ok   zero uncaught page errors');
  console.log('\nall broker-estimates UI checks passed');
} catch (err) {
  failed = true;
  console.error('FAIL', err?.stack || err?.message || err);
} finally {
  await browser?.close();
  server.close();
}
process.exit(failed ? 1 : 0);
