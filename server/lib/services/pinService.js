/**
 * Pinned Messages Domain Service
 *
 * Authorises a pin request, applies it, and works out its effects: the pin
 * list for the caller, the realtime events for the chat and the
 * "X pinned a message" entry in the timeline. Returns plain `{ status, body }`
 * results for the thin route layer.
 */

import {
  buildPinEntry,
  canManagePins,
  chatTypeGetsPinServiceMessage,
  clampMaxPinnedMessages,
} from "../pins.js";
import { buildPinServiceBody, isServiceMessageBody } from "../serviceMessages.js";

const maybe = async (value) =>
  value && typeof value.then === "function" ? await value : value;

const fail = (status, error, extra = {}) => ({ ok: false, status, body: { error, ...extra } });

// The message disappeared between our checks and the write (SQLite / Postgres
// foreign key violation on chat_pinned_messages.message_id).
const isForeignKeyViolation = (error) =>
  error?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
  error?.code === "23503" ||
  /FOREIGN KEY constraint failed/i.test(String(error?.message || ""));

export function createPinService(deps) {
  const {
    getSetting,
    emitChatEvent,
    createMessage,
    findChatById,
    findMessageById,
    getChatMemberRole,
    isMember,
    isMessageHiddenForUser,
    listPinnedMessages,
    markMessageRead,
    pinMessage,
    unpinAllMessages,
    unpinMessage,
  } = deps;

  const maxPinned = () =>
    clampMaxPinnedMessages(typeof getSetting === "function" ? getSetting("MAX_PINNED_MESSAGES") : null);

  // A broken realtime hub must never undo a change that is already stored.
  const emit = (chatId, payload) => {
    if (typeof emitChatEvent !== "function") return;
    try {
      emitChatEvent(chatId, payload);
    } catch (error) {
      console.error("pins: realtime event failed:", error);
    }
  };

  /** The caller must be in the chat, and the chat's rules must let them manage pins. */
  async function authorizeManager({ user, chatId }) {
    if (!(await maybe(isMember(chatId, user.id)))) {
      return fail(403, "Not a member of this chat.");
    }
    const chat = await maybe(findChatById(chatId));
    if (!chat) return fail(404, "Chat not found.");

    const role = await maybe(getChatMemberRole(chatId, user.id));
    if (
      !canManagePins({
        chatType: chat.type,
        role,
        allowMemberPins: chat.allow_member_pins,
      })
    ) {
      return fail(403, "You are not allowed to pin messages in this chat.");
    }
    return { ok: true, chat };
  }

  /** The pins of the chat as this person sees them, newest first. */
  async function pinsFor(chat, user) {
    const rows = (await maybe(listPinnedMessages(chat.id, user.id, { limit: 100 }))) || [];
    return rows.map((row) => buildPinEntry(row, chat));
  }

  async function list({ user, chatId }) {
    if (!(await maybe(isMember(chatId, user.id)))) {
      return fail(403, "Not a member of this chat.");
    }
    const chat = await maybe(findChatById(chatId));
    if (!chat) return fail(404, "Chat not found.");
    return { ok: true, status: 200, body: { pins: await pinsFor(chat, user) } };
  }

  /** Writes the "X pinned a message" entry and tells the chat about it. */
  async function announceInTimeline({ user, chat, messageId }) {
    if (!chatTypeGetsPinServiceMessage(chat.type) || typeof createMessage !== "function") return;
    try {
      const body = buildPinServiceBody(messageId);
      const serviceMessageId = await maybe(
        createMessage(chat.id, user.id, body, null, null, null, {
          allowPlaintextSystemMessage: true,
        }),
      );
      if (!serviceMessageId) return;

      // Saved Messages has one reader, who just did this: nothing to read.
      const alreadyRead = String(chat.type).toLowerCase() === "saved";
      if (alreadyRead && typeof markMessageRead === "function") {
        await maybe(markMessageRead(serviceMessageId, user.id));
      }
      emit(chat.id, {
        type: "chat_message",
        chatId: chat.id,
        messageId: serviceMessageId,
        username: user.username,
        userId: user.id,
        body,
        service: { action: "pin", messageId, actorId: user.id },
        ...(alreadyRead
          ? { read_at: new Date().toISOString(), read_by_user_id: user.id }
          : {}),
      });
    } catch (error) {
      // The pin itself is stored; only its timeline entry is missing.
      console.error("pins: unable to write the pinned-message entry:", error);
    }
  }

  async function pin({ user, chatId, messageId }) {
    const auth = await authorizeManager({ user, chatId });
    if (!auth.ok) return auth;
    const { chat } = auth;

    // A message of another chat is "not found", exactly like one that never
    // existed, so ids of other conversations cannot be probed.
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
    if (isServiceMessageBody(message.body)) {
      return fail(400, "This message cannot be pinned.");
    }

    const max = maxPinned();
    let outcome;
    try {
      outcome = await maybe(pinMessage({ chatId, messageId, userId: user.id, max }));
    } catch (error) {
      if (isForeignKeyViolation(error)) return fail(404, "Message not found.");
      throw error;
    }

    if (outcome?.status === "limit") {
      return fail(409, `A chat can have at most ${max} pinned messages. Unpin one first.`, {
        code: "pin_limit",
      });
    }

    if (outcome?.status === "pinned") {
      emit(chatId, {
        type: "message_pinned",
        chatId,
        messageId,
        pinnedBy: user.id,
        pinnedAt: outcome.pinnedAt,
      });
      await announceInTimeline({ user, chat, messageId });
    }

    return { ok: true, status: 200, body: { pins: await pinsFor(chat, user) } };
  }

  async function unpin({ user, chatId, messageId }) {
    const auth = await authorizeManager({ user, chatId });
    if (!auth.ok) return auth;

    const removed = Number(await maybe(unpinMessage(chatId, messageId))) || 0;
    if (removed > 0) {
      emit(chatId, { type: "message_unpinned", chatId, messageId });
    }
    return { ok: true, status: 200, body: { pins: await pinsFor(auth.chat, user) } };
  }

  async function unpinAll({ user, chatId }) {
    const auth = await authorizeManager({ user, chatId });
    if (!auth.ok) return auth;

    const removed = Number(await maybe(unpinAllMessages(chatId))) || 0;
    if (removed > 0) {
      emit(chatId, { type: "messages_unpinned_all", chatId });
    }
    return { ok: true, status: 200, body: { pins: await pinsFor(auth.chat, user) } };
  }

  return { list, pin, unpin, unpinAll };
}
