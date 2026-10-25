import { describe, expect, test } from "vitest";
import { DEFAULT_API_RATE_LIMIT, DEFAULT_STATIC_RATE_LIMIT, rateLimitMax } from "../../lib/rateLimitSettings.js";

describe("rateLimitMax", () => {
  test("the defaults leave room for several people behind one VPN or proxy address", () => {
    expect(DEFAULT_API_RATE_LIMIT).toBeGreaterThanOrEqual(10000);
    expect(DEFAULT_STATIC_RATE_LIMIT).toBeGreaterThanOrEqual(5000);
  });
  test("takes a positive whole number from the environment, otherwise the default", () => {
    expect(rateLimitMax("25000", 10000)).toBe(25000);
    expect(rateLimitMax(" 300 ", 10000)).toBe(300);
    for (const bad of [undefined, "", "abc", "-5", "0", "1.5", "1e9999"]) expect(rateLimitMax(bad, 10000)).toBe(10000);
  });
});
