// Local workerd only. Large validated archives cross a real Durable Object RPC response stream.
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map(dir => join(dir, 'wrangler')).find(existsSync);
if (!location) throw Error('Run under npx --package=wrangler@4.119.0 or set WRANGLER_PACKAGE');
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare'), { build } = require('esbuild');
const at = new Date().toISOString();
const capture = { schemaVersion: 2, channel: 'researchreportss', route: 'embed+permalink', lastRun: { at, status: 'ok' },
  lastCheckedAt: at, session: 'PRIVATE-CREDENTIAL', posts: Array.from({ length: 7000 }, (_, i) => ({ id: 100000 + i,
    text: `Public report ${i}: ${'retained public evidence '.repeat(22)}`, publishedAt: at, session: 'PRIVATE-CREDENTIAL' })) };
let bytes, digest, calls = 0, corrupt = false;
function pack() { bytes = gzipSync(JSON.stringify(capture)); digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
pack();
const bundle = await build({ stdin: { contents: `
import worker from './worker/index.js';
import {CaptureRegistry} from './worker/capture-registry-object.mjs';
import {TELEGRAM_DELIVERY_NAME} from './worker/telegram-delivery.mjs';
export class TestRegistry extends CaptureRegistry {
  constructor(ctx, env) { super(ctx, env); this.clockAt=Date.now(); this.telegramDelivery.now=()=>this.clockAt; }
  advance() { this.clockAt+=65000; }
  async inspect() { return {alarm:await this.ctx.storage.getAlarm(),schedule:await this.status()}; }
}
export default {async fetch(request,env,ctx) {
  const stub=env.TELEGRAM_SCHEDULER.getByName(TELEGRAM_DELIVERY_NAME);
  const path=new URL(request.url).pathname;
  if(path==='/test/advance') { await stub.advance();return new Response('advanced'); }
  if(path==='/test/read') return stub.telegramPosts();
  if(path==='/test/inspect') return Response.json(await stub.inspect());
  return worker.fetch(request,env,ctx);
}};`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false,
  format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
const options = { workers: [{ name: 'telegram-delivery-test', modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-05-23', bindings: { GH_DISPATCH_TOKEN: 'test-token' },
  durableObjects: { TELEGRAM_SCHEDULER: { className: 'TestRegistry', useSQLite: true } },
  outboundService: async request => {
    calls++; const url = request.url;
    assert.equal(request.method, 'GET', 'delivery never dispatches collection');
    if (url.startsWith('https://example.blob.core.windows.net/')) {
      assert.equal(request.headers.get('authorization'), null); return new Response(bytes);
    }
    assert(url.startsWith('https://api.github.com/repos/techmuns/Glow-Central-Research/'));
    assert.equal(request.headers.get('authorization'), 'Bearer test-token');
    if (url.includes('/runs?')) {
      await new Promise(done => setTimeout(done, 10));
      return Response.json({ workflow_runs: [{ id: 1, name: 'Telegram collection (github-cron)', head_branch: 'main',
        head_repository: { full_name: 'techmuns/Glow-Central-Research' }, event: 'schedule', status: 'completed', conclusion: 'success' }] });
    }
    if (url.includes('/artifacts?')) return Response.json({ artifacts: [{ id: 2, name: 'telegram-posts-v1.json.gz', expired: false,
      workflow_run: { id: 1 }, digest: corrupt ? 'sha256:' + '0'.repeat(64) : digest, size_in_bytes: bytes.length }] });
    if (url.endsWith('/2/zip')) return new Response(null, { status: 302, headers: { location: 'https://example.blob.core.windows.net/capture' } });
    throw Error('Unexpected request');
  },
}] };
let mf = new Miniflare(options);
try {
  let origin = await mf.ready;
  const results = await Promise.all(Array.from({ length: 6 }, async () => {
    const response = await fetch(new URL('/api/telegram/posts', origin));
    assert.equal(response.status, 200); const text = await response.text();
    assert(!text.includes('PRIVATE-CREDENTIAL')); assert(text.length > 3 * 1024 * 1024);
    const value = JSON.parse(text); assert.equal(value.posts.length, 7000);
    assert.equal(value.posts[0].id, 106999); return response.headers.get('etag');
  }));
  assert.equal(calls, 5, 'concurrent readers share one validated GitHub artifact read');
  const conditional = await fetch(new URL('/api/telegram/posts', origin), { headers: { 'if-none-match': results[0] } });
  assert.equal(conditional.status, 304); assert.equal(await conditional.text(), ''); assert.equal(calls, 5);
  const inspect = await (await fetch(new URL('/test/inspect', origin))).json();
  assert.equal(inspect.alarm, null); assert.equal(inspect.schedule.enabled, false, 'delivery does not activate the collection timer');
  capture.posts.push({ id: 107000, text: 'New public arrival', publishedAt: at }); pack();
  await fetch(new URL('/test/advance', origin));
  let updated = await (await fetch(new URL('/test/read', origin))).json();
  assert.equal(updated.posts.length, 7001); assert.equal(updated.posts[0].id, 107000);
  corrupt = true; await fetch(new URL('/test/advance', origin));
  assert.equal((await fetch(new URL('/test/read', origin))).status, 503, 'a failed read cannot reuse an expired success response');
  const failedCalls = calls;
  assert.equal((await fetch(new URL('/test/read', origin))).status, 503); assert.equal(calls, failedCalls, 'failed delivery is briefly throttled');
  corrupt = false; await fetch(new URL('/test/advance', origin));
  assert.equal((await fetch(new URL('/test/read', origin))).status, 200, 'delivery recovers on the next bounded attempt');
  await mf.dispose(); mf = new Miniflare(options); origin = await mf.ready;
  updated = await (await fetch(new URL('/api/telegram/posts', origin))).json();
  assert.equal(updated.posts.length, 7001, 'a runtime restart restores from immutable artifacts without depending on memory');
  assert.equal((await fetch(new URL('/api/telegram/posts', origin), { method: 'POST' })).status, 405);
  console.log('PASS workerd Telegram delivery: 7,001 posts, streamed RPC, concurrent deduplication, ETags, private-field stripping, source integrity, expiry/recovery and cold restart');
} finally { await mf.dispose(); }
