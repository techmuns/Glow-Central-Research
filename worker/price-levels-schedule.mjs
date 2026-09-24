import { boundedJson } from '../public/js/data/family-book-contract.js';
import { istDate, marketWindow, expectedSession } from '../public/js/data/breakout-live-shared.js';

// THE MINUTE CHECK — every waiting price level against the live price, while the market is open.
//
// An alert has to fire whether or not anybody has the dashboard open, so this is a Durable Object
// ALARM on the price-level object itself, not a poll from a page: once a minute from 09:15 to 16:15
// IST on a trading day, every fifteen minutes otherwise, and not at all while there is nothing left
// to check. The account has no free cron slot (see wrangler.jsonc), and the breakout capture already
// proves this arrangement against the same Upstox feed — see worker/breakout-primary.mjs.
//
// WHICH PRICE, AND HOW IT IS PROVEN TO BE THIS COMPANY'S
//   Upstox's full market quote, keyed on the company's ISIN (`NSE_EQ|<ISIN>`), which the family's own
//   dashboard sends with every level. A row counts only if it echoes BOTH the instrument key asked
//   for AND the ticker the level was set on — the identity gate the breakout capture and Glow
//   Ventures' own quote feed both apply. A company that arrived with no ISIN is not guessed from its
//   name: it is reported as unchecked, by name, until an ISIN arrives with its next save.
//
// A QUOTE FROM ANOTHER DAY IS NOT TODAY'S PRICE. Only a quote whose last trade falls on today's IST
// session is compared, so a pre-open quote still carrying yesterday's close can never fire a level.

export const PRICE_LEVEL_TIMER = 'price-level-timer';
export const PRICE_LEVEL_INTERVAL = 60000;
export const PRICE_LEVEL_IDLE_INTERVAL = 15 * 60000;
/** A check this late is overdue — the alarm was lost or every attempt is failing. */
export const PRICE_LEVEL_MAX_AGE = 3 * 60000;
const UPSTOX_CLIENT = 'GlowCentralResearch/1.0';
const FAILED = new Set(['not-configured', 'authentication', 'rate-limited', 'unavailable']);

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * Upstox's answer, reduced to what a level needs: the last price and the day's range, for the
 * companies that proved who they are. Pure — the suite hands it a recorded payload.
 */
export function levelQuotes(payload, targets, now = Date.now()) {
  if (payload?.status !== 'success' || !payload.data || typeof payload.data !== 'object') throw Error('unavailable');
  const byKey = new Map(targets.map((target) => [`NSE_EQ|${target.isin}`, target]));
  const today = istDate(now);
  const quotes = new Map();
  for (const data of Object.values(payload.data)) {
    const target = byKey.get(data?.instrument_token);
    // BOTH halves of the identity: the key we asked for AND the symbol the level was set on.
    if (!target || data.symbol !== target.ticker) continue;
    const price = finite(data.last_price);
    const tradeAt = Number(data.last_trade_time);
    if (price === null || !Number.isFinite(tradeAt) || tradeAt <= 0 || tradeAt > now + 60000) continue;
    const sessionDate = istDate(tradeAt);
    if (sessionDate !== today) continue;
    quotes.set(target.ticker, {
      price,
      // The day's range can only ever widen what counts as reached, so an absent figure stays absent
      // rather than falling back to the last price — that would narrow nothing and claim a range.
      high: finite(data.ohlc?.high),
      low: finite(data.ohlc?.low),
      sessionDate,
      quoteAt: new Date(tradeAt).toISOString(),
    });
  }
  return quotes;
}

/** One call for up to 500 companies. Never follows a redirect carrying the credential. */
export async function fetchLevelQuotes(targets, token, { fetcher = fetch, now = Date.now } = {}) {
  const quotes = new Map();
  let reason = null;
  for (let offset = 0; offset < targets.length; offset += 500) {
    const batch = targets.slice(offset, offset + 500);
    const url = new URL('https://api.upstox.com/v2/market-quote/quotes');
    url.searchParams.set('instrument_key', batch.map((target) => `NSE_EQ|${target.isin}`).join(','));
    try {
      const response = await fetcher(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UPSTOX_CLIENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        reason = [401, 403].includes(response.status) ? 'authentication' : response.status === 429 ? 'rate-limited' : 'unavailable';
        await response.body?.cancel();
        break;
      }
      for (const [ticker, quote] of levelQuotes(await boundedJson(response, 4 * 1024 * 1024), batch, now())) quotes.set(ticker, quote);
    } catch {
      reason = 'unavailable';
      break;
    }
  }
  return { quotes, reason };
}

export class PriceLevelSchedule {
  constructor(storage, env, store, { now = Date.now, fetcher = fetch } = {}) {
    this.storage = storage;
    this.env = env;
    this.store = store;
    this.now = now;
    this.fetcher = fetcher;
  }

