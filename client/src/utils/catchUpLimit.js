// After the connection was down (or the app was asleep) the events of that
// time are gone: a reaction on an old message, an edit, a delete. Reading only
// the newest page again would leave the rows above it as they were, so the
// refresh asks for as many messages as are loaded.

/** The most messages one catch-up read asks for. */
export const CATCH_UP_MAX_MESSAGES = 1000;

/** How many of the newest messages to read: the loaded window, at least one page. */
export function catchUpLimit(loadedCount, pageSize) {
  const loaded = Number(loadedCount);
  const page = Number(pageSize);
  const wanted = Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded) : 0;
  const floor = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
  return Math.min(CATCH_UP_MAX_MESSAGES, Math.max(floor, wanted));
}
