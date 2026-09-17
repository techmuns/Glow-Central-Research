#!/usr/bin/env node
// THE NEWSLETTER CONTROL, DRIVEN THROUGH THE REAL UI AGAINST THE REAL ROUTE AND STORE.
//
// The fixture server serves public/ and answers /api/newsletter* by calling `handleNewsletter`
// itself — the same function the Worker runs — over a `NewsletterStore` on node:sqlite and a
// `NewsletterSchedule` whose fetcher answers Yahoo, NSE and the email endpoint from fixtures. So
// this exercises the whole path (button → panel → route → store → schedule → email request) with
// no wrangler, no egress and no second copy of the rules that could drift from the deployed one.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { NewsletterStore, NEWSLETTER_OBJECT } from '../worker/newsletter-store.mjs';
import { NewsletterSchedule, EMAIL_SEND_URL } from '../worker/newsletter-schedule.mjs';
import { handleNewsletter } from '../worker/newsletter.mjs';

const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const { chromium } = await import(`${PW_ROOT}/index.mjs`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const fixture = (name) => readFileSync(new URL(`./fixtures/newsletter/${name}`, import.meta.url), 'utf8');

// ---- the stand-in Worker ---------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
const kv = new Map();
let alarm = null;
let tail = Promise.resolve();
const storage = {
  sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
  transactionSync: (fn) => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } },
  get: async (key) => structuredClone(kv.get(key)),
  put: async (key, value) => { kv.set(key, structuredClone(value)); },
  getAlarm: async () => alarm,
  setAlarm: async (value) => { alarm = value; },
  deleteAlarm: async () => { alarm = null; },
  transaction(fn) { const result = tail.then(() => fn(storage)); tail = result.catch(() => {}); return result; },
};
const emails = [];
const fetcher = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('https://query1.finance.yahoo.com/')) return new Response(fixture('yahoo-sp500.json'), { headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://nsearchives.nseindia.com/')) return new Response(fixture('nse-announcements.xml'), { headers: { 'content-type': 'application/xml' } });
  if (url === EMAIL_SEND_URL) {
    const body = JSON.parse(init.body);
    emails.push({ to: body.email, subject: body.subject, html: body.html, hasText: body.text !== undefined, auth: init.headers.authorization });
    return Response.json({ data: { message: 'Email sent successfully!' }, message: '', success: true });
  }
  throw new Error(`unexpected upstream ${url}`);
};
const assets = { fetch: async (request) => { const path = new URL(request.url).pathname; try { return new Response(readFileSync(resolve(root, `.${path}`)), { headers: { 'content-type': 'application/json' } }); } catch { return new Response('', { status: 404 }); } } };
let tokenConfigured = true;
const envFor = () => ({ ASSETS: assets, ...(tokenConfigured ? { MUNS_TOKEN: 'team-token' } : {}), DASHBOARD_ORIGIN: 'https://example.test' });
const store = new NewsletterStore(storage);
const schedule = () => new NewsletterSchedule(storage, envFor(), store, { fetcher });
// The object surface the route talks to, exactly as capture-registry-object.mjs exposes it.
const object = {
  newsletterSnapshot: () => store.snapshot(),
  newsletterStatus: async () => { await schedule().arm(); return schedule().status(); },
  newsletterApply: async ({ intents = null, settings = null } = {}) => {
    const out = { outcomes: [], settingsChanged: false };
    if (settings) out.settingsChanged = store.setSettings(settings).changed;
    if (intents) out.outcomes = store.apply(intents).outcomes;
    await schedule().arm();
    return { ...out, snapshot: store.snapshot(), schedule: await schedule().status() };
  },
  newsletterSend: (input, token) => schedule().sendNow(input, token),
  newsletterPreview: (input) => schedule().preview(input),
};
let offline = false;
let mode = 'worker'; // worker | static
const env = () => ({ ...envFor(), NEWSLETTER: { getByName: (name) => { assert.equal(name, NEWSLETTER_OBJECT); return object; } }, NEWSLETTER_LIMITER: { limit: async () => ({ success: true }) } });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/newsletter')) {
    if (mode === 'static') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>not found</html>'); return; }
    if (offline) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":false,"reason":"newsletter-unavailable"}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    try {
      const response = await handleNewsletter(request, env());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      // A throw here would leave the browser waiting for ever; name it and answer.
      console.error('  fixture route failed:', error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false,"reason":"fixture-error"}');
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false}'); return; }
  const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(file)] || 'text/html');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
