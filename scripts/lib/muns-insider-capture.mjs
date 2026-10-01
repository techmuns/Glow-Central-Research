import { mergeInsiderTrades } from '../../public/js/data/insider-history.js';
import { newsDay } from '../../public/js/data/news-window.js';
import { exchangeRows } from '../../public/js/data/exchange-deals-shared.js';

const shift = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A REFUSAL IS A 500 (OR 404) THE SOURCE GIVES ONE COMPANY WHILE IT ANSWERS THE OTHERS. Measured on 1 October
// 2026, the insider-trades API answers HTTP 500 for any symbol it cannot resolve (a nonsense ticker
// and an unused BSE code both get one): rights entitlements, partly-paid lines, InvIT and REIT units,
// renamed or delisted symbols and some BSE-only codes. It ALSO answers 500 to everyone during its own
// outages (every company for an hour on 27 September). One 500 cannot tell the two apart, so a
// refusal is asked again RECHECK_DELAY_MS later, after the Worker's 15-second failure cache, and only
// a run that shows the source working may name it no-record. Showing the source working means: other
// companies answered between and after the two refusals, no check failed any other way, and no 500
// turned into an answer on its second ask.
export const RECHECK_DELAY_MS = 30_000;
export const MIN_CLEAN_ANSWERS = 10;
// A witness is a company that answered before, asked next while a refusal still lacks an answer
// between or after its two asks. After the budget, witnesses are the only companies a run starts.
const MAX_WITNESSES = 6;
// Failed companies are re-asked right after the portfolio, oldest failure first. A failure this old
// with no re-check means that lane is not keeping up, which is itself a failure of the capture.
export const OVERDUE_FAILURE_MS = 3 * 86_400_000;

/** One company's latest state: 'unchecked' | 'ok' | 'failed' | 'no-record'. */
export function checkState(entry) {
  if (!entry) return 'unchecked';
  if (entry.error) return 'failed';
  if (entry.noRecord) return 'no-record';
  return entry.lastSuccessAt ? 'ok' : 'unchecked';
}

/** The current NSE symbol for each ISIN in the capture's verified security map; null where two disagree. */
export function currentSymbols(securityMap) {
  const symbols = new Map();
  for (const entry of Object.values(securityMap || {})) {
    const symbol = String(entry?.ticker || '').toUpperCase();
    if (!/^IN[A-Z0-9]{10}$/.test(entry?.isin || '') || !symbol || /^\d{6}$/.test(symbol)) continue;
    symbols.set(entry.isin, symbols.has(entry.isin) && symbols.get(entry.isin) !== symbol ? null : symbol);
  }
  return symbols;
}

export function insiderCaptureCompanies(companies, retained, exchange) {
  // A book holding keeps its own ticker, but the source is asked by the symbol the exchanges list for
  // its ISIN today: HEG Ltd became HEGAM in September 2026 and the source stopped resolving "HEG".
  const symbols = currentSymbols(exchange?.securityMap);
  const seen = new Map(companies.map(c => {
    const current = c.isin ? symbols.get(c.isin) : null;
    return [c.ticker, current && current !== String(c.ticker).toUpperCase() ? { ...c, sourceTicker: current } : c];
  }));
  const asked = new Set([...seen.values()].map(c => c.sourceTicker).filter(Boolean));
  // Universe means the companies in this dashboard's retained market feed as well as its book. A
  // symbol a holding is already asked by would file the same disclosures twice under two tickers.
  for (const ticker of [...Object.keys(retained.byTicker || {}), ...exchangeRows(exchange).map(r => r.ticker)]) {
    if (!seen.has(ticker) && !asked.has(ticker)) seen.set(ticker, { ticker, priority: false });
  }
  return [...seen.values()];
}

