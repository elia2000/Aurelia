// Checks a second factor (authenticator code or recovery code) for a user and
// keeps the bookkeeping that makes the check safe: replay protection, single
// use recovery codes and a per-user limit on wrong codes across challenges.

import { createThrottle } from "./throttle.js";
import { verifyTotp } from "./totp.js";
import { decryptTotpSecret, hashRecoveryCode, normalizeRecoveryCode } from "./twoFactor.js";

const maybe = async (value) => (value && typeof value.then === "function" ? await value : value);

export const SECOND_FACTOR_FAILURE_LIMIT = 10; // wrong codes per user per window
export const SECOND_FACTOR_WINDOW_MS = 15 * 60 * 1000;

export function createTwoFactorService({
  getUserTwoFactor,
  markTotpStepUsed,
  consumeRecoveryCode,
  now = () => Date.now(),
  failureLimit = SECOND_FACTOR_FAILURE_LIMIT,
}) {
  const failures = createThrottle({ windowMs: SECOND_FACTOR_WINDOW_MS, max: failureLimit, now });

  return {
    async status(userId) {
      const row = await maybe(getUserTwoFactor(userId));
      return { enabled: Boolean(row?.enabled), pending: Boolean(row && !row.enabled), row };
    },

    /** True when this user has had too many wrong codes lately (across all challenges and endpoints). */
    isBlocked(userId) {
      return failures.remaining(String(userId)) <= 0;
    },

    recordFailure(userId) {
      failures.take(String(userId));
    },

    /**
     * Verifies a TOTP `code` or a `recoveryCode` for a user who has 2FA ON.
     * Resolves to { ok: true, method } or { ok: false, reason }.
     * A TOTP step, once accepted, can not be accepted again; a recovery code
     * works exactly once.
     */
    async verify(userId, { code, recoveryCode } = {}) {
      const row = await maybe(getUserTwoFactor(userId));
      if (!row?.enabled) return { ok: false, reason: "not_enabled" };

      if (recoveryCode !== undefined && recoveryCode !== null && String(recoveryCode).trim() !== "") {
        if (!normalizeRecoveryCode(recoveryCode)) return { ok: false, reason: "format" };
        const spent = await maybe(consumeRecoveryCode(userId, hashRecoveryCode(recoveryCode)));
        return spent ? { ok: true, method: "recovery" } : { ok: false, reason: "mismatch" };
      }

      const secret = decryptTotpSecret(row.secret_enc, userId);
      if (!secret) return { ok: false, reason: "secret_unreadable" };
      const result = verifyTotp(secret, code, { now: now(), lastUsedStep: row.last_used_step });
      if (!result.ok) return { ok: false, reason: result.reason };
      const claimed = await maybe(markTotpStepUsed(userId, result.step));
      return claimed ? { ok: true, method: "totp", step: result.step } : { ok: false, reason: "replay" };
    },

    /**
     * For routes that re-authenticate with the password and, when the account
     * has 2FA, a code too. Resolves to null when the request may continue or
     * to { status, body } to send back.
     */
    async requireSecondFactor(user, body = {}) {
      const row = await maybe(getUserTwoFactor(user.id));
      if (!row?.enabled) return null;
      const hasCode = String(body.code ?? "").trim() !== "" || String(body.recoveryCode ?? "").trim() !== "";
      if (!hasCode) {
        return {
          status: 401,
          body: { error: "Enter your authentication code.", twoFactorRequired: true },
        };
      }
      if (this.isBlocked(user.id)) {
        return { status: 429, body: { error: "Too many attempts. Try again later." } };
      }
      const result = await this.verify(user.id, { code: body.code, recoveryCode: body.recoveryCode });
      if (result.ok) return null;
      this.recordFailure(user.id);
      return { status: 401, body: { error: "Invalid code.", twoFactorRequired: true } };
    },
  };
}

/** One service per `deps`, so the wrong-code limit is shared by every route that checks a code. */
export function twoFactorServiceFor(deps) {
  if (!deps.twoFactorService) {
    deps.twoFactorService = createTwoFactorService({
      getUserTwoFactor: deps.getUserTwoFactor,
      markTotpStepUsed: deps.markTotpStepUsed,
      consumeRecoveryCode: deps.consumeRecoveryCode,
    });
  }
  return deps.twoFactorService;
}
