// Keyboard shortcuts of the call screen. This file is the pure part: which key
// means what, when a key press must be left alone (typing, a window on top,
// modifier keys), and a dispatcher that ties the two to the call's actions.
// useCallShortcuts.js attaches it to the page.

/**
 * What the shortcuts are, in the order the cheat sheet shows them. `keys` is
 * what is drawn on the key caps; `label` is the action.
 */
export const CALL_SHORTCUTS = Object.freeze([
  { id: "mute", keys: ["M"], label: "Mute or unmute the microphone" },
  { id: "camera", keys: ["V"], label: "Turn the camera on or off" },
  { id: "screen", keys: ["S"], label: "Share your screen, or stop sharing" },
  { id: "pip", keys: ["P"], label: "Picture in picture" },
  { id: "fullscreen", keys: ["F"], label: "Full screen" },
  { id: "minimise", keys: ["Esc"], label: "Minimise the call" },
  { id: "hangup", keys: ["Shift", "H"], label: "End the call" },
  { id: "help", keys: ["?"], label: "Show this list" },
]);

const LETTER_ACTIONS = Object.freeze({ m: "mute", v: "camera", s: "screen", p: "pip", f: "fullscreen" });
const QUESTION_MARKS = new Set(["?", "؟"]); // the Persian one too

// Input types that take no typing: letters pass through a focused checkbox, slider or button.
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "image", "file", "color"]);
const TEXT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** True when a key pressed on `target` is for typing, not for a shortcut. */
export function isTypingTarget(target) {
  if (!target || typeof target.tagName !== "string") return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has(String(target.type || "text").toLowerCase());
  const role = target.getAttribute?.("role");
  return Boolean(role && TEXT_ROLES.has(role.toLowerCase()));
}

/**
 * True when something other than the call is in front: a modal window, a
 * menu, or any other dialog. Keys then belong to it. The call's own card is a
 * dialog too, so it is named to be left out.
 */
export function windowOnTop(doc, callCard = null) {
  if (!doc?.querySelector) return false;
  if (doc.querySelector('[aria-modal="true"], [role="menu"]')) return true;
  return [...doc.querySelectorAll('[role="dialog"]')].some((dialog) => dialog !== callCard);
}

/**
 * The shortcut a key press stands for, or null. Nothing with Ctrl, Cmd or Alt
 * (those belong to the browser and the system), no repeats (holding M must not
 * flap the microphone), and no half-typed composition. Letters are matched on
 * the key, and on the physical key when the layout has no Latin letters (a
 * Persian keyboard), so the shortcuts work in either.
 * @returns {string|null} an id of CALL_SHORTCUTS
 */
export function shortcutFor(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || event.keyCode === 229) return null;
  const { key, code, shiftKey } = event;
  if (key === "Escape") return shiftKey ? null : "minimise";
  if (QUESTION_MARKS.has(key) || (shiftKey && code === "Slash")) return "help";
  const letter = /^[a-z]$/i.test(key || "") ? key.toLowerCase() : /^Key([A-Z])$/.exec(code || "")?.[1].toLowerCase();
  if (!letter) return null;
  // Hanging up needs Shift, so that it is never one slip of the finger.
  if (shiftKey) return letter === "h" ? "hangup" : null;
  return LETTER_ACTIONS[letter] ?? null;
}

/**
 * The key handler of the call screen.
 * `getActions()` returns `{ [id]: (event) => boolean | void }`; an action that
 * returns false (or is missing) declined, and the key goes on to whoever else
 * wants it. `getCard()` is the call card, `doc` the document.
 * @returns {(event: KeyboardEvent) => boolean} whether the key was taken
 */
export function createShortcutHandler({ getActions, getCard = () => null, doc = typeof document === "undefined" ? null : document }) {
  return function onKeyDown(event) {
    if (event.defaultPrevented) return false;
    const id = shortcutFor(event);
    if (!id) return false;
    if (isTypingTarget(event.target) || isTypingTarget(doc?.activeElement)) return false;
    if (windowOnTop(doc, getCard())) return false;
    const action = getActions()?.[id];
    if (!action || action(event) === false) return false;
    // Taken: not typed into the page, and not also the page's own Escape (which closes the open chat).
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
}
