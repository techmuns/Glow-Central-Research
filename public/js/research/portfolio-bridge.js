// The private book stays in the authenticated Family parent. No token, raw
// ledger, or portfolio reply is persisted here. Standalone Research has no access.
export const FAMILY_ORIGIN = 'https://sattva-family.pages.dev';
export const FAMILY_RESEARCH_URL = `${FAMILY_ORIGIN}/research`;
export const PORTFOLIO_CHANNEL = 'sattva-portfolio-v1';
export const PORTFOLIO_MAX_CHARS = 6000;
let connected = false;
let connection = null;
const listeners = new Set();
const invalidations = new Set();
let watching = false;
export const onPortfolioInvalidation = (fn) => { invalidations.add(fn); return () => invalidations.delete(fn); };
export const portfolioConnected = () => connected;
export const onPortfolioConnection = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const privatePortfolioContext = () => !!parentOrigin();

export function questionNeedsPortfolio(question) {
  return (/\b(my|our)\b/i.test(question) && /\b(portfolio|holdings|positions?|stocks?|investments?|book|nav|assets|allocation|tax|gains|pnl)\b/i.test(question)) ||
    /\b(i own|we own|i hold|we hold|do i have|do we have|am i holding|are we holding|cost basis|tax lots)\b/i.test(question);
}

function parentOrigin() {
  if (typeof window === 'undefined' || window.parent === window) return null;
  try {
    const origin = new URL(document.referrer).origin;
    if (origin === FAMILY_ORIGIN) return origin;
    if (location.origin === 'http://localhost:8080' && origin === 'http://localhost:5173') return origin;
  } catch { /* no authenticated parent */ }
  return null;
}

export function validPortfolioReply(value, startedAt = Date.now()) {
  const reading = value?.reading;
  const checked = Date.parse(reading?.checkedAt || '');
  return !!reading && ['ready', 'limited'].includes(reading.status) && typeof reading.answer === 'string' &&
    reading.answer.length > 0 && typeof reading.bookAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reading.bookAsOf) &&
    Number.isFinite(checked) && checked >= startedAt - 1000 && checked <= Date.now() + 10_000 &&
    JSON.stringify(reading).length <= PORTFOLIO_MAX_CHARS && Array.isArray(value.holdings) && value.holdings.length <= 2000 &&
    value.holdings.every((h) => typeof h?.isin === 'string' && /^[A-Z]{2}[A-Z0-9]{10}$/.test(h.isin) && typeof h.name === 'string' && h.name.length <= 300 &&
      typeof h.sector === 'string' && h.sector.length <= 200 && (h.ticker === null || (typeof h.ticker === 'string' && /^[A-Z0-9&.-]{1,30}$/.test(h.ticker))));
}

function request(type, question, signal, timeoutMs) {
  const origin = parentOrigin();
  if (!origin) return Promise.reject(new Error('Full portfolio is not connected. Open Research inside Sattva Family.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); };
    const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
    const abort = () => {
      window.parent.postMessage({ channel: PORTFOLIO_CHANNEL, id, type: 'cancel' }, origin);
      finish(new DOMException('Cancelled', 'AbortError'));
    };
    const receive = (event) => {
      if (event.origin !== origin || event.source !== window.parent || event.data?.channel !== PORTFOLIO_CHANNEL || event.data?.id !== id) return;
      if (event.data.type === 'error') finish(new Error(String(event.data.message || 'The portfolio could not be read.').slice(0, 400)));
      else if (event.data.type === (type === 'hello' ? 'ready' : 'result')) finish(null, event.data);
    };
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      window.parent.postMessage({ channel: PORTFOLIO_CHANNEL, id, type: 'cancel' }, origin);
      finish(new Error('The Family portfolio did not answer in time. No old portfolio reading was reused.'));
    }, timeoutMs);
    if (signal?.aborted) { abort(); return; }
    window.parent.postMessage({ channel: PORTFOLIO_CHANNEL, id, type, ...(question ? { question } : {}) }, origin);
  });
}

export function connectPortfolio() {
  if (!connection) connection = request('hello', null, null, 2500).then(() => {
    connected = true;
    if (!watching) {
      watching = true;
      window.addEventListener('message', (event) => {
        if (event.origin !== parentOrigin() || event.source !== window.parent || event.data?.channel !== PORTFOLIO_CHANNEL || event.data?.type !== 'invalidated' || !Number.isSafeInteger(event.data.version)) return;
        for (const fn of invalidations) fn(event.data.version);
      });
    }
    for (const fn of listeners) fn(true);
    return true;
  }).catch(() => false).finally(() => { connection = null; });
  return connection;
}

export async function readPortfolio(question, signal) {
  if (!connected && !await connectPortfolio()) return {
    reading: { status: 'unavailable', source: 'Ask Sattva', note: 'Full portfolio disconnected. The Research company list is only a dated coverage snapshot, not the current ledger. Do not answer ownership, position sizes, valuations, P&L, tax or full-book questions from it. Open Research inside Sattva Family.' },
    holdings: null,
  };
  const startedAt = Date.now();
  // Once connected, failures are fatal for this answer, never silently downgraded
  // to the old coverage snapshot under a connected badge.
  const reply = await request('read', question, signal, 125_000);
  if (!validPortfolioReply(reply, startedAt)) throw new Error('The Family portfolio reply was stale or invalid. No portfolio figures were used.');
  return reply;
}
