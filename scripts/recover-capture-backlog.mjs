#!/usr/bin/env node
// RECOVER THE CAPTURES THAT NEVER REACHED MAIN.
//
// Between 9 and 17 September 2026 every scheduled capture opened its own `codex/data-*` branch and
// none of them merged, because the shared `browser` check was red on main and the review gate could
// not clear a bot-authored pull request. The collectors went on running, so the branches are real
// captures — but each one was cut from the SAME stale main, and each carries only what its own run
// could see. A feed whose upstream publishes a rolling window therefore has a DIFFERENT few days in
// every branch, and the newest branch is not a superset of the older ones.
//
// Measured on the shipped branches: taking only the newest capture of each feed would have dropped
// 2,343 market-news stories, six whole days of NSE filing shards and 294 corporate actions. That is
// exactly the silent discard `news-store.mjs` and `filing-archive.mjs` were written to prevent,
// arriving from outside the collectors rather than inside them.
//
// So this walks the branches in chronological order, unions each feed by that feed's OWN identity,
// and writes the result back through that feed's OWN writer. It invents nothing, fetches nothing
// from any publisher, and is re-runnable: a second pass over the same branches is a no-op.
//
// Usage:  node scripts/recover-capture-backlog.mjs [--feed <id>] [--limit N] [--dry-run]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNewsJson } from './lib/news-json-storage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'public/data');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).trim();

/** Every capture branch, oldest first: the order they were captured is the order they merge in. */
export function captureBranches() {
  return git('for-each-ref', '--sort=committerdate', '--format=%(refname:short)\t%(committerdate:iso-strict)\t%(subject)',
    'refs/remotes/origin/codex/data-*').split('\n').filter(Boolean)
    .map(line => { const [ref, when, subject] = line.split('\t'); return { ref, when, subject }; });
}

/**
 * A branch's own change, never a diff against today's main — main has moved since.
 *
 * Some capture branches chain onto another capture branch that has since been deleted, so their
 * parent commit is simply not in this clone and `<ref>^` cannot be resolved. That is a fact about
 * what was fetched, not about the branch, so it returns NULL rather than an empty list: a caller
 * reading null as "nothing changed" would silently skip a real capture, which is the same class of
 * error as reading a failed request as an empty result. Callers treat null as "read it anyway".
 */
const changedFiles = (ref) => {
  try { return git('diff', '--name-only', `${ref}^`, ref, '--', 'public/data').split('\n').filter(Boolean); }
  catch { return null; }
};
const touches = (files, test) => files === null || files.some(test);

/** Materialise just the paths a feed needs, so a branch costs its own files and nothing else. */
function checkoutPaths(ref, paths) {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'glow-recover-'));
  if (!paths.length) return dir;
  const tar = execFileSync('git', ['archive', ref, '--', ...paths], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1024 * 1024 * 1024 });
  return dir;
}

