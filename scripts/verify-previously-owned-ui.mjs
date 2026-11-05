// The Watchlist scope's two lists in the real app (GLOW-OWNED): Current portfolio | Watchlist ▾ |
// Universe, the Bookmarked / Previously owned menu, a scoped table narrowed to the chosen list, the
// choice surviving a reload, and the read-only Previously owned view. Serves public/ itself; every
// other origin is refused, so nothing here depends on the network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright'}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const book = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'), 'utf8'));
const previous = book.previouslyOwned.entries;
const previousTickers = new Set(previous.map((e) => e.ticker).filter(Boolean));
const heldTickers = new Set(book.holdings.map((h) => h.ticker).filter(Boolean));
assert.ok(previousTickers.size > 10, 'the shipped list carries previously owned companies');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  res.setHeader('cache-control', 'no-store');
  if (path.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.writeHead(404).end('{"ok":false}'); return; }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
  try {
    res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failures += 1; };

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    const type = route.request().resourceType();
    return route.fulfill({ contentType: type === 'script' ? 'text/javascript' : type === 'stylesheet' ? 'text/css' : 'application/json', body: ['script', 'stylesheet'].includes(type) ? '' : '{}' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const segment = (value) => page.locator(`#scope-toggle-mount [data-value="${value}"]`);
  const rowKeys = () => page.$$eval('#content-host tbody tr[data-row-key]', (trs) => trs.map((tr) => tr.dataset.rowKey));

  await page.goto(`${origin}/#/research/breakouts/momentum-scanner?scope=portfolio`);
  await segment('portfolio').waitFor();
  check('the Portfolio scope reads "Current portfolio"', (await segment('portfolio').innerText()).trim() === 'Current portfolio');
  check('Watchlist carries a menu', (await segment('watchlist').getAttribute('aria-haspopup')) === 'menu');
  const widths = await page.$$eval('#scope-toggle-mount [data-value]', (bs) => bs.map((b) => [b.scrollWidth, b.clientWidth]));
  check('no scope label overflows its segment', widths.every(([s, c]) => s <= c + 1), JSON.stringify(widths));

  // Pressing Watchlist switches to it (Bookmarked by default) and opens the list menu.
  await segment('watchlist').click();
  await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [data-value="watchlist"]')?.getAttribute('aria-pressed') === 'true');
  await page.locator('[data-watch-list-menu]').waitFor();
  const options = await page.$$eval('[data-watch-list]', (bs) => bs.map((b) => ({ id: b.dataset.watchList, checked: b.getAttribute('aria-checked'), count: b.querySelector('[data-watch-list-count]')?.textContent })));
  check('the menu offers Bookmarked and Previously owned', JSON.stringify(options.map((o) => o.id)) === '["bookmarked","previous"]', JSON.stringify(options));
  check('Bookmarked is the default', options[0]?.checked === 'true');
  check('Previously owned shows its count', Number(options[1]?.count) === previous.length, JSON.stringify(options[1]));
  check('the segment names the chosen list', (await segment('watchlist').innerText()).trim() === 'Bookmarked');
  check('focus moves into the menu', await page.evaluate(() => !!document.activeElement?.closest('[data-watch-list-menu]')));
  await page.keyboard.press('Escape');
  check('Escape closes the menu', (await page.locator('[data-watch-list-menu]').count()) === 0);
  check('the bookmarked list empty-state still offers Add', (await page.locator('[data-watchlist-add]').count()) === 1);

  // Choose Previously owned.
  await segment('watchlist').click();
  await page.locator('[data-watch-list="previous"]').click();
  await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [data-value="watchlist"]')?.innerText.trim() === 'Previously owned');
  check('the menu closes on a choice', (await page.locator('[data-watch-list-menu]').count()) === 0);
  check('the scope stays Watchlist in the URL', /scope=watchlist/.test(page.url()));
  await page.waitForFunction(() => document.querySelectorAll('#content-host tbody tr[data-row-key]').length > 0, null, { timeout: 30000 });
  const keys = await rowKeys();
  check('a scoped table narrows to previously owned companies', keys.length > 0 && keys.every((k) => previousTickers.has(k)), keys.filter((k) => !previousTickers.has(k)).slice(0, 5).join(', '));
  check('no company held now is on it', keys.every((k) => !heldTickers.has(k)));

  // The choice survives a reload, on this device.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [data-value="watchlist"]')?.innerText.trim() === 'Previously owned');
  // Pressing the active segment reopens the menu, with Previously owned checked.
  await segment('watchlist').click();
  await page.locator('[data-watch-list-menu]').waitFor();
  check('the menu reopens on the chosen list', (await page.locator('[data-watch-list="previous"]').getAttribute('aria-checked')) === 'true');
  await page.keyboard.press('Escape');
  check('the chosen list is remembered across a reload', (await page.evaluate(() => localStorage.getItem('glow:watch-list:v1'))) === 'previous');

  // The eye opens the read-only list with last-held dates.
  const edit = page.locator('[data-scope-edit]');
  check('the scope button views rather than edits', /View previously owned/.test(await edit.getAttribute('aria-label')));
  await edit.click();
  await page.locator('[data-scope-editor="previous"]').waitFor();
  const view = await page.locator('[data-scope-editor="previous"]').innerText();
  check('the view counts the list', view.includes(`${previous.length} PREVIOUSLY OWNED`) || view.includes(`${previous.length} previously owned`), view.slice(0, 200));
  check('every line carries its last-held date', (await page.locator('[data-previous-member] [data-last-held]').count()) === previous.length);
  check('nothing on the view can be removed', (await page.locator('[data-scope-editor="previous"] [data-scope-remove]').count()) === 0);
  await page.locator('[data-scope-editor="previous"] [data-scope-search]').fill(previous[0].name.split(' ')[0]);
  check('the view searches', (await page.locator('[data-previous-member]').count()) >= 1);
  await page.keyboard.press('Escape');

  // Back to Bookmarked from the menu; Current portfolio is unchanged by any of it.
  await segment('watchlist').click();
  await page.locator('[data-watch-list="bookmarked"]').click();
  await page.waitForFunction(() => document.querySelector('#scope-toggle-mount [data-value="watchlist"]')?.innerText.trim() === 'Bookmarked');
  check('Bookmarked comes back', (await page.locator('[data-watchlist-add]').count()) === 1);
  await segment('portfolio').click();
  await page.waitForFunction(() => document.querySelectorAll('#content-host tbody tr[data-row-key]').length > 0, null, { timeout: 30000 });
  check('the segment reads Watchlist again off the scope', (await segment('watchlist').innerText()).trim() === 'Watchlist');
  const portfolioKeys = await rowKeys();
  check('Current portfolio lists only companies held now', portfolioKeys.every((k) => heldTickers.has(k) || !previousTickers.has(k)));

  // Phone width: the toggle and the menu fit without a sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await segment('watchlist').click();
  await page.locator('[data-watch-list-menu]').waitFor();
  const fit = await page.evaluate(() => {
    const r = document.querySelector('[data-watch-list-menu]').getBoundingClientRect();
    return { scroll: document.documentElement.scrollWidth, width: innerWidth, left: r.left, right: r.right };
  });
  check('the menu fits a phone', fit.scroll <= fit.width && fit.left >= 0 && fit.right <= fit.width, JSON.stringify(fit));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await context.close();
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('PASS previously owned UI');
