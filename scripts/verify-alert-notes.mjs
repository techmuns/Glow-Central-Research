#!/usr/bin/env node
// THE "SO WHAT?" LINE — contract, Worker store, route and browser client, with stub model replies.
//
// No request leaves this process: the model is a stub fetcher, the Durable Object's SQLite is
// node:sqlite, and the browser client's `fetch` is replaced. What is asserted is the contract the
// line runs on — what the model is shown, what it may say, that one development costs one request
// whoever asks, that every absence carries its reason, and that the card and the row ask the same
// question about the same development.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

const shared = await import('../public/js/data/alert-notes-shared.js');
const { AlertNotesStore, NOTE_DAILY_LIMIT, NOTE_OPENAI_MODEL, noteProvider } = await import('../worker/alert-notes-store.mjs');
const { NEWS_PRICES } = await import('../worker/newsletter-openai.mjs');
const { handleAlertNotes } = await import('../worker/alert-notes.mjs');
const notes = await import('../public/js/data/alert-notes.js');
const dev = await import('../public/js/data/alert-developments.js');
const ai = await import('../public/js/data/ai-alerts.js');

// ---------------------------------------------------------------------------------------
// 1. The contract
// ---------------------------------------------------------------------------------------
const item = shared.noteItem({
  id: 'x', kind: 'filing', company: 'Puravankara Ltd', ticker: 'PURVA', sector: 'Realty', day: '2026-09-17',
  line: 'Secures ₹2,600 Cr redevelopment project in Goregaon', headline: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon',
  detail: 'BSE · Press Release', related: ['a', 'b', 'c', 'd'],
});
assert.equal(item.related.length, 3, 'at most three related headlines');
assert.equal(shared.noteItem({ id: 'x', kind: 'tape', company: 'A', line: 'B' }), null, 'a price or volume reading is not an item');
assert.equal(shared.noteItem({ id: 'x', kind: 'filing', company: 'A', line: '' }), null, 'an item needs its line');
assert.equal(shared.noteContent({ ...item, id: 'other' }), shared.noteContent(item), 'the id is not part of what a note is stored under');
assert.notEqual(shared.noteContent({ ...item, line: 'Something else' }), shared.noteContent(item));
assert.deepEqual(shared.fiscalYearOf('2026-09-23'), { label: 'FY27', next: 'FY28', endYear: 2027 }, 'April 2026 – March 2027 is FY27');
assert.equal(shared.fiscalYearOf('2026-03-31').label, 'FY26');
const ok = (note) => shared.acceptNote(note, item, '2026-09-23');
assert.equal(ok('Unlikely to move FY27 revenue at once; the ₹2,600 Cr project mainly adds to the development pipeline for later years.').ok, true,
  'a hedged note naming the given figure and fiscal year is kept');
