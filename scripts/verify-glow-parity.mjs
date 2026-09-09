import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { glowPortfolio, glowPositionReply, glowReading } from '../public/js/data/glow-book-contract.js';
import { validPositionSizes, validPortfolioReply } from '../public/js/research/portfolio-bridge.js';
import { handleGlowPortfolio } from '../worker/glow-portfolio.mjs';

const json = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const book = json('book'), companies = json('portfolio-companies');
const now = Date.now();
const portfolio = await glowPortfolio(companies, book, { now });
assert.equal(portfolio.holdings.length, companies.holdings.length, 'every Glow company survives the new contract');
assert.deepEqual(portfolio.holdings.map(h => h.ticker), companies.holdings.map(h => h.ticker));
assert(portfolio.holdings.every(h => /^INE[A-Z0-9]{9}$/.test(h.isin)));
assert.equal(new Set(portfolio.holdings.map(h => h.isin)).size, portfolio.holdings.length);
assert.equal(portfolio.sourceKind, 'glow-statements');
assert.equal(portfolio.asOf, book.asOf, 'a successful re-read must not change the statement date');
assert(!/marketValue|costBasis|quantity|accountId|ownerId/.test(JSON.stringify(portfolio)), 'the public sync endpoint projects identities only');
const reply = glowPositionReply(portfolio, book);
assert(validPositionSizes(reply, now));
assert(reply.sizes.complete, 'the shipped Glow equity book must reconcile before size ordering is enabled');
assert(Math.abs(reply.holdings.reduce((s, h) => s + h.weightPct, 0) - 100) < 1e-8);
const reading = glowReading(portfolio, book, reply.sizes);
assert(validPortfolioReply({ ...reply, reading }, now));
assert.match(reading.answer, /not a live broker/);
assert.match(reading.answer, /ring-fenced promoter holding is outside/);
assert(reading.answer.length < 6000);
const unknown = structuredClone(book);
unknown.positions.find(p => p.assetClass === 'Equity').marketValue = null;
const incomplete = glowPositionReply(portfolio, unknown);
assert.equal(incomplete.sizes.complete, false);
assert(incomplete.holdings.every(h => h.weightPct === null), 'unknown marks never become zero or a partial denominator');
const mismatched = structuredClone(companies); mismatched.sourceCommit.sha = 'different';
await assert.rejects(glowPortfolio(mismatched, book), /same source revision/);
await assert.rejects(glowPortfolio({ ...companies, source: 'techmuns/Sattva-Family' }, book), /same source revision/);

const paths = [];
const env = { ASSETS: { fetch: async request => {
  const path = new URL(request.url).pathname; paths.push(path);
  assert(new URL(request.url).origin === 'https://glow.example');
  return Response.json(path === '/data/book.json' ? book : companies);
} } };
const response = await handleGlowPortfolio(new Request('https://glow.example/api/family-portfolio'), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(new Set(paths), new Set(['/data/book.json', '/data/portfolio-companies.json']));
assert.equal((await response.json()).count, companies.count);
const failed = await handleGlowPortfolio(new Request('https://glow.example/api/family-portfolio'), {
  ASSETS: { fetch: async () => new Response('unavailable', { status: 503 }) },
});
assert.equal(failed.status, 503);
assert.equal((await failed.json()).ok, false);

const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
assert.match(config, /"name": "glow-central-research"/);
assert.match(config, /"GH_REPO": "techmuns\/Glow-Central-Research"/);
assert(!/"namespace_id": "170[12]"/.test(config), 'rate limits must not share Sattva buckets');
assert(!/"script_name"/.test(config), 'durable objects must belong to Glow');
const shell = readFileSync(new URL('../public/js/ui/shell.js', import.meta.url), 'utf8');
for (const name of ['mutualFunds', 'macroResearch', 'economyMacro', 'familyBook']) assert(shell.includes(name));
const scan = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.(js|mjs)$/.test(path)) {
      const source = readFileSync(path, 'utf8');
      assert(!source.includes('https://sattva-family.pages.dev'), `foreign portfolio URL in ${path}`);
      assert(!source.includes('techmuns/Sattva-Central-Research'), `foreign collector repo in ${path}`);
      assert(!source.includes('/assets/brand/sattva-ventures-'), `foreign product artwork in ${path}`);
      assert(!/^(<<<<<<<|=======|>>>>>>>) /m.test(source), `merge marker in ${path}`);
    }
  }
};
scan('worker'); scan('public/js');
const sync = readFileSync(new URL('../.github/workflows/sync-upstream.yml', import.meta.url), 'utf8');
assert(!sync.includes('HEAD:main'));
assert(sync.includes('git restore --source="$base" --staged --worktree'));
assert(sync.includes('codex/sattva-sync-'));
assert(sync.includes('--body-file'));
console.log(`PASS Glow parity: ${companies.count} identities, complete statement weights, source dates, nulls, portfolio isolation, local asset-only reads and PR-only template sync.`);
