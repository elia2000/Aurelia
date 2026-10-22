import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  CALL_SHORTCUT_KEY,
  DEFAULT_CALL_SHORTCUTS_ENABLED,
  getCallShortcutsEnabled,
  loadCallShortcutsEnabled,
  reloadCallShortcutsEnabled,
  saveCallShortcutsEnabled,
  setCallShortcutsEnabled,
  subscribeCallShortcuts,
} from "../../src/calls/callShortcutPrefs.js";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
};
const blocked = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
};

describe("the call shortcut switch of this device", () => {
  test("the letter keys are on until the person says otherwise", () => {
    expect(DEFAULT_CALL_SHORTCUTS_ENABLED).toBe(true);
    expect(loadCallShortcutsEnabled(memory())).toBe(true);
    expect(loadCallShortcutsEnabled(null)).toBe(true);
  });

  test("reads back what was saved, as 1 and 0 like the call sound switches", () => {
    const storage = memory();
    saveCallShortcutsEnabled(false, storage);
    expect(storage.data.get(CALL_SHORTCUT_KEY)).toBe("0");
    expect(loadCallShortcutsEnabled(storage)).toBe(false);
    saveCallShortcutsEnabled(true, storage);
    expect(storage.data.get(CALL_SHORTCUT_KEY)).toBe("1");
    expect(loadCallShortcutsEnabled(storage)).toBe(true);
  });

  test("rubbish in storage means the default", () => {
    for (const value of ["maybe", "", "false", "2"]) {
      expect(loadCallShortcutsEnabled(memory({ [CALL_SHORTCUT_KEY]: value }))).toBe(true);
    }
  });

  test("a browser that blocks site data changes nothing and breaks nothing", () => {
    expect(loadCallShortcutsEnabled(blocked)).toBe(true);
    expect(() => saveCallShortcutsEnabled(false, blocked)).not.toThrow();
  });

  test("the key is a per-device one next to the call sound preferences", () => {
    expect(CALL_SHORTCUT_KEY).toBe("aurelle-call-shortcuts");
  });
});

describe("the shared store", () => {
  beforeEach(() => setCallShortcutsEnabled(true, { storage: memory() }));

  test("a change reaches everyone listening, once, and is saved on this device", () => {
    const storage = memory();
    const listener = vi.fn();
    const off = subscribeCallShortcuts(listener);
    setCallShortcutsEnabled(false, { storage });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCallShortcutsEnabled()).toBe(false);
    expect(storage.data.get(CALL_SHORTCUT_KEY)).toBe("0");
    off();
    setCallShortcutsEnabled(true, { storage });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getCallShortcutsEnabled()).toBe(true);
  });

  test("setting what already is makes no noise", () => {
    const listener = vi.fn();
    const off = subscribeCallShortcuts(listener);
    setCallShortcutsEnabled(true, { storage: memory() });
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  test("the choice holds for this page even when it cannot be saved", () => {
    setCallShortcutsEnabled(false, { storage: blocked });
    expect(getCallShortcutsEnabled()).toBe(false);
  });

  test("a change made in another tab is followed", () => {
    reloadCallShortcutsEnabled(memory({ [CALL_SHORTCUT_KEY]: "0" }));
    expect(getCallShortcutsEnabled()).toBe(false);
    reloadCallShortcutsEnabled(memory());
    expect(getCallShortcutsEnabled()).toBe(true);
  });
});
