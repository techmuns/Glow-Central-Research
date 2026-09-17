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
// The gate is retired (writers commit to main again), so this is now the tool for the day a
// branch strands for any other reason. Two kinds of feed, and the split is the whole design:
//
//   HISTORY feeds are unioned by identity — a story, a filing, a post, a checked move — because a
//   later run cannot re-fetch what an upstream's window has already moved past.
//   SNAPSHOT feeds are rebuilt from their upstream on every run, so each PATH is taken from the
//   newest branch that changed it: that is the state a normal run sequence would have left, and it
//   is what the next scheduled run would do to main in any case.
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
const ARCHIVE_SHARD = /^(?:\d{4}-\d{2}|undated)\.json$/;

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

/**
 * INSIDER TRADES and BSE ANNOUNCEMENTS — the archive layer is the history; the snapshot is a window.
 *
 * `filing-archive.mjs` keeps a month shard per feed and `archiveFilings` merges incoming rows into
 * whatever is on disk through each feed's own identity (`mergeInsiderTrades`, `mergeAnnouncements`),
 * so every shard a branch CHANGED goes back through it, oldest branch first. Only the changed shards
 * are read: a branch carries the whole archive, and most of it is the base every other branch also
 * carries. The bounded `insider-trades.json` / `corp-announcements.json` windows and the resumable
 * `filing-capture/` state are snapshots and are taken from the newest branch below.
 */
function filingArchiveRecovery({ id, dir, kind }) {
  return async function recover(branches, { dryRun }) {
    const { archiveFilings } = await import('./lib/filing-archive.mjs');
    const target = join(DATA, dir);
    const rows = [];
    let seen = 0;
    for (const { ref } of branches) {
      const changed = changedFiles(ref);
      if (!touches(changed, f => f.startsWith(`public/data/${dir}/`))) continue;
      const checkout = checkoutPaths(ref, [`public/data/${dir}`]);
      try {
        const source = join(checkout, 'public/data', dir);
        for (const name of existsSync(source) ? readdirSync(source) : []) {
          if (!ARCHIVE_SHARD.test(name)) continue;
          if (changed !== null && !changed.includes(`public/data/${dir}/${name}`)) continue;
          rows.push(...(readJson(join(source, name), {}).rows || []));
        }
        seen += 1;
      } finally { rmSync(checkout, { recursive: true, force: true }); }
    }
    const before = readJson(join(target, 'index.json'), { rowCount: 0 }).rowCount || 0;
    if (dryRun || !rows.length) return { feed: id, branches: seen, before, incoming: rows.length, wrote: false };
    const index = archiveFilings(target, kind, rows);
    return { feed: id, branches: seen, before, after: index.rowCount, added: index.rowCount - before, incoming: rows.length, wrote: true };
  };
}

/**
 * X / TWITTER — deduplicated by tweet id, then capped, the way `scrape-twitter.py` does it.
 *
 * The head is the newest `TWITTER_KEEP` posts and the month shards under `twitter-archive/` are
 * the history; both are unioned by `tweet_id`, newest branch winning a post and `matchedQueries`
 * accumulating, then sorted newest-first with the id as the tie-break so a post with no readable
 * time still lands somewhere stable. The envelope is the newest branch's.
 */
