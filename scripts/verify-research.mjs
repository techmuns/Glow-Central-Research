#!/usr/bin/env node
// Focused unit/integration checks for Ask Research. Dependency-free by repository contract.

import assert from 'node:assert/strict';
import {
  buildOpenAIRequest,
  extractWebSources,
  handleResearch,
  researchConfigured,
  takeSseEvents,
  validateResearchBody,
} from '../worker/research.mjs';

// The browser modules initialise against localStorage. Give the Node check the same tiny contract
// before importing the runtime catalog, without relying on Node's experimental Web Storage flag.
const memoryStorage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => memoryStorage.has(key) ? memoryStorage.get(key) : null,
    setItem: (key, value) => memoryStorage.set(key, String(value)),
    removeItem: (key) => memoryStorage.delete(key),
  },
});
const { DASHBOARD_RESEARCH_SOURCES } = await import('../public/js/research/estate.js');

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log(`PASS  ${label}`);
};

ok('the runtime research catalog covers every visible research tab and hidden portfolio analytics', () => {
  const tabs = new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.tab));
  for (const title of ['Daily Alerts', 'Earnings Hub', 'Con-call', 'Public Chatter', 'Breakouts / Technical', 'Super Investors', 'News', 'Corp Announcements', 'Insider Trades', 'Portfolio Analytics']) {
    assert.equal(tabs.has(title), true, title);
  }
  assert.equal(new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.id)).size, DASHBOARD_RESEARCH_SOURCES.length);
});

ok('configuration requires a non-trivial server-side API key', () => {
  assert.equal(researchConfigured({}), false);
  assert.equal(researchConfigured({ OPENAI_API_KEY: 'short' }), false);
  assert.equal(researchConfigured({ OPENAI_API_KEY: 'sk-test-research-key' }), true);
});

const valid = validateResearchBody({
  question: 'What changed?',
  scope: 'portfolio',
  webResearch: true,
  history: [{ role: 'user', text: 'Earlier question' }, { role: 'tool', text: 'not permitted' }],
  evidence: { catalog: [{ id: 'earnings-hub' }], sources: [] },
});

ok('request validation bounds and normalises history', () => {
  assert.equal(valid.ok, true);
  assert.equal(valid.history.length, 1);
  assert.equal(valid.webResearch, true);
  assert.equal(validateResearchBody({ evidence: {} }).error, 'missing_question');
});

ok('web mode requires hosted search and keeps provider storage off', () => {
  const request = buildOpenAIRequest(valid, { OPENAI_MODEL: 'gpt-test' });
  assert.equal(request.model, 'gpt-test');
  assert.deepEqual(request.tools, [{ type: 'web_search' }]);
  assert.equal(request.tool_choice, 'required');
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
});

ok('SSE framing waits for complete blocks', () => {
  const first = takeSseEvents('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel');
  assert.equal(first.events.length, 0);
  const second = takeSseEvents(`${first.rest}lo"}\n\n`);
  assert.equal(second.events.length, 1);
  assert.equal(JSON.parse(second.events[0]).delta, 'Hello');
});

ok('web citations are de-duplicated and bounded', () => {
  const sources = extractWebSources({
    output: [
      { type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'Example A' }] }] },
      { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/a', title: 'Duplicate' }, { url: 'https://example.org/b', title: 'Example B' }] } },
    ],
  });
  assert.deepEqual(sources.map((source) => source.url), ['https://example.com/a', 'https://example.org/b']);
});

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.authorization, 'Bearer sk-test-research-key');
    const requested = JSON.parse(init.body);
    assert.equal(requested.tools[0].type, 'web_search');
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"Earnings improved. [Dashboard: Earnings Hub]"}',
      '',
      'data: {"type":"response.web_search_call.searching"}',
      '',
      'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"annotations":[{"type":"url_citation","url":"https://example.com/result","title":"Result source"}]}]}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const body = JSON.stringify({
    question: 'What changed?',
    scope: 'portfolio',
    webResearch: true,
    history: [],
    evidence: { catalog: [{ id: 'earnings-hub', status: 'ready' }], sources: [{ id: 'earnings-hub', status: 'ready', rows: [] }] },
  });
  const response = await handleResearch(
    new Request('https://dashboard.example/api/research', {
      method: 'POST',
      headers: { origin: 'https://dashboard.example', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    }),
    {
      OPENAI_API_KEY: 'sk-test-research-key',
      OPENAI_MODEL: 'gpt-test',
      RESEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    }
  );
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

  ok('the Worker streams normalised text, web sources and a valid completion', () => {
    assert.equal(response.status, 200);
    assert.equal(events.some((event) => event.type === 'text' && /Earnings improved/.test(event.text)), true);
    assert.equal(events.some((event) => event.type === 'sources' && event.sources[0]?.url === 'https://example.com/result'), true);
    assert.equal(events.at(-1).type, 'done');
  });
} finally {
  globalThis.fetch = originalFetch;
}

const notConfigured = await handleResearch(new Request('https://dashboard.example/api/research'), {});
const configBody = await notConfigured.json();
ok('the configuration route fails closed without exposing provider details', () => {
  assert.deepEqual(configBody, { configured: false, webResearchAvailable: false, history: 'device' });
});

const wrongOrigin = await handleResearch(
  new Request('https://dashboard.example/api/research', {
    method: 'POST',
    headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Test', evidence: {} }),
  }),
  { OPENAI_API_KEY: 'sk-test-research-key' }
);
ok('the paid research route rejects cross-origin submissions', () => {
  assert.equal(wrongOrigin.status, 403);
});

const oversized = await handleResearch(
  new Request('https://dashboard.example/api/research', {
    method: 'POST',
    headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
    body: 'x'.repeat(180_001),
  }),
  { OPENAI_API_KEY: 'sk-test-research-key' }
);
ok('the request-body bound is enforced on bytes even without a content-length header', () => {
  assert.equal(oversized.status, 413);
});

console.log(`\n${checks} Ask Research checks passed.`);
