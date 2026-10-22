import { describe, expect, test } from "vitest";
import { createTtlCache } from "../../lib/linkPreview/cache.js";

function clock(start = 1_000_000) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms) => (state.at += ms) };
}

describe("expiry", () => {
  test("an entry lasts for its own time to live", () => {
    const time = clock();
    const cache = createTtlCache({ now: time.now });
    cache.set("a", 1, 1000);
    cache.set("b", 2, 5000);
    time.advance(999);
    expect(cache.get("a")).toBe(1);
    time.advance(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    time.advance(4000);
    expect(cache.get("b")).toBeUndefined();
  });

  test("setting a key again replaces the value and the time", () => {
    const time = clock();
    const cache = createTtlCache({ now: time.now });
    cache.set("a", 1, 100);
    time.advance(90);
    cache.set("a", 2, 100);
    time.advance(90);
    expect(cache.get("a")).toBe(2);
    expect(cache.size).toBe(1);
  });

  test("expired entries leave first when room is needed", () => {
    const time = clock();
    const cache = createTtlCache({ maxEntries: 2, now: time.now });
    cache.set("old", 1, 100);
    cache.set("fresh", 2, 10_000);
    cache.get("old"); // recently used, but expired by the time room is needed
    time.advance(200);
    cache.set("new", 3, 10_000);
    expect(cache.has("fresh")).toBe(true);
    expect(cache.has("new")).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe("size limits", () => {
  test("the least recently used entry goes first", () => {
    const cache = createTtlCache({ maxEntries: 3 });
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.set("c", 3, 1000);
    cache.get("a"); // a is now the most recent
    cache.set("d", 4, 1000);
    expect(cache.has("b")).toBe(false);
    expect([...["a", "c", "d"]].every((key) => cache.has(key))).toBe(true);
    expect(cache.size).toBe(3);
  });

  test("a byte budget evicts until the new entry fits", () => {
    const cache = createTtlCache({ maxBytes: 100, sizeOf: (value) => value.length });
    cache.set("a", "x".repeat(40), 1000);
    cache.set("b", "x".repeat(40), 1000);
    expect(cache.bytes).toBe(80);
    cache.set("c", "x".repeat(40), 1000);
    expect(cache.has("a")).toBe(false);
    expect(cache.bytes).toBe(80);
  });

  test("an entry bigger than the whole budget is not stored (and evicts nothing)", () => {
    const cache = createTtlCache({ maxBytes: 100, sizeOf: (value) => value.length });
    cache.set("a", "x".repeat(40), 1000);
    expect(cache.set("huge", "x".repeat(101), 1000)).toBe(false);
    expect(cache.has("huge")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  test("replacing an entry gives its bytes back first", () => {
    const cache = createTtlCache({ maxBytes: 100, sizeOf: (value) => value.length });
    cache.set("a", "x".repeat(90), 1000);
    cache.set("a", "x".repeat(95), 1000);
    expect(cache.bytes).toBe(95);
    expect(cache.size).toBe(1);
  });

  test("delete and clear", () => {
    const cache = createTtlCache({ sizeOf: (value) => value.length });
    cache.set("a", "xx", 1000);
    cache.set("b", "yyy", 1000);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.bytes).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
