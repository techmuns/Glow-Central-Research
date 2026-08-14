#!/usr/bin/env node
// stub-chatter.mjs — a local stand-in for the SentimentDash API, for verification runs.
//
//   node scripts/stub-chatter.mjs [port] [payload.json]
//   CHATTER_STUB=http://127.0.0.1:8902/v1 node scripts/verify-ui.mjs
//
// WHY THIS EXISTS
//   The chatter feed is the one upstream the BROWSER calls directly (see js/data/chatter-live.js
//   for why it cannot be proxied). That makes a verification run depend on the machine's outbound
//   network, which is not a property of this codebase — a sandbox with no egress would fail checks
//   that are about our rendering, not about their service. It also means a full suite run would
//   hammer somebody else's API on every execution.
//
//   So this serves a captured payload from localhost with THE SAME HEADER SET the live API sends,
//   verified against it with `curl -D-`: permissive CORS, an exposed ETag, and a real 304 on
//   `If-None-Match`. The conditional-fetch path is therefore exercised for real, not stubbed out.
//
// THE DATA IS THEIRS. `fixtures/chatter-dashboard.json` is a verbatim capture of
// GET /v1/dashboard?limit=all. Nothing here invents an entry, a mention count or a sentiment —
// a stub that made up numbers would let the suite pass against data the real feed never produces.
// Recapture with:
//   curl -s 'https://sentimentdash-api.tech-441.workers.dev/v1/dashboard?limit=all' \
//     -o scripts/fixtures/chatter-dashboard.json

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8902;
const PAYLOAD_PATH = process.argv[3] || resolve(__dirname, 'fixtures/chatter-dashboard.json');

let dashboard;
try {
  dashboard = readFileSync(PAYLOAD_PATH, 'utf8');
} catch {
  console.error(`No capture at ${PAYLOAD_PATH}. Recapture it — see the header of this file.`);
  process.exit(2);
}

const parsed = JSON.parse(dashboard);
const generatedAt = parsed.generatedAt || new Date(0).toISOString();

// A weak validator over the payload, so `If-None-Match` can answer 304 exactly as theirs does.
let h = 0;
for (let i = 0; i < dashboard.length; i++) h = (h * 31 + dashboard.charCodeAt(i)) | 0;
const ETAG = `W/"${(h >>> 0).toString(36)}"`;

const health = JSON.stringify({
  status: 'ok',
  version: 'v1',
  // `ageSeconds` NESTED UNDER `data`, which is where the real API puts it. Reading it from the top
  // level silently produced null against production; the stub reproduces the real shape so that
  // bug could not come back unnoticed.
  data: {
    source: 'stub',
    ttlSeconds: 300,
    generatedAt,
    ageSeconds: 12804,
    window: parsed.window || '30d',
    totalPosts: parsed.overview?.totalPosts ?? null,
    totalStocks: parsed.pagination?.total ?? null,
  },
  upstreamLatencyMs: 1,
});

// Exactly what the live API returns, confirmed with `curl -D-`.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag, X-Data-Generated-At',
  'access-control-max-age': '86400',
  'x-data-generated-at': generatedAt,
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/(api\/)?v1/, '') || '/';

  if (path === '/health') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    return res.end(health);
  }
  if (path === '/dashboard' || path === '/stocks') {
    if (req.headers['if-none-match'] === ETAG) {
      res.writeHead(304, { ...CORS, etag: ETAG });
      return res.end();
    }
    res.writeHead(200, { ...CORS, 'content-type': 'application/json', etag: ETAG, 'cache-control': 'public, max-age=60' });
    return res.end(dashboard);
  }
  res.writeHead(404, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { status: 404, code: 'unknown_route', message: path } }));
}).listen(PORT, () => {
  console.log(`chatter stub on http://127.0.0.1:${PORT}/v1  (${parsed.stocks?.length ?? 0} entries, etag ${ETAG})`);
});
