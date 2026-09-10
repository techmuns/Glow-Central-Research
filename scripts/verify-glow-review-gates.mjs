import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import worker from '../worker/index.js';
import { dataReviewDecision } from './merge-data-pr.mjs';
import { dataBranch, dataPath, publishStagedData, DATA_REPOSITORY } from './data-pr.mjs';

const sha = 'a'.repeat(40), bot = { login: 'chatgpt-codex-connector[bot]' };
const notice = { user: bot, body: 'To use Codex here, [create a Codex account and connect to github](https://chatgpt.com/codex/cloud/settings/connectors).' };
const approval = { state: 'APPROVED', commit_id: sha, author_association: 'OWNER', user: { login: 'techmuns' } };
const check = name => ({ name, status: 'completed', conclusion: 'success', started_at: '2026-09-09T00:00:00Z' });
const input = { pr: { state: 'OPEN', isCrossRepository: false, baseRefName: 'main', headRepository: { nameWithOwner: DATA_REPOSITORY },
  headRefName: 'codex/data-123-1', changedFiles: 1, mergeable: 'MERGEABLE', isDraft: false, headRefOid: sha, author: { login: 'github-actions[bot]' } },
  files: [{ filename: 'public/data/news.json' }], checks: ['contracts', 'browser', 'portfolio-research'].map(check),
  runs: [{ headSha: sha, databaseId: 1, status: 'completed', conclusion: 'success' }], reviews: [], inline: [],
  comments: [{ user: bot, body: '<!-- codex-pull-request-review-summary --> Completed `aaaaaaa`' }] };
assert.equal(dataReviewDecision(input), 'ready');
for (const [change, reason] of [
  [{ files: [{ filename: 'worker/index.js' }] }, 'scope'],
  [{ runs: [{ ...input.runs[0], headSha: 'b'.repeat(40) }] }, 'verification'],
  [{ checks: [check('contracts')] }, 'verification'],
  [{ checks: [...input.checks, { ...check('deploy'), conclusion: 'failure' }] }, 'checks'],
  [{ comments: [{ user: bot, body: 'You have reached your Codex usage limits for code reviews.' }] }, 'review-pending-or-unavailable'],
  // A reviewer that cannot answer here is not a reviewer that has not answered yet. Neither merges;
  // only the first will still be true tomorrow, so the run has to be able to name it.
  [{ comments: [notice] }, 'review-unavailable'],
  // Where it cannot answer, a person who could merge this by hand reviewing it is the review — and
  // of THIS capture only, by somebody who is not the branch's own author.
  [{ comments: [notice], reviews: [approval] }, 'ready'],
  [{ comments: [notice], reviews: [{ ...approval, commit_id: 'c'.repeat(40) }] }, 'review-unavailable'],
  [{ comments: [notice], reviews: [{ ...approval, author_association: 'NONE' }] }, 'review-unavailable'],
  [{ comments: [notice], reviews: [{ ...approval, user: { login: 'github-actions[bot]' } }] }, 'review-unavailable'],
  [{ comments: [notice], reviews: [approval, { state: 'CHANGES_REQUESTED' }] }, 'review-feedback'],
  [{ comments: [{ user: bot, body: '<!-- codex-pull-request-review-summary --> Completed `bbbbbbb`' }] }, 'review-pending-or-unavailable'],
  [{ comments: [...input.comments, { user: bot, body: 'P1: dropped records need restoration' }] }, 'review-feedback'],
  [{ inline: [{ body: 'wrong issuer' }] }, 'review-feedback'],
  [{ reviews: [{ state: 'CHANGES_REQUESTED' }] }, 'review-feedback'],
]) assert.equal(dataReviewDecision({ ...input, ...change }), reason);
assert.equal(dataReviewDecision({ ...input, pr: { ...input.pr, isCrossRepository: true } }), 'scope');
assert.equal(dataReviewDecision({ ...input, pr: { ...input.pr, mergeable: 'CONFLICTING' } }), 'merge-gate');
assert(!dataPath('public/data/../worker.json')); assert(!dataPath('public/data/source.js'));
assert(dataPath('public/data/shareholding-filings.json.gz')); assert(!dataPath('public/data/source.js.gz'));
assert.equal(dataBranch('123', '2'), 'codex/data-123-2'); assert.throws(() => dataBranch('../main', '1'));
const env = { ...process.env }, commands = [];
try {
  Object.assign(process.env, { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: DATA_REPOSITORY });
  const run = (cwd, exe, args) => {
    commands.push([exe, ...args]);
    if (exe === 'git' && args[0] === 'diff') return 'public/data/news.json';
    if (exe === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://github.com/techmuns/Glow-Central-Research/pull/999';
    return '';
  };
  publishStagedData({ run });
  const branchAt = commands.findIndex(c => c[1] === 'switch'), commitAt = commands.findIndex(c => c[1] === 'commit');
  assert(branchAt >= 0 && branchAt < commitAt, 'commit is made only after leaving main');
  assert.deepEqual(commands.find(c => c[1] === 'push'), ['git', 'push', 'origin', 'HEAD:refs/heads/codex/data-123-1']);
  assert(commands.some(c => c[0] === 'gh' && c[1] === 'workflow' && c.at(-1) === 'codex/data-123-1'), 'GITHUB_TOKEN PRs explicitly receive CI');
  assert(commands.some(c => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'comment'));
  assert.throws(() => publishStagedData({ run: () => 'worker/index.js' }), /non-data/);
} finally { process.env = env; }
for (const name of readdirSync('.github/workflows').filter(f => f.endsWith('.yml'))) {
  const source = readFileSync(`.github/workflows/${name}`, 'utf8');
  assert(!/git\s+push[^\n]*(?:HEAD:main|heads\/main)/.test(source), `${name} bypasses PRs`);
}
// Both validation outcomes run in fresh processes because configuration is module-scoped.
for (const [id, shouldPass] of [['10850427', false], ['99000001', true], ['', false]]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import { assertGlowWatchlist } from './scripts/lib/screener-upcoming.mjs'; assertGlowWatchlist();"],
    { encoding: 'utf8', env: { ...process.env, SCREENER_WATCHLIST_ID: id, SCREENER_WATCHLIST_NAME: 'Glow test watchlist' } });
  assert.equal(result.status === 0, shouldPass, 'production Sattva identity and absent configuration must be rejected');
}

