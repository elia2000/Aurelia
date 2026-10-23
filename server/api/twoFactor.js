import {
  generateTotpSecret,
  buildOtpauthUri,
  verifyTotp,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "../lib/totp.js";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  isTwoFactorKeyAvailable,
} from "../lib/twoFactor.js";
import { toIsoTimestamp } from "../lib/accountSessions.js";
import { loginGuardFor, sendTooManyAttempts } from "../lib/loginGuard.js";
import { twoFactorServiceFor } from "../lib/twoFactorService.js";

// Shown by the authenticator app next to the account name.
const ISSUER = "Aurelle";

const maybe = async (value) => (value && typeof value.then === "function" ? await value : value);

/**
 * Optional TOTP two-factor sign-in (RFC 6238).
 *
 *   GET  /api/2fa                   status
 *   POST /api/2fa/setup             {password}         new secret (not active yet)
 *   POST /api/2fa/enable            {code}             confirm with one code, returns recovery codes ONCE
 *   POST /api/2fa/recovery-codes    {password, code|recoveryCode}  a new set (old codes die)
 *   POST /api/2fa/disable           {password, code|recoveryCode}
 *
 * Every state change asks for the current password again (and a code once 2FA is on),
 * so a stolen session cookie alone cannot turn 2FA on, off or reroll the recovery codes.
 */
function registerTwoFactorRoutes(app, deps) {
  const {
    requireSession,
    bcrypt,
    findUserById,
    getUserTwoFactor,
    beginTwoFactorEnrollment,
    enableTwoFactor,
    replaceRecoveryCodes,
    disableTwoFactor,
    countUnusedRecoveryCodes,
  } = deps;

  const guard = loginGuardFor(deps);
  const twoFactor = twoFactorServiceFor(deps);

  const caller = async (req, res) => {
    const session = await requireSession(req, res);
    if (!session) return null;
    const user = await maybe(findUserById(session.id));
    if (!user) {
      res.status(401).json({ error: "Not authenticated." });
      return null;
    }
    return user;
  };

  // Password re-check shared by the routes that change 2FA. Wrong passwords
  // count against the same limits as sign-in.
  const checkPassword = async (req, res, user) => {
    const who = { ip: req.ip, account: String(user.username || "").toLowerCase() };
    if (!guard.check(who).allowed) {
      sendTooManyAttempts(res, guard);
      return false;
    }
    const password = req.body?.password;
    const ok =
      typeof password === "string" &&
      password !== "" &&
      Boolean(user.password_hash) &&
      (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      guard.recordFailure(who);
      res.status(401).json({ error: "Invalid credentials." });
      return false;
    }
    guard.recordSuccess(who);
    return true;
  };

  app.get("/api/2fa", async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const state = await twoFactor.status(user.id);
    res.json({
      available: isTwoFactorKeyAvailable(),
      enabled: state.enabled,
      enabledAt: state.enabled ? toIsoTimestamp(state.row?.enabled_at) : null,
      recoveryCodesRemaining: state.enabled
        ? Number(await maybe(countUnusedRecoveryCodes(user.id)))
        : 0,
    });
  });

  app.post("/api/2fa/setup", async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    if (!isTwoFactorKeyAvailable()) {
      return res.status(503).json({ error: "Two-factor authentication is not available on this server." });
    }
    const state = await twoFactor.status(user.id);
    if (state.enabled) {
      return res.status(409).json({ error: "Two-factor authentication is already on." });
    }
    if (!(await checkPassword(req, res, user))) return;

    const secret = generateTotpSecret();
    await maybe(beginTwoFactorEnrollment(user.id, encryptTotpSecret(secret, user.id)));
    const issuer = ISSUER;
    return res.json({
      secret,
      otpauthUri: buildOtpauthUri({ secret, account: user.username, issuer }),
      issuer,
      account: user.username,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    });
  });

  app.post("/api/2fa/enable", async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const state = await twoFactor.status(user.id);
    if (state.enabled) {
      return res.status(409).json({ error: "Two-factor authentication is already on." });
    }
    if (!state.pending) {
      return res.status(400).json({ error: "Start the setup first." });
    }
    if (twoFactor.isBlocked(user.id)) return sendTooManyAttempts(res, guard);

    const secret = decryptTotpSecret(state.row.secret_enc, user.id);
    if (!secret) return res.status(400).json({ error: "Start the setup again." });
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    const result = verifyTotp(secret, code);
    if (!result.ok) {
      twoFactor.recordFailure(user.id);
      return res.status(400).json({ error: "That code is not right. Check the time on your phone and try again." });
    }

    const codes = generateRecoveryCodes();
    const switched = await maybe(enableTwoFactor(user.id, result.step, codes.map(hashRecoveryCode)));
    if (!switched) return res.status(409).json({ error: "Two-factor authentication is already on." });
    return res.json({ ok: true, enabled: true, recoveryCodes: codes });
  });

  app.post("/api/2fa/recovery-codes", async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const state = await twoFactor.status(user.id);
    if (!state.enabled) return res.status(400).json({ error: "Two-factor authentication is not on." });
    if (!(await checkPassword(req, res, user))) return;
    const blocked = await twoFactor.requireSecondFactor(user, req.body || {});
    if (blocked) return res.status(blocked.status).json(blocked.body);

    const codes = generateRecoveryCodes();
    await maybe(replaceRecoveryCodes(user.id, codes.map(hashRecoveryCode)));
    return res.json({ ok: true, recoveryCodes: codes });
  });

  app.post("/api/2fa/disable", async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const state = await twoFactor.status(user.id);
    if (!state.enabled && !state.pending) {
      return res.status(400).json({ error: "Two-factor authentication is not on." });
    }
    if (!(await checkPassword(req, res, user))) return;
    if (state.enabled) {
      const blocked = await twoFactor.requireSecondFactor(user, req.body || {});
      if (blocked) return res.status(blocked.status).json(blocked.body);
    }
    await maybe(disableTwoFactor(user.id));
    return res.json({ ok: true, enabled: false });
  });
}

export { registerTwoFactorRoutes };
