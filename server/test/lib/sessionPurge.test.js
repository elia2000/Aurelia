import { describe, expect, test, vi } from "vitest";
import { createSessionPurger } from "../../lib/sessionPurge.js";
import { SESSION_MAX_AGE_MS, liveSessionOrNull } from "../../lib/accountSessions.js";

describe("session purge", () => {
  const NOW = Date.parse("2026-03-15T12:00:00Z");
  const quiet = { warn: vi.fn() };

  test("closes the live streams of the sessions it removes, then removes them, with the 14 day cutoff", async () => {
    const calls = [];
    const purge = createSessionPurger({
      listExpiredSessionIds: async (cutoff) => {
        calls.push(["list", cutoff]);
        return ["p1", "p2"];
      },
      purgeExpiredSessions: async (cutoff) => {
        calls.push(["purge", cutoff]);
        return 2;
      },
      closeSessionStreams: (target) => calls.push(["close", target]),
      now: () => NOW,
      logger: quiet,
    });
    expect(await purge()).toBe(2);
    const cutoff = "2026-03-01 12:00:00";
    expect(Date.parse(`${cutoff.replace(" ", "T")}Z`)).toBe(NOW - SESSION_MAX_AGE_MS);
    expect(calls).toEqual([
      ["list", cutoff],
      ["close", { sessionIds: ["p1", "p2"], payload: { type: "session_revoked", reason: "expired" } }],
      ["purge", cutoff],
    ]);
  });

  test("a database that throws straight away (SQLITE_BUSY) is swallowed: the timer must never take the server down", async () => {
    const warn = vi.fn();
    const purge = createSessionPurger({
      listExpiredSessionIds: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      purgeExpiredSessions: () => 0,
      now: () => NOW,
      logger: { warn },
    });
    await expect(purge()).resolves.toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("SQLITE_BUSY");
  });

  test("a rejected promise is swallowed too, and nothing is closed when nothing expired", async () => {
    const closeSessionStreams = vi.fn();
    const failing = createSessionPurger({
      listExpiredSessionIds: async () => [],
      purgeExpiredSessions: async () => {
        throw new Error("connection lost");
      },
      closeSessionStreams,
      now: () => NOW,
      logger: quiet,
    });
    await expect(failing()).resolves.toBe(0);
    expect(closeSessionStreams).not.toHaveBeenCalled();
  });
});

describe("liveSessionOrNull (the WebSocket upgrade honours the same 14 days as the cookie)", () => {
  const NOW = Date.parse("2026-03-15T12:00:00Z");
  test("an old session is dead, a young one and one without a date are kept", () => {
    expect(liveSessionOrNull({ username: "a", session_created_at: "2026-02-01 00:00:00" }, NOW)).toBeNull();
    const young = { username: "a", session_created_at: "2026-03-14 00:00:00" };
    expect(liveSessionOrNull(young, NOW)).toBe(young);
    const undated = { username: "a" };
    expect(liveSessionOrNull(undated, NOW)).toBe(undated);
    expect(liveSessionOrNull(null, NOW)).toBeNull();
  });
});
