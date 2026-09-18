// An optional RAM tier. Eviction never touches durable records or its callers' live references.
export function createMemoryCache(budgetBytes) {
  const entries = new Map();
  let bytes = 0;
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  function trim() {
    for (const [key, entry] of entries) {
      if (bytes <= budgetBytes) break;
      if (entry.evictable) remove(key);
    }
  }
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    peek: key => entries.get(key)?.value,
    set(key, value, size, evictable = true) {
      remove(key);
      entries.set(key, { value, bytes: size, evictable }); bytes += size; trim();
    },
    markEvictable(key, value) {
      const entry = entries.get(key);
      if (entry?.value === value) { entry.evictable = true; trim(); }
    },
    delete: remove,
    clear() { entries.clear(); bytes = 0; },
    keys: () => entries.keys(),
    stats: () => ({ entries: entries.size, bytes, budgetBytes,
      pinnedBytes: [...entries.values()].reduce((sum, entry) => sum + (entry.evictable ? 0 : entry.bytes), 0) }),
  };
}

// Conservative accounting without allocating a second JSON string. The ceiling makes estimating
// a huge reconstructible object bounded; it is already too large for the optional tier then.
export function estimateMemoryBytes(value, ceiling = Infinity) {
  const seen = new Set(), pending = [value];
  let bytes = 0;
  while (pending.length && bytes <= ceiling) {
    const next = pending.pop();
    if (typeof next === 'string') bytes += 16 + next.length * 2;
    else if (next && typeof next === 'object' && !seen.has(next)) {
      seen.add(next); bytes += 48;
      for (const key of Object.keys(next)) { bytes += 16 + key.length * 2; pending.push(next[key]); }
    } else bytes += 8;
  }
  return bytes;
}