assert.equal(ok('This will lift FY27 profit.').reason, 'unhedged', '"will" is refused');
assert.equal(ok('Investors should buy the stock on this win.').reason, 'advice');
assert.equal(ok('Shares could rally on the news.').reason, 'price-call');
assert.equal(ok('Could add ₹400 crore of revenue in FY28.').reason, 'unsupported-figure', 'a figure the source does not state is refused');
assert.equal(ok('Could add to FY29 bookings.').reason, 'unsupported-figure', 'only the two fiscal years given may be named');
const parsed = shared.parseNotes('```json\n[{"id":"0","note":"May add to the pipeline."},{"id":"9","note":"stray"},{"id":"0","note":"dup"}]\n```', new Set(['0']));
assert.deepEqual(parsed, { 0: 'May add to the pipeline.' }, 'fences are tolerated; unknown and repeated ids are dropped');
assert.equal(shared.parseNotes('no json here', new Set(['0'])), null);
const body = shared.noteRequest([item], 'model-x', '2026-09-23');
assert.equal(body.thinking.type, 'disabled');
const sent = JSON.parse(body.messages[0].content);
assert.match(sent.CONTEXT.fiscalYears.current, /^FY27 \(April 2026 – March 2027\)$/);
assert.equal(sent.ITEMS[0].statement, item.line, 'the model is shown the line the card prints');
assert.equal(Object.hasOwn(sent.ITEMS[0], 'url'), false, 'no link or document is sent — headlines and statements only');
const openBody = shared.noteOpenAIRequest([item], 'gpt-6-luna', '2026-09-23');
assert.equal(openBody.model, 'gpt-6-luna');
assert.equal(openBody.store, false, 'nothing is kept at OpenAI');
assert.equal(openBody.service_tier, 'default');
assert.deepEqual(openBody.reasoning, { effort: 'none' }, 'the newsletter\'s low-cost settings: reasoning off');
assert.deepEqual(openBody.text.format, { type: 'json_schema', name: 'alert_notes', strict: true, schema: shared.NOTE_SCHEMA });
assert.equal(Object.hasOwn(openBody, 'tools'), false, 'no tools: the model reads only what it is given');
const openSent = JSON.parse(openBody.input);
assert.deepEqual(openSent.ITEMS, sent.ITEMS, 'both providers are shown the identical items');
assert.deepEqual(openSent.CONTEXT, sent.CONTEXT);
const rules = shared.NOTE_INSTRUCTIONS.slice(0, shared.NOTE_INSTRUCTIONS.indexOf('Return ONLY'));
assert.ok(rules.length > 500 && shared.NOTE_OPENAI_INSTRUCTIONS.startsWith(rules), 'both providers get the same rules word for word');
assert.deepEqual(shared.parseNotes(JSON.stringify({ notes: [{ id: '0', note: 'May add to the pipeline.' }, { id: '7', note: 'stray' }] }), new Set(['0'])),
  { 0: 'May add to the pipeline.' }, 'the strict-schema object is read, and only ids that were asked about');
assert.match(shared.NOTE_REASON.unavailable, /will be retried/);
for (const reason of ['unavailable', 'no-service', 'quota', 'declined']) assert.doesNotMatch(shared.NOTE_REASON[reason], /no AI service/, `${reason} is not "no AI service"`);
assert.equal(ok('Revenue increases substantially.').ok,false);
assert.equal(ok('It could add 27 crore revenue.').ok,false,'FY27 does not authorise a 27-crore claim');
assert.equal(shared.parseNotes(JSON.stringify([{id:'x',note:{}}]),new Set(['x'])).x,undefined);
console.log('PASS the contract: bounded items, content-keyed, fiscal-year context, and every refusal the line runs on.');

