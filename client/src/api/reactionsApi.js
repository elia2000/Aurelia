import { apiFetch } from "./chatApi.js";

const jsonHeaders = { "Content-Type": "application/json" };

/**
 * Adds, replaces or removes the signed-in person's reaction on a message.
 * `emoji` null removes all of theirs. 200 answers { messageId, reactions }.
 */
export const reactToMessage = ({ chatId, messageId, emoji }) =>
  apiFetch("/api/messages/react", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ chatId, messageId, emoji }),
  });

/**
 * Who reacted with what. 200 answers { messageId, reactions: [{ emoji, count,
 * users }], truncated }. In a channel only its owner may ask (403).
 */
export const listMessageReactors = ({ chatId, messageId, emoji = "", signal } = {}) => {
  const query = new URLSearchParams({ chatId: String(chatId), messageId: String(messageId) });
  if (emoji) query.set("emoji", emoji);
  return apiFetch(`/api/messages/reactions?${query.toString()}`, {
    cache: "no-store",
    signal,
  });
};
