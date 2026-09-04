// The authenticated Family reader runs in a hidden frame inside Central Research.
// No token, raw ledger, or portfolio reply is persisted here.
export const FAMILY_ORIGIN = 'https://sattva-family.pages.dev';
export const FAMILY_BRIDGE_URL = `${FAMILY_ORIGIN}/research-bridge`;
export const PORTFOLIO_CHANNEL = 'sattva-portfolio-v1';
export const PORTFOLIO_MAX_CHARS = 6000;
let connected = false;
let connection = null;
let positionSizesSupported = false;
const listeners = new Set();
const invalidations = new Set();
const portfolioReady = new Set();
let watching = false;
let target = null;
let dialog = null;
let state = 'connecting';
export const portfolioConnectionState = () => state;
function setConnection(next) {
  state = next;
  connected = next === 'connected';
  if (connected && dialog?.open) dialog.close();
  for (const fn of listeners) fn(connected);
}
export const onPortfolioInvalidation = (fn) => { invalidations.add(fn); return () => invalidations.delete(fn); };
export const onPortfolioReady = (fn) => { portfolioReady.add(fn); return () => portfolioReady.delete(fn); };
export const portfolioConnected = () => connected;
export const onPortfolioConnection = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const privatePortfolioContext = () => typeof window !== 'undefined';

export function questionNeedsPortfolio(question) {
  return (/\b(my|our)\b/i.test(question) && /\b(portfolio|holdings|positions?|stocks?|investments?|book|nav|assets|allocation|tax|gains|pnl)\b/i.test(question)) ||
    /\b(i own|we own|i hold|we hold|do i have|do we have|am i holding|are we holding|cost basis|tax lots)\b/i.test(question);
}

export function validPortfolioReply(value, startedAt = Date.now()) {
  const reading = value?.reading;
  const checked = Date.parse(reading?.checkedAt || '');
  return !!reading && ['ready', 'limited'].includes(reading.status) && typeof reading.answer === 'string' &&
    reading.answer.length > 0 && typeof reading.bookAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reading.bookAsOf) &&
    Number.isFinite(checked) && checked >= startedAt - 1000 && checked <= Date.now() + 10_000 &&
    JSON.stringify(reading).length <= PORTFOLIO_MAX_CHARS && validHoldings(value.holdings);
}

function validHoldings(holdings) {
  return Array.isArray(holdings) && holdings.length <= 2000 && holdings.every((h) => typeof h?.isin === 'string' && /^[A-Z]{2}[A-Z0-9]{10}$/.test(h.isin) && typeof h.name === 'string' && h.name.length <= 300 &&
      typeof h.sector === 'string' && h.sector.length <= 200 && (h.ticker === null || (typeof h.ticker === 'string' && /^[A-Z0-9&.-]{1,30}$/.test(h.ticker))));
}

export function validPositionSizes(value, startedAt = Date.now()) {
  const sizes = value?.sizes;
  const checked = Date.parse(sizes?.checkedAt || '');
  const bookDay = Date.parse(`${sizes?.bookAsOf}T00:00:00Z`);
  if (!sizes || sizes.basis !== 'listed-market-value' || typeof sizes.complete !== 'boolean' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(sizes.bookAsOf) || !Number.isFinite(bookDay) || new Date(bookDay).toISOString().slice(0, 10) !== sizes.bookAsOf ||
      !Number.isSafeInteger(sizes.archiveVersion) || sizes.archiveVersion < 0 ||
      !Number.isFinite(checked) || checked < startedAt - 1000 || checked > Date.now() + 10_000 ||
      !validHoldings(value.holdings) || new Set(value.holdings.map((h) => h.isin)).size !== value.holdings.length ||
      JSON.stringify(value).length > 1_500_000) return false;
  if (!sizes.complete) return value.holdings.every((h) => h.weightPct === null);
  return value.holdings.every((h) => Number.isFinite(h.weightPct) && h.weightPct >= 0 && h.weightPct <= 100) &&
    Math.abs(value.holdings.reduce((sum, h) => sum + h.weightPct, 0) - 100) < 0.001;
}

