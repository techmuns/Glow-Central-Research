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
let skipped = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
// For the handful of checks that need the Tailwind CDN. Marking them SKIP is honest; asserting
// them against an unstyled page would be a pass that means nothing.
const skip = (label, why) => {
  skipped++;
  console.log(`SKIP  ${label}  — ${why}`);
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
// Wait for a panel to actually finish painting rather than sleeping a magic number at it. The
// Earnings Hub fetches 1,300+ live rows on a cold load, so any fixed settle time is a race that
// gets lost the day the feed grows.
const waitForPanel = async (timeout = 8000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const [len, skeleton] = await page.evaluate(() => [
      (document.querySelector('#content-host')?.innerText || '').trim().length,
      document.querySelectorAll('#content-host .skeleton-shimmer').length,
    ]);
    if (len > 120 && !skeleton) return true;
    await page.waitForTimeout(150);
  }
  return false;
};
// Assigned in the con-call section; declared here because the chatter section uses it too.
let setHidden;
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
    await go(hash, 300);
    await waitForPanel();
    const txt = await hostText();
    if (/hit a snag/i.test(txt) || txt.trim().length < 120) broken.push(hash);
  }
}
ok(`all ${routes.length} routes render in both scopes`, broken.length === 0, broken.slice(0, 4).join(', '));

// URL + history
await go('/#/research/breakouts/strong-breakouts');
ok('hash reflects the route', page.url().includes('breakouts/strong-breakouts'));
await page.goBack();
await page.waitForTimeout(600);
ok('browser back navigates', !page.url().includes('strong-breakouts'));

// ---------------------------------------------------------------------------------------
// 2. Earnings Hub — the LIVE results feed
// ---------------------------------------------------------------------------------------
console.log('\n— earnings hub (live) —');
await go('/#/research/earnings-hub?scope=universe', 2200);
const latestRows = await rowCount();
ok('Latest Results renders the full listed universe', latestRows > 1000, `${latestRows} companies`);

const ehText = await hostText();
ok('states which quarter and which two periods', /Q\d\s*FY/i.test(ehText) && /\bvs\b/i.test(ehText));
ok('says whether it is live or a snapshot', /\bLive\b/i.test(ehText) || /snapshot/i.test(ehText));
// This tab deliberately has no stat strip and no rail: one table, one small Live button.
ok('no stat-card furniture in front of the table', (await page.locator('#content-host .stat-card').count()) === 0);
ok('a single small Live button instead', (await page.locator('[data-live-info]').count()) === 1);
ok('the sub-view rail is hidden for this single-view tab', !/Latest Results|Movers|By Industry/.test(await page.locator('#aside-content').innerText()));
// The switcher moved out of the rail and into the tab-bar row, which is what lets the rail
// disappear entirely without stranding the Portfolio Analytics workspace.
ok('...but the workspace switcher survives, in the header', /Research Central/.test(await page.locator('#workspace-mount').innerText()));
ok('...and the content spans the full width', (await page.locator('#content-host').boundingBox()).width > 1200);

// The column set: date first, then the three metrics with BOTH reported periods beside each
// growth figure, then market cap and basis.
const ehHeads = (await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase())));
ok('DATE is the first column', /^DATE/.test(ehHeads[0] || ''), ehHeads[0]);
ok('COMPANY is the second', /^COMPANY/.test(ehHeads[1] || ''), ehHeads[1]);
for (const c of ['REVENUE GROWTH', 'NET PROFIT GROWTH', 'MARKET CAP', 'BASIS']) {
  ok(`column present: ${c}`, ehHeads.some((h) => h === c));
}
// Headers are spelled out. "PAT", "REV" and "MCAP" are trade shorthand and this table is read by
// people who did not write it.
ok('headers are full words, not trade shorthand', !ehHeads.some((h) => /\b(REV|PAT|MCAP)\b/.test(h)), ehHeads.join(' | '));
// Two reported-figure columns per metric, each header naming the period it is — a bare "REVENUE"
// would leave the reader guessing which quarter the number belongs to.
for (const m of ['REVENUE', 'NET PROFIT']) {
  const cols = ehHeads.filter((h) => h.startsWith(`${m} `) && h !== `${m} GROWTH`);
  ok(`${m.toLowerCase()}: both periods are columns, each period-labelled`, cols.length === 2 && cols.every((h) => /[A-Z]{3}\s*\d{2}$/.test(h)), cols.join(' + '));
}
ok('gross profit is not a column', !ehHeads.some((h) => h.includes('GROSS')));

// The head has to stay put on a 1,300-row table. `sticky` only engages against a scrolling
// ancestor, so the wrapper must actually scroll — assert the behaviour, not the CSS. Needs real
// stylesheets: `position: sticky` comes from a Tailwind class, so on an unstyled page the head
// would scroll away for a reason that has nothing to do with this code.
const ehSticky = await page.evaluate(async () => {
  const box = document.querySelector('[data-table-scroll]');
  const head = document.querySelector('#content-host thead');
  const styled = getComputedStyle(head).position === 'sticky';
  const before = head.getBoundingClientRect().top;
  box.scrollTop = 800;
  await new Promise((r) => setTimeout(r, 250));
  return { styled, moved: Math.abs(head.getBoundingClientRect().top - before), scrolled: box.scrollTop, rowsAbove: document.querySelector('#content-host tbody tr').getBoundingClientRect().top < before };
});
ok('the table body scrolls inside its own box', ehSticky.scrolled > 0, `${ehSticky.scrolled}px`);
if (ehSticky.styled) ok('...and the column headings stay put while it does', ehSticky.moved < 2 && ehSticky.rowsAbove, `head moved ${ehSticky.moved.toFixed(1)}px`);
else skip('...and the column headings stay put while it does', 'Tailwind CDN unreachable — position:sticky never applied');
await page.evaluate(() => (document.querySelector('[data-table-scroll]').scrollTop = 0));
await page.waitForTimeout(200);
ok('the serial-number column is gone', !ehHeads.some((h) => h === '#'));
ok('TICKER is not a column...', !ehHeads.some((h) => h.includes('TICKER')));
ok('...nor INDUSTRY...', !ehHeads.some((h) => h.includes('INDUSTRY')));
ok('...nor Return Since Result', !ehHeads.some((h) => h.includes('RETURN SINCE RESULT')));
// Dropping them from the header must not drop them from the page — they moved under the name.
const ehIdent = await page.locator('#content-host tbody tr').first().innerText();
const ehSub = ehIdent.split('\n').find((l) => /[A-Z0-9&-]{2,}\s·\s\S/.test(l)) || '';
ok('ticker and industry survive under the company name', !!ehSub, ehSub || ehIdent.replace(/\s+/g, ' ').slice(0, 60));
ok('default sort is newest-first', /^DATE/.test(ehHeads[0]) && /▾/.test(ehHeads[0]));

// AND IN MONEYCONTROL'S OWN ORDER WITHIN A DATE. `resultDate` is a date; filings arrive through
// the day, and the upstream returns them newest-first at that finer granularity. An earlier
// version tie-broke on the size of the profit move, which reshuffled the top of the table so
// "latest results" showed neither the latest nor the same list Moneycontrol shows. Compare our
// rendered order against the payload's own order, which is the only thing that can catch it.
const ehOrder = await page.evaluate(async () => {
  let payload = null;
  try {
    const r = await fetch('api/earnings?subType=yoy', { cache: 'no-store' });
    if (r.ok) payload = await r.json();
  } catch {
    /* no Worker on this origin */
  }
  if (!payload?.rows?.length) {
    const r = await fetch('data/earnings-live.json', { cache: 'no-store' });
    payload = await r.json();
  }
  // Upstream order, restricted to the newest date — that is where the tie-break used to bite.
  const newest = payload.rows.reduce((a, r) => (r.resultDate > a ? r.resultDate : a), '');
  const upstream = payload.rows.filter((r) => r.resultDate === newest).map((r) => r.scId);
  const rendered = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => tr.dataset.rowKey);
  return { upstream: upstream.slice(0, 8), rendered: rendered.slice(0, 8), newest, seq: payload.rows[0]?.seq };
});
ok('rows carry the upstream sequence', ehOrder.seq === 0, `first row seq=${ehOrder.seq}`);
ok(
  "...and the table is in Moneycontrol's own order within the newest date",
  ehOrder.upstream.length > 3 && ehOrder.upstream.join(',') === ehOrder.rendered.join(','),
  `${ehOrder.newest}: ${ehOrder.rendered.slice(0, 4).join(' ')} vs upstream ${ehOrder.upstream.slice(0, 4).join(' ')}`
);

