import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { glowPortfolio, glowPositionReply } from '../public/js/data/glow-book-contract.js';
import { glowManagerSnapshot } from '../public/js/data/glow-manager-contract.js';
import { snapshotIssue } from '../public/js/data/managers-contract.js';
import { validPositionSizes } from '../public/js/data/position-sizes-contract.js';
import { handleGlowHoldingSizes } from '../worker/glow-portfolio.mjs';
import { handlePriceLevels } from '../worker/glow-price-levels.mjs';
import worker from '../worker/index.js';
import { PRICE_LEVELS_OBJECT } from '../public/js/data/price-levels-shared.js';
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const book = read('book'), companies = read('portfolio-companies'), source = read('managers');
const portfolio = await glowPortfolio(companies, book);
const reply = glowPositionReply(portfolio, book);
assert(validPositionSizes(reply)); assert.equal(reply.holdings.length, companies.holdings.length);
const managers = await glowManagerSnapshot(portfolio, book, source);
assert.equal(snapshotIssue(managers), null);
assert.equal(managers.sourceKind, 'glow-statements');
assert.equal(managers.bookAsOf, book.asOf);
assert.match(managers.coverage.note, /positions and .* trades lack/);
assert(managers.managers.filter(m => m.kind === 'fund').every(m => m.capital.drawn === null && m.capital.tvpi === null));
await assert.rejects(glowManagerSnapshot(portfolio, book, { ...source, builtFrom: 'different' }), /revision/);
await assert.rejects(glowManagerSnapshot(portfolio, book, { ...source, source: 'techmuns/OtherFamily' }), /revision/);
const corrupt = structuredClone(managers); corrupt.sourceKind = 'other'; assert.equal(snapshotIssue(corrupt), 'format');
const paths = [];
const env = { ASSETS: { fetch: async request => {
  const url = new URL(request.url); assert.equal(url.origin, 'https://glow.example'); paths.push(url.pathname);
  assert.equal(request.headers.has('authorization'), false);
  return Response.json(url.pathname === '/data/book.json' ? book : companies);
} } };
const response = await handleGlowHoldingSizes(new Request('https://glow.example/api/holding-sizes'), env);
assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /private.*no-store/);
const sizes = await response.json(); assert(validPositionSizes(sizes));
assert.deepEqual(sizes.holdings.map(h => h.isin), companies.holdings.map(h => h.isin));
assert(!/accountId|marketValue|costBasis|quantity/.test(JSON.stringify(sizes)));
assert.deepEqual(new Set(paths), new Set(['/data/book.json', '/data/portfolio-companies.json']));
const failure = await handleGlowHoldingSizes(new Request('https://glow.example/api/holding-sizes'), { ASSETS: { fetch: async () => new Response('down', { status: 503 }) } });
assert.equal(failure.status, 503); assert.equal((await failure.json()).ok, false);
// Preserve the existing Glow object's identity while adopting lossless upstream keyset pages.
assert.equal(PRICE_LEVELS_OBJECT, 'price-levels:v1');
let cursor;
const levels = await worker.fetch(new Request('https://glow.example/api/price-levels?cursor=next-page'), {
  PRICE_LEVELS: { getByName(name) { assert.equal(name, PRICE_LEVELS_OBJECT); return {
    priceLevelsSnapshot(value) { cursor = value; return { companies: [], hits: [], nextCursor: null }; },
  }; } },
});
assert.equal(levels.status, 200); assert.equal(cursor, 'next-page');
const preflight = await worker.fetch(new Request('https://glow.example/api/price-levels', { method: 'OPTIONS', headers: { origin: 'https://glowventures-1xw.pages.dev' } }), {});
assert.equal(preflight.status, 204, 'the existing Glow Ventures ingress retains its browser preflight');
console.log(`PASS Glow statement adapters, complete ${sizes.holdings.length}-company weights, manager revision checks, honest statement dates/gaps, asset-only reads, failure handling, payload privacy and retained price-level object/pages.`);
