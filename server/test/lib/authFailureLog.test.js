import { describe, expect, test, vi } from "vitest";
import {
  formatAuthFailure,
  hashAccountName,
  logAuthFailure,
  normalizeIp,
} from "../../lib/authFailureLog.js";

// The shape deploy/fail2ban/filter.d/aurelle-auth.conf relies on.
const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[auth\] auth_failed ip=(\S+) user=([0-9a-f]{12}|-) reason=([a-z0-9_-]+)$/;

describe("normalizeIp", () => {
  test("keeps plain IPv4 and IPv6 addresses", () => {
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("2001:DB8::1")).toBe("2001:db8::1");
  });

  test("turns an IPv4-mapped IPv6 address back into IPv4 and drops a zone id", () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80::1");
  });

  test("returns null for anything that is not an address", () => {
    for (const value of ["", "   ", null, undefined, "unknown", "1.2.3.4 auth_failed", "1.2.3.4\nx", "999.1.1.1", "a".repeat(100)]) {
      expect(normalizeIp(value)).toBeNull();
    }
  });
});

describe("hashAccountName", () => {
  test("is stable, case/space-insensitive, 12 hex characters and does not contain the name", () => {
    const a = hashAccountName("Alice ");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(hashAccountName("alice")).toBe(a);
    expect(hashAccountName("bob")).not.toBe(a);
    expect(a).not.toContain("alice");
  });

  test("is a dash when there is no name", () => {
    expect(hashAccountName("")).toBe("-");
    expect(hashAccountName(undefined)).toBe("-");
  });
});

describe("formatAuthFailure", () => {
  const at = new Date("2026-10-22T21:30:00.123Z");

  test("writes one line with a fixed shape", () => {
    const line = formatAuthFailure({ ip: "::ffff:203.0.113.9", account: "alice", reason: "2fa" }, at);
    expect(line).toMatch(LINE);
    expect(line.startsWith("2026-10-22T21:30:00.123Z [auth] auth_failed ip=203.0.113.9 user=")).toBe(true);
    expect(line.endsWith(" reason=2fa")).toBe(true);
    expect(line).not.toContain("alice");
  });

  test("an address that is not an address becomes `unknown` and can not add fields or lines", () => {
    const line = formatAuthFailure({ ip: "1.2.3.4 auth_failed ip=5.6.7.8\nforged", account: "x" }, at);
    expect(line).toMatch(LINE);
    expect(line).toContain(" ip=unknown ");
    expect(line.split("\n")).toHaveLength(1);
  });

  test("a missing account is a dash and a bad reason falls back to `credentials`", () => {
    const line = formatAuthFailure({ ip: "198.51.100.4", reason: "Bad Reason!" }, at);
    expect(line).toMatch(LINE);
    expect(line).toContain(" user=- reason=credentials");
  });

  test("never contains the typed account name, even an unknown or odd one", () => {
    for (const account of ["ghost", "p@ssw0rd!", "x".repeat(500), "ali ce\nforged auth_failed"]) {
      const line = formatAuthFailure({ ip: "198.51.100.4", account }, at);
      expect(line).toMatch(LINE);
      expect(line).not.toContain(account.slice(0, 5));
    }
  });
});

describe("logAuthFailure", () => {
  test("hands the line to the sink", () => {
    const sink = vi.fn();
    logAuthFailure({ ip: "198.51.100.4", account: "alice" }, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatch(LINE);
  });

  test("never throws, so a broken log can not break a sign-in", () => {
    expect(() =>
      logAuthFailure({ ip: "198.51.100.4" }, () => {
        throw new Error("stdout closed");
      }),
    ).not.toThrow();
  });
});
