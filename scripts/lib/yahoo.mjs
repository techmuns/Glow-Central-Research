// lib/yahoo.mjs — the shared Yahoo Finance chart fetcher.
//
// Extracted from scrape-technicals.mjs so scrape-portfolio-history.mjs uses the same code
// path rather than a second, subtly-different copy. Two fetchers against the same endpoint
// drift: one gains a retry, the other keeps a bug, and the two feeds disagree about what a
// close price is.
//
//   import { fetchBars, sleep } from './lib/yahoo.mjs';
//   const bars = await fetchBars('RELIANCE.NS', new Date('2023-01-01'), new Date());
//
// Yahoo Chart v8 is public and needs no auth. NSE tickers carry a `.NS` suffix; the index is
// `^CRSLDX` (Nifty 500).

export const INDEX_SYMBOL = '^CRSLDX';
export const USER_AGENT = 'Mozilla/5.0 (compatible; SattvaCentralBot/1.0)';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Daily OHLCV bars between two dates.
 *
 * Returns `[{ date, open, high, low, close, volume }]`, oldest first, with nulls dropped —
 * Yahoo occasionally inserts a null row at a non-trading day. The returned array carries a
 * non-enumerable-ish `.meta` property with Yahoo's snapshot fields, which the technicals
 * scraper reads for the bid/ask sentiment rule.
 *
 * Retries 3× with backoff, and treats 429 separately with a longer wait.
 */
export async function fetchBars(symbol, start, end) {
  const p1 = Math.floor(start.getTime() / 1000);
  const p2 = Math.floor(end.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  const headers = { 'User-Agent': USER_AGENT };

  let attempt = 0;
  let lastErr;
  while (attempt < 3) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 404) throw new Error('ticker not found');
      if (r.status === 429) {
        lastErr = new Error('rate limited');
        attempt++;
        await sleep(1500 * attempt);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result || !result.timestamp) throw new Error('no chart data');

      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0] || {};
      const out = [];
      for (let i = 0; i < ts.length; i++) {
        const close = q.close?.[i];
        const volume = q.volume?.[i];
        if (close == null || volume == null) continue;
        out.push({
          date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
          open: q.open?.[i] ?? close,
          high: q.high?.[i] ?? close,
          low: q.low?.[i] ?? close,
          close,
          volume,
        });
      }
      out.meta = result.meta || {};
      return out;
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt < 3) await sleep(800 * attempt);
    }
  }
  throw lastErr;
}
