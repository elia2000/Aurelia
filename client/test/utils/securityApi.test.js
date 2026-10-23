import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeTwoFactorLogin,
  confirmTwoFactor,
  disableTwoFactor,
  fetchSessions,
  fetchTwoFactorStatus,
  regenerateRecoveryCodes,
  resetUserTwoFactor,
  revokeOtherSessions,
  revokeSession,
  startTwoFactorSetup,
} from "../../src/api/securityApi.js";
import { UNAUTHORIZED_EVENT, apiFetch } from "../../src/api/chatApi.js";

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const lastCall = () => {
  const [url, options] = fetchMock.mock.calls.at(-1);
  return { url, options, body: options.body ? JSON.parse(options.body) : undefined };
};

describe("securityApi requests", () => {
  test("sessions", async () => {
    fetchMock.mockResolvedValue(json(200, { sessions: [] }));
    await fetchSessions();
    expect(lastCall()).toMatchObject({ url: "/api/sessions", options: { method: "GET", credentials: "include" } });

    await revokeSession("a b/c");
    expect(lastCall()).toMatchObject({ url: "/api/sessions/a%20b%2Fc", options: { method: "DELETE", credentials: "include" } });

    await revokeOtherSessions();
    expect(lastCall()).toMatchObject({ url: "/api/sessions/revoke-others", options: { method: "POST" } });
  });

  test("two-factor", async () => {
    fetchMock.mockResolvedValue(json(200, {}));
    await fetchTwoFactorStatus();
    expect(lastCall().url).toBe("/api/2fa");
    await startTwoFactorSetup({ password: "pw" });
    expect(lastCall()).toMatchObject({ url: "/api/2fa/setup", body: { password: "pw" } });
    await confirmTwoFactor({ code: "123456" });
    expect(lastCall()).toMatchObject({ url: "/api/2fa/enable", body: { code: "123456" } });
    await regenerateRecoveryCodes({ password: "pw", code: "123456" });
    expect(lastCall()).toMatchObject({ url: "/api/2fa/recovery-codes", body: { password: "pw", code: "123456" } });
    await disableTwoFactor({ password: "pw", recoveryCode: "ABCDE-FGHJK" });
    expect(lastCall()).toMatchObject({ url: "/api/2fa/disable", body: { password: "pw", recoveryCode: "ABCDE-FGHJK" } });
    await completeTwoFactorLogin({ challenge: "c", code: "123456" });
    expect(lastCall()).toMatchObject({ url: "/api/login/2fa", body: { challenge: "c", code: "123456" } });
    expect(lastCall().options.headers).toEqual({ "Content-Type": "application/json" });
  });

  test("admin reset", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await resetUserTwoFactor("u-1");
    expect(lastCall()).toMatchObject({ url: "/api/admin/users/u-1/reset-2fa", options: { method: "POST" } });
  });

  test("a failure becomes an Error with the server's words, the status and the whole body", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "Invalid code.", attemptsLeft: 3, restart: false }));
    const error = await completeTwoFactorLogin({ challenge: "c", code: "000000" }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Invalid code.");
    expect(error.status).toBe(401);
    expect(error.data).toEqual({ error: "Invalid code.", attemptsLeft: 3, restart: false });
  });

  test("a failure with no JSON body still has a readable message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("html"); } });
    const error = await fetchSessions().catch((e) => e);
    expect(error.message).toMatch(/try again/i);
    expect(error.status).toBe(502);
  });
});

describe("apiFetch tells the app about a 401 (at most every few seconds)", () => {
  test("dispatches the event, and not for other statuses", async () => {
    const events = [];
    vi.stubGlobal("window", { dispatchEvent: (event) => events.push(event.type) });
    vi.stubGlobal("Event", class { constructor(type) { this.type = type; } });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      fetchMock.mockResolvedValue(json(200, {}));
      await apiFetch("/api/x");
      await Promise.resolve();
      expect(events).toEqual([]);

      fetchMock.mockResolvedValue(json(401, {}));
      await apiFetch("/api/x");
      await Promise.resolve();
      expect(events).toEqual([UNAUTHORIZED_EVENT]);

      await apiFetch("/api/x"); // inside the quiet period
      await Promise.resolve();
      expect(events).toHaveLength(1);

      vi.setSystemTime(new Date("2030-01-01T00:00:10Z"));
      await apiFetch("/api/x");
      await Promise.resolve();
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns the response untouched and survives a failing request", async () => {
    vi.stubGlobal("window", { dispatchEvent: () => {} });
    const res = json(200, { ok: true });
    fetchMock.mockResolvedValue(res);
    await expect(apiFetch("/api/x")).resolves.toBe(res);
    fetchMock.mockRejectedValue(new Error("offline"));
    await expect(apiFetch("/api/x")).rejects.toThrow("offline");
  });
});
