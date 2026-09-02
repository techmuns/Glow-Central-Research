// verify-sdk.mjs — the Munshot Dashboard SDK integration, driven against the REAL shipped bundle.
//
//   node scripts/verify-sdk.mjs [base]        # default http://127.0.0.1:8080
//
// WHY THIS IS ITS OWN FILE AND NOT PART OF verify-ui.mjs. Everything here needs the dashboard
// loaded INSIDE AN IFRAME with a host on the other end of the channel, which is a different
// fixture from the top-level page every other check drives. Running it separately also means the
// handshake is asserted whether or not the sandbox can reach the rest of the suite's CDNs.
//
// AND WHY IT USES THE REAL BUNDLE RATHER THAN A STAND-IN. The failure this exists to catch is a
// handshake that completes in a stub and not in production — a manual `ready()` racing `host:init`,
// a client built too late to hear it, a payload the channel silently drops. A stand-in written from
// the same reading of the docs as the code would agree with the code and prove nothing. So the
// bundle is fetched once from the Munshot CDN and served to the page from disk: identical bytes,
// no dependence on the browser being able to reach S3 (measured: `curl` and node can, Chromium in
// this sandbox cannot).
//
// The one thing it does stub is the HOST — because that is the thing under test's counterparty, and
// its protocol is fixed by the bundle: envelopes are
// `{ namespace: 'munshot-dashboard-sdk', version, channelId, source, kind, timestamp, payload }`,
// `host:request` carries `requestId` and a `{ topic, data }` payload, and answers come back as
// `dashboard:response` with `{ requestId, ok, topic, data | error }`.

import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const PW_ROOT = process.env.PLAYWRIGHT_ROOT || '/opt/node22/lib/node_modules/playwright';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SDK_URL = 'https://munshot.s3.ap-south-1.amazonaws.com/SDK+script/munshot-dashboard-sdk.v1.0.0.min.js';
const HOST_PAGE = `${BASE}/__sdk-host-fixture.html`;

// A token shaped like the JWT the host sends. It is not a credential and reaches nothing: every
// request in this run is served from the local static origin.
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZXJpZnktc2RrIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
const TEST_TICKER = 'BIOCON';
const TEST_COMPANY = 'Biocon Ltd';

let chromium;
try {
  ({ chromium } = await import(`${PW_ROOT}/index.mjs`));
} catch {
  console.error('Playwright not found. Set PLAYWRIGHT_ROOT to your install.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (label, cond, detail = '') => {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
};
const skip = (label, why) => {
  skipped += 1;
  console.log(`SKIP  ${label}  — ${why}`);
};

// ---- The SDK bundle -------------------------------------------------------------------------

let sdkSource = null;
try {
  const res = await fetch(SDK_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  sdkSource = await res.text();
} catch (err) {
  // Last resort: a copy a previous run left behind. Never a stand-in — see the header.
  try {
    sdkSource = readFileSync('/tmp/munshot-dashboard-sdk.v1.0.0.min.js', 'utf8');
  } catch {
    sdkSource = null;
  }
  if (!sdkSource) {
    console.log(`SKIP  the whole SDK handshake  — the Munshot CDN is unreachable from here (${err.message}); refusing to assert against a stand-in`);
    process.exit(0);
  }
}
ok('the shipped SDK bundle exposes createDashboardClientSdk', sdkSource.includes('createDashboardClientSdk'), `${sdkSource.length} bytes`);

// html-to-image, the one runtime dependency of the visual capture. Fetched here and served to the
// page from memory for the same reason as the SDK: node and curl reach this CDN from the sandbox
// and Chromium does not, and the Blob path is the half of that handler worth proving. If it cannot
// be had, the run still asserts the failure branch — a handler that answers rather than hangs.
const HTML_TO_IMAGE_CDN = 'https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js';
let htmlToImageSource = null;
try {
  const res = await fetch(HTML_TO_IMAGE_CDN);
  if (res.ok) htmlToImageSource = await res.text();
} catch {
  htmlToImageSource = null;
}

// The host fixture. Same origin as the dashboard so nothing here depends on a cross-origin quirk;
// the SDK is origin-agnostic (`targetOrigin` defaults to '*' and locks to the first host seen).
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SDK host fixture</title></head><body>
<script>
  const NS = 'munshot-dashboard-sdk';
  const VERSION = '1.0.0';
  window.__host = {
    channelId: 'verify-sdk-channel-1',
    ready: [],          // every dashboard:ready envelope seen
    responses: {},      // requestId -> payload
    messages: [],       // every envelope from the dashboard
  };
  const frame = document.createElement('iframe');
  frame.id = 'dash';
  frame.style.cssText = 'width:1440px;height:900px;border:0';
  frame.src = ${JSON.stringify(`${BASE}/index.html`)};
  document.body.appendChild(frame);

  const envelope = (kind, payload, requestId) => ({
    namespace: NS, version: VERSION, channelId: window.__host.channelId,
    source: 'host', kind, timestamp: Date.now(),
    ...(requestId ? { requestId } : {}), payload,
  });

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.namespace !== NS || data.source !== 'dashboard') return;
    window.__host.messages.push(data);
    if (data.kind === 'dashboard:ready') window.__host.ready.push(data);
    if (data.kind === 'dashboard:response') {
      const p = data.payload || {};
      if (p.requestId) window.__host.responses[p.requestId] = p;
    }
  });

  // Post host:init only once the iframe document has loaded, which is what the real host does.
  window.__host.init = (context) =>
    frame.contentWindow.postMessage(envelope('host:init', { context }), '*');
  window.__host.update = (context) =>
    frame.contentWindow.postMessage(envelope('host:context:update', { context }), '*');
  window.__host.ask = (topic, data, requestId) => {
    frame.contentWindow.postMessage(envelope('host:request', { topic, data }, requestId), '*');
    return requestId;
  };
