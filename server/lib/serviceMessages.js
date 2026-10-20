// Service messages are chat entries the server writes itself ("Bob joined the
// group", "Alice pinned a message"). They are stored as a message whose body is
// `[[system:<action>:<detail>]]` and are not part of the conversation: they
// never count as unread, never show up as a chat's last message, cannot be
// reacted to, forwarded, pinned or edited, and people cannot send them.

import { isValidUuid } from "./uuidUtils.js";

export const SYSTEM_MESSAGE_PREFIX = "[[system:";

// Exactly what buildPinServiceBody() writes. Only the id may vary in case.
const PIN_SERVICE_RE = /^\[\[system:pinned:([0-9a-fA-F-]{36})\]\]$/;

// The server writes the marker in lower case, but anything that merely looks
// like it must be refused: SQLite's LIKE (the unread, last-message and
// first-unread filters) ignores case, and a reader may not tell the difference
// either.
const SERVICE_LOOKALIKE_RE = /^\s*\[\[\s*system:/i;

/** True for a message body that is a service message (or tries to look like one). */
export function isServiceMessageBody(body) {
  return SERVICE_LOOKALIKE_RE.test(String(body ?? ""));
}

/** The body of the "X pinned a message" entry for the pinned message `messageId`. */
export function buildPinServiceBody(messageId) {
  return `${SYSTEM_MESSAGE_PREFIX}pinned:${messageId}]]`;
}

/**
 * The structured form of a "pinned a message" entry, or null for anything
 * else: `{ action: "pin", messageId, actorId }`. `actorId` is whoever wrote the
 * service message, i.e. whoever pinned.
 */
export function parsePinServiceBody(body, actorId = null) {
  const match = PIN_SERVICE_RE.exec(String(body ?? ""));
  if (!match || !isValidUuid(match[1])) return null;
  return { action: "pin", messageId: match[1].toLowerCase(), actorId: actorId ?? null };
}
