#!/usr/bin/env node
// scripts/verify-ui.mjs — the pre-push verification pass, as a script.
//
//   python3 -m http.server 8080 -d public
//   node scripts/verify-ui.mjs                     # defaults to http://localhost:8080
//   node scripts/verify-ui.mjs http://localhost:3000
//
// Walks CLAUDE.md's verification checklist plus the Earnings Hub specifics, and exits non-zero
// on the first failure so it can gate a push. Prints one PASS/FAIL line per check.
//
// This is a dev script, not part of the app — it uses the system Playwright (see PW_ROOT
// below) rather than adding an npm dependency, exactly as scrape-technicals.mjs uses none.
//
// SANDBOX NOTE: headless Chromium here cannot reach cdn.tailwindcss.com or Google Fonts
// (the agent proxy only accepts CONNECT). Layout checks still pass because they measure
// scrollWidth, not typography, but screenshots will be unstyled. To shoot styled captures,
// copy public/ to a scratch dir, curl the CDN assets into it, repoint index.html at the local
// copies and serve that — and never commit that rewrite.

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({ chromium } = await import(`${PW_ROOT}/index.mjs`));
} catch {
  console.error(`Could not load Playwright from ${PW_ROOT}.`);
  console.error('Set PLAYWRIGHT_ROOT to your install, e.g. PLAYWRIGHT_ROOT=$(npm root -g)/playwright');
  process.exit(2);
}

let failures = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--test-type'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.stack || e).slice(0, 400)}`));

// Scope persists to localStorage by design, so any check that assumes the full universe
// must say so in the URL rather than inherit whatever the previous navigation left behind.
const go = async (hash, settle = 900) => {
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(settle);
};
const hostText = () => page.locator('#content-host').innerText();
const rowCount = () => page.locator('tr[data-row-key]').count();
const SEARCH = '#content-host input[type="search"], #content-host input[placeholder*="Search"]';

// ---------------------------------------------------------------------------------------
// 1. Every route in both scopes renders a real panel
// ---------------------------------------------------------------------------------------
console.log('\n— shell and routing —');
await go('/#/', 1300);

const routes = await page.evaluate(async () => {
  const REGISTRY = {
    research: ['tabs/earnings-hub.js', 'tabs/concall.js', 'tabs/public-chatter.js', 'tabs/breakouts.js', 'tabs/super-investors.js'],
    portfolio: ['portfolio/overview.js', 'portfolio/position-by.js', 'portfolio/transactions.js', 'portfolio/drawdown.js'],
  };
  const out = [];
  for (const [ws, files] of Object.entries(REGISTRY)) {
    for (const f of files) {
      const m = await import(`/js/${f}`);
      const subs = (m.meta?.subviews || []).map((s) => s.id);
      for (const s of subs.length ? subs : [null]) out.push([ws, m.meta.id, s]);
    }
  }
  return out;
});

let broken = [];
for (const [ws, tab, sub] of routes) {
  for (const scope of ['universe', 'portfolio']) {
    const hash = `/#/${ws}/${tab}${sub ? `/${sub}` : ''}?scope=${scope}`;
    await go(hash, 620);
    const txt = await hostText();
    if (/hit a snag/i.test(txt) || txt.trim().length < 120) broken.push(hash);
  }
}
ok(`all ${routes.length} routes render in both scopes`, broken.length === 0, broken.slice(0, 4).join(', '));

// URL + history
await go('/#/research/earnings-hub/result-scans');
ok('hash reflects the route', page.url().includes('earnings-hub/result-scans'));
await page.goBack();
await page.waitForTimeout(600);
ok('browser back navigates', !page.url().includes('result-scans'));

// ---------------------------------------------------------------------------------------
// 2. Earnings Hub — the three sub-views
// ---------------------------------------------------------------------------------------
console.log('\n— earnings hub —');
await go('/#/research/earnings-hub/latest-results?scope=universe');
const latestRows = await rowCount();
ok('Latest Results renders the full set', latestRows > 0, `${latestRows} rows`);
ok('4-card stat strip with a gradient hero', /last refresh/i.test(await hostText()));
ok('upcoming-results strip', /upcoming results/i.test(await hostText()));

const beforeChip = await rowCount();
await page.locator('[data-chip-group="outcome"][data-chip-id="Beat"]').click();
await page.waitForTimeout(600);
const afterChip = await rowCount();
ok('chip filter narrows the set', afterChip > 0 && afterChip < beforeChip, `${beforeChip} → ${afterChip}`);
ok('chip filter is reflected in the URL', page.url().includes('tag=Beat'));
await page.locator('[data-chip-group="outcome"][data-chip-id="any"]').click();
await page.waitForTimeout(500);

await go('/#/research/earnings-hub/result-scans?scope=universe');
const scans = await page.locator('[data-scan-id]').count();
ok('built-in scans listed', scans >= 8, `${scans} scans`);
await page.locator('[data-scan-id]').nth(1).click();
await page.waitForTimeout(700);
ok('a scan filters and states its definition', /definition/i.test(await hostText()) && page.url().includes('scan='));

