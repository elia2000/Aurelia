// Whether link previews are shown. Two things decide:
//   - the server: the admin switch LINK_PREVIEWS (off by default), told to the
//     client in /api/app/info as `linkPreviewsEnabled`;
//   - the person: "Show link previews" in Settings > Appearance. Until they
//     choose, their choice follows the server (on when the server has it on).
//     The choice is remembered on this device.
// A preview is shown only when the server has it on AND the person has not
// turned it off. A tiny store, so the settings switch and every message agree
// at once.

import { defaultStorage } from "./safeStorage.js";

export const LINK_PREVIEW_PREF_KEY = "aurelle-link-previews";

/** true (shown), false (hidden) or null (not chosen: follows the server). */
export function loadLinkPreviewChoice(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(LINK_PREVIEW_PREF_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch (_) {
    // unreadable: follows the server
  }
  return null;
}

export function saveLinkPreviewChoice(choice, storage = defaultStorage()) {
  try {
    if (choice === null || choice === undefined) storage?.removeItem(LINK_PREVIEW_PREF_KEY);
    else storage?.setItem(LINK_PREVIEW_PREF_KEY, choice ? "1" : "0");
  } catch (_) {
    // not remembered: the choice lasts until the page closes
  }
}

const listeners = new Set();
let serverEnabled = false;
let choice = loadLinkPreviewChoice();

const build = () => Object.freeze({ serverEnabled, choice, enabled: serverEnabled && choice !== false });
let current = build();

/** { serverEnabled, choice, enabled }: the same object until something changes. */
export const getLinkPreviewPrefs = () => current;

export function subscribeLinkPreviewPrefs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish() {
  const next = build();
  if (next.serverEnabled === current.serverEnabled && next.choice === current.choice) return;
  current = next;
  listeners.forEach((listener) => listener());
}

/** What the server says (/api/app/info). Anything but true or false is ignored. */
export function setLinkPreviewsServerEnabled(value) {
  if (typeof value !== "boolean") return;
  serverEnabled = value;
  publish();
}

/** The person's choice: true, false, or null to follow the server again. Remembered on this device. */
export function setLinkPreviewChoice(value, { storage } = {}) {
  choice = value === null || value === undefined ? null : Boolean(value);
  saveLinkPreviewChoice(choice, storage);
  publish();
}

/** Reads the saved choice again (another tab changed it, or a test cleared storage). */
export function reloadLinkPreviewChoice(storage) {
  choice = loadLinkPreviewChoice(storage);
  publish();
}

// Another tab of this browser changed the choice: follow it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === LINK_PREVIEW_PREF_KEY) reloadLinkPreviewChoice();
  });
}
