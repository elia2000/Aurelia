/**
 * Deletion Domain Service
 *
 * Encapsulates transactional deletion for chats and user accounts.
 * Returns a post-commit plan detailing disk files to remove and SSE events to emit.
 */

import { buildPinsChangedEvents } from "../chatPins.js";

export function createDeletionService(dbApi) {
  const {
    deleteChatById,
    deleteUserById,
    findChatById,
    findUserById,
    listChatMembers,
    listChatsForUser,
    // Optional: who has the chat pinned, and what they have pinned afterwards.
    listChatPinHolders,
    listChatPinsForUsers,
  } = dbApi;

  /**
   * Deletes a chat (group, channel, DM, saved) and returns post-commit cleanup & notification targets.
   */
  async function deleteChat({ chatId }) {
    const chat = findChatById ? await findChatById(chatId) : null;
    const members = listChatMembers ? (await listChatMembers(chatId)) || [] : [];
    const memberUsernames = members
      .map((m) => String(m?.username || "").toLowerCase())
      .filter(Boolean);

    // The people who pinned the chat lose the pin with it. Ask before it is gone.
    let pinHolders = [];
    try {
      pinHolders = listChatPinHolders ? (await listChatPinHolders(chatId)) || [] : [];
    } catch {
      pinHolders = [];
    }

    const deletion = deleteChatById ? await deleteChatById(chatId) : {};
    const { storedNames = [] } = deletion || {};

    const sseEvents = memberUsernames.map((username) => ({
      targetUsername: username,
      payload: {
        type: "chat_deleted",
        chatId,
      },
    }));

    // Each of them is told what they still have pinned, for their other devices.
    if (pinHolders.length && listChatPinsForUsers) {
      try {
        const rows = (await listChatPinsForUsers(pinHolders.map((holder) => holder.user_id))) || [];
        sseEvents.push(...buildPinsChangedEvents(pinHolders, rows));
      } catch {
        // The chat is deleted either way; the next chat list fetch is correct.
      }
    }

    return {
      success: true,
      chatId,
      chat,
      storedFilesToRemove: storedNames,
      avatarFileToRemove: chat?.group_avatar_url || null,
      sseEvents,
    };
  }

  /**
   * Deletes a user account and returns post-commit disk cleanup and affected chat notification targets.
   */
  async function deleteUser({ targetUserId }) {
    const user = findUserById ? await findUserById(targetUserId) : null;
    const userChats = listChatsForUser ? (await listChatsForUser(targetUserId)) || [] : [];
    const affectedChatIds = userChats.map((c) => c.id);

    const deletion = deleteUserById ? await deleteUserById(targetUserId) : {};
    const { storedNames = [], avatarUrl = null } = deletion || {};

    const sseEvents = [];
    for (const chatId of affectedChatIds) {
      const members = listChatMembers ? (await listChatMembers(chatId)) || [] : [];
      members.forEach((m) => {
        const username = String(m?.username || "").toLowerCase();
        if (username) {
          sseEvents.push({
            targetUsername: username,
            payload: {
              type: "chat_updated",
              chatId,
            },
          });
        }
      });
    }

    return {
      success: true,
      userId: targetUserId,
      user,
      storedFilesToRemove: storedNames,
      avatarFileToRemove: avatarUrl,
      affectedChatIds,
      sseEvents,
    };
  }

  return {
    deleteChat,
    deleteUser,
  };
}
