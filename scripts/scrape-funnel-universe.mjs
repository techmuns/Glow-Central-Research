// scripts/scrape-funnel-universe.mjs — fill the Screener funnel's ₹1,000–25,000 Cr universe with the
// rich per-company metrics the funnel screens on (3-year growth, OPM, debt/equity, multi-year series),
// which the leaner universe export does not carry. GLOW-OWNED.
//
// Screener's standard company financials are public, but an AUTHENTICATED session gets a much higher
// request budget — essential for a ~1,100-company walk. This logs in once with the SCREENER_USERNAME /
// SCREENER_PASSWORD secrets (the same pair scripts/check-screener-access.mjs verifies), carries the
// session cookie into plain fetches, and reproduces Screener's own figures via the existing pure parser
// (scripts/lib/screener-fundamentals.mjs) — no number is invented. Output is a small FLAT per-ticker
// file the funnel builder overlays; it never bloats the browser feeds.
//
//   node scripts/scrape-funnel-universe.mjs                       # the whole ₹1,000–25,000 universe
//   FUNIV_LIMIT=5 node scripts/scrape-funnel-universe.mjs         # smoke run, first 5 (after login)
//   FUNIV_BAND=1000-25000 node scripts/scrape-funnel-universe.mjs # the band to walk (market cap, Cr)
//   FUNIV_STALE_DAYS=7 node scripts/scrape-funnel-universe.mjs    # re-read only entries older than this
//
// Resumable and honest: a company read this run is stored with its read time; a company that cannot be
// read KEEPS its previous entry (never dropped, never a guessed number) and is recorded in `failed`.
// Credentials are deleted from the environment before Chromium starts and are never logged. No npm dep.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseScreenerFundamentals } from './lib/screener-fundamentals.mjs';

const CSV = 'scripts/fixtures/tracked-universe.csv';
const OUT = 'scripts/fixtures/funnel-universe-rich.json';
const ORIGIN = 'https://www.screener.in';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DELAY_MS = Number(process.env.FUNIV_DELAY_MS || 1400);
const LIMIT = Number(process.env.FUNIV_LIMIT || 0);
const STALE_DAYS = Number(process.env.FUNIV_STALE_DAYS || 7);
const BAND = (process.env.FUNIV_BAND || '1000-25000').split('-').map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null)));
const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function cagr(series, years) {
  if (!Array.isArray(series) || series.length < years + 1) return null;
  const end = series[series.length - 1]; const start = series[series.length - 1 - years];
  if (!Number.isFinite(end) || !Number.isFinite(start) || start <= 0 || end <= 0) return null;
  return round((Math.pow(end / start, 1 / years) - 1) * 100, 1);
}

// The universe to walk: NSE symbols in the market-cap band, from the committed tracked-universe export.
function universeTickers() {
  const lines = readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const h = lines[0].split(',');
  const nse = h.findIndex((x) => x.trim().toLowerCase() === 'nse code');
  const mc = h.findIndex((x) => x.trim().toLowerCase() === 'market capitalization');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); if (p.length !== h.length) continue;
    const t = (p[nse] || '').trim().toUpperCase(); const cap = Number(p[mc]);
    if (t && Number.isFinite(cap) && cap >= BAND[0] && cap <= BAND[1]) out.push(t);
  }
  return [...new Set(out)];
}

// Flatten one parsed company into the funnel's fields — Screener's own growth where it prints it,
// else the compound growth of its own series. Never a 0 for a missing figure.
function flatten(f) {
  const a = f.annual || {}; const g = f.growth || {}; const r = f.ratios || {};
  const sales = a.sales || []; const pat = a.netProfit || a.pat || []; const eps = a.eps || []; const opm = a.opm || [];
  const pick = (v, series, yrs) => (n(v) != null ? round(n(v), 1) : cagr(series, yrs));
  return {
    salesGrowth3y: pick(g.sales?.y3, sales, 3),
    profitVar3y: pick(g.profit?.y3, pat, 3),
    epsGrowth3y: pick(g.eps?.y3, eps, 3),
    epsGrowth5y: pick(g.eps?.y5, eps, 5),
    opmPct: opm.length ? round(opm[opm.length - 1], 1) : null,
    roce: round(n(r.roce), 1), roe: round(n(r.roe), 1),
    debtToEquity: round(n(r.debtToEquity), 2), pe: round(n(r.pe), 2), bookValue: n(r.bookValue),
    revenueSeries: sales.slice(-9), patSeries: pat.slice(-9),
    revenueLy: sales.length ? sales[sales.length - 1] : null, patLy: pat.length ? pat[pat.length - 1] : null,
    readAt: new Date().toISOString(),
  };
}

