#!/usr/bin/env node
// Explicit output directory: staging checks cannot accidentally overwrite the deployed capture.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson } from './lib/company-capture.mjs';
import { archiveFilings } from './lib/filing-archive.mjs';
import { collectScreenerAnnouncements, screenerRecoveryCheckpoint, SCREENER_ANNOUNCEMENTS_URL } from './lib/screener-announcements.mjs';
import { mergeAnnouncements } from '../public/js/data/announcements-shared.js';
import { createAnnouncementIdentity, mergeExchangeIdentities } from '../public/js/data/announcement-identity.js';

const output = process.argv[2];
if (!output) throw Error('Provide a staging or scheduled-capture data directory');
const dataDir = resolve(output), path = join(dataDir, 'screener-announcements.json');
const sourceData = resolve('public/data');
const previous = screenerRecoveryCheckpoint(readJson(path));
const directories = readJson(join(sourceData, 'filing-capture/nse-identities.json'), {}).directories || {};
const identity = createAnnouncementIdentity(mergeExchangeIdentities(
  readJson(join(sourceData, 'announcement-identities.json'), {}).entries || [],
  directories.sme?.entries || [], directories.equity?.entries || [],
));
const now = process.env.ANN_CHECK_TO ? () => Date.parse(process.env.ANN_CHECK_TO) : Date.now;
if (!Number.isFinite(now())) throw Error('Invalid staging check date');
if ((process.env.ANN_CHECK_TO || process.env.ANN_CHECK_FROM) && dataDir === sourceData) throw Error('A fixed-date check must use a staging directory');
const bse = readJson(join(sourceData, 'corp-announcements.json'), {});
const overlapStart = new Date(now() - 7 * 86400000).toISOString();
const bseStart = bse.lastCompleteTo && new Date(Date.parse(`${bse.lastCompleteTo}T00:00:00+05:30`) - 2 * 86400000).toISOString();
const initialFrom = process.env.ANN_CHECK_FROM || (bseStart && bseStart < overlapStart ? bseStart : overlapStart);
const username = process.env.SCREENER_USERNAME, password = process.env.SCREENER_PASSWORD;
const runtime = process.env.PLAYWRIGHT_ROOT;
delete process.env.SCREENER_USERNAME;
delete process.env.SCREENER_PASSWORD;
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.DEBUG;
delete process.env.PWDEBUG;
let browser, page, loginPromise, stagingMarkup, sourceTime = Date.now();

const refusal = (reason, response) => {
  const error = Object.assign(Error('Announcement source unavailable'), { captureReason: reason });
  const retry = response?.headers?.()['retry-after'];
  if (retry) error.retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
  return error;
};

async function login() {
  if (!username || !password || !runtime) throw refusal('missing-configuration');
  const { chromium } = await import(pathToFileURL(resolve(runtime, 'index.mjs')).href);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ acceptDownloads: false });
  page = await context.newPage();
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(30000);
  const response = await page.goto(`https://www.screener.in/login/?next=${encodeURIComponent('/announcements/all/')}`, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw refusal('login-unavailable', response);
  const form = page.locator('form[action="/login/"]');
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL(url => url.origin === 'https://www.screener.in' && url.pathname === '/announcements/all/', { waitUntil: 'domcontentloaded' }),
    form.locator('button[type="submit"]').click(),
  ]);
  if (!(await context.cookies('https://www.screener.in')).some(c => c.name === 'sessionid' && c.value)
    || !await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count()) throw refusal('session-unverified');
}

async function readPage(cursor) {
  loginPromise ||= login();
  await loginPromise;
  const url = new URL(cursor, SCREENER_ANNOUNCEMENTS_URL).href;
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw refusal([401, 403, 429].includes(response?.status()) ? 'refused' : 'upstream', response);
  const arrived = new URL(page.url());
  if (arrived.origin !== 'https://www.screener.in' || arrived.pathname !== '/announcements/all/' || arrived.search !== new URL(url).search
    || !await page.locator('a[href^="/logout/"], form[action^="/logout/"]').count()) throw refusal('session-unverified');
  // Read the navigation's original bytes; browser DOM repair cannot certify a truncated response.
  sourceTime = Date.parse(response.headers().date || '');
  if (!Number.isFinite(sourceTime) || Math.abs(Date.now() - sourceTime) > 10 * 60000) throw refusal('source-clock-unverified');
  const body = await response.body();
  if (body.length > 2 * 1024 * 1024) throw refusal('oversized');
  await new Promise(done => setTimeout(done, 350));
  const html = body.toString('utf8');
  if (dataDir !== sourceData) stagingMarkup = html;
  return html;
}

let rows = previous?.rows || [], buffered = [], pagesSinceWrite = 0;
const checkpoint = async (state, incoming, { force = false } = {}) => {
  buffered.push(...incoming.map(identity.row));
  if (!force && ++pagesSinceWrite < 5) return;
  // Archive first. A crash between these writes replays the same pages with idempotent identities.
  if (buffered.length) {
    archiveFilings(join(dataDir, 'announcements-archive'), 'announcements', buffered);
    rows = mergeAnnouncements(rows, buffered);
    buffered = [];
  }
  const cutoff = new Date(now() - 7 * 86400000).toISOString().slice(0, 10);
  rows = rows.filter(row => !row.date || row.date >= cutoff);
  writeJson(path, { ...state, source: 'Screener all-announcements index', scope: 'publisher-index',
    coverageNote: 'Publisher-discovered exchange notices. Successful indexed windows do not certify complete BSE/NSE coverage.',
    pendingCount: state.pending.length, unavailableDocuments: rows.filter(r => r.documentUnavailable).length, rowCount: rows.length, rows });
  pagesSinceWrite = 0;
};

try {
  const state = await collectScreenerAnnouncements({ previous, readPage, checkpoint, now, initialFrom, sourceNow: () => sourceTime,
    maxPages: Number(process.env.ANN_MAX_PAGES || 600), budgetMs: Number(process.env.ANN_BUDGET_MS || 12 * 60000) });
  console.log(JSON.stringify({ pages: state.pagesThisRun, rows: rows.length, pending: state.pending.length, error: state.error?.reason || null }));
  if (state.error) {
    // Only public filing metadata is diagnostic; never print authenticated markup or forms.
    if (stagingMarkup) console.log(JSON.stringify({ sourceShape: {
      dateLabels: [...stagingMarkup.matchAll(/<div\b[^>]*>([^<>]{1,80})<\/div\s*>/gi)].map(m => m[1].trim()),
      cards: stagingMarkup.split(/<div\b[^>]*class=["'][^"']*\bannouncement-item\b[^"']*["'][^>]*>/i).slice(1).map(chunk =>
        [...chunk.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].slice(0, 2).map(m => {
          const href = /\bhref=["']([^"']*)["']/.exec(m[1])?.[1];
          let path = 'missing';
          try { const u = new URL(href, SCREENER_ANNOUNCEMENTS_URL); path = `${u.protocol}//${u.hostname}${u.pathname}`; } catch {}
          return { path, label: m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) };
        }))
    } }));
    process.exitCode = 1;
  }
} finally { await browser?.close(); }
