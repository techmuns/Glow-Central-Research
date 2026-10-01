import assert from 'node:assert/strict';
import { captureMunsInsiders, insiderCaptureCompanies } from './lib/muns-insider-capture.mjs';
import { emptyExchangeSnapshot } from './lib/exchange-deals.mjs';
import { combineExchangeDeals, insiderSummary, validateExchangeSnapshot } from '../public/js/data/exchange-deals-shared.js';

const at = Date.parse('2026-09-10T04:00:00Z');
const row = (date, person) => ({ ticker: 'HELD', date, cells: { Insider: person, Transaction: 'Acquisition', 'Trade Shares': '100', Source: 'BSE' } });
const old = row('2025-07-01', 'Retained old disclosure'), latest = row('2026-09-09', 'New disclosure');
const prior = { targetTickers: ['HELD', 'OTHER', 'FAILED'], byTicker: {
  HELD: { checkedAt: '2026-09-09T12:00:00Z', lastSuccessAt: '2026-09-09T12:00:00Z', from: '2025-07-01', trades: [old] },
  OTHER: { checkedAt: '2026-09-08T12:00:00Z', lastSuccessAt: '2026-09-08T12:00:00Z', trades: [] },
  FAILED: { checkedAt: '2026-09-10T03:00:00Z', error: 'Prior outage', trades: [] },
} };
const calls = [], checkpoints = [];
const companies = [{ ticker: 'OTHER' }, { ticker: 'FAILED' }, { ticker: 'HELD', priority: true }, { ticker: 'NEW', priority: true }];
const next = await captureMunsInsiders(prior, companies, { now: () => at, gapMs: 0,
  request: async (ticker, from, to) => {
    calls.push({ ticker, from, to });
    if (ticker === 'FAILED') throw new Error('Test outage');
    return { ok: true, trades: ticker === 'HELD' ? [latest, { ...latest, raw: 'must not be saved' }] : [] };
  }, checkpoint: state => checkpoints.push(structuredClone(state)),
});
assert.deepEqual(calls.slice(0, 2).map(c => c.ticker).sort(), ['HELD', 'NEW'], 'due/new Sattva holdings are checked first');
assert.equal(calls.find(c => c.ticker === 'HELD').from, '2026-09-02', 'late disclosures overlap the last successful read');
assert.equal(calls.find(c => c.ticker === 'NEW').from, '2025-09-10', 'first check requests a year');
assert.equal(next.byTicker.HELD.trades.length, 2, 'history retained beyond display window and repeat arrivals deduplicated');
assert(next.byTicker.HELD.trades.every(r => !('raw' in r)));
assert.equal(next.byTicker.FAILED.lastSuccessAt, undefined, 'a failed attempt cannot become a successful check');
assert.equal(next.byTicker.OTHER.lastSuccessAt, new Date(at).toISOString(), 'verified empty still advances that company');
assert.equal(checkpoints.length, 4, 'each completed answer checkpoints independently');
const targets = companies.map(c => c.ticker).sort();
assert.deepEqual(next.targetTickers, targets, 'completed and failed companies remain in the full capture target manifest');
for (const checkpoint of checkpoints) assert.deepEqual(checkpoint.targetTickers, targets, 'every checkpoint retains the full target manifest while workers consume the queue');
assert.equal(prior.byTicker.HELD.trades.length, 1, 'prior checkpoint is not mutated');

let clock = at, boundedCalls = 0;
const boundedCompanies = [...companies, { ticker: 'LATER' }];
const bounded = await captureMunsInsiders(prior, boundedCompanies, { now: () => clock, budgetMs: 1000, gapMs: 0,
  request: async () => { boundedCalls++; clock += 1000; return { trades: [] }; },
});
assert.equal(boundedCalls, 1, 'the budget stops further source requests');
assert.deepEqual(bounded.targetTickers, boundedCompanies.map(c => c.ticker).sort(), 'budget expiry retains completed, reserved and still-queued company targets');
assert.equal(bounded.byTicker.LATER, undefined, 'unattempted targets remain unchecked');
assert.deepEqual(bounded.byTicker.HELD.trades, prior.byTicker.HELD.trades, 'budget expiry preserves prior history');
assert.match(insiderSummary({ insiders: bounded }, undefined, at), /3\/5 companies checked/, 'coverage uses the full intended universe after a partial run');
assert.match(insiderSummary({ insiders: bounded }, undefined, at), /2 unchecked/);

