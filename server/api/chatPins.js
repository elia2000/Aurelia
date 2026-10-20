import { isValidUuid } from "../lib/uuidUtils.js";
import { createThrottle } from "../lib/throttle.js";
import { parseOrderBody } from "../lib/chatPins.js";
import { createChatPinService } from "../lib/services/chatPinService.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

/**
 * Pinned chats (Telegram style): conversations a person keeps at the top of
 * their own chat list. Pins are private to the person who made them.
 *
 *   PUT /api/chats/:chatId/pin   { pinned }   -> { chatId, pinned, pinPosition, pins }
 *   PUT /api/chats/pins/order    { chatIds }  -> { pins }
 *
 * `pins` is `[{ chatId, position }]`, top first. The caller is always the
 * signed-in person; an optional `username` must match. The rules live in
 * lib/services/chatPinService.js. The chat list itself (GET /api/chats) carries
 * `pinned` and `pinPosition` for each chat.
 */
function registerChatPinRoutes(app, deps) {
  const { requireSession, requireSessionUsernameMatch, findUserByUsername } = deps;
  const service = createChatPinService(deps);

  // Limits are per signed-in person, not per IP address (see lib/throttle.js).
  const writeThrottle = createThrottle({ windowMs: 60 * 1000, max: 30 });
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

  const bodyOf = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  app.put("/api/chats/:chatId/pin", async (req, res) => {
    try {
      const body = bodyOf(req);
      const user = await resolveCaller(req, res, body.username);
      if (!user) return;
      if (!writeThrottle.take(String(user.id))) return tooMany(res);
      const chatId = readUuid(res, req.params.chatId, "chatId");
      if (!chatId) return;
      if (typeof body.pinned !== "boolean") {
        return res.status(400).json({ error: "Field 'pinned' must be true or false." });
      }

      const result = await service.setPinned({ user, chatId, pinned: body.pinned });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("PUT /api/chats/:chatId/pin ERROR:", error);
      return res.status(500).json({ error: "Unable to update the pinned chat." });
    }
  });

  app.put("/api/chats/pins/order", async (req, res) => {
    try {
      const body = bodyOf(req);
      const user = await resolveCaller(req, res, body.username);
      if (!user) return;
      if (!writeThrottle.take(String(user.id))) return tooMany(res);
      const parsed = parseOrderBody(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      const result = await service.reorder({ user, chatIds: parsed.chatIds });
      return res.status(result.status).json(result.body);
    } catch (error) {
      console.error("PUT /api/chats/pins/order ERROR:", error);
      return res.status(500).json({ error: "Unable to reorder the pinned chats." });
    }
  });
}

export { registerChatPinRoutes };
