// What this device does when a call rings: play sounds (and how loud) and
// vibrate. Kept per device in localStorage, read through safe storage so a
// browser that blocks site data simply uses the defaults. A tiny store, so the
// settings panel and the ringer always agree and a change applies at once,
// even to a call that is ringing right now.

import { defaultStorage } from "../utils/safeStorage.js";

export const CALL_SOUND_KEYS = Object.freeze({
  enabled: "aurelle-call-sounds",
  volume: "aurelle-call-sound-volume",
  vibrate: "aurelle-call-vibrate",
});

export const DEFAULT_CALL_SOUND_PREFS = Object.freeze({ enabled: true, volume: 70, vibrate: true });

export const clampVolume = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CALL_SOUND_PREFS.volume;
  return Math.min(100, Math.max(0, Math.round(number)));
};

const readFlag = (storage, key, fallback) => {
  try {
    const value = storage?.getItem(key);
    if (value === "0") return false;
    if (value === "1") return true;
  } catch (_) {
    // unreadable: the default applies
  }
  return fallback;
};

/** The saved preferences, with a default for everything missing or unreadable. */
export function loadCallSoundPrefs(storage = defaultStorage()) {
  let volume = DEFAULT_CALL_SOUND_PREFS.volume;
  try {
    const saved = storage?.getItem(CALL_SOUND_KEYS.volume);
    if (saved !== null && saved !== undefined && saved !== "") volume = clampVolume(saved);
  } catch (_) {
    // unreadable: the default applies
  }
  return {
    enabled: readFlag(storage, CALL_SOUND_KEYS.enabled, DEFAULT_CALL_SOUND_PREFS.enabled),
    volume,
    vibrate: readFlag(storage, CALL_SOUND_KEYS.vibrate, DEFAULT_CALL_SOUND_PREFS.vibrate),
  };
}

export function saveCallSoundPrefs(prefs, storage = defaultStorage()) {
  try {
    storage?.setItem(CALL_SOUND_KEYS.enabled, prefs.enabled ? "1" : "0");
    storage?.setItem(CALL_SOUND_KEYS.volume, String(clampVolume(prefs.volume)));
    storage?.setItem(CALL_SOUND_KEYS.vibrate, prefs.vibrate ? "1" : "0");
  } catch (_) {
    // not remembered: the choice lasts until the page closes
  }
}

const listeners = new Set();
let current = loadCallSoundPrefs();

/** The current preferences (the same object until something changes). */
export const getCallSoundPrefs = () => current;

export function subscribeCallSoundPrefs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const sameAs = (a, b) => a.enabled === b.enabled && a.volume === b.volume && a.vibrate === b.vibrate;

function publish(next) {
  if (sameAs(next, current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** Changes some of the preferences, for the whole app at once, and remembers them on this device. */
export function setCallSoundPrefs(patch, { storage } = {}) {
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : Boolean(patch.enabled),
    volume: patch.volume === undefined ? current.volume : clampVolume(patch.volume),
    vibrate: patch.vibrate === undefined ? current.vibrate : Boolean(patch.vibrate),
  };
  saveCallSoundPrefs(next, storage);
  publish(next);
}

/** Reads the saved values again (another tab changed them, or a test cleared storage). */
export function reloadCallSoundPrefs(storage) {
  publish(loadCallSoundPrefs(storage));
}

// Another tab of this browser changed a setting: follow it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || Object.values(CALL_SOUND_KEYS).includes(event.key)) reloadCallSoundPrefs();
  });
}
