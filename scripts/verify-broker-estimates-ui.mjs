#!/usr/bin/env node
// scripts/verify-broker-estimates-ui.mjs — the "What brokers say" block (#452) in the real app.
//
// Opens a one-pager for a company brokers HAVE covered (BAJAJ-AUTO) and asserts the block renders —
// a consensus line, a per-broker row with a rating and a source link — with zero uncaught errors;
// then opens one a broker has NOT covered (HAL) and asserts the block is ABSENT, never an empty
// shell. Serves the committed public/ (data included); no API and no egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  // The page's live routes have no server here; answer them so nothing hangs, but the broker block
  // is drawn from the committed data/broker-reports.json, which is served below.
  if (pathname.startsWith('/api/') || req.method !== 'GET') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    const bytes = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end('{}'); }
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
  await page.locator('[data-open="BAJAJ-AUTO"]').first().waitFor();

  // ── A company brokers have covered: the block renders, reproducing their calls ──
  await page.locator('[data-open="BAJAJ-AUTO"]').first().click();
  const pager = page.locator('#modal-content .gi-pager[data-ticker="BAJAJ-AUTO"]');
  await pager.waitFor();
  const heading = pager.getByRole('heading', { name: /What brokers say/ });
  await heading.waitFor();
  assert.equal(await heading.count(), 1, 'the "What brokers say" block appears once on a covered company');

  const rows = pager.locator('.gi-brotable tbody tr');
  const rowCount = await rows.count();
  assert.ok(rowCount >= 1, 'at least one named broker row is shown');
  // Each row names a broker and carries a rating pill or a target or an em dash — never blank.
  const firstRowText = (await rows.first().innerText()).trim();
  assert.ok(firstRowText.length > 0, 'a broker row is not blank');
  assert.ok(await pager.locator('.gi-brate, .gi-brotable td').count() >= 1, 'ratings/targets render in the table');
  // The source is reachable: a broker row links to the post it was read from.
  assert.ok(await pager.locator('.gi-brotable td a[href^="https://t.me/"]').count() >= 1, 'a broker row links to its source post');
  // The consensus line names the broker count.
  const read = (await pager.locator('.gi-iv-read').last().innerText()).toLowerCase();
  assert.ok(/broker/.test(read), 'the consensus line names the brokers');
  console.log(`ok   BAJAJ-AUTO shows the broker block: ${rowCount} broker row(s)`);
  console.log(`     consensus: ${read.replace(/\s+/g, ' ').slice(0, 120)}`);

  await page.keyboard.press('Escape');

  // ── A company brokers have NOT covered: no block at all, not an empty shell ──
  await page.locator('[data-open="HAL"]').first().waitFor();
  await page.locator('[data-open="HAL"]').first().click();
  const halPager = page.locator('#modal-content .gi-pager[data-ticker="HAL"]');
  await halPager.waitFor();
  await halPager.getByRole('heading', { name: /What it's worth|The fundamentals|Our view/ }).first().waitFor();
  assert.equal(await halPager.getByRole('heading', { name: /What brokers say/ }).count(), 0,
    'a company with no broker report shows no broker block');
  assert.equal(await halPager.locator('.gi-brotable').count(), 0, 'and no empty broker table');
  console.log('ok   HAL (no broker coverage) shows no broker block — absent, not empty');

  assert.deepEqual(errors, [], `zero uncaught page errors (saw: ${errors.join(' | ')})`);
  console.log(`ok   zero uncaught page errors`);
  console.log('\nall broker-estimates UI checks passed');
} catch (err) {
  failed = true;
  console.error('FAIL', err?.message || err);
} finally {
  await browser?.close();
  server.close();
}
process.exit(failed ? 1 : 0);