const failedHeld = await captureMunsInsiders(next, [{ ticker: 'HELD' }], { now: () => at + 3600000, gapMs: 0, request: async () => ({ ok: false, reason: 'upstream', message: 'Unavailable' }) });
assert.deepEqual(failedHeld.byTicker.HELD.trades, next.byTicker.HELD.trades);
assert.equal(failedHeld.byTicker.HELD.lastSuccessAt, next.byTicker.HELD.lastSuccessAt);
const recovered = await captureMunsInsiders(failedHeld, [{ ticker: 'HELD' }], { now: () => at + 7200000, gapMs: 0, request: async () => ({ trades: [] }) });
assert.equal(recovered.byTicker.HELD.error, null);
assert.equal(recovered.byTicker.HELD.trades.length, 2, 'empty recovery retains historical events');

const exchange = { ...emptyExchangeSnapshot(new Date(at).toISOString()), insiders: next };
validateExchangeSnapshot(exchange);
const joined = combineExchangeDeals([latest], exchange);
assert.equal(joined.length, 2, 'Muns supplement and retained Screener/Muns rows reconcile once');
assert.match(insiderSummary({ insiders: failedHeld }, ['HELD'], at), /1 failed/);
assert.match(insiderSummary(exchange, ['UNSEEN'], at), /1 unchecked/);
assert.match(insiderSummary(exchange, ['HELD'], at + 5 * 3600000), /delayed/);
assert.match(insiderSummary(exchange, undefined, at), /3\/4 companies checked/, 'completed runs include all successful targets in universe coverage');
assert.match(insiderSummary(exchange, undefined, at), /1 failed/, 'a failed target cannot disappear from universe status');
assert.throws(() => validateExchangeSnapshot({ ...exchange, insiders: { targetTickers: [], byTicker: { X: {} } } }), /checkpoint/);
assert.deepEqual(insiderCaptureCompanies([{ ticker: 'HELD', priority: true }], { byTicker: { UNIVERSE: [], HELD: [] } }, exchange).map(c => [c.ticker, !!c.priority]), [['HELD', true], ['UNIVERSE', false]]);
console.log('PASS Muns supplementation: Sattva portfolio priority, expanding universe, overlap, checkpoint recovery, failures, empty answers, old history and deduplication');

// ---- Refusals, outages and the exit rule ---------------------------------------------------------
// Measured on 1 October 2026: the source answers HTTP 500 for a symbol it cannot resolve AND for
// everyone during its own outages. These cases pin which of the two a run may call no-record.
const { checkState, insiderVerdict, currentSymbols, OVERDUE_FAILURE_MS } = await import('./lib/muns-insider-capture.mjs');
const { captureVerdict } = await import('./capture-exchange-deals.mjs');
const { fetchInsiderTrades, upstreamDetail, MunsError } = await import('../worker/muns.mjs');

const refusal = { ok: false, kind: 'insider', reason: 'upstream', status: 500, message: 'The insider-trades API answered HTTP 500.', upstream: { message: 'Internal server error', requestId: 'req-1' } };
const answer = { ok: true, trades: [] };
const universe = n => Array.from({ length: n }, (_, i) => ({ ticker: `CO${String(i + 1).padStart(2, '0')}` }));
/** A run on a fake clock: sleeping and each request move time, so 30-second rechecks cost nothing. */
async function simulate(prior, companies, respond, options = {}) {
  let clock = at;
  const calls = [];
  const result = await captureMunsInsiders(prior, companies, {
    now: () => clock, sleep: async ms => { clock += ms; }, gapMs: 2500, budgetMs: 60_000, minCleanAnswers: 5,
    request: async (ticker, from, to) => {
      calls.push({ ticker, t: clock - at });
      clock += 800;
      const reply = respond(ticker, clock - at, calls);
      if (reply instanceof Error) throw reply;
      return structuredClone(reply);
    },
    ...options,
  });
  return { result, calls, asked: ticker => calls.filter(c => c.ticker === ticker).length };
}

