/**
 * A small in-memory cache: entries expire after their own time to live, the
 * least recently used one goes first when the cache is full, and an optional
 * byte budget keeps a cache of pictures from growing without bound.
 *
 * Nothing is written to disk. A restart empties it, which is fine: the worst
 * case is one more request to a site.
 */
export function createTtlCache({ maxEntries = 500, maxBytes = Infinity, sizeOf = () => 0, now = () => Date.now() } = {}) {
  const entries = new Map(); // key -> { value, expiresAt, size }; oldest first
  let bytes = 0;

  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    bytes -= entry.size;
    return true;
  };

  const trim = () => {
    const at = now();
    // Expired entries first, wherever they are...
    if (entries.size > maxEntries || bytes > maxBytes) {
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= at) drop(key);
      }
    }
    // ...then the least recently used.
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
    }
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        drop(key);
        return undefined;
      }
      // Most recently used goes last.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    has(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= now()) {
        drop(key);
        return false;
      }
      return true;
    },
    set(key, value, ttlMs) {
      drop(key);
      const size = Math.max(0, Number(sizeOf(value)) || 0);
      if (size > maxBytes) return false; // would never fit
      entries.set(key, { value, expiresAt: now() + ttlMs, size });
      bytes += size;
      trim();
      return entries.has(key);
    },
    delete: drop,
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