// ---------------------------------------------------------------------------------------
// 2. The Worker store
// ---------------------------------------------------------------------------------------
// What `read()` returns crosses Workers RPC, which refuses an object without Object.prototype
// ("Could not serialize object of type Object"). Node's structuredClone accepts one, so the shape is
// asserted on every read in this file; scripts/verify-alert-notes-runtime.mjs proves it in workerd.
function assertRpcSafe(value, path = 'read()') {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry, index) => assertRpcSafe(entry, `${path}[${index}]`)); return; }
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path} is an ordinary object`);
  for (const [key, entry] of Object.entries(value)) assertRpcSafe(entry, `${path}.${key}`);
}
const realRead = AlertNotesStore.prototype.read;
AlertNotesStore.prototype.read = async function read(...args) { const out = await realRead.apply(this, args); assertRpcSafe(out); return out; };
function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } } };
}
const KEY_ENV = { CLAUDE_KEY: 'ABSK-test-key-for-stub-only', BEDROCK_REGION: 'ap-south-1', BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-5' };
const reply = (list, status = 200) => new Response(JSON.stringify({ stop_reason:'end_turn', content: [{ type: 'text', text: JSON.stringify(list) }] }), { status, headers: { 'content-type': 'application/json' } });
{
  const calls = [];
  let answer = (items) => reply(items.map((i) => ({ id: i.id, note: 'Unlikely to move FY27 revenue at once; it could add to the development pipeline.' })));
  const fetcher = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, items: JSON.parse(parsedBody.messages[0].content).ITEMS });
    return answer(JSON.parse(parsedBody.messages[0].content).ITEMS);
  };
  const store = new AlertNotesStore(sqlStorage(), KEY_ENV, { fetcher, now: () => Date.parse('2026-09-23T06:00:00Z') });
  const first = await store.read([{ ...item, id: 'a' }]);
  assert.equal(first.notes.a.stored, false);
  assert.match(first.notes.a.note, /development pipeline/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/bedrock-runtime\.ap-south-1\.amazonaws\.com\//, 'the key goes only to the AWS endpoint');
  assert.equal(calls[0].headers['x-api-key'], KEY_ENV.CLAUDE_KEY);
  const second = await store.read([{ ...item, id: 'someone-else' }]);
  assert.equal(second.notes['someone-else'].stored, true, 'a second reader asking about the same development is answered from the store');
  assert.equal(calls.length, 1, 'one development, one model request');
  // Two readers at once pay once.
  const fresh = { ...item, line: 'Board approves ₹2,600 Cr fund raise', headline: 'Board approves Rs 2600 crore fund raise' };
  const [x, y] = await Promise.all([store.read([{ ...fresh, id: 'x' }]), store.read([{ ...fresh, id: 'y' }])]);
  assert.equal(x.notes.x.note, y.notes.y.note);
  assert.equal(calls.length, 2, 'a question already with the model is shared, not asked twice');
  // A refused answer is absent with its reason, and nothing is stored for it.
  answer = (items) => reply(items.map((i) => ({ id: i.id, note: 'Could add ₹900 crore to FY27 revenue.' })));
  const refused = await store.read([{ ...item, line: 'A different development', id: 'r' }]);
  assert.equal(refused.missing.r, 'unsupported-figure');
  const retried = await store.read([{ ...item, line: 'A different development', id: 'r2' }]);
  assert.equal(retried.missing.r2, 'unsupported-figure', 'a refused note was not stored as a note');
  answer = () => new Response('{}', { status: 403 });
  assert.equal((await store.read([{ ...item, line: 'Refused by provider', id: 'p' }])).missing.p, 'refused');
  answer = () => new Response('{}', { status: 429 });
  assert.equal((await store.read([{ ...item, line: 'Rate limited', id: 'q' }])).missing.q, 'rate-limited');
  answer = () => new Response('not json at all', { status: 200 });
  assert.equal((await store.read([{ ...item, line: 'Unreadable reply', id: 'u' }])).missing.u, 'unreadable');
  const status = store.status();
  assert.equal(status.limit, NOTE_DAILY_LIMIT);
  assert.equal(status.provider, 'bedrock', 'with only the Bedrock key and no pin, Claude writes the notes');
  assert(status.used >= 6 && status.stored === 2, `the day's spend and the stored notes are counted (${JSON.stringify(status)})`);
  const unconfigured = new AlertNotesStore(sqlStorage(), {}, { fetcher: () => { throw new Error('must not be called'); } });
  assert.equal((await unconfigured.read([{ ...item, id: 'n' }])).missing.n, 'no-key', 'no key is a named state, never a call');
  // The day's allowance.
  const spent = new AlertNotesStore(sqlStorage(), KEY_ENV, { fetcher, now: () => Date.parse('2026-09-23T06:00:00Z') });
  spent.spend(NOTE_DAILY_LIMIT);
  assert.equal((await spent.read([{ ...item, id: 'b' }])).missing.b, 'budget', "past the day's allowance no model is asked");
  await assert.rejects(() => store.read(Array.from({ length: 9 }, (_, i) => ({ ...item, id: String(i) }))), /Invalid notes request/);
  const invalid = await store.read([{ id: 'bad', kind: 'nope' }]);
  assert.equal(invalid.missing.bad, 'invalid');
  const odd = await store.read([{ id: '__proto__', kind: 'nope' }]);
  assert.equal(Object.hasOwn(odd.missing, '__proto__') && odd.missing.__proto__, 'invalid', "a caller's id is an ordinary key, never a prototype");
  console.log('PASS the store: one request per development, shared in flight, refusals unstored, every absence named, the day bounded.');
}

