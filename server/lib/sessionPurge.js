// The hourly clean-up of sessions older than their cookie (14 days).
//
// It runs from a timer, so it must never throw: a database that is busy for a
// moment (SQLite throws SQLITE_BUSY straight away, not as a rejected promise)
// would otherwise end the process. The live streams of the sessions that are
// removed are closed first, so an open tab does not keep receiving events
// with a session that no longer exists.

import { SESSION_MAX_AGE_MS } from "./accountSessions.js";

export function createSessionPurger({
  listExpiredSessionIds,
  purgeExpiredSessions,
  closeSessionStreams = null,
  maxAgeMs = SESSION_MAX_AGE_MS,
  now = () => Date.now(),
  logger = console,
}) {
  return async function purgeStaleSessions() {
    try {
      const cutoff = new Date(now() - maxAgeMs).toISOString().replace("T", " ").slice(0, 19);
      const ids = await listExpiredSessionIds(cutoff);
      if (ids?.length) {
        closeSessionStreams?.({ sessionIds: ids, payload: { type: "session_revoked", reason: "expired" } });
      }
      return await purgeExpiredSessions(cutoff);
    } catch (error) {
      logger.warn?.(`[sessions] could not purge expired sessions: ${error?.message || error}`);
      return 0;
    }
  };
}
