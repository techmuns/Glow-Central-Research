#!/usr/bin/env node
// EVERY RESEARCH RESPONSE MUST END WITH AN ENDING THE READER CAN NAME.
//
// The browser reports "The connection closed before the answer finished" for exactly one
// condition: a well-formed NDJSON body that reaches EOF carrying no `done` and no `error`. That
// sentence is the only one Ask Research can say about a stream with no ending in it, and it is
// undiagnosable — it describes the reader's socket rather than anything that actually happened,
// so it sends somebody to investigate a provider that may never have been asked anything.
//
// Every branch of researchStream writes a terminal event, and each upstream ending has its own
// wording (a provider failure, an answer limit, a timeout, a cancellation). What was missing was
// the GUARANTEE: an enqueue that throws skipped the event and let teardown close the body cleanly.
// So this asserts the property rather than any one branch — whatever the upstream does, the last
// line of the response is a terminal event, and there is exactly one of them.
//
// No paid calls: the Muns provider path is driven with a stubbed fetch, as verify-research-completion does.
import assert from 'node:assert/strict';
import { handleResearch } from '../worker/research.mjs';

const encoder = new TextEncoder();
const env = { MUNS_TOKEN: 'synthetic-test-credential' };
const question = () => new Request('https://dashboard.example/api/research', {
  method: 'POST',
  headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'What changed today?', scope: 'portfolio', history: [], evidence: { sources: [] } }),
});
const answerFrame = text => encoder.encode(JSON.stringify({ text: `<research-answer>${text}</research-answer>` }) + '\n');
const ndjsonBody = body => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });

// Each ending a real deployment can produce, including the ones that used to be able to
// close the body without saying anything.
const endings = {
  'complete answer': () => ndjsonBody(new ReadableStream({ start(c) { c.enqueue(answerFrame('A complete answer.')); c.close(); } })),
  'eof with no answer': () => ndjsonBody(new ReadableStream({ start(c) { c.close(); } })),
  'eof mid-answer': () => ndjsonBody(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(JSON.stringify({ text: '<research-answer>Partial' }))); c.close(); } })),
  'upstream errors mid-stream': () => ndjsonBody(new ReadableStream({
    start(c) { c.enqueue(answerFrame('Partial answer.')); c.error(new Error('upstream reset')); } })),
  'malformed frame': () => ndjsonBody(new ReadableStream({ start(c) { c.enqueue(encoder.encode('{not json}\n')); c.close(); } })),
  'oversized frame': () => ndjsonBody(new ReadableStream({ start(c) { c.enqueue(encoder.encode('x'.repeat(64_001))); c.close(); } })),
  'upstream 500': () => new Response('upstream unavailable', { status: 500 }),
  'upstream 401': () => new Response('denied', { status: 401 }),
  'no upstream body': () => new Response(null, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
  'upstream fetch rejects': () => { throw new TypeError('network down'); },
};

// THE CASE THE BRANCHES ABOVE CANNOT REACH: the terminal write itself fails.
// This is the condition the guarantee exists for and the only one that used to close the body
// with nothing in it. It cannot be produced by any upstream, so it is injected here — the first
// terminal enqueue throws, exactly as a detached controller would, and the teardown must still
// hand the reader an ending. Without the backstop this case yields a body whose last line is a
// `text` event, which is precisely the artefact the reader could only call "connection closed".
const RealReadableStream = globalThis.ReadableStream;
async function withFailingTerminalWrite(run) {
  let refused = false;
  class InjectedStream extends RealReadableStream {
    constructor(source, strategy) {
      if (source && typeof source.start === 'function' && !refused) {
        const start = source.start.bind(source);
        source = { ...source, start(controller) {
          return start({
            enqueue(value) {
              const line = new TextDecoder().decode(value);
              if (!refused && /"type":"(?:done|error)"/.test(line)) { refused = true; throw new TypeError('controller is detached'); }
              return controller.enqueue(value);
            },
            close() { return controller.close(); },
          });
        } };
      }
      super(source, strategy);
    }
  }
  globalThis.ReadableStream = InjectedStream;
  // `return run()` would restore the global at the first await inside handleResearch, long
  // before researchStream builds its body — the injection has to outlive the whole read.
  try { return await run(); } finally { globalThis.ReadableStream = RealReadableStream; }
}

const originalFetch = globalThis.fetch;
let failures = 0;
try {
  for (const [name, upstream] of Object.entries(endings)) {
    globalThis.fetch = async () => upstream();
    const response = await handleResearch(question(), env);
    const body = (await response.text()).trim();

    // A validation refusal is a plain JSON error with its own HTTP status, not a stream.
    if (response.status !== 200) { console.log(`SKIP ${name} — refused before streaming (HTTP ${response.status})`); continue; }

    let events;
    try { events = body.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { console.log(`FAIL ${name} — response body is not valid NDJSON`); failures++; continue; }

    const terminals = events.filter(event => ['done', 'error'].includes(event.type));
    try {
      assert(events.length > 0, 'the response carries at least one event');
      assert.equal(terminals.length, 1, `exactly one terminal event (saw ${terminals.length})`);
      assert(['done', 'error'].includes(events.at(-1).type), 'the LAST event is the terminal one');
      // An error must say something; a reader cannot act on an empty reason.
      if (events.at(-1).type === 'error') {
        assert(typeof events.at(-1).message === 'string' && events.at(-1).message.trim().length > 10,
          'a terminal error carries a message a reader can act on');
        assert(typeof events.at(-1).reason === 'string' && events.at(-1).reason, 'a terminal error names a reason');
      }
      console.log(`PASS ${name} — ends with ${events.at(-1).type}${events.at(-1).reason ? ` (${events.at(-1).reason})` : ''}`);
    } catch (error) {
      console.log(`FAIL ${name} — ${error.message}`);
      failures++;
    }
  }

  // The injected failure: the first terminal write is refused.
  globalThis.fetch = async () => ndjsonBody(new ReadableStream({ start(c) { c.enqueue(answerFrame('Partial answer that never finished.')); c.close(); } }));
  const injected = await withFailingTerminalWrite(async () => {
    const response = await handleResearch(question(), env);
    return (await response.text()).trim();
  });
  const injectedEvents = injected.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const injectedTerminals = injectedEvents.filter(event => ['done', 'error'].includes(event.type));
  try {
    assert.equal(injectedTerminals.length, 1, `a refused terminal write is replaced, not dropped (saw ${injectedTerminals.length})`);
    assert.equal(injectedEvents.at(-1).type, 'error', 'the replacement is the last event');
    assert.equal(injectedEvents.at(-1).reason, 'incomplete_stream', 'and it names the ending honestly rather than borrowing a provider failure');
    assert(injectedEvents.some(event => event.type === 'text'), 'the partial answer already delivered is kept');
    console.log('PASS refused terminal write — ends with error (incomplete_stream), partial answer retained');
  } catch (error) {
    console.log(`FAIL refused terminal write — ${error.message}`);
    failures++;
  }
} finally {
  globalThis.fetch = originalFetch;
}

if (failures) { console.error(`\n${failures} research response(s) ended without a nameable ending.`); process.exit(1); }
console.log('\nPASS Every research response ends with exactly one terminal event.');
