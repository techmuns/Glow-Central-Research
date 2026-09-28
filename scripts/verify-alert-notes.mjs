#!/usr/bin/env node
// OPTIONAL AI SUMMARY — contract, Worker store, route and browser client, with stub model replies.
//
// No request leaves this process: the model is a stub fetcher, the Durable Object's SQLite is
// node:sqlite, and the browser client's `fetch` is replaced. What is asserted is the contract the
// line runs on — what the model is shown, what it may say, that one development costs one request
// whoever asks, that every absence carries its reason, and that the card and the row ask the same
// question about the same development.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };

const shared = await import('../public/js/data/alert-notes-shared.js');
const { AlertNotesStore, NOTE_DAILY_LIMIT, NOTE_MAX_ATTEMPTS } = await import('../worker/alert-notes-store.mjs');
const { handleAlertNotes } = await import('../worker/alert-notes.mjs');
const notes = await import('../public/js/data/alert-notes.js');
const dev = await import('../public/js/data/alert-developments.js');
const ai = await import('../public/js/data/ai-alerts.js');

// ---------------------------------------------------------------------------------------
// 1. The contract
// ---------------------------------------------------------------------------------------
const item = shared.noteItem({
  id: 'x', kind: 'filing', documentType: 'orders', company: 'Puravankara Ltd', ticker: 'PURVA', sector: 'Realty', day: '2026-09-17',
  line: 'Secures ₹2,600 Cr redevelopment project in Goregaon', headline: 'Puravankara Limited secures Rs. 2600 Crore redevelopment project in Goregaon',
  detail: 'The company secured the Goregaon redevelopment project worth Rs 2600 crore. It covers 12 acres and the agreement provides for completion in 48 months. The work includes residential construction, site preparation and associated infrastructure; approvals remain pending.', related: ['a', 'b', 'c', 'd'],
});
assert.equal(item.related.length, 3, 'at most three related headlines');
assert.equal(shared.noteItem({ id: 'x', kind: 'tape', company: 'A', line: 'B' }), null, 'a price or volume reading is not an item');
assert.equal(shared.noteItem({ id: 'x', kind: 'filing', documentType: 'orders', company: 'A', line: '' }), null, 'an item needs its line');
assert.equal(shared.noteContent({ ...item, id: 'other' }), shared.noteContent(item), 'the id is not part of what a note is stored under');
assert.notEqual(shared.noteContent({ ...item, line: 'Something else' }), shared.noteContent(item));
assert.equal(shared.noteContent({ ...item, sector: 'Changed classification', related: ['A new news report'] }), shared.noteContent(item), 'irrelevant metadata does not repurchase the summary');
const ok = (note) => shared.acceptNote(note, item);
assert.equal(ok('The ₹2,600 Cr project covers 12 acres, with completion scheduled in 48 months.').ok, true);
assert.equal(ok('The project will be completed in 48 months.').ok, true, 'source-stated future actions are factual summaries');
assert.equal(shared.acceptNote('The board recommended a dividend of Rs 5 per share.', { ...item, detail: 'The board recommended a dividend of Rs 5 per share.' }).ok, true, 'a dividend recommendation is a corporate action, not investment advice');
assert.equal(ok('Investors should buy the stock on this win.').reason, 'advice');
for (const advice of ['We recommend a buy.', 'Recommend selling the shares.', 'Recommend to hold.']) assert.equal(ok(advice).reason, 'advice');
assert.equal(ok('Shares could rally on the news.').reason, 'price-call');
assert.equal(ok('Could add ₹400 crore of revenue in FY28.').reason, 'unsupported-figure');
assert.equal(ok('The project supports FY27 bookings.').reason, 'unsupported-figure', 'summaries cannot add an unstated fiscal year');
assert.equal(ok(item.line).reason, 'not-needed', 'a repeated headline adds no summary');
assert.equal(shared.noteItem({ ...item, kind: 'news' }), null, 'news cannot trigger generation even from an old client');
assert.equal(shared.noteItem({ ...item, documentType: 'routine' }), null);
assert.equal(shared.noteItem({ ...item, detail: item.line }), null, 'no call for repeated headline text');
assert.equal(shared.noteItem({ ...item, detail: 'BSE · Corporate action' }), null, 'a type label is not document content');
for (const type of shared.SUMMARY_TYPES) assert(shared.noteItem({ ...item, documentType: type }), type);
assert.equal(shared.summaryTypeOf({ kind: 'filing', headline: 'Press Release', detail: 'Receipt of order worth Rs 2600 crore' }), 'orders');
assert.equal(shared.summaryTypeOf({ kind: 'filing', subCategory: 'Newspaper Publication', headline: 'Financial results', detail: item.detail }), null);
assert.equal(shared.summaryTypeOf({ kind: 'filing', headline: 'Board Meeting Intimation', detail: 'Board meeting scheduled next week.' }), null);
const parsed = shared.parseNotes('```json\n[{"id":"0","note":"May add to the pipeline."},{"id":"9","note":"stray"},{"id":"0","note":"dup"}]\n```', new Set(['0']));
assert.deepEqual(parsed, { 0: 'May add to the pipeline.' }, 'fences are tolerated; unknown and repeated ids are dropped');
assert.equal(shared.parseNotes('no json here', new Set(['0'])), null);
const body = shared.noteRequest([item], 'model-x', '2026-09-23');
assert.equal(body.thinking.type, 'disabled');
const sent = JSON.parse(body.messages[0].content);
assert.equal(Object.hasOwn(sent, 'CONTEXT'), false, 'no current date or fiscal-year facts are injected');
assert.equal(sent.ITEMS[0].documentType, 'orders');
assert.match(shared.NOTE_INSTRUCTIONS, /Do not infer earnings, valuation/);
assert.match(shared.NOTE_INSTRUCTIONS, /note: null/);
assert.equal(sent.ITEMS[0].statement, item.line, 'the model is shown the line the card prints');
assert.equal(Object.hasOwn(sent.ITEMS[0], 'url'), false, 'no link or document is sent — headlines and statements only');
console.log('PASS the contract: bounded items, content-keyed, optional document types, source-only facts, and every refusal the line runs on.');