// The whole point of the wider column set was to keep it on screen. At the design width the
// table must not need its own horizontal scrollbar; the page must never scroll sideways at all.
// This one needs real CSS — an unstyled table lays out nothing like the shipped one.
const ehFit = await page.evaluate(() => {
  const box = document.querySelector('[data-table-scroll]');
  const styled = getComputedStyle(document.querySelector('[data-score-table]')).borderRadius !== '0px';
  return { need: box.scrollWidth, have: box.clientWidth, styled };
});
if (ehFit.styled) ok('the table fits at 1440 with no horizontal scrollbar', ehFit.need <= ehFit.have + 1, `${ehFit.need}px in ${ehFit.have}px`);
else skip('the table fits at 1440 with no horizontal scrollbar', 'Tailwind CDN unreachable — serve a vendored copy to measure this');

// THE RECONCILIATION. The growth column and the two figure columns are three renderings of the
// same fact, and a reader will trust the pair over the percentage. Recompute the percentage from
// the two figures actually on screen and require it to agree with the one actually on screen.
const ehRecon = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#content-host thead th')].map((t) => t.innerText.trim().toUpperCase());
  const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
  const out = { checked: 0, bad: [] };
  for (const tr of [...document.querySelectorAll('#content-host tbody tr')].slice(0, 60)) {
    const td = [...tr.children].map((c) => c.innerText.trim());
    for (const m of ['REVENUE', 'NET PROFIT']) {
      const iCur = heads.findIndex((h) => h.startsWith(`${m} `) && h !== `${m} GROWTH`);
      const iPct = heads.indexOf(`${m} GROWTH`);
      if (iCur < 0 || iPct < 0) continue;
      const cur = num(td[iCur]);
      const pri = num(td[iCur + 1]);
      const shown = td[iPct];
      if (!/^[+-]?[\d.]+%$/.test(shown)) continue; // a pill, not a percentage — checked elsewhere
      if (!Number.isFinite(cur) || !Number.isFinite(pri) || pri === 0) continue;
      out.checked++;
      const calc = ((cur - pri) / Math.abs(pri)) * 100;
      // Rounding: the figures are whole crore and the percentage is a whole number, so a small
      // integer-rounding gap is expected. A sign flip or a factor-of-two gap is not.
      if (Math.abs(calc - num(shown)) > Math.max(2, Math.abs(num(shown)) * 0.05)) {
        out.bad.push(`${td[1].replace(/\s+/g, ' ').slice(0, 32)} ${m}: ${pri}→${cur} shown ${shown}, computes ${calc.toFixed(0)}%`);
      }
    }
  }
  return out;
});
ok('the figure columns reconcile with the growth column', ehRecon.checked > 100 && ehRecon.bad.length === 0, `${ehRecon.checked} checked${ehRecon.bad.length ? ' — ' + ehRecon.bad.slice(0, 3).join('; ') : ''}`);

// The provenance did not vanish with the ribbon — it moved behind the button.
await page.locator('[data-live-info]').click();
await page.waitForTimeout(500);
const liveModal = await page.locator('#modal-content').innerText();
ok('the Live button opens the provenance', /moneycontrol/i.test(liveModal) && /polled every/i.test(liveModal));
ok('...and still states the dash rule', /not joined/i.test(liveModal));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// THE HONESTY CHECK. A percentage across a sign change is not a growth rate, and about 13% of
// companies have one. These must render as labelled pills, never as a coloured number.
ok('loss → profit renders as a pill, not a percentage', /to profit/i.test(ehText));
ok('profit → loss renders as a pill', /to loss/i.test(ehText));
ok('loss in both periods is labelled as a loss', /loss\s*[↓↑]/i.test(ehText)); // \s matches the nbsp in the pill

await page.locator('#content-host select').first().selectOption('turnaround');
await page.waitForTimeout(600);
const turnRows = await rowCount();
ok('the loss → profit filter narrows the set', turnRows > 0 && turnRows < latestRows, `${turnRows} turnarounds`);
await page.locator('#content-host select').first().selectOption('all');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 2b. YoY / QoQ — the same filing asked two different questions.
//
// This is the one control on the page that changes what every number MEANS without changing
// which quarter is on screen: the current-period figures are byte-identical between the two and
// only the comparison column moves. So the headers have to move with it, or a screenshot of the
// table is a lie about what it is measuring against.
// ---------------------------------------------------------------------------------------
console.log('\n— yoy / qoq —');
const headsNow = () => page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
const revCols = (hs) => hs.filter((h) => h.startsWith('REVENUE ') && h !== 'REVENUE GROWTH');
// Read one named company's revenue pair, whichever row it is on.
const figuresFor = (needle) =>
  page.evaluate((n) => {
    const hs = [...document.querySelectorAll('#content-host thead th')].map((t) => t.innerText.trim().toUpperCase());
    const i = hs.findIndex((h) => h.startsWith('REVENUE ') && h !== 'REVENUE GROWTH');
    for (const tr of document.querySelectorAll('#content-host tbody tr')) {
      const tds = [...tr.children].map((c) => c.innerText.trim());
      if (tds[1] && tds[1].toUpperCase().includes(n)) return { cur: tds[i], prior: tds[i + 1] };
    }
    return null;
  }, needle);

// The switch is a network round trip against the live upstream — on a cold cache that is seconds,
// not milliseconds. Wait for the toggle to actually flip (or for the tab to say it could not),
// rather than sleeping a number at it.
const waitForPeriod = async (want, timeout = 25000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const state = await page.evaluate(() => ({
      active: document.querySelector('[data-period][aria-pressed="true"]')?.dataset.period || null,
      error: /Comparison not switched/i.test(document.querySelector('#content-host')?.innerText || ''),
    }));
    if (state.active === want || state.error) return state;
    await page.waitForTimeout(250);
  }
  return { active: null, error: false };
};

ok('a YoY / QoQ toggle is present', (await page.locator('[data-period]').count()) === 2);
const yoyHeads = await headsNow();
const yoyPrior = revCols(yoyHeads)[1];
ok('YoY is the default', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'YOY');

// QoQ needs the live route. Without a Worker (a plain `python3 -m http.server`) there is nothing
// to fetch, and there is deliberately no committed QoQ snapshot to fall back to. Which of the two
// worlds we are in decides what to assert — and the no-Worker case is the more interesting test,
// because it is the one where the tab could quietly show YoY under QoQ headers and nobody would
// see it. Probe first, then assert the behaviour that world is supposed to have.
const hasLiveRoute = await page.evaluate(async () => {
  try {
    const r = await fetch('api/earnings?subType=qoq', { cache: 'no-store' });
    if (!r.ok) return false;
    return ((await r.json())?.rows?.length ?? 0) > 0;
  } catch {
    return false;
  }
});

// Pin one company so the before/after comparison is about the same filing, not about whichever
// row happened to sort first. Read the name off the table rather than hard-coding it — the
// committed snapshot and the live feed do not contain the same companies.
const pinned = await page.evaluate(() => {
  const tr = document.querySelector('#content-host tbody tr');
  return (tr?.children[1]?.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean).find((x) => x.length > 3) || '';
});
const yoyPinned = pinned ? await figuresFor(pinned.toUpperCase()) : null;

await page.locator('[data-period="qoq"]').click();
const qoqState = await waitForPeriod('qoq');

