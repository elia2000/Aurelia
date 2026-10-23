import { describe, expect, test, vi } from "vitest";
import { createSessionHelpers } from "../../lib/sessions.js";
import { SESSION_MAX_AGE_MS } from "../../lib/accountSessions.js";

const req = (sid) => ({ headers: { cookie: `sid=${sid}` } });

describe("last_seen is written at most once a minute", () => {
  test("many requests, one touch; another after the interval", () => {
    let clock = 1_000_000;
    const touchSession = vi.fn();
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: () => ({ id: "u1" }),
      touchSession,
      isProduction: false,
      now: () => clock,
    });
    for (let i = 0; i < 50; i += 1) {
      clock += 500;
      getSessionFromRequest(req("tok"));
    }
    expect(touchSession).toHaveBeenCalledTimes(1);
    clock += 60_000;
    getSessionFromRequest(req("tok"));
    expect(touchSession).toHaveBeenCalledTimes(2);
  });

  test("each session is throttled on its own", () => {
    const touchSession = vi.fn();
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: () => ({ id: "u1" }),
      touchSession,
      isProduction: false,
      now: () => 5,
    });
    getSessionFromRequest(req("a"));
    getSessionFromRequest(req("b"));
    getSessionFromRequest(req("a"));
    expect(touchSession.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  test("a failing touch does not break the request", async () => {
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: async () => ({ id: "u1" }),
      touchSession: () => Promise.reject(new Error("db busy")),
      isProduction: false,
    });
    await expect(getSessionFromRequest(req("a"))).resolves.toEqual({ id: "u1" });
  });
});

describe("a session does not outlive its cookie", () => {
  const stamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

  test("older than 14 days: refused and removed", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const deleteSession = vi.fn();
    const touchSession = vi.fn();
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: () => ({ id: "u1", session_created_at: stamp(now - SESSION_MAX_AGE_MS - 2000) }),
      touchSession,
      deleteSession,
      isProduction: false,
      now: () => now,
    });
    expect(getSessionFromRequest(req("old"))).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("old");
    expect(touchSession).not.toHaveBeenCalled();
  });

  test("younger than 14 days: accepted", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: () => ({ id: "u1", session_created_at: stamp(now - SESSION_MAX_AGE_MS + 60_000) }),
      touchSession: () => {},
      isProduction: false,
      now: () => now,
    });
    expect(getSessionFromRequest(req("fresh"))).toMatchObject({ id: "u1" });
  });

  test("works for asynchronous (Postgres) lookups too", async () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const deleteSession = vi.fn(() => Promise.resolve());
    const { getSessionFromRequest } = createSessionHelpers({
      getSession: async () => ({ id: "u1", session_created_at: "2026-01-01 00:00:00+00" }),
      touchSession: () => {},
      deleteSession,
      isProduction: false,
      now: () => now,
    });
    await expect(getSessionFromRequest(req("old"))).resolves.toBeNull();
    expect(deleteSession).toHaveBeenCalledWith("old");
  });
});
