// Read-only company lookup; never invoke the upstream DRHP sync/admin endpoints.
import { callerToken } from './muns.mjs';
import { boundedJson, privateReply as reply } from './private-documents.mjs';
import { normaliseDrhpFilings, validateDrhpCompany } from '../public/js/data/drhp-shared.js';

export async function handleDrhpFilings(request, { fetcher = fetch, now = Date.now } = {}) {
  if (request.method !== 'POST') return reply({ ok: false, message: 'Use POST for the DRHP lookup.' }, 405);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return reply({ ok: false, message: 'Use this dashboard for DRHP lookups.' }, 403);
  const token = callerToken(request);
  if (!token) return reply({ ok: false, reason: 'no-session', message: 'Sign in through Munshot to load IPO / DRHP filings.' }, 401);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  let company;
  try {
    const input = await boundedJson(request, 8192, signal);
    company = validateDrhpCompany(input?.company);
  } catch (error) {
    return reply({ ok: false, reason: 'request', message: error.message === 'too-large' ? 'Request is too large.' : 'Enter a ticker or exact company name (up to 200 characters).' }, error.message === 'too-large' ? 413 : 400);
  }
  try {
    const response = await fetcher(`https://devde.muns.io/filings/drhp/${encodeURIComponent(company)}`, {
      method: 'GET', redirect: 'error', cache: 'no-store', signal,
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const reason = [401, 403].includes(response.status) ? 'unauthorised' : response.status === 429 ? 'rate-limited' : 'upstream';
      const message = reason === 'unauthorised' ? 'Your session was refused. Sign in again and retry.' : reason === 'rate-limited' ? 'The DRHP service is rate limiting requests. Retry later.' : 'The DRHP service could not be reached. This is not confirmation that no filing exists.';
      return reply({ ok: false, reason, message }, reason === 'unauthorised' ? 401 : response.status === 429 ? 429 : 502);
    }
    const result = normaliseDrhpFilings(await boundedJson(response, 4 * 1024 * 1024, signal));
    return reply({ ok: true, ...result, query: company, fetchedAt: new Date(now()).toISOString() });
  } catch (error) {
    const reason = signal.aborted ? 'timeout' : error.message === 'too-large' ? 'too-large' : 'shape-or-upstream';
    return reply({ ok: false, reason, message: reason === 'timeout' ? 'The DRHP service timed out. Retry later.' : reason === 'too-large' ? 'The DRHP response is too large to display safely.' : 'The DRHP response could not be read. This is not an empty filing history.' }, 502);
  }
}
