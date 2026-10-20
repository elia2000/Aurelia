import { isValidUuid } from "../lib/uuidUtils.js";
import { createThrottle } from "../lib/throttle.js";
import { createPinService } from "../lib/services/pinService.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

/**
 * Pinned messages (Telegram style), per chat.
 *
 *   GET    /api/chats/:chatId/pins                 -> { pins }
 *   POST   /api/chats/:chatId/pins   { messageId } -> { pins }
 *   DELETE /api/chats/:chatId/pins/:messageId      -> { pins }
 *   DELETE /api/chats/:chatId/pins                 -> { pins }
 *
 * The caller is always the signed-in person; an optional `username` must
 * match. The rules live in lib/services/pinService.js.
 */
function registerPinRoutes(app, deps) {
  const { requireSession, requireSessionUsernameMatch, findUserByUsername } = deps;
  const service = createPinService(deps);

  // Limits are per signed-in person, not per IP address (see lib/throttle.js).
  const writeThrottle = createThrottle({ windowMs: 60 * 1000, max: 30 });
  const readThrottle = createThrottle({ windowMs: 60 * 1000, max: 120 });
  const tooMany = (res) =>
    res.status(429).json({ error: "Too many pin requests. Please slow down." });

  const resolveCaller = async (req, res, suppliedUsername) => {
    const session = await requireSession(req, res);
    if (!session) return null;
    if (suppliedUsername !== undefined && suppliedUsername !== null && suppliedUsername !== "") {
      if (!requireSessionUsernameMatch(res, session, suppliedUsername)) return null;
    }
    const user = await maybe(findUserByUsername(String(session.username || "").toLowerCase()));
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return null;
    }
    // Banning ends a person's sessions, but a request that was already in
    // flight must not get through. (Postgres returns BIGINT as a string.)
    if (Number(user.banned)) {
      res.status(403).json({ error: "Account is banned." });
      return null;
    }
    return user;
  };

  // An id must arrive as one plain UUID string: no spaces, arrays or objects.
  const readUuid = (res, value, field) => {
    if (value === undefined || value === null || value === "") {
      res.status(400).json({ error: `Field '${field}' is required.` });
      return null;
    }
    if (typeof value !== "string" || value !== value.trim() || !isValidUuid(value)) {
      res.status(400).json({ error: `Field '${field}' is not a valid UUID.` });
      return null;
    }
    return value;
  };

  const queryUsername = (req) =>
    typeof req.query?.username === "string" ? req.query.username : undefined;

  app.get("/api/chats/:chatId/pins", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, queryUsername(req));
      if (!user) return;
      if (!readThrottle.take(String(user.id))) return tooMany(res);
      const chatId = readUuid(res, req.params.chatId, "chatId");
      if (!chatId) return;

      const result = await service.list({ user, chatId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("GET /api/chats/:chatId/pins ERROR:", error);
      return res.status(500).json({ error: "Unable to load pinned messages." });
    }
  });

  app.post("/api/chats/:chatId/pins", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const user = await resolveCaller(req, res, body.username);
      if (!user) return;
      if (!writeThrottle.take(String(user.id))) return tooMany(res);
      const chatId = readUuid(res, req.params.chatId, "chatId");
      if (!chatId) return;
      const messageId = readUuid(res, body.messageId, "messageId");
      if (!messageId) return;

      const result = await service.pin({ user, chatId, messageId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("POST /api/chats/:chatId/pins ERROR:", error);
      return res.status(500).json({ error: "Unable to pin the message." });
    }
  });

  app.delete("/api/chats/:chatId/pins/:messageId", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, queryUsername(req));
      if (!user) return;
      if (!writeThrottle.take(String(user.id))) return tooMany(res);
      const chatId = readUuid(res, req.params.chatId, "chatId");
      if (!chatId) return;
      const messageId = readUuid(res, req.params.messageId, "messageId");
      if (!messageId) return;

      const result = await service.unpin({ user, chatId, messageId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("DELETE /api/chats/:chatId/pins/:messageId ERROR:", error);
      return res.status(500).json({ error: "Unable to unpin the message." });
    }
  });

  app.delete("/api/chats/:chatId/pins", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, queryUsername(req));
      if (!user) return;
      if (!writeThrottle.take(String(user.id))) return tooMany(res);
      const chatId = readUuid(res, req.params.chatId, "chatId");
      if (!chatId) return;

      const result = await service.unpinAll({ user, chatId });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("DELETE /api/chats/:chatId/pins ERROR:", error);
      return res.status(500).json({ error: "Unable to unpin the messages." });
    }
  });
}

export { registerPinRoutes };