// ---------------------------------------------------------------------------------------
// 2b. gpt-6-luna on OpenAI, and which provider writes the notes
// ---------------------------------------------------------------------------------------
{
  const OPENAI_ENV = { OPENAI_API_KEY: ' sk-test-openai-stub ', ALERT_NOTES_AI_PROVIDER: 'openai' };
  const completed = (list) => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: JSON.stringify({ notes: list }) }] }], usage: { input_tokens: 900, output_tokens: 80 } });
  const calls = [];
  let answer = (items) => completed(items.map((i) => ({ id: i.id, note: 'Unlikely to move FY27 revenue at once; it could add to the development pipeline.' })));
  const fetcher = async (url, init) => {
    const sentBody = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body: sentBody });
    return answer(JSON.parse(sentBody.input).ITEMS);
  };
  const store = new AlertNotesStore(sqlStorage(), { ...KEY_ENV, ...OPENAI_ENV }, { fetcher, now: () => Date.parse('2026-09-23T06:00:00Z') });
  const first = await store.read([{ ...item, id: 'a' }]);
  assert.equal(first.notes.a.model, 'gpt-6-luna');
  assert.match(first.notes.a.note, /development pipeline/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses', 'the OpenAI key goes only to OpenAI');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test-openai-stub', 'the key is sent trimmed');
  assert.equal(Object.hasOwn(calls[0].headers, 'x-api-key'), false, 'the Bedrock key never travels to OpenAI');
  assert.deepEqual({ model: calls[0].body.model, store: calls[0].body.store, reasoning: calls[0].body.reasoning },
    { model: 'gpt-6-luna', store: false, reasoning: { effort: 'none' } });
  assert.equal((await store.read([{ ...item, id: 'b' }])).notes.b.stored, true, 'kept, whoever asks next');
  assert.equal(calls.length, 1);
  const cases = [
    [() => new Response('{}', { status: 401 }), 'refused'],
    [() => Response.json({ error: { type: 'requests', code: 'rate_limit_exceeded' } }, { status: 429 }), 'rate-limited'],
    [() => Response.json({ error: { type: 'insufficient_quota', code: 'insufficient_quota' } }, { status: 429 }), 'quota'],
    [() => new Response('{}', { status: 500 }), 'upstream'],
    [() => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), 'unreadable'],
    [() => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }] }), 'declined'],
    [() => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); }, 'timeout'],
    [() => completed([{ id: 'nobody', note: 'Could add to the pipeline.' }]), 'empty'],
    [(items) => completed(items.map((i) => ({ id: i.id, note: 'This will lift FY27 profit.' }))), 'unhedged'],
  ];
  for (const [index, [reply, reason]] of cases.entries()) {
    answer = reply;
    const read = await store.read([{ ...item, line: `OpenAI case ${index}`, id: 'c' }]);
    assert.equal(read.missing.c, reason, `OpenAI failure case ${index} is ${reason}`);
  }
  const status = store.status();
  assert.deepEqual({ configured: status.configured, provider: status.provider, model: status.model }, { configured: true, provider: 'openai', model: 'gpt-6-luna' });

  assert.equal(noteProvider({}), null);
  assert.deepEqual(noteProvider(KEY_ENV), { id: 'bedrock', model: KEY_ENV.BEDROCK_MODEL_ID }, 'only a Bedrock key, no pin: Claude');
  assert.deepEqual(noteProvider({ ...KEY_ENV, OPENAI_API_KEY: 'sk' }), { id: 'openai', model: 'gpt-6-luna' }, 'both keys, no pin: the low-cost model');
  assert.equal(noteProvider({ ...KEY_ENV, ALERT_NOTES_AI_PROVIDER: 'openai' }), null, 'pinned to OpenAI without its key: no note, never a costlier model');
  assert.equal(noteProvider({ OPENAI_API_KEY: 'sk', ALERT_NOTES_AI_PROVIDER: 'bedrock' }), null);
  assert.equal(noteProvider({ OPENAI_API_KEY: 'sk', ALERT_NOTES_AI_PROVIDER: 'claude' }), null, 'an unrecognised pin fails closed');
  assert.equal(noteProvider({ OPENAI_API_KEY: '   ' }), null, 'a blank key is no key');
  assert.deepEqual(noteProvider({ OPENAI_API_KEY: 'sk', ALERT_NOTES_AI_PROVIDER: ' OpenAI ' }), { id: 'openai', model: 'gpt-6-luna' });
  const cheapest = Math.min(...Object.values(NEWS_PRICES).map(([input]) => input));
  assert.equal(NEWS_PRICES[NOTE_OPENAI_MODEL]?.[0], cheapest, 'the note model is a priced one, and the lowest-priced the Worker knows');
  assert.match(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'), /"ALERT_NOTES_AI_PROVIDER":\s*"openai"/, 'the deployment pins the notes to OpenAI');
  const pinned = new AlertNotesStore(sqlStorage(), { ...KEY_ENV, ALERT_NOTES_AI_PROVIDER: 'openai' }, { fetcher: () => { throw new Error('must not be called'); } });
  assert.equal((await pinned.read([{ ...item, id: 'n' }])).missing.n, 'no-key');
  console.log('PASS gpt-6-luna: the newsletter\'s low-cost settings, one request per development, every OpenAI failure named, and a pin that fails closed.');
}

