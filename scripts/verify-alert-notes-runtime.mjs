// Run under npx --package=wrangler@4.119.0, or set WRANGLER_PACKAGE to its package.json.
// The "So what?" notes through REAL Durable Object RPC and SQLite under workerd. All model traffic
// is a fixture: the outbound service stands in for OpenAI and fails the run if anything else is asked.
//
// Why this exists: the store once built its answer with `Object.create(null)`, which workerd's RPC
// cannot serialise. Every Node test passed — Node never crosses that boundary — while every live call
// failed with a 503 that the page printed as "this copy of the dashboard has no AI service". The first
// request below is the exact probe that exposed it on the live deployment: an item the contract
// rejects, which reaches the object and returns without asking any model.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
const location = process.env.WRANGLER_PACKAGE || process.env.PATH.split(delimiter).map((dir) => join(dir, 'wrangler')).find(existsSync);
if (!location) throw new Error('Run with npx --package=wrangler@4.119.0 or set WRANGLER_PACKAGE');
const require = createRequire(realpathSync(location));
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');

const bundle = await build({ stdin: { contents: `import {handleAlertNotes} from './worker/alert-notes.mjs'; export {CaptureRegistry} from './worker/capture-registry-object.mjs'; export default {fetch:(r,e)=>handleAlertNotes(r,e)};`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });

const KEY = 'sk-fixture-openai-key-for-local-tests';
let calls = 0;
let reply = null; // (input) => Response, swapped per case
const worker = (bindings) => new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-23',
  durableObjects: { ALERT_NOTES: { className: 'CaptureRegistry', useSQLite: true } },
  ratelimits: { ALERT_NOTES_LIMITER: { namespace_id: '1705', simple: { limit: 30, period: 60 } } },
  bindings,
  outboundService: async (request) => {
    calls++;
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/responses', 'the only outbound request is OpenAI\'s Responses API');
    assert.equal(request.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(request.headers.get('x-api-key'), null, 'no Bedrock credential travels to OpenAI');
    const body = await request.json();
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    return reply(JSON.parse(body.input));
  },
});
const completed = (notes) => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: JSON.stringify({ notes }) }] }], usage: { input_tokens: 900, output_tokens: 80 } });

const item = { kind: 'filing', company: 'Waaree Energies Limited', ticker: 'WAAREEENER', sector: 'Industrials', day: '2026-09-24',
  line: 'Amalgamation OR Merger-XBRL', headline: 'Amalgamation OR Merger-XBRL', detail: 'NSE · Amalgamation of wholly owned subsidiary Indosolar Limited' };

const mf = worker({ OPENAI_API_KEY: KEY, ALERT_NOTES_AI_PROVIDER: 'openai' });
try {
  const base = await mf.ready;
  const send = (items, origin = base.origin) => fetch(new URL('/api/alert-notes', base), {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ items }) });

  // 1. The live probe: through the object and back across RPC, with no model asked.
  const probe = await send([{ id: 'probe', kind: 'not-a-kind', company: 'X', line: 'Y' }]);
  assert.equal(probe.status, 200, `the object's answer crosses RPC (${probe.status} ${await probe.clone().text()})`);
  const probed = await probe.json();
  assert.equal(probed.ok, true);
  assert.equal(probed.missing.probe, 'invalid');
  assert.deepEqual(probed.notes, {});
  assert.equal(calls, 0, 'an item the contract rejects costs no model request');

  // 2. A real item: one gpt-6-luna request, a hedged note, stored.
  reply = (input) => completed(input.ITEMS.map((i) => ({ id: i.id, note: 'The merger could simplify the group structure; its financial effect is not stated.' })));
  const first = await (await send([{ ...item, id: '0' }])).json();
  assert.equal(first.ok, true);
  assert.equal(first.notes['0'].model, 'gpt-6-luna');
  assert.equal(first.notes['0'].stored, false);
  assert.match(first.notes['0'].note, /financial effect is not stated/);
  assert.equal(calls, 1);

  // 3. A second reader asking about the same development is answered from SQLite.
  const again = await (await send([{ ...item, id: '5' }])).json();
  assert.equal(again.notes['5'].stored, true);
  assert.equal(calls, 1, 'one development, one model request, whoever asks');

  // 4. Two readers at once pay once.
  const other = { ...item, line: 'Board approves fund raise by way of QIP', headline: 'Board approves fund raise by way of QIP' };
  const [x, y] = await Promise.all([send([{ ...other, id: '0' }]), send([{ ...other, id: '1' }])]);
  assert.equal((await x.json()).notes['0'].note, (await y.json()).notes['1'].note);
  assert.equal(calls, 2, 'a question already with the model is shared inside the object');

  // 5. A named absence crosses RPC too, and a caller's odd id stays an ordinary key.
  reply = () => Response.json({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }, { status: 429 });
  const quota = await (await send([{ ...item, line: 'Outcome of Board Meeting', id: '0' }, { id: '__proto__', kind: 'nope' }])).json();
  assert.equal(quota.missing['0'], 'quota', 'an account with no credit is said in its own words');
  assert.equal(Object.hasOwn(quota.missing, '__proto__') && quota.missing.__proto__ === 'invalid', true);

  // 6. The route's own boundaries still hold in the runtime.
  assert.equal((await send([{ ...item, id: '0' }], 'https://other.example')).status, 403);
  assert.equal((await fetch(new URL('/api/alert-notes', base))).status, 405);
} finally {
  await mf.dispose();
}

// 7. Pinned to OpenAI with no OpenAI key: the note is absent as `no-key` even though a Bedrock key
//    is installed — the notes never quietly move to the costlier model.
const pinned = worker({ ALERT_NOTES_AI_PROVIDER: 'openai', CLAUDE_KEY: 'ABSKfixture-key-for-local-tests' });
try {
  const base = await pinned.ready;
  const before = calls;
  const res = await fetch(new URL('/api/alert-notes', base), { method: 'POST', headers: { origin: base.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ ...item, id: '0' }] }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.missing['0'], 'no-key');
  assert.equal(calls, before, 'no request to any provider');
} finally {
  await pinned.dispose();
}
console.log('PASS: alert notes through real Durable Object RPC and SQLite in workerd — the answer crosses the boundary, gpt-6-luna is asked once per development, absences are named, and the OpenAI pin fails closed.');
