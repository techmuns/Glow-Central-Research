// Exercises the actual Family edge login using an isolated fixture password.
// No production credentials, cookies, data APIs or model requests are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const fixturePassword = 'local-portfolio-auth-fixture';
const fixtureHash = createHash('sha256').update(`sattva-family-office::pw::v1\n${fixturePassword}`).digest('hex');
const source = readFileSync(`${process.env.FAMILY_REPO || '../Sattva-Family-alert-sizes'}/functions/_middleware.js`, 'utf8')
  .replace(/const PASSWORD_HASH = "[a-f0-9]+";/, `const PASSWORD_HASH = "${fixtureHash}";`)
  .replaceAll('https://sattva-central-research.tech-441.workers.dev', 'http://localhost:8080');
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext();
let modelRequests = 0;
await context.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.fulfill({ status: 503, body: 'External network disabled' });
  if (url.port === '5173') {
    let authenticated = false;
    const response = await onRequest({ request: new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), ...(req.postData() ? { body: req.postData() } : {}) }), next: () => { authenticated = true; return new Response(null); } });
    if (!authenticated) return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  }
  if (url.port === '8080' && url.pathname === '/api/research') {
    if (req.method() === 'POST') modelRequests++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true }) });
  }
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, body: 'Test API unavailable' });
  return route.continue();
});
try {
  const page = await context.newPage();
  await page.goto('http://localhost:8080/#/research/ask-research?scope=portfolio');
  const unlock = page.getByRole('button', { name: 'Unlock portfolio' });
  await unlock.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0, 'sign-in does not interrupt initial viewing');
  await page.getByRole('textbox', { name: 'Ask about the dashboard' }).fill('What changed in the market?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await page.getByText('Unlock your portfolio above to answer with your holdings.', { exact: false }).waitFor();
  assert.equal(modelRequests, 0, 'even a generic question cannot silently omit holdings');
  await unlock.click();
  const login = page.frameLocator('iframe[title="Private portfolio connection"]');
  await login.getByLabel('Enter password to continue').fill('wrong-fixture-password');
  await login.getByRole('button', { name: 'Connect portfolio' }).click();
  await login.getByText('Incorrect password', { exact: false }).waitFor();
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  await login.getByLabel('Enter password to continue').fill(fixturePassword);
  await login.getByRole('button', { name: 'Connect portfolio' }).click();
  await page.getByText('Portfolio connected · refreshed with every question').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('iframe[title="Private portfolio connection"]').isVisible(), false);
  assert.equal(await page.getByRole('textbox', { name: 'Ask about the dashboard' }).inputValue(), 'What changed in the market?', 'unlocking preserves the unsent question');
  assert.equal(new URL(page.url()).port, '8080', 'Research remains the visible workspace');
  assert.equal(modelRequests, 0, 'unlocking never resubmits a question automatically');
  console.log('Portfolio sign-in UI: hidden by default, exact-origin auth state, missing-access refusal, wrong-password refusal, inline unlock and automatic close passed.');
} finally { await context.close(); await browser.close(); }
