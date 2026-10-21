// How many messages one chat may have pinned, and how many chats one person
// may pin. Both come from the server (GET /api/app/info, set once at start);
// they are only used for the wording of a notice, the server is what enforces
// them.

import { DEFAULT_MAX_PINNED_CHATS, clampMaxPinnedChats } from "./chatPins.js";
import { DEFAULT_MAX_PINNED_MESSAGES, clampMaxPinnedMessages } from "./messagePins.js";

let maxPinnedMessages = DEFAULT_MAX_PINNED_MESSAGES;
let maxPinnedChats = DEFAULT_MAX_PINNED_CHATS;

/** @param {{ messages?: unknown, chats?: unknown }} limits the app info's maxPinnedMessages / maxPinnedChats */
export function setPinLimits({ messages, chats } = {}) {
  maxPinnedMessages = clampMaxPinnedMessages(messages);
  maxPinnedChats = clampMaxPinnedChats(chats);
}

export const getMaxPinnedMessages = () => maxPinnedMessages;
export const getMaxPinnedChats = () => maxPinnedChats;
