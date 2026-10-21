// What forwarding, deleting and copying several selected messages needs that
// has nothing to do with the screen: which messages each action takes, how a
// batch is split into requests the server accepts, how the answers are read
// and what is told to the person afterwards.
import { isCallMessage } from "./callEntry.js";
import { parseServerDate } from "./chatFormat.js";
import { extractMessageBodyText, hasMessageText } from "./messageContent.js";
import { MAX_BATCH_MESSAGES } from "./batchSelection.js";
import { getServerMessageId, isServiceMessage } from "./messageKind.js";

export { getServerMessageId, isServiceMessage };

// The server takes at most this many chats, and messages x chats, in one forward request.
const FORWARD_MAX_TARGETS = 20;
const FORWARD_MAX_PAIRS = 500;

export const SELECTION_LIMIT_HINT = `You can select up to ${MAX_BATCH_MESSAGES} messages at once.`;

export const messagesLabel = (count) => `${count} ${count === 1 ? "message" : "messages"}`;

/** A message that is stored on the server can be selected (calls and service lines too: they can be deleted). */
export function isMessageSelectable(msg) {
  if (!getServerMessageId(msg)) return false;
  if (msg._delivery === "sending" || msg._delivery === "failed") return false;
  return !msg._awaitingServerEcho && !msg._processingPending;
}

/** The server refuses calls, service lines and encrypted messages (video notes). */
export const canForwardMessage = (msg) =>
  isMessageSelectable(msg) && !isCallMessage(msg) && !isServiceMessage(msg) && !msg?.e2ee;

/** Only text is copied: a photo or voice message without a caption has none. */
export const canCopyMessage = (msg) =>
  isMessageSelectable(msg) && !isCallMessage(msg) && !isServiceMessage(msg) && hasMessageText(msg);

const pad2 = (value) => String(value).padStart(2, "0");