</script>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message)));

// Requests the dashboard's own JS made, so the Authorization checks read what actually went out.
const sent = [];
await context.route('**/*', async (route) => {
  const req = route.request();
  const url = req.url();
  if (url === SDK_URL) {
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: sdkSource });
  }
  if (url === HOST_PAGE) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: hostHtml });
  }
  if (url === HTML_TO_IMAGE_CDN && htmlToImageSource) {
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: htmlToImageSource });
  }
  if (url.startsWith(BASE)) sent.push({ url, auth: req.headers()['authorization'] || null });
  return route.continue();
});

await page.goto(HOST_PAGE, { waitUntil: 'load' });
const frame = page.frameLocator('#dash');
// The dashboard boots from committed JSON; wait for the shell rather than sleeping.
await frame.locator('#content-host').waitFor({ state: 'attached', timeout: 30000 });

// The dashboard's own realm. Everything below that needs to see module state reaches it with a
// dynamic `import()` INSIDE this frame rather than through a hook exported for the test: an ES
// module registry is keyed by URL per realm, so importing `host-context.js` here returns the very
// instance the app is running on. Production code carries nothing it would not otherwise have.
const dash = page.frames().find((f) => f.url().startsWith(BASE) && f.url().includes('index.html'));
if (!dash) {
  console.log('FAIL  the dashboard iframe could not be found');
  await browser.close();
  process.exit(1);
}

// ---- 1. The handshake -------------------------------------------------------------------------

const sdkPresent = await page.evaluate(() => {
  const w = document.querySelector('#dash').contentWindow;
  return { global: typeof w.MunshotDashboardSDK, factory: typeof w.MunshotDashboardSDK?.createDashboardClientSdk };
});
ok('the dashboard loads the SDK as a classic script, so the factory is on the global',
  sdkPresent.global === 'object' && sdkPresent.factory === 'function',
  `global=${sdkPresent.global} factory=${sdkPresent.factory}`);

// NOTHING may be sent before host:init. This is the check that catches a manual `ready()` fired
// from a mount effect: it would already be in this list, with a channel the host cannot match.
const beforeInit = await page.evaluate(() => window.__host.messages.map((m) => m.kind));
ok('nothing is sent to the host before host:init arrives',
  beforeInit.length === 0, beforeInit.length ? beforeInit.join(', ') : 'no messages');

await page.evaluate(([token, ticker, company]) => window.__host.init({
  session: { token, userName: 'Verify Runner', email: 'verify@example.com', orgId: 'org-1', orgName: 'Verify Org' },
  market: { selectedTicker: ticker, selectedTickerCompany: company, selectedTickerCountry: 'IN', selectedSymbol: `NSE:${ticker}` },
  app: { route: '/dashboard', query: null, viewMode: 'grid', selectedCategory: null, searchQuery: null },
}), [TEST_TOKEN, TEST_TICKER, TEST_COMPANY]);

await page.waitForFunction(() => window.__host.ready.length > 0, null, { timeout: 10000 }).catch(() => {});
const ready = await page.evaluate(() => window.__host.ready);
ok('the SDK answers host:init with dashboard:ready, on the host\'s own channel',
  ready.length === 1 && ready[0].channelId === 'verify-sdk-channel-1',
  `${ready.length} ready message(s)${ready[0] ? ` · channel ${ready[0].channelId}` : ''}`);
ok('...and exactly one, so autoReady was left on and ready() was never called by hand',
  ready.length === 1, `${ready.length}`);
ok('...naming this dashboard rather than a placeholder',
  ready[0]?.payload?.data?.dashboardId === 'sattva-central-research',
  ready[0]?.payload?.data?.dashboardId || 'none');

// ---- 2. Context reaches the app ---------------------------------------------------------------

