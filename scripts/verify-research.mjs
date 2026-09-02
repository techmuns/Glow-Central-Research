#!/usr/bin/env node
// Focused unit/integration checks for Ask Research. Dependency-free by repository contract.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMunsRequest,
  handleResearch,
  researchConfigured,
  takeNdjsonLines,
  validateResearchBody,
} from '../worker/research.mjs';

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
const estateSource = readFileSync(new URL('../public/js/research/estate.js', import.meta.url), 'utf8');

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks += 1;
  console.log('PASS  ' + label);
};
const requestFor = (body) => new Request('https://dashboard.example/api/research', {
  method: 'POST',
  headers: { origin: 'https://dashboard.example', 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const parseEvents = async (response) =>
  (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

ok('the runtime research catalog covers every visible research tab and hidden portfolio analytics', () => {
  const tabs = new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.tab));
  for (const title of ['General Alerts', 'Earnings Hub', 'Con-call', 'Public Chatter', 'Breakouts / Technical', 'Super Investors', 'News', 'Corp Announcements', 'Insider Trades', 'Portfolio Analytics']) {
    assert.equal(tabs.has(title), true, title);
  }
  assert.equal(new Set(DASHBOARD_RESEARCH_SOURCES.map((source) => source.id)).size, DASHBOARD_RESEARCH_SOURCES.length);
});

ok('earnings calendar evidence waits for the shared live-results load before reading metadata', () => {
  assert.match(
    estateSource,
    /id: 'earnings-calendar',[\s\S]*?async read\(\) \{[\s\S]*?await earningsLive\.load\(\);[\s\S]*?const range = earningsLive\.dateRange\(\);/
  );
});

ok('Public Chatter evidence preserves failure state and separately samples unresolved topics', () => {
  assert.match(estateSource, /if \(meta\.ok !== true\) throw new Error/);
  assert.match(estateSource, /const unresolved = chatter\.uncovered\(\);[\s\S]*?unresolvedTopics: \{/);
});

ok('configuration accepts the dedicated or existing Muns session-token bindings', () => {
  assert.equal(researchConfigured({}), false);
  assert.equal(researchConfigured({ MUNS_TOKEN: 'short' }), false);
  assert.equal(researchConfigured({ MUNS_TOKEN: 'muns-session-token-value' }), true);
  assert.equal(researchConfigured({ MUNS_NEWS_TOKEN: 'muns-news-session-token' }), true);
  assert.equal(researchConfigured({ MUNS_LLM_TOKEN: 'muns-llm-session-token' }), true);
  assert.equal(researchConfigured({ ANTHROPIC_API_KEY: 'legacy-muns-session-token' }), true);
});

const valid = validateResearchBody({
  question: 'What changed?',
  scope: 'portfolio',
  webResearch: true,
  history: [{ role: 'user', text: 'Earlier question' }, { role: 'tool', text: 'not permitted' }],
  evidence: { catalog: [{ id: 'earnings-hub' }], sources: [] },
});

ok('request validation bounds history and disables unsupported web mode', () => {
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.history, [{ role: 'user', text: 'Earlier question' }]);
  assert.equal(valid.webResearch, false);
  assert.equal(validateResearchBody({ evidence: {} }).error, 'missing_question');
});

const longHistory = Array.from({ length: 12 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  text: 'm' + String(index).padStart(2, '0') + '-' + 'x'.repeat(3_996),
}));
const boundedHistory = validateResearchBody({
  question: 'Follow up',
  scope: 'portfolio',
  history: longHistory,
  evidence: { catalog: [], sources: [] },
}).history;
ok('history budgeting retains the newest messages and restores chronological order', () => {
  assert.deepEqual(boundedHistory.map((message) => message.text.slice(0, 3)), ['m06', 'm07', 'm08', 'm09', 'm10', 'm11']);
});

ok('the Muns request preserves evidence and selects hosted streaming by default', () => {
  const request = buildMunsRequest(valid);
  assert.equal(request.llm_type, 'hosted_llm');
  assert.equal(request.stream, true);
  assert.equal(request.temperature, 0.2);
  assert.equal(request.max_tokens, 1_800);
  assert.match(request.query, /DASHBOARD_EVIDENCE object is the only source of dashboard facts/);
  assert.match(request.query, /USER: Earlier question/);
  assert.match(request.query, /QUESTION:\nWhat changed\?/);
  assert.match(request.query, /DASHBOARD_EVIDENCE:/);
  assert.equal(buildMunsRequest(valid, { MUNS_LLM_TYPE: 'local_llm' }).llm_type, 'local_llm');
});

ok('NDJSON framing waits for complete network chunks', () => {
  const first = takeNdjsonLines('{"text":"Hel');
  assert.deepEqual(first.lines, []);
  const second = takeNdjsonLines(first.rest + 'lo"}\n{"text":"world"}\n');
  assert.deepEqual(second.lines.map((line) => JSON.parse(line).text), ['Hello', 'world']);
  assert.equal(second.rest, '');
});

const body = {
  question: 'What changed?',
  scope: 'portfolio',
  webResearch: false,
  history: [],
  evidence: {
    catalog: [{ id: 'earnings-hub', status: 'ready' }],
    sources: [{ id: 'earnings-hub', status: 'ready', rows: [] }],
  },
};

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://fastapi.muns.io/query-router');
    assert.equal(init.headers.authorization, 'Bearer llm-token-wins-over-the-fallback');
    assert.equal(init.headers.accept, 'application/x-ndjson');
    const requested = JSON.parse(init.body);
    assert.equal(requested.llm_type, 'hosted_llm');
    assert.equal(requested.stream, true);
    assert.match(requested.query, /QUESTION:\nWhat changed\?/);
    return new Response('{"text":"Earnings"}\n{"text":" improved. [Dashboard: Earnings Hub]"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };

  const response = await handleResearch(requestFor(body), {
    MUNS_LLM_TOKEN: 'llm-token-wins-over-the-fallback',
    MUNS_NEWS_TOKEN: 'news-token-fallback',
    MUNS_TOKEN: 'general-token-fallback',
    RESEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const events = await parseEvents(response);
  ok('the Worker forwards every Muns text chunk and completes the dashboard stream', () => {
    assert.equal(response.status, 200);
    assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), [
      'Earnings',
      ' improved. [Dashboard: Earnings Hub]',
    ]);
    assert.equal(events.at(-1).type, 'done');
  });
} finally {
  globalThis.fetch = originalFetch;
}

try {
  let releaseProvider;
  globalThis.fetch = async () => new Promise((resolve) => {
    releaseProvider = () => resolve(new Response('{"text":"Ready"}\n', {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }));
  });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const second = decoder.decode((await reader.read()).value);
  ok('the browser receives working status without waiting for the provider first token', () => {
    assert.match(first + second, /"type":"start"/);
    assert.match(first + second, /"type":"phase"/);
    assert.equal(typeof releaseProvider, 'function');
  });
  releaseProvider();
  while (!(await reader.read()).done) {
    // Drain the completion so every promise is accounted for.
  }
} finally {
  globalThis.fetch = originalFetch;
}

try {
  globalThis.fetch = async () => new Response('{"error":"Token expired"}\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const events = await parseEvents(response);
  ok('an error event inside a successful upstream stream fails closed', () => {
    assert.equal(events.some((event) => event.type === 'error' && event.message === 'Token expired'), true);
    assert.notEqual(events.at(-1).type, 'done');
  });
} finally {
  globalThis.fetch = originalFetch;
}

try {
  globalThis.fetch = async () => new Response('{"error":{"message":"expired"}}', { status: 401 });
  const response = await handleResearch(requestFor(body), { MUNS_TOKEN: 'muns-session-token-value' });
  const events = await parseEvents(response);
  ok('an HTTP authentication failure gives a safe operator-facing error', () => {
    assert.equal(events.some((event) => event.type === 'error' && /session token/i.test(event.message)), true);
  });
} finally {
  globalThis.fetch = originalFetch;
}

const notConfigured = await handleResearch(new Request('https://dashboard.example/api/research'), {});
const configBody = await notConfigured.json();
ok('the configuration route fails closed without exposing provider details', () => {
  assert.deepEqual(configBody, { configured: false, webResearchAvailable: false, history: 'device' });
});

const configured = await handleResearch(
  new Request('https://dashboard.example/api/research'),
  { MUNS_NEWS_TOKEN: 'muns-news-session-token' }
);
const configuredBody = await configured.json();
ok('the configuration route advertises dashboard research without unsupported web mode', () => {
  assert.deepEqual(configuredBody, { configured: true, webResearchAvailable: false, history: 'device' });
});

const wrongOrigin = await handleResearch(
  new Request('https://dashboard.example/api/research', {
    method: 'POST',
    headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Test', evidence: {} }),
  }),
  { MUNS_TOKEN: 'muns-session-token-value' }
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
  { MUNS_TOKEN: 'muns-session-token-value' }
);
ok('the request-body bound is enforced on bytes without a content-length header', () => {
  assert.equal(oversized.status, 413);
});

console.log('\n' + checks + ' Ask Research checks passed.');