async function recoverTwitterPosts(branches, { dryRun }) {
  const KEEP = Number(process.env.TWITTER_KEEP || 600);
  const path = join(DATA, 'twitter-posts.json');
  const archiveDir = join(DATA, 'twitter-archive');
  const current = readJson(path, { posts: [] });
  const held = new Map();
  const absorb = (post) => {
    if (!post?.tweet_id) return;
    const old = held.get(post.tweet_id) || {};
    const matched = new Map([...(old.matchedQueries || []), ...(post.matchedQueries || [])].map(q => [JSON.stringify(q), q]));
    held.set(post.tweet_id, { ...old, ...post, matchedQueries: [...matched.values()] });
  };
  for (const post of current.posts || []) absorb(post);
  for (const name of existsSync(archiveDir) ? readdirSync(archiveDir) : []) if (ARCHIVE_SHARD.test(name)) for (const post of readJson(join(archiveDir, name), {}).posts || []) absorb(post);
  const before = held.size;
  let envelope = current, seen = 0;
  for (const { ref } of branches) {
    const changed = changedFiles(ref);
    if (!touches(changed, f => f === 'public/data/twitter-posts.json' || f.startsWith('public/data/twitter-archive/'))) continue;
    const dir = checkoutPaths(ref, ['public/data/twitter-posts.json', 'public/data/twitter-archive']);
    try {
      const payload = readJson(join(dir, 'public/data/twitter-posts.json'));
      if (payload) { envelope = payload; for (const post of payload.posts || []) absorb(post); }
      const shards = join(dir, 'public/data/twitter-archive');
      for (const name of existsSync(shards) ? readdirSync(shards) : []) {
        if (!ARCHIVE_SHARD.test(name)) continue;
        if (changed !== null && !changed.includes(`public/data/twitter-archive/${name}`)) continue;
        for (const post of readJson(join(shards, name), {}).posts || []) absorb(post);
      }
      seen += 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const key = p => [p.created_at || '', String(p.tweet_id)];
  const newestFirst = (a, b) => { const [ka, kb] = [key(a), key(b)]; for (let i = 0; i < 2; i++) { if (ka[i] < kb[i]) return 1; if (ka[i] > kb[i]) return -1; } return 0; };
  const all = [...held.values()].sort(newestFirst);
  if (dryRun) return { feed: 'twitter', branches: seen, before, after: all.length, added: all.length - before, wrote: false };
  const buckets = new Map();
  for (const post of all) {
    const month = /^\d{4}-\d{2}/.test(post.created_at || '') ? post.created_at.slice(0, 7) : 'undated';
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(post);
  }
  mkdirSync(archiveDir, { recursive: true });
  for (const [month, posts] of buckets) writeJson(join(archiveDir, `${month}.json`), { month, posts });
  const archive = readdirSync(archiveDir).filter(n => ARCHIVE_SHARD.test(n)).sort().reverse().map(n => ({ file: `twitter-archive/${n}`, month: n.replace(/\.json$/, '') }));
  writeJson(path, { ...envelope, posts: all.slice(0, KEEP), archive });
  return { feed: 'twitter', branches: seen, before, after: all.length, added: all.length - before, head: Math.min(all.length, KEEP), wrote: true };
}

/**
 * PRICE-MOVE CHECKS — every answer the market-data endpoint ever gave, keyed `TICKER@bar_date`.
 *
 * Its quota is smaller than a day's flagged list, so the answers are collected across runs and a
 * name is asked about once. A branch therefore holds the base's answers plus its own few, and the
 * union by key is the recovery; the envelope is the branch with the newest `updated_at`.
 */
async function recoverPriceMoveChecks(branches, { dryRun }) {
  const path = join(DATA, 'price-move-checks.json');
  const current = readJson(path, { checks: {} });
  const checks = { ...(current.checks || {}) };
  let envelope = current, seen = 0;
  for (const { ref } of branches) {
    if (!touches(changedFiles(ref), f => f === 'public/data/price-move-checks.json')) continue;
    const dir = checkoutPaths(ref, ['public/data/price-move-checks.json']);
    try {
      const payload = readJson(join(dir, 'public/data/price-move-checks.json'));
      if (!payload?.checks) continue;
      Object.assign(checks, payload.checks);
      if ((payload.updated_at || '') >= (envelope.updated_at || '')) envelope = payload;
      seen += 1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const before = Object.keys(current.checks || {}).length, after = Object.keys(checks).length;
  if (dryRun) return { feed: 'price-move-checks', branches: seen, before, after, added: after - before, wrote: false };
  writeJson(path, { ...envelope, count: after, checks });
  return { feed: 'price-move-checks', branches: seen, before, after, added: after - before, wrote: true };
}

/**
 * SNAPSHOT FILES — each path is taken from the newest branch that changed it.
 *
 * These feeds are rebuilt from their upstream on every run: a technicals file is recomputed from
 * Yahoo, an investor book re-read from Finology, the series store copied whole from GlowVentures.
 * The newest capture of a PATH is therefore the state a normal run sequence would have left, and
 * it is what the next scheduled run does to main in any case. Per PATH rather than per directory,
 * so a per-company file an earlier run wrote and a later run never reached is kept; a path the
 * newest branch deleted is deleted. Nothing is merged, and nothing here is history.
 */
export const SNAPSHOT_PATHS = [
  // technicals-refresh.yml and price-move-verify.yml (price-move-checks.json is unioned above)
  'public/data/technicals.json', 'public/data/atr-history.json', 'public/data/result-returns.json',
  'public/data/earnings-live.json', 'public/data/earnings-calendar.json', 'public/data/mc-ticker-map.json',
  'public/data/concall-scans.json', 'public/data/portfolio-history.json',
  // fpi-activity-refresh.yml
  'public/data/fpi-activity.json',
  // series-refresh.yml
  'public/data/series/', 'public/data/book.json', 'public/data/managers.json', 'public/data/portfolio-companies.json',
  // investor-refresh.yml
  'public/data/super-investors.json', 'public/data/shareholding-filings.json.gz', 'public/data/public-holdings.json',
  // insider-trades-refresh.yml: the bounded window and the resumable capture state (its archive is unioned above)
  'public/data/insider-trades.json', 'public/data/filing-capture/',
  // announcements-refresh.yml: the bounded window and the identity table (its archive is unioned above)
  'public/data/corp-announcements.json', 'public/data/announcement-identities.json',
  // twitter-refresh.yml: the handle list and search state (the posts are unioned above)
  'public/data/twitter-handles.json', 'public/data/twitter-search-plan.json', 'public/data/twitter-search.json',
  // company-news-refresh.yml: the thirty-day head and its lossless parts, written together by one
  // run (the archive beneath them is unioned above and is the history)
  'public/data/news.json', 'public/data/news.parts/',
];
async function recoverSnapshots(branches, { dryRun }) {
  const latest = new Map();
  let seen = 0;
  for (const { ref } of branches) {
    let entries;
    try { entries = git('diff', '--name-status', '--no-renames', `${ref}^`, ref, '--', ...SNAPSHOT_PATHS).split('\n').filter(Boolean); }
    catch { entries = git('ls-tree', '-r', '--name-only', ref, '--', ...SNAPSHOT_PATHS).split('\n').filter(Boolean).map(p => `M\t${p}`); }
    if (!entries.length) continue;
    seen += 1;
    for (const line of entries) { const [status, path] = line.split('\t'); latest.set(path, { ref, status }); }
  }
  let written = 0, deleted = 0;
  const suppliers = new Map();
  for (const [path, { ref, status }] of latest) {
    suppliers.set(ref, (suppliers.get(ref) || 0) + 1);
    if (dryRun) continue;
    const target = join(ROOT, path);
    if (status === 'D') { rmSync(target, { force: true }); deleted += 1; continue; }
    const bytes = execFileSync('git', ['show', `${ref}:${path}`], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    written += 1;
  }
  return { feed: 'snapshots', branches: seen, paths: latest.size, suppliers: suppliers.size, written, deleted, wrote: !dryRun && latest.size > 0 };
}

const FEEDS = {
  'market-news': recoverMarketNews,
  'nse-filings': recoverNseFilings,
  'company-news': companyArchiveRecovery({ id: 'company-news', dir: 'company-news', prefix: 'company-news' }),
  'tradingview-news': companyArchiveRecovery({ id: 'tradingview-news', dir: 'tradingview-news', prefix: 'tradingview-news' }),
  'corporate-actions': recoverCorporateActions,
  'insider-archive': filingArchiveRecovery({ id: 'insider-archive', dir: 'insider-archive', kind: 'insider' }),
  'announcements-archive': filingArchiveRecovery({ id: 'announcements-archive', dir: 'announcements-archive', kind: 'announcements' }),
  'twitter': recoverTwitterPosts,
  'price-move-checks': recoverPriceMoveChecks,
  'snapshots': recoverSnapshots,
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
