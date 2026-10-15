import { describe, test, expect } from "vitest";
import {
  bytesEqual,
  concatBytes,
  encodeFields,
  fromB64u,
  randomBytes,
  randomUuid,
  toB64u,
} from "../../src/e2ee/encoding.js";

describe("base64url", () => {
  test("round-trips arbitrary bytes at every length mod 3", () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = randomBytes(n);
      const text = toB64u(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(bytesEqual(fromB64u(text), bytes)).toBe(true);
    }
  });

  test("handles large buffers without blowing the argument limit", () => {
    const big = new Uint8Array(300_000).fill(0xab);
    expect(bytesEqual(fromB64u(toB64u(big)), big)).toBe(true);
  });

  test("matches Node's base64url encoding", () => {
    const bytes = randomBytes(65);
    expect(toB64u(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });

  test("rejects invalid input", () => {
    expect(() => fromB64u("ab+/")).toThrow();
    expect(() => fromB64u("a=")).toThrow();
    expect(() => fromB64u("abcde")).toThrow();
  });
});

describe("encodeFields", () => {
  test("is unambiguous: re-splitting the same characters changes the bytes", () => {
    const a = encodeFields("d", ["ab", "c"]);
    const b = encodeFields("d", ["a", "bc"]);
    expect(bytesEqual(a, b)).toBe(false);
  });

  test("domain separates identical field lists", () => {
    expect(bytesEqual(encodeFields("invite", ["x"]), encodeFields("accept", ["x"]))).toBe(false);
  });

  test("field count is part of the encoding", () => {
    expect(bytesEqual(encodeFields("d", ["a", ""]), encodeFields("d", ["a"]))).toBe(false);
  });

  test("accepts raw bytes and strings interchangeably", () => {
    const text = encodeFields("d", ["abc"]);
    const raw = encodeFields("d", [new TextEncoder().encode("abc")]);
    expect(bytesEqual(text, raw)).toBe(true);
  });
});

describe("misc", () => {
  test("concatBytes joins parts in order", () => {
    expect([...concatBytes(new Uint8Array([1]), new Uint8Array([2, 3]))]).toEqual([1, 2, 3]);
  });
  test("bytesEqual is length-aware", () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
    expect(bytesEqual(null, new Uint8Array(1))).toBe(false);
  });
  test("randomUuid looks like a v4 UUID", () => {
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
