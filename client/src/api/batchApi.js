import { apiFetch } from "./chatApi.js";

const jsonHeaders = { "Content-Type": "application/json" };

/**
 * Forwards up to 100 messages (to up to 20 chats, at most 500 message-chat
 * pairs) in one request. Each message is sent with its own current text,
 * oldest first. 200 answers { forwarded: [...], failed: [...] } even when some
 * failed; an error status can carry the same lists.
 */
export const forwardMessages = ({ username, sourceMessageIds, targetChatIds }) =>
  apiFetch("/api/messages/forward", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ username, sourceMessageIds, targetChatIds }),
  });

/**
 * Deletes up to 100 messages of a chat in one request, all for `scope`
 * ("self" hides them for the signed-in person, "everyone" removes them).
 * 200 answers { results: [{ messageId, ok } | { messageId, ok: false, code, error }] }.
 */
export const deleteMessages = ({ chatId, username, messageIds, scope }) =>
  apiFetch("/api/messages/delete", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ chatId, username, messageIds, scope }),
  });
