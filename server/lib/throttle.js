// Small in-memory sliding-window throttle keyed by an arbitrary string.
//
// The routes behind it are authenticated, so they are limited per signed-in
// user instead of per IP address: behind a reverse proxy that does not forward
// the client address, or behind a shared NAT, every user would otherwise share
// one bucket.

export function createThrottle({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // key -> number[] (timestamps)

  const prune = (key, at) => {
    const list = hits.get(key);
    if (!list) return [];
    const fresh = list.filter((t) => at - t < windowMs);
    if (fresh.length) hits.set(key, fresh);
    else hits.delete(key);
    return fresh;
  };

  return {
    /** Records one attempt. Returns false (and records nothing) when over the limit. */
    take(key) {
      const at = now();
      const fresh = prune(key, at);
      if (fresh.length >= max) return false;
      fresh.push(at);
      hits.set(key, fresh);
      if (hits.size > 10_000) {
        for (const other of hits.keys()) prune(other, at);
      }
      return true;
    },
    /** Attempts left in the current window. */
    remaining(key) {
      return Math.max(0, max - prune(key, now()).length);
    },
    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
