// data/deep-dive.js — the client for the Concall Deep Dive dashboard's trigger API.
//
//   configured()                    is a base URL set?
//   setBaseUrl(url) / baseUrl()     where that dashboard lives
//   readyByTicker()                 which companies ALREADY have a report — free, no run
//   start(row, { onProgress })      dispatch a run and poll it to completion
//   resume(slug, { onProgress })    reattach to an existing run or open a finished report
//   reportUrl(slug)                 deep link into THEIR rendering of the report
//   remembered(ticker)              a slug we already have for this company
//
// TWO KINDS OF CALL, AND ONLY ONE OF THEM COSTS ANYTHING.
//   Reading — `GET /api/summary` (their index of finished reports) and `GET /api/report` — is
//   free. Writing — `POST /api/analyze` — starts a real LLM pipeline. So the index is fetched
//   once per page load to mark the rows that are already free to open, and a dispatch happens
//   only on an explicit click through a confirm step. Never blur those two.
//
// THIS TALKS TO A DIFFERENT DASHBOARD, AND EVERY FIELD IT RENDERS IS THAT DASHBOARD'S.
//   Concall Deep Dive runs its own LLM pipeline over a company's call and publishes a report. We
//   trigger it, watch it, and show what it returns. We compute nothing on top and we re-band
//   nothing — same rule as the StockScans scores and the Trendlyne holding values. Every surface
//   says whose analysis it is, and every report carries a link to their own rendering of it.
//
// A CLICK COSTS THEM A PIPELINE RUN.
//   `POST /api/analyze` dispatches a real LLM + compute run and the endpoint is unauthenticated.
//   So nothing here fires on its own: no poller registers this, no row triggers it on render, and
//   the button asks for confirmation before the first dispatch. A cached report (<14 days) comes
//   back instantly with `status: "done"` and costs nothing, which is why the confirm step says
//   whether it expects to reuse one.
//
// WHERE THE BASE URL COMES FROM
//   The Worker behind that dashboard has no custom domain, so its URL is whatever Cloudflare
//   assigned — typically https://concall-sattva.<subdomain>.workers.dev. It is not committed here
//   because it is deployment-specific and nobody in this repo can know it. Set it once in the UI
//   (stored in localStorage) or bake it in by setting `window.SATTVA_DEEPDIVE_URL` in index.html.
//   Until it is set, the column renders a "connect" state rather than a broken button.

const LS_BASE = 'sattva:deepdive-base';
const LS_SLUGS = 'sattva:deepdive-slugs';

// Their frontend polls every 3-5s and gives up around the pipeline's own ~20 minute ceiling.
export const POLL_MS = 4000;
export const TIMEOUT_MS = 25 * 60 * 1000;

const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private window: the session still works, it just does not persist */
  }
};

