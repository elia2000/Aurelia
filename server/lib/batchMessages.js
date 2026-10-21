// Pure helpers for the multi-select requests (forward / delete many messages at
// once). No I/O, so every rule here is unit tested without a database.

import { generateOrderedUuid, isValidUuid } from "./uuidUtils.js";

/** The most messages one multi-select request may name. */
export const BATCH_MESSAGE_LIMIT = 100;

/** The most chats one forward request may send to. */
export const FORWARD_MAX_TARGET_CHATS = 20;

/**
 * The most messages one forward request may create (messages x chats). It is
 * also what a person may create in a minute (FORWARD_MESSAGES_PER_MINUTE).
 */
export const FORWARD_MAX_CREATED_MESSAGES = 500;

/**
 * How many forwarded messages one person may create in a minute (a request is
 * charged for the messages it creates, see the route). It is one largest
 * request a minute: a forward is a burst of messages every member of the
 * target chats receives, and an ordinary send is limited to a few dozen a
 * minute, so this bounds how fast one account can fill a chat.
 */
export const FORWARD_MESSAGES_PER_MINUTE = FORWARD_MAX_CREATED_MESSAGES;

/**
 * Reads a list of message ids from a request: an array of 1 to `max` UUID
 * strings. Surrounding spaces are ignored and an id named twice counts once
 * (first position wins). The size limit applies to what was sent, so a request
 * cannot make the server walk a huge list just because it repeats one id.
 *
 * Returns `{ ok: true, ids }` or `{ ok: false, error }`.
 */
export function parseMessageIdList(value, field, max = BATCH_MESSAGE_LIMIT) {
  if (!Array.isArray(value)) {
    return { ok: false, error: `Field '${field}' must be an array of message ids.` };
  }
  if (value.length < 1) {
    return { ok: false, error: `Field '${field}' must name at least one message.` };
  }
  if (value.length > max) {
    return { ok: false, error: `Field '${field}' can name at most ${max} messages.` };
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || !isValidUuid(entry)) {
      return { ok: false, error: `Field '${field}' contains an invalid UUID.` };
    }
    const id = entry.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

/**
 * Milliseconds since the epoch of a stored `created_at`: the space separated
 * UTC text the server writes ("2025-01-01 10:00:00"), an ISO string or a Date.
 * Anything else sorts last.
 */
export function createdAtMs(value) {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  }
  const text = String(value ?? "").trim();
  if (!text) return Number.MAX_SAFE_INTEGER;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

/**
 * Oldest first, the way a chat shows its messages: by creation time, then by id
 * (the database orders equal times by id too).
 */
export function compareChronologically(a, b) {
  const byTime = createdAtMs(a?.created_at) - createdAtMs(b?.created_at);
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  const left = String(a?.id ?? "");
  const right = String(b?.id ?? "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A sorted copy of message rows, oldest first. */
export function sortChronologically(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort(compareChronologically);
}

/**
 * `count` fresh ids in ascending order. Messages written in the same second
 * share a `created_at`, and a chat orders those by id: giving the messages of
 * one batch ascending ids, in the order they are written, keeps them in that
 * order for everybody.
 */
export function allocateAscendingIds(count, generate = generateOrderedUuid) {
  const ids = Array.from({ length: Math.max(0, Math.trunc(Number(count)) || 0) }, () => generate());
  return ids.sort();
}

/**
 * The HTTP status for a request whose items all failed: the one they share, or
 * 400 when they differ.
 */
export function commonFailureStatus(statuses, fallback = 400) {
  const unique = new Set((Array.isArray(statuses) ? statuses : []).filter(Number.isInteger));
  return unique.size === 1 ? [...unique][0] : fallback;
}