const readContext = () => dash.evaluate(async () => {
  const m = await import('/js/core/host-context.js');
  const c = m.getHostContext();
  return { token: m.hostToken(), ticker: m.hostTicker(), company: c.tickerCompany, received: c.received };
});
const ctx = await readContext();
ok('the app reads session and market context through getContext()',
  ctx && ctx.token === TEST_TOKEN && ctx.ticker === TEST_TICKER && ctx.company === TEST_COMPANY,
  ctx ? `token ${ctx.token ? 'present' : 'MISSING'} · ticker ${ctx.ticker} · ${ctx.company}` : 'probe unavailable');

// The host's selection has to be visible, or receiving it means nothing.
const chip = await frame.locator('[data-host-ticker]').innerText().catch(() => '');
ok('the host\'s selected company is named in the dashboard header',
  chip.includes(TEST_COMPANY) || chip.includes(TEST_TICKER), chip.replace(/\s+/g, ' ').trim() || 'no chip');

// A later selection must re-sync — this is the half a listen-forward-only implementation gets right
// and a read-once implementation gets wrong.
await page.evaluate(() => window.__host.update({
  market: { selectedTicker: 'RELIANCE', selectedTickerCompany: 'Reliance Industries Ltd', selectedTickerCountry: 'IN', selectedSymbol: 'NSE:RELIANCE' },
}));
await page.waitForTimeout(300);
const chip2 = await frame.locator('[data-host-ticker]').innerText().catch(() => '');
ok('a host:context:update repoints it without a reload',
  chip2.includes('Reliance') || chip2.includes('RELIANCE'), chip2.replace(/\s+/g, ' ').trim() || 'no chip');

// A logout clears the token and must not leave a stale credential behind.
await page.evaluate(() => window.__host.update({ session: { token: null, userName: null, email: null, orgId: null, orgName: null } }));
await page.waitForTimeout(200);
const afterLogout = await readContext();
ok('a logout pushed by the host clears the token rather than leaving the old one in place',
  afterLogout && afterLogout.token === null, afterLogout ? String(afterLogout.token) : 'probe unavailable');
ok('...and the dashboard keeps rendering rather than showing a page-level error',
  await frame.locator('#content-host').isVisible(), 'content host still visible');

// Put the session back for the request checks below.
await page.evaluate(([token, ticker, company]) => window.__host.update({
  session: { token, userName: 'Verify Runner', email: 'verify@example.com', orgId: 'org-1', orgName: 'Verify Org' },
  market: { selectedTicker: ticker, selectedTickerCompany: company, selectedTickerCountry: 'IN', selectedSymbol: `NSE:${ticker}` },
}), [TEST_TOKEN, TEST_TICKER, TEST_COMPANY]);
await page.waitForTimeout(200);

// ---- 3. Who gets the Authorization header, and who must not -----------------------------------

sent.length = 0;
// Drive REAL call sites rather than the helper on its own: `searchCompanies` is the scope editor's
// client for `api/stock-search`, `conditionalJson` is the shared path every polled feed takes, and
// `revalidatedJson` is how every committed file is read. A test that only called `authHeaders`
// would prove the helper works and say nothing about whether anything uses it.
await dash.evaluate(async () => {
  const [{ searchCompanies }, store] = await Promise.all([
    import('/js/data/stock-search.js'),
    import('/js/core/store.js'),
  ]);
  await searchCompanies('reliance').catch(() => {});          // -> api/stock-search
  await store.conditionalJson('api/earnings', { optional: true }).catch(() => {});
  await store.conditionalJson('api/concalls', { optional: true }).catch(() => {});
  await store.revalidatedJson('data/portfolio-companies.json', { optional: true }).catch(() => {});
});
await page.waitForTimeout(800);

