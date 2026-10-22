import { createThrottle } from "../lib/throttle.js";
import { LinkPreviewError, allowPrivateForTests, createLinkPreviewService } from "../lib/linkPreview.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

/**
 * Link previews (opt-in, LINK_PREVIEWS, default off).
 *
 *   GET|POST /api/link-preview            ?url=...  or  { url } in a POST body
 *       -> { url, title, description, siteName, image: { url, width, height } | null }
 *   GET      /api/link-preview/image/:id  the picture of a preview, from OUR cache
 *
 * The server fetches the page (and its picture) itself; the browser of the
 * person reading never contacts the linked site. The rules for what may be
 * fetched, and how, live in lib/linkPreview.js and lib/linkPreview/. Every
 * answer is "404 Link previews are turned off" while the setting is off.
 *
 *   400 invalid_url          the link is not one that may be fetched
 *   404 link_previews_disabled
 *   422 preview_unavailable  the site could not be fetched or has nothing to show
 *   429 rate_limited         this person asks too fast (the app then waits a minute)
 *   503 busy                 the server (or this person) has enough previews loading
 *                            right now; nothing is wrong, the app just asks again later
 *
 * Fetching a site is limited per signed-in person (30 a minute, 300 a day);
 * an answer from the cache costs only the (generous) lookup limit.
 */
function registerLinkPreviewRoutes(app, deps) {
  const { requireSession, requireSessionUsernameMatch, findUserByUsername, getSetting } = deps;
  const allowPrivate = allowPrivateForTests(deps.env || process.env);
  if (allowPrivate && !deps.linkPreviewService) {
    console.warn(
      "[link-preview] LINK_PREVIEW_ALLOW_PRIVATE_FOR_TESTS is on: link previews may reach private addresses. For tests only.",
    );
  }
  const service =
    deps.linkPreviewService ||
    createLinkPreviewService({ fetcher: deps.linkPreviewFetcher || null, allowPrivate });

  // Per signed-in person, not per IP address (see lib/throttle.js).
  const lookupThrottle = createThrottle({ windowMs: 60 * 1000, max: 240 });
  const fetchPerMinute = createThrottle({ windowMs: 60 * 1000, max: 30 });
  const fetchPerDay = createThrottle({ windowMs: 24 * 60 * 60 * 1000, max: 300 });
  const imageThrottle = createThrottle({ windowMs: 60 * 1000, max: 300 });
  const tooMany = (res) =>
    res.status(429).json({ error: "Too many link preview requests. Please slow down.", code: "rate_limited" });

  const resolveCaller = async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return null;
    const supplied = typeof req.query?.username === "string" ? req.query.username : "";
    if (supplied && !requireSessionUsernameMatch(res, session, supplied)) return null;
    const user = await maybe(findUserByUsername(String(session.username || "").toLowerCase()));
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return null;
    }
    // A request that was already in flight when someone got banned.
    if (Number(user.banned)) {
      res.status(403).json({ error: "Account is banned." });
      return null;
    }
    return user;
  };

  const disabled = (res) =>
    res.status(404).json({ error: "Link previews are turned off.", code: "link_previews_disabled" });

  const readUrl = (req) => {
    const value = req.method === "POST" ? req.body?.url : req.query?.url;
    return typeof value === "string" ? value : "";
  };

  const preview = async (req, res) => {
    try {
      const user = await resolveCaller(req, res);
      if (!user) return;
      if (!getSetting("LINK_PREVIEWS")) return disabled(res);
      const userKey = String(user.id);
      if (!lookupThrottle.take(userKey)) return tooMany(res);

      const result = await service.getPreview(readUrl(req), {
        owner: userKey,
        // Asked only when a site is really about to be contacted.
        admit: () => {
          if (fetchPerMinute.remaining(userKey) < 1 || fetchPerDay.remaining(userKey) < 1) return false;
          fetchPerMinute.take(userKey);
          fetchPerDay.take(userKey);
          return true;
        },
      });
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(200).json(result);
    } catch (error) {
      if (error instanceof LinkPreviewError) {
        if (error.code === "invalid_url") {
          return res.status(400).json({ error: "This link cannot be previewed.", code: "invalid_url" });
        }
        if (error.code === "rate_limited") return tooMany(res);
        if (error.code === "busy") {
          // Not the person's own rate limit: the app must not stop asking for a minute.
          res.setHeader("Retry-After", "5");
          return res.status(503).json({ error: "Link previews are busy. Try again shortly.", code: "busy" });
        }
        // Whatever went wrong with the site (blocked address, timeout, wrong
        // type, nothing to show), the answer is the same, so a preview cannot
        // be used to find out what is on the server's network.
        return res
          .status(422)
          .json({ error: "No preview is available for this link.", code: "preview_unavailable" });
      }
      console.error("GET /api/link-preview ERROR:", error);
      return res.status(500).json({ error: "Unable to load the link preview." });
    }
  };

  app.get("/api/link-preview", preview);
  app.post("/api/link-preview", preview);

  app.get("/api/link-preview/image/:id", async (req, res) => {
    try {
      const user = await resolveCaller(req, res);
      if (!user) return;
      if (!getSetting("LINK_PREVIEWS")) return disabled(res);
      if (!imageThrottle.take(String(user.id))) return tooMany(res);
      const image = service.getImage(String(req.params.id || ""));
      if (!image) return res.status(404).json({ error: "Image not found." });

      // A plain picture: it runs nothing even if opened directly. The id is the
      // hash of the bytes, so the answer for one URL never changes.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Cache-Control", "private, max-age=86400, immutable");
      res.setHeader("Vary", "Cookie");
      res.setHeader("Content-Type", image.mime);
      res.setHeader("Content-Length", String(image.bytes.length));
      return res.status(200).end(image.bytes);
    } catch (error) {
      console.error("GET /api/link-preview/image/:id ERROR:", error);
      return res.status(500).json({ error: "Unable to load the image." });
    }
  });
}

export { registerLinkPreviewRoutes };
