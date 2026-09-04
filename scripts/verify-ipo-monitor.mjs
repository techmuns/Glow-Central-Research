#!/usr/bin/env node
// Public, read-only fixtures. Never starts the reference repository's capture pipeline.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleIpoMonitor } from '../worker/ipo-monitor.mjs';
import { createIpoFeed } from '../public/js/data/ipo-monitor.js';
import {
  validateIpoSnapshot,
  validateScoring,
  buildIpoRows,
  weeklyIpoStats,
  scoreIpo,
  matchesIpo,
  sourceLinks,
  ipoStory,
} from '../public/js/data/ipo-monitor-shared.js';
import worker from '../worker/index.js';
const read = (path) => JSON.parse(readFileSync(new URL(`../public/data/${path}`, import.meta.url)));
const latest = read('ipo-monitor/latest.json'),
  config = read('ipo-monitor/scoring_config.json'),
  index = read('ipo-monitor/index.json');
const snapshots = index.historyDates.map((d) => read(`ipo-monitor/snapshots/${d}.json`));
const tracked = read('ipo-tracked-issuers.json').issuers;
const bundle = { ok: true, latest, config, historyDates: index.historyDates, historyAvailable: true };
const req = (query = '', init) => new Request(`https://dashboard.example/api/ipo-monitor${query}`, init);
let checks = 0;
const check = async (name, fn) => {
  await fn();
  console.log(`PASS ${name}`);
  checks++;
};
const upstream = async (url, init) => {
  assert.equal(init.redirect, 'manual');
  assert.equal(init.cache, 'no-store');
  assert.equal(new Headers(init.headers).has('authorization'), false);
  assert.equal(new Headers(init.headers).has('cookie'), false);
  assert.ok(init.signal);
  assert.ok(!init.method || init.method === 'GET');
  if (url.startsWith('https://api.github.com/repos/techmuns/DRHP/contents/data/snapshots?'))
    return Response.json(index.historyDates.map((d) => ({ name: `${d}.json`, type: 'file' })));
  assert.ok(url.startsWith('https://raw.githubusercontent.com/techmuns/DRHP/main/data/'));
  return Response.json(read(`ipo-monitor/${url.split('/data/')[1]}`));
};
await check('all nine imported snapshots and scoring model satisfy the source contract', () => {
  assert.equal(snapshots.length, 9);
  snapshots.forEach(validateIpoSnapshot);
  validateScoring(config);
  assert.deepEqual(weeklyIpoStats(latest, config), { drhp: 3, prospectus: 4, updated: 4, dig: 5 });
  assert.throws(() => validateIpoSnapshot({ ...latest, meta: { ...latest.meta, snapshot_id: '../bad' } }));
  assert.throws(() => validateScoring({ ...config, min_coverage_weight: 101 }));
});
await check('121 issuers retain older history and separate prospectus from listing', () => {
  const rows = buildIpoRows(snapshots, tracked);
  assert.equal(rows.length, 121);
  const prospectus = {
    ...latest,
    filings: [
      {
        company_name: 'Synthetic Limited',
        filing_date: '2026-08-31',
        filing_type: 'Prospectus',
        current_stage: 'Listed',
      },
    ],
    ipo_market: null,
  };
  assert.equal(buildIpoRows([prospectus])[0].stage, 'Prospectus filed');
  const empty = {
    ...latest,
    meta: { ...latest.meta, data_as_of: '2026-09-04' },
    filings: [],
    ipo_market: null,
  };
  assert.equal(buildIpoRows([...snapshots, empty], tracked).length, rows.length);
  assert.ok(rows.some((r) => r.marketAsOf && r.marketAsOf < latest.meta.data_as_of));
});
await check('EAAA is an explicit verified supplement, not invented IPO dates, financials or buzz', () => {
  assert.equal(buildIpoRows(snapshots).filter((r) => matchesIpo(r, 'EAAA')).length, 0);
  const row = buildIpoRows(snapshots, tracked).find((r) => matchesIpo(r, 'Edelweiss Alternatives'));
  assert.equal(row.name, 'EAAA India Alternatives Limited');
  assert.equal(row.history.length, 2);
  assert.equal(row.filingDate, '2026-08-13');
  assert.equal(row.market, undefined);
  assert.equal(scoreIpo(row.financials, config).total, null);
  assert.match(row.tracked.note, /not independently captured/);
  assert.ok(sourceLinks(row).some((r) => r.url === 'https://www.eaaa.in/ipo-page/'));
  assert.equal(sourceLinks({ sources: { bad: 'javascript:alert(1)' } }).length, 0);
  assert.equal(ipoStory({ title: 'EAAA earnings rise' }), false);
  assert.equal(ipoStory({ title: 'EAAA IPO draft' }), true);
});
await check('missing inputs stay unknown; real zero stays zero; invalid models are refused', () => {
  assert.equal(scoreIpo({}, config).total, null);
  const zeros = Object.fromEntries(Object.values(config.components).map((p) => [p.input, { value: 0 }]));
  assert.equal(scoreIpo(zeros, config).coverage, 100);
  const unavailable = Object.fromEntries(
    Object.values(config.components).map((p) => [p.input, { value: '0' }]),
  );
  assert.equal(scoreIpo(unavailable, config).total, null);
  const bad = structuredClone(config);
  Object.values(bad.components)[0].weight++;
  assert.throws(() => validateScoring(bad));
  const avaada = snapshots.flatMap((s) => s.filings).find((f) => f.company_name.includes('Avaada'));
  assert.equal(scoreIpo(avaada.financials, config).total, 65);
});
await check(
  'read-only fixed routes reject method, path injection and invalid dates before fetching',
  async () => {
    let calls = 0;
    const opts = {
      fetcher: async () => {
        calls++;
        throw Error();
      },
    };
    assert.equal((await handleIpoMonitor(req('', { method: 'POST' }), opts)).status, 405);
    for (const q of [
      '?snapshot=../sync',
      '?snapshot=2026-02-30',
      '?url=https://evil.test',
      '?snapshot=2026-08-31&snapshot=2026-08-24',
    ])
      assert.equal((await handleIpoMonitor(req(q), opts)).status, 400);
    assert.equal(calls, 0);
  },
);
await check('public proxy strips caller identity and returns validated latest/history', async () => {
  const response = await handleIpoMonitor(
    req('', { headers: { authorization: 'Bearer fixture.private', cookie: 'fixture=private' } }),
    { fetcher: upstream },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  const body = await response.json();
  assert.equal(body.latest.filings.length, 11);
  assert.equal(body.historyDates.length, 9);
  const older = await (await handleIpoMonitor(req('?snapshot=2026-06-30'), { fetcher: upstream })).json();
  assert.equal(older.snapshot.meta.snapshot_id, '2026-06-30');
});
await check('partial sources and malformed/latest failures never look like an empty market', async () => {
  const partial = await handleIpoMonitor(req(), {
    fetcher: async (url, init) =>
      url.endsWith('/latest.json') ? upstream(url, init) : Response.json({}, { status: 503 }),
  });
  const p = await partial.json();
  assert.equal(p.ok, true);
  assert.equal(p.config, null);
  assert.equal(p.historyAvailable, false);
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  for (const body of ['bad json', '{}', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const response = await handleIpoMonitor(req(), { fetcher: async () => new Response(body) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(
    (await handleIpoMonitor(req('?snapshot=2026-06-30'), { fetcher: async () => Response.json(latest) }))
      .status,
    502,
  );
});
await check('cache failure is non-fatal; cache keys exclude credentials', async () => {
  const cache = {
    match: async (key) => {
      assert.equal([...key.headers].length, 0);
      throw Error();
    },
    put: async () => {
      throw Error();
    },
  };
  assert.equal((await handleIpoMonitor(req(), { fetcher: upstream, cache })).status, 200);
});
await check('stalled response bodies respect caller cancellation', async () => {
  const controller = new AbortController();
  const result = handleIpoMonitor(req('?snapshot=2026-06-30', { signal: controller.signal }), {
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{'));
          },
        }),
      ),
  });
  setTimeout(() => controller.abort(), 10);
  assert.equal((await result).status, 502);
});
await check(
  'client loads every saved capture with a bounded pool and retains history on refresh',
  async () => {
    let active = 0,
      peak = 0;
    const feed = createIpoFeed({
      fetcher: async (url, init) => {
        assert.ok(init.signal);
        active++;
        peak = Math.max(peak, active);
        await new Promise((done) => setTimeout(done, 1));
        active--;
        return Response.json(
          url === 'api/ipo-monitor'
            ? bundle
            : {
                ok: true,
                snapshot: read(
                  `ipo-monitor/snapshots/${new URL(url, 'https://test/').searchParams.get('snapshot')}.json`,
                ),
              },
        );
      },
    });
    await feed.load();
    await feed.loadHistory();
    assert.equal(feed.state.snapshots.size, 9);
    assert.ok(peak <= 3);
    await feed.load();
    assert.equal(feed.state.snapshots.size, 9);
  },
);
await check('client falls back visibly, validates paths, and can retry failed history', async () => {
  let fail = true;
  const requested = [];
  const feed = createIpoFeed({
    fetcher: async (url) => {
      requested.push(url);
      if (url.startsWith('api/')) throw Error();
      if (fail && url.includes('/snapshots/')) throw Error();
      return Response.json(read(url.replace('data/', '')));
    },
  });
  await feed.load();
  assert.equal(feed.state.fallback, true);
  assert.equal(feed.state.bundle.checkedAt, null);
  await feed.loadHistory();
  assert.equal(feed.state.failedDates.size, 8);
  fail = false;
  await feed.loadHistory();
  assert.equal(feed.state.failedDates.size, 0);
  assert.equal(feed.state.snapshots.size, 9);
  const bad = createIpoFeed({
    fetcher: async (url) => {
      assert.ok(!url.includes('../'));
      return Response.json(
        url === 'api/ipo-monitor'
          ? { ...bundle, historyDates: ['../../bad'] }
          : read(url.replace('data/', '')),
      );
    },
  });
  await bad.load();
  assert.equal(bad.state.fallback, true);
});
await check('actual Worker route never forwards deployment or caller credentials', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    assert.equal((await worker.fetch(req(), { MUNS_TOKEN: 'fixture.deployment' }, {})).status, 200);
  } finally {
    globalThis.fetch = original;
  }
});
console.log(`\n${checks} IPO monitor checks passed.`);
