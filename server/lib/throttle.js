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
    /**
     * Records one attempt, or `cost` of them for work that is worth more than
     * one (a request that creates many messages). Returns false, and records
     * nothing, when the whole cost does not fit in what is left.
     */
    take(key, cost = 1) {
      let units = Number(cost);
      if (!Number.isFinite(units) || units < 0) units = 1;
      units = Math.ceil(units);
      if (units === 0) return true;
      const at = now();
      const fresh = prune(key, at);
      if (fresh.length + units > max) return false;
      for (let i = 0; i < units; i += 1) fresh.push(at);
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