// ---------------------------------------------------------------------------------------
// 3. The route
// ---------------------------------------------------------------------------------------
{
  const origin = 'https://dash.example';
  const post = (payload, headers = {}) => new Request(`${origin}/api/alert-notes`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers }, body: JSON.stringify(payload),
  });
  let answered = null;
  const env = {
    ALERT_NOTES: { getByName: (name) => ({ alertNotesRead: async (items) => { answered = { name, items }; return { notes: { 0: { note: 'May add to the pipeline.', model: 'm', stored: true } }, missing: {} }; } }) },
    ALERT_NOTES_LIMITER: { limit: async () => ({ success: true }) },
  };
  assert.equal((await handleAlertNotes(new Request(`${origin}/api/alert-notes`), env)).status, 405, 'GET never starts a model request');
  assert.equal((await handleAlertNotes(post({ items: [item] }, { origin: 'https://evil.example' }), env)).status, 403, 'another origin is refused');
  const unconfigured = await handleAlertNotes(post({ items: [item] }), {});
  assert.equal(unconfigured.status, 503, 'a deployment without the store says so');
  assert.equal((await unconfigured.json()).reason, 'notes-unconfigured');
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const failing = await handleAlertNotes(post({ items: [{ ...item, id: '0' }] }), { ...env,
      ALERT_NOTES: { getByName: () => ({ alertNotesRead: async () => { throw new Error('Could not serialize object of type "Object".'); } }) } });
    assert.equal(failing.status, 503);
    assert.equal((await failing.json()).reason, 'notes-unavailable', 'a store that failed is not a store that is missing');
    assert.match(logged.join('\n'), /Could not serialize/, "the store's real failure reaches the operator's log");
  } finally {
    console.error = realError;
  }
  assert.equal((await handleAlertNotes(post({ items: [] }), env)).status, 400);
  assert.equal((await handleAlertNotes(post({ items: Array.from({ length: 9 }, () => item) }), env)).status, 400);
  const limited = await handleAlertNotes(post({ items: [item] }), { ...env, ALERT_NOTES_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).reason, 'rate-limited');
  const good = await handleAlertNotes(post({ items: [{ ...item, id: '0' }] }), env);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  const json = await good.json();
  assert.equal(json.ok, true);
  assert.equal(json.notes['0'].note, 'May add to the pipeline.');
  assert.equal(answered.name, 'alert-notes:v1');
  console.log('PASS the route: POST only, same origin only, bounded, rate-limited, and a store it names.');
}

