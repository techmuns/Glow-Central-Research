// Caller-private document history. Never use the deployment identity or the shared edge cache:
// isRead is a property of the signed-in reader, not public market data.
import { callerToken } from './muns.mjs';
import { DOCUMENT_FORMS, normaliseCombinedFilings, validDay } from '../public/js/data/combined-filings-shared.js';

const ENDPOINT = 'https://devde.muns.io/filings/combined_filings_announcements';
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store', vary: 'Authorization', 'x-content-type-options': 'nosniff' } });

async function boundedJson(message, limit, signal) {
  if (Number(message.headers.get('content-length')) > limit) throw new Error('too-large');
  const reader = message.body?.getReader();
  if (!reader) throw new Error('shape');
  let length = 0;
  const decoder = new TextDecoder();
  let body = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('timeout');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('timeout');
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('too-large');
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function validateCombinedRequest(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a company and date range.');
  const ticker = typeof input.ticker === 'string' ? input.ticker.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9&.\-]{0,29}$/.test(ticker)) throw new Error('Choose a valid stock ticker.');
  if (!['India', 'USA', 'United States'].includes(input.country)) throw new Error('Choose India or USA.');
  const today = new Date(now + 19800000).toISOString().slice(0, 10);
  const end = input.end_date ?? today;
  const start = input.start_date ?? new Date(Date.parse(`${end}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  if (!validDay(start) || !validDay(end) || start > end || end > today) throw new Error('Provide valid dates, no later than today.');
  if (Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error('Search at most one year at a time.');
  const body = { ticker, country: input.country, start_date: start, end_date: end };
  if (input.country === 'India') {
    const forms = input.form ?? ['all'];
    if (!Array.isArray(forms) || !forms.length || forms.length > 3 || forms.some((form) => !DOCUMENT_FORMS.includes(form)) || (forms.includes('all') && forms.length !== 1)) throw new Error('Choose a supported Indian filing type.');
    body.form = [...new Set(forms)];
  } else {
    for (const field of ['email', 'company_name']) {
      if (input[field] == null) continue;
      if (typeof input[field] !== 'string' || input[field].length > 254 || /[\r\n]/.test(input[field])) throw new Error(`Invalid ${field}.`);
      body[field] = input[field].trim();
    }
  }
  // Never forward user_index, arbitrary URLs, or unknown fields to this authenticated service.
  return body;
}

export async function handleCombinedFilings(request, { fetcher = fetch, now = Date.now } = {}) {
  if (request.method !== 'POST') return reply({ ok: false, message: 'Use POST for company document history.' }, 405);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return reply({ ok: false, message: 'Use this dashboard to request document history.' }, 403);
  const token = callerToken(request);
  if (!token) return reply({ ok: false, reason: 'no-session', message: 'Sign in through Munshot to load your company document history.' }, 401);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let query;
  try { query = validateCombinedRequest(await boundedJson(request, MAX_REQUEST_BYTES, signal), now()); }
  catch (error) { return reply({ ok: false, reason: 'request', message: error.message === 'too-large' ? 'Request is too large.' : 'Invalid company, filing type or date range. Search at most one year at a time.' }, error.message === 'too-large' ? 413 : 400); }
  try {
    const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(query) });
    if (!response.ok) {
      await response.body?.cancel();
      const status = response.status;
      const reason = [401, 403].includes(status) ? 'unauthorised' : status === 429 ? 'rate-limited' : 'upstream';
      const message = reason === 'unauthorised' ? 'Your session was refused. Sign in again and retry.' : reason === 'rate-limited' ? 'The document service is rate limiting requests. Retry later.' : 'The document service could not be reached. Existing exchange feeds are unchanged.';
      return reply({ ok: false, reason, message }, reason === 'unauthorised' ? 401 : status === 429 ? 429 : 502);
    }
    const payload = await boundedJson(response, MAX_RESPONSE_BYTES, signal);
    const result = normaliseCombinedFilings(payload, query);
    return reply({ ok: true, ...result, query, source: 'Muns combined filings & announcements', fetchedAt: new Date(now()).toISOString() });
  } catch (error) {
    const reason = signal.aborted ? 'timeout' : error.message === 'too-large' ? 'too-large' : 'shape-or-upstream';
    return reply({ ok: false, reason, message: reason === 'timeout' ? 'The document service timed out. Retry or narrow the date range.' : reason === 'too-large' ? 'Too many document records. Narrow the date range.' : 'The document response could not be read. This is not an empty filing history.' }, 502);
  }
}
