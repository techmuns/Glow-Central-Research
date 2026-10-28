// AI Alerts' Compact view in a real browser: the default layout, the Compact | Detailed switch and
// its memory, one row per company with the source behind it, broker reports listed on demand,
// nothing that Compact leaves out, phone width and the dark theme. Local fixture only — no
// production reads, no AI requests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(`${process.env.PLAYWRIGHT_ROOT}/index.mjs`);
const root = resolve('public');

const html = `<!doctype html><html><head><script src="/js/theme-init.js"></script><link rel="stylesheet" href="/css/tailwind.css"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/glow.css"></head>
<body><main id="root" style="padding:24px;max-width:1400px;margin:auto"></main><script type="module">
import * as tab from '/js/tabs/ai-alerts.js';
import * as coverage from '/js/data/coverage.js';
coverage.prime({ holdings: ['TAPE','RESULTCO','BROKERCO','AAA','BBB','MEETCO'].map(ticker => ({ ticker, name: ticker + ' Limited' })) });
window.show = (scope = 'portfolio') => { tab.destroy(); tab.render({ root: document.querySelector('#root'), scope, params: {} }); };
window.show(); window.ready = true;
</script></body></html>`;

// The collector, replaced: every event the tab ranks, in the shapes the real feeds produce.
const feedModule = `
import { currentDay } from '../ui/ai-alert-utils.js';
import { ATTRIBUTION_VERSION } from './company-news-attribution.js';
export { currentDay as today } from '../ui/ai-alert-utils.js';
const listeners = new Set(); export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export async function readCachedAlertWindow() { return null; }
export async function collect({ scope }) {
  const day = currentDay(); let n = 0;
  const ev = (ticker, feed, headline, extra = {}) => ({ id: feed + ':' + ticker + ':' + (++n), ticker, company: ticker + ' Limited', feed, feedLabel: feed,
    headline, detail: '', day, time: '10:' + String(10 + n).padStart(2, '0'), importance: 'high', direction: 'neutral', aiEligible: true,
    url: 'https://example.test/' + ticker + '/' + n, signalReason: 'fixture', importanceReason: 'fixture', ...extra });
  const broker = (ticker, r) => ev(ticker, 'broker-reports', r.broker + ' report', { url: 'https://t.me/researchreportss/' + (900 + n), kind: 'broker-report',
    brokerReport: { id: String(n), ticker, kind: 'view', publishedAt: day + 'T05:00:00.000Z', url: 'https://t.me/researchreportss/' + (900 + n), ...r } });
  const confirmed = { version: ATTRIBUTION_VERSION, status: 'confirmed' };
  const events = [
    ev('TAPE', 'technicals', 'Rose 6.2% at the close', { kind: 'move', movePct: 6.2, direction: 'positive' }),
    ev('RESULTCO', 'earnings', 'YOY quarterly result filed', { resultBasis: 'YOY', metrics: { netProfit: { label: 'Net Profit', kind: 'normal', pct: 21 }, revenue: { label: 'Revenue', kind: 'normal', pct: 16 } }, direction: 'positive' }),
    ev('RESULTCO', 'announcements', 'Unaudited Financial Results for the quarter ended September 30, 2026', { filingSubject: 'Unaudited Financial Results for the quarter ended September 30, 2026', filingSubCategory: 'Financial Results', url: 'https://www.bseindia.com/result.pdf' }),
    ev('RESULTCO', 'news', 'RESULTCO Q2 FY27 results: net profit rises 21%', { namesCompany: true, attribution: confirmed }),
    ev('BROKERCO', 'chatter', 'Bullish public chatter (30d snapshot)', { direction: 'positive' }),
    broker('BROKERCO', { broker: 'Antique', rating: 'BUY', stance: 'bullish', target: 1755, points: 'Margins in-line, PAT beat on lower opex' }),
    broker('BROKERCO', { broker: 'Axis Securities', upsidePct: 34, points: 'Consistent Outperformance Merits a Premium' }),
    broker('BROKERCO', { broker: 'Centrum', upsidePct: 29 }),
    broker('BROKERCO', { broker: 'PL Capital', upsidePct: -8, points: 'Strong Q2' }),
    ev('AAA', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
    ev('BBB', 'announcements', 'Award of order worth ₹500 crore', { filingSubject: 'Award of order worth ₹500 crore', url: 'https://example.test/shared-story' }),
    ev('BBB', 'insider', 'Promoter — Buy', { tradeCategory: 'Block deal', direction: 'positive' }),
    broker('BBB', { broker: 'Nuvama', upsidePct: 12, points: 'Order book visibility' }),
    ev('MEETCO', 'announcements', 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results', { filingSubject: 'Board Meeting Intimation for Consideration And Approval Of Unaudited Financial Results' }),
  ];
  const feeds = [...new Set(events.map(e => e.feed))].map(id => ({ id, label: id, status: 'ok', reachesToday: true }));
  return { scope, day, events, feeds, pending: 0 };
}`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('cache-control', 'no-cache');
  try {
    if (path === '/' || path === '/index.html') { res.setHeader('content-type', 'text/html'); return res.end(html); }
    if (path === '/js/data/holding-sizes.js') { res.setHeader('content-type', 'text/javascript'); return res.end('export const cachedHoldingSizes=()=>null;export const readHoldingSizes=()=>Promise.resolve(null);'); }
    if (path.startsWith('/api/')) { res.writeHead(503); return res.end('{}'); }
    const file = resolve(root, '.' + path); if (!file.startsWith(root + sep)) throw Error();
    const body = path === '/js/data/daily-alerts.js' ? feedModule : readFileSync(file);
    res.setHeader('content-type', { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404); res.end('{}'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ...options });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ status: 503, body: '{}' })));
  return { context, page };
};
const rows = (page) => page.locator('[data-ai-compact-row]');
const row = (page, ticker) => page.locator(`[data-ai-compact-row][data-ticker="${ticker}"]`);

