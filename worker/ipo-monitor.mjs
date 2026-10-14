// Read published public artifacts from ONE fixed repository; never trigger its pipeline.
import { boundedJson } from './private-documents.mjs';
import { validateIpoSnapshot, validateScoring } from '../public/js/data/ipo-monitor-shared.js';
import { validDay } from '../public/js/data/combined-filings-shared.js';

const RAW = 'https://raw.githubusercontent.com/techmuns/DRHP/main/data/';
const INDEX = 'https://api.github.com/repos/techmuns/DRHP/contents/data/snapshots?ref=main';
const reply = (body, status = 200, cacheable = false) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': cacheable ? 'public, max-age=300' : 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
export async function handleIpoMonitor(
  request,
  { fetcher = fetch, cache = globalThis.caches?.default, now = Date.now } = {},
) {
  if (request.method !== 'GET') return reply({ ok: false, message: 'IPO monitor is read-only.' }, 405);
  const url = new URL(request.url),
    date = url.searchParams.get('snapshot');
  if (
    [...url.searchParams.keys()].some((key) => key !== 'snapshot') ||
    url.searchParams.getAll('snapshot').length > 1 ||
    (date !== null && !validDay(date))
  )
    return reply({ ok: false, message: 'Invalid snapshot date.' }, 400);
  const key = new Request(`${url.origin}/api/ipo-monitor${date ? `?snapshot=${date}` : ''}`);
  const cached = await cache?.match(key).catch(() => null);
  if (cached) return cached;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  const read = async (path) => {
    const response = await fetcher(path, {
      signal,
      redirect: 'manual',
      cache: 'no-store',
      headers: { accept: 'application/json', 'user-agent': 'Sattva-IPO-Monitor' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`source-http-${response.status}`);
    }
    return boundedJson(response, 4 * 1024 * 1024, signal);
  };
  try {
    let body;
    if (date) {
      const snapshot = validateIpoSnapshot(await read(`${RAW}snapshots/${date}.json`));
      if (snapshot.meta.snapshot_id !== date) throw new Error('snapshot-mismatch');
      body = { ok: true, snapshot, checkedAt: new Date(now()).toISOString() };
    } else {
      const [latest, scoring, index] = await Promise.allSettled([
        read(`${RAW}latest.json`),
        read(`${RAW}scoring_config.json`),
        read(INDEX),
      ]);
      if (latest.status !== 'fulfilled') throw latest.reason;
      const data = validateIpoSnapshot(latest.value);
      let config = null;
      try {
        if (scoring.status === 'fulfilled') config = validateScoring(scoring.value);
      } catch {
        /* Report unavailable scoring, not a fabricated fallback model. */
      }
      const historyAvailable = index.status === 'fulfilled' && Array.isArray(index.value);
      const historyDates = historyAvailable
        ? [
            ...new Set(
              index.value
                .filter(
                  (f) =>
                    f?.type === 'file' &&
                    /^\d{4}-\d{2}-\d{2}\.json$/.test(f.name) &&
                    validDay(f.name.slice(0, 10)),
                )
                .map((f) => f.name.slice(0, 10)),
            ),
          ]
            .sort()
            .reverse()
        : [];
      body = {
        ok: true,
        latest: data,
        config,
        historyDates,
        historyAvailable,
        checkedAt: new Date(now()).toISOString(),
        source: 'techmuns/DRHP published snapshots',
      };
    }
    const cacheable = date || (body.historyAvailable && body.config);
    const response = reply(body, 200, !!cacheable);
    if (cacheable) await cache?.put(key, response.clone()).catch(() => {});
    return response;
  } catch (error) {
    // Public, fixed-resource fetch only: no reader credential, request body or headers in diagnostics.
    console.warn('IPO published source unavailable', {
      type: error?.name,
      message: String(error?.message || '').slice(0, 180),
    });
    const reason = /^source-http-\d{3}$/.test(error?.message)
      ? error.message
      : signal.aborted
        ? 'timeout'
        : 'source-read';
    return reply(
      {
        ok: false,
        reason,
        message: signal.aborted
          ? 'The IPO source timed out.'
          : 'The published IPO snapshot could not be read. This is not an empty IPO market.',
      },
      502,
    );
  }
}
