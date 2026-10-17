import { isValidUuid } from "../lib/uuidUtils.js";
import { createThrottle } from "../lib/throttle.js";
import { createReactionService } from "../lib/services/reactionService.js";
import { normalizeReactionEmoji, parseReactRequestEmoji } from "../lib/reactions.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

/**
 * Message reactions (Telegram style).
 *
 *   POST /api/messages/react        { chatId, messageId, emoji|null }
 *   GET  /api/messages/reactions    ?chatId=&messageId=&emoji=
 *
 * The caller is always the signed-in person; an optional `username` must
 * match. The rules live in lib/services/reactionService.js.
 */
function registerReactionRoutes(app, deps) {
  const { requireSession, requireSessionUsernameMatch, findUserByUsername } = deps;
  const service = createReactionService(deps);

  // Limits are per signed-in person, not per IP address (see lib/throttle.js).
  const reactThrottle = createThrottle({ windowMs: 60 * 1000, max: 30 });
  const listThrottle = createThrottle({ windowMs: 60 * 1000, max: 120 });
  const tooMany = (res) =>
    res.status(429).json({ error: "Too many reaction requests. Please slow down." });

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
    return user;
  };

  // Reads a UUID that must arrive as one plain string (not an array or object).
  const readUuid = (res, source, field) => {
    const value = source?.[field];
    if (value === undefined || value === null || value === "") {
      res.status(400).json({ error: `Field '${field}' is required.` });
      return null;
    }
    if (typeof value !== "string" || !isValidUuid(value)) {
      res.status(400).json({ error: `Field '${field}' is not a valid UUID.` });
      return null;
    }
    return value;
  };

  app.post("/api/messages/react", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const user = await resolveCaller(req, res, body.username);
      if (!user) return;
      if (!reactThrottle.take(String(user.id))) return tooMany(res);

      const chatId = readUuid(res, body, "chatId");
      if (!chatId) return;
      const messageId = readUuid(res, body, "messageId");
      if (!messageId) return;
      const parsed = parseReactRequestEmoji(body.emoji);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const result = await service.react({ user, chatId, messageId, emoji: parsed.emoji });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("POST /api/messages/react ERROR:", error);
      return res.status(500).json({ error: "Unable to update reaction." });
    }
  });

  app.get("/api/messages/reactions", async (req, res) => {
    try {
      const query = req.query || {};
      const user = await resolveCaller(req, res, query.username);
      if (!user) return;
      if (!listThrottle.take(String(user.id))) return tooMany(res);

      const chatId = readUuid(res, query, "chatId");
      if (!chatId) return;
      const messageId = readUuid(res, query, "messageId");
      if (!messageId) return;

      let emoji = null;
      if (query.emoji !== undefined && query.emoji !== "") {
        const parsed = normalizeReactionEmoji(query.emoji);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        emoji = parsed.emoji;
      }

      const result = await service.listReactors({ user, chatId, messageId, emoji });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("GET /api/messages/reactions ERROR:", error);
      return res.status(500).json({ error: "Unable to load reactions." });
    }
  });
}

export { registerReactionRoutes };
