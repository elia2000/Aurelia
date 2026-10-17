import { describe, test, expect } from "vitest";
import {
  clampReactionsPerUser,
  isServiceMessageBody,
  normalizeReactionEmoji,
  parseReactRequestEmoji,
  planReactionChange,
  summarizeReactionRows,
  toReactionCounts,
} from "../../lib/reactions.js";

describe("normalizeReactionEmoji", () => {
  test.each([
    ["thumbs up", "\u{1F44D}"],
    ["red heart with variation selector", "❤️"],
    ["skin tone modifier", "\u{1F44D}\u{1F3FD}"],
    ["family (ZWJ sequence)", "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"],
    ["flag (regional indicators)", "\u{1F1EE}\u{1F1F7}"],
    ["keycap", "1️⃣"],
    ["England flag (tag sequence)", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["heart on fire (ZWJ with variation selector)", "❤️‍\u{1F525}"],
    ["face with tears of joy", "\u{1F602}"],
  ])("accepts %s", (_label, emoji) => {
    expect(normalizeReactionEmoji(emoji)).toEqual({ ok: true, emoji });
  });

  test("stores text-style symbols in their emoji spelling so both keyboards agree", () => {
    expect(normalizeReactionEmoji("❤")).toEqual({ ok: true, emoji: "❤️" });
    expect(normalizeReactionEmoji("❤️")).toEqual({ ok: true, emoji: "❤️" });
    expect(normalizeReactionEmoji("1⃣")).toEqual({ ok: true, emoji: "1️⃣" });
    // A skin tone is already the emoji spelling; nothing is appended.
    expect(normalizeReactionEmoji("☝\u{1F3FD}")).toEqual({
      ok: true,
      emoji: "☝\u{1F3FD}",
    });
  });

  test.each([
    ["empty string", ""],
    ["plain letter", "a"],
    ["word", "like"],
    ["digit without keycap", "1"],
    ["two emoji", "\u{1F44D}\u{1F44D}"],
    ["emoji followed by text", "\u{1F44D}a"],
    ["leading space", " \u{1F44D}"],
    ["trailing newline", "\u{1F44D}\n"],
    ["markup", "<b>\u{1F44D}</b>"],
    ["lone zero width joiner", "‍"],
    ["lone variation selector", "️"],
    ["lone skin tone swatch", "\u{1F3FD}"],
    ["lone regional indicator", "\u{1F1EE}"],
    ["text variation selector", "❤︎"],
    ["longer than 32 UTF-16 units", "\u{1F468}‍".repeat(20) + "\u{1F469}"],
    ["number", 5],
    ["object", { emoji: "\u{1F44D}" }],
    ["array", ["\u{1F44D}"]],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    const result = normalizeReactionEmoji(value);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/single emoji/i);
  });
});

