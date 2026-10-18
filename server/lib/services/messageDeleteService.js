/**
 * Message Delete Domain Service
 *
 * Deletes one or many messages of one chat for the caller. The single-message
 * request (`messageId`) and the multi-select request (`messageIds`) both end up
 * here, so every message is judged and removed by exactly the same code.
 *
 * Two scopes:
 *   - "self" (the default): the message disappears from the caller's own view.
 *     Every member may do this to any message of the chat, call history entries
 *     included.
 *   - "everyone": the message is gone for the whole chat. Only its author or the
 *     chat's owner, and only where the caller may post (a channel's owner).
 *     Call history entries are each person's own record and cannot be deleted
 *     for everyone. A message deleted for everyone can no longer stay pinned.
 *
 * Results are values, never exceptions: one result per message, so a multi
 * select reports which messages went and which did not.
 */

import { isCallMessage } from "../callMessages.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const failure = (status, code, error) => ({ status, code, error });

export const DELETE_ERRORS = Object.freeze({
  notMember: () => failure(403, "forbidden", "Not a member of this chat."),
  notFound: () => failure(404, "not_found", "Message not found."),
  chatNotFound: () => failure(404, "chat_not_found", "Chat not found."),
  callSelfOnly: () =>
    failure(400, "call_message_self_only", "Call entries can only be deleted for yourself."),
  notAllowed: () =>
    failure(403, "forbidden", "You cannot delete this message for everyone."),
  failed: () => failure(500, "delete_failed", "Unable to delete message."),
});

export function createMessageDeleteService(deps) {
  const {
    emitChatEvent,
    findChatById,
    findMessageById,
    findMessagesByIds,
    getChatMemberRole,
    hideMessageForEveryone,
    hideMessageForUser,
    isMember,
    unpinMessage,
  } = deps;

  async function loadMessages(ids) {
    if (ids.length > 1 && typeof findMessagesByIds === "function") {
      const rows = (await maybe(findMessagesByIds(ids))) || [];
      return new Map(rows.filter(Boolean).map((row) => [String(row.id), row]));
    }
    const rows = await Promise.all(ids.map((id) => maybe(findMessageById(id))));
    const byId = new Map();
    ids.forEach((id, index) => {
      if (rows[index]) byId.set(String(id), rows[index]);
    });
    return byId;
  }

  // Who the caller is in the chat, looked up once and only when the scope needs
  // it: deleting for yourself needs neither the chat nor the role.
  function makeEveryoneContext({ chatId, userId }) {
    let loaded = null;
    return async () => {
      if (!loaded) {
        loaded = (async () => {
          const chat = await maybe(findChatById(chatId));
          if (!chat) return { chat: null };
          const role = String((await maybe(getChatMemberRole(chatId, userId))) || "").toLowerCase();
          // Channels: the owner only. Everywhere else every member posts.
          const canPost = chat.type !== "channel" || role === "owner";
          return { chat, role, canPost };
        })();
      }
      return loaded;
    };
  }

  /**
   * May `userId` delete this message? Returns null when yes, otherwise the
   * failure. Same rules for one message and for many.
   */
  async function judge({ message, chatId, userId, scope, everyoneContext }) {
    if (!message || String(message.chat_id) !== String(chatId)) return DELETE_ERRORS.notFound();
    if (scope !== "everyone") return null;

    // A call history entry is each person's own record of the call.
    if (isCallMessage(message)) return DELETE_ERRORS.callSelfOnly();
    const context = await everyoneContext();
    if (!context.chat) return DELETE_ERRORS.chatNotFound();
    const isAuthor = String(message.user_id) === String(userId);
    if (!(context.canPost && (isAuthor || context.role === "owner"))) {
      return DELETE_ERRORS.notAllowed();
    }
    return null;
  }

  /**
   * Deletes the named messages of `chatId` for `user`.
   *
   * Resolves to `{ ok: false, status, code, error }` when the request as a
   * whole is refused (the caller is not in the chat), otherwise to
   * `{ ok: true, scope, results }` with one result per distinct id, in order:
   * `{ messageId, ok: true }` or `{ messageId, ok: false, status, code, error }`.
   */
  async function deleteMessages({ user, chatId, messageIds, scope }) {
    const effectiveScope = String(scope || "").toLowerCase() === "everyone" ? "everyone" : "self";

    if (!(await maybe(isMember(chatId, user.id)))) {
      return { ok: false, ...DELETE_ERRORS.notMember() };
    }

    const messages = await loadMessages(messageIds);
    const everyoneContext = makeEveryoneContext({ chatId, userId: user.id });

    const results = [];
    const deletedIds = [];
    const unpinnedIds = [];

    for (const messageId of messageIds) {
      const message = messages.get(String(messageId));
      const refusal = await judge({
        message,
        chatId,
        userId: user.id,
        scope: effectiveScope,
        everyoneContext,
      });
      if (refusal) {
        results.push({ messageId, ok: false, ...refusal });
        continue;
      }

      // Already gone for everyone (the author, the owner or a retention job
      // was faster): what the person wants is true, so there is nothing to
      // write and nothing new to tell the chat.
      if (effectiveScope === "everyone" && message.hidden_everyone_at) {
        results.push({ messageId, ok: true });
        continue;
      }

      try {
        if (effectiveScope === "everyone") {
          await maybe(hideMessageForEveryone(message.id));
          // A message that is gone for everyone cannot stay pinned.
          if (await removePin(chatId, message.id)) unpinnedIds.push(message.id);
          deletedIds.push(message.id);
        } else {
          await maybe(hideMessageForUser(message.id, user.id));
        }
        results.push({ messageId, ok: true });
      } catch (error) {
        console.error("messages delete: unable to delete a message:", error);
        results.push({ messageId, ok: false, ...DELETE_ERRORS.failed() });
      }
    }

    // One event for everything that went, then one per pin that went with it.
    // The deletion is stored already: a broken hub must not turn it into an error.
    if (deletedIds.length) {
      try {
        emitChatEvent(chatId, {
          type: "chat_message_deleted",
          chatId,
          messageIds: deletedIds,
        });
        for (const unpinnedId of unpinnedIds) {
          emitChatEvent(chatId, { type: "message_unpinned", chatId, messageId: unpinnedId });
        }
      } catch (error) {
        console.error("messages delete: realtime event failed:", error);
      }
    }

    return { ok: true, scope: effectiveScope, results };
  }

  // Failing to drop the pin must not undo the deletion.
  async function removePin(chatId, messageId) {
    if (typeof unpinMessage !== "function") return false;
    try {
      return Number(await maybe(unpinMessage(chatId, messageId))) > 0;
    } catch (error) {
      console.error("POST /api/messages/delete unpin ERROR:", error);
      return false;
    }
  }

  return { deleteMessages };
}
