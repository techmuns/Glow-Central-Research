#!/usr/bin/env node
// THE PORTFOLIO CALENDAR SURVIVES A FAILURE IN THE FEED IT SHARES A ROUTE WITH.
//
// `/api/concalls` assembles two independent upstreams: StockScans' analysed con-call rows, and the
// authenticated S Screen dashboard captured into an immutable Actions artifact. Either fails on
// its own, and when StockScans is the one that fails the Worker serves the committed snapshot —
// a capture of StockScans alone, which has never carried a calendar at all.
//
// Both used to arrive in the browser as `[]`, which was written straight over a good calendar and
// then persisted, because the response is stored under the server's own ETag. All Alerts' Upcoming
// view emptied on an outage in a feed it does not read, and stayed empty across reloads.
//
// Every assertion here is about that boundary: an absent calendar is retained, a read one wins,
// and an EMPTY SUCCESSFUL read still clears — "the dashboard has nothing on it" is a real answer
// and must not be confused with "we could not ask".
//
// Local captures and local stand-ins only. No production requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const snapshot = JSON.parse(readFileSync(resolve(root, 'data/concall-scans.json')));

const event = (ticker, date, eventType) => ({
  id: `${ticker}|${date}|${eventType}|day`, companyKey: ticker, ticker, name: `${ticker} Limited`,
  date, time: null, eventType, companyUrl: `https://www.screener.in/company/${ticker}/`,
  sourceUrl: `https://www.screener.in/company/${ticker}/`, observedAt: '2026-09-04T07:00:00Z',
});
const FULL = [event('STLTECH', '2026-09-10', 'AGM'), event('RELIANCE', '2026-09-12', 'Result')];
const SHRUNK = [event('RELIANCE', '2026-09-12', 'Result')];

// The four shapes the route can answer with. Only the first two are successful reads of the
// dashboard; the last two are the failures that used to read as an empty calendar.
const MODES = {
  full: { portfolioUpcoming: FULL, screener: { status: 'ok', checkedAt: '2026-09-04T07:00:00Z', portfolioUpcomingAvailable: true } },
  shrunk: { portfolioUpcoming: SHRUNK, screener: { status: 'ok', checkedAt: '2026-09-05T07:00:00Z', portfolioUpcomingAvailable: true } },
  emptied: { portfolioUpcoming: [], screener: { status: 'ok', checkedAt: '2026-09-06T07:00:00Z', portfolioUpcomingAvailable: true } },
  // The artifact could not be read: capture null, so the route sends no calendar.
  'artifact-failed': { portfolioUpcoming: null, screener: { status: 'failed', checkedAt: '2026-09-06T09:00:00Z', portfolioUpcomingAvailable: false } },
};
let mode = 'full';
let stockscansDown = false;
// The Worker is unreachable entirely: a reload paints the stored response, and nothing in this
// session has confirmed any of it.
let routeDown = false;