describe("parseReactRequestEmoji", () => {
  test("null and empty string mean remove", () => {
    expect(parseReactRequestEmoji(null)).toEqual({ ok: true, emoji: null });
    expect(parseReactRequestEmoji("")).toEqual({ ok: true, emoji: null });
  });

  test("a missing field is an error, never a silent removal", () => {
    const result = parseReactRequestEmoji(undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  test("a real emoji is validated and canonicalised", () => {
    expect(parseReactRequestEmoji("❤")).toEqual({ ok: true, emoji: "❤️" });
    expect(parseReactRequestEmoji("hello").ok).toBe(false);
  });
});

describe("clampReactionsPerUser", () => {
  test("keeps the value in the supported 1-3 range", () => {
    expect(clampReactionsPerUser(1)).toBe(1);
    expect(clampReactionsPerUser(3)).toBe(3);
    expect(clampReactionsPerUser(0)).toBe(1);
    expect(clampReactionsPerUser(99)).toBe(3);
    expect(clampReactionsPerUser("2")).toBe(2);
    expect(clampReactionsPerUser(null)).toBe(1);
    expect(clampReactionsPerUser(undefined)).toBe(1);
    expect(clampReactionsPerUser("abc")).toBe(1);
  });
});

describe("planReactionChange", () => {
  const A = "\u{1F44D}";
  const B = "❤️";
  const C = "\u{1F525}";
  const D = "\u{1F602}";

  test("adds the first reaction", () => {
    expect(planReactionChange([], A, 1)).toEqual({ add: A, remove: [] });
  });

  test("sending the same emoji again removes it (toggle)", () => {
    expect(planReactionChange([A], A, 1)).toEqual({ add: null, remove: [A] });
    expect(planReactionChange([A, B], B, 2)).toEqual({ add: null, remove: [B] });
  });

  test("with a limit of 1 a different emoji replaces the previous one", () => {
    expect(planReactionChange([A], B, 1)).toEqual({ add: B, remove: [A] });
  });

  test("with a higher limit it keeps older ones until the limit is hit, then drops the oldest", () => {
    expect(planReactionChange([A], B, 2)).toEqual({ add: B, remove: [] });
    expect(planReactionChange([A, B], C, 2)).toEqual({ add: C, remove: [A] });
    expect(planReactionChange([A, B, C], D, 3)).toEqual({ add: D, remove: [A] });
  });

  test("a lowered limit trims down to the new limit", () => {
    expect(planReactionChange([A, B, C], D, 1)).toEqual({ add: D, remove: [A, B, C] });
    expect(planReactionChange([A, B, C], D, 2)).toEqual({ add: D, remove: [A, B] });
  });

  test("null removes every reaction of the person", () => {
    expect(planReactionChange([A, B], null, 3)).toEqual({ add: null, remove: [A, B] });
    expect(planReactionChange([], null, 3)).toEqual({ add: null, remove: [] });
  });
});

describe("summarizeReactionRows", () => {
  test("orders by count desc then by first reaction time and keeps per-message groups", () => {
    const rows = [
      { message_id: "m1", emoji: "B", count: 1, first_at: "2025-01-01T00:00:01.000Z", reacted: 0 },
      { message_id: "m1", emoji: "A", count: 3, first_at: "2025-01-01T00:00:09.000Z", reacted: 1 },
      { message_id: "m1", emoji: "C", count: 1, first_at: "2025-01-01T00:00:00.000Z", reacted: "0" },
      { message_id: "m2", emoji: "D", count: "2", first_at: "2025-01-01T00:00:00.000Z", reacted: "1" },
    ];
    const grouped = summarizeReactionRows(rows);
    expect(grouped.get("m1")).toEqual([
      { emoji: "A", count: 3, reacted: true },
      { emoji: "C", count: 1, reacted: false },
      { emoji: "B", count: 1, reacted: false },
    ]);
    expect(grouped.get("m2")).toEqual([{ emoji: "D", count: 2, reacted: true }]);
    expect(grouped.get("m3")).toBeUndefined();
  });

  test("ignores malformed rows and non-arrays", () => {
    expect(summarizeReactionRows(null).size).toBe(0);
    expect(summarizeReactionRows([{ message_id: null, emoji: "A", count: 1 }]).size).toBe(0);
    expect(summarizeReactionRows([{ message_id: "m", emoji: "", count: 1 }]).size).toBe(0);
  });

  test("toReactionCounts drops the per-viewer flag", () => {
    expect(toReactionCounts([{ emoji: "A", count: 2, reacted: true }])).toEqual([
      { emoji: "A", count: 2 },
    ]);
    expect(toReactionCounts(undefined)).toEqual([]);
  });
});

describe("isServiceMessageBody", () => {
  test("recognises service messages", () => {
    expect(isServiceMessageBody("[[system:member_joined]]")).toBe(true);
    expect(isServiceMessageBody("hello")).toBe(false);
    expect(isServiceMessageBody(null)).toBe(false);
  });
});