if (!hasLiveRoute) {
  // No Worker. The ONLY acceptable outcome is a refusal that says so — never YoY numbers sitting
  // under QoQ column headers, which is the one failure the page itself could not reveal.
  ok('without the live route, QoQ refuses rather than switching', qoqState.error === true && qoqState.active !== 'qoq');
  ok('...and says which comparison you are actually looking at', /Comparison not switched/i.test(await hostText()));
  ok('...and the comparison columns are untouched', revCols(await headsNow())[1] === yoyPrior, yoyPrior);
  ok('...and the toggle still reads YoY', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'YOY');
  console.log('      (QoQ round trip not exercised — no /api/earnings on this origin)');
} else {
  ok('the QoQ switch completes against the live feed', qoqState.active === 'qoq' && !qoqState.error);
  await page.waitForTimeout(400);
  const qoqHeads = await headsNow();
  const qoqPrior = revCols(qoqHeads)[1];
  ok('switching to QoQ repoints the comparison columns', !!qoqPrior && qoqPrior !== yoyPrior, `${yoyPrior} → ${qoqPrior}`);
  ok('...while the current period is unchanged', revCols(qoqHeads)[0] === revCols(yoyHeads)[0], revCols(qoqHeads)[0]);
  ok('...and the URL records it, so the view is shareable', page.url().includes('period=qoq'));
  ok('...with no bogus sub-view segment in the path', !/earnings-hub\/(null|undefined)/.test(page.url()), page.url().split('#')[1]);

  // A reload has to come back on the same comparison, not silently on the other one.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForPanel();
  await waitForPeriod('qoq');
  ok('a reload restores QoQ rather than falling back to YoY', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'QOQ');
  ok('...and the headers agree with the toggle', revCols(await headsNow())[1] === qoqPrior);

  // THE INVARIANT. Same filing, two questions: the reported current-period figure must be
  // IDENTICAL under both, and only the comparison figure may move. If the current figure moved
  // too, the toggle would be switching quarters rather than switching comparisons — and because
  // the columns look the same either way, nothing else on the page would reveal it.
  const qoqPinned = pinned ? await figuresFor(pinned.toUpperCase()) : null;
  ok('the same filing keeps its current-period figure under both comparisons', !!yoyPinned && !!qoqPinned && yoyPinned.cur === qoqPinned.cur, `${pinned}: ${yoyPinned?.cur} both ways`);
  ok('...and only the comparison figure moves', !!yoyPinned && !!qoqPinned && yoyPinned.prior !== qoqPinned.prior, `${yoyPinned?.prior} (YoY) vs ${qoqPinned?.prior} (QoQ)`);

  await page.locator('[data-period="yoy"]').click();
  await waitForPeriod('yoy');
  await page.waitForTimeout(400);
  ok('switching back to YoY restores the year-ago comparison', revCols(await headsNow())[1] === yoyPrior);
  ok('...and drops period=qoq from the URL', !/period=qoq/.test(page.url()), page.url().split('?')[1] || '');
}

// ---------------------------------------------------------------------------------------
// 2c. Earnings Calendar — the forward-looking half of the tab.
//
// The honesty check here is the one that matters: the per-date COUNT is complete (a clean JSON
// API) while the company LIST is the twenty largest by market cap (the page cannot be paged past).
// Twenty rows under a bare heading would assert that twenty companies report. The table must name
// both numbers.
// ---------------------------------------------------------------------------------------
console.log('\n— earnings calendar —');
await go('/#/research/earnings-hub?scope=universe', 800);
await waitForPanel();
ok('the tab offers Reported / Calendar', (await page.locator('[data-view]').count()) === 2);

await page.locator('[data-view="calendar"]').click();
// The calendar is a live round trip with no snapshot fallback, so wait for the strip or the
// failure panel rather than a fixed sleep.
const calReady = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const st = await page.evaluate(() => ({
      chips: document.querySelectorAll('[data-date]').length,
      failed: /could not be loaded/i.test(document.querySelector('#content-host')?.innerText || ''),
      rows: document.querySelectorAll('tr[data-row-key]').length,
    }));
    if ((st.chips && st.rows) || st.failed) return st;
    await page.waitForTimeout(300);
  }
  return { chips: 0, failed: false, rows: 0 };
})();

if (calReady.failed) {
  // No Worker on this origin. The view must say so, not draw an empty calendar.
  ok('without the live route, the calendar says so', /could not be loaded/i.test(await hostText()));
  ok('...and explains why there is no offline copy', /claim about the future|stale/i.test(await hostText()));
  console.log('      (calendar round trip not exercised — no /api/earnings-calendar on this origin)');
  // Everything after this section reads the results table, so go back to it either way.
  await page.locator('[data-view="reported"]').click();
  await waitForPanel();
} else {
  ok('the calendar renders a date strip with counts', calReady.chips > 5, `${calReady.chips} dates`);
  ok('...and the URL records the view', page.url().includes('view=calendar'));
  const calHeads = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
  for (const c of ['DATE', 'COMPANY', 'QUARTER', 'TIME', 'PRICE', 'MARKET CAP']) {
    ok(`calendar column: ${c}`, calHeads.some((h) => h.startsWith(c)), calHeads.join(' | '));
  }

  // THE CHECK THIS VIEW EXISTS TO PASS.
  const calHonesty = await page.evaluate(() => {
    const txt = document.querySelector('#content-host').innerText;
    const m = /([\d,]+)\s+companies report on this date/.exec(txt);
    return { total: m ? Number(m[1].replace(/,/g, '')) : null, rows: document.querySelectorAll('tr[data-row-key]').length, saysCap: /largest by market cap/i.test(txt) };
  });
  ok('the calendar states the complete count for the date', calHonesty.total > 0, `${calHonesty.total} scheduled`);

  // The list is read live where the calendar page answers this server and comes from the committed
  // capture where it does not (Akamai). Either is fine; showing captured rows under a "Live" pill
  // would not be. Whichever state we are in, the pill and the note must agree with the payload.
  // Read the payload the page already holds rather than refetching — no second request, and no
  // chance of asking about a different date than the one on screen.
  const calSource = await page.evaluate(async () => {
    const mod = await import('/js/data/earnings-calendar.js');
    const shown = mod.strip().map((d) => d.date).find((d) => mod.forDate(d));
    const payload = shown ? mod.forDate(shown) : null;
    const txt = document.querySelector('#content-host').innerText;
    return { src: payload?.listSource ?? null, pill: /\b(Live|Captured|Partial)\b/.exec(txt)?.[1] || null, saysCapture: /names below are a capture/i.test(txt) };
  });
  if (calSource.src === 'snapshot') {
    ok('a captured list is labelled Captured, not Live', calSource.pill === 'Captured' && calSource.saysCapture);
  } else if (calSource.src === 'live') {
    ok('a live list is labelled Live and claims no capture', calSource.pill === 'Live' && !calSource.saysCapture);
  } else {
    ok('the payload names where the list came from', false, `listSource=${calSource.src}`);
  }
  ok(
    '...and says the list is a top-N when it is one',
    calHonesty.rows >= calHonesty.total || calHonesty.saysCap,
    `${calHonesty.rows} named of ${calHonesty.total}`
  );

  // Clicking another date must change both the data and the URL.
  const otherDate = await page.evaluate(() => {
    const active = document.querySelector('[data-date][aria-pressed], [data-date]');
    const all = [...document.querySelectorAll('[data-date]:not([disabled])')].map((b) => b.dataset.date);
    void active;
    return all[all.length - 1];
  });
  await page.locator(`[data-date="${otherDate}"]`).click();
  await page.waitForTimeout(6000);
  ok('picking a date reloads that day and records it in the URL', page.url().includes(`date=${otherDate}`), otherDate);

  // Back to reported, which is where the rest of the suite expects to be.
  await page.locator('[data-view="reported"]').click();
  await waitForPanel();
  ok('switching back to Reported restores the results table', (await rowCount()) > 1000);
}

// ---------------------------------------------------------------------------------------
// 3. Table mechanics
// ---------------------------------------------------------------------------------------
console.log('\n— table —');
const full = await rowCount();
await page.locator(SEARCH).first().fill('TITAN');
await page.waitForTimeout(500);
const searched = await rowCount();
ok('search narrows the table', searched > 0 && searched < full, `${full} → ${searched}`);
await page.locator(SEARCH).first().fill('');
await page.waitForTimeout(400);
// Re-read immediately before the click. This runs against a LIVE feed, so a company filing
// between the two reads would otherwise fail a sort assertion for a reason that is not the sort.
const beforeSort = await rowCount();
await page.locator('#content-host thead th').nth(3).click();
await page.waitForTimeout(300);
ok('header sort keeps every row', (await rowCount()) === beforeSort, `${beforeSort} rows`);