const html = `<!doctype html><html><body><script type="module">
import * as concalls from '/js/data/concall-scans.js';
window.concalls = concalls;
window.ready = concalls.load().then(() => true, (e) => 'error: ' + e.message);
</script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value, tag) => {
    res.setHeader('content-type', 'application/json');
    if (tag) res.setHeader('etag', tag);
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
    if (url.pathname === '/api/concalls') {
      if (routeDown) { res.writeHead(503); res.end('{}'); return; }
      // StockScans down: the Worker's own fallback branch, which serves the committed snapshot and
      // states `portfolioUpcoming: null` rather than leaving the key merely missing.
      if (stockscansDown) return json({ ...snapshot, ok: true, portfolioUpcoming: null,
        degraded: 'StockScans is unavailable — showing the last committed snapshot.' }, '"snapshot-fallback"');
      const { portfolioUpcoming, screener } = MODES[mode];
      return json({ ...snapshot, portfolioUpcoming, meta: { ...snapshot.meta, screener } }, `"${mode}"`);
    }
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + sep)) throw Error('Invalid path');
    res.setHeader('content-type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const context = await browser.newContext();
const errors = [];
let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); }
  catch (error) { failures++; console.log(`FAIL  ${label}\n      ${error.message}`); }
};

const openPage = async () => {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
  await page.route('**/*', (route) => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 503, body: '{}' }));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => window.ready), true, 'the con-call module failed to load');
  return page;
};
const state = (page) => page.evaluate(() => ({
  dates: window.concalls.portfolioUpcoming().map((row) => `${row.ticker}|${row.date}`),
  rows: window.concalls.all().length,
  retained: window.concalls.meta()?.portfolioUpcomingRetained,
  supplied: window.concalls.meta()?.portfolioUpcomingSupplied,
  calendarAsOf: window.concalls.meta()?.portfolioUpcomingCheckedAt,
  screener: window.concalls.meta()?.screener?.status ?? null,
}));

const page = await openPage();
let now = await state(page);
check('a healthy read paints the dashboard calendar and is not marked retained', () => {
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12']);
  assert.equal(now.retained, false);
  assert.equal(now.calendarAsOf, '2026-09-04T07:00:00Z');
});

// A SUCCESSFUL READ ALWAYS WINS, INCLUDING A SHORTER ONE. A forward calendar legitimately shrinks
// as its dates pass, so retention must never become a merge that keeps yesterday's events alive.
mode = 'shrunk';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('a shorter successful read replaces the calendar rather than merging into it', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, false);
  assert.equal(now.calendarAsOf, '2026-09-05T07:00:00Z');
});

// THE FAILURE THIS FILE EXISTS FOR.
mode = 'artifact-failed';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('an unreadable S Screen artifact retains the calendar instead of emptying it', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.screener, 'failed', 'the failure must still be reported');
  assert.equal(now.retained, true, 'and the rows must be labelled as retained');
});
check('a retained calendar keeps its own capture time, not the failed check', () => {
  assert.equal(now.calendarAsOf, '2026-09-05T07:00:00Z');
});

// AND IT SURVIVES A RELOAD. The response is stored under the server's ETag, so without a retained
// copy of its own the reload repaints the empty calendar the failure carried — which is the
// version of this bug that looks permanent rather than transient.
await page.reload();
await page.waitForFunction(() => window.ready);
now = await state(page);
check('the retained calendar survives a reload while the artifact is still unreadable', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, true);
});

// A STOCKSCANS OUTAGE MAY NOT EMPTY A FEED IT DOES NOT PUBLISH. The Worker's snapshot fallback is
// a capture of StockScans alone and carries no calendar at all.
mode = 'shrunk';
stockscansDown = true;
await page.evaluate(() => window.concalls.refresh().catch(() => null));
now = await state(page);
check('a StockScans outage does not empty the S Screen calendar', () => {
  assert.deepEqual(now.dates, ['RELIANCE|2026-09-12']);
  assert.equal(now.retained, true);
});

// AND AN EMPTY SUCCESSFUL READ STILL CLEARS. "The dashboard has nothing scheduled" is an answer;
// retention must not turn it into a calendar that can never go back to nothing.
stockscansDown = false;
mode = 'emptied';
await page.evaluate(() => window.concalls.refresh());
now = await state(page);
check('a successful read of an empty dashboard clears the calendar', () => {
  assert.deepEqual(now.dates, []);
  assert.equal(now.retained, false);
  assert.equal(now.calendarAsOf, '2026-09-06T07:00:00Z');
});

// A LIVE READ THAT NEVER HAPPENED IS NOT A CONFIRMATION. Reloading against an unreachable route
// paints the stored response, whose own `meta.screener` said `ok` when it was written. Reporting
// that as a current capture is the same class of claim as the empty calendar above, one layer on.
mode = 'full';
await page.evaluate(() => window.concalls.refresh().catch(() => null));
routeDown = true;
await page.reload();
await page.waitForFunction(() => window.ready);
now = await state(page);
check('a reload with an unreachable route serves the calendar as retained, not as confirmed', () => {
  assert.deepEqual(now.dates, ['STLTECH|2026-09-10', 'RELIANCE|2026-09-12'], 'the stored calendar is still painted');
  assert.equal(now.retained, true, 'bytes nobody confirmed in this session may not read as a fresh capture');
});
routeDown = false;

// AN AVAILABILITY TRANSITION IS ITSELF A CHANGE. `hasChanged` gates whether subscribers repaint,
// and the coverage chip reads the retention flag — so a calendar going missing, or coming back
// with the same rows, has to reach them rather than waiting for the next full collection.
const page3 = await openPage();
const changes = () => page3.evaluate(() => window.__calendarChanges || 0);
await page3.evaluate(() => {
  window.__calendarChanges = 0;
  window.concalls.onChange(() => { window.__calendarChanges += 1; });
});
mode = 'artifact-failed';
await page3.evaluate(() => window.concalls.refresh());
const afterLoss = await changes();
const lostState = await state(page3);
check('a calendar going missing notifies subscribers even though its rows are unchanged', () => {
  assert.equal(afterLoss, 1, `expected one change notification, saw ${afterLoss}`);
  assert.equal(lostState.retained, true);
  assert.equal(lostState.supplied, false);
});
mode = 'full';
await page3.evaluate(() => window.concalls.refresh());
const afterRecovery = await changes();
const recoveredState = await state(page3);
check('and the same calendar coming back notifies them too', () => {
  assert.equal(afterRecovery, 2, `expected a second change notification, saw ${afterRecovery}`);
  assert.equal(recoveredState.retained, false);
  assert.equal(recoveredState.supplied, true);
});
await page3.close();

await page.close();

check('no console errors', () => assert.deepEqual(errors, []));

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll portfolio-calendar checks passed');
process.exit(failures ? 1 : 0);
