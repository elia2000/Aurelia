import { describe, test, expect } from "vitest";
import { generateOrderedUuid, generateUuid, isValidUuid } from "../../lib/uuidUtils.js";

describe("uuidUtils", () => {
  describe("generateUuid", () => {
    test("returns a valid UUID string matching v4 pattern", () => {
      const uuid = generateUuid();
      expect(typeof uuid).toBe("string");
      expect(isValidUuid(uuid)).toBe(true);
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    test("generates unique UUIDs across multiple calls", () => {
      const count = 100;
      const set = new Set(Array.from({ length: count }, () => generateUuid()));
      expect(set.size).toBe(count);
    });
  });

  describe("generateOrderedUuid", () => {
    // The clock is passed in, and each test starts later than the one before,
    // because the generator never goes back to an earlier time.
    const base = Date.now() + 10 * 60 * 1000;

    test("is a valid UUID (version 7 layout, RFC variant)", () => {
      const uuid = generateOrderedUuid(base);
      expect(isValidUuid(uuid)).toBe(true);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    test("later ids sort after earlier ones, also many inside one millisecond", () => {
      const ids = Array.from({ length: 5000 }, () => generateOrderedUuid(base + 1000));
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(ids);
    });

    test("follows the clock across milliseconds", () => {
      const a = generateOrderedUuid(base + 2000);
      const b = generateOrderedUuid(base + 2001);
      const c = generateOrderedUuid(base + 90_000);
      expect([a, b, c].sort()).toEqual([a, b, c]);
    });

    test("never goes backwards when the clock does", () => {
      const a = generateOrderedUuid(base + 200_000);
      const b = generateOrderedUuid(base + 100_000);
      expect(a < b).toBe(true);
    });

    test("without an argument it uses the current time", () => {
      const before = Date.now();
      const uuid = generateOrderedUuid();
      const stamp = parseInt(uuid.replace(/-/g, "").slice(0, 12), 16);
      expect(stamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe("isValidUuid", () => {
    test("returns true for valid UUID v4 strings in various casings", () => {
      expect(isValidUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
      expect(isValidUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
      expect(isValidUuid("123e4567-E89b-12D3-a456-426614174000")).toBe(true);
      expect(isValidUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
      expect(isValidUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(true);
    });

    test("returns true for valid UUID with surrounding whitespace", () => {
      expect(isValidUuid("  123e4567-e89b-12d3-a456-426614174000  ")).toBe(true);
      expect(isValidUuid("\t123e4567-e89b-12d3-a456-426614174000\n")).toBe(true);
    });

    test("returns false for non-string or empty inputs", () => {
      expect(isValidUuid("")).toBe(false);
      expect(isValidUuid("   ")).toBe(false);
      expect(isValidUuid(null)).toBe(false);
      expect(isValidUuid(undefined)).toBe(false);
      expect(isValidUuid(12345)).toBe(false);
      expect(isValidUuid({})).toBe(false);
      expect(isValidUuid([])).toBe(false);
      expect(isValidUuid(true)).toBe(false);
    });

    test("returns false for invalid or malformed strings", () => {
      expect(isValidUuid("invalid-uuid-string")).toBe(false);
      expect(isValidUuid("12345")).toBe(false);
      // Missing hyphens
      expect(isValidUuid("123e4567e89b12d3a456426614174000")).toBe(false);
      // Extra characters / wrong segment lengths
      expect(isValidUuid("123e4567-e89b-12d3-a456-4266141740000")).toBe(false);
      expect(isValidUuid("123e45670-e89b-12d3-a456-426614174000")).toBe(false);
      // Non-hex characters
      expect(isValidUuid("123e4567-e89b-12d3-a456-42661417400g")).toBe(false);
      expect(isValidUuid("g23e4567-e89b-12d3-a456-426614174000")).toBe(false);
      // Extra hyphens
      expect(isValidUuid("123e4567--e89b-12d3-a456-426614174000")).toBe(false);
      // Prefix/suffix attached
      expect(isValidUuid("id:123e4567-e89b-12d3-a456-426614174000")).toBe(false);
      expect(isValidUuid("123e4567-e89b-12d3-a456-426614174000-extra")).toBe(false);
    });
  });
});
