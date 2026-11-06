// scripts/scrape-screener-fundamentals.mjs — capture authoritative multi-year fundamentals for the
// family's book from Screener.in's PUBLIC company pages, into public/data/fundamentals.json.
//
// Screener is the authoritative source for Indian company fundamentals and the standard financials are
// public (no login). We reproduce its figures (the StockScans / Finology / Trendlyne rule) and the one
// derived thing on top — a fair-value band — is computed in the browser (js/data/fair-value.js) and
// labelled ours. No npm dependency: global fetch (Node 22) + the pure parser in lib/.
//
// Honesty: a company Screener can't be read for is recorded in `failed` with a reason and KEEPS its
// previous record (never dropped, never a guessed number). A run that reads fewer than it should does
// not overwrite a healthier file wholesale — each company is merged in on its own success.
//
//   node scripts/scrape-screener-fundamentals.mjs                # the whole book
//   FUND_LIMIT=3 node scripts/scrape-screener-fundamentals.mjs   # smoke run, first 3
//   FUND_ONLY=BAJAJ-AUTO,TITAN node scripts/scrape-screener-fundamentals.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { parseScreenerFundamentals } from './lib/screener-fundamentals.mjs';

const OUT = 'public/data/fundamentals.json';
const BOOK = 'public/data/portfolio-companies.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DELAY_MS = Number(process.env.FUND_DELAY_MS || 1600);
const LIMIT = Number(process.env.FUND_LIMIT || 0);
const ONLY = (process.env.FUND_ONLY || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (n) => typeof n === 'number' && Number.isFinite(n);

// A parsed page actually carries financials (not a sparse consolidated shell): it has a P/E, or a
// trailing EPS, or at least one year of the annual P&L.
function hasUsableData(f) {
  return fin(f?.ratios?.pe) || fin(f?.epsTtm) || (f?.annual?.years?.length > 0);
}

function bookTickers() {
  const d = JSON.parse(readFileSync(BOOK, 'utf8'));
  const seen = new Set();
  return (d.holdings || []).filter((h) => h.listed !== false && h.ticker && !seen.has(h.ticker) && seen.add(h.ticker))
    .map((h) => ({ ticker: String(h.ticker).toUpperCase(), name: h.name || h.bookName || h.ticker, sector: h.sector || '' }));
}

function loadExisting() {
  try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return { companies: {}, failed: [] }; }
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  const text = await res.text();
  return { status: res.status, url: res.url, text };
}

// Read one company: try consolidated, fall back to standalone. Returns a parsed record or throws with
// a reason. Basis is taken from the URL the page actually resolved to (consolidated can redirect to
// standalone when a company files no consolidated accounts).
async function readCompany(ticker) {
  for (const path of [`${ticker}/consolidated/`, `${ticker}/`]) {
    const url = `https://www.screener.in/company/${path}`;
    let r;
    try { r = await fetchPage(url); } catch (e) { throw Object.assign(new Error('network'), { reason: `network: ${e.message}` }); }
    if (r.status === 429) throw Object.assign(new Error('rate-limited'), { reason: 'rate-limited (HTTP 429)', rateLimited: true });
    if (r.status === 404) continue;                       // try the next path
    if (r.status !== 200) throw Object.assign(new Error('http'), { reason: `HTTP ${r.status}` });
    const basis = /\/consolidated\//.test(r.url) ? 'consolidated' : 'standalone';
    const parsed = parseScreenerFundamentals(r.text, { symbol: ticker, basis, url: r.url });
    // A company that reports only standalone has a near-empty CONSOLIDATED shell: the page exists and
    // has the ratios list, but no P/E, no EPS and no P&L rows. Reject that and fall through to the
    // standalone page, which carries the real figures (banks and many NBFCs are like this).
    if (parsed && hasUsableData(parsed)) return parsed;
  }
  throw Object.assign(new Error('not-a-company'), { reason: 'no readable company page' });
}

async function main() {
  let list = bookTickers();
  if (ONLY.length) list = list.filter((c) => ONLY.includes(c.ticker));
  if (LIMIT) list = list.slice(0, LIMIT);
  console.log(`[fundamentals] reading ${list.length} companies from Screener (delay ${DELAY_MS}ms)…`);

  const existing = loadExisting();
  const companies = { ...(existing.companies || {}) };
  const failed = [];
  let ok = 0;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      const rec = await readCompany(c.ticker);
      rec.sector = c.sector || rec.sector || '';
      companies[c.ticker] = rec;
      ok += 1;
      process.stdout.write(`  ✓ ${c.ticker} (P/E ${rec.ratios.pe ?? '—'}, ROE ${rec.ratios.roe ?? '—'}, EPS ${rec.epsTtm ?? '—'})\n`);
    } catch (e) {
      failed.push({ ticker: c.ticker, name: c.name, reason: e.reason || e.message });
      process.stdout.write(`  ✗ ${c.ticker} — ${e.reason || e.message}${companies[c.ticker] ? ' (kept previous)' : ''}\n`);
      if (e.rateLimited) { console.log('  …backing off 30s after a rate-limit'); await sleep(30000); }
    }
    if (i < list.length - 1) await sleep(DELAY_MS);
  }

  const out = {
    _provenance: 'REAL DATA from Screener.in public company pages (no login). Multi-year financials and '
      + 'ratios are Screener\'s own figures, reproduced, in Rs crore / % as they publish them. The fair-value '
      + 'band shown on the dashboard is derived from these by js/data/fair-value.js and is labelled ours — '
      + 'not a Screener figure and not a price target.',
    source: 'https://www.screener.in/company/<SYMBOL>/',
    fetchedAt: new Date().toISOString(),
    count: Object.keys(companies).length,
    okThisRun: ok,
    companies,
    failed,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[fundamentals] wrote ${OUT}: ${out.count} companies (${ok} read this run, ${failed.length} failed).`);
}

main().catch((e) => { console.error('[fundamentals] fatal', e); process.exit(1); });
