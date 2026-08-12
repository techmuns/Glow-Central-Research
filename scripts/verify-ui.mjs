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
// Simulate the tab going to the background. Pollers must pause on hidden and refetch on return —
// this used to be defined in the con-call live-feed section, which no longer exists.
const setHidden = (hidden) =>
  page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
const rowCount = () => page.locator('tr[data-row-key]').count();
const SEARCH = '#content-host input[type="search"], #content-host input[placeholder*="Search"]';

/**
 * A stand-in for the Concall Deep Dive dashboard (see section 6d).
 *
 * It implements the documented contract and nothing else, and it counts what it is asked to do —
 * which is the point: the checks that matter about that integration are about requests NOT made.
 * Deterministic by call count rather than by wall clock, so a slow machine cannot skip a state.
 *
 * The report body is deliberately hostile in two ways: it carries a section this renderer has
 * never heard of, and a string that is markup. Both must survive as text.
 */
async function startDeepDiveStub(hits) {
  const { createServer } = await import('node:http');
  const runs = new Map(); // slug -> report polls served so far
  const REPORT = {
    meta: { company: 'Tata Motors', ticker: 'TATAMOTORS', quarter: 'Q1FY27', call_date: '2026-08-05' },
    verdict: 'Constructive. Margin recovery is ahead of the guided path. <img src=x onerror="window.__dd_pwned=1">',
    key_takeaways: ['JLR EBIT margin guided to 8-10% for FY27.', 'Net automotive debt down to near zero.'],
    financials: [
      { metric: 'Revenue', current: 108000, prior: 102300 },
      { metric: 'PAT', current: 5900, prior: 3200 },
    ],
    weird_new_section: 'A field this renderer has never heard of, kept anyway.',
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const send = (obj) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        // Their CORS is wide open; the stub matches so the browser behaves the same way.
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'OPTIONS') return send({});
    if (url.pathname === '/api/analyze') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.analyze++;
        const body = JSON.parse(raw || '{}');
        if (body.force) hits.forced++;
        const slug = `${String(body.ticker || body.company || 'x').toLowerCase().replace(/\W+/g, '-')}-q1fy27`;
        runs.set(slug, 0);
        send({ ok: true, slug, status: 'queued' });
      });
      return;
    }
    if (url.pathname === '/api/report') {
      hits.report++;
      const slug = url.searchParams.get('slug');
      if (!runs.has(slug)) return send({ ok: true, slug, status: 'unknown' });
      const n = runs.get(slug) + 1;
      runs.set(slug, n);
      // 1: the KV propagation beat. 2: a stage with a message. 3+: the finished report.
      if (n === 1) return send({ ok: true, slug, status: 'unknown' });
      if (n === 2) return send({ ok: true, slug, status: 'running', stage: 'transcript', message: 'Pulling the transcript from the exchange filing' });
      return send({ ok: true, slug, status: 'done', report: REPORT, partial: false });
    }
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

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
  // Check the ORDERING CONTRACT itself — date descending, and within a date the upstream's own
  // `seq` ascending — rather than comparing two literal lists. An earlier version compared the
  // newest date's list and required it to hold more than three companies, which is true in the
  // middle of results season and false at 09:00, when exactly one company has filed. The property
  // under test holds either way; the list comparison did not.
  const index = new Map(payload.rows.map((r) => [r.scId, { date: r.resultDate || '', seq: r.seq ?? 0 }]));
  const rendered = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => tr.dataset.rowKey);
  const seen = rendered.map((k) => index.get(k)).filter(Boolean); // a row that filed mid-check is simply skipped
  const breaks = [];
  for (let i = 1; i < seen.length; i++) {
    const a = seen[i - 1];
    const b = seen[i];
    if (b.date > a.date) breaks.push(`${rendered[i]} (${b.date} after ${a.date})`);
    else if (b.date === a.date && b.seq < a.seq) breaks.push(`${rendered[i]} (seq ${b.seq} after ${a.seq} on ${b.date})`);
  }
  const newest = payload.rows.reduce((a, r) => (r.resultDate > a ? r.resultDate : a), '');
  return {
    breaks: breaks.slice(0, 3),
    checked: seen.length,
    newest,
    newestCount: payload.rows.filter((r) => r.resultDate === newest).length,
    firstRendered: rendered.slice(0, 4).join(' '),
    seq: payload.rows[0]?.seq,
  };
});
ok('rows carry the upstream sequence', ehOrder.seq === 0, `first row seq=${ehOrder.seq}`);
ok(
  "...and the table is in Moneycontrol's own order — date desc, then upstream seq",
  ehOrder.checked > 20 && ehOrder.breaks.length === 0,
  ehOrder.breaks.length ? ehOrder.breaks.join('; ') : `${ehOrder.checked} rows in order; ${ehOrder.newestCount} filed on ${ehOrder.newest} — ${ehOrder.firstRendered}`
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
//
// Polled, not read once. This runs against a LIVE feed: a company filing mid-check triggers a
// structural repaint, and a read that lands while the table is being rebuilt sees an empty tbody
// and reports a company that is plainly on screen as missing. Same reason `waitForPanel` exists.
const figuresFor = async (needle, timeout = 8000) => {
  const started = Date.now();
  for (;;) {
    const hit = await page.evaluate((n) => {
      const hs = [...document.querySelectorAll('#content-host thead th')].map((t) => t.innerText.trim().toUpperCase());
      const i = hs.findIndex((h) => h.startsWith('REVENUE ') && h !== 'REVENUE GROWTH');
      if (i < 0) return null;
      for (const tr of document.querySelectorAll('#content-host tbody tr')) {
        const tds = [...tr.children].map((c) => c.innerText.trim());
        if (tds[1] && tds[1].toUpperCase().includes(n)) return { cur: tds[i], prior: tds[i + 1] };
      }
      return null;
    }, needle);
    if (hit || Date.now() - started > timeout) return hit;
    await page.waitForTimeout(250);
  }
};

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

// QoQ needs the live route to actually be serving QoQ. Three worlds, and which one we are in
// decides what to assert:
//   1. No Worker (a plain `python3 -m http.server`) — nothing to fetch.
//   2. A Worker whose upstream is down — it serves the committed snapshot, which is YoY-only.
//      There is deliberately no committed QoQ file, because a stale one would look exactly like a
//      live one while comparing against the wrong quarter.
//   3. A working live route.
// Worlds 1 and 2 are the MORE interesting test: they are where the tab could quietly show YoY
// numbers under QoQ headers and nothing on the page would reveal it. So probe for a genuinely
// live QoQ answer — not merely a 200 with rows in it — and assert the refusal otherwise.
const qoqProbe = await page.evaluate(async () => {
  try {
    const r = await fetch('api/earnings?subType=qoq', { cache: 'no-store' });
    if (!r.ok) return { live: false, why: `HTTP ${r.status}` };
    const p = await r.json();
    if (!(p?.rows?.length > 0)) return { live: false, why: 'no rows' };
    if (p.degraded) return { live: false, why: 'the route is serving the committed snapshot' };
    if ((p.meta?.subType || 'yoy') !== 'qoq') return { live: false, why: `the feed answered with ${p.meta?.subType}` };
    return { live: true, why: '' };
  } catch {
    return { live: false, why: 'no /api/earnings on this origin' };
  }
});
const hasLiveRoute = qoqProbe.live;

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
  ok('without a live QoQ feed, QoQ refuses rather than switching', qoqState.error === true && qoqState.active !== 'qoq', qoqProbe.why);
  ok('...and says which comparison you are actually looking at', /Comparison not switched/i.test(await hostText()));
  ok('...and the comparison columns are untouched', revCols(await headsNow())[1] === yoyPrior, yoyPrior);
  ok('...and the toggle still reads YoY', (await page.locator('[data-period][aria-pressed="true"]').innerText()).toUpperCase() === 'YOY');
  skip('the QoQ round trip against a live feed', qoqProbe.why);
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
    return {
      total: m ? Number(m[1].replace(/,/g, '')) : null,
      rows: document.querySelectorAll('tr[data-row-key]').length,
      saysCap: /largest by market cap/i.test(txt),
      saysUnknown: /how many report on this date is not known/i.test(txt),
    };
  });
  // Moneycontrol serves the counts and the lists from two different endpoints, and the count one
  // goes flat — zero for every date in the window — while the lists keep working. The page must
  // never print "0 companies report" above twenty of them: with no believable count it has to say
  // the count is unknown. Either state is acceptable; asserting a number that is not there is not.
  if (calHonesty.total != null) {
    ok('the calendar states the complete count for the date', calHonesty.total >= calHonesty.rows, `${calHonesty.total} scheduled, ${calHonesty.rows} named`);
  } else {
    ok('...and says so plainly when the count endpoint is not answering', calHonesty.saysUnknown, 'no count printed and no explanation either');
  }

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
    calHonesty.total == null || calHonesty.rows >= calHonesty.total || calHonesty.saysCap,
    `${calHonesty.rows} named of ${calHonesty.total}`
  );

  // Clicking another date must change both the data and the URL. A date with a zero count is
  // disabled — but when NO count is readable, none may be disabled, or the reader is locked out of
  // a calendar whose lists are working fine.
  const strip = await page.evaluate(() => ({
    all: [...document.querySelectorAll('[data-date]')].map((b) => b.dataset.date),
    enabled: [...document.querySelectorAll('[data-date]:not([disabled])')].map((b) => b.dataset.date),
    counted: [...document.querySelectorAll('[data-date]')].filter((b) => /\d/.test(b.textContent.split('\n').pop() || '')).length,
  }));
  ok('the date strip never disables every date at once', strip.enabled.length > 0, `${strip.enabled.length} of ${strip.all.length} clickable`);
  const activeDate = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(page.url())?.[1] || null;
  const otherDate = strip.enabled.filter((d) => d !== activeDate).pop() || strip.enabled[strip.enabled.length - 1];
  if (otherDate) {
    await page.locator(`[data-date="${otherDate}"]`).click();
    await page.waitForTimeout(6000);
    ok('picking a date reloads that day and records it in the URL', page.url().includes(`date=${otherDate}`), otherDate);
  } else {
    ok('picking a date reloads that day and records it in the URL', false, 'no clickable date in the strip');
  }

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
// 6b. Con-call — the LIVE half, off StockScans.
//
// The honesty check that matters here is attribution: the result score, the sentiment tier and
// the highlight bullets are StockScans' analysis, not ours, and every surface that shows them has
// to say so — including the one that leaves the page. And `pending` must never render as a zero.
// ---------------------------------------------------------------------------------------
console.log('\n— con-call: live scan —');
await go('/#/research/concall/concall-scans?scope=universe', 1200);
await waitForPanel();
const csReady = await (async () => {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const n = await rowCount();
    if (n > 0) return n;
    if (/could not reach/i.test(await hostText())) return 0;
    await page.waitForTimeout(300);
  }
  return 0;
})();
ok('the live con-call scan renders the quarter', csReady > 200, `${csReady} calls`);

