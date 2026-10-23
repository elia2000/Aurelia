import { userEvents } from "../lib/workers/autoAddWorker.js";
import { AUTH_METHODS, summarizeUserAgent } from "../lib/accountSessions.js";
import { loginGuardFor, sendTooManyAttempts } from "../lib/loginGuard.js";
import {
  createChallengeGuard,
  signLoginChallenge,
  verifyLoginChallenge,
} from "../lib/twoFactor.js";
import { twoFactorServiceFor } from "../lib/twoFactorService.js";

const maybe = async (value) => (value && typeof value.then === "function" ? await value : value);

// Compared against when the account name is unknown, so a wrong name costs the
// same time as a wrong password (no user enumeration through timing).
let decoyHash = null;
const decoyHashFor = (bcrypt, crypto) => {
  if (!decoyHash) decoyHash = bcrypt.hashSync(crypto.randomBytes(16).toString("hex"), 10);
  return decoyHash;
};

function registerAuthRoutes(app, deps) {
  const {
    USER_COLORS,
    USERNAME_REGEX,
    getSetting,
    bcrypt,
    clearSessionCookie,
    createSession,
    createUser,
    crypto,
    deleteSession,
    ensureAvatarExists,
    findChatByGroupUsername,
    findUserByUsername,
    parseCookies,
    setSessionCookie,
    setUserColor,
    updateLastSeen,
    getSessionFromRequest,
  } = deps;

  const guard = loginGuardFor(deps);
  const twoFactor = twoFactorServiceFor(deps);
  const challenges = deps.challengeGuard || (deps.challengeGuard = createChallengeGuard());

  // A new login never reuses a token: it always gets a fresh random id, and the
  // session the browser was holding (if any) is retired so it does not linger
  // in the list of active sessions or stay usable.
  const startSession = async (req, res, userId, authMethod) => {
    const previous = parseCookies(req).sid;
    if (previous) {
      try {
        await maybe(deleteSession(previous));
      } catch {
        // best effort: the old session is also removed by expiry
      }
    }
    const token = crypto.randomBytes(24).toString("hex");
    await createSession(userId, token, {
      userAgent: summarizeUserAgent(req.headers?.["user-agent"]),
      authMethod,
    });
    setSessionCookie(req, res, token);
    return token;
  };

  const userPayload = (user) => ({
    id: user.id,
    username: user.username,
    nickname: user.nickname || null,
    avatarUrl: ensureAvatarExists(user.id, user.avatar_url) || null,
    color: user.color || USER_COLORS[0],
    status: user.status || "online",
  });

  app.post("/api/register", async (req, res) => {
    if (!getSetting("SIGN_UP")) {
      return res.status(403).json({ error: "Account creation is disabled." });
    }
    const { username, password, nickname, avatarUrl } = req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password are required." });
    }

    const trimmed = username.trim().toLowerCase();
    const usernameMax = getSetting("USERNAME_MAX_CHARS");
    const nicknameMax = getSetting("NICKNAME_MAX_CHARS");

    if (trimmed.length < 3) {
      return res
        .status(400)
        .json({ error: "Username must be at least 3 characters." });
    }
    if (usernameMax && trimmed.length > usernameMax) {
      return res.status(400).json({
        error: `Username must be at most ${usernameMax} characters.`,
      });
    }

    if (!USERNAME_REGEX.test(trimmed)) {
      return res.status(400).json({
        error:
          "Username can only include english letters, numbers, dot (.), and underscore (_).",
      });
    }
    if (nickname && String(nickname).trim().length > (nicknameMax || 0)) {
      return res.status(400).json({
        error: `Nickname must be at most ${nicknameMax} characters.`,
      });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    const rawExisting = findUserByUsername(trimmed);
    const existing = rawExisting && typeof rawExisting.then === "function" ? await rawExisting : rawExisting;
    if (existing) {
      return res.status(409).json({ error: "Username already exists." });
    }
    if (findChatByGroupUsername) {
      const rawGroup = findChatByGroupUsername(trimmed);
      const group = rawGroup && typeof rawGroup.then === "function" ? await rawGroup : rawGroup;
      if (group) {
        return res.status(409).json({ error: "Username already exists." });
      }
    }

    const assignedColor = setUserColor();
    const passwordHash = bcrypt.hashSync(password, 10);

    const rawId = createUser(
      trimmed,
      passwordHash,
      nickname?.trim() || null,
      avatarUrl?.trim() || null,
      assignedColor,
    );
    const id = rawId && typeof rawId.then === "function" ? await rawId : rawId;

    if (id) {
      userEvents.emit("user:created", { userId: id });
    }

    await startSession(req, res, id, AUTH_METHODS.REGISTRATION);

    return res.json({
      id,
      username: trimmed,
      nickname: nickname?.trim() || null,
      avatarUrl: ensureAvatarExists(id, avatarUrl?.trim()) || null,
      color: assignedColor,
      status: "online",
    });
  });

  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Username and password are required." });
    }
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    const trimmed = username.trim().toLowerCase();
    const who = { ip: req.ip, account: trimmed };
    if (!(await guard.enter(who, res)).allowed) return sendTooManyAttempts(res, guard);

    const user = await maybe(findUserByUsername(trimmed));

    // Always compare against a hash, even for an unknown name, so the response
    // time does not tell whether the account exists.
    const hash = user?.password_hash || decoyHashFor(bcrypt, crypto);
    const passwordOk = (await bcrypt.compare(password, hash)) && Boolean(user?.password_hash);

    if (!passwordOk) {
      guard.recordFailure(who);
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // NB: Postgres returns BIGINT columns (e.g. users.banned) as strings,
    // and "0" is truthy in JS, so coerce to Number before the check.
    // Checked after the password, so the ban state of an account is not
    // visible to somebody who does not know its password.
    if (Number(user.banned)) {
      return res.status(403).json({ error: "Account is banned." });
    }

    const tf = typeof deps.getUserTwoFactor === "function" ? await maybe(deps.getUserTwoFactor(user.id)) : null;
    if (tf?.enabled) {
      // Right password, second factor still owed: no session and no cookie yet.
      const challenge = signLoginChallenge({ userId: user.id });
      return res.json({
        twoFactorRequired: true,
        challenge: challenge.token,
        expiresInSeconds: Math.round((challenge.exp - Date.now()) / 1000),
      });
    }

    guard.recordSuccess(who);
    await updateLastSeen(user.id);
    await startSession(req, res, user.id, AUTH_METHODS.PASSWORD);

    return res.json(userPayload(user));
  });

  // Second step of a sign-in with 2FA: the challenge from /api/login plus a
  // code from the authenticator app, or one recovery code.
  app.post("/api/login/2fa", async (req, res) => {
    const { challenge, code, recoveryCode } = req.body || {};
    const expired = () =>
      res.status(401).json({ error: "This sign-in has expired. Enter your password again.", restart: true });

    if (typeof challenge !== "string" || !challenge) return expired();
    const payload = verifyLoginChallenge(challenge);
    if (!payload) return expired();

    const stateError = () => {
      const state = challenges.status(payload.jti);
      if (state === "used") return expired();
      if (state === "locked") {
        return res
          .status(429)
          .json({ error: "Too many wrong codes. Enter your password again.", restart: true });
      }
      return null;
    };
    if (stateError()) return;

    const user = await maybe(deps.findUserById(payload.uid));
    if (!user || Number(user.banned)) return expired();

    // Same buckets as the password step, so wrong codes and wrong passwords add up.
    const who = { ip: req.ip, account: String(user.username || "").toLowerCase() };
    if (!(await guard.enter(who, res)).allowed) return sendTooManyAttempts(res, guard);
    // Earlier attempts on this account have been counted by now: look at the challenge again.
    if (stateError()) return;
    if (twoFactor.isBlocked(user.id)) return sendTooManyAttempts(res, guard);

    const hasInput =
      (typeof code === "string" && code.trim() !== "") ||
      (typeof recoveryCode === "string" && recoveryCode.trim() !== "");
    const result = hasInput
      ? await twoFactor.verify(user.id, {
          code: typeof code === "string" ? code : "",
          recoveryCode: typeof recoveryCode === "string" ? recoveryCode : "",
        })
      : { ok: false, reason: "format" };

    if (!result.ok) {
      guard.recordFailure(who);
      twoFactor.recordFailure(user.id);
      const left = challenges.fail(payload.jti, payload.exp);
      if (left === 0) {
        return res
          .status(429)
          .json({ error: "Too many wrong codes. Enter your password again.", restart: true });
      }
      return res.status(401).json({ error: "Invalid code.", attemptsLeft: left });
    }

    challenges.consume(payload.jti, payload.exp);
    guard.recordSuccess(who);
    await updateLastSeen(user.id);
    await startSession(
      req,
      res,
      user.id,
      result.method === "recovery" ? AUTH_METHODS.RECOVERY_CODE : AUTH_METHODS.PASSWORD_2FA,
    );

    let recoveryCodesRemaining;
    if (result.method === "recovery" && typeof deps.countUnusedRecoveryCodes === "function") {
      recoveryCodesRemaining = Number(await maybe(deps.countUnusedRecoveryCodes(user.id)));
    }
    return res.json({
      ...userPayload(user),
      ...(result.method === "recovery" ? { usedRecoveryCode: true, recoveryCodesRemaining } : {}),
    });
  });

  app.get("/api/me", async (req, res) => {
    const rawSession = getSessionFromRequest(req);
    const session = rawSession && typeof rawSession.then === "function" ? await rawSession : rawSession;
    if (!session) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    res.json({
      id: session.id,
      username: session.username,
      nickname: session.nickname || null,
      avatarUrl: ensureAvatarExists(session.id, session.avatar_url) || null,
      color: session.color || USER_COLORS[0],
      status: session.status || "online",
      role: session.role || "user",
      verified: Boolean(session.verified),
    });
  });

  app.post("/api/logout", async (req, res) => {
    const cookies = parseCookies(req);

    if (cookies.sid) {
      await deleteSession(cookies.sid);
    }

    clearSessionCookie(req, res);

    res.json({ ok: true });
  });
}

export { registerAuthRoutes };
