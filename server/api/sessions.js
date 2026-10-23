import { serializeSession, sortSessions } from "../lib/accountSessions.js";
import { isValidUuid } from "../lib/uuidUtils.js";

const maybe = async (value) => (value && typeof value.then === "function" ? await value : value);

/**
 * The person's own sign-ins ("active sessions").
 *
 * Only the caller's sessions are ever listed or touched: another person's
 * session id answers 404, exactly like an id that does not exist.
 * Revoking a session ends it everywhere at once: the row is deleted (so every
 * API call with its cookie answers 401), its push subscriptions are removed,
 * the E2EE device key it registered is revoked, and its open event streams
 * (SSE / WebSocket) are told and closed.
 */
function registerSessionRoutes(app, deps) {
  const {
    requireSession,
    listUserSessions,
    revokeUserSession,
    revokeOtherUserSessions,
    closeSessionStreams,
    deleteSession,
    parseCookies,
    clearSessionCookie,
  } = deps;

  const disconnect = (sessionIds, reason) => {
    if (!sessionIds.length) return;
    try {
      closeSessionStreams?.({
        sessionIds,
        payload: { type: "session_revoked", reason },
      });
    } catch {
      // the rows are already gone; the streams also re-check on their next ping
    }
  };

  app.get("/api/sessions", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const rows = (await maybe(listUserSessions(session.id))) || [];
    const current = session.session_public_id || null;
    res.json({
      sessions: sortSessions(rows.map((row) => serializeSession(row, current))),
    });
  });

  // Must be registered before "/api/sessions/:id" so "revoke-others" is not read as an id.
  app.post("/api/sessions/revoke-others", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const revoked =
      (await maybe(revokeOtherUserSessions(session.id, session.session_public_id || null))) || [];
    disconnect(revoked, "signed_out");
    res.json({ ok: true, revoked: revoked.length });
  });

  app.delete("/api/sessions/:id", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;
    const id = String(req.params.id || "");
    if (!isValidUuid(id)) return res.status(404).json({ error: "Session not found." });

    // Signing out this very device is a normal sign-out.
    if (session.session_public_id && id === session.session_public_id) {
      const token = parseCookies(req).sid;
      if (token) await maybe(deleteSession(token));
      clearSessionCookie(req, res);
      return res.json({ ok: true, current: true });
    }

    const revoked = await maybe(revokeUserSession(session.id, id));
    if (!revoked) return res.status(404).json({ error: "Session not found." });
    disconnect([id], "signed_out");
    return res.json({ ok: true });
  });
}

export { registerSessionRoutes };
