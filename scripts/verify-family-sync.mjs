import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFamilyBook, assertBookChange, boundedJson } from '../public/js/data/family-book-contract.js';
import { resolvePortfolio } from '../worker/portfolio-resolver.mjs';
import { handleFamilyPortfolio, fetchFamilyBook, FAMILY_HOLDINGS_URL } from '../worker/family-portfolio.mjs';
import { syncFamilyBook } from './sync-family-book.mjs';
import * as coverage from '../public/js/data/coverage.js';
import { loadActivePortfolio } from './lib/active-portfolio.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const saved = read('portfolio-companies');
const sources = { scans: read('concall-scans'), mc: read('mc-ticker-map'), universe: read('universe') };
const prior = JSON.parse(readFileSync(new URL('./fixtures/family-book.json', import.meta.url)));
const sterlite = { isin: 'INE089C01029', name: 'Sterlite Technologies Ltd', sector: 'Unclassified' };
const beforeSterlite = prior.lines.filter(l => l.isin !== sterlite.isin);
const incoming = {
  ok: true, schemaVersion: 1, storage: 'shared', revision: 'a'.repeat(64),
  asOf: '2026-09-30', checkedAt: new Date().toISOString(),
  sourceWorkbook: { fileKey: 'up-aug', label: 'FY27 till Q2 Aug.', uploadedAt: '2026-09-03T00:00:00Z' },
  positions: prior.positions, excluded: prior.excluded,
  lines: [...beforeSterlite.slice(1), sterlite], count: beforeSterlite.length,
};
const token = 'test-only-token-not-a-real-credential';
const assetEnv = {
  FAMILY_HOLDINGS_TOKEN: token,
  ASSETS: { fetch: async req => Response.json(read(new URL(req.url).pathname.split('/').at(-1).replace('.json', ''))) },
};

test('existing ISIN/ticker resolution is unchanged by extracting the shared resolver', async () => {
  const actual = await resolvePortfolio(prior, sources);
  assert.deepEqual(actual.holdings, saved.holdings);
  assert.equal(actual.resolved, saved.resolved);
});

test('active workbook adds Sterlite as STLTECH and removes the departed holding', async () => {
  const book = validateFamilyBook(incoming);
  assertBookChange(book, prior);
  const resolved = await resolvePortfolio(book, sources);
  assert.equal(resolved.holdings.find(h => h.isin === sterlite.isin)?.ticker, 'STLTECH');
  assert.equal(resolved.holdings.some(h => h.isin === prior.lines[0].isin), false);
  assert.equal(resolved.count, incoming.count);
  assert.equal(resolved.sourceWorkbook.fileKey, 'up-aug');
});

test('malformed, duplicate, empty and incomplete reads cannot replace a saved book', () => {
  for (const patch of [{ lines: [] }, { count: 1 }, { revision: null }, { checkedAt: null }, { storage: 'local' },
    { lines: [incoming.lines[0], incoming.lines[0]], count: 2 }]) {
    assert.throws(() => validateFamilyBook({ ...incoming, ...patch }));
  }
  assert.throws(() => assertBookChange({ lines: [sterlite] }, prior));
  const clean = validateFamilyBook({ ...incoming, account: 'PRIVATE', marketValue: 999, lines: incoming.lines.map(l => ({ ...l, quantity: 50 })) });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|marketValue|quantity/);
});

