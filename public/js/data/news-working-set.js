// Query raw captures without materializing overlapping head/month archives at once. The original
// immutable parts remain authoritative. Compact, verified per-part indexes live on this device;
// they locate selected dates and EVERY companion URL before existing canonicalization runs.
import { conditionalJson, readEntry, writeEntry } from '../core/store.js';
import { shardSpec, shardPath, readVerifiedShard } from '../core/json-shards.js';
import { newsQueryIdentities as identities, newsQueryIndexRow as summary, validNewsQueryIndex, NEWS_QUERY_INDEX_VERSION } from './news-query-index.js';

const encoder = new TextEncoder();
const fetchPart = (...args) => fetch(...args);
const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const yieldInput = () => new Promise(resolve => setTimeout(resolve, 0));
function selected(item, window) {
  if (!window) return true;
  return item.slice(0, 2).some(day => day && day >= window.from && day <= window.to) ||
    !item[0] && !item[1] && !!window.includeUndated;
}
function unwrap(item, descriptor) {
  if (descriptor.spec?.field !== 'byTicker') return item;
  if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Object.hasOwn(descriptor.entry.value.byTicker, item[0]))
    throw Error('Unknown news bucket');
  return item[1];
}

export function createNewsWorkingSet({ window: readingWindow, extraRows = () => [], read = conditionalJson,
  diskRead = readEntry, diskWrite = writeEntry, fetcher = fetchPart } = {}) {
  let pending = null, descriptors = new Map(), urls = new Set(), preparedWindow = null, lastPrepared = 0, epoch = 0, selectionRevision = 0;
  const raw = path => read(path, { key: `news-query:manifest:${path}`, rawManifest: true });
  async function partIndex(descriptor, part) {
    const index = part.queryIndex;
    if (index?.version === NEWS_QUERY_INDEX_VERSION && index.sourceSha256 === part.sha256 && index.rows === part.rows &&
        /^[a-f0-9]{64}$/.test(index.sha256 || '') && index.file?.endsWith(`/${index.sha256}.json`) &&
        Number.isSafeInteger(index.bytes) && index.bytes > 0 && index.bytes <= 4 * 1024 * 1024) {
      try {
        const rows = await readVerifiedShard(shardPath(descriptor.path, index.file), index, { fetcher });
        if (validNewsQueryIndex(rows, part.rows)) return rows;
      } catch { /* A missing/corrupt optional index falls back to the verified original part. */ }
    }
    const key = `news-query:index:v${NEWS_QUERY_INDEX_VERSION}:${part.sha256}:${part.rows}:${descriptor.spec.field}`;
    const saved = (await diskRead(key))?.value;
    if (typeof saved?.json === 'string' && saved.digest === await hash(saved.json)) {
      try {
        const rows = JSON.parse(saved.json);
        if (validNewsQueryIndex(rows, part.rows)) return rows;
      } catch { /* Rebuild corrupt indexes from the original integrity-checked bytes. */ }
    }
    const items = await readVerifiedShard(shardPath(descriptor.path, part.file), part, { fetcher });
    const rows = items.map(item => summary(unwrap(item, descriptor))), json = JSON.stringify(rows);
    await diskWrite(key, { value: { json, digest: await hash(json) } });
    return rows;
  }
  async function prepare() {
    if (pending) return pending;
    const generation = epoch, window = readingWindow();
    pending = (async () => {
      const next = new Map(), selectedUrls = new Set(), edges = new Map();
      const indexRow = item => {
        if (selected(item, window)) for (const id of item[2]) selectedUrls.add(id);
        // The same TradingView story can change URLs. Close over both identities, including
        // cross-route URL companions, before any of the existing deduplicators run.
        if (item[2].length > 1) for (const id of item[2]) {
          if (!edges.has(id)) edges.set(id, new Set());
          for (const other of item[2]) edges.get(id).add(other);
        }
      };
      const load = async path => {
        if (next.has(path)) return next.get(path);
        const entry = await raw(path), spec = shardSpec(entry.value);
        if (!entry.value || typeof entry.value !== 'object') throw Error('News capture unavailable');
        const descriptor = { path, entry, spec };
        if (entry.value.byTicker) {
          let counts = spec?.bucketRows;
          if (spec && !counts) {
            // Older publications have no bucket summary. Verify their original parts one at a
            // time; an empty manifest bucket alone cannot establish that a company was checked.
            counts = Object.fromEntries(Object.keys(entry.value.byTicker).map(key => [key, 0]));
            for (const part of spec.parts) {
              const items = await readVerifiedShard(shardPath(path, part.file), part, { fetcher });
              for (const item of items) { unwrap(item, descriptor); counts[item[0]]++; }
            }
          }
          descriptor.sourceTickers = Object.keys(entry.value.byTicker)
            .filter(key => counts ? counts[key] > 0 : entry.value.byTicker[key].length > 0);
        }
        next.set(path, descriptor); return descriptor;
      };
      let head = null;
      try { head = await load('data/news.json'); } catch { /* Independent sources can still paint. */ }
      // The supplemental capture can fail independently. Keep that failure local to its reader.
      let trading = null;
      try { trading = await load('data/tradingview-news/latest.json'); } catch { /* Reader reports this below. */ }
      for (const headValue of [head?.entry.value, trading?.entry.value].filter(Boolean)) {
        const indexPath = headValue.archive?.index;
        if (!indexPath) continue;
        if (!/^(company-news|tradingview-news)\/index\.json$/.test(indexPath)) continue; // Owning archive reader reports this family's failure.
        let index;
        try { index = await load(`data/${indexPath}`); } catch { continue; }
        const family = indexPath.split('/')[0];
        if (!Array.isArray(index.entry.value.archive)) continue;
        for (const part of index.entry.value.archive) {
          if (!new RegExp(`^${family}/(\\d{4}-\\d{2}|undated)\\.json$`).test(part.file || '')) continue;
          let descriptor;
          try { descriptor = await load(`data/${part.file}`); } catch { continue; }
          const count = descriptor.spec?.rows ?? descriptor.entry.value.articles?.length;
          if (count !== part.count) { next.delete(descriptor.path); continue; }
        }
      }
      for (const row of extraRows()) indexRow(summary(row));
      // Index one bounded part at a time. Keep only its selected IDs / selected row positions;
      // the complete text and full index need no additional module-lifetime owner.
      for (const descriptor of next.values()) {
        if (descriptor.spec) {
          for (const part of descriptor.spec.parts) {
            let index;
            try { index = await partIndex(descriptor, part); }
            catch { next.delete(descriptor.path); break; }
            for (const item of index) indexRow(item);
          }
        } else {
          const value = descriptor.entry.value;
          const rows = value.articles || Object.values(value.byTicker || {}).flat();
          for (const row of rows) indexRow(summary(row));
          if (Array.isArray(value.articles) || value.byTicker) {
            descriptor.inlineField = value.byTicker ? 'byTicker' : 'articles';
            descriptor.inlineDigest = await hash(JSON.stringify(value[descriptor.inlineField]));
            descriptor.inlineCount = rows.length;
            descriptor.inlineIndex = rows.map(summary);
            // The raw inline body stays on disk / HTTP cache, not in the working-set owner.
            const metadata = { ...value };
            if (value.byTicker) metadata.byTicker = Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []]));
            else metadata.articles = [];
            descriptor.entry = { ...descriptor.entry, value: metadata };
          }
        }
        await yieldInput();
      }
      const queue = [...selectedUrls];
      for (let i = 0; i < queue.length; i++) for (const id of edges.get(queue[i]) || []) if (!selectedUrls.has(id)) {
        selectedUrls.add(id); queue.push(id);
      }
      // All families and date-correction companions have been considered before exposing a view.
      if (generation !== epoch) throw Error('Obsolete news view');
      for (const descriptor of next.values()) if (descriptor.inlineIndex) {
        descriptor.inlineNeeded = descriptor.inlineIndex.some(item => selected(item, window) || item[2].some(id => selectedUrls.has(id)));
        delete descriptor.inlineIndex;
      }
      if (JSON.stringify(preparedWindow) !== JSON.stringify(window) || urls.size !== selectedUrls.size ||
          [...selectedUrls].some(url => !urls.has(url))) selectionRevision++;
      descriptors = next; urls = selectedUrls; preparedWindow = window; lastPrepared = Date.now();
    })().finally(() => { if (generation === epoch) pending = null; });
    return pending;
  }
  async function project(descriptor) {
    const window = preparedWindow, selectedUrls = urls, queryRevision = selectionRevision;
    let value = descriptor.entry.value;
    if (!descriptor.spec && !value.byTicker && !Array.isArray(value.articles)) return { ...descriptor.entry, queryRevision };
    const field = descriptor.spec?.field || (value.byTicker ? 'byTicker' : 'articles');
    const { _jsonShards, ...out } = value;
    out.queryWindow = window; out.queryRevision = queryRevision;
    out[field] = field === 'byTicker' ? Object.fromEntries(Object.keys(value.byTicker).map(key => [key, []])) : [];
    const matches = item => selected(item, window) || item[2].some(id => selectedUrls.has(id));
    if (descriptor.inlineDigest && descriptor.inlineNeeded) {
      const entry = await raw(descriptor.path);
      if (await hash(JSON.stringify(entry.value?.[descriptor.inlineField])) !== descriptor.inlineDigest) throw Error('News capture changed during this query');
      value = entry.value;
    }
    const add = item => {
      const row = unwrap(item, { ...descriptor, spec: { field } });
      if (!matches(summary(row))) return;
      if (field === 'byTicker') out.byTicker[item[0]].push(row); else out.articles.push(row);
    };
    if (descriptor.spec) {
      const selectedItems = [];
      let offset = 0;
      for (const part of descriptor.spec.parts) {
      const index = await partIndex(descriptor, part);
      if (index.some(matches)) {
        const items = await readVerifiedShard(shardPath(descriptor.path, part.file), part, { fetcher });
        items.forEach((item, i) => { if (matches(index[i])) selectedItems.push({ item, order: part.order?.[i] ?? offset+i }); });
      }
      offset += part.rows;
      await yieldInput();
      }
      selectedItems.sort((a,b)=>a.order-b.order).forEach(({item})=>add(item));
    } else if (field === 'articles') value.articles.forEach(add);
    else for (const [key, rows] of Object.entries(value.byTicker)) for (const row of rows) add([key, row]);
    if (field === 'byTicker') {
      // A checked company whose saved articles fall outside this period is not an unchecked
      // company. Keep source failures separate, and do not rewrite the source's own empty list.
      const failed = new Set(Object.keys(value.failed || {}).map(key => key.toUpperCase()));
      out.queryEmpty = descriptor.sourceTickers.filter(key => !out.byTicker[key].length && !failed.has(key.toUpperCase()));
    }
    // Count validation describes the complete source; query rows describe only this working set.
    if (field === 'articles') out.querySourceCount = descriptor.spec?.rows ?? descriptor.inlineCount ?? value.articles.length;
    return { ...descriptor.entry, value: out };
  }
  return {
    prepare,
    includes: row => selected(summary(row), readingWindow()) || identities(row).some(id => urls.has(id)),
    async read(path, options) {
      if (!path.startsWith('data/')) return read(path, options);
      if (!lastPrepared || JSON.stringify(preparedWindow) !== JSON.stringify(readingWindow()) ||
          ['data/news.json', 'data/tradingview-news/latest.json'].includes(path) && Date.now() - lastPrepared > 1000) await prepare();
      // A period selected while an earlier preparation was in flight gets its own complete
      // projection. A pending old query cannot certify the new period.
      while (JSON.stringify(preparedWindow) !== JSON.stringify(readingWindow())) await prepare();
      const descriptor = descriptors.get(path);
      if (!descriptor) throw Error('News capture unavailable');
      return project(descriptor);
    },
    release() { epoch++; pending = null; descriptors.clear(); urls.clear(); lastPrepared = 0; preparedWindow = null; },
  };
}