{ // A company refused twice in a run that answers everyone else is named no-record, and is not a failure.
  const { result, asked } = await simulate({ byTicker: {} }, [{ ticker: 'DEAD' }, ...universe(30)], t => t === 'DEAD' ? refusal : answer);
  assert.equal(asked('DEAD'), 2, 'a refusal is asked once more in the same run');
  assert.equal(checkState(result.byTicker.DEAD), 'no-record');
  assert.equal(result.byTicker.DEAD.error, null, 'a confirmed refusal is not a failed check');
  assert.equal(result.byTicker.DEAD.noRecord.refusals, 2);
  assert.equal(result.byTicker.DEAD.failure.status, 500, 'the evidence stays on the company');
  assert.equal(result.byTicker.DEAD.failure.upstream.requestId, 'req-1', "the upstream's own words travel with it");
  assert.equal(result.run.clean, true);
  assert.equal(result.run.noRecordConfirmed, 1);
  const verdict = insiderVerdict(result, { now: at + 3600000 });
  assert.deepEqual(verdict.failures, [], 'a source with no record for a company does not fail the run');
  assert.match(verdict.notices.join(' '), /1 companies have no record at the insider source.*DEAD/, 'the gap is stated, not dropped');
  const summary = insiderSummary({ insiders: result }, undefined, at + 3600000);
  const answeredCount = result.targetTickers.filter(t => checkState(result.byTicker[t]) === 'ok').length;
  assert.match(summary, /1 have no record at the source/);
  assert.match(summary, new RegExp(`${answeredCount}/31 companies checked`), 'no-record is not counted as checked');
  assert.match(summary, new RegExp(` ${31 - answeredCount - 1} unchecked`), 'nor as unchecked');
  assert.doesNotMatch(summary, /failed checks/, 'nor as failed');

  // Already named: one more refusal agrees with it and costs one request, even in a later run.
  const again = await simulate(result, [{ ticker: 'DEAD' }, ...universe(8)], t => t === 'DEAD' ? refusal : answer);
  assert.equal(again.asked('DEAD'), 1);
  assert.equal(checkState(again.result.byTicker.DEAD), 'no-record');
  assert.equal(again.result.byTicker.DEAD.noRecord.refusals, 3);
  assert.equal(again.result.byTicker.DEAD.noRecord.since, result.byTicker.DEAD.noRecord.since);
  // And a source that starts answering it again takes the name away.
  const back = await simulate(result, [{ ticker: 'DEAD' }, ...universe(8)], () => answer);
  assert.equal(checkState(back.result.byTicker.DEAD), 'ok');
  assert.equal(back.result.byTicker.DEAD.noRecord, undefined);
  assert.equal(back.result.byTicker.DEAD.failure, undefined);
}

{ // A 404 is the source saying it has no record: confirmed the same way, and never alone.
  const missing = { ok: false, kind: 'insider', reason: 'not-found', status: 404, message: 'The insider-trades API has no record at this address (HTTP 404).' };
  const one = await simulate({ byTicker: {} }, [{ ticker: 'GONE' }, ...universe(20)], t => t === 'GONE' ? missing : answer);
  assert.equal(checkState(one.result.byTicker.GONE), 'no-record');
  assert.equal(one.result.byTicker.GONE.failure.status, 404);
  const all = await simulate({ byTicker: {} }, universe(12), () => missing);
  assert.equal(all.result.run.noRecordConfirmed, 0, 'a route that answers 404 to everyone has moved; it is not every company lacking a record');
  assert.equal(insiderVerdict(all.result, { now: at + 600000 }).failures.length, 1);
}

{ // A full outage refuses everyone: nothing can be named, every company failed, the run fails.
  const { result, asked } = await simulate({ byTicker: {} }, universe(12), () => refusal);
  assert.equal(result.run.clean, false);
  assert.equal(result.run.noRecordConfirmed, 0, 'an outage is never recorded as companies the source lacks');
  assert(result.targetTickers.filter(t => asked(t)).every(t => checkState(result.byTicker[t]) === 'failed'));
  assert.match(insiderVerdict(result, { now: at + 600000 }).failures.join(' '), /failed their insider check in this run \(\d+ upstream 500\)/);
}

{ // An outage that begins mid-run: refusals with no answer between their two asks stay failures.
  const { result } = await simulate({ byTicker: {} }, universe(30), (t, ms) => ms > 25_000 ? refusal : answer);
  const refusedLate = result.targetTickers.filter(t => result.byTicker[t]?.failure?.status === 500);
  assert(refusedLate.length > 3, 'the outage refused several companies');
  assert(refusedLate.every(t => checkState(result.byTicker[t]) === 'failed'), 'a refusal inside an outage is not named no-record');
  assert.equal(insiderVerdict(result, { now: at + 600000 }).failures.length, 1);
}