const csHeads = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()));
for (const c of ['CALL', 'COMPANY', 'RESULT SCORE', 'RESULT', 'SENTIMENT', 'HIGHLIGHTS']) {
  ok(`con-call column: ${c}`, csHeads.some((h) => h.startsWith(c)), csHeads.join(' | '));
}
const csText = await hostText();
ok('the panel says whose analysis this is', /StockScans/.test(csText) && /own analysis/i.test(csText));
// One view, no rail. The tab used to carry six sub-views, four of them on a synthetic transcript
// corpus with fictional speakers; they are gone, and with them the amber ribbon that had to sit
// next to a live green pill explaining which half you were looking at.
ok('the tab renders with no sub-view in the URL', csReady > 200);
ok('...and the shell drops the rail entirely', (await page.locator('#aside-content').count()) === 0 || !(await page.locator('#aside-content').isVisible()));
ok('...and nothing on the tab is flagged illustrative any more', (await page.locator('[data-mock-ribbon]').count()) === 0);

// Times are IST, not the viewer's zone. An 18:00 IST call is an 18:00 IST event; rendering it in
// the browser's local zone turned it into 12:30 on a UTC machine.
const csTimes = await page.$$eval('#content-host tbody tr td:first-child', (ts) => ts.slice(0, 40).map((t) => t.innerText.trim()));
ok('call times render in IST regardless of the viewer’s zone', csTimes.some((t) => /\d{2}:\d{2}/.test(t)) && !csTimes.every((t) => /00:00/.test(t)), csTimes[0]);