const readJson = (path, fallback = null) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value)}\n`); };
export const MONTH_SHARD = /^(\d{4}-\d{2})\.json$/;
export const DAY_SHARD = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * MARKET NEWS — the feed that proved the problem.
 *
 * `news-store.commit()` already merges into whatever shards are on disk and rebuilds the bounded
 * head from the union, so the whole recovery is: hand it every story every branch holds, plus
 * every story already committed, oldest first so the newest capture of a story wins. Nothing is
 * trimmed that was not already trimmed — the head is a window, the shards are the history.
 */
async function recoverMarketNews(branches, { dryRun }) {
  const store = await import('./lib/news-store.mjs');
  const onDisk = store.loadEverything();
  const merged = new Map([...onDisk.all]);
  let newestHead = null, seen = 0;
  for (const { ref } of branches) {
    if (!touches(changedFiles(ref), f => f === 'public/data/market-news.json' || f.startsWith('public/data/market-news/'))) continue;
    const dir = checkoutPaths(ref, ['public/data/market-news.json', 'public/data/market-news']);
    try {
      const head = readNewsJson(join(dir, 'public/data/market-news.json'), null);
      if (head) { newestHead = head; for (const a of head.articles || []) merged.set(store.keyOf(a), a); }
      const shardDir = join(dir, 'public/data/market-news');
      for (const name of existsSync(shardDir) ? readdirSync(shardDir) : []) {
        if (!MONTH_SHARD.test(name)) continue;
        for (const a of readNewsJson(join(shardDir, name), { articles: [] }).articles || []) merged.set(store.keyOf(a), a);
      }
      seen += 1;
      if (seen % 25 === 0) process.stderr.write(`market-news: ${seen} captures read, ${merged.size} stories\n`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const before = onDisk.all.size;
  if (dryRun) return { feed: 'market-news', branches: seen, before, after: merged.size, added: merged.size - before, wrote: false };
  const result = store.commit({
    articles: [...merged.values()],
    capturedAt: newestHead?.capturedAt || new Date().toISOString(),
    sources: newestHead?.sources || [],
    head: newestHead?.keep || 600,
  });
  return { feed: 'market-news', branches: seen, before, after: merged.size, added: merged.size - before,
    head: result.kept.length, archived: result.archived, wrote: true };
}

/**
 * NSE FILINGS — one shard per day, and the branches hold DIFFERENT days.
 *
 * Each run appends the day it read to the 9 September base, so the newest branch carries 03, 04,
 * 07, 08, 09 and 16 and nothing between. `archiveNseFilings` merges a list of captures into the
 * shards already on disk and rebuilds the index, so every branch's shards and its own capture
 * snapshot go in together and each day lands in its own file. `nse-announcements.json` is the
 * bounded live snapshot rather than history, so the newest branch's copy is taken as it is.
 */
async function recoverNseFilings(branches, { dryRun }) {
  const { archiveNseFilings } = await import('./lib/nse-history.mjs');
  const captures = [];
  let newestSnapshot = null, seen = 0;
  for (const { ref, when } of branches) {
    if (!touches(changedFiles(ref), f => f.startsWith('public/data/nse-filings/') || f === 'public/data/nse-announcements.json')) continue;
    const dir = checkoutPaths(ref, ['public/data/nse-announcements.json', 'public/data/nse-filings']);
    try {
      const snapshot = readJson(join(dir, 'public/data/nse-announcements.json'));
      if (snapshot) { newestSnapshot = snapshot; captures.push(snapshot); }
      const shardDir = join(dir, 'public/data/nse-filings');
      const index = readJson(join(shardDir, 'index.json'), {});
      for (const name of existsSync(shardDir) ? readdirSync(shardDir) : []) {
        if (!DAY_SHARD.test(name) && name !== 'undated.json') continue;
        const shard = readJson(join(shardDir, name), null);
        if (shard?.rows?.length) captures.push({ capturedAt: index.capturedAt || when, rows: shard.rows });
      }
      seen += 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const before = readJson(join(DATA, 'nse-filings/index.json'), { count: 0, days: [] });
  if (dryRun || !captures.length) {
    return { feed: 'nse-filings', branches: seen, before: before.count, captures: captures.length, wrote: false };
  }
  const after = archiveNseFilings(DATA, captures);
  if (newestSnapshot) writeJson(join(DATA, 'nse-announcements.json'), newestSnapshot);
  return { feed: 'nse-filings', branches: seen, before: before.count, after: after.count,
    added: after.count - before.count, days: after.days.length, daysBefore: before.days.length, wrote: true };
}

/**
 * COMPANY NEWS and TRADINGVIEW NEWS — one writer, two archives.
 *
 * Both are written by `company-news-archive.mjs`, which merges incoming articles into the shards
 * already on disk and never lets a successful empty read delete an earlier article. So the union of
 * every branch's archive rows goes back through that same writer, under its own directory and
 * prefix. The entity registry and query watermarks are taken from the NEWEST branch: they describe
 * what the collector currently covers, not history, and an older copy would walk coverage backwards.
 */
function companyArchiveRecovery({ id, dir, prefix, extraPaths = [] }) {
  return async function recover(branches, { dryRun }) {
    const archive = await import('./lib/company-news-archive.mjs');
    const target = join(DATA, dir);
    const before = archive.companyNewsArchiveRows(target);
    const merged = new Map(before.map(row => [archive.companyArticleKey(row), row]));
    let newestIndex = null, newestCapturedAt = null, seen = 0;
    for (const { ref } of branches) {
      if (!touches(changedFiles(ref), f => f.startsWith(`public/data/${dir}/`))) continue;
      const checkout = checkoutPaths(ref, [`public/data/${dir}`, ...extraPaths]);
      try {
        const source = join(checkout, 'public/data', dir);
        for (const row of archive.companyNewsArchiveRows(source)) merged.set(archive.companyArticleKey(row), row);
        const index = readJson(join(source, 'index.json'));
        if (index) { newestIndex = index; newestCapturedAt = index.updatedAt || index.capturedAt || newestCapturedAt; }
        seen += 1;
      } finally { rmSync(checkout, { recursive: true, force: true }); }
    }
    if (dryRun) return { feed: id, branches: seen, before: before.length, after: merged.size, added: merged.size - before.length, wrote: false };
    const result = archive.commitCompanyNewsArchive({
      dir: target, articles: [...merged.values()],
      entities: newestIndex?.entities || archive.readCompanyNewsIndex(target).entities || [],
      queries: newestIndex?.queries ?? null,
      capturedAt: newestCapturedAt || new Date().toISOString(),
      archivePrefix: prefix,
    });
    return { feed: id, branches: seen, before: before.length, after: merged.size,
      added: merged.size - before.length, articleCount: result?.articleCount ?? merged.size, wrote: true };
  };
}

/**
 * CORPORATE ACTIONS — one flat file with a stable row id, so the union is the whole recovery.
 *
 * There is no library writer for it; the envelope is the newest branch's, because it describes that
 * run's own request window and source counts. Only the two figures derived from the rows themselves
 * are recomputed, and `rows` is sorted so a rerun produces the same bytes.
 */
async function recoverCorporateActions(branches, { dryRun }) {
  const path = join(DATA, 'corporate-actions.json');
  const current = readJson(path, { rows: [] });
  const merged = new Map((current.rows || []).map(r => [String(r.id || JSON.stringify(r)), r]));
  let envelope = current, seen = 0;
  for (const { ref } of branches) {
    if (!touches(changedFiles(ref), f => f === 'public/data/corporate-actions.json')) continue;
    const dir = checkoutPaths(ref, ['public/data/corporate-actions.json']);
    try {
      const payload = readJson(join(dir, 'public/data/corporate-actions.json'));
      if (!payload?.rows) continue;
      for (const row of payload.rows) merged.set(String(row.id || JSON.stringify(row)), row);
      envelope = payload; seen += 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const before = (current.rows || []).length;
  if (dryRun) return { feed: 'corporate-actions', branches: seen, before, after: merged.size, added: merged.size - before, wrote: false };
  const rows = [...merged.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  writeJson(path, { ...envelope, rowCount: rows.length,
    companyCount: new Set(rows.map(r => r.ticker || r.company).filter(Boolean)).size, rows });
  return { feed: 'corporate-actions', branches: seen, before, after: rows.length, added: rows.length - before, wrote: true };
}

const FEEDS = {
  'market-news': recoverMarketNews,
  'nse-filings': recoverNseFilings,
  'company-news': companyArchiveRecovery({ id: 'company-news', dir: 'company-news', prefix: 'company-news' }),
  'tradingview-news': companyArchiveRecovery({ id: 'tradingview-news', dir: 'tradingview-news', prefix: 'tradingview-news' }),
  'corporate-actions': recoverCorporateActions,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const dryRun = process.argv.includes('--dry-run');
  const only = arg('--feed');
  const limit = Number(arg('--limit') || 0);
  let branches = captureBranches();
  if (limit > 0) branches = branches.slice(-limit);
  for (const [id, run] of Object.entries(FEEDS)) {
    if (only && only !== id) continue;
    console.log(JSON.stringify(await run(branches, { dryRun })));
  }
}
