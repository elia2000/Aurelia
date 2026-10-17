// Service messages are chat entries the server writes itself ("Bob joined the
// group", "Alice pinned a message"). They are stored as a message whose body is
// `[[system:<action>:<detail>]]` and are not part of the conversation: they
// never count as unread, never show up as a chat's last message, cannot be
// reacted to, forwarded, pinned or edited, and people cannot send them.

import { isValidUuid } from "./uuidUtils.js";

export const SYSTEM_MESSAGE_PREFIX = "[[system:";

const PIN_SERVICE_RE = /^\[\[system:pinned:([0-9a-f-]{36})\]\]$/i;

/** True for a message body that is a service message (or tries to look like one). */
export function isServiceMessageBody(body) {
  return String(body ?? "").trimStart().startsWith(SYSTEM_MESSAGE_PREFIX);
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