// pending is not zero.
const csPending = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const rows = mod.all();
  const nulls = rows.filter((r) => r.resultScore == null);
  const zeros = rows.filter((r) => r.resultScore === 0);
  return { total: rows.length, nulls: nulls.length, zeros: zeros.length, analysed: rows.filter((r) => r.resultScore != null).length };
});
ok('unanalysed calls carry a null score, never a zero', csPending.nulls >= 0 && csPending.zeros === 0, `${csPending.nulls} pending of ${csPending.total}`);
await page.locator('#content-host select').first().selectOption('pending');
await page.waitForTimeout(600);
ok('...and the pending filter shows them as “pending”', (await rowCount()) === csPending.nulls && (csPending.nulls === 0 || /pending/i.test(await hostText())), `${await rowCount()} rows`);
await page.locator('#content-host select').first().selectOption('all');
await page.waitForTimeout(400);

// The tier labels must be StockScans' own, not a re-banding of ours.
const csBands = await page.evaluate(async () => {
  const m = await import('/js/data/stockscans-shared.js');
  return [85, 61, 45, 21, 3].map((v) => m.resultTierOf(v).label).join(',') + '|' + (m.resultTierOf(null) === null);
});
ok('result tiers use StockScans’ published bands', csBands === 'Excellent,Strong,Average,Weak,Poor|true', csBands);

