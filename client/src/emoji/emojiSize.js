// How big a message of only a few emoji is drawn. Such a message (see
// isJumboEmojiText in emojiImages.js) is Large by default, like Telegram; every
// person can make it Medium, or the same size as the text around it (Normal).
//
// The choice is a style on <html> (data-emoji-size, acted on by emojiSize.css),
// not something the message renderer knows about: a change shows at once in the
// messages already on the screen, and the rendered messages kept in the caches
// stay right. It is remembered on this device, and put on <html> as soon as
// this file is loaded, before the first message is drawn.

import { defaultStorage } from "../utils/safeStorage.js";
import "./emojiSize.css";

export const EMOJI_SIZE_CHOICES = Object.freeze([
  { id: "large", label: "Large" },
  { id: "medium", label: "Medium" },
  { id: "normal", label: "Normal" },
]);
export const DEFAULT_EMOJI_SIZE = "large";
export const EMOJI_SIZE_ATTRIBUTE = "data-emoji-size";
export const isEmojiSizeChoice = (value) => EMOJI_SIZE_CHOICES.some((choice) => choice.id === value);

const KEY = "aurelle-emoji-size";

export function loadEmojiSize(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(KEY);
    return isEmojiSizeChoice(value) ? value : DEFAULT_EMOJI_SIZE;
  } catch (_) {
    return DEFAULT_EMOJI_SIZE;
  }
}

export function saveEmojiSize(value, storage = defaultStorage()) {
  try {
    if (isEmojiSizeChoice(value)) storage?.setItem(KEY, value);
  } catch (_) {
    // not remembered: the choice lasts until the page closes
  }
}

/** Puts the size on the page (<html> unless told otherwise), where emojiSize.css acts on it. */
export function applyEmojiSize(
  value,
  root = typeof document === "undefined" ? null : document.documentElement,
) {
  root?.setAttribute(EMOJI_SIZE_ATTRIBUTE, isEmojiSizeChoice(value) ? value : DEFAULT_EMOJI_SIZE);
}

const listeners = new Set();
let current = loadEmojiSize();
applyEmojiSize(current);

export const getEmojiSize = () => current;

export function subscribeEmojiSize(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Makes this the size on the whole app, at once, and remembers it on this device. */
export function setEmojiSize(value, { storage, root } = {}) {
  const next = isEmojiSizeChoice(value) ? value : DEFAULT_EMOJI_SIZE;
  saveEmojiSize(next, storage);
  applyEmojiSize(next, root);
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}