// The two filter dropdowns are independent questions and must AND together.
const selCount = await page.locator('#content-host select').count();
ok('there are two filter dropdowns', selCount === 2, `${selCount} selects`);
const preBasis = await rowCount();
await page.locator('#content-host select').nth(1).selectOption('std');
await page.waitForTimeout(500);
const stdOnly = await rowCount();
await page.locator('#content-host select').nth(1).selectOption('con');
await page.waitForTimeout(500);
const conOnly = await rowCount();
ok('standalone + consolidated partition the set exactly', stdOnly > 0 && conOnly > 0 && stdOnly + conOnly === preBasis, `${stdOnly} STD + ${conOnly} CON = ${preBasis}`);
ok('...and the rows actually carry that basis, spelled out', /Consolidated/.test(await page.locator('#content-host tbody tr').first().innerText()));
// AND, not OR: narrowing the other dropdown on top of this one must narrow further.
await page.locator('#content-host select').first().selectOption('pat-up');
await page.waitForTimeout(500);
const bothFilters = await rowCount();
ok('the two dropdowns combine rather than replace each other', bothFilters > 0 && bothFilters < conOnly, `${conOnly} CON → ${bothFilters} CON with PAT up`);
await page.locator('#content-host select').first().selectOption('all');
await page.locator('#content-host select').nth(1).selectOption('all');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 4. Drill panel
//
// The Earnings Hub deliberately has none: once both reported periods became columns, the drill
// was restating the row you clicked on. So the check here is the opposite of everywhere else —
// clicking a row must do NOTHING, and the row must not advertise itself as clickable.
// ---------------------------------------------------------------------------------------
console.log('\n— drill —');
const ehRow = page.locator('tr[data-row-key]').first();
ok('earnings rows are not styled as clickable', !((await ehRow.getAttribute('class')) || '').includes('cursor-pointer'));
await ehRow.click();
await page.waitForTimeout(600);
const ehDrillOpen = await page.evaluate(() => {
  const d = document.getElementById('drill-panel');
  return !!d && d.classList.contains('translate-x-0');
});
ok('...and clicking one opens no drill', !ehDrillOpen);
// The provenance the drill used to carry has to still be reachable, or this is just deletion.
// It lives behind the Live pill — verified above — which is one click from anywhere on the page.
ok('...because the provenance moved to the Live pill', (await page.locator('[data-live-info]').count()) === 1);

// The drill itself still has to work where it IS used. Breakouts is the reference consumer: a
// scored row with per-rule provenance behind it.
await go('/#/research/breakouts/technical-scanner?scope=universe', 2000);
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(700);
const drill = await page.locator('#drill-content').innerText();
ok('drill opens from a row', drill.length > 200);
ok('drill shows the scored rules', /moving average|trend|momentum/i.test(drill));
ok('drill carries per-rule provenance', /source|calculation/i.test(drill));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('ESC closes the drill', (await page.locator('#drill-panel.translate-x-full, #drill-panel:not(.translate-x-0)').count()) > 0);
await go('/#/research/earnings-hub?scope=universe', 1800);

// ---------------------------------------------------------------------------------------
// 5. Provenance and the other two sub-views
// ---------------------------------------------------------------------------------------
console.log('\n— provenance —');
await go('/#/research/earnings-hub?scope=universe', 1800);
ok('the tab renders without a sub-view in the URL', (await rowCount()) > 1000);
// The coverage note and the roadmap card were removed from this tab deliberately — one table,
// nothing under it. The dash rule they carried lives in the Live pill's modal, checked above.
ok('no roadmap placeholder under the table', !/wiring roadmap/i.test(await hostText()));
ok('...and no coverage paragraph either', !/resolved to an NSE ticker/i.test(await hostText()));

await page.locator('button:has-text("Sources")').first().click();
await page.waitForTimeout(600);
const sources = await page.locator('#modal-content').innerText();
ok('Sources modal lists the live Moneycontrol feed', /moneycontrol/i.test(sources) && /rapid results/i.test(sources));
ok('...and still labels the remaining mock earnings set', /gen-mock-earnings/.test(sources));
await page.keyboard.press('Escape');

// ---------------------------------------------------------------------------------------
// 6. Export — the workbook must carry its own provenance
// ---------------------------------------------------------------------------------------
console.log('\n— export —');
await go('/#/research/earnings-hub?scope=universe');
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
// 7. Con-call — the live ticker, the keyword engine and the Deep Dive
// ---------------------------------------------------------------------------------------
console.log('\n— con-call: live feed —');
page.on('dialog', (d) => d.accept()); // the editor's delete / reset confirmations

await go('/#/research/concall/live-feed?scope=universe', 2200);
const tickerNodes = () => page.locator('[data-ticker] > div').count();
const kwCounters = () => page.evaluate(() => [...document.querySelectorAll('[data-live-kw-n]')].reduce((s, e) => s + (+e.textContent || 0), 0));

ok('live cards render', (await page.locator('[data-live-card]').count()) > 0, `${await page.locator('[data-live-card]').count()} on air`);
const n0 = await tickerNodes();
const k0 = await kwCounters();
const e0 = await page.locator('[data-elapsed]').first().innerText();
await page.waitForTimeout(11000); // ~2 ticks at 5s
const n1 = await tickerNodes();
const k1 = await kwCounters();
ok('ticker appends segments across ticks', n1 > n0, `${n0} → ${n1}`);
ok('elapsed clock advances', (await page.locator('[data-elapsed]').first().innerText()) !== e0);
ok('keyword counters increment as hits stream in', k1 >= k0 && k1 > 0, `${k0} → ${k1}`);