// The drill has to carry the attribution too — and so does the export banner, which is the one
// artefact that leaves the page without any chrome around it.
await page.locator('tr[data-row-key]').first().click();
await page.waitForTimeout(700);
const csDrill = await page.locator('#drill-content').innerText();
ok('the drill attributes the score to StockScans', /StockScans/.test(csDrill) && /not this dashboard/i.test(csDrill));
ok('...and quotes their bands rather than inventing any', /80\+ Excellent/.test(csDrill));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ---------------------------------------------------------------------------------------
// 6c. The schedule, as an overlay — "Upcoming Concalls"
//
// It is a modal off the scan table rather than a second page, which is how StockScans present it.
// The checks that matter: it groups by DATE, marks today, collapses a long day behind "+N more"
// that actually expands, and searches across every day rather than only the visible ones.
// ---------------------------------------------------------------------------------------
await page.locator('[data-open-schedule]').click();
await page.waitForTimeout(600);
const calModal = () => page.locator('#modal-content');
const calText = await calModal().innerText();
ok('the Upcoming Concalls button opens the schedule overlay', /Upcoming Concalls/i.test(calText));

const calShape = await page.evaluate(() => {
  const root = document.querySelector('#modal-content');
  const days = [...root.querySelectorAll('section')];
  return {
    days: days.length,
    today: root.innerText.includes('TODAY') || root.innerText.includes('Today'),
    tiles: root.querySelectorAll('section .grid > div').length,
    more: root.querySelectorAll('[data-cal-more]').length,
    firstDay: days[0]?.querySelector('.grid')?.children.length ?? 0,
  };
});
ok('...grouped into days', calShape.days > 0, `${calShape.days} dates`);
ok('...with today marked', calShape.today);
ok('...and each day capped, with the rest behind “+N more”', calShape.more > 0, `${calShape.more} collapsed days`);

// "+N more" must actually reveal that day, and only that day.
const beforeMore = await page.locator('#modal-content section .grid > div').count();
await page.locator('[data-cal-more]').first().click();
await page.waitForTimeout(300);
const afterMore = await page.locator('#modal-content section .grid > div').count();
ok('“+N more” expands its day in place', afterMore > beforeMore, `${beforeMore} → ${afterMore} companies`);

// Search has to reach days that are still collapsed, or it would only find what is on screen.
const hidden = await page.evaluate(async () => {
  const mod = await import('/js/data/concall-scans.js');
  const up = mod.upcoming();
  const byDate = new Map();
  for (const r of up) byDate.set(r.date, [...(byDate.get(r.date) || []), r]);
  // A company past the 7-per-day cut on a day other than the first.
  const dates = [...byDate.keys()].sort();
  for (const d of dates.slice(1)) {
    const list = byDate.get(d);
    if (list.length > 8) return list[list.length - 1].ticker;
  }
  return null;
});
if (hidden) {
  await page.locator('[data-cal-search]').fill(hidden);
  await page.waitForTimeout(400);
  ok('search reaches a company hidden behind a collapsed day', (await calModal().innerText()).includes(hidden), hidden);
  await page.locator('[data-cal-search]').fill('zzzznotacompany');
  await page.waitForTimeout(400);
  ok('...and says so plainly when nothing matches', /No company matches/i.test(await calModal().innerText()));
  await page.locator('[data-cal-search]').fill('');
  await page.waitForTimeout(300);
} else {
  skip('search reaches a company hidden behind a collapsed day', 'no day in the current schedule is long enough to collapse past');
}

// Times are IST here too, and in StockScans' own 12-hour form.
ok('schedule times are 12-hour IST, as StockScans print them', /\b\d{1,2}:\d{2}\s?(AM|PM)\b/.test(await calModal().innerText()));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('ESC closes the schedule overlay', (await page.locator('#modal-overlay.is-open').count()) === 0);

// ---------------------------------------------------------------------------------------
// 6d. The Deep Dive column — triggering someone else's pipeline
//
// This column dispatches a run on a SEPARATE dashboard. Two things make it different from every
// other feed here and both are checked below rather than trusted:
//
//   1. A CLICK COSTS MONEY. Their POST /api/analyze is unauthenticated and every accepted call
//      starts a real LLM run. So the suite counts requests: rendering the table must dispatch
//      NOTHING, reaching the confirm step must dispatch NOTHING, and reopening a finished panel
//      must reattach rather than pay for a second run. A regression here is not a visual bug.
//   2. THE REPORT IS EXTERNAL CONTENT with a schema we do not own. It must render sections we
//      have never heard of, and it must not be able to inject markup.
//
// The stub below speaks the documented contract and nothing more, which is exactly what this
// integration is allowed to assume. Pointing the suite at the real dashboard would spend money on
// every run — and its URL is deployment-specific and deliberately not in this repo.
// ---------------------------------------------------------------------------------------
console.log('\n— con-call: deep dive —');

const ddHits = { analyze: 0, report: 0, forced: 0 };
const { server: ddStub, origin: ddOrigin } = await startDeepDiveStub(ddHits);

