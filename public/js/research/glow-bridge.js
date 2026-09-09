// Same-origin reader for the already-published Glow statement book. No credentials,
// model call, localStorage, private Sattva frame or new public portfolio data.
import { readGlowBook, glowPositionReply, glowReading } from '../data/glow-book-contract.js';
import { assertBookChange } from '../data/family-book-contract.js';
const channel = 'sattva-portfolio-v1';
const active = new Map();
let lastRevision = null;
let lastPortfolio = null;
window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.channel !== channel ||
      typeof event.data.id !== 'string' || event.data.id.length > 100) return;
  const { id, type } = event.data;
  const send = payload => parent.postMessage({ channel, id, ...payload }, location.origin);
  if (type === 'hello') { send({ type: 'ready', capabilities: ['position-sizes'] }); return; }
  if (type === 'cancel') { active.get(id)?.abort(); send({ type: 'error', message: 'Cancelled' }); return; }
  if (!['read', 'positions'].includes(type) || active.has(id) || active.size) return;
  const controller = new AbortController(); active.set(id, controller);
  try {
    const { portfolio, book } = await readGlowBook(fetch, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    assertBookChange(portfolio, lastPortfolio);
    const reply = glowPositionReply(portfolio, book);
    const changed = lastRevision && lastRevision !== portfolio.sourceRevision;
    if (changed)
      send({ type: 'invalidated', version: reply.sizes.archiveVersion });
    lastRevision = portfolio.sourceRevision;
    lastPortfolio = portfolio;
    if (controller.signal.aborted) throw Error('Cancelled');
    send({ type: 'result', ...reply, ...(type === 'read' ? { reading: glowReading(portfolio, book, reply.sizes) } : {}) });
    // AI Alerts waits for adoption after invalidation, including when the
    // background session (rather than that tab) discovered the new book.
    if (changed) send({ type: 'positions-ready', version: reply.sizes.archiveVersion });
  } catch { send({ type: 'error', message: 'The Glow statement book could not be verified. Please refresh; no replacement holdings were assumed.' }); }
  finally { active.delete(id); }
});
