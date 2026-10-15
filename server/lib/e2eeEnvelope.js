import { isBase64Url, isValidP256PublicKey } from "./e2eeKeys.js";
import { isValidUuid } from "./uuidUtils.js";

// Structural validation for end-to-end encrypted message envelopes.
//
// The server cannot (and must not) look inside: it only rejects malformed or
// oversized envelopes so a client cannot use the field as free-form storage,
// and it makes sure the sender is one of the caller's own active devices.

export const E2EE_ENVELOPE_VERSION = 2;
export const E2EE_VIDEO_NOTE_KIND = "video_note";
export const E2EE_ENVELOPE_MAX_BYTES = 48 * 1024;
export const E2EE_ENVELOPE_MAX_RECIPIENT_KEYS = 128;
export const E2EE_VIDEO_NOTE_MAX_DURATION_MS = 61 * 1000;
export const E2EE_POSTER_MAX_BYTES = 12 * 1024;

const ALLOWED_INNER_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

function fail(message) {
  return { ok: false, error: message };
}

/**
 * @param {unknown} input JSON string or object
 * @returns {{ok: true, envelope: object, json: string} | {ok: false, error: string}}
 */
export function parseVideoNoteEnvelope(input) {
  let envelope = input;
  if (typeof input === "string") {
    if (input.length > E2EE_ENVELOPE_MAX_BYTES) {
      return fail("Encrypted envelope is too large.");
    }
    try {
      envelope = JSON.parse(input);
    } catch {
      return fail("Encrypted envelope is not valid JSON.");
    }
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return fail("Encrypted envelope must be an object.");
  }
  if (envelope.v !== E2EE_ENVELOPE_VERSION) {
    return fail("Unsupported encrypted envelope version.");
  }
  if (envelope.kind !== E2EE_VIDEO_NOTE_KIND) {
    return fail("Unsupported encrypted message kind.");
  }
  if (!isValidUuid(String(envelope.senderDeviceId || ""))) {
    return fail("Invalid sender device.");
  }
  if (!isBase64Url(envelope.iv, { minBytes: 12, maxBytes: 12 })) {
    return fail("Invalid media IV.");
  }
  const durationMs = Number(envelope.durationMs);
  if (
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > E2EE_VIDEO_NOTE_MAX_DURATION_MS
  ) {
    return fail("Invalid video message duration.");
  }
  if (!ALLOWED_INNER_MIME.has(String(envelope.mime || "").toLowerCase())) {
    return fail("Unsupported video container.");
  }
  if (!isBase64Url(envelope.sig, { minBytes: 64, maxBytes: 64 })) {
    return fail("Invalid envelope signature.");
  }

  if (envelope.poster != null) {
    const { iv, ct } = envelope.poster || {};
    if (
      !isBase64Url(iv, { minBytes: 12, maxBytes: 12 }) ||
      !isBase64Url(ct, { minBytes: 17, maxBytes: E2EE_POSTER_MAX_BYTES })
    ) {
      return fail("Invalid encrypted poster.");
    }
  }

  const keys = envelope.keys;
  if (
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > E2EE_ENVELOPE_MAX_RECIPIENT_KEYS
  ) {
    return fail("Invalid recipient key list.");
  }
  const seen = new Set();
  for (const entry of keys) {
    if (!entry || typeof entry !== "object") return fail("Invalid recipient key.");
    if (!isValidUuid(String(entry.deviceId || ""))) {
      return fail("Invalid recipient device.");
    }
    if (seen.has(entry.deviceId)) return fail("Duplicate recipient device.");
    seen.add(entry.deviceId);
    if (
      // Reject off-curve points here as well: the recipient's static key is
      // used with this value, so an invalid-curve point must never be relayed.
      !isValidP256PublicKey(entry.epk) ||
      !isBase64Url(entry.iv, { minBytes: 12, maxBytes: 12 }) ||
      // 32-byte content key + 16-byte GCM tag
      !isBase64Url(entry.ct, { minBytes: 48, maxBytes: 48 })
    ) {
      return fail("Invalid recipient key material.");
    }
  }

  // Re-serialise only the known fields so unknown attacker-controlled keys
  // are never persisted or relayed to other clients.
  const clean = {
    v: envelope.v,
    kind: envelope.kind,
    senderDeviceId: envelope.senderDeviceId,
    iv: envelope.iv,
    durationMs: Math.round(durationMs),
    mime: String(envelope.mime).toLowerCase(),
    ...(envelope.poster
      ? { poster: { iv: envelope.poster.iv, ct: envelope.poster.ct } }
      : {}),
    keys: keys.map((entry) => ({
      deviceId: entry.deviceId,
      epk: entry.epk,
      iv: entry.iv,
      ct: entry.ct,
    })),
    sig: envelope.sig,
  };
  const json = JSON.stringify(clean);
  if (json.length > E2EE_ENVELOPE_MAX_BYTES) {
    return fail("Encrypted envelope is too large.");
  }
  return { ok: true, envelope: clean, json };
}

export function safeParseStoredEnvelope(json) {
  if (!json || typeof json !== "string") return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
