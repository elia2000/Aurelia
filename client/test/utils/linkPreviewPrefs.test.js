import { afterEach, describe, expect, test, vi } from "vitest";
import {
  LINK_PREVIEW_PREF_KEY,
  getLinkPreviewPrefs,
  loadLinkPreviewChoice,
  reloadLinkPreviewChoice,
  saveLinkPreviewChoice,
  setLinkPreviewChoice,
  setLinkPreviewsServerEnabled,
  subscribeLinkPreviewPrefs,
} from "../../src/utils/linkPreviewPrefs.js";

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};
const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

afterEach(() => {
  setLinkPreviewChoice(null, { storage: memory() });
  setLinkPreviewsServerEnabled(false);
});

describe("what is saved on the device", () => {
  test("nothing saved means 'follow the server'", () => {
    expect(loadLinkPreviewChoice(memory())).toBeNull();
  });

  test.each([
    ["1", true],
    ["0", false],
    ["yes", null],
    ["", null],
    ["true", null],
  ])("saved %j is read as %j", (saved, expected) => {
    expect(loadLinkPreviewChoice(memory({ [LINK_PREVIEW_PREF_KEY]: saved }))).toBe(expected);
  });

  test("saving and clearing", () => {
    const storage = memory();
    saveLinkPreviewChoice(true, storage);
    expect(storage.data.get(LINK_PREVIEW_PREF_KEY)).toBe("1");
    saveLinkPreviewChoice(false, storage);
    expect(storage.data.get(LINK_PREVIEW_PREF_KEY)).toBe("0");
    saveLinkPreviewChoice(null, storage);
    expect(storage.data.has(LINK_PREVIEW_PREF_KEY)).toBe(false);
  });

  test("a browser that blocks site data neither breaks nor remembers", () => {
    expect(loadLinkPreviewChoice(broken)).toBeNull();
    expect(() => saveLinkPreviewChoice(true, broken)).not.toThrow();
    expect(() => setLinkPreviewChoice(false, { storage: broken })).not.toThrow();
    expect(getLinkPreviewPrefs().choice).toBe(false); // still applies until the page closes
  });

  test("no storage at all", () => {
    expect(loadLinkPreviewChoice(null)).toBeNull();
    expect(() => saveLinkPreviewChoice(true, null)).not.toThrow();
  });
});

describe("whether previews are shown", () => {
  test("off while the server has them off, whatever the person chose", () => {
    setLinkPreviewsServerEnabled(false);
    setLinkPreviewChoice(true, { storage: memory() });
    expect(getLinkPreviewPrefs()).toEqual({ serverEnabled: false, choice: true, enabled: false });
  });

  test("on by default when the server has them on (the person has not chosen)", () => {
    setLinkPreviewsServerEnabled(true);
    expect(getLinkPreviewPrefs()).toEqual({ serverEnabled: true, choice: null, enabled: true });
  });

  test("a person can turn them off, and on again", () => {
    const storage = memory();
    setLinkPreviewsServerEnabled(true);
    setLinkPreviewChoice(false, { storage });
    expect(getLinkPreviewPrefs().enabled).toBe(false);
    expect(storage.data.get(LINK_PREVIEW_PREF_KEY)).toBe("0");
    setLinkPreviewChoice(true, { storage });
    expect(getLinkPreviewPrefs().enabled).toBe(true);
    setLinkPreviewChoice(null, { storage });
    expect(getLinkPreviewPrefs()).toMatchObject({ choice: null, enabled: true });
    expect(storage.data.has(LINK_PREVIEW_PREF_KEY)).toBe(false);
  });

  test("only a real true or false from the server counts", () => {
    setLinkPreviewsServerEnabled(true);
    for (const junk of [undefined, null, "true", 1, 0, {}]) setLinkPreviewsServerEnabled(junk);
    expect(getLinkPreviewPrefs().serverEnabled).toBe(true);
    setLinkPreviewsServerEnabled(false);
    expect(getLinkPreviewPrefs().serverEnabled).toBe(false);
  });

  test("another tab's change is followed", () => {
    const storage = memory();
    setLinkPreviewsServerEnabled(true);
    storage.setItem(LINK_PREVIEW_PREF_KEY, "0");
    reloadLinkPreviewChoice(storage);
    expect(getLinkPreviewPrefs().enabled).toBe(false);
  });
});

describe("listeners", () => {
  test("hear a change, once, and stay quiet when nothing changed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLinkPreviewPrefs(listener);
    setLinkPreviewsServerEnabled(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setLinkPreviewsServerEnabled(true);
    setLinkPreviewChoice(null, { storage: memory() });
    expect(listener).toHaveBeenCalledTimes(1);
    setLinkPreviewChoice(false, { storage: memory() });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setLinkPreviewChoice(true, { storage: memory() });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("the snapshot is the same object until something changes (useSyncExternalStore needs that)", () => {
    const a = getLinkPreviewPrefs();
    expect(getLinkPreviewPrefs()).toBe(a);
    setLinkPreviewsServerEnabled(!a.serverEnabled);
    expect(getLinkPreviewPrefs()).not.toBe(a);
    expect(Object.isFrozen(getLinkPreviewPrefs())).toBe(true);
  });
});