await go('/#/research/concall?scope=universe', 1200);
await waitForPanel();
await page.waitForSelector('[data-deep-dive]', { timeout: 25000 }).catch(() => {});
const ddCells = await page.locator('[data-deep-dive]').count();
ok('every scan row carries a Deep Dive button', ddCells > 200 && ddCells === (await rowCount()), `${ddCells} buttons`);
ok('...and the column is headed Deep Dive', (await page.$$eval('#content-host thead th', (ts) => ts.map((t) => t.innerText.trim().toUpperCase()))).includes('DEEP DIVE'));
ok('THE TABLE DISPATCHES NOTHING ON RENDER', ddHits.analyze === 0 && ddHits.report === 0, `analyze=${ddHits.analyze} report=${ddHits.report}`);

// The button owns its click: opening the drill behind a panel is not what anyone meant.
await page.locator('[data-deep-dive]').first().click();
await page.waitForTimeout(600);
ok('the button opens the Deep Dive, not the row drill', (await page.locator('#drill-panel.is-open').count()) === 0 && (await page.locator('#workspace-overlay:not(.hidden)').count()) === 1);

// Unconnected is the shipped state, because that URL is not in this repo.
ok('an unconnected column asks for the dashboard URL', (await page.locator('#dd-base').count()) === 1);
await page.fill('#dd-base', ddOrigin);
await page.click('[data-dd-save]');
await page.waitForSelector('[data-dd-start]', { timeout: 5000 });
const ddConfirm = await page.locator('#workspace-panel').innerText();
ok('...then says a run costs real compute before anything is sent', /costs real compute/i.test(ddConfirm) && /entirely theirs/i.test(ddConfirm));
ok('...and STILL has not dispatched anything', ddHits.analyze === 0, `analyze=${ddHits.analyze}`);

await page.click('[data-dd-start]');
// Their pipeline reports `unknown` for a beat after dispatch while the record propagates. That is
// not a failure and must not read as one.
await page.waitForFunction(() => /Waiting for the run to register/i.test(document.querySelector('#workspace-panel')?.innerText || ''), null, { timeout: 15000 })
  .then(() => ok('“unknown” right after dispatch reads as waiting, not as an error', true))
  .catch(() => ok('“unknown” right after dispatch reads as waiting, not as an error', false, 'never showed the registering state'));

// The loading window is THEIR words. A spinner of ours would be inventing reassurance.
await page.waitForFunction(() => /Pulling the transcript from the exchange filing/.test(document.querySelector('#workspace-panel')?.innerText || ''), null, { timeout: 20000 })
  .then(() => ok('the loading window prints their stage and message verbatim', true))
  .catch(() => ok('the loading window prints their stage and message verbatim', false, 'their message never appeared'));
const ddRunning = await page.locator('#workspace-panel').innerText();
ok('...with an elapsed clock and the stages so far', /\d+m \d{2}s elapsed/.test(ddRunning) && /Stages so far/i.test(ddRunning));

await page.waitForSelector('[data-dd-raw]', { timeout: 40000 });
const ddDone = await page.locator('#workspace-panel').innerText();
ok('the finished report renders', /Constructive/.test(ddDone) && /Key Takeaways/i.test(ddDone));
ok('...and says the whole analysis is theirs', /reproduced here unchanged/i.test(ddDone) && /Nothing on this panel is computed/i.test(ddDone));
const ddLink = await page.getAttribute('#workspace-panel a[target=_blank]', 'href');
ok('...and links to their own rendering of it', !!ddLink && ddLink.startsWith(`${ddOrigin}/#/report/`), ddLink || 'no link');

// The schema lives in their repo. A section we have never heard of must still appear.
ok('a section the renderer has never heard of still renders', /Weird New Section/i.test(ddDone) && /kept anyway/i.test(ddDone));

// It is external content, so none of it may reach the DOM as markup.
const ddInjection = await page.evaluate(() => ({
  pwned: !!window.__dd_pwned,
  imgs: document.querySelectorAll('#workspace-panel img').length,
  literal: document.querySelector('#workspace-panel').innerText.includes('<img src=x'),
}));
ok('report strings are escaped, not parsed as markup', !ddInjection.pwned && ddInjection.imgs === 0 && ddInjection.literal, JSON.stringify(ddInjection));