test('live route authenticates only the fixed source URL and never forwards the token', async () => {
  let calls = 0;
  const response = await handleFamilyPortfolio(new Request('https://research.test/api/family-portfolio?url=https://evil.test'), assetEnv, async (url, init) => {
    calls++;
    assert.equal(url, FAMILY_HOLDINGS_URL);
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    return Response.json(incoming);
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.syncStatus, 'live');
  assert.equal(body.holdings.find(h => h.isin === sterlite.isin).ticker, 'STLTECH');
  assert.doesNotMatch(JSON.stringify(body), /test-only-token/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upstream refusal, missing configuration, oversized bodies and redirects cannot turn green', async () => {
  for (const upstream of [() => new Response('Forbidden', { status: 403 }), () => Response.json({}), () => { throw new Error('timeout'); }]) {
    const response = await handleFamilyPortfolio(new Request('https://research.test/api/family-portfolio'), assetEnv, upstream);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
  await assert.rejects(fetchFamilyBook(null));
  await assert.rejects(fetchFamilyBook(token, async () => Response.json({ ...incoming, checkedAt: '2020-01-01T00:00:00Z' })));
  await assert.rejects(boundedJson(new Response('x'.repeat(100)), 50));
});

test('scheduled sync writes only validated identities; a bad read leaves fixture bytes untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-sync-test-'));
  const fixturePath = join(dir, 'book.json'), local = join(dir, 'incoming.json');
  writeFileSync(fixturePath, JSON.stringify(prior));
  writeFileSync(local, JSON.stringify(incoming));
  await syncFamilyBook({ local, fixturePath });
  const good = readFileSync(fixturePath, 'utf8');
  assert.equal(JSON.parse(good).lines.some(l => l.isin === sterlite.isin), true);
  writeFileSync(local, JSON.stringify({ ...incoming, lines: [], count: 0 }));
  await assert.rejects(syncFamilyBook({ local, fixturePath }));
  assert.equal(readFileSync(fixturePath, 'utf8'), good);
});

test('browser replaces scope, retains last good on failure, and labels recovery honestly', async () => {
  const original = globalThis.fetch;
  try {
    coverage.prime(saved);
    const payload = { ok: true, syncStatus: 'live', ...await resolvePortfolio(validateFamilyBook(incoming), sources) };
    let changes = 0;
    const off = coverage.onChange(({ changed }) => { if (changed) changes++; });
    globalThis.fetch = async () => Response.json(payload);
    await coverage.refresh();
    assert.equal(coverage.has('STLTECH'), true);
    assert.equal(coverage.meta().syncStatus, 'live');
    assert.match(coverage.syncLabel(), /FY27 till Q2 Aug/);
    globalThis.fetch = async () => new Response('down', { status: 503 });
    await coverage.refresh();
    assert.equal(coverage.has('STLTECH'), true);
    assert.equal(coverage.meta().syncStatus, 'unavailable');
    assert.match(coverage.syncLabel(), /may be out of date/);
    await coverage.restoreLastGood();
    assert.equal(coverage.has('STLTECH'), true);
    assert.equal(coverage.meta().syncStatus, 'snapshot');
    globalThis.fetch = async () => Response.json(payload);
    await coverage.refresh();
    assert.equal(coverage.meta().syncStatus, 'live');
    assert.equal(changes, 1);
    const newerSnapshot = { ...saved, syncedAt: new Date(Date.parse(payload.syncedAt) + 60000).toISOString() };
    coverage.prime(newerSnapshot);
    await coverage.restoreLastGood();
    assert.deepEqual(coverage.baseHoldings(), saved.holdings, 'an older browser cache must not replace a newer committed snapshot');
    coverage.prime(saved);
    await coverage.restoreLastGood();
    assert.equal(coverage.has('STLTECH'), true, 'a newer last-good cache must survive reloads');
    off();
  } finally { globalThis.fetch = original; }
});

test('scheduled collectors use the active portfolio and refuse silent static fallback', async () => {
  const payload = { ok: true, syncStatus: 'live', ...await resolvePortfolio(validateFamilyBook(incoming), sources) };
  const current = await loadActivePortfolio('/unused', { live: true, fetcher: async () => Response.json(payload) });
  assert.equal(current.holdings.find(h => h.isin === sterlite.isin).ticker, 'STLTECH');
  await assert.rejects(loadActivePortfolio('/unused', { live: true, fetcher: async () => new Response('down', { status: 503 }) }));
  const offline = await loadActivePortfolio(new URL('../public/data/portfolio-companies.json', import.meta.url), { live: false, fetcher: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(offline.holdings, saved.holdings);
});