{ // A run that ends in an outage: a second refusal with no answer after it cannot be told from the outage.
  const { result, asked } = await simulate({ byTicker: {} }, [{ ticker: 'DEAD' }, ...universe(40)], (t, ms) => t === 'DEAD' || ms > 30_000 ? refusal : answer);
  assert.equal(asked('DEAD'), 2);
  assert.equal(result.run.clean, true, 'nothing failed any other way and the source answered before the outage');
  assert.equal(checkState(result.byTicker.DEAD), 'failed', 'a refusal with no answer after its second ask stays a failure');
  assert.match(insiderVerdict(result, { now: at + 600000, sample: 100 }).failures.join(' '), /\bDEAD\b/);
}

{ // Half a minute in which the source answered nobody: answers later in the run cannot vouch for it.
  const refused = Array.from({ length: 13 }, (_, i) => ({ ticker: `GAP${i + 1}` }));
  const { result, asked } = await simulate({ byTicker: {} }, [...refused, ...universe(20)], t => t.startsWith('GAP') ? refusal : answer, { concurrency: 1, budgetMs: 120_000 });
  assert(refused.every(({ ticker }) => asked(ticker) === 2), 'each refusal was asked twice');
  assert.equal(result.run.clean, true, 'nothing else failed in the run');
  assert(refused.every(({ ticker }) => checkState(result.byTicker[ticker]) === 'failed'), 'a refusal with no answer between its two asks stays a failure');
}

{ // A 500 that answers on its second ask shows the source wobbling: no refusal in that run is named.
  const { result, asked } = await simulate({ byTicker: {} }, [{ ticker: 'DEAD' }, { ticker: 'FLAKY' }, ...universe(30)],
    (t, ms, calls) => t === 'DEAD' || (t === 'FLAKY' && calls.filter(c => c.ticker === 'FLAKY').length === 1) ? refusal : answer);
  assert.equal(asked('FLAKY'), 2);
  assert.equal(checkState(result.byTicker.FLAKY), 'ok');
  assert.equal(result.run.flaps, 1);
  assert.equal(checkState(result.byTicker.DEAD), 'failed', 'an unconfirmed refusal stays a failure of this run');
  assert.match(insiderVerdict(result, { now: at + 600000 }).failures.join(' '), /DEAD/);
}

{ // A timeout anywhere in the run is a transient failure: it fails the run and blocks naming.
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { result } = await simulate({ byTicker: {} }, [{ ticker: 'DEAD' }, { ticker: 'SLOW' }, ...universe(30)],
    t => t === 'DEAD' ? refusal : t === 'SLOW' ? timeout : answer);
  assert.equal(result.byTicker.SLOW.failure.reason, 'timeout');
  assert.equal(checkState(result.byTicker.DEAD), 'failed');
  const failed = insiderVerdict(result, { now: at + 600000 }).failures.join(' ');
  assert.match(failed, /\b1 timeout\b/);
  assert.match(failed, /\b1 upstream 500\b/);
}

{ // A refusal near the end of the budget is still re-asked after it, with an answer seen after it.
  const companies = [...universe(8), { ticker: 'LATE' }, ...universe(40).slice(8)];
  const { result, asked, calls } = await simulate({ byTicker: {} }, companies, t => t === 'LATE' ? refusal : answer, { budgetMs: 25_000 });
  assert.equal(asked('LATE'), 2, 'the recheck runs after the budget');
  assert(calls.find(c => c.ticker === 'LATE').t < 25_000 && calls.filter(c => c.ticker === 'LATE')[1].t >= 25_000);
  assert(calls.at(-1).ticker !== 'LATE', 'a witness answered after the final refusal');
  assert(calls.length < 20, 'the budget still bounds how many companies the run starts');
  assert.equal(checkState(result.byTicker.LATE), 'no-record');
}

{ // Unauthorised stops the run at once, as before, and the run fails.
  const { result, calls } = await simulate({ byTicker: {} }, universe(10), () => ({ ok: false, reason: 'unauthorised', message: 'Expired session' }), { concurrency: 1 });
  assert.equal(calls.length, 1);
  assert.equal(insiderVerdict(result, { now: at + 1000 }).failures.length, 1);
}