// ---------------------------------------------------------------------------------------
// 4. The browser client: states, holds, and one question per development across both surfaces
// ---------------------------------------------------------------------------------------
{
  const { ATTRIBUTION_VERSION } = await import('../public/js/data/company-news-attribution.js');
  const confirmed = { version: ATTRIBUTION_VERSION, status: 'confirmed' };
  const filing = { id: 'ann:1', feed: 'announcements', ticker: 'PURVA', company: 'Puravankara Ltd', day: '2026-09-17', time: '18:05',
    headline: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon', filingSubject: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon',
    detail: 'BSE · Press Release', url: 'https://www.bseindia.com/g.pdf', importance: 'high', direction: 'neutral', aiEligible: true };
  const report = { id: 'news:1', feed: 'news', ticker: 'PURVA', company: 'Puravankara Ltd', day: '2026-09-18', time: '08:00',
    headline: 'Puravankara bags ₹2,600-crore redevelopment project in Goregaon', attribution: confirmed, importance: 'high', direction: 'neutral', aiEligible: true, detail: 'Published by Mint' };
  const uncertain = { ...report, id: 'news:2', headline: 'Goregaon redevelopment: Puravankara ₹2,600 crore project explained', attribution: { ...confirmed, status: 'uncertain' } };
  // The card sees what the ranking admits; the stream sees everything. Same development, same question.
  const cardDev = dev.foldDevelopments([report, filing], { companyNames: ['Puravankara Limited'] }).find((d) => d.lead.id === filing.id);
  const rowDev = dev.developmentOfRow(dev.foldAlertRows([uncertain, report, filing]).find((row) => row.id === filing.id));
  const fromCard = notes.noteRequestFor(cardDev, { fallback: ai.plainHeadline(filing) });
  const fromRow = notes.noteRequestFor(rowDev, { fallback: ai.plainHeadline(filing) });
  assert.equal(fromCard.key, fromRow.key, 'AI Alerts and All Alerts ask the identical question about one development');
  assert.equal(notes.noteRequestFor(dev.foldDevelopments([uncertain])[0]), null, 'a possible match is never asked about');
  assert.equal(notes.noteRequestFor(dev.foldDevelopments([{ ...report, id: 't', feed: 'technicals', kind: 'volume' }])[0]), null, 'a volume reading is never asked about');

  const realFetch = globalThis.fetch;
  try {
    notes.resetNotes();
    let posts = 0;
    globalThis.fetch = async () => { posts += 1; return new Response('Unsupported method', { status: 501 }); };
    const changed = [];
    const off = notes.onNotes((handles) => changed.push(...handles));
    notes.requestNotes([fromCard]);
    assert.equal(notes.noteState(fromCard).state, 'pending');
    await new Promise((done) => setTimeout(done, 250));
    assert.deepEqual(notes.noteState(fromCard), { state: 'missing', reason: 'no-worker', retryAt: Infinity }, 'a static origin is a named state, not a fault');
    assert.equal(changed[0], fromCard.handle, 'subscribers hear which question changed');
    notes.requestNotes([fromCard, notes.noteRequestFor(dev.foldDevelopments([{ ...filing, id: 'ann:2', headline: 'Board approves fund raise', filingSubject: 'Board approves fund raise' }])[0], {})]);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(posts, 1, 'a deployment with no AI service is not asked again this session');
    off();

    notes.resetNotes();
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, reason: 'notes-unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
    notes.requestNotes([fromCard]);
    await new Promise((done) => setTimeout(done, 250));
    const failed = notes.noteState(fromCard);
    assert.equal(failed.reason, 'unavailable', 'a Worker that answered with a failure is never "no AI service"');
    assert.ok(Number.isFinite(failed.retryAt), 'and it is asked again once the hold lapses');
    notes.resetNotes();
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, reason: 'notes-unconfigured' }), { status: 503, headers: { 'content-type': 'application/json' } });
    notes.requestNotes([fromCard]);
    await new Promise((done) => setTimeout(done, 250));
    assert.deepEqual(notes.noteState(fromCard), { state: 'missing', reason: 'no-service', retryAt: Infinity }, 'a Worker without the store says so, once');

    notes.resetNotes();
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const items = JSON.parse(init.body).items;
      seen.push(items);
      return new Response(JSON.stringify({ ok: true, notes: { 0: { note: 'Unlikely to move FY27 revenue at once; it could add to the development pipeline.', model: 'm', stored: false } },
        missing: Object.fromEntries(items.slice(1).map((_, i) => [String(i + 1), 'budget'])) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const other = notes.noteRequestFor(dev.foldDevelopments([{ ...filing, id: 'ann:3', headline: 'Allotment of shares', filingSubject: 'Allotment of shares under ESOP' }])[0], {});
    notes.requestNotes([fromCard, other]);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(seen.length, 1, 'one batched request');
    assert.equal(seen[0].length, 2);
    assert.equal(Object.hasOwn(seen[0][0], 'url'), false, 'the page sends no link');
    assert.equal(notes.noteState(fromCard).state, 'ready');
    assert.match(notes.noteState(fromCard).note, /development pipeline/);
    assert.equal(notes.noteState(other).reason, 'budget', "the day's allowance is said on the card");
    notes.requestNotes([fromCard, other]);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(seen.length, 1, 'an answered question and a held one are not asked again');
    assert.match(notes.reasonText('budget'), /allowance/);
  } finally {
    globalThis.fetch = realFetch;
    notes.resetNotes();
  }
  console.log('PASS the client: one batched request, named absences, held deployments, and one question per development on both surfaces.');
}
