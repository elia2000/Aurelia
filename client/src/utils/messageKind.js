import { isCallMessage } from "./callEntry.js";
import { normalizeUuid } from "./uuidUtils.js";

// Message types this client draws itself. The server sends messageType "call"
// for a call history entry and "text" for everything else.
const KNOWN_MESSAGE_TYPES = new Set(["text", "call"]);

/**
 * A message of a type this client does not know (a newer server) that also has
 * nothing the client could show: no text and no files. It is drawn as a small
 * "not supported" line instead of an empty bubble. A message of an unknown
 * type that does carry text or files is drawn like any other message.
 */
export function isUnsupportedMessage(msg) {
  if (!msg || typeof msg !== "object" || msg._systemEvent) return false;
  if (isCallMessage(msg)) return false;
  const type = typeof msg.messageType === "string" ? msg.messageType.trim() : "";
  if (!type || KNOWN_MESSAGE_TYPES.has(type)) return false;
  const body = typeof msg.body === "string" ? msg.body.trim() : "";
  const files = Array.isArray(msg.files) ? msg.files : [];
  return !body && files.length === 0;
}

/** The id the server knows a message by, or null while it only exists on this device. */
export function getServerMessageId(msg) {
  if (!msg || typeof msg !== "object") return null;
  return normalizeUuid(msg._serverId) || normalizeUuid(msg.id) || null;
}

/** "X joined the group" and the like: lines the chat adds, not things a person wrote. */
export const isServiceMessage = (msg) =>
  Boolean(msg?._systemEvent) || /^\[\[system:/i.test(String(msg?.body ?? ""));
