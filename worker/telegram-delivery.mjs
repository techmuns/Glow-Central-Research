import { readTelegramCollector } from './telegram-collector.mjs';
import { tagged, CORS } from './http.mjs';

export const TELEGRAM_DELIVERY_NAME = 'researchreportss-delivery-v1';
const TTL_MS = 60000;

// One channel object coordinates concurrent artifact reads. The authoritative capture stays in
// immutable Actions artifacts; this in-memory response is a disposable one-minute acceleration.
// Decompression, public-schema validation and JSON encoding run in the Durable Object, not in
// the short CPU budget of the public Worker. No Telegram request or collection dispatch occurs.
export class TelegramDelivery {
  constructor(env, { fetcher = fetch, now = Date.now } = {}) {
    this.env = env; this.fetcher = fetcher; this.now = now;
    this.cached = null; this.pending = null; this.retryAt = 0;
  }
  async response() {
    if (this.cached?.expiresAt > this.now()) return this.reply();
    if (!this.pending && this.retryAt > this.now()) return this.unavailable();
    if (!this.pending) {
      this.pending = (async () => {
        const result = await readTelegramCollector({ token: this.env.GH_DISPATCH_TOKEN,
          fetcher: this.fetcher, now: this.now, signal: AbortSignal.timeout(20000) });
        const body = JSON.stringify({ ...result.capture, delivery: result.source });
        const bytes = new TextEncoder().encode(body);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const tag = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        this.cached = { bytes, tag, expiresAt: this.now() + TTL_MS };
        this.retryAt = 0;
      })().finally(() => { this.pending = null; });
    }
    try { await this.pending; return this.reply(); }
    catch { this.retryAt = this.now() + 15000; return this.unavailable(); }
  }
  reply() {
    // Bound downstream caching by this capture check, so an almost-expired object response
    // cannot start another full minute at each edge location.
    const ttl = Math.max(0, Math.floor((this.cached.expiresAt - this.now()) / 1000));
    return tagged(this.cached.bytes, this.cached.tag, ttl);
  }
  unavailable() {
    return Response.json({ ok: false, reason: 'capture-unavailable',
      message: 'Latest collection unavailable; retain the saved archive.' },
    { status: 503, headers: { ...CORS, 'cache-control': 'no-store' } });
  }
}