/** What one answer from the Worker route means for the company asked. */
function readAnswer(body, ticker) {
  if (body?.ok === false || !Array.isArray(body?.trades)) {
    const failure = {
      reason: typeof body?.reason === 'string' ? body.reason : 'shape',
      status: Number.isInteger(body?.status) ? body.status : null,
      message: typeof body?.message === 'string' && body.message ? body.message : 'Insider source returned an unreadable response',
      ...(body?.upstream && typeof body.upstream === 'object' ? { upstream: body.upstream } : {}),
    };
    // A 404 is the source's own word for "no record"; it is confirmed the same way, so a moved
    // route that answers 404 to everyone still fails the run.
    const refused = (failure.reason === 'upstream' && failure.status === 500) || failure.reason === 'not-found';
    return { kind: refused ? 'refused' : 'failed', failure,
      stop: ['no-token', 'unauthorised'].includes(failure.reason) };
  }
  const incoming = body.trades.map(({ raw, ...row }) => ({ ...row, ticker }));
  if (incoming.some(r => !r.cells || typeof r.cells !== 'object' || Array.isArray(r.cells) || !Object.keys(r.cells).length)) {
    return { kind: 'failed', failure: { reason: 'shape', status: null, message: 'Insider source returned an unreadable row' } };
  }
  return { kind: 'answered', incoming };
}

const failedEntry = ({ noRecord, ...prior }, checkedAt, failure) =>
  ({ ...prior, checkedAt, error: failure.message, failure, trades: prior.trades || [] });

/** A rotating company checkpoint supplements Screener without overwriting its four-list manifest.
 * Three lanes: portfolio companies due for their two-hour check, then companies whose last check
 * failed (oldest failure first) so an outage is repaired in the next runs instead of a full rotation
 * later, then the universe by attempt time. Every read overlaps the last success by a week.
 */