  /** What a reader is told about the check, alongside the list. */
  async status() {
    const state = (await this.storage.get(PRICE_LEVEL_TIMER)) || { started: false };
    const alarmAt = await this.storage.getAlarm();
    const pending = this.store.activeTargets();
    const at = this.now();
    const overdue = !!state.started && pending.length > 0 && marketWindow(at).collect &&
      (alarmAt === null || at > (state.nextAt || 0) + PRICE_LEVEL_MAX_AGE);
    const session = expectedSession(at);
    // 'idle' is only ever true of an EMPTY list; levels that arrived since the last wake are waiting.
    const reason = state.reason && state.reason !== 'idle' ? state.reason : 'waiting';
    return {
      configured: !!this.env?.UPSTOX_ACCESS_TOKEN,
      state: overdue ? 'overdue' : pending.length ? reason : 'idle',
      failed: pending.length > 0 && (overdue || FAILED.has(state.reason)),
      lastAttemptAt: state.lastAttemptAt ? new Date(state.lastAttemptAt).toISOString() : null,
      checkedAt: state.okAt ? new Date(state.okAt).toISOString() : null,
      session: state.okSession || null,
      // "Current" means every waiting level has been checked against the latest session that has
      // happened — or that nothing is waiting at all, which is complete by definition.
      current: !pending.length || (!!session && state.okSession === session),
      nextAt: alarmAt ? new Date(alarmAt).toISOString() : null,
      failures: Array.isArray(state.failures) ? state.failures : [],
    };
  }

  /** The list, the reached history and the check's own state, in one answer. */
  async snapshot() {
    // A list with levels waiting and no alarm set heals itself on the next read.
    await this.arm();
    return { ...this.store.snapshot(), check: await this.status() };
  }

  /** Set the alarm if there is something to check and none is set. Idempotent. */
  async arm() {
    if (!this.store.activeTargets().length) return;
    await this.storage.transaction(async (tx) => {
      const state = (await tx.get(PRICE_LEVEL_TIMER)) || {};
      if ((await tx.getAlarm()) !== null) return;
      const nextAt = this.now() + 1000;
      await tx.put(PRICE_LEVEL_TIMER, { ...state, started: true, nextAt });
      await tx.setAlarm(nextAt);
    });
  }

  async wake() {
    const at = this.now();
    const window = marketWindow(at);
    const claimed = await this.storage.transaction(async (tx) => {
      const old = (await tx.get(PRICE_LEVEL_TIMER)) || {};
      // An early or duplicate wake keeps the schedule it already has rather than doubling a call.
      if (old.lastAttemptAt && old.nextAt > at) { await tx.setAlarm(old.nextAt); return false; }
      const nextAt = at + (window.collect ? PRICE_LEVEL_INTERVAL : PRICE_LEVEL_IDLE_INTERVAL);
      await tx.put(PRICE_LEVEL_TIMER, { ...old, started: true, lastAttemptAt: at, nextAt, reason: 'checking' });
      await tx.setAlarm(nextAt);
      return true;
    });
    if (!claimed) return;

    const targets = this.store.activeTargets();
    let reason = 'closed';
    let checked = 0;
    let reached = 0;
    let failures = [];
    let ok = false;
    if (!targets.length) {
      // NOTHING LEFT TO CHECK, SO NOTHING IS SCHEDULED. The next save arms it again.
      reason = 'idle';
      await this.storage.deleteAlarm();
    } else if (window.collect) {
      const withIsin = targets.filter((target) => target.isin);
      if (!this.env?.UPSTOX_ACCESS_TOKEN) reason = 'not-configured';
      else {
        try {
          const result = withIsin.length
            ? await fetchLevelQuotes(withIsin, this.env.UPSTOX_ACCESS_TOKEN, { fetcher: this.fetcher, now: this.now })
            : { quotes: new Map(), reason: null };
          reached = this.store.recordCheck(this.now(), result.quotes).reached.length;
          checked = result.quotes.size;
          failures = targets.filter((target) => !result.quotes.has(target.ticker)).map((target) => ({
            ticker: target.ticker,
            reason: !target.isin ? 'no-isin' : result.reason || 'no-quote-today',
          }));
          reason = result.reason || (failures.length ? 'partial' : 'ok');
          ok = !result.reason && checked > 0;
        } catch {
          reason = 'unavailable';
        }
      }
    }
    await this.storage.transaction(async (tx) => {
      const state = (await tx.get(PRICE_LEVEL_TIMER)) || {};
      if (state.lastAttemptAt !== at) return;
      const next = { ...state, reason, checked, reached, failures: failures.slice(0, 50), completedAt: this.now() };
      if (ok) { next.okAt = this.now(); next.okSession = istDate(at); }
      if (reason === 'idle') next.nextAt = null;
      await tx.put(PRICE_LEVEL_TIMER, next);
    });
  }
}
