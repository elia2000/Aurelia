import {
  SESSION_MAX_AGE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  isSessionExpired,
} from "./accountSessions.js";

export function createSessionHelpers({
  getSession,
  touchSession,
  isProduction,
  // Optional: lets a session older than its cookie be removed when it is used.
  deleteSession = null,
  // last_seen is written at most this often per session (a write per request
  // would make every API call a database write).
  touchIntervalMs = SESSION_TOUCH_INTERVAL_MS,
  now = () => Date.now(),
}) {
  const lastTouched = new Map(); // token -> ms of the last touch

  const shouldTouch = (token) => {
    const at = now();
    const last = lastTouched.get(token);
    if (last !== undefined && at - last < touchIntervalMs) return false;
    lastTouched.set(token, at);
    if (lastTouched.size > 5000) {
      for (const [key, when] of lastTouched) {
        if (at - when >= touchIntervalMs) lastTouched.delete(key);
      }
    }
    return true;
  };

  // A malformed %-escape in a cookie value must not turn into a 500.
  const safeDecode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const parseCookies = (req) => {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return {};

    return cookieHeader.split(";").reduce((acc, cookie) => {
      const [name, ...rest] = cookie.trim().split("=");
      if (!name) return acc;

      acc[name] = safeDecode(rest.join("="));

      return acc;
    }, {});
  };

  const isHttpsRequest = (req) => {
    if (!req) return false;
    if (req.secure) return true;

    const proto = String(req.headers?.["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim()
      .toLowerCase();

    return proto === "https";
  };

  const shouldUseSecureCookie = (req) => {
    // Only mark cookies Secure on actual HTTPS requests.
    // This keeps local HTTP development working even if APP_ENV is production.
    return isProduction && isHttpsRequest(req);
  };

  const setSessionCookie = (req, res, token) => {
    const parts = [
      `sid=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
    ];

    if (shouldUseSecureCookie(req)) {
      parts.push("Secure");
    }

    res.setHeader("Set-Cookie", parts.join("; "));
  };

  const clearSessionCookie = (req, res) => {
    const parts = ["sid=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

    if (shouldUseSecureCookie(req)) {
      parts.push("Secure");
    }

    res.setHeader("Set-Cookie", parts.join("; "));
  };

  // A session row older than the cookie that carries it is dead: the browser
  // drops the cookie after Max-Age, and a copy of it must not outlive that.
  const acceptSession = (session, token) => {
    if (!session) return null;
    if (session.session_created_at && isSessionExpired(session.session_created_at, now())) {
      try {
        const removed = deleteSession?.(token);
        if (removed && typeof removed.catch === "function") removed.catch(() => {});
      } catch {
        // best effort
      }
      return null;
    }
    if (shouldTouch(token)) {
      const touched = touchSession(token);
      if (touched && typeof touched.catch === "function") touched.catch(() => {});
    }
    return session;
  };

  const getSessionFromRequest = (req) => {
    const cookies = parseCookies(req);
    if (!cookies.sid) return null;
    const token = cookies.sid;

    const rawSession = getSession(token);
    if (rawSession && typeof rawSession.then === "function") {
      return rawSession.then((session) => acceptSession(session, token));
    }

    return acceptSession(rawSession, token);
  };

  const requireSession = (req, res) => {
    const rawSession = getSessionFromRequest(req);
    if (rawSession && typeof rawSession.then === "function") {
      return rawSession.then((session) => {
        if (!session) {
          res.status(401).json({ error: "Not authenticated." });
          return null;
        }
        return session;
      });
    }

    if (!rawSession) {
      res.status(401).json({ error: "Not authenticated." });
      return null;
    }

    return rawSession;
  };

  const requireSessionUsernameMatch = (res, session, suppliedUsername) => {
    const supplied = String(suppliedUsername || "")
      .trim()
      .toLowerCase();

    if (supplied && supplied !== String(session.username || "").toLowerCase()) {
      res
        .status(403)
        .json({ error: "Username does not match authenticated user." });
      return false;
    }

    return true;
  };

  return {
    parseCookies,
    isHttpsRequest,
    shouldUseSecureCookie,
    setSessionCookie,
    clearSessionCookie,
    getSessionFromRequest,
    requireSession,
    requireSessionUsernameMatch,
  };
}