// The poller must pause when the tab is not visible, and stop when the tab unmounts.
setHidden = (hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
await setHidden(true);
const nHidden = await tickerNodes();
await page.waitForTimeout(11000);
ok('poller pauses while the document is hidden', (await tickerNodes()) === nHidden, `${nHidden} unchanged over 11s`);
await setHidden(false);
await page.waitForTimeout(3000);
ok('poller resumes when the document is visible again', (await tickerNodes()) > nHidden);

await go('/#/research/earnings-hub?scope=universe');
const stopped = await page.evaluate(async () => {
  const live = await import('/js/core/live.js');
  const before = live.getLastTick('concall-live');
  await new Promise((r) => setTimeout(r, 9000));
  return before === live.getLastTick('concall-live');
});
ok('poller stops on unmount', stopped);

console.log('\n— con-call: keyword engine —');
await go('/#/research/concall/keyword-scan?scope=universe', 1800);
const colCount = () => page.locator('[data-matrix] thead th').count();
const grandTotal = () => page.evaluate(() => [...document.querySelectorAll('[data-matrix-row]')].reduce((s, r) => s + (parseInt(r.children[2]?.innerText, 10) || 0), 0));

const cols0 = await colCount();
const total0 = await grandTotal();
ok('keyword matrix renders', (await page.locator('[data-matrix-row]').count()) > 0, `${await page.locator('[data-matrix-row]').count()} rows × ${cols0} cols`);

const stickiness = await page.evaluate(() => {
  const th = document.querySelector('[data-matrix] thead th');
  const td = document.querySelector('[data-matrix-row] td');
  const box = document.querySelector('[data-matrix]').closest('.overflow-x-auto');
  return {
    sticky: getComputedStyle(th).position === 'sticky' && getComputedStyle(td).position === 'sticky',
    scrollsInside: box.scrollWidth > box.clientWidth,
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
ok('company column is sticky', stickiness.sticky);
ok('matrix scrolls inside its own container', stickiness.scrollsInside);
ok('...and the page does not scroll sideways', stickiness.page <= 0, `${stickiness.page}px`);

// Adding a keyword must add a column and change the counts, with no reload.
await page.locator('[data-open-keyword-editor]').first().click();
await page.waitForTimeout(600);
await page.locator('[data-kw-add]').click();
await page.waitForTimeout(400);
const kwRows = await page.locator('[data-kw-row]').count();
await page.locator(`[data-kw-label="${kwRows - 1}"]`).fill('Working capital');
await page.locator(`[data-kw-terms="${kwRows - 1}"]`).fill('working capital, receivables');
await page.locator('[data-kw-save]').click();
await page.waitForTimeout(1200);
ok('adding a keyword adds its column immediately', (await colCount()) === cols0 + 1, `${cols0} → ${await colCount()}`);
ok('...and every count is recomputed', (await grandTotal()) > total0, `${total0} → ${await grandTotal()} mentions`);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
ok('keyword edits survive a reload', /working capital/i.test(await page.locator('[data-matrix] thead').innerText()));

await page.locator('[data-open-keyword-editor]').first().click();
await page.waitForTimeout(600);
await page.locator(`[data-kw-delete="${(await page.locator('[data-kw-row]').count()) - 1}"]`).click();
await page.waitForTimeout(900);
await page.locator('[data-modal-close]').first().click();
await page.waitForTimeout(900);
ok('deleting a keyword removes its column', (await colCount()) === cols0);

// The proof that scanning is genuinely runtime: narrowing the alias list must lose hits.
const capexTotal = () =>
  page.evaluate(() => {
    const i = [...document.querySelectorAll('[data-matrix] thead th')].findIndex((th) => /capex/i.test(th.textContent));
    return [...document.querySelectorAll('[data-matrix-row]')].reduce((s, r) => s + (parseInt(r.children[i]?.innerText, 10) || 0), 0);
  });
await page.locator('[data-open-keyword-editor]').first().click();
await page.waitForTimeout(500);
await page.locator('[data-kw-terms="0"]').fill('capex');
await page.locator('[data-kw-save]').click();
await page.waitForTimeout(1200);
const narrow = await capexTotal();
await page.locator('[data-open-keyword-editor]').first().click();
await page.waitForTimeout(500);
await page.locator('[data-kw-terms="0"]').fill('capex, capital expenditure, capital outlay, capital spend');
await page.locator('[data-kw-save]').click();
await page.waitForTimeout(1200);
ok('aliases genuinely widen the match', (await capexTotal()) > narrow, `1 term = ${narrow} hits, 4 terms = ${await capexTotal()}`);

await page.locator('[data-open-keyword-editor]').first().click();
await page.waitForTimeout(500);
await page.locator('[data-kw-reset]').click();
await page.waitForTimeout(800);
await page.locator('[data-modal-close]').first().click();
await page.waitForTimeout(800);

console.log('\n— con-call: deep dive —');
const wsOpen = () => page.locator('#workspace-overlay.is-open').count();

// Entry point 1 — the tab-header launcher.
await go('/#/research/concall/keyword-scan?scope=universe', 1800);
await page.locator('[data-dd-launch]').click();
await page.waitForTimeout(900);
ok('opens from the tab header', (await wsOpen()) === 1);
ok('URL carries the company and view', /deepdive=/.test(page.url()) && /view=/.test(page.url()));

// All six internal views must render.
for (const view of ['summary', 'comparison', 'transcript', 'qna', 'keywords', 'catalysts']) {
  await page.locator(`[data-ws-tab="${view}"]`).click();
  await page.waitForTimeout(700);
  const txt = await page.locator('#workspace-content').innerText();
  ok(`deep dive view renders: ${view}`, txt.length > 300 && !/hit a snag/i.test(txt));
}

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2400);
ok('deep dive survives a reload', (await wsOpen()) === 1);
ok('...on the same internal view', (await page.locator('[data-ws-tab="catalysts"]').getAttribute('aria-selected')) === 'true');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
ok('ESC closes the deep dive', (await wsOpen()) === 0);
ok('...and clears its URL params', !/deepdive=/.test(page.url()));

// Entry point 2 — a keyword-scan row.
await page.locator('[data-matrix-row]').first().click();
await page.waitForTimeout(900);
ok('opens from a Keyword Scan row', (await wsOpen()) === 1);

// Transcript search, highlighting and jump-to-next.
await page.locator('[data-ws-tab="transcript"]').click();
await page.waitForTimeout(800);
ok('transcript highlights tracked keywords', (await page.locator('#workspace-content mark[data-kw]').count()) > 0);
ok('transcript has a keyword mini-map', (await page.locator('#workspace-content [data-jump-seg]').count()) > 0);
const segsAll = await page.locator('#workspace-content [data-seg]').count();
await page.locator('[data-tr-search]').fill('capex');
await page.waitForTimeout(700);
const segsHit = await page.locator('#workspace-content [data-seg]:not(.hidden)').count();
ok('transcript search filters segments', segsHit > 0 && segsHit < segsAll, `${segsAll} → ${segsHit}`);
await page.locator('[data-tr-next]').click();
await page.waitForTimeout(500);
ok('jump-to-next-mention works', /of/.test(await page.locator('[data-tr-count]').innerText()));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Entry point 3 — a catalyst row.
await go('/#/research/concall/catalysts?scope=universe', 1600);
await page.locator('tr[data-row-key] [data-deepdive]').first().click();
await page.waitForTimeout(900);
ok('opens from a catalyst row', (await wsOpen()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Entry point 4 — a live feed card.
await go('/#/research/concall/live-feed?scope=universe', 2200);
await page.locator('[data-live-card] [data-deepdive]').first().click();
await page.waitForTimeout(900);
ok('opens from a Live Feed card', (await wsOpen()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// A company with only one call must say so, not render a diff of zeroes.
const solo = await page.evaluate(async () => {
  const cc = await import('/js/data/concalls.js');
  await cc.load();
  return cc.companies().find((c) => c.hasTranscript && !c.previous?.transcript?.length)?.ticker || null;
});
if (solo) {
  await go(`/#/research/concall/keyword-scan?scope=universe&deepdive=${solo}&view=comparison`, 2200);
  const txt = await page.locator('#workspace-content').innerText();
  ok('comparison degrades cleanly for a single-call company', /only one call on record/i.test(txt), solo);
  ok('...and draws no delta chart', (await page.locator('#workspace-content svg').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
} else {
  ok('comparison degrades cleanly for a single-call company', false, 'no single-call company in the data set to test with');
}

// Con-call provenance.
for (const sub of ['live-feed', 'keyword-scan', 'catalysts', 'deep-dive']) {
  await go(`/#/research/concall/${sub}?scope=universe`, 1500);
  ok(`con-call ${sub}: amber ribbon present`, (await page.locator('[data-mock-ribbon]').count()) === 1);
}
ok('con-call ribbon flags the fictional people', /fictional/i.test(await hostText()));

// ---------------------------------------------------------------------------------------
// 8. Public Chatter — pump risk, the technicals join, and the quadrant
// ---------------------------------------------------------------------------------------
console.log('\n— public chatter —');

for (const sub of ['valuepickr', 'telegram', 'trending']) {
  await go(`/#/research/public-chatter/${sub}?scope=universe`, 2000);
  const txt = await hostText();
  ok(`chatter ${sub} renders`, txt.length > 400 && !/hit a snag/i.test(txt));
  ok(`chatter ${sub}: amber ribbon`, (await page.locator('[data-mock-ribbon]').count()) === 1);
}
ok('chatter ribbon flags fictional handles', /fictional/i.test(await hostText()));

// Pump risk: the flag has to compute across levels and show its reasons.
await go('/#/research/public-chatter/telegram?scope=universe', 1800);
const riskLevels = await page.evaluate(async () => {
  const c = await import('/js/data/chatter.js');
  await c.load();
  const dist = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const g of c.groups()) dist[g.risk.level]++;
  return dist;
});
ok('pump risk spans more than one level', Object.values(riskLevels).filter((n) => n > 0).length >= 3, JSON.stringify(riskLevels));
ok('a quiet group cannot be flagged', await page.evaluate(async () => {
  const c = await import('/js/data/chatter.js');
  await c.load();
  // Every group that failed the volume gate must be level 0, whatever its other ratios say.
  return c.groups().filter((g) => !g.risk.gate.fired).every((g) => g.risk.level === 0);
}));

await page.locator('[data-tg-filter="risk"][data-tg-value="flagged"]').click();
await page.waitForTimeout(700);
const flaggedRows = await rowCount();
ok('filter to flagged groups', flaggedRows > 0, `${flaggedRows} at level 2+`);
ok('chatter filter is reflected in the URL', page.url().includes('risk=flagged'));
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(700);
const riskDrill = await page.locator('#drill-content').innerText();
ok('pump-risk drill lists every criterion', ['volume burst', 'few senders', 'forwarded', 'uniformly bullish'].every((t) => new RegExp(t, 'i').test(riskDrill)));
ok('...with the measured values, not just a verdict', /messages in 24h/i.test(riskDrill) && /distinct senders/i.test(riskDrill));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// The Trending join must pull REAL technical scores, and the quadrant must be clickable.
await go('/#/research/public-chatter/trending?scope=universe', 2200);
const joinCheck = await page.evaluate(async () => {
  const [t, c] = await Promise.all([import('/js/data/technicals.js'), import('/js/data/chatter.js')]);
  await Promise.all([t.load(), c.load()]);
  const rows = c.trending();
  const joined = rows.filter((r) => t.byTicker(r.ticker) && !t.byTicker(r.ticker).tickerError);
  const sample = joined[0] ? t.byTicker(joined[0].ticker) : null;
  return { total: rows.length, joined: joined.length, sampleScore: sample ? `${sample.totalPoints}/${sample.totalMax}` : null };
});
ok('trending joins the real technicals feed', joinCheck.joined > 0, `${joinCheck.joined}/${joinCheck.total} joined, e.g. ${joinCheck.sampleScore}`);
ok('quadrant plots points', (await page.locator('[data-quad-point]').count()) > 0, `${await page.locator('[data-quad-point]').count()} points`);
await page.locator('[data-quad-point]').first().click();
await page.waitForTimeout(800);
ok('quadrant point opens the technicals drill', (await page.locator('#drill-content').innerText()).length > 200);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('trending states which axis is real', /real/i.test(await hostText()) && /synthetic/i.test(await hostText()));

// The chatter poller: arrivals, pause on hidden, stop on unmount.
await go('/#/research/public-chatter/valuepickr?scope=universe', 2000);
const arrivals = () => page.evaluate(async () => (await import('/js/data/chatter.js')).totalArrivals());
const c0 = await arrivals();
await page.waitForTimeout(18000);
ok('chatter poller delivers arrivals', (await arrivals()) > c0, `${c0} → ${await arrivals()}`);
await setHidden(true);
const cHidden = await arrivals();
await page.waitForTimeout(18000);
ok('chatter poller pauses while hidden', (await arrivals()) === cHidden, `${cHidden} unchanged`);
await setHidden(false);
await page.waitForTimeout(3000);
await go('/#/research/earnings-hub?scope=universe');
ok('chatter poller stops on unmount', await page.evaluate(async () => {
  const live = await import('/js/core/live.js');
  const before = live.getLastTick('chatter-live');
  await new Promise((r) => setTimeout(r, 11000));
  return before === live.getLastTick('chatter-live');
}));

// ---------------------------------------------------------------------------------------
// 9. Super Investors — the workspace, the heatmap and the flow charts
// ---------------------------------------------------------------------------------------
console.log('\n— super investors —');

for (const sub of ['superstar-investors', 'institutions', 'fund-flows']) {
  await go(`/#/research/super-investors/${sub}?scope=universe`, 2200);
  const txt = await hostText();
  ok(`investors ${sub} renders`, txt.length > 400 && !/hit a snag/i.test(txt));
  ok(`investors ${sub}: attribution ribbon`, (await page.locator('[data-mock-ribbon]').count()) === 1);
}
ok('ribbon says the names are real and the holdings are not', /names are real/i.test(await hostText()) && /synthetic/i.test(await hostText()));
ok('ribbon names the real sources', /ticker finology/i.test(await hostText()) && /trendlyne/i.test(await hostText()) && /amfi/i.test(await hostText()));

// The positions must reconcile internally — qtyDelta against the quantities beside it.
ok('holdings arithmetic reconciles', await page.evaluate(async () => {
  const inv = await import('/js/data/investors.js');
  const qs = inv.meta().quarters.slice().reverse();
  for (const h of inv.holders()) {
    for (const [, list] of h.byTicker) {
      const sorted = list.slice().sort((a, b) => qs.indexOf(a.quarter) - qs.indexOf(b.quarter));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].qtyDelta !== sorted[i].qty - sorted[i - 1].qty) return false;
      }
    }
  }
  return true;
}));

// Fund Flows charts, including sign handling.
await go('/#/research/super-investors/fund-flows?scope=universe', 2600);
ok('flows charts render', (await page.locator('#content-host svg').count()) >= 5, `${await page.locator('#content-host svg').count()} charts`);
ok('flows data contains both signs', await page.evaluate(async () => {
  const inv = await import('/js/data/investors.js');
  const m = inv.flows();
  return m.some((x) => x.fiiNetCr < 0) && m.some((x) => x.fiiNetCr > 0);
}));
ok('flows chart draws bars on both sides of zero', await page.evaluate(() => {
  const svg = document.querySelector('#content-host svg');
  const zero = [...svg.querySelectorAll('line')].map((l) => +l.getAttribute('y1')).sort((a, b) => a - b);
  const rects = [...svg.querySelectorAll('rect')];
  if (!rects.length || !zero.length) return false;
  const mid = zero[Math.floor(zero.length / 2)];
  return rects.some((r) => +r.getAttribute('y') < mid) && rects.some((r) => +r.getAttribute('y') >= mid - 1);
}));
ok('institutional table joins the real ownership fields', (await page.locator('[data-open-tech]').count()) > 0, `${await page.locator('[data-open-tech]').count()} rows`);
await page.locator('[data-open-tech]').first().click();
await page.waitForTimeout(800);
ok('...and cross-links to the technicals drill', (await page.locator('#drill-content').innerText()).length > 200);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Overlap heatmap.
ok('overlap heatmap renders', (await page.locator('[data-heatmap]').count()) === 1);
const heatCells = await page.locator('[data-heatmap] [data-open-holder]').count();
ok('heatmap has populated cells', heatCells > 0, `${heatCells} cells`);
await page.locator('[data-heatmap] [data-open-holder]').first().click();
await page.waitForTimeout(900);
ok('heatmap cell opens the investor workspace', (await page.locator('#workspace-overlay.is-open').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// The workspace, from a card and from a row, with all four views.
await go('/#/research/super-investors/superstar-investors?scope=universe', 2000);
ok('investor cards render', (await page.locator('[data-holder-card]').count()) === 8, `${await page.locator('[data-holder-card]').count()} cards`);
await page.locator('[data-holder-card] [data-open-holder]').first().click();
await page.waitForTimeout(900);
ok('workspace opens from an investor card', (await page.locator('#workspace-overlay.is-open').count()) === 1);
ok('workspace URL carries holder and view', /holder=/.test(page.url()) && /hview=/.test(page.url()));
for (const view of ['portfolio', 'activity', 'history', 'overlap']) {
  await page.locator(`[data-ws-tab="${view}"]`).click();
  await page.waitForTimeout(700);
  const txt = await page.locator('#workspace-content').innerText();
  ok(`workspace view renders: ${view}`, txt.length > 200 && !/hit a snag/i.test(txt));
  ok(`  ...${view} carries the attribution banner`, (await page.locator('#workspace-content [data-attribution]').count()) === 1);
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2600);
ok('investor workspace survives a reload', (await page.locator('#workspace-overlay.is-open').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
ok('ESC closes it and clears the URL', (await page.locator('#workspace-overlay.is-open').count()) === 0 && !/holder=/.test(page.url()));
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(900);
ok('workspace opens from a moves row', (await page.locator('#workspace-overlay.is-open').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 10. Scope and exports on both new tabs
// ---------------------------------------------------------------------------------------
console.log('\n— scope and exports —');
await go('/#/research/public-chatter/trending?scope=portfolio', 2000);
ok('chatter portfolio scope narrows and labels', /Portfolio/.test(await hostText()));
ok('...and lists holdings with no chatter rather than dropping them', /no chatter tracked/i.test(await hostText()));
await go('/#/research/super-investors/superstar-investors?scope=portfolio', 2000);
ok('investors portfolio scope labels', /Portfolio/.test(await hostText()));
ok('...and marks holders with no overlap', /none of your holdings/i.test(await hostText()) || /of your holdings/i.test(await hostText()));

for (const [hash, label] of [
  ['/#/research/public-chatter/valuepickr?scope=universe', 'chatter'],
  ['/#/research/super-investors/superstar-investors?scope=universe', 'investors'],
]) {
  await go(hash, 2000);
  const dl = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  await page.locator('#content-host button:has-text("Export")').first().click();
  const file = await dl;
  ok(`${label} export downloads`, !!file, file?.suggestedFilename() || 'no download (CDN blocked?)');
}

// ---------------------------------------------------------------------------------------
// 11. Portfolio Analytics — the two reconciliation identities, asserted NUMERICALLY
//
// These are the checks the whole workspace rests on. They run against the live module in the
// page, not against a fixture, so they fail if the shipped data and the shipped code disagree.
// ---------------------------------------------------------------------------------------
console.log('\n— portfolio: reconciliation —');
await go('/#/portfolio/overview/positions?scope=universe', 1800);

const recon = await page.evaluate(async () => {
  const pf = await import('/js/data/portfolio.js');
  const lots = await import('/js/portfolio/lots.js');
  await pf.load();
  const positions = pf.positions();
  const s = pf.summary();
  const book = pf.book();

  // IDENTITY 1 — sum of open lot quantities === position quantity, per ticker.
  const lotMismatches = positions
    .map((p) => ({ t: p.ticker, lots: p.lots.reduce((a, l) => a + l.openQty, 0), qty: p.qty }))
    .filter((r) => r.lots !== r.qty);

  // ...and the same again against the holdings config, so the file and the replay agree too.
  const configMismatches = pf
    .holdingsConfig()
    .map((h) => ({ t: h.ticker, cfg: h.qty, replay: pf.byTicker(h.ticker)?.qty ?? null }))
    .filter((r) => r.cfg !== r.replay);

  // IDENTITY 2 — realised + unrealised + dividends === total P&L, to the paisa.
  const rebuilt = positions.reduce((a, p) => a + p.realised + p.unrealised + p.dividends, 0);
  const residual = Math.abs(rebuilt - s.totalPnl);

  // Per-position too: a portfolio total can net two opposite errors to zero.
  const perPosition = positions
    .map((p) => ({ t: p.ticker, d: Math.abs(p.totalPnl - (p.realised + p.unrealised + p.dividends)) }))
    .filter((r) => r.d > 0.011);

  // Every realised row's own arithmetic: pnl === proceeds - cost.
  const badRows = book.realised.filter((r) => Math.abs(r.pnl - (r.proceeds - r.cost)) > 0.011);

  // Every sold quantity is accounted for by lot matches.
  const sells = pf.transactions().filter((t) => String(t.type).toLowerCase() === 'sell');
  const unmatchedSells = sells.filter((t) => {
    const matched = book.realised.filter((r) => r.sellId === t.id).reduce((a, r) => a + r.qty, 0);
    return matched !== t.qty;
  });

  // Corporate actions preserve total cost: quantity × cost-per-share is invariant.
  const caTickers = [...new Set(book.events.filter((e) => e.kind === 'bonus' || e.kind === 'split').map((e) => e.ticker))];

  // A purpose-built fixture for the paths the shipped ledger cannot exercise on its own.
  const fixture = lots.replay([
    { id: 'f1', date: '2024-01-10', ticker: 'ZZZ', type: 'Buy', qty: 100, price: 200, value: 20000, charges: 0 },
    { id: 'f2', date: '2024-06-10', ticker: 'ZZZ', type: 'Bonus', qty: 100, price: 0, value: 0, ratio: 2 },
    { id: 'f3', date: '2025-06-10', ticker: 'ZZZ', type: 'Sell', qty: 50, price: 150, value: 7500, charges: 0 },
    { id: 'f4', date: '2024-02-01', ticker: 'YYY', type: 'Sell', qty: 10, price: 100, value: 1000, charges: 0 },
    { id: 'f5', date: '2024-02-02', ticker: 'XXX', type: 'Teleport', qty: 1, price: 1, value: 1 },
  ]);
  const zzz = fixture.byTicker.get('ZZZ');
  const zzzRow = fixture.realised[0];

  return {
    tickerCount: positions.length,
    lotMismatches, configMismatches, residual, perPosition,
    badRowCount: badRows.length, unmatchedSellCount: unmatchedSells.length, sellCount: sells.length,
    lotMatchCount: book.realised.length, replayErrors: book.errors.length,
    caTickers,
    caCostPreserved: caTickers.every((t) => {
      const ev = book.events.find((e) => e.ticker === t && (e.kind === 'bonus' || e.kind === 'split'));
      return ev && ev.qtyAfter === Math.round(ev.qtyBefore * ev.ratio);
    }),
    // fixture expectations
    fxQty: zzz.qty,                       // 100 → bonus ×2 = 200 → sell 50 = 150
    fxCost: zzz.invested,                 // total cost unchanged at 20,000 − the 50 sold
    fxBuyDate: zzzRow?.buyDate,           // bonus shares keep the ORIGINAL acquisition date
    fxTerm: zzzRow?.term,                 // 2024-01-10 → 2025-06-10 is long term
    fxErrors: fixture.errors.map((e) => e.reason),
    // summary sanity
    xirr: s.xirr, twr: s.twr?.total, maxDD: s.maxDrawdown, coverage: pf.equityCurve()?.coverage,
    unpriced: s.reconciliation.unpricedTickers,
  };
});

ok('IDENTITY 1: open lots sum to position qty on every ticker', recon.lotMismatches.length === 0,
   recon.lotMismatches.map((r) => `${r.t} ${r.lots}!=${r.qty}`).join(', ') || `${recon.tickerCount} tickers`);
ok('...and portfolio.json agrees with the replay', recon.configMismatches.length === 0,
   recon.configMismatches.map((r) => `${r.t} ${r.cfg}!=${r.replay}`).join(', '));
ok('IDENTITY 2: realised + unrealised + dividends === total P&L', recon.residual < 0.011, `residual ${recon.residual}`);
ok('...per position, not just in aggregate', recon.perPosition.length === 0,
   recon.perPosition.map((r) => `${r.t} ${r.d}`).join(', '));
ok('every realised row: pnl === proceeds − cost', recon.badRowCount === 0, `${recon.lotMatchCount} lot matches checked`);
ok('every sold share is matched to a lot', recon.unmatchedSellCount === 0, `${recon.sellCount} sells`);
ok('the ledger replays with no rejected rows', recon.replayErrors === 0, `${recon.replayErrors} errors`);
ok('corporate actions multiply quantity exactly', recon.caCostPreserved && recon.caTickers.length > 0, recon.caTickers.join(', '));

console.log('\n— portfolio: FIFO fixture —');
ok('bonus doubles quantity (100 → 200, less 50 sold = 150)', recon.fxQty === 150, `got ${recon.fxQty}`);
ok('bonus preserves total cost, so 150 shares cost 15,000', Math.abs(recon.fxCost - 15000) < 0.011, `got ${recon.fxCost}`);
ok('bonus shares inherit the ORIGINAL acquisition date', recon.fxBuyDate === '2024-01-10', `got ${recon.fxBuyDate}`);
ok('...so the gain is classified long term', recon.fxTerm === 'long', `got ${recon.fxTerm}`);
ok('a sell with no holding is reported, not dropped', recon.fxErrors.some((r) => /exceeds/.test(r)), recon.fxErrors.join(' | '));
ok('an unknown transaction type is reported, not dropped', recon.fxErrors.some((r) => /unknown type/.test(r)), recon.fxErrors.join(' | '));

// ---------------------------------------------------------------------------------------
// 12. Equity curve — bounds, and an INDEPENDENT recompute of max drawdown
// ---------------------------------------------------------------------------------------
console.log('\n— portfolio: equity curve —');
const curveChecks = await page.evaluate(async () => {
  const pf = await import('/js/data/portfolio.js');
  await pf.load();
  const c = pf.equityCurve();
  const pts = c.points;

  // Recomputed from scratch here, deliberately not sharing a line of code with the module.
  let peak = -Infinity, worst = 0, worstAt = null;
  for (const p of pts) { if (p.value > peak) peak = p.value; const d = ((p.value - peak) / peak) * 100; if (d < worst) { worst = d; worstAt = p.d; } }

  return {
    days: pts.length,
    nonFinite: pts.filter((p) => !Number.isFinite(p.value)).length,
    negative: pts.filter((p) => p.value < 0).length,
    monotonicDates: pts.every((p, i) => i === 0 || p.d > pts[i - 1].d),
    valueEqualsParts: pts.filter((p) => Math.abs(p.value - (p.holdings + p.excludedCost + p.cash)) > 0.011).length,
    cashNeverFalls: pts.every((p, i) => i === 0 || p.cash >= pts[i - 1].cash - 0.011),
    moduleMaxDD: c.maxDrawdown, independentMaxDD: worst,
    moduleTrough: c.maxDrawdownTrough, independentTrough: worstAt,
    ddInRange: c.drawdown.every((d) => d.dd <= 0.0001 && d.dd >= -100),
    holdingsDD: c.maxHoldingsDrawdown,
    excluded: c.excluded, coverage: c.coverage,
    benchDays: c.benchmark?.points.length ?? 0,
    from: c.from, to: c.to,
  };
});

ok('curve has one point per trading day, dates strictly increasing', curveChecks.monotonicDates && curveChecks.days > 700, `${curveChecks.days} days, ${curveChecks.from} → ${curveChecks.to}`);
ok('no non-finite or negative portfolio values', curveChecks.nonFinite === 0 && curveChecks.negative === 0);
ok('value === holdings + excluded-at-cost + cash, every day', curveChecks.valueEqualsParts === 0, `${curveChecks.valueEqualsParts} days off`);
ok('cash never decreases (proceeds are retained, never reinvested)', curveChecks.cashNeverFalls);
ok('drawdown is always in (−100%, 0]', curveChecks.ddInRange);
ok('INDEPENDENT recompute agrees on max drawdown', Math.abs(curveChecks.moduleMaxDD - curveChecks.independentMaxDD) < 0.0001,
   `module ${curveChecks.moduleMaxDD.toFixed(4)}% vs recomputed ${curveChecks.independentMaxDD.toFixed(4)}%`);
ok('...and on the trough date', curveChecks.moduleTrough === curveChecks.independentTrough, `${curveChecks.moduleTrough} vs ${curveChecks.independentTrough}`);
ok('holdings-only drawdown is deeper than the total (cash dampens it)', curveChecks.holdingsDD < curveChecks.moduleMaxDD,
   `holdings ${curveChecks.holdingsDD.toFixed(2)}% vs total ${curveChecks.moduleMaxDD.toFixed(2)}%`);
ok('benchmark covers the same window', curveChecks.benchDays === curveChecks.days, `${curveChecks.benchDays} benchmark points`);
ok('excluded tickers are named, and coverage is reported', curveChecks.coverage > 0 && curveChecks.coverage <= 100,
   `${curveChecks.coverage.toFixed(1)}% priced, excludes ${curveChecks.excluded.join(', ') || 'nothing'}`);

// ---------------------------------------------------------------------------------------
// 13. The no-live-price fallback must be loud, not silent
// ---------------------------------------------------------------------------------------
console.log('\n— portfolio: no-live-price fallback —');
{
  const fb = await context.newPage();
  const fbErrors = [];
  fb.on('pageerror', (e) => fbErrors.push(String(e.message)));
  await fb.route('**/data/technicals.json', (r) => r.fulfill({ status: 404, body: 'gone' }));
  await fb.goto(`${BASE}/#/portfolio/overview/positions?scope=universe`, { waitUntil: 'networkidle' });
  await fb.waitForTimeout(1600);
  const t = await fb.locator('#content-host').innerText();
  ok('a missing mark says so rather than showing zeros', /Marks unavailable/.test(t));
  ok('...and every row is tagged "at cost"', /AT COST/i.test(t));
  ok('...without throwing', fbErrors.length === 0, fbErrors.join(' | '));
  await fb.close();

  const nh = await context.newPage();
  await nh.route('**/data/portfolio-history.json', (r) => r.fulfill({ status: 404, body: 'gone' }));
  await nh.goto(`${BASE}/#/portfolio/drawdown/curve?scope=universe`, { waitUntil: 'networkidle' });
  await nh.waitForTimeout(1600);
  const dt = await nh.locator('#content-host').innerText();
  ok('a missing price history refuses to show a drawdown', /No price history, so no drawdown/.test(dt));
  ok('...and names how to produce it', /scrape-portfolio-history/.test(dt));
  await nh.close();
}

// ---------------------------------------------------------------------------------------
// 14. Group-by, the CSV round trip, and the portfolio exports
// ---------------------------------------------------------------------------------------
console.log('\n— portfolio: group-by and CSV —');
for (const [sub, label, unit] of [['sector', 'sector', 'positions'], ['conviction', 'conviction', 'positions'], ['holding-period', 'holding period', 'lots'], ['pnl-band', 'P&L band', 'positions']]) {
  await go(`/#/portfolio/position-by/${sub}?scope=universe`, 1500);
  const rows = await page.locator('#content-host table').first().locator('tbody tr').count();
  const txt = await hostText();
  ok(`group by ${label} produces groups`, rows >= 2, `${rows} groups`);
  ok(`...counted in ${unit}`, new RegExp(unit === 'lots' ? 'lots' : 'positions', 'i').test(txt));
}
{
  await go('/#/portfolio/position-by/sector?scope=universe', 1500);
  const weights = await page.evaluate(() => [...document.querySelectorAll('#content-host table')][0].querySelectorAll('tbody tr'))
    .then(() => page.evaluate(() => {
      const cells = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => tr.innerText.match(/(\d+\.\d)%/g)).filter(Boolean);
      return cells.length;
    }));
  ok('every group carries a weight', weights > 0, `${weights} rows with a % figure`);
}

await go('/#/portfolio/transactions/import?scope=universe', 1600);
{
  const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await page.locator('#csv-download').click();
  const file = await dl;
  ok('the ledger downloads as CSV', !!file, file?.suggestedFilename() || 'no download');
  if (file) {
    const path = await file.path();
    const { readFileSync } = await import('node:fs');
    const csv = readFileSync(path, 'utf8');
    const lines = csv.trim().split('\n');
    ok('CSV header matches the documented columns', lines[0] === 'id,date,ticker,name,type,qty,price,value,charges,ratio', lines[0]);
    await page.locator('#csv-file').setInputFiles(path);
    await page.waitForTimeout(900);
    const preview = await page.locator('#import-result').innerText();
    ok('round-tripping the CSV parses every row back', new RegExp(`${lines.length - 1} rows parsed`).test(preview), preview.split('\n').find((l) => /parsed/.test(l)) || '');
    ok('...with nothing rejected', !/rejected/.test(preview));
  }
}
{
  const { writeFileSync } = await import('node:fs');
  const bad = `${process.env.TMPDIR || '/tmp'}/sattva-bad-import.csv`;
  writeFileSync(bad, ['id,date,ticker,name,type,qty,price', 'b1,2024-13-45,INFY,Infosys,Buy,10,1500', 'b2,2024-05-06,,Infosys,Buy,10,1500', 'b3,2024-05-06,INFY,Infosys,Teleport,10,1500', 'b4,2024-05-06,INFY,Infosys,Buy,10,1500'].join('\n'));
  await page.locator('#csv-file').setInputFiles(bad);
  await page.waitForTimeout(900);
  const preview = await page.locator('#import-result').innerText();
  ok('a malformed CSV names every rejected row', /3 rejected/.test(preview), preview.split('\n').find((l) => /rejected/.test(l)) || '');
  ok('...including an impossible calendar date', /not a valid YYYY-MM-DD/.test(preview));
  ok('...and still applies the good row', /1 row parsed/.test(preview));
}

for (const [hash, label] of [
  ['/#/portfolio/overview/positions?scope=universe', 'positions'],
  ['/#/portfolio/overview/realised?scope=universe', 'realised'],
  ['/#/portfolio/drawdown/episodes?scope=universe', 'drawdown episodes'],
]) {
  await go(hash, 1600);
  const dl = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
  await page.locator('#content-host button:has-text("Export")').first().click();
  const file = await dl;
  ok(`${label} export downloads`, !!file, file?.suggestedFilename() || 'no download (CDN blocked?)');
}

// ---------------------------------------------------------------------------------------
// 15. Accessibility — table semantics and overlay focus management
// ---------------------------------------------------------------------------------------
console.log('\n— accessibility —');
{
  let totalTh = 0, missing = 0;
  for (const hash of ['/#/research/earnings-hub?scope=universe', '/#/research/breakouts/technical-scanner?scope=universe',
                      '/#/portfolio/overview/positions?scope=universe', '/#/portfolio/transactions/trades?scope=universe',
                      '/#/portfolio/position-by/holding-period?scope=universe']) {
    await go(hash, 1300);
    const r = await page.evaluate(() => { const th = [...document.querySelectorAll('#content-host th')]; return [th.length, th.filter((t) => !t.hasAttribute('scope')).length]; });
    totalTh += r[0]; missing += r[1];
  }
  ok('every table header carries scope="col"', missing === 0, `${totalTh} headers checked, ${missing} missing`);
}
{
  await go('/#/portfolio/overview/positions?scope=universe', 1600);
  await page.locator('#content-host tbody tr').first().click();
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => { const d = document.getElementById('drill-panel'); return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), inside: d.contains(document.activeElement) }; });
  ok('the drill is role=dialog aria-modal=true', st.role === 'dialog' && st.modal === 'true');
  ok('...and takes focus on open', st.inside);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  ok('...and Tab cannot escape it', await page.evaluate(() => document.getElementById('drill-panel').contains(document.activeElement)));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  ok('...and focus leaves it on close', await page.evaluate(() => !document.getElementById('drill-panel').contains(document.activeElement)));
}
{
  let kOk = 0;
  const kRoutes = ['/#/research/earnings-hub', '/#/research/concall/live-feed', '/#/portfolio/drawdown/curve', '/#/portfolio/transactions/import'];
  for (const r of kRoutes) {
    await go(r, 1300);
    await page.keyboard.press('Meta+k'); await page.waitForTimeout(250);
    if (await page.evaluate(() => document.activeElement?.tagName === 'INPUT')) kOk++;
    await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  }
  ok('⌘K focuses global search from every route', kOk === kRoutes.length, `${kOk}/${kRoutes.length}`);
}

// ---------------------------------------------------------------------------------------
// 16. Layout holds and nothing scrolls sideways
// ---------------------------------------------------------------------------------------
console.log('\n— layout —');
for (const width of [1440, 1024, 390]) {
  await page.setViewportSize({ width, height: 900 });
  for (const [route, label] of [
    ['/#/research/concall/keyword-scan?scope=universe', 'con-call matrix'],
    ['/#/research/public-chatter/trending?scope=universe', 'chatter trending'],
    ['/#/research/super-investors/fund-flows?scope=universe', 'investor flows'],
  ]) {
    await go(route, 1700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${label}: no sideways page scroll at ${width}px`, over <= 0, `${over}px`);
  }
  await go('/#/research/earnings-hub?scope=universe', 1600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`no sideways page scroll at ${width}px`, overflow <= 0, `${overflow}px`);
}

// ---------------------------------------------------------------------------------------
console.log('\n— console —');
const unique = [...new Set(errors)];
ok('zero console errors', unique.length === 0, unique.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? `\nAll checks passed.${skipped ? ` (${skipped} skipped — see SKIP lines)` : ''}` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
