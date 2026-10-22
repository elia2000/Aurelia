import { describe, test, expect, vi } from "vitest";
import {
  CALL_SHORTCUTS,
  createShortcutHandler,
  isTypingTarget,
  shortcutFor,
  windowOnTop,
} from "../../src/calls/shortcuts.js";

// A key event the way the page sees it.
const key = (k, extra = {}) => ({
  key: k,
  code: "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  defaultPrevented: false,
  target: null,
  preventDefault: vi.fn(function prevent() {
    this.defaultPrevented = true;
  }),
  stopPropagation: vi.fn(),
  ...extra,
});

const element = (tagName, extra = {}) => ({ tagName, isContentEditable: false, getAttribute: () => null, ...extra });

describe("shortcutFor: which key is which action", () => {
  // [description, event, expected]
  const table = [
    ["m", key("m"), "mute"],
    ["M with caps lock", key("M"), "mute"],
    ["v", key("v"), "camera"],
    ["s", key("s"), "screen"],
    ["p", key("p"), "pip"],
    ["f", key("f"), "fullscreen"],
    ["Escape", key("Escape"), "minimise"],
    ["Shift+Escape is nothing", key("Escape", { shiftKey: true }), null],
    ["Shift+H", key("H", { shiftKey: true }), "hangup"],
    ["h alone does not hang up", key("h"), null],
    ["Shift+M is not mute", key("M", { shiftKey: true }), null],
    ["?", key("?", { shiftKey: true }), "help"],
    ["? without the shift flag (some keyboards)", key("?"), "help"],
    ["the Persian question mark", key("؟", { shiftKey: true }), "help"],
    ["Shift+/ on any layout", key("/", { shiftKey: true, code: "Slash" }), "help"],
    ["a letter that is nothing", key("x"), null],
    ["a digit", key("1"), null],
    ["Enter", key("Enter"), null],
    ["Space", key(" "), null],
    ["Tab", key("Tab"), null],
    ["Ctrl+M", key("m", { ctrlKey: true }), null],
    ["Cmd+M", key("m", { metaKey: true }), null],
    ["Alt+M", key("m", { altKey: true }), null],
    ["Ctrl+Shift+H", key("H", { ctrlKey: true, shiftKey: true }), null],
    ["Ctrl+Shift+E (the browser's own)", key("E", { ctrlKey: true, shiftKey: true }), null],
    ["a held key (repeat)", key("m", { repeat: true }), null],
    ["a key typed into an input method", key("m", { isComposing: true }), null],
    ["key code 229 (an input method in progress)", key("m", { keyCode: 229 }), null],
    // Another layout: the letter is not Latin, so the physical key decides.
    ["M on a Persian keyboard", key("ئ", { code: "KeyM" }), "mute"],
    ["V on a Persian keyboard", key("ر", { code: "KeyV" }), "camera"],
    ["Shift+H on a Persian keyboard", key("آ", { code: "KeyH", shiftKey: true }), "hangup"],
    ["a Persian letter on a key with no letter name", key("ژ", { code: "Quote" }), null],
    // A layout where the Latin letter sits on another key: the letter wins.
    ["m on AZERTY (the key is a semicolon in a QWERTY layout)", key("m", { code: "Semicolon" }), "mute"],
    ["no event at all", null, null],
  ];
  test.each(table)("%s", (_name, event, expected) => {
    expect(shortcutFor(event)).toBe(expected);
  });

  test("every shortcut in the cheat sheet can be reached", () => {
    const reachable = new Set(
      [key("m"), key("v"), key("s"), key("p"), key("f"), key("Escape"), key("H", { shiftKey: true }), key("?", { shiftKey: true })].map(shortcutFor),
    );
    expect([...reachable].sort()).toEqual(CALL_SHORTCUTS.map((shortcut) => shortcut.id).sort());
    for (const shortcut of CALL_SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.label).toBeTruthy();
    }
  });
});

describe("isTypingTarget: the typing guard", () => {
  test.each([
    ["a text input", element("INPUT", { type: "text" }), true],
    ["an input with no type", element("INPUT"), true],
    ["a search box", element("INPUT", { type: "search" }), true],
    ["a password field", element("INPUT", { type: "password" }), true],
    ["a number field", element("INPUT", { type: "number" }), true],
    ["a text area", element("TEXTAREA"), true],
    ["a select", element("SELECT"), true],
    ["an editable element", element("DIV", { isContentEditable: true }), true],
    ["a text box by role", element("DIV", { getAttribute: (name) => (name === "role" ? "textbox" : null) }), true],
    ["a combo box by role", element("DIV", { getAttribute: (name) => (name === "role" ? "combobox" : null) }), true],
    ["a checkbox", element("INPUT", { type: "checkbox" }), false],
    ["a slider", element("INPUT", { type: "range" }), false],
    ["a radio button", element("INPUT", { type: "radio" }), false],
    ["a button", element("BUTTON"), false],
    ["a plain element", element("DIV"), false],
    ["the page body", element("BODY"), false],
    ["the document itself (no tag)", { nodeType: 9 }, false],
    ["nothing", null, false],
  ])("%s", (_name, target, expected) => {
    expect(isTypingTarget(target)).toBe(expected);
  });
});