async function login() {
  const username = process.env.SCREENER_USERNAME; const password = process.env.SCREENER_PASSWORD;
  if (!username || !password) return null;                   // public walk (slower, may rate-limit sooner)
  delete process.env.SCREENER_USERNAME; delete process.env.SCREENER_PASSWORD; delete process.env.PWDEBUG; delete process.env.DEBUG;
  if (!process.env.PLAYWRIGHT_ROOT) throw new Error('PLAYWRIGHT_ROOT not set — cannot authenticate');
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_ROOT, 'index.mjs')).href);
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ acceptDownloads: false });
    const page = await ctx.newPage(); page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(45000);
    await page.goto(`${ORIGIN}/login/?next=${encodeURIComponent('/')}`, { waitUntil: 'domcontentloaded' });
    const form = page.locator('form[action="/login/"]'); await form.waitFor({ state: 'visible' });
    await form.locator('input[name="username"]').fill(username);
    await form.locator('input[name="password"]').fill(password);
    await Promise.all([page.waitForURL(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' }), form.locator('button[type="submit"]').click()]);
    const cookies = await ctx.cookies(ORIGIN);
    const session = cookies.find((c) => c.name === 'sessionid' && c.value);
    if (!session) throw new Error('authentication not verified');
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } finally { await browser.close().catch(() => {}); }
}

async function readCompany(ticker, cookie) {
  for (const path of [`${ticker}/consolidated/`, `${ticker}/`]) {
    let res;
    try { res = await fetch(`${ORIGIN}/company/${path}`, { headers: { 'user-agent': UA, accept: 'text/html', ...(cookie ? { cookie } : {}) }, redirect: 'follow' }); }
    catch (e) { throw Object.assign(new Error('network'), { reason: `network: ${e.message}` }); }
    if (res.status === 429) throw Object.assign(new Error('rate-limited'), { rateLimited: true, reason: 'HTTP 429' });
    if (res.status === 404) continue;
    if (res.status !== 200) throw Object.assign(new Error('http'), { reason: `HTTP ${res.status}` });
    const text = await res.text();
    const basis = /\/consolidated\//.test(res.url) ? 'consolidated' : 'standalone';
    const parsed = parseScreenerFundamentals(text, { symbol: ticker, basis, url: res.url });
    if (parsed && (parsed.ratios?.pe != null || parsed.epsTtm != null || (parsed.annual?.years?.length > 0))) return parsed;
  }
  throw Object.assign(new Error('no-data'), { reason: 'no readable company page' });
}

async function main() {
  let tickers = universeTickers();
  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { companies: {} };
  const companies = { ...(existing.companies || {}) };
  const freshCut = Date.now() - STALE_DAYS * 864e5;
  // Re-read only what is missing or stale, so a scheduled run resumes rather than restarts.
  let todo = tickers.filter((t) => { const e = companies[t]; return !e || !e.readAt || new Date(e.readAt).getTime() < freshCut; });
  if (LIMIT) todo = todo.slice(0, LIMIT);

  const cookie = await login();
  console.log(`[funnel-universe] ${cookie ? 'authenticated' : 'PUBLIC (no secrets — slower)'} walk of ${todo.length} of ${tickers.length} in-band companies (delay ${DELAY_MS}ms).`);

  const failed = []; let ok = 0;
  for (let i = 0; i < todo.length; i++) {
    const t = todo[i];
    try { companies[t] = flatten(await readCompany(t, cookie)); ok++; if (ok % 50 === 0) process.stdout.write(`  …${ok} read\n`); }
    catch (e) { failed.push({ ticker: t, reason: e.reason || e.message }); if (e.rateLimited) { console.log('  rate-limited — backing off 30s'); await sleep(30000); } }
    if (i < todo.length - 1) await sleep(DELAY_MS);
  }

  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Screener.in public company pages, authenticated session for request budget. Reproduced figures; '
      + '3-year growth is Screener\'s own or the compound growth of its own series. No figure is invented.',
    count: Object.keys(companies).length, okThisRun: ok, failedThisRun: failed.length, companies,
  }, null, 2));
  console.log(`[funnel-universe] wrote ${OUT}: ${Object.keys(companies).length} companies (${ok} read this run, ${failed.length} failed). Now run build-funnel-fundamentals.mjs.`);
}

main().catch((e) => { console.error('[funnel-universe] fatal:', e.message); process.exit(1); });
