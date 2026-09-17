import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import worker from '../worker/index.js';

// GENERATED DATA GOES STRAIGHT TO MAIN, THE WAY IT DOES ON THE TEMPLATE. Between 9 and 17
// September 2026 every scheduled capture opened its own `codex/data-*` pull request and waited
// for a review that could not arrive: the reviewer app does not review a PR raised by
// github-actions[bot]. 1,091 of them were open on 17 September, the live site sat on 9 September
// prices, and every run still reported success. The gate is gone; these assertions keep it gone.
const workflows = readdirSync('.github/workflows').filter(f => f.endsWith('.yml'));
for (const name of workflows) {
  const source = readFileSync(`.github/workflows/${name}`, 'utf8');
  assert(!/scripts\/(?:data-pr|merge-data-pr|publish-data-pr)\.mjs/.test(source), `${name} still publishes data through the retired PR gate`);
  // A workflow that stages public/data and commits it must push that commit to main itself,
  // through the fetch-and-rebase retry every template writer uses. (The company-news workflow
  // hands the whole publication to its publisher, which pushes to main from a fresh worktree.)
  const stagesData = /git add[^\n]*public\/data/.test(source) && /git commit/.test(source);
  if (stagesData) {
    assert(/git push origin HEAD:main/.test(source), `${name} commits captured data but never pushes it to main`);
    assert(/git rebase origin\/main/.test(source), `${name} pushes to main without the rebase retry, so a concurrent writer loses its capture`);
  }
  assert(!/gh pr create[^\n]*codex\/data-/.test(source), `${name} opens a data PR`);
}
assert(!existsSync('.github/workflows/data-pr-review.yml'), 'the data PR review gate workflow is retired');
for (const script of ['scripts/data-pr.mjs', 'scripts/merge-data-pr.mjs', 'scripts/publish-data-pr.mjs'])
  assert(!existsSync(script), `${script} is retired; writers push to main`);
const publisher = readFileSync('scripts/publish-company-news.mjs', 'utf8');
assert(publisher.includes("['push', 'origin', 'HEAD:refs/heads/main']"), 'the company-news publisher pushes to main');
assert(!/review-pending/.test(publisher), 'the company-news publisher no longer reports a pending review');

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
console.log('PASS Glow isolation: every scheduled writer commits to main, no data PR gate, deployment cache isolation, credential visibility and watchlist rejection');
