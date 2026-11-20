// verify-framework-ui.mjs — the Framework tab in a real browser, against the real shared store.
// GLOW-OWNED. Serves public/ and stands up /api/framework backed by the actual FrameworkStore on
// node:sqlite, then drives two devices: one scores a company, the other sees it. No egress.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FrameworkStore } from '../worker/framework-store.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const root = resolve('public');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

const db = new DatabaseSync(':memory:');
let clock = 0;
const store = new FrameworkStore({
  sql: { exec: (sql, ...a) => { const rows = db.prepare(sql).all(...a); return { toArray: () => rows }; } },
  transactionSync: (fn) => { db.exec('BEGIN'); try { const o = fn(); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } },
}, { now: () => (clock += 1000) });

const readBody = (req) => new Promise((done) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => done(b)); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('cache-control', 'no-cache');
  if (url.pathname === '/api/framework') {
    try {
      if (req.method === 'POST') {
        const input = JSON.parse(await readBody(req));
        const result = store.apply(input?.intents);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, ...result.snapshot, outcomes: result.outcomes, checkedAt: new Date().toISOString() }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ...store.snapshot() }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: String(e?.message || e) })); }
    return;
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  try {
    const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (file !== resolve(root, 'index.html') && !file.startsWith(root + sep)) throw Error('bad');
    const body = readFileSync(file);
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((d) => server.listen(0, '127.0.0.1', d));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const pass = (m) => console.log('  PASS ', m);
const ROW = '[data-table-scroll] tbody tr:not([aria-hidden="true"])';

async function openTab(colorScheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/#/research/framework`, { waitUntil: 'domcontentloaded' });
  await page.locator('#tabbar-mount [data-tab-id="framework"][aria-selected="true"]').waitFor({ timeout: 30000 });
  await page.locator(ROW).first().waitFor({ timeout: 30000 });
  return { ctx, page, errors };
}

const scoreOne = async (page, name) => {
  await page.locator('[data-table-search]').fill(name);
  await page.waitForTimeout(400);
  await page.locator(ROW).first().click();
  await page.locator('.fw-drill').waitFor({ timeout: 8000 });
};

try {
  const a = await openTab('light');

  // 1) renders the whole worksheet
  const rows = await a.page.locator(ROW).count();
  assert.ok(rows >= 40, `the worksheet renders the company list (${rows} rows on first paint)`);
  pass(`the worksheet renders (${rows} rows painted)`);
  assert.ok(/five criteria/i.test(await a.page.locator('#content-host').innerText()), 'the rubric is described in the head');
  pass('the rubric and scope note are shown');

  // 2) score a company in the rubric-guided drill
  await scoreOne(a.page, 'Tips Music');
  const crits = await a.page.locator('.fw-crit').count();
  assert.ok(crits >= 6, `the drill shows every criterion plus the gate (${crits} blocks)`);
  pass(`the drill is rubric-guided (${crits} blocks incl. the gate)`);
  await a.page.locator('.fw-crit .fw-score-btn[data-fw-value="2"]').first().click();
  await a.page.locator('.fw-crit').nth(1).locator('.fw-score-btn[data-fw-value="1"]').click();
  await a.page.locator('.fw-gate-btn-pass').click();
  await a.page.locator('.fw-why').first().fill('Durable catalogue, pricing power.');
  await a.page.locator('.fw-why').first().blur();
  await a.page.waitForTimeout(400);
  pass('scores, gate and a rationale are entered');

  // 3) the shared store received them
  const snap = store.snapshot();
  assert.equal(snap.values.TIPSMUSIC['score:business-quality'].value, 2, 'the score reached the shared store');
  assert.equal(snap.values.TIPSMUSIC.gate.value, 'pass', 'the gate reached the shared store');
  assert.ok(snap.values.TIPSMUSIC['why:business-quality'].value.includes('pricing power'), 'the rationale reached the shared store');
  pass('every edit reached the shared store');

  // 4) the table reflects them after the drill closes
  await a.page.keyboard.press('Escape');
  await a.page.waitForTimeout(500);
  await a.page.locator('[data-table-search]').fill('Tips Music');
  await a.page.waitForTimeout(400);
  const rowText = (await a.page.locator(ROW).first().innerText()).replace(/\s+/g, ' ');
  assert.ok(rowText.includes('3/10') && rowText.includes('Pass'), `the row shows the total and gate — "${rowText.slice(0, 80)}"`);
  pass('the overview row shows the derived total and the gate');

  // 5) a reload keeps them (shared store, not just this paint)
  await a.page.reload();
  await a.page.locator(ROW).first().waitFor({ timeout: 30000 });
  await scoreOne(a.page, 'Tips Music');
  assert.equal(await a.page.locator('.fw-crit .fw-score-btn[data-fw-value="2"]').first().getAttribute('aria-pressed'), 'true', 'the score survives a reload');
  pass('a reload keeps the scores (shared store)');

  // 6) a SECOND device sees the first device's scores
  const b = await openTab('dark');
  await scoreOne(b.page, 'Tips Music');
  assert.equal(await b.page.locator('.fw-gate-btn-pass').getAttribute('aria-pressed'), 'true', 'the second device sees the shared gate');
  assert.equal(await b.page.locator('.fw-crit .fw-score-btn[data-fw-value="2"]').first().getAttribute('aria-pressed'), 'true', 'the second device sees the shared score');
  pass('a second device sees the same shared scores');

  assert.deepEqual(a.errors, [], `no page errors on device A (${a.errors.join(' | ')})`);
  assert.deepEqual(b.errors, [], `no page errors on device B (${b.errors.join(' | ')})`);
  pass('zero page errors on both devices');
} finally {
  await browser.close();
  server.close();
}
console.log('\nAll framework UI checks passed');
