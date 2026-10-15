import { describe, test, expect } from "vitest";
import {
  isBase64Url,
  isValidP256PublicKey,
  sanitizeDeviceLabel,
} from "../../lib/e2eeKeys.js";
import { makeP256PublicKey } from "../helpers/p256.js";

describe("isValidP256PublicKey", () => {
  test("accepts a real uncompressed P-256 point", () => {
    expect(isValidP256PublicKey(makeP256PublicKey())).toBe(true);
  });

  test("rejects a point that is not on the curve", () => {
    const raw = Buffer.alloc(65, 1);
    raw[0] = 0x04;
    expect(isValidP256PublicKey(raw.toString("base64url"))).toBe(false);
  });

  test("rejects wrong length, compressed prefix and non-strings", () => {
    const good = Buffer.from(makeP256PublicKey(), "base64url");
    expect(isValidP256PublicKey(good.subarray(0, 64).toString("base64url"))).toBe(false);
    const compressedPrefix = Buffer.from(good);
    compressedPrefix[0] = 0x02;
    expect(isValidP256PublicKey(compressedPrefix.toString("base64url"))).toBe(false);
    expect(isValidP256PublicKey(null)).toBe(false);
    expect(isValidP256PublicKey(42)).toBe(false);
    expect(isValidP256PublicKey("")).toBe(false);
  });

  test("rejects standard base64 (padding / + /) so formats stay unambiguous", () => {
    const good = Buffer.from(makeP256PublicKey(), "base64url").toString("base64");
    if (/[+/=]/.test(good)) {
      expect(isValidP256PublicKey(good)).toBe(false);
    }
  });
});

describe("isBase64Url", () => {
  test("enforces byte bounds", () => {
    expect(isBase64Url(Buffer.alloc(12).toString("base64url"), { minBytes: 12, maxBytes: 12 })).toBe(true);
    expect(isBase64Url(Buffer.alloc(11).toString("base64url"), { minBytes: 12, maxBytes: 12 })).toBe(false);
    expect(isBase64Url(Buffer.alloc(13).toString("base64url"), { minBytes: 12, maxBytes: 12 })).toBe(false);
  });
  test("rejects length 1 mod 4 (cannot be valid base64url)", () => {
    expect(isBase64Url("abcde")).toBe(false);
  });
});

describe("sanitizeDeviceLabel", () => {
  test("strips control characters, collapses whitespace and caps length", () => {
    expect(sanitizeDeviceLabel("  My \u0000 Phone\n\t ")).toBe("My Phone");
    expect(sanitizeDeviceLabel("x".repeat(200))).toHaveLength(60);
    expect(sanitizeDeviceLabel("   ")).toBeNull();
    expect(sanitizeDeviceLabel(undefined)).toBeNull();
  });
});
