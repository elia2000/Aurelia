import multer from "multer";
import { isValidUuid } from "../lib/uuidUtils.js";
import { createThrottle } from "../lib/throttle.js";
import { SAVED_GIF_MAX_BYTES, parseSaveRequest } from "../lib/savedGifs.js";
import { createSavedGifService } from "../lib/services/savedGifService.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

/**
 * Saved GIFs: a private collection per person (default 50, MAX_SAVED_GIFS).
 *
 *   GET    /api/gifs               -> { gifs: [{ id, url, thumbUrl, width, height, mime, size, createdAt }], limit, count }
 *   POST   /api/gifs               { messageId, fileId | fileIndex }   save a picture from a message you can see
 *   POST   /api/gifs/upload        multipart, one file in the field "file"   add a picture from the device
 *                                  -> 201 { gif, evicted: [{ id }], limit, count }
 *                                     (200 with `existing: true` if you already had these bytes)
 *   DELETE /api/gifs/:id           -> { ok, id, limit, count }
 *   GET    /api/gifs/:id/file      the bytes, for the owner only
 *
 * Everything is scoped to the signed-in person. Somebody else's GIF is "not
 * found", the same answer as for an id that never existed. When a save pushes
 * the person over their limit the oldest GIFs are removed and listed in
 * `evicted`, so the client can say so. Sending a saved GIF is POST
 * /api/messages with `savedGifId` (see api/messages.js). The rules live in
 * lib/services/savedGifService.js.
 */
function registerGifRoutes(app, deps) {
  const { requireSession, requireSessionUsernameMatch, findUserByUsername } = deps;
  const service = createSavedGifService(deps);

  // Limits are per signed-in person, not per IP address (see lib/throttle.js).
  const listThrottle = createThrottle({ windowMs: 60 * 1000, max: 60 });
  const saveThrottle = createThrottle({ windowMs: 60 * 1000, max: 60 });
  const uploadThrottle = createThrottle({ windowMs: 60 * 1000, max: 10 });
  const deleteThrottle = createThrottle({ windowMs: 60 * 1000, max: 60 });
  // A grid of GIFs loads many files at once; the browser caches them afterwards.
  const fileThrottle = createThrottle({ windowMs: 60 * 1000, max: 300 });
  const tooMany = (res) =>
    res.status(429).json({ error: "Too many GIF requests. Please slow down." });

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

  const send = (res, result) => res.status(result.status).json(result.body);

  // One picture in memory at a time, and only after the person is known.
  const receiveOne = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SAVED_GIF_MAX_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
  }).single("file");

  const receiveUpload = (req, res, next) =>
    receiveOne(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return res
            .status(400)
            .json({ error: "A GIF can be at most 20 MB.", code: "gif_too_large" });
        }
        return res
          .status(400)
          .json({ error: "Send exactly one file, in the field 'file'.", code: "gif_missing" });
      }
      console.error("POST /api/gifs/upload ERROR:", error);
      return res.status(400).json({ error: "Unable to read the upload.", code: "gif_invalid_upload" });
    });

  app.get("/api/gifs", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, req.query?.username);
      if (!user) return;
      if (!listThrottle.take(String(user.id))) return tooMany(res);
      return send(res, await service.list({ user }));
    } catch (error) {
      console.error("GET /api/gifs ERROR:", error);
      return res.status(500).json({ error: "Unable to load your GIFs." });
    }
  });

  app.post("/api/gifs", async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const user = await resolveCaller(req, res, body.username);
      if (!user) return;
      if (!saveThrottle.take(String(user.id))) return tooMany(res);

      const parsed = parseSaveRequest(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });

      return send(
        res,
        await service.saveFromMessage({
          user,
          messageId: parsed.messageId,
          fileId: parsed.fileId,
          fileIndex: parsed.fileIndex,
        }),
      );
    } catch (error) {
      console.error("POST /api/gifs ERROR:", error);
      return res.status(500).json({ error: "Unable to save the GIF." });
    }
  });

  // The person is identified (and throttled) before the body is read.
  app.post(
    "/api/gifs/upload",
    async (req, res, next) => {
      try {
        const user = await resolveCaller(req, res, req.query?.username);
        if (!user) return;
        if (!uploadThrottle.take(String(user.id))) return tooMany(res);
        req.gifUser = user;
        return next();
      } catch (error) {
        console.error("POST /api/gifs/upload ERROR:", error);
        return res.status(500).json({ error: "Unable to save the GIF." });
      }
    },
    receiveUpload,
    async (req, res) => {
      try {
        const bytes = req.file?.buffer;
        if (!bytes) {
          return res
            .status(400)
            .json({ error: "A GIF file is required.", code: "gif_missing" });
        }
        return send(res, await service.saveUploaded({ user: req.gifUser, bytes }));
      } catch (error) {
        console.error("POST /api/gifs/upload ERROR:", error);
        return res.status(500).json({ error: "Unable to save the GIF." });
      }
    },
  );

  app.delete("/api/gifs/:id", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, req.query?.username);
      if (!user) return;
      if (!deleteThrottle.take(String(user.id))) return tooMany(res);
      if (!isValidUuid(req.params.id)) {
        return res.status(400).json({ error: "Parameter 'id' is not a valid UUID." });
      }
      return send(res, await service.remove({ user, gifId: req.params.id }));
    } catch (error) {
      console.error("DELETE /api/gifs/:id ERROR:", error);
      return res.status(500).json({ error: "Unable to delete the GIF." });
    }
  });

  app.get("/api/gifs/:id/file", async (req, res) => {
    try {
      const user = await resolveCaller(req, res, req.query?.username);
      if (!user) return;
      if (!fileThrottle.take(String(user.id))) return tooMany(res);
      if (!isValidUuid(req.params.id)) {
        return res.status(400).json({ error: "Parameter 'id' is not a valid UUID." });
      }
      const result = await service.readFile({ user, gifId: req.params.id });
      if (!result.ok) return send(res, result);

      // Only a plain picture is shown; it runs no script even if opened directly.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      // The URL is unique to the GIF and its bytes never change, but the
      // answer is for its owner only.
      res.setHeader("Cache-Control", "private, max-age=604800, immutable");
      res.setHeader("Vary", "Cookie");
      if (result.mime) {
        res.setHeader("Content-Type", result.mime);
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", "attachment");
      }
      res.setHeader("Content-Length", String(result.bytes.length));
      return res.status(200).end(result.bytes);
    } catch (error) {
      console.error("GET /api/gifs/:id/file ERROR:", error);
      return res.status(500).json({ error: "Unable to load the GIF." });
    }
  });
}

export { registerGifRoutes };
