// Building blocks for two-factor sign-in: encrypted TOTP secrets, recovery
// codes and the short-lived challenge that sits between the password and the
// code. No I/O here; the tables are reached through db.js.
//
// Key material. Everything below is keyed from STORAGE_ENCRYPTION_KEY (the
// server secret the app already generates on first start and keeps in .env and
// the database, see lib/secrets.js) through HKDF with a distinct `info` label
// per purpose. So the key that protects stored messages is never used as it is
// for 2FA, and a value signed for one purpose cannot be replayed for another.

import crypto from "node:crypto";
import { normalizeEnvSecret } from "./secrets.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;

const SECRET_PREFIX = "tfa1:";
const HKDF_SALT = Buffer.from("aurelle-two-factor-v1", "utf8");
// No 0/O/1/I/L: codes are read off a sheet of paper and typed by hand.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function rootKey() {
  const raw = normalizeEnvSecret(process.env.STORAGE_ENCRYPTION_KEY);
  if (!raw) {
    // Never fall back to storing a secret in clear text: refuse instead.
    throw new Error("Two-factor authentication needs STORAGE_ENCRYPTION_KEY to be set.");
  }
  return Buffer.from(raw, "utf8");
}

export function isTwoFactorKeyAvailable() {
  return Boolean(normalizeEnvSecret(process.env.STORAGE_ENCRYPTION_KEY));
}

function deriveKey(purpose) {
  return Buffer.from(crypto.hkdfSync("sha256", rootKey(), HKDF_SALT, `aurelle:${purpose}`, 32));
}

// ─── TOTP secret at rest (AES-256-GCM, bound to the owner) ───────────────────

/** Encrypts a TOTP secret. The user id is authenticated data: a row copied to another user will not decrypt. */
export function encryptTotpSecret(secret, userId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey("totp-secret"), iv);
  cipher.setAAD(Buffer.from(String(userId), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/** Returns the secret, or null when the value is not ours, was tampered with, or the key changed. */
export function decryptTotpSecret(stored, userId) {
  try {
    const value = String(stored || "");
    if (!value.startsWith(SECRET_PREFIX)) return null;
    const [ivPart, tagPart, dataPart] = value.slice(SECRET_PREFIX.length).split(".");
    if (!ivPart || !tagPart || !dataPart) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey("totp-secret"),
      Buffer.from(ivPart, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(String(userId), "utf8"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

// ─── Recovery codes ──────────────────────────────────────────────────────────

/** `count` single-use codes shaped XXXXX-XXXXX (about 49 bits each). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = new Set();
  while (codes.size < count) {
    let raw = "";
    for (let i = 0; i < 10; i += 1) {
      raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** Upper-case, separators removed. Returns "" for anything that cannot be a recovery code. */
export function normalizeRecoveryCode(value) {
  const cleaned = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{10}$/.test(cleaned) ? cleaned : "";
}

/**
 * What is stored for a recovery code. A keyed hash (HMAC with a key derived from
 * the server secret), so a copy of the database alone cannot be used to
 * brute-force the codes offline.
 */
export function hashRecoveryCode(code) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return "";
  return crypto
    .createHmac("sha256", deriveKey("recovery-code"))
    .update(normalized)
    .digest("hex");
}

// ─── Login challenge ─────────────────────────────────────────────────────────

const b64 = (buf) => Buffer.from(buf).toString("base64url");

/**
 * A signed, short-lived token that says "this person got the password right
 * and still owes a code". It is not a session: it carries no cookie and every
 * other endpoint ignores it. It is bound to one purpose (`typ`).
 */
export function signLoginChallenge({ userId, authMethod = "password", now = Date.now(), ttlMs = CHALLENGE_TTL_MS }) {
  const payload = {
    typ: "2fa-login",
    uid: String(userId),
    jti: crypto.randomBytes(16).toString("hex"),
    exp: now + ttlMs,
  };
  const body = b64(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", deriveKey("login-challenge")).update(body).digest();
  return { token: `${body}.${b64(mac)}`, jti: payload.jti, exp: payload.exp, authMethod };
}

/** The payload of a genuine, unexpired challenge, or null. */
export function verifyLoginChallenge(token, { now = Date.now() } = {}) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig || String(token).split(".").length !== 2) return null;
    const expected = crypto.createHmac("sha256", deriveKey("login-challenge")).update(body).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload?.typ !== "2fa-login" || !payload.uid || !payload.jti) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Remembers, per challenge, how many wrong codes were tried and whether it was
 * already used. After `maxAttempts` wrong codes the challenge is dead: the
 * person has to enter the password again. In memory on purpose: a challenge
 * lives five minutes, and a restart only gives a new, still limited, start.
 */
export function createChallengeGuard({ maxAttempts = CHALLENGE_MAX_ATTEMPTS, now = () => Date.now() } = {}) {
  const state = new Map(); // jti -> { attempts, used, exp }

  const sweep = () => {
    const at = now();
    for (const [jti, entry] of state) {
      if (entry.exp <= at) state.delete(jti);
    }
  };

  return {
    /** "ok" | "locked" | "used" */
    status(jti) {
      sweep();
      const entry = state.get(jti);
      if (!entry) return "ok";
      if (entry.used) return "used";
      if (entry.attempts >= maxAttempts) return "locked";
      return "ok";
    },
    /** Counts one wrong code. Returns how many are left (0 means locked now). */
    fail(jti, exp) {
      sweep();
      const entry = state.get(jti) || { attempts: 0, used: false, exp };
      entry.attempts += 1;
      state.set(jti, entry);
      return Math.max(0, maxAttempts - entry.attempts);
    },
    /** Burns the challenge: it cannot be used for a second sign-in. */
    consume(jti, exp) {
      sweep();
      const entry = state.get(jti) || { attempts: 0, used: false, exp };
      entry.used = true;
      state.set(jti, entry);
    },
    size: () => state.size,
  };
}
