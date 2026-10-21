// Pinned messages: who may pin, how the server's list is read, what the bar
// under the chat header shows and in which order it cycles, and how the
// "X pinned a message" line is recognised. Everything here is pure; the pins
// of each chat live in utils/pinStore.js.
//
// The server lists pins newest first (index 0 is the newest pin). The bar
// numbers them the other way round, like Telegram: with three pins the newest
// is "#3", and a click on the bar shows the next older one ("#2", "#1") before
// it comes back to the newest.

import { isCallMessage } from "./callEntry.js";
import { isServiceMessage } from "./messageKind.js";
import { normalizeUuid } from "./uuidUtils.js";

export const DEFAULT_MAX_PINNED_MESSAGES = 20;
const MIN_MAX_PINNED_MESSAGES = 1;
const MAX_MAX_PINNED_MESSAGES = 100;

/** The most segments the bar draws on its left edge. */
export const MAX_BAR_SEGMENTS = 4;

export function clampMaxPinnedMessages(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_MAX_PINNED_MESSAGES) return DEFAULT_MAX_PINNED_MESSAGES;
  return Math.min(MAX_MAX_PINNED_MESSAGES, Math.trunc(n));
}

// --- who may pin ---

const PIN_ROLES = new Set(["owner", "admin"]);

/**
 * The same rule as the server's: a direct chat and Saved Messages, either
 * person; a group, its owner (or everybody when the owner allowed members to
 * pin); a channel, only its owner. The server has the last word (403), this
 * only decides whether the menu offers the item.
 */
export function canManagePins({ chatType, role, allowMemberPins } = {}) {
  const type = String(chatType || "").toLowerCase();
  const isOwner = PIN_ROLES.has(String(role || "").toLowerCase());
  if (type === "dm" || type === "saved") return true;
  if (type === "group") return isOwner || Number(allowMemberPins || 0) === 1 || allowMemberPins === true;
  if (type === "channel") return isOwner;
  return false;
}

/** The person's role in a chat, from its member list ("" when not a member). */
export function getMemberRole(members, userId) {
  if (!Array.isArray(members) || !userId) return "";
  const me = members.find((member) => String(member?.id || "") === String(userId));
  return String(me?.role || "").toLowerCase();
}

/** Can this message be pinned at all? A sent, ordinary message can. */
export function isPinnableMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.service || isServiceMessage(msg) || isCallMessage(msg)) return false;
  if (msg._delivery === "sending" || msg._delivery === "failed") return false;
  if (msg._processingPending) return false;
  return Boolean(normalizeUuid(msg._serverId || msg.id));
}

// --- the server's list ---

const FILE_KINDS = new Set(["image", "video", "audio", "document", "video_note"]);

const toText = (value, max = 300) => String(value ?? "").slice(0, max);

/** One entry of GET /api/chats/:id/pins, made safe to draw; null when unusable. */
export function normalizePin(raw) {
  const messageId = normalizeUuid(raw?.messageId || raw?.message?.id);
  if (!messageId) return null;
  const message = raw?.message && typeof raw.message === "object" ? raw.message : {};
  const fileKind = FILE_KINDS.has(message.fileKind) ? message.fileKind : null;
  return {
    messageId,
    pinnedBy: normalizeUuid(raw?.pinnedBy) || null,
    pinnedAt: typeof raw?.pinnedAt === "string" ? raw.pinnedAt : null,
    message: {
      id: messageId,
      senderId: normalizeUuid(message.senderId) || null,
      senderName: toText(message.senderName, 80),
      type: message.type === "text" ? "text" : fileKind || "text",
      text: toText(message.text, 200),
      hasFile: Boolean(message.hasFile) || Boolean(fileKind),
      fileKind,
      createdAt: typeof message.createdAt === "string" ? message.createdAt : null,
    },
  };
}

const timeOf = (pin) => {
  const t = Date.parse(pin?.pinnedAt || "");
  return Number.isFinite(t) ? t : 0;
};

/**
 * The server's `pins` list, newest first, each message once. The server
 * already sorts it; sorting again keeps the bar right when two lists are
 * merged by hand (the order of equal times is kept).
 */
export function normalizePinList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const list = [];
  raw.forEach((entry) => {
    const pin = normalizePin(entry);
    if (!pin || seen.has(pin.messageId)) return;
    seen.add(pin.messageId);
    list.push(pin);
  });
  return list
    .map((pin, order) => ({ pin, order }))
    .sort((a, b) => timeOf(b.pin) - timeOf(a.pin) || a.order - b.order)
    .map((entry) => entry.pin);
}

export function hasPin(pins, messageId) {
  const id = normalizeUuid(messageId);
  return Boolean(id) && Array.isArray(pins) && pins.some((pin) => pin.messageId === id);
}

/** The list without one message (the same array when it was not there). */
export function removePin(pins, messageId) {
  const id = normalizeUuid(messageId);
  if (!id || !hasPin(pins, id)) return pins;
  return pins.filter((pin) => pin.messageId !== id);
}

