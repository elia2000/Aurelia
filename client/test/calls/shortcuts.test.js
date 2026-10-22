import { describe, test, expect, vi } from "vitest";
import {
  CALL_SHORTCUTS,
  LETTER_SHORTCUT_IDS,
  createShortcutHandler,
  focusIsOnCall,
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

describe("focusIsOnCall: where the call's keys apply", () => {
  const card = { contains: (node) => node === card || node?.inCard === true };
  const body = { tagName: "BODY" };
  const doc = (activeElement) => ({ activeElement, body, documentElement: { tagName: "HTML" } });

  test("on the bare page (nothing, the body or the root focused)", () => {
    expect(focusIsOnCall(doc(null), card)).toBe(true);
    expect(focusIsOnCall(doc(undefined), card)).toBe(true);
    expect(focusIsOnCall(doc(body), card)).toBe(true);
    const root = { tagName: "HTML" };
    expect(focusIsOnCall({ activeElement: root, body, documentElement: root }, card)).toBe(true);
  });

  test("on the call card or anything inside it", () => {
    expect(focusIsOnCall(doc(card), card)).toBe(true);
    expect(focusIsOnCall(doc({ inCard: true }), card)).toBe(true);
  });

  test("not on a control of the page behind the card (the chat list, a message, the header)", () => {
    expect(focusIsOnCall(doc({ inCard: false }), card)).toBe(false);
    expect(focusIsOnCall(doc({ inCard: false }), null)).toBe(false);
  });

  test("a missing document is nothing to object to", () => {
    expect(focusIsOnCall(null, card)).toBe(true);
  });
});

describe("createShortcutHandler: the switch for the letter keys and the focus rule", () => {
  const BODY = { tagName: "BODY" };
  const behind = { tagName: "BUTTON", getAttribute: () => null }; // a chat row
  const card = { contains: (node) => node === card || node?.inCard === true };
  const docWith = (activeElement) => ({
    activeElement,
    body: BODY,
    documentElement: { tagName: "HTML" },
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const setup = (actions, { active = BODY, lettersEnabled = () => true } = {}) =>
    createShortcutHandler({ getActions: () => actions, getCard: () => card, doc: docWith(active), lettersEnabled });
  const press = (handler, k, extra = {}) => {
    const event = key(k, { target: extra.target || BODY, ...extra });
    return { taken: handler(event), event };
  };

  test("the letter keys are exactly M, V, S, P and F", () => {
    expect([...LETTER_SHORTCUT_IDS].sort()).toEqual(["camera", "fullscreen", "mute", "pip", "screen"]);
  });

  test("switched off, the letter keys pass untouched", () => {
    const actions = { mute: vi.fn(), camera: vi.fn(), screen: vi.fn(), pip: vi.fn(), fullscreen: vi.fn() };
    const handler = setup(actions, { lettersEnabled: () => false });
    for (const letter of ["m", "v", "s", "p", "f"]) {
      const { taken, event } = press(handler, letter);
      expect(taken, letter).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  test("switched off, Escape, ? and Shift+H are as always", () => {
    const actions = { minimise: vi.fn(), help: vi.fn(), hangup: vi.fn() };
    const handler = setup(actions, { lettersEnabled: () => false });
    expect(press(handler, "Escape").taken).toBe(true);
    expect(press(handler, "?", { shiftKey: true }).taken).toBe(true);
    expect(press(handler, "H", { shiftKey: true }).taken).toBe(true);
    expect(actions.minimise).toHaveBeenCalledTimes(1);
    expect(actions.help).toHaveBeenCalledTimes(1);
    expect(actions.hangup).toHaveBeenCalledTimes(1);
  });

  test("the switch is asked at every key press, so a change applies at once", () => {
    const mute = vi.fn();
    let on = true;
    const handler = setup({ mute }, { lettersEnabled: () => on });
    expect(press(handler, "m").taken).toBe(true);
    on = false;
    expect(press(handler, "m").taken).toBe(false);
    on = true;
    expect(press(handler, "m").taken).toBe(true);
    expect(mute).toHaveBeenCalledTimes(2);
  });

  test("with the focus on the page behind the card, the letters and the other keys are left alone", () => {
    const actions = { mute: vi.fn(), screen: vi.fn(), help: vi.fn(), hangup: vi.fn() };
    const handler = setup(actions, { active: behind });
    for (const [k, extra] of [["m", {}], ["s", {}], ["?", { shiftKey: true }], ["H", { shiftKey: true }]]) {
      const { taken, event } = press(handler, k, { ...extra, target: behind });
      expect(taken, k).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  test("Escape still minimises the call from anywhere, so it is never also the chat's Escape", () => {
    const minimise = vi.fn();
    const handler = setup({ minimise }, { active: behind });
    const { taken, event } = press(handler, "Escape", { target: behind });
    expect(taken).toBe(true);
    expect(minimise).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  test("with the focus on the card, or inside it, the keys work", () => {
    const mute = vi.fn();
    expect(press(setup({ mute }, { active: card }), "m").taken).toBe(true);
    expect(press(setup({ mute }, { active: { tagName: "BUTTON", inCard: true, getAttribute: () => null } }), "m").taken).toBe(true);
    expect(mute).toHaveBeenCalledTimes(2);
  });
});

