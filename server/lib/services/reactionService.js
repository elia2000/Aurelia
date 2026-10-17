/**
 * Message Reaction Domain Service
 *
 * Authorises a reaction request, applies it, and works out its effects: the
 * summary for the caller, the realtime event for the chat and the push
 * notification for the message's author. Returns plain `{ status, body }`
 * results for the thin route layer.
 */

import {
  REACTION_USERS_CAP,
  clampReactionsPerUser,
  isServiceMessageBody,
  summarizeReactionRows,
  toReactionCounts,
} from "../reactions.js";
import { isCallMessage } from "../callMessages.js";
import { createThrottle } from "../throttle.js";

const PUSH_WINDOW_MS = 60 * 1000;

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const fail = (status, error) => ({ ok: false, status, body: { error } });

// The message disappeared between our checks and the write (SQLite / Postgres
// foreign key violation on message_reactions.message_id).
const isForeignKeyViolation = (error) =>
  error?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
  error?.code === "23503" ||
  /FOREIGN KEY constraint failed/i.test(String(error?.message || ""));

const isRemoteClientRequestId = (value) => /^remote:/i.test(String(value || "").trim());

export function createReactionService(deps) {
  const {
    getSetting,
    emitChatEvent,
    ensureAvatarExists,
    findChatById,
    findMessageById,
    findUserById,
    getChatMemberRole,
    getMessageAuthors,
    isMember,
    isMessageHiddenForUser,
    isUserConnected,
    listMessageReactionSummaries,
    listMessageReactionUsers,
    listMutedUserIdsForChat,
    sendPushNotificationToUsers,
    toggleMessageReaction,
  } = deps;

  // One push per reactor and message per minute, so tapping a reaction on and
  // off cannot be used to spam the author.
  const pushThrottle = createThrottle({ windowMs: PUSH_WINDOW_MS, max: 1 });

  const maxReactionsPerUser = () =>
    clampReactionsPerUser(typeof getSetting === "function" ? getSetting("MAX_REACTIONS_PER_USER") : null);

  /**
   * The caller must be in the chat, and the message must belong to it and be
   * visible to them. A person who is not a member gets the same answer
   * whatever the ids are, so nothing leaks about chats or messages.
   */
  async function loadTarget({ user, chatId, messageId }) {
    if (!(await maybe(isMember(chatId, user.id)))) {
      return fail(403, "Not a member of this chat.");
    }
    const chat = await maybe(findChatById(chatId));
    if (!chat) return fail(404, "Chat not found.");

    const message = await maybe(findMessageById(messageId));
    if (
      !message ||
      String(message.chat_id) !== String(chatId) ||
      message.hidden_everyone_at
    ) {
      return fail(404, "Message not found.");
    }
    if (
      typeof isMessageHiddenForUser === "function" &&
      (await maybe(isMessageHiddenForUser(messageId, user.id)))
    ) {
      return fail(404, "Message not found.");
    }
    return { ok: true, chat, message };
  }

  async function summaryFor(messageId, viewerUserId) {
    const rows = await maybe(listMessageReactionSummaries([messageId], viewerUserId));
    return summarizeReactionRows(rows).get(messageId) || [];
  }

  async function notifyAuthor({ user, chat, message, messageId, emoji }) {
    const authorId = message.user_id;
    if (!authorId || String(authorId) === String(user.id)) return;
    if (typeof sendPushNotificationToUsers !== "function") return;

    // Posts mirrored from a remote channel have no real author to tell.
    if (typeof getMessageAuthors === "function") {
      const rows = (await maybe(getMessageAuthors([messageId]))) || [];
      const row = rows.find((candidate) => candidate?.id === messageId);
      if (isRemoteClientRequestId(row?.client_request_id)) return;
    }

    const author = await maybe(findUserById(authorId));
    if (!author) return;
    // Someone who left (or was removed from) the chat must not hear about it,
    // and neither must someone who deleted the message for themselves.
    if (!(await maybe(isMember(chat.id, authorId)))) return;
    if (
      typeof isMessageHiddenForUser === "function" &&
      (await maybe(isMessageHiddenForUser(messageId, authorId)))
    ) {
      return;
    }
    // Somebody looking at the app sees the reaction live.
    if (typeof isUserConnected === "function" && isUserConnected(author.username)) return;

    if (typeof listMutedUserIdsForChat === "function") {
      const mutedRows = (await maybe(listMutedUserIdsForChat(chat.id))) || [];
      const muted = new Set(mutedRows.map((row) => row?.user_id || row).filter(Boolean));
      if (muted.has(authorId)) return;
    }

    if (!pushThrottle.take(`${user.id}:${messageId}`)) return;

    const who = user.nickname || user.username;
    const title =
      chat.type === "dm"
        ? who
        : chat.name || (chat.type === "channel" ? "Channel" : "Group");
    await sendPushNotificationToUsers([authorId], {
      title,
      // Never contains the message text. People who turned previews off get
      // `redactedBody` instead (see lib/push.js).
      body: `${who} reacted ${emoji} to your message`,
      redactedBody: "New reaction",
      data: { chatId: chat.id, messageId, type: "reaction" },
    });
  }

  /**
   * Applies a react request. `emoji` is already validated and canonical, or
   * null to remove the caller's reactions.
   */
  async function react({ user, chatId, messageId, emoji }) {
    const target = await loadTarget({ user, chatId, messageId });
    if (!target.ok) return target;
    if (isServiceMessageBody(target.message.body) || isCallMessage(target.message)) {
      return fail(400, "Reactions are not available for this message.");
    }

    let change;
    try {
      change = await maybe(
        toggleMessageReaction({
          messageId,
          userId: user.id,
          emoji,
          maxPerUser: maxReactionsPerUser(),
        }),
      );
    } catch (error) {
      if (isForeignKeyViolation(error)) return fail(404, "Message not found.");
      throw error;
    }
    const added = change?.added || null;
    const removed = Array.isArray(change?.removed) ? change.removed : [];

    const reactions = await summaryFor(messageId, user.id);

    if ((added || removed.length) && typeof emitChatEvent === "function") {
      emitChatEvent(chatId, {
        type: "message_reactions",
        chatId,
        messageId,
        counts: toReactionCounts(reactions),
        actorId: user.id,
        actorEmoji: added,
        removedEmoji: removed[0] ?? null,
        removedEmojis: removed,
      });
    }

    if (added) {
      void notifyAuthor({
        user,
        chat: target.chat,
        message: target.message,
        messageId,
        emoji: added,
      }).catch(() => {
        // A failed push must never affect the reaction.
      });
    }

    return { ok: true, status: 200, body: { messageId, reactions } };
  }

  /**
   * Who reacted with what. In a channel only its owner may ask: subscribers of
   * a public channel are strangers to each other and see counts only.
   */
  async function listReactors({ user, chatId, messageId, emoji = null }) {
    const target = await loadTarget({ user, chatId, messageId });
    if (!target.ok) return target;

    if (String(target.chat.type || "").toLowerCase() === "channel") {
      const role = String((await maybe(getChatMemberRole(chatId, user.id))) || "").toLowerCase();
      if (role !== "owner") {
        return fail(403, "Only the channel owner can see who reacted.");
      }
    }

    if (isServiceMessageBody(target.message.body) || isCallMessage(target.message)) {
      return { ok: true, status: 200, body: { messageId, reactions: [], truncated: false } };
    }

    const [summary, userRows] = await Promise.all([
      summaryFor(messageId, user.id),
      maybe(listMessageReactionUsers(messageId, { emoji, limit: REACTION_USERS_CAP })),
    ]);

    const usersByEmoji = new Map();
    for (const row of userRows || []) {
      const list = usersByEmoji.get(row.emoji) || [];
      list.push({
        id: row.id,
        username: row.username,
        nickname: row.nickname || null,
        avatarUrl:
          (typeof ensureAvatarExists === "function"
            ? ensureAvatarExists(row.id, row.avatar_url)
            : row.avatar_url) || null,
        color: row.color || null,
        createdAt: row.created_at || null,
      });
      usersByEmoji.set(row.emoji, list);
    }

    const reactions = summary
      .filter((entry) => !emoji || entry.emoji === emoji)
      .map((entry) => ({
        emoji: entry.emoji,
        count: entry.count,
        users: usersByEmoji.get(entry.emoji) || [],
      }));

    return {
      ok: true,
      status: 200,
      body: {
        messageId,
        reactions,
        truncated: (userRows || []).length >= REACTION_USERS_CAP,
      },
    };
  }

  return { react, listReactors };
}