// Reopening must reattach, not pay for a second run.
const ddAfterRun = ddHits.analyze;
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.locator('[data-deep-dive]').first().click();
await page.waitForTimeout(600);
ok('reopening offers to reattach to the run on record', (await page.locator('[data-dd-resume]').count()) === 1);
await page.click('[data-dd-resume]');
await page.waitForSelector('[data-dd-raw]', { timeout: 20000 });
ok('...AND REATTACHING COSTS NOTHING', ddHits.analyze === ddAfterRun, `${ddHits.analyze} dispatches total`);
ok('...never forcing a fresh run behind the reader’s back', ddHits.forced === 0, `${ddHits.forced} forced`);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// Leave no base URL behind: later sections must see the shipped, unconnected state.
await page.evaluate(() => {
  localStorage.removeItem('sattva:deepdive-base');
  localStorage.removeItem('sattva:deepdive-slugs');
});
await new Promise((r) => ddStub.close(r));

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
  // Institutions is real filed data and carries no ribbon; the other two are synthetic and must.
  const ribbons = await page.locator('[data-mock-ribbon]').count();
  if (sub === 'institutions') ok('investors institutions: no ribbon, because nothing on it is synthetic', ribbons === 0, `${ribbons} ribbons`);
  else ok(`investors ${sub}: attribution ribbon`, ribbons === 1);
}
ok('ribbon says the names are real and the holdings are not', /names are real/i.test(await hostText()) && /synthetic/i.test(await hostText()));