{ // Lanes: due portfolio first, then failed companies (oldest failure first), then the rotation.
  const prior = { byTicker: {
    P: { checkedAt: '2026-09-09T20:00:00Z', lastSuccessAt: '2026-09-09T20:00:00Z', error: null, trades: [] },
    OLDOK: { checkedAt: '2026-09-01T00:00:00Z', lastSuccessAt: '2026-09-01T00:00:00Z', error: null, trades: [] },
    F2: { checkedAt: '2026-09-09T00:00:00Z', error: 'Prior outage', trades: [] },
    F1: { checkedAt: '2026-09-05T00:00:00Z', error: 'Prior outage', trades: [] },
  } };
  const { calls } = await simulate(prior, [{ ticker: 'OLDOK' }, { ticker: 'NEW' }, { ticker: 'F2' }, { ticker: 'F1' }, { ticker: 'P', priority: true }], () => answer, { concurrency: 1 });
  assert.deepEqual(calls.map(c => c.ticker), ['P', 'F1', 'F2', 'NEW', 'OLDOK'], 'a failed company is retried before the rotation');
}

{ // A renamed book holding is asked by the symbol its ISIN trades under today, filed under the book's ticker.
  const map = { 509631: { ticker: 'HEGAM', name: 'HEG Advanced Materials Ltd', isin: 'INE545A01024' },
    500001: { ticker: 'AAA', isin: 'INE000A01001' }, 500002: { ticker: 'BBB', isin: 'INE000A01001' } };
  assert.equal(currentSymbols(map).get('INE545A01024'), 'HEGAM');
  assert.equal(currentSymbols(map).get('INE000A01001'), null, 'an ISIN with two symbols is ambiguous and is not used');
  const deals = { ...emptyExchangeSnapshot(new Date(at).toISOString()), securityMap: map,
    records: [['bse-bulk', '2026-09-30', '509631', 'HEG ADVANCED', 'A FUND', 'Buy', 100, 10, '']] };
  const listed = insiderCaptureCompanies([{ ticker: 'HEG', isin: 'INE545A01024', priority: true }, { ticker: 'AAA', isin: 'INE000A01001', priority: true }], { byTicker: {} }, deals);
  assert.deepEqual(listed.map(c => [c.ticker, c.sourceTicker || null]), [['HEG', 'HEGAM'], ['AAA', null]], 'the exchange-listed HEGAM is the holding, not a second company');
  const trade = { date: '2026-09-29', cells: { Insider: 'Promoter', Transaction: 'Acquisition', 'Trade Shares': '10' } };
  const { result, calls } = await simulate({ byTicker: {} }, listed, t => t === 'HEGAM' ? { ok: true, trades: [{ ...trade, ticker: 'HEGAM' }] } : answer);
  assert.deepEqual(calls.map(c => c.ticker).sort(), ['AAA', 'HEGAM']);
  assert.equal(result.byTicker.HEG.trades[0].ticker, 'HEG', 'disclosures stay with the holding the book names');
  assert.equal(result.byTicker.HEGAM, undefined);
}