function ensureTarget() {
  if (target) return target;
  {
    const origin = location.origin === 'http://localhost:8080' ? 'http://localhost:5173' : FAMILY_ORIGIN;
    dialog = document.createElement('dialog');
    dialog.className = 'portfolio-unlock-dialog';
    dialog.setAttribute('aria-label', 'Unlock portfolio access');
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close';
    close.className = 'portfolio-unlock-close';
    close.onclick = () => dialog.close();
    const frame = document.createElement('iframe');
    frame.title = 'Private portfolio connection';
    frame.src = `${origin}/research-bridge`;
    dialog.append(close, frame);
    document.body.appendChild(dialog);
    target = { origin, window: frame.contentWindow };
    // The closed dialog keeps data access invisible. It is opened only by an
    // explicit Unlock click when the existing authenticated session is absent.
  }
  if (!watching) {
    watching = true;
    window.addEventListener('message', (event) => {
      if (event.origin !== target.origin || event.source !== target.window || event.data?.channel !== PORTFOLIO_CHANNEL) return;
      if (event.data.type === 'auth-required') {
        setConnection('locked');
        for (const fn of invalidations) fn(-1);
      } else if (event.data.type === 'available') {
        setConnection('connecting');
        connectPortfolio();
      } else if (Number.isSafeInteger(event.data.version)) {
        const targets = event.data.type === 'invalidated' ? invalidations : event.data.type === 'positions-ready' ? portfolioReady : [];
        for (const fn of targets) fn(event.data.version);
      }
    });
  }
  return target;
}

export function unlockPortfolio() {
  ensureTarget();
  if (dialog && !dialog.open) dialog.showModal();
}

function request(type, question, signal, timeoutMs) {
  const peer = ensureTarget();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let timer, retry;
    const cleanup = () => { clearTimeout(timer); clearInterval(retry); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); };
    const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
    const post = (kind) => peer.window.postMessage({ channel: PORTFOLIO_CHANNEL, id, type: kind, ...(question ? { question } : {}) }, peer.origin);
    const abort = () => { post('cancel'); finish(new DOMException('Cancelled', 'AbortError')); };
    const receive = (event) => {
      if (event.origin !== peer.origin || event.source !== peer.window || event.data?.channel !== PORTFOLIO_CHANNEL) return;
      if (event.data.type === 'auth-required') { finish(new Error('Unlock your portfolio above to answer with your holdings.')); return; }
      if (event.data?.id !== id) return;
      if (event.data.type === 'error') finish(new Error(String(event.data.message || 'The portfolio could not be read.').slice(0, 400)));
      else if (event.data.type === (type === 'hello' ? 'ready' : 'result')) finish(null, event.data);
    };
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { post('cancel'); finish(new Error('The portfolio did not answer in time. Please try again.')); }, timeoutMs);
    if (signal?.aborted) { abort(); return; }
    // A cold iframe can finish loading after the first hello. Retry only the
    // side-effect-free handshake, never a question or a data read.
    if (type === 'hello') retry = setInterval(() => post('hello'), 250);
    post(type);
  });
}

export function connectPortfolio() {
  if (connected) return Promise.resolve(true);
  if (!connection) connection = request('hello', null, null, 15_000).then((reply) => {
    positionSizesSupported = Array.isArray(reply.capabilities) && reply.capabilities.includes('position-sizes');
    setConnection('connected');
    return true;
  }).catch(() => { if (state !== 'locked') setConnection('unavailable'); return false; }).finally(() => { connection = null; });
  return connection;
}

export async function readPortfolio(question, signal) {
  if (!connected && !await connectPortfolio()) throw new Error(state === 'locked'
    ? 'Unlock your portfolio above to answer with your holdings.'
    : 'Your portfolio connection is unavailable. Please try again; no old holdings were used.');
  const startedAt = Date.now();
  // Once connected, failures are fatal for this answer, never silently downgraded
  // to the old coverage snapshot under a connected badge.
  const reply = await request('read', question, signal, 125_000);
  if (!validPortfolioReply(reply, startedAt) || !validPositionSizes(reply, startedAt)) throw new Error('The Family portfolio reply was stale or invalid. No portfolio figures were used.');
  return reply;
}

/** A direct, ephemeral size snapshot from the authenticated reader; no model or public ledger. */
export async function readPositionSizes(signal) {
  if (!connected && !await connectPortfolio()) return null;
  if (!positionSizesSupported) return null;
  const startedAt = Date.now();
  const reply = await request('positions', null, signal, 45_000);
  if (!validPositionSizes(reply, startedAt)) throw new Error('Holding sizes were stale or incomplete. Refresh to read the active portfolio again.');
  return reply;
}
