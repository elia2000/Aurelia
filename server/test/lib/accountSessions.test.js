import { describe, expect, test } from "vitest";
import {
  AUTH_METHODS,
  SESSION_MAX_AGE_MS,
  isSessionExpired,
  parseUserAgent,
  serializeSession,
  sortSessions,
  summarizeUserAgent,
  toIsoTimestamp,
} from "../../lib/accountSessions.js";

const UA = {
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  firefoxIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0",
};

describe("summarizeUserAgent", () => {
  test.each([
    [UA.firefoxLinux, "Firefox on Linux"],
    [UA.chromeWindows, "Chrome on Windows"],
    [UA.edgeWindows, "Edge on Windows"],
    [UA.safariMac, "Safari on macOS"],
    [UA.safariIphone, "Safari on iOS"],
    [UA.chromeAndroid, "Chrome on Android"],
    [UA.firefoxIos, "Firefox on iOS"],
    [UA.samsung, "Samsung Internet on Android"],
    [UA.opera, "Opera on Windows"],
  ])("%s", (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  test("keeps neither version numbers nor the raw header", () => {
    for (const ua of Object.values(UA)) {
      const summary = summarizeUserAgent(ua);
      expect(summary).not.toMatch(/\d/);
      expect(summary).not.toContain("Mozilla");
    }
  });

  test("copes with missing and odd headers", () => {
    expect(summarizeUserAgent(undefined)).toBe("Unknown device");
    expect(summarizeUserAgent("")).toBe("Unknown device");
    expect(summarizeUserAgent("curl/8.0")).toBe("Unknown device");
    expect(summarizeUserAgent("X11")).toBe("Unknown browser on Linux");
    expect(parseUserAgent("a".repeat(100000))).toEqual({ browser: "", os: "" });
  });
});

describe("toIsoTimestamp", () => {
  test("reads SQLite style (UTC, no zone)", () => {
    expect(toIsoTimestamp("2026-01-02 03:04:05")).toBe("2026-01-02T03:04:05.000Z");
  });
  test("reads Postgres style text with fractions and a short zone", () => {
    expect(toIsoTimestamp("2026-01-02 03:04:05.123456+00")).toBe("2026-01-02T03:04:05.123Z");
    expect(toIsoTimestamp("2026-01-02 05:04:05+02")).toBe("2026-01-02T03:04:05.000Z");
  });
  test("passes ISO strings and Dates through, and rejects junk", () => {
    expect(toIsoTimestamp("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(toIsoTimestamp(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp("")).toBeNull();
    expect(toIsoTimestamp("yesterday")).toBeNull();
  });
});

describe("expiry", () => {
  test("a session is dead after the cookie's 14 days", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    expect(SESSION_MAX_AGE_MS).toBe(14 * 24 * 3600 * 1000);
    expect(isSessionExpired("2026-01-18 00:00:01", now)).toBe(false);
    expect(isSessionExpired("2026-01-17 23:59:59", now)).toBe(true);
    expect(isSessionExpired(null, now)).toBe(false);
  });
});

describe("serializeSession / sortSessions", () => {
  const row = (over = {}) => ({
    public_id: "p1",
    user_agent: "Firefox on Linux",
    auth_method: AUTH_METHODS.PASSWORD,
    created_at: "2026-01-02 03:04:05",
    last_seen: "2026-01-02 04:00:00",
    ...over,
  });

  test("shape, and never a token", () => {
    const out = serializeSession({ ...row(), token: "secret-token", id: 7 }, "p1");
    expect(out).toEqual({
      id: "p1",
      current: true,
      device: "Firefox on Linux",
      browser: "Firefox",
      os: "Linux",
      method: "password",
      viaPassword: true,
      createdAt: "2026-01-02T03:04:05.000Z",
      lastSeenAt: "2026-01-02T04:00:00.000Z",
    });
    expect(JSON.stringify(out)).not.toContain("secret-token");
  });

  test("current is only the matching one, and a registration is not a password login", () => {
    expect(serializeSession(row(), "other").current).toBe(false);
    expect(serializeSession(row(), null).current).toBe(false);
    expect(serializeSession(row({ auth_method: AUTH_METHODS.REGISTRATION }), "x").viaPassword).toBe(false);
    expect(serializeSession(row({ auth_method: AUTH_METHODS.PASSWORD_2FA }), "x").viaPassword).toBe(true);
    expect(serializeSession(row({ auth_method: null, user_agent: null }), "x")).toMatchObject({
      device: "Unknown device",
      method: null,
      viaPassword: false,
    });
  });

  test("this device first, then by last activity", () => {
    const list = sortSessions([
      serializeSession(row({ public_id: "a", last_seen: "2026-01-01 00:00:00" }), "c"),
      serializeSession(row({ public_id: "b", last_seen: "2026-01-03 00:00:00" }), "c"),
      serializeSession(row({ public_id: "c", last_seen: "2025-12-01 00:00:00" }), "c"),
    ]);
    expect(list.map((s) => s.id)).toEqual(["c", "b", "a"]);
  });
});
