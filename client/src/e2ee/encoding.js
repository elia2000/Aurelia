// Byte/text helpers shared by the E2EE and call modules. Everything that
// crosses the wire is base64url without padding (the format the server
// validates), and everything that is signed is built with `encodeFields`.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const utf8 = (text) => textEncoder.encode(String(text));
export const fromUtf8 = (bytes) => textDecoder.decode(bytes);

export function toB64u(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromB64u(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error("Invalid base64url value.");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

const uint32 = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
};

/**
 * Unambiguous serialisation for signing / AAD: a domain label followed by
 * length-prefixed fields. Two different field lists can never produce the same
 * bytes, so a signature over one cannot be replayed as a signature over
 * another message type or a re-split of the same strings.
 * Fields may be strings or Uint8Arrays.
 */
export function encodeFields(domain, fields = []) {
  const parts = [];
  const push = (value) => {
    const bytes = value instanceof Uint8Array ? value : utf8(value);
    parts.push(uint32(bytes.length), bytes);
  };
  push(domain);
  parts.push(uint32(fields.length));
  fields.forEach(push);
  return concatBytes(...parts);
}

export function randomBytes(length) {
  const out = new Uint8Array(length);
  // getRandomValues refuses requests above 65,536 bytes.
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(length, offset + 65536)));
  }
  return out;
}

export function randomUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
