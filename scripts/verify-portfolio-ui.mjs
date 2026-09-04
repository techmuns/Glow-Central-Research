// Start Research on localhost:8080 and the companion Family Vite app on
// localhost:5173. All external APIs and both model endpoints are intercepted:
// this test cannot send portfolio data to production or start a production run.
import assert from 'node:assert/strict';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
const errors = [];
let outage = false;
const questions = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/*', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.fulfill({ status: 503, body: 'External network disabled in this test' });
  if (url.pathname === '/api/workbooks') return json(route, outage ? { error: 'offline' } : { ok: true, storage: 'unconfigured', books: [] }, outage ? 503 : 200);
  if (url.port === '8080' && url.pathname === '/api/research') {
    if (req.method() === 'GET') return json(route, { configured: true });
    const body = req.postDataJSON();
    questions.push(body);
    return route.fulfill({ contentType: 'application/x-ndjson', body: [
      { type: 'text', text: 'Portfolio source was read. [Dashboard: Ask Sattva]' }, { type: 'done' },
    ].map(x => JSON.stringify(x)).join('\n') + '\n' });
  }
  if (url.pathname.startsWith('/api/')) return json(route, { ok: false, error: 'Test API unavailable' }, 503);
  return route.continue();
});
try {
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:5173/research', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const research = page.frameLocator('iframe[title="Portfolio-connected Sattva Research"]');
  await research.getByText('Full portfolio via Ask Sattva', { exact: false }).waitFor({ timeout: 90_000 });
  const input = research.getByRole('textbox', { name: 'Ask about the dashboard' });
  await input.fill('Do I have Sterlite in my portfolio?');
  await research.getByRole('button', { name: 'Send question' }).click();
  await research.getByText('Portfolio source was read.', { exact: false }).waitFor({ timeout: 125_000 });
  assert.equal(questions.length, 1);
  assert.ok(['ready', 'limited'].includes(questions[0].evidence.portfolio.status));
  assert.match(questions[0].evidence.portfolio.answer, /Sterlite/i);
  assert.equal(questions[0].evidence.portfolio.bookAsOf, '2026-06-30');
  await research.getByText('Portfolio book: 2026-06-30.', { exact: false }).waitFor();
  const child = page.frames().find(f => f.url().startsWith('http://localhost:8080'));
  assert.ok(child);
  assert.doesNotMatch(await child.evaluate(() => localStorage.getItem('sattva:ask-research:v1') || ''), /Sterlite|Portfolio source was read/);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  outage = true;
  await input.fill('Do I have Sterlite in my portfolio?');
  await research.getByRole('button', { name: 'Send question' }).click();
  await research.getByText('The shared workbook store could not be checked.', { exact: false }).waitFor({ timeout: 45_000 });
  assert.equal(questions.length, 1, 'an outage must not send old private facts to Research');

  const standalone = await context.newPage();
  standalone.on('pageerror', e => errors.push(e.message));
  await standalone.goto('http://localhost:8080');
  await standalone.getByRole('link', { name: 'Open with portfolio' }).waitFor();
  await standalone.getByRole('textbox', { name: 'Ask about the dashboard' }).fill('Do I have Sterlite in my portfolio?');
  await standalone.getByRole('button', { name: 'Send question' }).click();
  await standalone.getByText('This question needs your full portfolio.', { exact: false }).waitFor();
  assert.equal(questions.length, 1, 'standalone portfolio questions never reach a model');
  assert.deepEqual(errors, []);
  console.log('Portfolio UI: real Family readers → Research evidence, dates, memory-only history, outage refusal and standalone refusal passed. No production API calls.');
} finally { await context.close(); await browser.close(); }