{ // The exit rule. Only this run's failures, an incomplete capture, an exchange source that failed, or a
  // failure left without a re-check past the limit fail the job; gaps from earlier runs are stated.
  const runAt = Date.parse('2026-10-02T04:00:00Z');
  const insiders = { targetTickers: ['NOW', 'EARLIER', 'STALE', 'GONE', 'OK'], run: { startedAt: new Date(runAt).toISOString() }, byTicker: {
    NOW: { checkedAt: new Date(runAt + 60000).toISOString(), error: 'The insider-trades API did not answer within 20s.', failure: { reason: 'timeout', status: null }, trades: [] },
    EARLIER: { checkedAt: new Date(runAt - 6 * 3600000).toISOString(), error: 'The insider-trades API answered HTTP 500.', trades: [] },
    STALE: { checkedAt: new Date(runAt - OVERDUE_FAILURE_MS - 60000).toISOString(), error: 'The insider-trades API answered HTTP 500.', trades: [] },
    GONE: { checkedAt: new Date(runAt - 3600000).toISOString(), error: null, noRecord: { since: '2026-09-30T00:00:00Z', refusals: 2 }, trades: [] },
    OK: { checkedAt: new Date(runAt + 1000).toISOString(), lastSuccessAt: new Date(runAt + 1000).toISOString(), error: null, trades: [] },
    LEFTOVER: { checkedAt: new Date(runAt - 30 * 86400000).toISOString(), error: 'No longer a target', trades: [] },
  } };
  const verdict = insiderVerdict(insiders, { now: runAt + 600000 });
  assert.equal(verdict.failures.length, 2);
  assert.match(verdict.failures[0], /1 companies failed their insider check in this run \(1 timeout\): NOW\./);
  assert.match(verdict.failures[1], /1 companies have carried a failed insider check for more than 3 days without a re-check: STALE\./);
  assert.match(verdict.warnings.join(' '), /1 companies still carry a failed insider check from an earlier run.*EARLIER/);
  assert.match(verdict.notices.join(' '), /GONE/);
  assert(!JSON.stringify(verdict).includes('LEFTOVER'), 'a company no longer targeted cannot hold the job red');
  const healthy = { ...insiders, byTicker: { ...insiders.byTicker, NOW: insiders.byTicker.OK, STALE: insiders.byTicker.OK } };
  const sources = ['nse-bulk', 'nse-block', 'bse-bulk', 'bse-block'].map(id => ({ id, ok: true, error: null }));
  const green = captureVerdict({ sources, insiders: healthy }, { now: runAt + 600000 });
  assert.deepEqual(green.failures, [], 'a healthy run with stated gaps exits 0');
  assert.equal(green.warnings.length, 1);
  assert.equal(green.notices.length, 1);
  const bse = captureVerdict({ sources: sources.map(s => s.id === 'bse-bulk' ? { ...s, ok: false, error: 'HTTP 403' } : s), insiders: healthy }, { now: runAt + 600000 });
  assert.match(bse.failures.join(' '), /bse-bulk: HTTP 403/, 'an exchange source failure still fails the run');
  assert.match(captureVerdict({ sources, insiders: { ...healthy, run: null, error: 'Portfolio unavailable' } }).failures.join(' '), /did not complete: Portfolio unavailable/);
  assert.match(captureVerdict({ sources }).failures.join(' '), /did not run/);
}

{ // The Worker carries the upstream's own words for a failure, bounded, and never hangs on them.
  const realFetch = globalThis.fetch;
  try {
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response(JSON.stringify({ statusCode: 500, path: '/filings/data/insider_trades', requestId: 'abc-123', message: { message: 'Internal server error', statusCode: 500 } }), { status: 500 }); };
    const error = await fetchInsiderTrades({ ticker: 'HEG', fromDate: '2026-09-01', toDate: '2026-10-01' }, { MUNS_TOKEN: 'fixture-session-token' }).catch(e => e);
    assert(error instanceof MunsError);
    assert.equal(error.status, 500);
    assert.equal(attempts, 2, 'a 5xx is still retried once');
    assert.deepEqual(error.upstream, { message: 'Internal server error', requestId: 'abc-123' });
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'token fixture-session-token rejected' }), { status: 502 });
    const echoed = await fetchInsiderTrades({ ticker: 'HEG' }, { MUNS_TOKEN: 'fixture-session-token' }).catch(e => e);
    assert.equal(echoed.upstream.message, 'token [redacted] rejected', "the Worker's own token is never quoted back");
  } finally { globalThis.fetch = realFetch; }
  assert.equal(await upstreamDetail(new Response('<html>520: Web server is returning an unknown error</html>', { status: 520 })), null, 'an HTML error page has nothing to quote');
  const started = Date.now();
  assert.equal(await upstreamDetail(new Response(new ReadableStream({ start() {} }), { status: 500 }), { ms: 50 }), null);
  assert(Date.now() - started < 1000, 'a stalled error body is abandoned at the deadline');
  const leaky = await upstreamDetail(new Response(JSON.stringify({ message: 'Lookup failed for fixture-session-token at https://internal.example/api?key=abc123 with eyJhbGciOi.eyJzdWIiOjF9.c2lnbmF0dXJl and ' + 'A'.repeat(40) }), { status: 500 }), { secrets: ['fixture-session-token'] });
  assert.equal(leaky.message, 'Lookup failed for [redacted] at [url] with [token] and [redacted]', 'nothing credential-shaped is quoted on a public route');
  const long = await upstreamDetail(new Response(JSON.stringify({ message: 'x'.repeat(10000) }), { status: 500 }));
  assert.equal(long, null, 'a body beyond the cap is not parsed as a partial message');
}
console.log('PASS insider refusals: in-run confirmation, outages, flaps, timeouts, budget witnesses, retry lane, renamed holdings, exit rule and upstream detail');
