function registerHealthRoutes(app, deps) {
  const {
    addSseClient,
    findUserByUsername,
    removeSseClient,
    requireSession,
    requireSessionUsernameMatch,
    connectPresence,
    disconnectPresence,
    getSessionFromRequest,
  } = deps;

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/events", async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return;

    const username = req.query.username?.toString()?.toLowerCase();
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    if (!requireSessionUsernameMatch(res, session, username)) return;
    const rawUser = findUserByUsername(username);
    const user = rawUser && typeof rawUser.then === "function" ? await rawUser : rawUser;

    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Hint reverse proxies (e.g., Nginx) not to buffer SSE chunks.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    addSseClient(username, res, session.session_public_id || null);
    connectPresence(username, res);

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const keepAlive = setInterval(async () => {
      res.write(`: ping\n\n`);
      // A stream outlives the request that opened it. If its session was
      // ended some other way (another instance, the CLI, an expiry), close it
      // within one ping instead of leaving it open until the browser leaves.
      if (typeof getSessionFromRequest !== "function") return;
      try {
        const stillValid = await getSessionFromRequest(req);
        if (!stillValid) {
          res.write(`data: ${JSON.stringify({ type: "session_revoked", reason: "signed_out" })}\n\n`);
          res.end();
        }
      } catch {
        // a failed lookup is not a sign-out: try again on the next ping
      }
    }, deps.eventsRecheckIntervalMs || 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      removeSseClient(username, res);
      disconnectPresence(username, res);
    });
  });
}

export { registerHealthRoutes };