const apiReqs = sent.filter((r) => /\/api\//.test(r.url));
const staticReqs = sent.filter((r) => /\/(data|js|css)\//.test(r.url));
ok('every Munshot API request carries the host session token as a bearer',
  apiReqs.length > 0 && apiReqs.every((r) => r.auth === `Bearer ${TEST_TOKEN}`),
  `${apiReqs.filter((r) => r.auth === `Bearer ${TEST_TOKEN}`).length}/${apiReqs.length} api request(s)`);
ok('...and no committed static file does, so a cached asset is never varied by a credential',
  staticReqs.length > 0 && staticReqs.every((r) => !r.auth),
  `${staticReqs.filter((r) => r.auth).length} of ${staticReqs.length} static request(s) carried one`);

// The predicate itself, at the boundaries. A third-party origin getting the reader's JWT is the
// failure that matters most here and it cannot be produced by a page that happens not to call one.
const predicate = await dash.evaluate(async () => {
  const { authHeaders } = await import('/js/core/host-context.js');
  const has = (p) => !!authHeaders(p).authorization;
  return {
    ownApi: has('api/earnings'),
    munsAbsolute: has('https://fastapi.muns.io/market_data?ticker=RELIANCE'),
    staticFile: has('data/portfolio-companies.json'),
    // The two third-party origins this dashboard genuinely calls from the browser.
    deepDive: has('https://concall-sattva.tech-441.workers.dev/api/summary'),
    chatter: has('https://sentimentdash-api.tech-441.workers.dev/v1/health'),
    // A hostname that merely ENDS in something similar must not pass for the real one.
    lookalike: has('https://muns.io.evil.example/api/steal'),
  };
});
ok('the allow-list refuses every non-Munshot address',
  predicate
    && predicate.ownApi === true
    && predicate.munsAbsolute === true
    && predicate.staticFile === false
    && predicate.deepDive === false
    && predicate.chatter === false
    && predicate.lookalike === false,
  predicate ? JSON.stringify(predicate) : 'probe unavailable');

// ---- 4. The two capture handlers --------------------------------------------------------------

const snapshot = await page.evaluate(async () => {
  const id = 'req-snapshot-1';
  window.__host.ask('dashboard.capture.snapshot', {}, id);
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (window.__host.responses[id]) return window.__host.responses[id];
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
});
ok('dashboard.capture.snapshot answers the host', !!snapshot && snapshot.ok === true,
  snapshot ? `ok=${snapshot.ok}${snapshot.error ? ` ${snapshot.error.message}` : ''}` : 'no response within 8s');
const snapData = snapshot?.data || {};
ok('...in the documented { context, selection, data } shape',
  !!snapData.context && !!snapData.selection && !!snapData.data,
  Object.keys(snapData).join(', ') || 'empty');
ok('...naming the scope and route, which is what makes a captured number readable later',
  typeof snapData.context?.scope === 'string' && typeof snapData.context?.route === 'string',
  `scope=${snapData.context?.scope} route=${snapData.context?.route}`);
ok('...and carrying the host ticker it was told about',
  snapData.context?.hostTicker === TEST_TICKER, String(snapData.context?.hostTicker));
const snapBytes = JSON.stringify(snapData).length;
ok('...well inside the 512KB the channel will carry', snapBytes < 512 * 1024, `${snapBytes} bytes`);

const visual = await page.evaluate(async () => {
  const id = 'req-visual-1';
  window.__host.ask('dashboard.capture.visual', {}, id);
  const started = Date.now();
  while (Date.now() - started < 25000) {
    if (window.__host.responses[id]) {
      const p = window.__host.responses[id];
      const blob = p?.data?.visualSnapshot;
      return {
        ok: p.ok,
        isBlob: blob instanceof Blob,
        type: blob?.type || null,
        size: blob?.size || 0,
        capturedAt: p?.data?.capturedAt || null,
        error: p?.data?.error || p?.error?.message || null,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
});
if (!visual) {
  ok('dashboard.capture.visual answers the host', false, 'no response within 25s');
} else if (visual.isBlob) {
  ok('dashboard.capture.visual returns a real PNG Blob of the content region',
    visual.isBlob && visual.type.includes('png') && visual.size > 0,
    `${visual.type} · ${visual.size} bytes`);
  ok('...stamped with a capture time', typeof visual.capturedAt === 'string' && !Number.isNaN(Date.parse(visual.capturedAt)), String(visual.capturedAt));
} else {
  // html-to-image is fetched from a CDN on demand, exactly as exceljs is. Without egress the
  // handler must still ANSWER — a structured failure, never a throw and never a timeout, because
  // those two are indistinguishable to the host.
  skip('dashboard.capture.visual returns a PNG Blob', `html-to-image CDN unreachable (${visual.error || 'no blob'})`);
  ok('...and a capture that cannot run answers with a structured error rather than timing out',
    visual.ok === true && typeof visual.error === 'string' && visual.error.length > 0,
    `ok=${visual.ok} error=${visual.error}`);
}

// An unregistered topic must be answered too — proving the handlers were registered on the
// channel rather than merely defined.
const unknown = await page.evaluate(async () => {
  const id = 'req-unknown-1';
  window.__host.ask('dashboard.capture.nothing-like-this', {}, id);
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (window.__host.responses[id]) return window.__host.responses[id];
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
});
ok('an unregistered topic is refused by name, which proves the two real ones are registered',
  unknown && unknown.ok === false && /NO_REQUEST_HANDLER/.test(unknown.error?.code || ''),
  unknown ? `${unknown.ok} ${unknown.error?.code}` : 'no response');

// ---- 5. Nothing broke on the way --------------------------------------------------------------

ok('the dashboard threw nothing while all of that happened', pageErrors.length === 0,
  pageErrors.slice(0, 3).join(' | ') || 'no page errors');

await browser.close();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