/** Two lists show the same bar (same messages, same previews)? */
export function samePins(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((pin, i) => {
    const other = b[i];
    return (
      pin.messageId === other.messageId &&
      pin.pinnedAt === other.pinnedAt &&
      pin.message.text === other.message.text &&
      pin.message.senderName === other.message.senderName &&
      pin.message.fileKind === other.message.fileKind
    );
  });
}

// --- the bar ---

const FILE_LABELS = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  document: "File",
  video_note: "Video message",
};

/** What one pin shows on the second line of the bar. */
export function pinPreview(pin) {
  const message = pin?.message || {};
  const label = message.fileKind
    ? FILE_LABELS[message.fileKind]
    : message.hasFile
      ? "Attachment"
      : "";
  const text = String(message.text || "").trim();
  return {
    sender: String(message.senderName || "").trim(),
    text: text || label || "Message",
    label,
    hasText: Boolean(text),
  };
}

export function clampBarIndex(index, count) {
  if (!(count > 0)) return 0;
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(Math.max(n, 0), count - 1);
}

/** "#3" for the newest of three pins; counted from the oldest. */
export function pinOrdinal(index, count) {
  return count - clampBarIndex(index, count);
}

export function pinBarTitle(index, count) {
  return count > 1 ? `Pinned message #${pinOrdinal(index, count)}` : "Pinned message";
}

/** After a click the bar shows the next older pin, and wraps to the newest. */
export function nextBarIndex(index, count) {
  if (!(count > 1)) return 0;
  return (clampBarIndex(index, count) + 1) % count;
}

/**
 * Which pin the bar shows after the list changed. A pin that arrived brings
 * the bar to it (the newest); otherwise the bar stays on the message it was
 * showing, and when that one is gone it stays on the same place in the list.
 */
export function barIndexAfterChange({ previous, next, index }) {
  if (!next.length) return 0;
  const before = Array.isArray(previous) ? previous : [];
  const current = before[clampBarIndex(index, before.length)];
  const hadNewcomer = next.some((pin) => !hasPin(before, pin.messageId));
  if (hadNewcomer && before.length) return 0;
  if (current) {
    const at = next.findIndex((pin) => pin.messageId === current.messageId);
    if (at >= 0) return at;
  }
  return clampBarIndex(index, next.length);
}

/**
 * The segments on the bar's left edge, top to bottom (the oldest pin on top).
 * With more pins than fit, a window of MAX_BAR_SEGMENTS slides along.
 */
export function barSegments({ index, count, maxVisible = MAX_BAR_SEGMENTS }) {
  if (!(count > 1)) return [];
  const visible = Math.min(count, Math.max(2, maxVisible));
  const active = count - 1 - clampBarIndex(index, count); // 0 = oldest
  const start = Math.min(Math.max(active - Math.floor(visible / 2), 0), count - visible);
  return Array.from({ length: visible }, (_, i) => ({ active: start + i === active }));
}

// --- the line in the chat ("X pinned a message") ---

const PIN_BODY = /^\[\[system:pinned:([0-9a-f-]{36})\]\]$/i;

/**
 * The pin service line of a message (REST row or realtime event):
 * { messageId, actorId } of the pinned message, or null for any other message.
 */
export function parsePinService(msg) {
  if (!msg || typeof msg !== "object") return null;
  const service = msg.service;
  if (service && typeof service === "object" && service.action === "pin") {
    const messageId = normalizeUuid(service.messageId);
    if (messageId) return { messageId, actorId: normalizeUuid(service.actorId) || null };
  }
  const match = PIN_BODY.exec(String(msg.body ?? "").trim());
  const messageId = match ? normalizeUuid(match[1]) : null;
  return messageId
    ? { messageId, actorId: normalizeUuid(msg.user_id || msg.userId) || null }
    : null;
}

export const isPinServiceMessage = (msg) => parsePinService(msg) !== null;

/**
 * The centered chip for a pin line: who did it (the name, or "You") and the
 * message a click goes to.
 */
export function buildPinSystemEvent(msg, { isOwn = false } = {}) {
  const service = parsePinService(msg);
  if (!service) return null;
  const name = isOwn
    ? "You"
    : String(msg?.nickname || msg?.username || "").trim() || "A member";
  const suffix = "pinned a message";
  return {
    type: "pin",
    name,
    suffix,
    text: `${name} ${suffix}`,
    jumpToMessageId: service.messageId,
  };
}

// --- notices ---

export function pinLimitText(max) {
  const n = Number(max);
  if (!Number.isFinite(n) || n < 1) return "You can't pin more messages. Unpin one first.";
  return `You can pin up to ${Math.trunc(n)} ${n === 1 ? "message" : "messages"} in a chat`;
}

/** The notice for a refused pin / unpin. `body` is the server's JSON. */
export function describePinError({ status, body, fallbackMax = null } = {}) {
  if (body?.code === "pin_limit") return pinLimitText(parseLimit(body?.error) ?? fallbackMax);
  if (status === 403) return "You can't pin messages in this chat.";
  if (status === 404) return "That message is no longer available.";
  if (status === 429) return "Too many pin changes. Try again in a minute.";
  return "Couldn't update the pinned messages.";
}

// The server's 409 text reads "A chat can have at most N pinned messages...".
function parseLimit(text) {
  const match = /at most (\d+)/i.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}
