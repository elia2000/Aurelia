// "Open the safety number of this chat" from anywhere in the chat, without the
// thing that asks having to own the screen: the notice in the timeline asks,
// the shield in the chat header (which owns the safety number screen) opens it.

const listeners = new Set();

/** Asks for the safety number screen of the direct chat `chatId`. */
export function requestSafetyNumber(chatId) {
  for (const listener of [...listeners]) listener(String(chatId ?? ""));
}

/** @returns {() => void} stop listening */
export function onSafetyNumberRequest(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
