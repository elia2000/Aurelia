// Whether the single-letter keys of the call screen (M, V, S, P, F) work on this
// device. On by default; a person who uses speech recognition, a screen reader
// in focus mode or simply types a lot can switch them off (WCAG 2.1.4). Kept per
// device in localStorage through safe storage, like the call sound preferences,
// in a tiny store so the call's settings, the app's settings and the key handler
// always agree and a change applies at once, even in a call that is going on.
//
// Only the modifier-free letter keys are affected. Escape, ? and Shift+H are not
// single letters (Escape and Shift+H need a deliberate press, ? only opens the
// list that holds this very switch) and stay as they are.

import { defaultStorage } from "../utils/safeStorage.js";

export const CALL_SHORTCUT_KEY = "aurelle-call-shortcuts";
export const DEFAULT_CALL_SHORTCUTS_ENABLED = true;

/** The saved choice, or the default when nothing (or rubbish) is saved or storage cannot be read. */
export function loadCallShortcutsEnabled(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(CALL_SHORTCUT_KEY);
    if (value === "0") return false;
    if (value === "1") return true;
  } catch (_) {
    // unreadable: the default applies
  }
  return DEFAULT_CALL_SHORTCUTS_ENABLED;
}

export function saveCallShortcutsEnabled(enabled, storage = defaultStorage()) {
  try {
    storage?.setItem(CALL_SHORTCUT_KEY, enabled ? "1" : "0");
  } catch (_) {
    // not remembered: the choice lasts until the page closes
  }
}

const listeners = new Set();
let current = loadCallShortcutsEnabled();

/** Whether the letter keys work right now. */
export const getCallShortcutsEnabled = () => current;

export function subscribeCallShortcuts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next) {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** Switches the letter keys on or off for the whole app at once, and remembers it on this device. */
export function setCallShortcutsEnabled(enabled, { storage } = {}) {
  const next = Boolean(enabled);
  saveCallShortcutsEnabled(next, storage);
  publish(next);
}

/** Reads the saved value again (another tab changed it, or a test cleared storage). */
export function reloadCallShortcutsEnabled(storage) {
  publish(loadCallShortcutsEnabled(storage));
}

// Another tab of this browser changed the setting: follow it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === CALL_SHORTCUT_KEY) reloadCallShortcutsEnabled();
  });
}
