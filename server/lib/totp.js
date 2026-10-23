// Time-based one-time passwords (RFC 6238) on top of HOTP (RFC 4226).
//
// Implemented with node:crypto only: an HMAC over a counter, dynamically
// truncated. Authenticator apps (Google Authenticator, Aegis, 1Password, ...)
// all speak the SHA-1 / 6 digits / 30 second profile, which is the default here.
//
// Pure functions: no I/O, no clock unless `now` is left out.

import crypto from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
// 160 bits, the size RFC 4226 recommends for the shared secret.
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes RFC 4648 base32. Spaces, dashes, padding and case are ignored. Returns null when invalid. */
export function base32Decode(input) {
  const clean = String(input ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/=+$/, "");
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random shared secret, base32 encoded (32 characters for 160 bits). */
export function generateTotpSecret(bytes = TOTP_SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

function toKeyBuffer(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  return base32Decode(secret);
}

/** HOTP (RFC 4226): `counter` is a non-negative integer. */
export function hotp(secret, counter, { digits = TOTP_DIGITS, algorithm = "sha1" } = {}) {
  const key = toKeyBuffer(secret);
  if (!key || !key.length) throw new Error("Invalid TOTP secret.");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The time step (counter) a moment in time falls into. */
export function totpStep(timeMs = Date.now(), period = TOTP_PERIOD_SECONDS) {
  return Math.floor(timeMs / 1000 / period);
}

/** The code valid at `timeMs`. */
export function totp(secret, timeMs = Date.now(), options = {}) {
  const period = options.period || TOTP_PERIOD_SECONDS;
  return hotp(secret, totpStep(timeMs, period), options);
}

/** A code as people type it: digits only, no spaces. Returns "" when it cannot be a code. */
export function normalizeTotpCode(value, digits = TOTP_DIGITS) {
  const cleaned = String(value ?? "").replace(/[\s-]+/g, "");
  return new RegExp(`^\\d{${digits}}$`).test(cleaned) ? cleaned : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Checks a code against the steps `now - window ... now + window`.
 *
 * `lastUsedStep` is the step of the last code that was accepted for this
 * secret: a code is only accepted for a LATER step, so a code (or one that is
 * still inside the window) can never be used twice (RFC 6238 section 5.2).
 *
 * Every candidate step is compared, with no early exit, so the time taken does
 * not depend on which step matched.
 *
 * Returns { ok: true, step } or { ok: false, reason: "format" | "mismatch" | "replay" }.
 */
export function verifyTotp(
  secret,
  code,
  { now = Date.now(), window = 1, lastUsedStep = null, period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {},
) {
  const normalized = normalizeTotpCode(code, digits);
  if (!normalized) return { ok: false, reason: "format" };
  const current = totpStep(now, period);
  let matchedStep = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const candidate = hotp(secret, step, { digits });
    if (safeEqual(candidate, normalized) && matchedStep === null) matchedStep = step;
  }
  if (matchedStep === null) return { ok: false, reason: "mismatch" };
  if (lastUsedStep !== null && lastUsedStep !== undefined && matchedStep <= Number(lastUsedStep)) {
    return { ok: false, reason: "replay" };
  }
  return { ok: true, step: matchedStep };
}

/** The otpauth:// URI that authenticator apps import (Key URI Format). */
export function buildOtpauthUri({ secret, account, issuer }) {
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    : encodeURIComponent(account);
  const params = new URLSearchParams({ secret });
  if (issuer) params.set("issuer", issuer);
  params.set("algorithm", "SHA1");
  params.set("digits", String(TOTP_DIGITS));
  params.set("period", String(TOTP_PERIOD_SECONDS));
  return `otpauth://totp/${label}?${params.toString()}`;
}
