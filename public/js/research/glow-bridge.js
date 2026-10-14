// Same-origin reader for the already-published Glow statement book. No credentials,
// model call, localStorage, private Sattva frame or new public portfolio data.
import { readGlowBook, glowPositionReply, glowReading } from '../data/glow-book-contract.js';
import { assertBookChange } from '../data/family-book-contract.js';
import { boundedJson } from '../data/family-book-contract.js';
import { glowManagerSnapshot } from '../data/glow-manager-contract.js';
const channel = 'sattva-portfolio-v1';
const active = new Map();
let lastRevision = null;
let lastPortfolio = null;
window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.channel !== channel ||
      typeof event.data.id !== 'string' || event.data.id.length > 100) return;
  const { id, type } = event.data;
  const send = payload => parent.postMessage({ channel, id, ...payload }, location.origin);
  if (type === 'hello') { send({ type: 'ready', capabilities: ['position-sizes', 'manager-workbook', 'price-levels'] }); return; }
  if (type === 'cancel') { active.get(id)?.abort(); send({ type: 'error', message: 'Cancelled' }); return; }
  if (!['read', 'positions', 'managers', 'price-levels'].includes(type) || active.has(id)) return;
  // Price alerts and manager/position reads have independent callers in the shared template.
  // Silently dropping an overlapping read leaves its caller waiting until the transport timeout.
  if (active.size >= 8) { send({ type: 'error', message: 'Glow statement reads are busy; please retry.' }); return; }
  const controller = new AbortController(); active.set(id, controller);
  try {
    if (type === 'price-levels') {
      const cursor = event.data.question;
      if (cursor && (typeof cursor !== 'string' || cursor.length > 700)) throw Error('Invalid cursor');
      const priceLevels = await boundedJson(await fetch(`/api/price-levels${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      }), 1500000);
      send({ type: 'result', priceLevels }); return;
    }
    const { portfolio, book } = await readGlowBook(fetch, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
    assertBookChange(portfolio, lastPortfolio);
    if (type === 'managers') {
      const source = await boundedJson(await fetch('/data/managers.json', { cache: 'no-cache', signal: controller.signal }), 5_000_000);
      send({ type: 'result', managers: await glowManagerSnapshot(portfolio, book, source) }); return;
    }
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