/** Trailing slashes stripped so `${base}/api/analyze` cannot become a double slash. */
export function normaliseBase(url) {
  const t = String(url || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function baseUrl() {
  return normaliseBase(read(LS_BASE, '') || (typeof window !== 'undefined' ? window.SATTVA_DEEPDIVE_URL : '') || '');
}

export function setBaseUrl(url) {
  const clean = normaliseBase(url);
  write(LS_BASE, clean);
  return clean;
}

export const configured = () => !!baseUrl();

/** Their own rendering of a finished report. Always offered beside ours — see the header. */
export function reportUrl(slug) {
  const b = baseUrl();
  return b && slug ? `${b}/#/report/${encodeURIComponent(slug)}` : null;
}

// ticker -> { slug, at }. A run takes minutes; remembering the slug means closing the panel and
// coming back reattaches to the job in flight rather than dispatching a second one.
export const remembered = (ticker) => (ticker ? read(LS_SLUGS, {})[String(ticker).toUpperCase()] || null : null);

/**
 * The whole map, read once.
 *
 * The scan table marks every row that already has a run on record, and it is a 500-row table that
 * repaints on a live tick. Asking `remembered()` per row would be 500 localStorage reads and 500
 * `JSON.parse` calls per paint for a map that changes at most once a minute.
 */
export const rememberedMap = () => read(LS_SLUGS, {});

function remember(ticker, slug) {
  if (!ticker || !slug) return;
  const all = read(LS_SLUGS, {});
  all[String(ticker).toUpperCase()] = { slug, at: Date.now() };
  write(LS_SLUGS, all);
}

async function call(path, init) {
  const b = baseUrl();
  if (!b) throw new Error('The Deep Dive dashboard URL has not been set.');
  let res;
  try {
    res = await fetch(`${b}${path}`, init);
  } catch (err) {
    // Their CORS is open, so a failure here is the host being unreachable or the URL being wrong —
    // both worth saying plainly rather than as a bare TypeError.
    throw new Error(`Could not reach ${b} — check the URL is right and the dashboard is deployed.`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${path} returned ${res.status} and not JSON — is ${b} the Deep Dive dashboard?`);
  }
  return body;
}

/** Ask whether a fresh report already exists, without dispatching anything. */
export async function peek(ticker) {
  const known = remembered(ticker);
  if (!known?.slug) return null;
  try {
    return await call(`/api/report?slug=${encodeURIComponent(known.slug)}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Their index of finished reports — free, and the reason most clicks cost nothing
//
// `GET /api/summary` lists every report that dashboard has already produced. Reading it is a
// plain GET with no pipeline behind it, so unlike a dispatch it is safe to fetch on our own —
// and it is what lets the scan table say "this one is ready" instead of making the reader pay to
// find out. Fetched ONCE per page load: it is small, it changes only when a run completes, and
// polling someone else's service for a list that moves a few times a day would be rude.
// ---------------------------------------------------------------------------------------

let summaryPromise = null;

/** The raw `/api/summary` payload, fetched at most once per page load. Never throws. */
export function summary({ refresh = false } = {}) {
  if (refresh) summaryPromise = null;
  if (!summaryPromise) {
    summaryPromise = (async () => {
      if (!configured()) return null;
      try {
        const body = await call('/api/summary');
        return Array.isArray(body?.summaries) ? body : null;
      } catch {
        // A missing index is not an error: it means we cannot pre-mark rows, and every row falls
        // back to the ask-first path, which is where they would have been anyway.
        return null;
      }
    })();
  }
  return summaryPromise;
}

/**
 * ticker (upper-case) -> the summary row for the report they already hold.
 *
 * Only rows with a slug are kept, because the slug is the whole point: it is what opens the
 * finished report without dispatching anything.
 */
export async function readyByTicker() {
  const body = await summary();
  const out = {};
  for (const r of body?.summaries || []) {
    const t = String(r?.ticker || '').toUpperCase();
    if (!t || !r.slug) continue;
    // Several quarters of the same company can exist; keep the most recently generated.
    if (!out[t] || String(r.generated_at || '') > String(out[t].generated_at || '')) out[t] = r;
  }
  return out;
}

/**
 * Dispatch a run and poll it to completion.
 *
 * `onProgress(state)` fires on every tick with what THEIR pipeline reports — `status`, `stage`,
 * `message` — plus how long we have been waiting. That is the loading window: their words, not a
 * spinner of ours guessing at what is happening.
 *
 * Resolves with `{ status: 'done', slug, report }` or throws. `signal` aborts the polling loop
 * when the reader closes the panel — the run continues on their side, and reopening reattaches.
 */
export async function start({ company, ticker, force = false }, { onProgress = () => {}, signal } = {}) {
  if (!company && !ticker) throw new Error('A company name or ticker is required.');

  onProgress({ status: 'dispatching', stage: null, message: 'Asking the Deep Dive dashboard to start…', elapsedMs: 0 });

  const body = { company: company || ticker, force };
  // Always send the ticker when we have one: it is what makes "Tata Motors", "Tata Motors Ltd" and
  // "TMCV" resolve to one cached report instead of three runs.
  if (ticker) body.ticker = ticker;

  const dispatched = await call('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (dispatched?.ok === false) {
    throw new Error(dispatched.error || 'The Deep Dive dashboard refused the request.');
  }
  // The slug is theirs and is always derived server-side. Never construct one here.
  const slug = dispatched?.slug;
  if (!slug) throw new Error('The Deep Dive dashboard did not return a report id.');
  remember(ticker, slug);

  if (dispatched.status === 'done') {
    onProgress({ status: 'done', stage: null, message: 'A recent report was already on file.', elapsedMs: 0, cached: true });
    const ready = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    return { status: 'done', slug, report: ready?.report ?? null, partial: !!ready?.partial, cached: true };
  }

  const started = Date.now();
  onProgress({ status: dispatched.status || 'queued', stage: dispatched.stage || null, message: dispatched.message || null, elapsedMs: 0, slug });

  for (;;) {
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');
    await sleep(POLL_MS, signal);
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');

    const elapsedMs = Date.now() - started;
    if (elapsedMs > TIMEOUT_MS) {
      throw new Error(`The run has been going for ${Math.round(elapsedMs / 60000)} minutes without finishing. It may still complete on the Deep Dive dashboard — the link below reattaches to it.`);
    }

    let tick;
    try {
      tick = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    } catch (err) {
      // A blip mid-run should not kill a twenty-minute job. Report it and keep polling.
      onProgress({ status: 'running', stage: null, message: `Lost contact for a moment (${err.message})`, elapsedMs, slug, transientError: true });
      continue;
    }

    if (tick?.status === 'done') {
      onProgress({ status: 'done', stage: null, message: null, elapsedMs, slug });
      return { status: 'done', slug, report: tick.report ?? null, partial: !!tick.partial, cached: false };
    }
    if (tick?.status === 'error') throw new Error(tick.error || 'The Deep Dive run failed.');
    // `unknown` is a brief KV propagation lag right after dispatch, not a failure.
    onProgress({
      status: tick?.status === 'unknown' ? 'queued' : tick?.status || 'running',
      stage: tick?.stage || null,
      message: tick?.status === 'unknown' ? 'Waiting for the run to register…' : tick?.message || null,
      elapsedMs,
      slug,
    });
  }
}

/**
 * Reattach to a run already dispatched, WITHOUT dispatching anything.
 *
 * Used when the reader reopens a panel they closed, or reloads the page mid-run. Their API would
 * dedup a second `POST /api/analyze` anyway, but not asking at all is the version that cannot
 * cost a run through a bug of ours.
 */
export async function resume(slug, { onProgress = () => {}, signal } = {}) {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('polling stopped', 'AbortError');
    const elapsedMs = Date.now() - started;
    let tick;
    try {
      tick = await call(`/api/report?slug=${encodeURIComponent(slug)}`);
    } catch (err) {
      onProgress({ status: 'running', stage: null, message: `Lost contact for a moment (${err.message})`, elapsedMs, slug, transientError: true });
      await sleep(POLL_MS, signal);
      continue;
    }
    if (tick?.status === 'done') {
      onProgress({ status: 'done', stage: null, message: null, elapsedMs, slug });
      return { status: 'done', slug, report: tick.report ?? null, partial: !!tick.partial, cached: true };
    }
    if (tick?.status === 'error') throw new Error(tick.error || 'The Deep Dive run failed.');
    if (tick?.status === 'unknown') throw new Error('That run is no longer on record. Start a new one.');
    onProgress({ status: tick?.status || 'running', stage: tick?.stage || null, message: tick?.message || null, elapsedMs, slug });
    if (elapsedMs > TIMEOUT_MS) throw new Error('The run has not finished in the expected window.');
    await sleep(POLL_MS, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}