await go('/#/research/earnings-hub/quality-growth?scope=universe');
ok('Quality & Growth renders its charts', (await page.locator('#content-host svg').count()) > 0 && (await page.locator('#content-host table').count()) > 0);

// ---------------------------------------------------------------------------------------
// 3. Table mechanics
// ---------------------------------------------------------------------------------------
console.log('\n— table —');
await go('/#/research/earnings-hub/latest-results?scope=universe');
const full = await rowCount();
await page.locator(SEARCH).first().fill('MARICO');
await page.waitForTimeout(500);
const searched = await rowCount();
ok('search narrows the table', searched > 0 && searched < full, `${full} → ${searched}`);
await page.locator(SEARCH).first().fill('');
await page.waitForTimeout(400);

// Correctness only — no timing. The repaint is not synchronous with the click, so anything
// measured around it here reads 0ms and would be a made-up number. The sort-performance bar
// is exercised against the 535-row technicals table, not this one.
await page.locator('#content-host thead th').nth(3).click();
await page.waitForTimeout(250);
ok('header sort keeps every row', (await rowCount()) === full);

// ---------------------------------------------------------------------------------------
// 4. Drill panel
// ---------------------------------------------------------------------------------------
console.log('\n— drill —');
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(700);
const drill = await page.locator('#drill-content').innerText();
ok('drill opens from a row', drill.length > 200);
ok('drill shows all five categories', ['growth', 'margins', 'earnings quality', 'surprise', 'consistency'].every((c) => new RegExp(c, 'i').test(drill)));
ok('drill shows provenance chips', /calculation/i.test(drill) && /implementation/i.test(drill));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('ESC closes the drill', await page.locator('#drill-panel.translate-x-full, #drill-panel:not(.translate-x-0)').count() > 0);

// ---------------------------------------------------------------------------------------
// 5. Provenance — every surface that shows a synthetic number says so
// ---------------------------------------------------------------------------------------
console.log('\n— provenance —');
for (const sub of ['latest-results', 'result-scans', 'quality-growth']) {
  await go(`/#/research/earnings-hub/${sub}?scope=universe`);
  ok(`${sub}: amber ribbon present`, (await page.locator('[data-mock-ribbon]').count()) === 1);
}
await go('/#/research/earnings-hub/latest-results?scope=universe');
ok('freshness card says mock, not a filing time', /mock data/i.test(await hostText()) && /not a filing time/i.test(await hostText()));

// the drill marker must survive on a loss-maker, where a red-flag banner also renders
const openFirstMatch = async (q) => {
  await go('/#/research/earnings-hub/latest-results?scope=universe');
  await page.locator(SEARCH).first().fill(q);
  await page.waitForTimeout(600);
  if ((await rowCount()) === 0) return null;
  await page.locator('tr[data-row-key]').first().click();
  await page.waitForTimeout(700);
  return page.locator('#drill-content').innerText();
};
const lossDrill = await openFirstMatch('M & M');
if (lossDrill) {
  ok('loss-maker drill shows the red flag', /red flag/i.test(lossDrill));
  ok('loss-maker drill still shows the synthetic marker', /illustrative figures/i.test(lossDrill));
}
await page.keyboard.press('Escape');

await go('/#/research/earnings-hub/latest-results?scope=universe');
await page.locator('button:has-text("Sources")').first().click();
await page.waitForTimeout(500);
const sources = await page.locator('#modal-content').innerText();
ok('Sources modal lists earnings as mock and names the generator', /mock/i.test(sources) && /gen-mock-earnings/.test(sources));
await page.keyboard.press('Escape');

// ---------------------------------------------------------------------------------------
// 6. Export — the workbook must carry its own provenance
// ---------------------------------------------------------------------------------------
console.log('\n— export —');
await go('/#/research/earnings-hub/latest-results?scope=universe');
const download = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await page.locator('#content-host button:has-text("Export")').first().click();
const file = await download;
if (file) {
  ok('Export Excel downloads a workbook', true, file.suggestedFilename());
} else {
  // The CDN is unreachable in some sandboxes; that is a environment limit, not a regression.
  const blocked = errors.some((e) => /exceljs/i.test(e));
  ok('Export Excel downloads a workbook', false, blocked ? 'exceljs CDN unreachable from here' : 'no download fired');
}

// ---------------------------------------------------------------------------------------
// 7. Layout holds and nothing scrolls sideways
// ---------------------------------------------------------------------------------------
console.log('\n— layout —');
for (const width of [1440, 1024, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await go('/#/research/earnings-hub/quality-growth?scope=universe');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`no sideways page scroll at ${width}px`, overflow <= 0, `${overflow}px`);
}

// ---------------------------------------------------------------------------------------
console.log('\n— console —');
const unique = [...new Set(errors)];
ok('zero console errors', unique.length === 0, unique.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
