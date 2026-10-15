import crypto from "node:crypto";

// Public keys are exchanged as base64url of the raw uncompressed P-256 point
// (0x04 || X || Y, 65 bytes) — the format WebCrypto's `exportKey("raw")`
// produces and that native platforms can emit without extra encoding code.

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function isBase64Url(value, { minBytes = 1, maxBytes = Infinity } = {}) {
  if (typeof value !== "string" || !value || !B64URL_RE.test(value)) return false;
  // base64url without padding: 4 chars carry 3 bytes.
  if (value.length % 4 === 1) return false;
  const bytes = Math.floor((value.length * 3) / 4);
  return bytes >= minBytes && bytes <= maxBytes;
}

export function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

/**
 * Returns true only for a well-formed, on-curve uncompressed P-256 public key.
 * Off-curve points are rejected so a malicious client cannot register a key
 * that enables invalid-curve attacks against peers deriving ECDH secrets.
 */
export function isValidP256PublicKey(value) {
  if (!isBase64Url(value, { minBytes: 65, maxBytes: 65 })) return false;
  const raw = decodeBase64Url(value);
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  try {
    crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

export function sanitizeDeviceLabel(label) {
  const text = String(label ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 60) : null;
}