// ---------------------------------------------------------------------------------------
// 9b. Institutions — REAL filed shareholdings, and the line between them and the rest.
//
// This is the one view where a real feed and the synthetic placeholders share a sub-view, so the
// checks that matter are about the boundary: no headline number may span both, and the reader must
// never be able to mistake which half a figure came from.
// ---------------------------------------------------------------------------------------
await go('/#/research/super-investors/institutions?scope=universe', 2400);
await waitForPanel();
const filedData = await page.evaluate(async () => {
  const m = await import('/js/data/institution-holdings.js');
  const f = m.all()[0];
  if (!f) return null;
  return {
    name: f.name,
    stocksHeld: f.stocksHeld,
    portfolioValueCr: f.portfolioValueCr,
    sumOfRows: Math.round(f.holdings.reduce((a, h) => a + (h.valueCr ?? 0), 0) * 10) / 10,
    filed: f.filedThisQuarter,
    awaiting: f.awaitingFiling.length,
    quarters: f.quarters.length,
    // The one number that must never be faked: a holding with no filed percentage keeps its
    // share count, and must not be carrying a zero percentage instead.
    zeroPcts: f.holdings.filter((h) => h.holdingPct === 0).length,
    nullPctWithQty: f.holdings.filter((h) => h.holdingPct == null && h.qty != null).length,
    deltaDisagreements: f.holdings.filter((h) => h.changePp != null && h.pctDelta != null && Math.abs(h.changePp - h.pctDelta) > 0.11).length,
  };
});
if (filedData) {
  ok('the filed-holdings file loads', filedData.stocksHeld > 0, `${filedData.name}: ${filedData.stocksHeld} holdings`);
  ok("...and its total is the sum of its own rows", Math.abs(filedData.portfolioValueCr - filedData.sumOfRows) < 0.5, `${filedData.portfolioValueCr} vs ${filedData.sumOfRows}`);
  ok('...with nine quarters of filed history', filedData.quarters === 9, `${filedData.quarters} quarters`);
  // Trendlyne publish their own change per row; ours is the difference of two filed percentages.
  // They should agree — a disagreement means the history columns are being read out of order.
  ok("our change agrees with Trendlyne's on every row", filedData.deltaDisagreements === 0, `${filedData.deltaDisagreements} rows differ by >0.11pp`);
  ok('a holding awaiting its filing keeps null, never a zero percentage', filedData.zeroPcts === 0 && filedData.nullPctWithQty === filedData.awaiting, `${filedData.awaiting} awaiting, ${filedData.zeroPcts} zeros`);

  const inst = await hostText();
  ok('the table renders every filed holding', (await rowCount()) === filedData.stocksHeld, `${await rowCount()} rows`);
  ok('the panel says the value is Trendlyne’s, not ours', /Trendlyne/.test(inst) && /derivation/i.test(inst));
  // A row awaiting its filing shows a dash for the percentage and says WHY in the change column —
  // Trendlyne's own label. A zero there would report a live position as sold.
  ok('...and a holding awaiting its filing says so rather than showing zero', filedData.awaiting === 0 || /Filing Awaited/i.test(inst));
  ok('...and the note explains what the dash means', /dash there means/i.test(inst) && /never sold/i.test(inst));

  // THE COLUMN SET IS TRENDLYNE'S: Stock, Holding Value, Qty Held, the latest quarter's change and
  // holding percentage, then the eight prior quarters. Thirteen columns, every one sortable.
  const cols = await page.$$eval('#content-host thead th', (ts) => ts.map((t) => ({ label: t.innerText.trim().toUpperCase().replace(/\s*[▾▴]$/, ''), sortable: !!t.dataset.sort })));
  ok('the table carries Trendlyne’s full column set', cols.length === 13, `${cols.length} columns: ${cols.map((c) => c.label).join(' | ').slice(0, 90)}…`);
  for (const want of ['STOCK', 'HOLDING VALUE', 'QTY HELD']) {
    ok(`column: ${want}`, cols.some((c) => c.label.replace(/\s+/g, ' ') === want), cols.map((c) => c.label).join(' | '));
  }
  ok('the latest quarter has both a change and a holding column', cols.filter((c) => /CHANGE %|HOLDING %/.test(c.label)).length === 2);
  ok('...and eight prior quarters follow it', cols.filter((c) => /^[A-Z]{3} \d{2} %$/.test(c.label.replace(/\s+/g, ' '))).length === 8);
  ok('EVERY heading is a sort button', cols.every((c) => c.sortable), `${cols.filter((c) => !c.sortable).length} not sortable`);

  // And sorting has to actually reorder the rows, on a numeric column and on the name.
  const firstBy = async (label) => {
    await page.locator(`th[data-sort="${label}"]`).click();
    await page.waitForTimeout(400);
    return (await page.locator('tr[data-row-key]').first().getAttribute('data-row-key')) || '';
  };
  const byValue = await firstBy('Holding Value');
  const byQty = await firstBy('Qty Held');
  ok('sorting by a heading reorders the table', byValue !== byQty, `by value ${byValue}, by qty ${byQty}`);
  const qtyDesc = await page.evaluate(() => [...document.querySelectorAll('tr[data-row-key] td')].length > 0);
  ok('...and the sorted column is the one that is ordered', qtyDesc && (await page.evaluate(() => {
    const idx = [...document.querySelectorAll('#content-host thead th')].findIndex((t) => t.dataset.sort === 'Qty Held');
    const vals = [...document.querySelectorAll('#content-host tbody tr')].map((tr) => Number((tr.children[idx]?.innerText || '').replace(/[^0-9]/g, '')) || 0);
    return vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  })));

  // Thirteen columns is a lot. They have to fit the content column at the design width without
  // the table needing a scrollbar of its own — the same bar the Earnings Hub is held to.
  const filedFit = await page.evaluate(() => {
    const e = document.querySelector('[data-table-scroll]');
    return { over: e.scrollWidth - e.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok('the thirteen columns fit at 1440 with no scrollbar of their own', filedFit.over <= 0, `${filedFit.over}px over`);
  ok('...and the page never scrolls sideways', filedFit.page <= 0, `${filedFit.page}px`);

  await page.locator('[data-filed-info]').click();
  await page.waitForTimeout(500);
  const prov = await page.locator('#modal-content').innerText();
  ok('the Filed pill explains which numbers are filings', /filing/i.test(prov) && /derivation/i.test(prov));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
} else {
  skip('the filed-holdings file loads', 'public/data/institution-holdings.json is not present');
}

await go('/#/research/super-investors/superstar-investors?scope=universe', 2000);
ok('ribbon names the real sources', /ticker finology/i.test(await hostText()) && /amfi|trendlyne/i.test(await hostText()));

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
  const kRoutes = ['/#/research/earnings-hub', '/#/research/concall', '/#/portfolio/drawdown/curve', '/#/portfolio/transactions/import'];
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
    ['/#/research/concall?scope=universe', 'con-call scan table'],
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
// 17. Persistent caching — the two big polled feeds must not re-download themselves
//
// The results feed is 1.1MB and the con-call scan 450KB, both polled every 30 seconds. Before
// this was wired, one open Earnings Hub tab pulled 1,135KB PER TICK — measured, ~136MB an hour —
// to report that nothing had changed. The assertions below are the ones that keep it that way.
// ---------------------------------------------------------------------------------------
console.log('\n— persistent cache —');
await page.setViewportSize({ width: 1440, height: 1100 });

// The store must actually persist, and must hold the server's own bytes under the server's own
// tag. That pairing is the whole basis for trusting an unchanged answer: if the stored value and
// the stored tag ever describe different things, every later revalidation is a lie.
await go('/#/research/earnings-hub?scope=universe', 400);
await waitForPanel(12000);
await page.waitForTimeout(1200); // the writes are fire-and-forget, off the paint path

const stored = await page.evaluate(async () => {
  const s = await import('./js/core/store.js');
  const e = await s.readEntry(s.KEYS.earnings('yoy'));
  return { persistent: s.isPersistent(), has: !!e, tag: e?.tag || null, rows: e?.value?.rows?.length || 0, bodyTag: e?.value?.meta?.contentTag || null };
});
if (stored.has) {
  ok('the results payload is kept on this device', stored.rows > 100, `${stored.rows} rows stored`);
  ok('...under a content tag', !!stored.tag, stored.tag || 'none');
  ok(
    "...and the tag describes the value stored with it",
    !stored.bodyTag || stored.tag.replace(/"/g, '') === stored.bodyTag,
    `header ${stored.tag} vs body ${stored.bodyTag}`
  );
} else {
  skip('the results payload is kept on this device', 'no /api/earnings on this origin — nothing live to store');
}

// A revalidation must cost headers, not a payload. `transferSize` is the honest measure:
// `content-length` is present on a browser-cache hit too, so counting it would report a full
// download for a request that moved nothing.
const revalidation = await page.evaluate(async () => {
  const url = 'api/earnings?subType=yoy&fields=prices';
  const probe = async () => {
    performance.clearResourceTimings();
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 250));
    const e = performance.getEntriesByType('resource').filter((x) => x.name.includes('fields=prices')).pop();
    return e ? { transfer: e.transferSize, decoded: e.decodedBodySize } : null;
  };
  const first = await probe();
  const second = await probe();
  return { first, second };
});
if (revalidation.second) {
  ok(
    'a repeat fetch of the prices projection transfers no payload',
    revalidation.second.transfer < 2000,
    `${revalidation.second.transfer} bytes on the wire vs ${revalidation.second.decoded} decoded`
  );
  ok(
    '...and the projection is a fraction of the full feed',
    revalidation.first.decoded > 0 && revalidation.first.decoded < 200_000,
    `${Math.round(revalidation.first.decoded / 1024)}KB`
  );
} else {
  skip('a repeat fetch of the prices projection transfers no payload', 'no /api/earnings on this origin');
}

// The freshness claim has to distinguish "read from the upstream at X" from "confirmed still
// current at Y". Collapsing them would let a five-hour-old figure read as seconds old.
const freshness = await page.evaluate(async () => {
  const feed = await import('./js/data/earnings-live.js');
  const m = feed.meta();
  return m ? { origin: m.origin, checkedAt: m.checkedAt, fetchedAt: m.fetchedAt || null } : null;
});
ok('the feed records where this paint came from', !!freshness?.origin, `origin=${freshness?.origin}`);
ok('...and when the server last confirmed it', Number.isFinite(freshness?.checkedAt), String(freshness?.checkedAt));
const provenance = await page.evaluate(() => {
  document.querySelector('[data-live-info]')?.click();
  return new Promise((r) => setTimeout(() => r(document.querySelector('#modal-content')?.innerText || ''), 400));
});
ok('the Live pill says where the figures came from', /Painted from/.test(provenance));
ok('...and never presents a cached copy as a live one', !/Painted from this device/.test(provenance) || /last confirmed|could not be reached/.test(provenance));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// Con-call: same contract, one channel — nothing on a con-call row moves on a tick, so the
// conditional GET does the whole job there and no projection exists.
await go('/#/research/concall/concall-scans?scope=universe', 400);
await waitForPanel(12000);
await page.waitForTimeout(1200);
const ccStore = await page.evaluate(async () => {
  const s = await import('./js/core/store.js');
  const e = await s.readEntry(s.KEYS.concalls);
  const probe = async () => {
    performance.clearResourceTimings();
    const res = await fetch('api/concalls', { cache: 'no-cache' });
    if (!res.ok) return null;
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 250));
    const t = performance.getEntriesByType('resource').filter((x) => x.name.includes('api/concalls')).pop();
    return t ? { transfer: t.transferSize, decoded: t.decodedBodySize } : null;
  };
  await probe();
  return { has: !!e, rows: e?.value?.rows?.length || 0, second: await probe() };
});
if (ccStore.has) {
  ok('the con-call scan is kept on this device', ccStore.rows > 50, `${ccStore.rows} calls stored`);
  ok('...and a repeat fetch transfers no payload', (ccStore.second?.transfer ?? 1e9) < 2000, `${ccStore.second?.transfer} bytes vs ${ccStore.second?.decoded} decoded`);
} else {
  skip('the con-call scan is kept on this device', 'no /api/concalls on this origin');
}

// The committed snapshots and lookup tables are static files. Fetching them with `no-store` — as
// every loader did — forbids reuse outright and made each visit pay ~800KB again.
const noStore = await page.evaluate(async () => {
  const files = ['js/app.js', 'js/data/technicals.js', 'js/data/portfolio.js', 'js/data/earnings.js', 'js/data/chatter.js'];
  const out = [];
  for (const f of files) {
    const src = await (await fetch(f, { cache: 'no-cache' })).text();
    if (/cache:\s*'no-store'/.test(src)) out.push(f);
  }
  return out;
});
ok('no static-file loader still uses cache: no-store', noStore.length === 0, noStore.join(', '));

// ---------------------------------------------------------------------------------------
console.log('\n— console —');
const unique = [...new Set(errors)];
ok('zero console errors', unique.length === 0, unique.slice(0, 3).join(' | '));

await browser.close();
console.log(failures === 0 ? `\nAll checks passed.${skipped ? ` (${skipped} skipped — see SKIP lines)` : ''}` : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
