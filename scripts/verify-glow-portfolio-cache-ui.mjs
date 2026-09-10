// The real portfolio reader under a controlling service worker, including an
// already-open legacy session. All assets/data are local; inference is a fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResearchBody } from '../worker/research.mjs';
import { handleGlowPortfolio } from '../worker/glow-portfolio.mjs';

const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = fileURLToPath(new URL('../public', import.meta.url));
const holdings = JSON.parse(readFileSync(resolve(root, 'data/portfolio-companies.json'))).holdings;
const worker = readFileSync(resolve(root, 'sw.js'), 'utf8');
let upgraded = false, bookUnavailable = false, bridgeUnavailable = false, bookReads = 0;
const questions = [], errors = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'public, max-age=0, must-revalidate');
  const send = (body, type = 'text/html', status = 200) => {
    res.writeHead(status, { 'content-type': type }); res.end(body);
  };
  if (path === '/cache-fixture') return send('<!doctype html><title>Cache upgrade fixture</title>');
  if (path === '/sdk-fixture') return send('// Local SDK fixture', 'text/javascript');
  if (path === '/sw.js') {
    let body = worker.replace(/const MUNSHOT_SDK = '[^']+';/, `const MUNSHOT_SDK = '${origin}/sdk-fixture';`);
    if (!upgraded) body = body
      .replace(/(const CACHE_NAME = `\$\{CACHE_PREFIX\})[^`]+(`;)/, '$1legacy-portfolio-fixture$2')
      .replace('function cacheKey(request, url) {', 'function cacheKey(request, url) { if (request.mode === "navigate") return new Request(new URL("/index.html", self.location.origin));');
    return send(body, 'text/javascript');
  }
  // Reproduce Cloudflare's .html redirects, including background revalidation.
  if (path === '/index.html' || path === '/glow-bridge.html') {
    res.writeHead(307, { location: path === '/index.html' ? '/' : '/glow-bridge' }); res.end(); return;
  }
  if (path === '/' && !upgraded) return send('<!doctype html><title>Legacy dashboard shell</title>');
  if (path === '/glow-bridge' && bridgeUnavailable) return send('Reader unavailable', 'text/plain', 503);
  if (path === '/data/book.json') {
    bookReads++;
    if (bookUnavailable) return send('{"error":"Fixture book unavailable"}', 'application/json', 503);
  }
  if (path === '/api/family-portfolio') {
    const response = await handleGlowPortfolio(new Request(`${origin}${path}`), {
      ASSETS: { fetch: async request => new Response(readFileSync(resolve(root, `.${new URL(request.url).pathname}`))) },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); return;
  }
  if (path === '/api/research') {
    if (req.method === 'GET') return send('{"configured":true,"provider":"muns"}', 'application/json');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), validation = validateResearchBody(body);
    if (!validation.ok) return send(JSON.stringify(validation), 'application/json', validation.status);
    questions.push(body);
    res.setHeader('cache-control', 'no-store');
    return send([{ type: 'start', provider: 'muns' }, { type: 'text', text: 'Local test answer: the verified statement holdings reached research.' }, { type: 'done' }].map(event => JSON.stringify(event)).join('\n') + '\n', 'application/x-ndjson');
  }
  if (path.startsWith('/api/')) return send('{"ok":false,"error":"Local fixture unavailable"}', 'application/json', 503);
  const file = resolve(root, `.${path === '/' ? '/index.html' : path === '/glow-bridge' ? '/glow-bridge.html' : path}`);
  if (!file.startsWith(root + sep)) return send('Missing', 'text/plain', 404);
  try {
    return send(readFileSync(file), { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
  } catch { return send('Missing', 'text/plain', 404); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: 'External network disabled' }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/cache-fixture`);
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.src = '/glow-bridge.html'; document.body.append(frame);
  });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.title === 'Legacy dashboard shell');
  console.log('Reproduced: a warm legacy cache serves the dashboard instead of the portfolio reader.');
  await page.evaluate(async () => {
    document.querySelector('iframe').remove();
    const { watchWorkerChanges } = await import('/js/core/app-updates.js');
    watchWorkerChanges(navigator.serviceWorker, () => { sessionStorage.setItem('portfolio-cache-upgraded', 'yes'); location.reload(); });
  });
  upgraded = true;
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.evaluate(() => { navigator.serviceWorker.getRegistration().then(registration => registration.update()); }),
  ]);
  await page.waitForFunction(() => sessionStorage.getItem('portfolio-cache-upgraded') === 'yes' && document.title === 'Cache upgrade fixture');
  const cacheNames = await page.evaluate(() => caches.keys());
  assert(!cacheNames.some(name => name.includes('legacy-portfolio-fixture')), 'old cache is evicted during the existing-session upgrade');
  assert(cacheNames.some(name => name.includes('glow-portfolio-reader-v1')), 'the deployed release marker advances');

  // Both document spellings work after redirects and repeated revalidation.
  for (const path of ['/glow-bridge.html', '/glow-bridge', '/glow-bridge.html']) {
    await page.goto(`${origin}${path}`);
    assert.equal(await page.title(), 'Glow portfolio reader');
  }
  const cachedDocuments = await page.evaluate(async () => {
    const cache = await caches.open((await caches.keys()).find(name => name.startsWith('sattva-dashboard-')));
    return { shell: await (await cache.match('/index.html')).text(), reader: await (await cache.match('/glow-bridge.html')).text(),
      redirected: (await cache.match('/glow-bridge.html')).redirected,
      readerModule: !!await cache.match('/js/research/glow-bridge.js') };
  });
  assert(cachedDocuments.shell.includes('js/app.js'), 'reader navigation cannot overwrite the app shell');
  assert(cachedDocuments.reader.includes('/js/research/glow-bridge.js'));
  assert.equal(cachedDocuments.redirected, false, 'revalidated redirects remain safe for later navigation');
  assert(cachedDocuments.readerModule, 'the independent reader module graph is warmed');

  await page.goto(`${origin}/#/research/ask-research?scope=portfolio`);
  await page.locator('[data-portfolio-connection][data-state="connected"]').waitFor();
  const before = bookReads;
  await page.getByRole('textbox', { name: 'Ask about the dashboard' }).fill('what needs attention for my largest portfolio?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await page.getByText('Local test answer: the verified statement holdings reached research.', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(questions.length, 1);
  assert(bookReads > before, 'the question rechecks the source book');
  assert.deepEqual(questions[0].evidence.portfolioPositions.holdings.map(h => h.isin).sort(), holdings.map(h => h.isin).sort(), 'the complete real Glow holding set reaches the research request');
  assert.equal(questions[0].evidence.portfolioPositions.sizes.basis, 'statement-equity-value');
  await page.reload();
  await page.locator('[data-portfolio-connection][data-state="connected"]').waitFor();
  const reply = await page.evaluate(async () => (await import('/js/research/portfolio-bridge.js')).readResearchPortfolio('What are my largest holdings?'));
  assert.equal(reply.holdings.length, holdings.length, 'returning dashboards read every holding');
  bookUnavailable = true;
  const failure = await page.evaluate(async () => {
    try { await (await import('/js/research/portfolio-bridge.js')).readResearchPortfolio('What are my largest holdings?'); return null; }
    catch (error) { return error.message; }
  });
  assert.match(failure, /could not be verified/, 'a failed live book check cannot fall back to cached holdings');
  bookUnavailable = false;
  const recovered = await page.evaluate(async () => (await import('/js/research/portfolio-bridge.js')).readResearchPortfolio('What are my largest holdings?'));
  assert.equal(recovered.holdings.length, holdings.length);

  // A missing standalone document must not turn into another dashboard either.
  bridgeUnavailable = true;
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name); await cache.delete('/glow-bridge.html'); await cache.delete('/glow-bridge');
    }
  });
  await page.goto(`${origin}/glow-bridge`);
  assert.match(await page.locator('body').innerText(), /Reader unavailable/);
  assert.equal(await page.locator('#app').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS existing-session upgrade, redirected reader isolation, full Ask Research request (${holdings.length} holdings), repeat visits, source outage and recovery.`);
} finally { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