/** "20.10.2026 14:03" in local time, the stamp Telegram puts on copied messages. */
export function formatCopyTimestamp(value) {
  if (!value) return "";
  const date = parseServerDate(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

const getAuthorName = (msg, channelName) => {
  if (channelName) return channelName;
  const username = String(msg?.username || "").trim();
  const nickname = String(msg?.nickname || "").trim();
  if (username.toLowerCase() === "deleted" || nickname.toLowerCase() === "deleted user") {
    return "Deleted account";
  }
  return nickname || username || "Unknown";
};

/**
 * The text that goes to the clipboard, like Telegram: a single message is its
 * text; several are "Name, [date time]" followed by the text, one blank line
 * between messages. Messages without text are skipped (and counted).
 */
export function buildCopyText(messages, { channelName = "" } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const copyable = list.filter(canCopyMessage);
  const skipped = list.length - copyable.length;
  if (!copyable.length) return { text: "", copied: 0, skipped };

  const texts = copyable.map((msg) => extractMessageBodyText(msg.body).trim());
  if (copyable.length === 1) return { text: texts[0], copied: 1, skipped };

  const blocks = copyable.map((msg, index) => {
    const stamp = formatCopyTimestamp(msg.created_at || msg._createdAt);
    const name = getAuthorName(msg, channelName);
    return `${stamp ? `${name}, [${stamp}]` : name}\n${texts[index]}`;
  });
  return { text: blocks.join("\n\n"), copied: copyable.length, skipped };
}

/** The sentence that says some selected messages were left out. */
export function describeSkipped({ action, count }) {
  if (!count) return "";
  const were = count === 1 ? "was" : "were";
  if (action === "copy") return `${messagesLabel(count)} without text ${were} skipped.`;
  return `${messagesLabel(count)} can't be forwarded (calls, service and encrypted messages) and ${were} skipped.`;
}

const chunk = (list, size) => {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
};

/**
 * Splits a forward into requests the server accepts (at most 20 chats and 500
 * message-chat pairs each). Within one chat the messages stay oldest first, so
 * the requests must be sent one after the other, in this order.
 */
export function planForwardRequests(sourceIds, targetIds) {
  if (!sourceIds.length || !targetIds.length) return [];
  const requests = [];
  chunk(targetIds, FORWARD_MAX_TARGETS).forEach((targetChatIds) => {
    const perRequest = Math.max(
      1,
      Math.min(MAX_BATCH_MESSAGES, Math.floor(FORWARD_MAX_PAIRS / targetChatIds.length)),
    );
    chunk(sourceIds, perRequest).forEach((sourceMessageIds) => {
      requests.push({ sourceMessageIds, targetChatIds });
    });
  });
  return requests;
}

/**
 * What one forward request did, as `{ forwarded, failed }`. The lists are in
 * the body of a 200 and also of an error answer when nothing could be
 * forwarded; an error without them (the whole request was refused) fails
 * every message of the request with the server's words.
 */
export function interpretForwardResponse({ ok, data }, request) {
  const forwardedList = Array.isArray(data?.forwarded) ? data.forwarded : null;
  const failedList = Array.isArray(data?.failed) ? data.failed : null;
  if (forwardedList || failedList) {
    return {
      forwarded: (forwardedList || []).map((item) => ({
        sourceMessageId: item.sourceMessageId,
        targetChatId: item.chatId ?? null,
      })),
      failed: (failedList || []).map((item) => ({
        sourceMessageId: item.sourceMessageId,
        targetChatId: item.targetChatId ?? null,
        code: item.code || "unknown",
        error: item.error || "Unable to forward message.",
      })),
    };
  }
  const error =
    (typeof data?.error === "string" && data.error) ||
    (ok ? "The server's answer was not understood." : "Unable to forward messages.");
  return {
    forwarded: [],
    failed: request.sourceMessageIds.map((sourceMessageId) => ({
      sourceMessageId,
      targetChatId: null,
      code: "request_failed",
      error,
    })),
  };
}

const FORWARD_REASONS = {
  gone: "Some messages were deleted or removed from your view.",
  encrypted: "End-to-end encrypted messages can't be forwarded.",
  not_forwardable: "Calls and service messages can't be forwarded.",
};

// The reason that hit the most messages, in words.
function pickReason(failed, known = {}) {
  const counts = new Map();
  failed.forEach((item) => counts.set(item.code, (counts.get(item.code) || 0) + 1));
  let topCode = null;
  counts.forEach((count, code) => {
    if (topCode === null || count > counts.get(topCode)) topCode = code;
  });
  if (topCode === null) return "";
  if (known[topCode]) return known[topCode];
  const sample = failed.find((item) => item.code === topCode);
  return String(sample?.error || "Something went wrong.");
}

/** What to tell the person after a forward, and how many messages got through. */
export function summarizeForward({ sourceIds, forwarded, failed }) {
  const total = new Set(sourceIds).size;
  const reached = new Set(forwarded.map((item) => item.sourceMessageId));
  const forwardedCount = reached.size;
  if (!failed.length) {
    return { tone: "info", text: `${messagesLabel(forwardedCount)} forwarded`, forwardedCount };
  }
  const reason = pickReason(failed, FORWARD_REASONS);
  if (!forwardedCount) {
    return { tone: "error", text: `Couldn't forward the messages. ${reason}`, forwardedCount: 0 };
  }
  if (forwardedCount >= total) {
    return {
      tone: "error",
      text: `Some messages did not reach every chat. ${reason}`,
      forwardedCount,
    };
  }
  return {
    tone: "error",
    text: `${forwardedCount} of ${messagesLabel(total)} forwarded. ${reason}`,
    forwardedCount,
  };
}

/**
 * The messages of a delete, in chat order: all of them, those the person may
 * delete for everyone and those that can only be hidden for them. A call entry
 * can only ever be hidden.
 */
export function planDelete(messages, { canDeleteForEveryone }) {
  const ids = [];
  const everyoneIds = [];
  const selfOnlyIds = [];
  (Array.isArray(messages) ? messages : []).forEach((msg) => {
    const id = getServerMessageId(msg);
    if (!id) return;
    ids.push(id);
    if (!isCallMessage(msg) && canDeleteForEveryone?.(msg)) everyoneIds.push(id);
    else selfOnlyIds.push(id);
  });
  return { ids, everyoneIds, selfOnlyIds };
}

/**
 * What one delete request did, as `{ okIds, failed }`: the server answers for
 * every message (also with an error status when all of them failed); a
 * refusal of the whole request fails them all.
 */
export function interpretDeleteResponse({ ok, data }, messageIds) {
  if (Array.isArray(data?.results)) {
    const byId = new Map(
      data.results.map((result) => [String(result?.messageId || "").toLowerCase(), result]),
    );
    const okIds = [];
    const failed = [];
    messageIds.forEach((messageId) => {
      const result = byId.get(String(messageId).toLowerCase());
      if (result?.ok) {
        okIds.push(messageId);
        return;
      }
      failed.push({
        messageId,
        code: result?.code || "unknown",
        error: result?.error || "The server gave no answer for this message.",
      });
    });
    return { okIds, failed };
  }
  const error =
    (typeof data?.error === "string" && data.error) ||
    (ok ? "The server's answer was not understood." : "Unable to delete messages.");
  return {
    okIds: [],
    failed: messageIds.map((messageId) => ({ messageId, code: "request_failed", error })),
  };
}

/**
 * What the delete question says will happen, for the choice currently made:
 * how many go for everyone and how many are only taken out of the person's
 * own view (and what to switch on to remove more).
 */
export function describeDeleteEffect({ total, everyoneCount, deleteForEveryone }) {
  const them = total === 1 ? "It is" : "They are";
  const keeps = total === 1 ? "it" : "them";
  if (everyoneCount <= 0) {
    return `You can only remove ${keeps} from your own view. Everyone else in the chat keeps ${keeps}.`;
  }
  if (!deleteForEveryone) {
    const more =
      everyoneCount >= total
        ? `remove ${keeps} for everyone too`
        : `also remove ${everyoneCount} of them for everyone`;
    return `${them} removed from your view only. Turn on "Delete for everyone" to ${more}.`;
  }
  if (everyoneCount >= total) return `${them} removed for everyone in this chat.`;
  return `${everyoneCount} of them ${
    everyoneCount === 1 ? "is" : "are"
  } removed for everyone. The other ${total - everyoneCount} can only be removed from your view.`;
}

/** What to tell the person after a delete. */
export function summarizeDelete({ total, okCount, failed }) {
  if (!failed.length) return { tone: "info", text: `${messagesLabel(okCount)} deleted` };
  const reason = pickReason(failed);
  if (!okCount) return { tone: "error", text: `Couldn't delete the messages. ${reason}` };
  return { tone: "error", text: `${okCount} of ${messagesLabel(total)} deleted. ${reason}` };
}
