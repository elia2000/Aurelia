// The theme colour state shared by the app and the settings screen: the
// palette the admin set, the person's choice, and the colour that means today.

import {
  DEFAULT_PALETTE,
  loadThemePreference,
  parsePalette,
  resolveThemeColor,
  saveThemePreference,
} from "./themeColor.js";

const listeners = new Set();
let palette = [...DEFAULT_PALETTE];
let userKey = null;
let preference = { mode: "default" };
let snapshot = null;

function compute(now) {
  return { palette, userKey, preference, color: resolveThemeColor(preference, palette, userKey, now()) };
}

function sameSnapshot(a, b) {
  return (
    a &&
    a.userKey === b.userKey &&
    a.color === b.color &&
    a.preference.mode === b.preference.mode &&
    a.preference.color === b.preference.color &&
    a.palette === b.palette
  );
}

function emit(now = () => new Date()) {
  const next = compute(now);
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

snapshot = compute(() => new Date());

export const getThemeSnapshot = () => snapshot;

export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The colours "Random" draws from, as the server sent them. */
export function setThemePalette(list, { now } = {}) {
  palette = parsePalette(list);
  emit(now);
}

/** Whose choice applies (null when nobody is signed in). */
export function setThemeUser(key, { storage, now } = {}) {
  userKey = key ? String(key) : null;
  preference = userKey ? loadThemePreference(userKey, storage) : { mode: "default" };
  emit(now);
}

export function setThemePreference(next, { storage, now } = {}) {
  preference = next?.mode === "random" || next?.mode === "custom" ? next : { mode: "default" };
  if (userKey) saveThemePreference(userKey, preference, storage);
  emit(now);
}

/** Looks at the clock again (the colour changes at midnight). */
export function refreshThemeColor({ now } = {}) {
  emit(now);
}

/** Milliseconds from `date` to the next local midnight. */
export function msUntilNextDay(date = new Date()) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - date.getTime();
}

export function resetThemeStore() {
  palette = [...DEFAULT_PALETTE];
  userKey = null;
  preference = { mode: "default" };
  snapshot = null;
  snapshot = compute(() => new Date());
}
