// Masks credentials before a request or response is written to a log.
// APP_DEBUG logs request bodies and JSON responses; a password, a 2FA code,
// a recovery code or a sign-in challenge must never end up there.

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|challenge|recovery|otpauth|^code$|^totp|authorization|cookie|api[-_]?key|private/i;

export const REDACTED = "[redacted]";

export function redactSensitive(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return "[binary]";
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(inner, depth + 1);
  }
  return out;
}