// Exercise real Worker routing against a shared edge-cache fixture and mocked upstream only.
const originalFetch = globalThis.fetch, originalCaches = globalThis.caches;
const entries = new Map(), writes = [], pending = [];
const foreign = Response.json({ ok: true, investors: [{ slug: 'foreign', name: 'Other deployment' }] });
entries.set('https://cache.invalid/super-investors', foreign);
entries.set('https://cache.invalid/sattva-central-research.tech-441.workers.dev/super-investors', foreign);
const cache = { match: async key => entries.get(key.url)?.clone(), put: async (key, value) => { writes.push(key.url); entries.set(key.url, value.clone()); } };
globalThis.caches = { default: cache };
let status = 200;
globalThis.fetch = async url => {
  assert(new URL(url).origin === 'https://investors.fixture.invalid');
  return status === 200 ? Response.json({ investors: [{ slug: 'one', name: 'Own cached response' }],
    slug: 'one', quarters: ['Jun 2026'], holdings: [] }) : new Response('Credential expired', { status });
};
const ctx = { waitUntil: promise => pending.push(promise) };
const request = async (path, token = 'fixture') => (await worker.fetch(new Request(`https://glow.fixture.invalid/api/${path}`),
  { MUNS_TOKEN: token, MUNS_BASE: 'https://investors.fixture.invalid' }, ctx)).json();
try {
  for (const path of ['super-investors', 'super-investors/one']) {
    const live = await request(path); assert.equal(live.ok, true); await Promise.all(pending);
    if (path === 'super-investors') assert.equal(live.investors[0].slug, 'one', 'Sattva shared-cache entries are not read');
    assert.equal((await request(path, '')).reason, 'no-token', 'even fresh cache cannot mask a removed secret');
    entries.delete(`https://cache.invalid/glow-central-research/${path}`);
    status = 401;
    const expired = await request(path); await Promise.all(pending);
    assert.equal(expired.ok, false); assert.equal(expired.reason, 'unauthorised'); assert.equal(expired.stale, false);
    entries.delete(`https://cache.invalid/glow-central-research/${path}`);
    status = 500;
    const outage = await request(path); await Promise.all(pending);
    assert.equal(outage.ok, true); assert.equal(outage.stale, true, 'ordinary outages still retain labelled evidence');
    status = 200;
  }
  assert(writes.every(key => key.startsWith('https://cache.invalid/glow-central-research/')));
} finally { globalThis.fetch = originalFetch; globalThis.caches = originalCaches; }
console.log('PASS Glow review gates: scoped PR publication, exact-head CI/review, quota refusal, deployment cache isolation, credential visibility and watchlist rejection');