export async function captureMunsInsiders(previous, companies, {
  request, now = Date.now, budgetMs = 12 * 60000, gapMs = 2500, checkpoint = () => {}, sleep = wait,
  concurrency = 4, recheckDelayMs = RECHECK_DELAY_MS, minCleanAnswers = MIN_CLEAN_ANSWERS,
} = {}) {
  const started = now(), today = newsDay(started);
  const byTicker = structuredClone(previous?.byTicker || {});
  const list = [...new Map(companies.filter(c => c.ticker).map(c => [c.ticker.toUpperCase(), c])).entries()];
  const due = ([ticker, company]) => !!company.priority && started - Date.parse(byTicker[ticker]?.lastSuccessAt || '1970-01-01') >= 2 * 3600000;
  const lane = entry => due(entry) ? 0 : checkState(byTicker[entry[0]]) === 'failed' ? 1 : 2;
  // Workers consume the queue; coverage must keep every intended company throughout the run.
  const queue = [...list].sort((a, b) => lane(a) - lane(b) ||
    String(byTicker[a[0]]?.checkedAt || '').localeCompare(String(byTicker[b[0]]?.checkedAt || '')));
  const run = { startedAt: new Date(started).toISOString(), finishedAt: null, requests: 0, checked: 0, answered: 0,
    failed: 0, refusalsRechecked: 0, flaps: 0, noRecordConfirmed: 0, noRecordReconfirmed: 0, clean: null };
  const answeredAt = [], refusals = new Map(), rechecks = [], transient = new Set(), asked = new Set();
  let gate = Promise.resolve(), nextStart = started, stopped = false, witnesses = 0, witnessInFlight = false;
  const state = () => ({ source: 'Muns insider disclosures via Sattva', checkedAt: new Date(now()).toISOString(),
    targetTickers: list.map(([ticker]) => ticker).sort(), byTicker, run: { ...run } });
  const pace = () => {
    const turn = gate.then(async () => {
      await sleep(Math.max(0, nextStart - now()));
      nextStart = now() + gapMs;
    });
    gate = turn; return turn;
  };
  // A refusal that can still be confirmed lacks an answer after its latest ask.
  const needsWitness = () => [...refusals.values()].some(({ first, second }) => second == null
    ? !answeredAt.some(t => t > first)
    : answeredAt.some(t => t > first && t < second) && !answeredAt.some(t => t > second));
  // The budget bounds how many companies a run starts. A refusal already made is still re-asked
  // after it, so a refusal in the last half-minute is not left unconfirmed by the clock.
  const take = () => {
    if (stopped) return null;
    if (rechecks.length && rechecks[0].readyAt <= now()) return rechecks.shift();
    const inBudget = now() - started < budgetMs;
    // While a refusal waits for evidence that the source answers others, the next company asked is
    // one that answered before. The failed lane is a run of refusals back to back, and refusals
    // cannot vouch for each other by silence. After the budget, a witness is all a run still starts.
    if (queue.length && !witnessInFlight && needsWitness() && (inBudget || witnesses < MAX_WITNESSES)) {
      const known = queue.findIndex(([ticker]) => checkState(byTicker[ticker]) === 'ok');
      if (known >= 0 || !inBudget) {
        witnessInFlight = true;
        if (!inBudget) witnesses++;
        return { entry: queue.splice(Math.max(0, known), 1)[0], witness: true };
      }
    }
    if (queue.length && inBudget) return { entry: queue.shift() };
    return rechecks.shift() || null;
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let job = take(); job; job = take()) {
      const [ticker, company] = job.entry;
      if (job.readyAt) await sleep(Math.max(0, job.readyAt - now()));
      await pace();
      if (stopped) break;
      if (!job.readyAt && !job.witness && now() - started >= budgetMs) continue;
      const prior = byTicker[ticker] || {};
      const checkedAt = new Date(now()).toISOString();
      const from = prior.lastSuccessAt ? shift(newsDay(prior.lastSuccessAt), -7) : shift(today, -365);
      run.requests++; asked.add(ticker);
      let outcome;
      try {
        outcome = readAnswer(await request(company.sourceTicker || ticker, from, today), ticker);
      } catch (error) {
        outcome = { kind: 'failed', failure: { reason: error?.name === 'TimeoutError' ? 'timeout' : 'unreachable', status: null,
          message: String(error?.message || error || 'Insider source could not be reached') } };
      }
      const at = now();
      if (job.witness) witnessInFlight = false;
      if (outcome.stop) stopped = true;
      if (outcome.kind === 'answered') {
        answeredAt.push(at);
        // A 500 that answered on its second ask is the source wobbling, not refusing this company.
        if (refusals.delete(ticker)) run.flaps++;
        byTicker[ticker] = { checkedAt, lastSuccessAt: checkedAt, from: prior.from || from, to: today, error: null,
          trades: mergeInsiderTrades(prior.trades || [], outcome.incoming) };
      } else if (outcome.kind === 'refused' && checkState(prior) === 'no-record') {
        // Already named in an earlier run; one more refusal agrees with it and needs no second ask.
        byTicker[ticker] = { ...prior, checkedAt, error: null, failure: outcome.failure,
          noRecord: { ...prior.noRecord, lastRefusedAt: checkedAt, refusals: (prior.noRecord.refusals || 0) + 1 } };
        run.noRecordReconfirmed++;
      } else if (outcome.kind === 'refused' && !refusals.has(ticker)) {
        // Failed until the run proves otherwise, so an interrupted run publishes the failure.
        refusals.set(ticker, { first: at, firstAt: checkedAt, second: null });
        rechecks.push({ entry: job.entry, readyAt: at + recheckDelayMs });
        byTicker[ticker] = failedEntry(prior, checkedAt, outcome.failure);
      } else {
        if (outcome.kind === 'refused') { refusals.get(ticker).second = at; run.refusalsRechecked++; }
        else { refusals.delete(ticker); transient.add(ticker); }
        byTicker[ticker] = failedEntry(prior, checkedAt, outcome.failure);
      }
      // Preserve each completed response, including failures, if the runner is interrupted later.
      checkpoint(state());
    }
  }));
  const clean = !stopped && transient.size === 0 && run.flaps === 0 && answeredAt.length >= minCleanAnswers;
  for (const [ticker, { first, firstAt, second }] of refusals) {
    if (!clean || second == null || !answeredAt.some(t => t > first && t < second) || !answeredAt.some(t => t > second)) continue;
    byTicker[ticker] = { ...byTicker[ticker], error: null,
      noRecord: { since: firstAt, lastRefusedAt: byTicker[ticker].checkedAt, refusals: 2 } };
    run.noRecordConfirmed++;
  }
  Object.assign(run, { finishedAt: new Date(now()).toISOString(), clean, checked: asked.size,
    answered: [...asked].filter(t => checkState(byTicker[t]) === 'ok').length,
    failed: [...asked].filter(t => checkState(byTicker[t]) === 'failed').length });
  return state();
}

