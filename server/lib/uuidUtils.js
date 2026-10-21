import crypto from "node:crypto";

/**
 * UUID Utility Module
 *
 * Provides standardized UUID v4 generation and validation using Node.js native crypto module.
 */

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a new UUID v4 string.
 */
export function generateUuid() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments where randomUUID might be mocked or unavailable
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.randomBytes(1)[0] & (15 >> (c / 4)))).toString(16),
  );
}

// State of generateOrderedUuid: the newest millisecond handed out and how many
// ids that millisecond has already used.
let orderedLastMs = 0;
let orderedSequence = 0;

/**
 * A UUID that sorts after every one this process made before it (version 7
 * layout: 48 bits of milliseconds, a 12 bit counter that keeps ids made within
 * one millisecond in order, then random bits).
 *
 * Messages are stored with a created_at of one-second resolution and a chat
 * sorts messages of the same second by id. With random (v4) ids two messages
 * written within a second came out in random order, and a client asking for
 * "what is newer than my last message" could miss one that sorted before it.
 * Ids that grow with time make the order the one the messages were written in.
 *
 * `now` is the clock in milliseconds (for tests); it never moves backwards.
 */
export function generateOrderedUuid(now = Date.now()) {
  let ms = Math.max(Math.trunc(Number(now)) || 0, orderedLastMs);
  if (ms === orderedLastMs) {
    orderedSequence += 1;
    if (orderedSequence > 0xfff) {
      // 4096 ids in one millisecond: carry on in the next one
      ms += 1;
      orderedSequence = 0;
    }
  } else {
    orderedSequence = 0;
  }
  orderedLastMs = ms;

  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (orderedSequence >> 8);
  bytes[7] = orderedSequence & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Validates if a value is a valid UUID string.
 */
export function isValidUuid(value) {
  if (!value || typeof value !== "string") return false;
  return UUID_REGEX.test(value.trim());
}