// ---------------------------------------------------------------------------------------
// 2. The Worker store
// ---------------------------------------------------------------------------------------
function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  return { sql: { exec: (sql, ...args) => { const rows = db.prepare(sql).all(...args); return { toArray: () => rows }; } },
    transactionSync(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const KEY_ENV = { CLAUDE_KEY: 'ABSK-test-key-for-stub-only', BEDROCK_REGION: 'ap-south-1', BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-5' };
const reply = (list, status = 200) => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(list) }] }), { status, headers: { 'content-type': 'application/json' } });
{
  const calls = [];
  let answer = (items) => reply(items.map((i) => ({ id: i.id, note: 'The ₹2,600 Cr project covers 12 acres, with completion scheduled in 48 months.' })));
  const fetcher = async (url, init) => {
    const parsedBody = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, items: JSON.parse(parsedBody.messages[0].content).ITEMS });
    return answer(JSON.parse(parsedBody.messages[0].content).ITEMS);
  };
  const store = new AlertNotesStore(sqlStorage(), KEY_ENV, { fetcher, now: () => Date.parse('2026-09-23T06:00:00Z') });
  for (const raw of [{ ...item, kind: 'news' }, { ...item, documentType: 'routine' }, { ...item, detail: item.line }]) {
    assert.equal((await store.read([{ ...raw, id: 'skip' }])).missing.skip, 'not-needed');
  }
  assert.equal(calls.length, 0, 'the server also skips news, routine and headline-only requests');
  const first = await store.read([{ ...item, id: 'a' }]);
  assert.equal(first.notes.a.stored, false);
  assert.match(first.notes.a.note, /12 acres/);
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
  // A refused answer is absent, but its receipt prevents another charge for the same input.
  answer = (items) => reply(items.map((i) => ({ id: i.id, note: 'Could add ₹900 crore to FY27 revenue.' })));
  const refused = await store.read([{ ...item, line: 'A different development', id: 'r' }]);
  assert.equal(refused.missing.r, 'unsupported-figure');
  const callsBeforeRetry = calls.length;
  const retried = await store.read([{ ...item, line: 'A different development', id: 'r2' }]);
  assert.equal(retried.missing.r2, 'unsupported-figure', 'a refused note was not stored as a note');
  assert.equal(calls.length, callsBeforeRetry, 'a rejected answer is not purchased again');
  assert.equal(retried.retryAt.r2, null, 'withheld output is terminal for this evidence');
  answer = () => new Response('{}', { status: 403 });
  assert.equal((await store.read([{ ...item, line: 'Refused by provider', id: 'p' }])).missing.p, 'refused');
  answer = () => new Response('{}', { status: 429 });
  assert.equal((await store.read([{ ...item, line: 'Rate limited', id: 'q' }])).missing.q, 'rate-limited');
  answer = () => new Response('not json at all', { status: 200 });
  assert.equal((await store.read([{ ...item, line: 'Unreadable reply', id: 'u' }])).missing.u, 'unreadable');
  const status = store.status();
  assert.equal(status.limit, NOTE_DAILY_LIMIT);
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
  console.log('PASS the store: one request per development, shared in flight, rejection receipts, every absence named, the day bounded.');
}

