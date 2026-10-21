import { apiFetch } from "./chatApi.js";

const jsonHeaders = { "Content-Type": "application/json" };
const chatPath = (chatId) => `/api/chats/${encodeURIComponent(chatId)}`;

// --- pinned messages (per chat) ---
// Every answer is { pins: [...] }, the pins of the chat after the change.

/** The pins of a chat, newest first. */
export const listMessagePins = (chatId, { signal } = {}) =>
  apiFetch(`${chatPath(chatId)}/pins`, { cache: "no-store", signal });

/** Pins a message (pinning one that is pinned already is a quiet 200). */
export const pinMessage = (chatId, messageId) =>
  apiFetch(`${chatPath(chatId)}/pins`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messageId }),
  });

/** Unpins one message. */
export const unpinMessage = (chatId, messageId) =>
  apiFetch(`${chatPath(chatId)}/pins/${encodeURIComponent(messageId)}`, {
    method: "DELETE",
  });

/** Unpins every message of the chat. */
export const unpinAllMessages = (chatId) =>
  apiFetch(`${chatPath(chatId)}/pins`, { method: "DELETE" });

// --- pinned chats (per person) ---

/**
 * Pins a chat to the top of the signed-in person's list, or lets it go.
 * 200 answers { chatId, pinned, pinPosition, pins: [{ chatId, position }] }.
 */
export const setChatPinned = (chatId, pinned) =>
  apiFetch(`${chatPath(chatId)}/pin`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ pinned: Boolean(pinned) }),
  });

/**
 * Saves the order of the pinned chats: ALL of them, top first. 200 answers
 * { pins }; 409 pin_set_mismatch answers the real list.
 */
export const reorderPinnedChats = (chatIds) =>
  apiFetch("/api/chats/pins/order", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ chatIds }),
  });