let checks = 0;
const ok = (name, pass, detail = '') => { checks++; if (!pass) failures++; console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/#/research/insider-trades?scope=portfolio`);
  const button = () => page.locator('[data-brief-button]');
  const panel = () => page.getByRole('dialog', { name: 'Newsletter', exact: true });
  await button().waitFor();

  console.log('\n— the button —');
  const placement = await page.evaluate(() => {
    const b = document.querySelector('[data-brief-button]');
    const bell = document.querySelector('[data-notification-bell]');
    const bookmarks = document.querySelector('[data-header-bookmarks]');
    return {
      inHeader: !!b.closest('[data-app-header]'),
      leftOfBell: b.getBoundingClientRect().right <= bell.getBoundingClientRect().left && b.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING,
      rightOfBookmarks: bookmarks.getBoundingClientRect().right <= b.getBoundingClientRect().left,
      label: b.textContent.trim(),
      height: b.getBoundingClientRect().height,
    };
  });
  ok('one Newsletter button in the header, immediately left of the bell', placement.inHeader && placement.leftOfBell && placement.rightOfBookmarks, JSON.stringify(placement));
  ok('...labelled Newsletter, with no dot before anything has been read', placement.label === 'Newsletter' && !(await page.locator('[data-brief-dot]').isVisible()));
  ok('...and it fetched nothing on page load', (await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/newsletter')).length)) === 0);

  console.log('\n— the panel —');
  await button().click();
  await panel().waitFor();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('opens on the reader\'s own subscription form, opaque over the page', await panel().evaluate((n) => /^rgb\(/.test(getComputedStyle(n).backgroundColor)));
  ok('...names the next scheduled send in IST', /Next: (Morning|Evening) brief, \w{3} \d+ \w{3}, \d\d:\d\d IST/.test(await page.locator('[data-brief-next]').innerText()), await page.locator('[data-brief-next]').innerText());
  await page.keyboard.press('Escape');
  ok('Escape closes it and returns focus to the button', !(await panel().isVisible()) && (await button().evaluate((n) => n === document.activeElement)));

  console.log('\n— subscribing —');
  await button().click();
  await page.locator('[data-brief-form="me"] input[name="email"]').fill('Pratik@Muns.io');
  await page.locator('[data-brief-form="me"] input[name="by"]').fill('Pratik');
  await page.locator('[data-brief-form="me"] button[type="submit"]').click();
  await page.locator('.brief-you').waitFor().catch(async (error) => { console.error('  panel said:', await page.locator('.brief-body').innerText()); throw error; });
  ok('subscribing shows "You\'re subscribed" with the normalised address', (await page.locator('.brief-you').innerText()).includes('pratik@muns.io'));
  ok('...the button now carries the subscribed dot', await page.locator('[data-brief-dot]').isVisible());
  ok('...and the store holds one attributed row', store.snapshot().subscribers[0]?.addedBy === 'Pratik' && store.snapshot().count === 1);
  ok('...with the alarm armed for the next weekday send', alarm != null);
  await page.locator('[data-brief-my-edition][value="evening"]').uncheck();
  await page.waitForFunction(() => document.querySelector('.brief-note')?.textContent.includes('Updated which briefs'));
  ok('unticking the evening brief updates only that address\'s editions', JSON.stringify(store.snapshot().subscribers[0].editions) === '["morning"]');

  console.log('\n— the team —');
  await page.locator('[data-brief-form="add"] input[name="email"]').fill('meera@muns.io');
  await page.locator('[data-brief-form="add"] button[type="submit"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.brief-row')].some((r) => r.textContent.includes('meera@muns.io')));
  ok('adding a colleague lists them under Team, attributed to this device\'s name', (await page.locator('.brief-row', { hasText: 'meera@muns.io' }).innerText()).includes('added by Pratik'));
  ok('...and the count reads 2 of 100', (await page.locator('.brief-count').innerText()) === '2 of 100');

  console.log('\n— sending —');
  await page.locator('[data-brief-edition-select]').selectOption('morning');
  await page.locator('[data-brief-action="send-test"]').click();
  await page.waitForFunction(() => document.querySelector('.brief-note')?.textContent.includes('Test copy'));
  ok('"Send me a copy" posts exactly one html email to the reader', emails.length === 1 && emails[0].to === 'pratik@muns.io' && emails[0].html && !emails[0].hasText, JSON.stringify(emails.map((e) => e.to)));
  ok('...as a Glow Ventures broadsheet with the portfolio subject', emails[0].html.includes('GLOW VENTURES') && !emails[0].html.includes('MUNSHOT') && /^Glow Ventures · \d+ updates? on your portfolio companies/.test(emails[0].subject), emails[0].subject);
  ok('...marked as a test copy in its footer', emails[0].html.includes('This is a test copy you asked for.'));
  await page.locator('[data-brief-action="send-all"]').click();
  ok('"Send to everyone" asks first, naming how many will get it', (await page.locator('.brief-confirm').innerText()).includes('2 addresses'), 'pratik is morning-only and meera gets both');
  await page.locator('[data-brief-action="send-all-cancel"]').click();
  ok('...and Cancel sends nothing', emails.length === 1 && !(await page.locator('.brief-confirm').isVisible()));
  await page.locator('[data-brief-edition-select]').selectOption('evening');
  await page.locator('[data-brief-action="send-all"]').click();
  await page.locator('[data-brief-action="send-all-confirm"]').click();
  await page.waitForFunction(() => document.querySelector('.brief-note')?.textContent.includes('sent to'));
  ok('confirming sends the evening brief to its one subscriber', emails.length === 2 && emails[1].to === 'meera@muns.io' && emails[1].auth === 'Bearer team-token');
  ok('...and the send appears under Recent sends', (await page.locator('.brief-log').innerText()).includes('sent to 1 of 1'));
  const [preview] = await Promise.all([context.waitForEvent('page'), page.locator('[data-brief-action="preview"]').click()]);
  await preview.waitForLoadState();
  ok('Preview opens the edition as it would send now, in a new tab', /Glow Ventures · \d+ updates?/.test(await preview.title()) && (await preview.locator('body').innerText()).includes('GLOW VENTURES'));
  await preview.close();

  console.log('\n— the schedule —');
  await page.locator('[data-brief-form="schedule"] input[name="time-morning"]').fill('07:30');
  await page.locator('[data-brief-form="schedule"] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('.brief-note')?.textContent.includes('Schedule saved'));
  ok('saving a send time changes the desk-wide schedule and re-arms the alarm', store.settings().morning.time === '07:30' && alarm != null);
  ok('...and the panel prints the new time on the edition', (await page.locator('.brief-check-row').first().innerText()).includes('Morning 07:30 IST'));

  console.log('\n— states —');
  await page.keyboard.press('Escape');
  tokenConfigured = false;
  await button().click();
  await page.locator('.brief-warn').waitFor();
  ok('with no token on the Worker the panel names the secret and says the buttons still work with the session', (await page.locator('.brief-warn').innerText()).includes('MUNS_TOKEN'));
  tokenConfigured = true;
  await page.keyboard.press('Escape');
  await page.locator('[data-brief-action="unsubscribe-me"]').waitFor({ state: 'hidden' }).catch(() => {});
  await button().click();
  await page.locator('[data-brief-action="unsubscribe-me"]').click();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('Unsubscribe returns the reader to the form and clears the dot', !(await page.locator('[data-brief-dot]').isVisible()) && store.snapshot().count === 1);
  await page.keyboard.press('Escape');
  offline = true;
  await button().click();
  await page.locator('.brief-empty').waitFor();
  ok('an unreachable service is named as such, with a retry', (await page.locator('.brief-empty').innerText()).includes("Couldn't reach") && (await page.locator('[data-brief-action="retry"]').count()) === 1);
  offline = false;
  await page.locator('[data-brief-action="retry"]').click();
  await page.locator('[data-brief-form="me"]').waitFor();
  ok('...and retrying recovers', true);
  await page.keyboard.press('Escape');
  mode = 'static';
  await page.reload();
  await button().waitFor();
  await button().click();
  await page.locator('.brief-empty').waitFor();
  ok('a static origin says the newsletter is not part of this deployment — never an error', (await page.locator('.brief-empty').innerText()).includes("isn't part of this deployment"));
  mode = 'worker';
  await page.keyboard.press('Escape');

  console.log('\n— unsubscribe link, appearance, small screens —');
  await page.goto(`${base}/#/research/insider-trades?scope=portfolio&newsletter=manage`);
  await panel().waitFor();
  ok('the email\'s Unsubscribe link (?newsletter=manage) opens straight onto the panel', await panel().isVisible());
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sattvaTheme.toggle());
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  const dark = await panel().evaluate((n) => getComputedStyle(n).backgroundColor);
  ok('the dark panel paints an opaque dark surface', /^rgb\(/.test(dark) && dark !== 'rgb(255, 255, 255)', dark);
  await page.screenshot({ path: '/tmp/glow-newsletter-dark.png' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sattvaTheme.toggle());
  await page.setViewportSize({ width: 390, height: 844 });
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  const bounds = await panel().boundingBox();
  ok('on a phone the panel stays inside the viewport and the page does not scroll sideways',
    bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845 && (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)), JSON.stringify(bounds));
  ok('...and the button is a 44px touch target', (await button().boundingBox()).height >= 44);
  await page.screenshot({ path: '/tmp/glow-newsletter-mobile.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await button().click();
  await page.locator('[data-brief-form="me"]').waitFor();
  await page.screenshot({ path: '/tmp/glow-newsletter-desktop.png' });

  ok('zero page errors throughout', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${checks - failures} of ${checks} passed`);
if (failures) process.exit(1);