describe("windowOnTop", () => {
  const card = { id: "card" };
  const docWith = (matches) => ({
    querySelector: (selector) => (selector.includes("aria-modal") ? matches.modal || matches.menu || null : null),
    querySelectorAll: () => matches.dialogs || [],
  });

  test("a modal or a menu in front takes the keys", () => {
    expect(windowOnTop(docWith({ modal: {} }), card)).toBe(true);
    expect(windowOnTop(docWith({ menu: {} }), card)).toBe(true);
  });

  test("any dialog other than the call's own takes the keys", () => {
    expect(windowOnTop(docWith({ dialogs: [{}] }), card)).toBe(true);
  });

  test("the call's own card does not count", () => {
    expect(windowOnTop(docWith({ dialogs: [card] }), card)).toBe(false);
    expect(windowOnTop(docWith({}), card)).toBe(false);
    expect(windowOnTop(null, card)).toBe(false);
  });
});

describe("createShortcutHandler", () => {
  const setup = (actions, { doc = { activeElement: null, querySelector: () => null, querySelectorAll: () => [] }, card = null } = {}) => {
    const handler = createShortcutHandler({ getActions: () => actions, getCard: () => card, doc });
    return handler;
  };

  test("runs the action and takes the key (no typing, no Escape for the chat behind)", () => {
    const mute = vi.fn();
    const handler = setup({ mute });
    const event = key("m", { target: element("BODY") });
    expect(handler(event)).toBe(true);
    expect(mute).toHaveBeenCalledWith(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  test("does nothing while the person types, in whatever field", () => {
    const mute = vi.fn();
    const handler = setup({ mute });
    for (const target of [element("INPUT", { type: "text" }), element("TEXTAREA"), element("DIV", { isContentEditable: true }), element("SELECT")]) {
      const event = key("m", { target });
      expect(handler(event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(mute).not.toHaveBeenCalled();
  });

  test("does nothing when the focus is in a field even if the event came from elsewhere", () => {
    const mute = vi.fn();
    const handler = setup({ mute }, { doc: { activeElement: element("TEXTAREA"), querySelector: () => null, querySelectorAll: () => [] } });
    expect(handler(key("m", { target: element("BODY") }))).toBe(false);
    expect(mute).not.toHaveBeenCalled();
  });

  test("does nothing with a modifier key held", () => {
    const mute = vi.fn();
    const handler = setup({ mute });
    for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(handler(key("m", { target: element("BODY"), ...extra }))).toBe(false);
    }
    expect(mute).not.toHaveBeenCalled();
  });

  test("does nothing while a modal window is open", () => {
    const mute = vi.fn();
    const doc = { activeElement: null, querySelector: () => ({}), querySelectorAll: () => [] };
    expect(setup({ mute }, { doc })(key("m", { target: element("BODY") }))).toBe(false);
    expect(mute).not.toHaveBeenCalled();
  });

  test("an action that declines leaves the key alone (Escape with the settings open)", () => {
    const minimise = vi.fn(() => false);
    const handler = setup({ minimise });
    const event = key("Escape", { target: element("BODY") });
    expect(handler(event)).toBe(false);
    expect(minimise).toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  test("a shortcut with no action is not taken", () => {
    const event = key("p", { target: element("BODY") });
    expect(setup({})(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("a key somebody already handled is not handled twice", () => {
    const mute = vi.fn();
    const event = key("m", { target: element("BODY"), defaultPrevented: true });
    expect(setup({ mute })(event)).toBe(false);
    expect(mute).not.toHaveBeenCalled();
  });

  test("keys that mean nothing pass untouched", () => {
    const mute = vi.fn();
    const event = key("x", { target: element("BODY") });
    expect(setup({ mute })(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("Shift+H hangs up and plain h does not", () => {
    const hangup = vi.fn();
    const handler = setup({ hangup });
    expect(handler(key("h", { target: element("BODY") }))).toBe(false);
    expect(hangup).not.toHaveBeenCalled();
    expect(handler(key("H", { shiftKey: true, target: element("BODY") }))).toBe(true);
    expect(hangup).toHaveBeenCalledTimes(1);
  });
});
