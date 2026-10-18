import { describe, test, expect, vi, afterEach } from "vitest";
import {
  DEFAULT_EMOJI_SIZE,
  EMOJI_SIZE_ATTRIBUTE,
  EMOJI_SIZE_CHOICES,
  applyEmojiSize,
  getEmojiSize,
  isEmojiSizeChoice,
  loadEmojiSize,
  saveEmojiSize,
  setEmojiSize,
  subscribeEmojiSize,
} from "../../src/emoji/emojiSize.js";
import { MAX_JUMBO_EMOJI, isJumboEmojiText } from "../../src/emoji/emojiImages.js";
import { defaultStorage } from "../../src/utils/safeStorage.js";

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};
const broken = {
  getItem: () => {
    throw new Error("no");
  },
  setItem: () => {
    throw new Error("no");
  },
};
const fakeRoot = () => {
  const attributes = {};
  return { attributes, setAttribute: (name, value) => (attributes[name] = value) };
};

afterEach(() => {
  setEmojiSize(DEFAULT_EMOJI_SIZE, { storage: memory(), root: fakeRoot() });
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the choices", () => {
  test("Large, Medium and Normal, in that order, and nothing else", () => {
    expect(EMOJI_SIZE_CHOICES.map((c) => [c.id, c.label])).toEqual([
      ["large", "Large"],
      ["medium", "Medium"],
      ["normal", "Normal"],
    ]);
    expect(isEmojiSizeChoice("medium")).toBe(true);
    expect(isEmojiSizeChoice("Medium")).toBe(false);
    expect(isEmojiSizeChoice("huge")).toBe(false);
    expect(isEmojiSizeChoice("__proto__")).toBe(false);
    expect(isEmojiSizeChoice(undefined)).toBe(false);
  });

  test("Large is what everybody has until they choose", () => {
    expect(DEFAULT_EMOJI_SIZE).toBe("large");
    expect(EMOJI_SIZE_CHOICES[0].id).toBe(DEFAULT_EMOJI_SIZE);
  });
});

describe("remembering the choice on this device", () => {
  test("nothing remembered means Large", () => {
    expect(loadEmojiSize(memory())).toBe("large");
  });

  test("a saved choice comes back", () => {
    const storage = memory();
    saveEmojiSize("normal", storage);
    expect(loadEmojiSize(storage)).toBe("normal");
    saveEmojiSize("medium", storage);
    expect(loadEmojiSize(storage)).toBe("medium");
  });

  test("something that is not a choice is not saved, and is not believed when read", () => {
    const storage = memory();
    saveEmojiSize("medium", storage);
    saveEmojiSize("huge", storage);
    expect(loadEmojiSize(storage)).toBe("medium");
    storage.setItem("aurelle-emoji-size", "tiny");
    expect(loadEmojiSize(storage)).toBe("large");
    storage.setItem("aurelle-emoji-size", JSON.stringify({ size: "normal" }));
    expect(loadEmojiSize(storage)).toBe("large");
  });

  test("storage that fails or is blocked never throws: Large, and the choice is just not kept", () => {
    expect(loadEmojiSize(broken)).toBe("large");
    expect(() => saveEmojiSize("normal", broken)).not.toThrow();
    expect(loadEmojiSize(null)).toBe("large");
    expect(() => saveEmojiSize("normal", null)).not.toThrow();
  });

  test("a browser that blocks site data is no storage at all", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      expect(defaultStorage()).toBeNull();
      expect(loadEmojiSize()).toBe("large");
      expect(() => saveEmojiSize("normal")).not.toThrow();
    } finally {
      delete globalThis.localStorage;
    }
  });
});

describe("putting the choice on the page", () => {
  test("sets data-emoji-size on the root", () => {
    const root = fakeRoot();
    applyEmojiSize("medium", root);
    expect(root.attributes[EMOJI_SIZE_ATTRIBUTE]).toBe("medium");
    expect(EMOJI_SIZE_ATTRIBUTE).toBe("data-emoji-size");
  });

  test("nonsense counts as Large, and no page at all is fine", () => {
    const root = fakeRoot();
    applyEmojiSize("huge", root);
    expect(root.attributes[EMOJI_SIZE_ATTRIBUTE]).toBe("large");
    expect(() => applyEmojiSize("normal", null)).not.toThrow();
  });
});

describe("changing the choice", () => {
  test("applies at once, is remembered, and tells whoever is listening", () => {
    const storage = memory();
    const root = fakeRoot();
    const heard = vi.fn();
    const stop = subscribeEmojiSize(heard);
    setEmojiSize("normal", { storage, root });
    expect(getEmojiSize()).toBe("normal");
    expect(root.attributes[EMOJI_SIZE_ATTRIBUTE]).toBe("normal");
    expect(loadEmojiSize(storage)).toBe("normal");
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
  });

  test("choosing what is already chosen tells nobody", () => {
    const heard = vi.fn();
    setEmojiSize("medium", { storage: memory(), root: fakeRoot() });
    const stop = subscribeEmojiSize(heard);
    setEmojiSize("medium", { storage: memory(), root: fakeRoot() });
    expect(heard).not.toHaveBeenCalled();
    stop();
  });

  test("nobody is told after they stopped listening", () => {
    const heard = vi.fn();
    const stop = subscribeEmojiSize(heard);
    stop();
    setEmojiSize("normal", { storage: memory(), root: fakeRoot() });
    expect(heard).not.toHaveBeenCalled();
  });

  test("something that is not a choice becomes Large", () => {
    const storage = memory();
    setEmojiSize("medium", { storage, root: fakeRoot() });
    setEmojiSize("huge", { storage, root: fakeRoot() });
    expect(getEmojiSize()).toBe("large");
    expect(loadEmojiSize(storage)).toBe("large");
  });
});

describe("on first paint", () => {
  const fakePage = (saved) => {
    const root = fakeRoot();
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: () => {} });
    return root;
  };

  test("a remembered size is on <html> as soon as the module is loaded, before any message is drawn", async () => {
    const root = fakePage("medium");
    vi.resetModules();
    const fresh = await import("../../src/emoji/emojiSize.js");
    expect(root.attributes["data-emoji-size"]).toBe("medium");
    expect(fresh.getEmojiSize()).toBe("medium");
  });

  test("with nothing remembered it is Large", async () => {
    const root = fakePage(null);
    vi.resetModules();
    await import("../../src/emoji/emojiSize.js");
    expect(root.attributes["data-emoji-size"]).toBe("large");
  });

  test("the emoji renderer brings it in, so nothing else has to remember to", async () => {
    const root = fakePage("normal");
    vi.resetModules();
    await import("../../src/emoji/emojiImages.js");
    expect(root.attributes["data-emoji-size"]).toBe("normal");
  });
});

describe("which messages the choice is about", () => {
  test("only one to three emoji with no other text: the very rule the picture class is given by", () => {
    expect(MAX_JUMBO_EMOJI).toBe(3);
    expect(isJumboEmojiText("😀".repeat(MAX_JUMBO_EMOJI))).toBe(true);
    expect(isJumboEmojiText("😀".repeat(MAX_JUMBO_EMOJI + 1))).toBe(false);
    expect(isJumboEmojiText("ok 😀")).toBe(false);
  });
});