const named = (tickers, sample) => `${tickers.slice(0, sample).join(', ')}${tickers.length > sample ? ` and ${tickers.length - sample} more` : ''}`;

/**
 * What a finished insider capture says about its run. `failures` fail the job: a company that failed
 * in THIS run (an outage, a timeout, a refusal the run could not confirm), a capture that did not
 * complete, or a failure left OVERDUE_FAILURE_MS without a re-check. `warnings` state failures from
 * an earlier run still queued for a re-check; `notices` the companies the source holds no record for.
 * Gaps are stated, never dropped: only their severity differs.
 */
export function insiderVerdict(insiders, { now = Date.now(), overdueMs = OVERDUE_FAILURE_MS, sample = 12 } = {}) {
  const failures = [], warnings = [], notices = [];
  if (!insiders) return { failures: ['The insider disclosure capture did not run.'], warnings, notices };
  if (insiders.error) failures.push(`The insider disclosure capture did not complete: ${insiders.error}`);
  const startedAt = Date.parse(insiders.run?.startedAt);
  const failedNow = [], pending = [], overdue = [], noRecord = [];
  for (const ticker of insiders.targetTickers || []) {
    const entry = insiders.byTicker?.[ticker], state = checkState(entry);
    if (state === 'no-record') noRecord.push(ticker);
    if (state !== 'failed') continue;
    const at = Date.parse(entry.checkedAt);
    if (Number.isFinite(startedAt) && at >= startedAt) failedNow.push(ticker);
    else if (!Number.isFinite(at) || now - at > overdueMs) overdue.push(ticker);
    else pending.push(ticker);
  }
  const reasons = tickers => [...tickers.reduce((counts, t) => {
    const failure = insiders.byTicker[t].failure;
    const key = failure ? `${failure.reason}${failure.status ? ` ${failure.status}` : ''}` : 'unknown';
    return counts.set(key, (counts.get(key) || 0) + 1);
  }, new Map())].map(([key, count]) => `${count} ${key}`).join(', ');
  if (failedNow.length) failures.push(`${failedNow.length} companies failed their insider check in this run (${reasons(failedNow)}): ${named(failedNow, sample)}.`);
  if (overdue.length) failures.push(`${overdue.length} companies have carried a failed insider check for more than ${Math.round(overdueMs / 86_400_000)} days without a re-check: ${named(overdue, sample)}.`);
  if (pending.length) {
    const oldest = pending.map(t => insiders.byTicker[t].checkedAt).sort()[0];
    warnings.push(`${pending.length} companies still carry a failed insider check from an earlier run (oldest ${oldest}); the next run re-asks them right after the portfolio: ${named(pending, sample)}.`);
  }
  if (noRecord.length) notices.push(`${noRecord.length} companies have no record at the insider source: it refuses them (HTTP 500 or 404) while answering others. ${named(noRecord, sample)}.`);
  return { failures, warnings, notices };
}
