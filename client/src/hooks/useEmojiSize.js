import { useSyncExternalStore } from "react";
import { getEmojiSize, subscribeEmojiSize } from "../emoji/emojiSize.js";

/** "large", "medium" or "normal": how a message of only a few emoji is drawn on this device. */
export function useEmojiSize() {
  return useSyncExternalStore(subscribeEmojiSize, getEmojiSize, getEmojiSize);
}
