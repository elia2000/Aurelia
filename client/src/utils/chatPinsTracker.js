// Which pinned-chat list is the newest this browser has seen. GET /api/chats
// carries `pinned` / `pinPosition` too, but an answer that left before the
// person pinned a chat (or before a chat_pins_changed event) can arrive after
// it; without this it would put the old pins back.
//
// Every place that sets the pinned list of the chat list (the person's own
// change, its answer, the realtime event) calls notePinnedChatList. A chat-list
// request remembers the version when it leaves and, if the version moved by
// the time the answer is used, lays the newest list over the answer.

import { applyPinnedList } from "./chatPins.js";

let version = 0;
let newest = [];

export const getPinnedChatListVersion = () => version;

/** The pinned list ([{ chatId, position }], top first) that is now the truth. */
export function notePinnedChatList(rawList) {
  newest = Array.isArray(rawList) ? rawList : [];
  version += 1;
}

/** `chats` as read by a request that started at `sinceVersion`, with the newest pins. */
export function withNewestChatPins(chats, sinceVersion) {
  if (version === sinceVersion) return chats;
  return applyPinnedList(chats, newest);
}

export function resetPinnedChatListTracker() {
  version = 0;
  newest = [];
}
