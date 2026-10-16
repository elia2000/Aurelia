// The theme colour state shared by the app and the settings screen: the
// palette and default the admin set, the person's choice, and the colour that
// means today.

import {
  DEFAULT_PALETTE,
  followsTheDay,
  loadServerTheme,
  loadThemePreference,
  msUntilNextDay,
  parsePalette,
  parseThemeDefault,
  resolveThemeColor,
  saveServerTheme,
  saveThemePreference,
} from "./themeColor.js";

export { msUntilNextDay };

const listeners = new Set();
const remembered = loadServerTheme();
let palette = remembered.palette;
let themeDefault = remembered.themeDefault;
let userKey = null;
let preference = { mode: "inherit" };
let snapshot = null;

function compute(now) {
  return {
    palette,
    themeDefault,
    userKey,
    preference,
    color: resolveThemeColor(preference, palette, themeDefault, now()),
    daily: followsTheDay(preference, themeDefault),
  };
}

function sameSnapshot(a, b) {
  return (
    a &&
    a.userKey === b.userKey &&
    a.color === b.color &&
    a.daily === b.daily &&
    a.preference.mode === b.preference.mode &&
    a.preference.color === b.preference.color &&
    a.themeDefault === b.themeDefault &&
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
export function setThemePalette(list, { now, storage } = {}) {
  palette = parsePalette(list);
  saveServerTheme({ palette, themeDefault }, storage);
  emit(now);
}

/** What people get until they choose ("random", "default" or "#rrggbb"), as the server sent it. */
export function setThemeDefault(value, { now, storage } = {}) {
  themeDefault = parseThemeDefault(value);
  saveServerTheme({ palette, themeDefault }, storage);
  emit(now);
}

/** Whose choice applies (null when nobody is signed in). */
export function setThemeUser(key, { storage, now } = {}) {
  userKey = key ? String(key) : null;
  preference = userKey ? loadThemePreference(userKey, storage) : { mode: "inherit" };
  emit(now);
}

export function setThemePreference(next, { storage, now } = {}) {
  const mode = next?.mode;
  preference = mode === "random" || mode === "custom" || mode === "default" ? next : { mode: "inherit" };
  if (userKey) saveThemePreference(userKey, preference, storage);
  emit(now);
}

/** Looks at the clock again (the colour changes at midnight, UTC). */
export function refreshThemeColor({ now } = {}) {
  emit(now);
}

/** Back to the built-in settings, without reading what was remembered (for tests). */
export function resetThemeStore() {
  palette = [...DEFAULT_PALETTE];
  themeDefault = "random";
  userKey = null;
  preference = { mode: "inherit" };
  snapshot = null;
  snapshot = compute(() => new Date());
}
