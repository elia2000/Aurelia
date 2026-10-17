// Pure helpers for pinned messages. No I/O, so every rule here is unit tested
// without a database.

export const MAX_PINNED_MIN = 1;
export const MAX_PINNED_MAX = 100;
export const MAX_PINNED_DEFAULT = 20;
export const PIN_PREVIEW_MAX_CHARS = 140;

/** The `MAX_PINNED_MESSAGES` setting, clamped to the supported 1-100 range. */
export function clampMaxPinnedMessages(value) {
  // Nothing configured (null, undefined, "") is the default, not zero.
  if (value === null || value === undefined || String(value).trim() === "") {
    return MAX_PINNED_DEFAULT;
  }
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return MAX_PINNED_DEFAULT;
  return Math.min(MAX_PINNED_MAX, Math.max(MAX_PINNED_MIN, n));
}

const ROLES_WITH_PIN_RIGHT = new Set(["owner", "admin"]);

/**
 * May this person pin and unpin in this chat? The caller has already checked
 * that they are a current member.
 *
 * - Direct messages and Saved Messages: both people, for both.
 * - Groups: the owner (and any administrator role), or everybody when the
 *   group's "members can pin" setting is on.
 * - Channels, mirrored remote channels included: the owner only. A channel's
 *   subscribers can never pin, whatever the group setting says.
 */
export function canManagePins({ chatType, role, allowMemberPins = false }) {
  const type = String(chatType || "").toLowerCase();
  const normalizedRole = String(role || "").toLowerCase();
  if (type === "dm" || type === "saved") return true;
  if (type === "group") {
    return ROLES_WITH_PIN_RIGHT.has(normalizedRole) || Boolean(Number(allowMemberPins));
  }
  if (type === "channel") return ROLES_WITH_PIN_RIGHT.has(normalizedRole);
  return false;
}

/** Service entries ("X pinned a message") are written for these chat types. */
export function chatTypeGetsPinServiceMessage(chatType) {
  const type = String(chatType || "").toLowerCase();
  // Not for channels: the public channel feed is what remote servers mirror,
  // and a mirror has no use for "pinned" entries pointing at messages of the
  // origin server.
  return type === "dm" || type === "saved" || type === "group";
}

/**
 * Turns the markdown the composer allows into the plain words a person would
 * read, on one line. Not a full parser: it only has to be right for previews.
 */
export function stripMarkdown(input) {
  let text = String(input ?? "");
  // Fence lines of code blocks go, the code stays.
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "");
  // Images and links keep their visible text.
  text = text.replace(/!\[([^\]]*)\]\([^)\n]*\)/g, "$1");
  text = text.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1");
  // Inline code.
  text = text.replace(/(`+)([^`]+?)\1/g, "$2");
  // Bold, strike-through and spoilers.
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, "$1");
  // Italic. Underscores inside words (snake_case) are left alone.
  text = text.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2");
  text = text.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1$2");
  // Headings and quotes.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  return text.replace(/\s+/g, " ").trim();
}

/** At most `max` characters (code points), ending in an ellipsis when cut. */
export function truncateChars(text, max = PIN_PREVIEW_MAX_CHARS) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

export function buildPreviewText(body, max = PIN_PREVIEW_MAX_CHARS) {
  return truncateChars(stripMarkdown(body), max);
}

/**
 * What kind of attachment a message has: "image", "video", "audio",
 * "document", "video_note" (an end-to-end encrypted round video) or null.
 */
export function classifyAttachment({ fileCount = 0, firstFileMime = "", firstFileKind = "", encrypted = false }) {
  if (encrypted) return "video_note";
  if (!Number(fileCount)) return null;
  const mime = String(firstFileMime || "").toLowerCase();
  if (mime.startsWith("audio/")) return "audio";
  // A photo sent "as a file" is shown as a document.
  if (String(firstFileKind || "").toLowerCase() === "document") return "document";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  return "document";
}

/** "2025-01-01 10:00:00" (UTC, as stored) or an ISO string -> ISO 8601, else null. */
export function toIsoTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim();
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/**
 * One entry of GET /api/chats/:chatId/pins from a row of listPinnedMessages().
 * In a channel every post speaks for the channel, so the channel's name is the
 * sender.
 */
export function buildPinEntry(row, chat) {
  const chatType = String(chat?.type || "").toLowerCase();
  const attachment = classifyAttachment({
    fileCount: row.file_count,
    firstFileMime: row.first_file_mime,
    firstFileKind: row.first_file_kind,
    encrypted: Boolean(row.e2ee_envelope),
  });
  let senderName;
  if (chatType === "channel") {
    senderName =
      String(chat?.name || "").trim() || String(chat?.group_username || "").trim() || "Channel";
  } else if (!row.sender_id || row.sender_username == null) {
    senderName = "Deleted user";
  } else {
    senderName = row.sender_nickname || row.sender_username;
  }
  return {
    messageId: row.message_id,
    pinnedBy: row.pinned_by || null,
    pinnedAt: row.pinned_at,
    message: {
      id: row.message_id,
      senderId: row.sender_id || null,
      senderName,
      type: attachment || "text",
      text: buildPreviewText(row.edited_body ?? row.body),
      hasFile: Boolean(attachment),
      fileKind: attachment,
      createdAt: toIsoTimestamp(row.message_created_at),
    },
  };
}

/** `[{chat_id, message_id}]` -> Map<chatId, messageId[]> */
export function groupPinsByChat(rows) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const chatId = row?.chat_id;
    const messageId = row?.message_id;
    if (!chatId || !messageId) continue;
    const list = grouped.get(chatId) || [];
    list.push(messageId);
    grouped.set(chatId, list);
  }
  return grouped;
}

/** Tells every member of each chat that these messages are no longer pinned. */
export function emitUnpinnedMessages(emitChatEvent, rows) {
  if (typeof emitChatEvent !== "function") return;
  for (const [chatId, messageIds] of groupPinsByChat(rows)) {
    for (const messageId of messageIds) {
      emitChatEvent(chatId, { type: "message_unpinned", chatId, messageId });
    }
  }
}