try {
  const { context, page } = await open();
  await page.goto(origin);
  await page.waitForSelector('[data-ai-compact-row]');

  // Compact is the default, and the switch says so.
  assert.equal(await page.locator('[data-ai-card]').count(), 0, 'Compact is the default layout');
  assert.equal(await page.locator('[data-ai-view="compact"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-ai-view="detailed"]').getAttribute('aria-pressed'), 'false');

  // One row per company; what Compact leaves out is not drawn, and the pill says how many.
  const tickers = await rows(page).evaluateAll((nodes) => nodes.map((n) => n.dataset.ticker));
  assert.equal(new Set(tickers).size, tickers.length, 'one row per company');
  assert(!tickers.includes('TAPE'), 'a price-and-volume only company is left to Detailed');
  assert(!tickers.includes('MEETCO'), 'a board-meeting intimation is a date');
  const pillTitle = await page.locator('[data-ai-feed-status] [title]').first().getAttribute('title');
  assert.match(pillTitle, /Compact shows the Detailed alerts filtered/);
  assert.match(pillTitle, /2 companies have nothing else and appear only in Detailed/);
  assert.match(await page.locator('.ai-alert-count').textContent(), /4\s+companies/);

  // A result is one row and opens the company's own filing, in a new tab.
  const result = row(page, 'RESULTCO');
  assert.equal(await result.getAttribute('data-kind'), 'result');
  assert.match(await result.locator('.ai-compact-text').textContent(), /net profit \+21\.0%, revenue \+16\.0%/);
  const link = result.locator('a.ai-compact-hit');
  assert.equal(await link.getAttribute('href'), 'https://www.bseindia.com/result.pdf');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await result.locator('[data-ai-mcap]').count(), 1, 'a market cap cell on every row');
  // The whole row is the control: the link's overlay covers the row.
  const box = await result.boundingBox();
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a, button')?.className || '', { x: box.x + box.width * 0.6, y: box.y + box.height / 2 });
  assert.match(hit, /ai-compact-hit/, 'a click anywhere on the row opens its source');

  // A story tagged to two companies leads one row; the second leads with its own item.
  const shared = await rows(page).locator('a.ai-compact-hit[href="https://example.test/shared-story"]').count();
  assert.equal(shared, 1, 'a story leads one row');

  // Broker views: the row lists every report on demand, each linking to its post.
  const brokerRow = row(page, 'BROKERCO');
  assert.equal(await brokerRow.getAttribute('data-kind'), 'broker', 'four broker reports lead over a chatter snapshot');
  assert.match(await brokerRow.locator('.ai-compact-text').textContent(), /4 broker reports in 14 days\. Antique rates it BUY with a ₹1,755 target; (?:Axis Securities and Centrum|Centrum and Axis Securities) see 29–34% upside; PL Capital sees 8% downside\./);
  assert.equal(await brokerRow.locator('.ai-compact-reports').isVisible(), false, 'reports are closed until asked for');
  await brokerRow.locator('button.ai-compact-hit').click();
  await brokerRow.locator('.ai-compact-reports').waitFor({ state: 'visible' });
  assert.equal(await brokerRow.locator('button.ai-compact-hit').getAttribute('aria-expanded'), 'true');
  const reports = await brokerRow.locator('.ai-compact-report').evaluateAll((nodes) => nodes.map((n) => [n.querySelector('.ai-compact-report-broker').textContent, n.getAttribute('href'), n.getAttribute('target')]));
  assert.equal(reports.length, 4);
  assert(reports.every(([, href, target]) => href.startsWith('https://t.me/researchreportss/') && target === '_blank'), 'each report links to its own post');
  assert.equal(await brokerRow.locator('.ai-compact-stance').first().textContent(), 'BUY', 'a stance only where the broker printed a rating');
  // A secondary broker line on a row led by something else.
  const bbb = row(page, 'BBB');
  await bbb.locator('button.ai-compact-brokers').click();
  assert.equal(await bbb.locator('.ai-compact-report').count(), 1);

  // Nothing Compact leaves out leaks into the text, and every line is within sixty words.
  for (const text of await page.locator('.ai-compact-text').allTextContents()) {
    assert(!/RSI|check both directions below/i.test(text), text);
    assert(text.trim().split(/\s+/).length <= 63, `sixty words: ${text}`);
  }

  // The switch: Detailed draws today's cards, and the choice survives a reload.
  await page.locator('[data-ai-view="detailed"]').click();
  await page.waitForSelector('[data-ai-card]');
  assert.equal(await page.locator('[data-ai-compact]').count(), 0);
  assert(await page.locator('[data-ai-card][data-ticker="TAPE"]').count() === 1, 'Detailed still shows what Compact leaves out');
  assert.equal(await page.evaluate(() => localStorage.getItem('glow:ai-alerts:layout:v1')), 'detailed');
  await page.reload();
  await page.waitForSelector('[data-ai-card]');
  assert.equal(await page.locator('[data-ai-view="detailed"]').getAttribute('aria-pressed'), 'true', 'the reader\'s layout is remembered');
  await page.locator('[data-ai-view="compact"]').click();
  await page.waitForSelector('[data-ai-compact-row]');

  // Keyboard: the row's control takes focus and shows it.
  await page.locator('[data-ai-compact-row] .ai-compact-hit').first().focus();
  assert(await page.evaluate(() => document.activeElement?.matches('.ai-compact-hit:focus-visible') || document.activeElement?.classList.contains('ai-compact-hit')));
  await context.close();

  // Phone width and the dark theme.
  const phone = await open({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await phone.page.goto(origin);
  await phone.page.waitForSelector('[data-ai-compact-row]');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert(overflow <= 1, `no sideways page scroll at 390px (${overflow}px)`);
  assert.equal(await phone.page.locator('.ai-compact-head').isVisible(), false, 'the column header gives way on a phone');
  // Dark theme: the row's own text is light on the dark surface, not the light theme's ink.
  const luminance = await phone.page.evaluate(() => {
    const lum = (c) => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
    return { name: lum(getComputedStyle(document.querySelector('.ai-compact-name')).color), cmp: lum(getComputedStyle(document.querySelector('.ai-compact-cmp-value')).color),
      surface: lum(getComputedStyle(document.querySelector('.ai-compact')).backgroundColor) };
  });
  assert(luminance.name - luminance.surface > 0.4 && luminance.cmp - luminance.surface > 0.4, `readable in the dark theme (${JSON.stringify(luminance)})`);
  await phone.context.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS AI Alerts Compact UI: default layout and remembered switch, ${tickers.length} rows, results opened at the filing, broker reports listed on demand, nothing left out leaks, phone width and dark theme`);
} finally {
  await browser.close();
  server.close();
}
