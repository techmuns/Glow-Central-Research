// One bounded price projection and the existing public cap directory, shared by mounted tables.
import { revalidatedJson } from '../core/store.js';
import * as live from './breakout-live.js';
import { companyMarketLookup } from './company-market-shared.js';

let inputs = {}, lookup = companyMarketLookup(), pending = null, checkedAt = 0, referencesCheckedAt = 0, dailyFailed = false;
const listeners = new Set();
const emit = () => listeners.forEach(fn => fn());
export const read = company => lookup.read(company || {}, daily => {
  const quote = live.priceInfo(daily);
  return quote.at ? { ...quote, label: `${quote.stale ? 'Saved · ' : ''}${quote.source} · ${live.stamp(quote.at)}` }
    : dailyFailed ? { ...quote, label: `${quote.label} · latest daily price check unavailable` } : quote;
});
export async function load() {
  if (pending) return pending;
  if (Date.now() - checkedAt < 60_000) return;
  checkedAt = Date.now();
  pending = (async () => {
    const readQuotes = async () => {
      try {
        const response = await fetch('/api/technicals/prices', { cache: 'no-cache', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error('Price projection unavailable');
        const value = await response.json();
        if (value.version !== 1 || !value.rows?.length || !Number.isFinite(Date.parse(value.generated_at))) throw Error('Invalid price projection');
        return value;
      } catch { return revalidatedJson('data/company-quotes.json', { fresh: true }); }
    };
    const referencesDue = !inputs.marketCaps || !inputs.tickerMap || Date.now() - referencesCheckedAt >= 15 * 60_000;
    if (referencesDue) referencesCheckedAt = Date.now();
    const values = await Promise.allSettled([readQuotes(),
      referencesDue ? revalidatedJson('data/market-caps.json', { fresh: true }) : inputs.marketCaps,
      referencesDue ? revalidatedJson('data/mc-ticker-map.json', { fresh: true }) : inputs.tickerMap]);
    dailyFailed = values[0].status === 'rejected';
    for (const [i, key] of ['quotes', 'marketCaps', 'tickerMap'].entries()) {
      if (values[i].status !== 'fulfilled') continue;
      const next = values[i].value;
      if (key === 'quotes') {
        if (!next?.rows?.length || next.version !== 1 || !Number.isFinite(Date.parse(next.generated_at)) ||
          Date.parse(next.generated_at) < Date.parse(inputs.quotes?.generated_at)) { dailyFailed = true; continue; }
        const previous = new Map((inputs.quotes?.rows || []).map(row => [row.ticker, { ...row, retained: true }]));
        for (const row of next.rows) {
          const old = previous.get(row.ticker);
          if (row.cmp > 0 && (!old?.price_date || row.price_date >= old.price_date)) previous.set(row.ticker, row);
          else if (!old) previous.set(row.ticker, row);
        }
        inputs.quotes = { ...next, rows: [...previous.values()] };
      } else if (key === 'marketCaps' ? next?.version === 1 && Array.isArray(next.entries) : next?.map) inputs[key] = next;
    }
    lookup = companyMarketLookup(inputs); emit();
  })().finally(() => { pending = null; });
  return pending;
}
export function watch(fn) {
  listeners.add(fn);
  const check = () => { if (!document.hidden) void load(); };
  const stop = live.watch(fn), timer = setInterval(check, 60_000);
  document.addEventListener('visibilitychange', check); window.addEventListener('focus', check); window.addEventListener('online', check);
  check();
  return () => { listeners.delete(fn); stop(); clearInterval(timer); document.removeEventListener('visibilitychange', check);
    window.removeEventListener('focus', check); window.removeEventListener('online', check); };
}
