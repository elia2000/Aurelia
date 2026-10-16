import { describe, test, expect, beforeAll } from "vitest";
import raw from "emoji-datasource-apple/emoji.json";
import {
  CATEGORY_ORDER,
  SKIN_TONES,
  addRecent,
  applySkinTone,
  buildEmojiIndex,
  loadRecent,
  searchEmoji,
} from "../../src/emoji/emojiData.js";

let index;
beforeAll(() => {
  index = buildEmojiIndex(raw);
});

describe("buildEmojiIndex", () => {
  test("groups the emoji in Telegram's order and leaves out what has no picture", () => {
    expect(index.categories.map((c) => c.id)).toEqual(CATEGORY_ORDER);
    expect(index.categories).toHaveLength(9);
    const all = index.categories.flatMap((c) => c.emojis);
    expect(all.length).toBeGreaterThan(1800);
    expect(all.every((e) => e.image && e.char)).toBe(true);
    expect(index.categories[0].emojis[0].char).toBe("😀");
  });

  test("builds the real characters, including the variation selector where it is needed", () => {
    const all = index.categories.flatMap((c) => c.emojis);
    expect(all.find((e) => e.shortName === "heart").char).toBe("❤️");
    expect(all.find((e) => e.shortName === "flag-ir").char).toBe("🇮🇷");
  });
});

describe("searchEmoji", () => {
  test("finds by name or short name, exact matches first", () => {
    const hits = searchEmoji(index, "heart");
    expect(hits.length).toBeGreaterThan(10);
    expect(hits[0].shortName).toBe("heart");
    expect(searchEmoji(index, "  FIRE ")[0].char).toBe("🔥");
  });
  test("nothing for an empty or unknown search", () => {
    expect(searchEmoji(index, "")).toEqual([]);
    expect(searchEmoji(index, "qqqqzzzz")).toEqual([]);
  });
});

describe("skin tones", () => {
  const wave = () => index.categories.flatMap((c) => c.emojis).find((e) => e.shortName === "wave");
  test("an emoji that has tones can wear one", () => {
    const tone = SKIN_TONES.find((t) => t.id === "1F3FD"); // medium
    const out = applySkinTone(wave(), tone.id);
    expect(out.char).toBe("👋🏽");
    expect(out.image).toBe("1f44b-1f3fd.png");
  });
  test("the default tone, and emoji with no tones, stay as they are", () => {
    expect(applySkinTone(wave(), "default").char).toBe("👋");
    const fire = searchEmoji(index, "fire")[0];
    expect(applySkinTone(fire, "1F3FD")).toBe(fire);
  });
});

describe("recently used", () => {
  const memory = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
  };
  test("newest first, no repeats, at most 24", () => {
    const storage = memory();
    addRecent("😀", storage);
    addRecent("❤️", storage);
    addRecent("😀", storage);
    expect(loadRecent(storage)).toEqual(["😀", "❤️"]);
    for (let i = 0; i < 40; i += 1) addRecent(String.fromCodePoint(0x1f600 + i), storage);
    expect(loadRecent(storage)).toHaveLength(24);
  });
  test("a broken store is an empty list", () => {
    expect(loadRecent({ getItem: () => "{not json" })).toEqual([]);
    expect(loadRecent(null)).toEqual([]);
  });
});