// A refresh, another browser, day rollover and object eviction must share durable cost controls.
{
  let clock = Date.parse('2026-09-28T08:00:00Z'), calls = 0;
  const disk = sqlStorage();
  let answer = (items) => reply(items.map(i => ({ id: i.id, note: 'Asha Rao resigned as director for personal reasons, effective 23 September 2026.' })));
  const options = { now: () => clock, fetcher: async (_url, init) => {
    calls++;
    return answer(JSON.parse(JSON.parse(init.body).messages[0].content).ITEMS);
  } };
  let store = new AlertNotesStore(disk, KEY_ENV, options);
  const event = { ...item, company: 'Fractal Analytics Limited', ticker: 'FRACTAL', sector: 'Information Technology',
    documentType: 'management', day: '2026-09-23', line: 'Resignation of Director/KMP/SMP.', headline: 'Resignation',
    detail: 'Director Asha Rao resigned effective 23 September 2026 for personal reasons. The company stated that there were no other material reasons for her resignation.', related: [] };
  const first = await store.read([{ ...event, id: 'card' }, { ...event, id: 'row' }]);
  assert.equal(calls, 1);
  assert.equal(store.status().used, 1, 'duplicates in one batch consume one allowance item');
  assert.equal(first.notes.card.note, first.notes.row.note);
  assert.equal(first.notes.card.generatedAt, new Date(clock).toISOString());
  store = new AlertNotesStore(disk, KEY_ENV, options);
  assert.equal((await store.read([{ ...event, id: 'reload' }])).notes.reload.stored, true);
  assert.equal(calls, 1, 'a new browser/server instance uses the saved note');
  clock += 70 * 86_400_000;
  store.spend(1); // This used to delete notes older than 60 days.
  assert.equal((await store.read([{ ...event, id: 'history' }])).notes.history.stored, true);
  assert.equal(calls, 1, 'All history does not repurchase an old reading');

  for (const [reason, makeReply] of [
    ['unsupported-figure', items => reply(items.map(i => ({ id: i.id, note: 'Could add 999 crore revenue.' })))],
    ['empty', () => reply([])],
    ['not-needed', items => reply(items.map(i => ({ id: i.id, note: null })))],
    ['unreadable', () => new Response('not json')],
  ]) {
    answer = makeReply;
    const bad = { ...event, line: `${event.line} ${reason}` };
    const result = await store.read([{ ...bad, id: 'first' }]);
    assert.equal(result.missing.first, reason);
    assert.equal(result.retryAt.first, null);
    const before = calls;
    for (let i = 0; i < 3; i++) {
      clock += 86_400_000;
      store = new AlertNotesStore(disk, KEY_ENV, options);
      assert.equal((await store.read([{ ...bad, id: 'refresh' }])).missing.refresh, reason);
    }
    assert.equal(calls, before, `${reason} is not purchased again after reloads/rollover`);
  }

  answer = () => { throw new DOMException('Stub timeout', 'TimeoutError'); };
  const outage = { ...event, line: 'A changed source statement during an outage' };
  const before = calls;
  for (let attempt = 1; attempt <= NOTE_MAX_ATTEMPTS; attempt++) {
    const result = await store.read([{ ...outage, id: 'first' }]);
    assert.equal(calls, before + attempt);
    assert.equal(result.missing.first, attempt === NOTE_MAX_ATTEMPTS ? 'retry-exhausted' : 'timeout');
    store = new AlertNotesStore(disk, KEY_ENV, options);
    await store.read([{ ...outage, id: 'reload' }]);
    assert.equal(calls, before + attempt, 'a second reader cannot bypass the durable backoff');
    clock = result.retryAt.first ?? clock + 86_400_000;
  }
  clock += 90 * 86_400_000;
  store = new AlertNotesStore(disk, KEY_ENV, options);
  assert.equal((await store.read([{ ...outage, id: 'later' }])).missing.later, 'retry-exhausted');
  assert.equal(calls, before + NOTE_MAX_ATTEMPTS, 'the cap survives day rollover and old history');
  answer = items => reply(items.map(i => ({ id: i.id, note: 'Asha Rao resigned as director for personal reasons, effective 23 September 2026.' })));
  assert((await store.read([{ ...outage, line: 'Corrected source statement', id: 'correction' }])).notes.correction);
  assert.equal(calls, before + NOTE_MAX_ATTEMPTS + 1, 'a genuine source correction is eligible');

  // Simulate eviction while the provider call has no answer: its receipt already exists.
  let release;
  answer = () => new Promise(resolve => { release = resolve; });
  const interrupted = { ...event, line: 'An interrupted provider call' };
  const pending = store.read([{ ...interrupted, id: 'waiting' }]);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const callsInFlight = calls;
  const restarted = new AlertNotesStore(disk, KEY_ENV, options);
  const held = await restarted.read([{ ...interrupted, id: 'returned' }]);
  assert.equal(held.missing.returned, 'timeout');
  assert(held.retryAt.returned > clock);
  assert.equal(calls, callsInFlight, 'an interrupted request cannot be immediately charged again');
  release(reply([{ id: 'waiting', note: 'Asha Rao resigned as director for personal reasons, effective 23 September 2026.' }]));
  await pending;
  assert.equal((await restarted.read([{ ...interrupted, id: 'saved' }])).notes.saved.stored, true);
  console.log('PASS FRACTAL refresh/reload, batch dedupe, retained history, terminal outcomes, bounded retries, corrections and interrupted requests.');
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
  assert.equal((await handleAlertNotes(post({ items: [item] }), {})).status, 503, 'a deployment without the store says so');
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
    filingSubCategory: 'Award of Order / Receipt of Order', filingDescription: item.detail, detail: 'BSE · Press Release', url: 'https://www.bseindia.com/g.pdf', importance: 'high', direction: 'neutral', aiEligible: true };
  const report = { id: 'news:1', feed: 'news', ticker: 'PURVA', company: 'Puravankara Ltd', day: '2026-09-18', time: '08:00',
    headline: 'Puravankara bags ₹2,600-crore redevelopment project in Goregaon', attribution: confirmed, importance: 'high', direction: 'neutral', aiEligible: true, detail: 'Published by Mint' };
  const uncertain = { ...report, id: 'news:2', headline: 'Goregaon redevelopment: Puravankara ₹2,600 crore project explained', attribution: { ...confirmed, status: 'uncertain' } };
  // The card sees what the ranking admits; the stream sees everything. Same development, same question.
  const cardDev = dev.foldDevelopments([report, filing], { companyNames: ['Puravankara Limited'] }).find((d) => d.lead === filing);
  const rowDev = dev.developmentOfRow(dev.foldAlertRows([uncertain, report, filing]).find((row) => row.id === filing.id));
  const fromCard = notes.noteRequestFor(cardDev, { fallback: ai.plainHeadline(filing) });
  const fromRow = notes.noteRequestFor(rowDev, { fallback: ai.plainHeadline(filing) });
  assert.equal(fromCard.key, fromRow.key, 'AI Alerts and All Alerts ask the identical question about one development');
  assert.equal(notes.noteRequestFor(dev.foldDevelopments([report])[0]), null, 'confirmed news needs no summary');
  assert.equal(notes.noteRequestFor(dev.foldDevelopments([{ ...filing, filingDescription: null }])[0]), null, 'a headline alone is sufficient');
  assert.equal(notes.noteRequestFor(dev.foldDevelopments([{ ...filing, filingSubCategory: 'Resignation of Director', headline: 'Resignation', filingSubject: 'Resignation of Director/KMP/SMP.', filingDescription: 'Resignation of Director/KMP/SMP.' }])[0]), null, 'the reported FRACTAL-style category-only notice has no summary request');
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
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const items = JSON.parse(init.body).items;
      seen.push(items);
      return new Response(JSON.stringify({ ok: true, notes: { 0: { note: 'The ₹2,600 Cr project covers 12 acres, with completion scheduled in 48 months.', model: 'm', stored: false } },
        missing: Object.fromEntries(items.slice(1).map((_, i) => [String(i + 1), 'budget'])) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const other = notes.noteRequestFor(dev.foldDevelopments([{ ...filing, id: 'ann:3', headline: 'Allotment of shares', filingSubject: 'Allotment of shares under ESOP' }])[0], {});
    notes.requestNotes([fromCard, other]);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(seen.length, 1, 'one batched request');
    assert.equal(seen[0].length, 2);
    assert.equal(Object.hasOwn(seen[0][0], 'url'), false, 'the page sends no link');
    assert.equal(notes.noteState(fromCard).state, 'ready');
    assert.match(notes.noteState(fromCard).note, /12 acres/);
    assert.equal(notes.noteState(other).reason, 'budget', "the day's allowance is said on the card");
    notes.requestNotes([fromCard, other]);
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(seen.length, 1, 'an answered question and a held one are not asked again');
    assert.match(notes.reasonText('budget'), /allowance/);

    // Server retry decisions override the old five-minute client retry for rejected output.
    notes.resetNotes();
    let now = Date.now(), count = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const retryTime = now + 600_000;
      globalThis.fetch = async () => {
        count++;
        return Response.json({ ok: true, notes: {}, missing: { 0: 'unreadable', 1: 'timeout' }, retryAt: { 0: null, 1: retryTime } });
      };
      notes.requestNotes([fromCard, other]);
      await new Promise(done => setTimeout(done, 250));
      assert.equal(notes.noteState(fromCard).retryAt, Infinity);
      assert.equal(notes.noteState(other).retryAt, retryTime);
      now += 5 * 60_000 + 1;
      notes.requestNotes([fromCard, other]);
      await new Promise(done => setTimeout(done, 250));
      assert.equal(count, 1, 'automatic refresh cannot restart a terminal or held reading');
      notes.resetNotes();
      now = Date.parse('2027-04-02T08:00:00Z');
      globalThis.fetch = async () => Response.json({ ok: true, notes: { 0: {
        note: 'The project covers 12 acres with completion scheduled in 48 months.', generatedAt: '2026-09-28T08:00:00Z', stored: true,
      } }, missing: {} });
      notes.requestNotes([fromCard]);
      await new Promise(done => setTimeout(done, 250));
      assert.equal(notes.noteState(fromCard).state, 'ready', 'a saved factual summary is reused after date rollover');
      const ui = await import('../public/js/ui/alert-note.js');
      assert.match(ui.noteRowHtml(fromCard), /AI summary/);
      assert.equal(ui.noteExportText(fromCard), notes.noteState(fromCard).note);
      notes.resetNotes();
      let skippedCalls = 0;
      globalThis.fetch = async () => {
        skippedCalls++;
        return Response.json({ ok: true, notes: {}, missing: { 0: 'not-needed' }, retryAt: { 0: null } });
      };
      notes.requestNotes([fromCard]);
      await new Promise(done => setTimeout(done, 250));
      assert.equal(notes.noteState(fromCard).state, 'skipped');
      assert.equal(ui.noteIsSkipped(fromCard), true);
      assert.equal(ui.noteBodyHtml(fromCard), '');
      assert.equal(ui.noteRowHtml(fromCard), '');
      assert.equal(ui.noteExportText(fromCard), '');
      notes.requestNotes([fromCard]);
      await new Promise(done => setTimeout(done, 250));
      assert.equal(skippedCalls, 1, 'a no-summary result is never retried on refresh');
    } finally { Date.now = realNow; }
  } finally {
    globalThis.fetch = realFetch;
    notes.resetNotes();
  }
  console.log('PASS the client: one batched request, named absences, held deployments, and one question per development on both surfaces.');
}
