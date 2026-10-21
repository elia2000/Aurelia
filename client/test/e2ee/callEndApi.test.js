import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../../src/api/chatApi.js", () => ({ apiFetch: (...args) => hoisted.apiFetch(...args) }));

const { endCall, endCallBeacon } = await import("../../src/api/e2eeApi.js");

const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
  hoisted.apiFetch.mockReset();
  hoisted.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("endCall", () => {
  test("sends the reason and how long the media was connected", async () => {
    await endCall("call-1", "failed", 125_400.6);
    expect(hoisted.apiFetch).toHaveBeenCalledTimes(1);
    expect(hoisted.apiFetch.mock.calls[0][0]).toBe("/api/calls/call-1/end");
    expect(bodyOf(hoisted.apiFetch.mock.calls[0])).toEqual({ reason: "failed", durationMs: 125_401 });
  });

  test("leaves the length out when the call never connected", async () => {
    await endCall("call-1", "declined");
    expect(bodyOf(hoisted.apiFetch.mock.calls[0])).toEqual({ reason: "declined" });
  });

  test("never sends a length that is not a number or is negative", async () => {
    await endCall("call-1", undefined, Number.NaN);
    await endCall("call-1", undefined, -5);
    await endCall("call-1", undefined, "12");
    for (const call of hoisted.apiFetch.mock.calls) {
      expect(bodyOf(call)).toEqual({});
    }
  });

  test("a length of zero is still a length", async () => {
    await endCall("call-1", undefined, 0);
    expect(bodyOf(hoisted.apiFetch.mock.calls[0])).toEqual({ durationMs: 0 });
  });
});

describe("endCallBeacon", () => {
  const readBlob = (blob) => blob.text().then((text) => JSON.parse(text));

  test("sends a hang-up with the length of a connected call", async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    expect(endCallBeacon("call-9", 61_000)).toBe(true);
    expect(sendBeacon.mock.calls[0][0]).toBe("/api/calls/call-9/end");
    expect(await readBlob(sendBeacon.mock.calls[0][1])).toEqual({ reason: "hangup", durationMs: 61_000 });
  });

  test("sends only the hang-up when there is no length", async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    endCallBeacon("call-9");
    expect(await readBlob(sendBeacon.mock.calls[0][1])).toEqual({ reason: "hangup" });
  });

  test("reports false when the browser has no beacon", () => {
    vi.stubGlobal("navigator", {});
    expect(endCallBeacon("call-9", 1000)).toBe(false);
  });
});
