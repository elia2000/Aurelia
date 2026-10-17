import { describe, test, expect } from "vitest";
import {
  CALL_OUTCOMES,
  callPreviewText,
  callCountsAsUnread,
  isCallMessage,
  resolveCallOutcome,
  serializeCall,
} from "../../lib/callMessages.js";

// A call the way the registry hands it over once it has ended.
const ended = (overrides = {}) => ({
  id: "call-1",
  kind: "audio",
  createdAt: 1_000,
  answeredAt: null,
  connectedAt: null,
  endedAt: 31_000,
  endedFrom: "ringing",
  endReason: "cancelled",
  offlineSince: null,
  reportedDurationMs: null,
  ...overrides,
});

describe("resolveCallOutcome: every way a call can end", () => {
  describe("never answered", () => {
    test.each([
      ["cancelled", "cancelled"],
      ["declined", "declined"],
      ["missed", "missed"],
      // The registry cannot give any other reason for a call that still rang,
      // but an unexpected one must still produce a valid entry.
      ["timeout", "missed"],
      ["hangup", "cancelled"],
      ["something-new", "cancelled"],
    ])("reason %s becomes %s", (endReason, outcome) => {
      expect(resolveCallOutcome(ended({ endReason }))).toEqual({
        outcome,
        durationSec: null,
      });
    });
  });

  describe("answered but the media never connected", () => {
    test.each(["failed", "connect_failed", "hangup", "timeout"])(
      "reason %s becomes failed, without a duration",
      (endReason) => {
        const call = ended({
          endedFrom: "connecting",
          answeredAt: 5_000,
          endReason,
        });
        expect(resolveCallOutcome(call)).toEqual({ outcome: "failed", durationSec: null });
      },
    );
  });

  describe("answered, the server never heard that it connected, but the device says it ran", () => {
    const lost = (overrides = {}) =>
      ended({
        endedFrom: "connecting",
        answeredAt: 5_000,
        connectedAt: null,
        endedAt: 65_000,
        endReason: "hangup",
        reportedDurationMs: 40_000,
        ...overrides,
      });

    test("a hang-up with a reported duration is a completed call of that length", () => {
      expect(resolveCallOutcome(lost())).toEqual({ outcome: "completed", durationSec: 40 });
    });
    test("a reported duration of zero proves nothing", () => {
      expect(resolveCallOutcome(lost({ reportedDurationMs: 0 }))).toEqual({
        outcome: "failed",
        durationSec: null,
      });
    });
    test("no reported duration: still failed", () => {
      expect(resolveCallOutcome(lost({ reportedDurationMs: null })).outcome).toBe("failed");
    });
    test.each(["failed", "connect_failed", "timeout"])(
      "a device that says the connection failed (%s) is believed over its duration",
      (endReason) => {
        expect(resolveCallOutcome(lost({ endReason })).outcome).toBe("failed");
      },
    );
  });

  describe("answered and connected", () => {
    test.each(["hangup", "failed", "connect_failed", "timeout"])(
      "reason %s still counts as a completed call",
      (endReason) => {
        const call = ended({
          endedFrom: "active",
          answeredAt: 5_000,
          connectedAt: 8_000,
          endedAt: 38_000,
          endReason,
        });
        expect(resolveCallOutcome(call)).toEqual({ outcome: "completed", durationSec: 30 });
      },
    );
  });

  test("the outcomes are exactly the six the client knows", () => {
    expect([...CALL_OUTCOMES].sort()).toEqual(
      ["busy", "cancelled", "completed", "declined", "failed", "missed"].sort(),
    );
  });
});

describe("resolveCallOutcome: duration", () => {
  const active = (overrides = {}) =>
    ended({
      endedFrom: "active",
      answeredAt: 10_000,
      connectedAt: 12_000,
      endedAt: 72_000,
      endReason: "hangup",
      ...overrides,
    });

  test("runs from the moment the call connected, not from the answer", () => {
    expect(resolveCallOutcome(active()).durationSec).toBe(60);
  });

  test("falls back to the answer when the connection was never reported", () => {
    expect(resolveCallOutcome(active({ connectedAt: null })).durationSec).toBe(62);
  });

  test("prefers the duration the device reported", () => {
    expect(resolveCallOutcome(active({ reportedDurationMs: 58_400 })).durationSec).toBe(58);
  });

  test("a reported duration of zero is respected, not treated as missing", () => {
    expect(resolveCallOutcome(active({ reportedDurationMs: 0 })).durationSec).toBe(0);
  });

  test("a reported duration cannot be longer than the time between answer and end", () => {
    expect(resolveCallOutcome(active({ reportedDurationMs: 9_999_999 })).durationSec).toBe(62);
  });

  test.each([NaN, Infinity, -5, "30000", {}, [], null, undefined])(
    "an unusable reported duration (%s) is ignored",
    (reportedDurationMs) => {
      expect(resolveCallOutcome(active({ reportedDurationMs })).durationSec).toBe(60);
    },
  );

  test("rounds to whole seconds", () => {
    expect(resolveCallOutcome(active({ connectedAt: 12_000, endedAt: 12_499 })).durationSec).toBe(0);
    expect(resolveCallOutcome(active({ connectedAt: 12_000, endedAt: 12_500 })).durationSec).toBe(1);
  });

  test("never negative, even if the clocks disagree", () => {
    const call = active({ connectedAt: 90_000, endedAt: 72_000 });
    expect(resolveCallOutcome(call).durationSec).toBe(0);
  });

  test("a call dropped because both people vanished stops at the moment they vanished", () => {
    const call = active({
      endReason: "failed",
      connectedAt: 12_000,
      offlineSince: 42_000,
      endedAt: 140_000,
    });
    expect(resolveCallOutcome(call).durationSec).toBe(30);
  });
});

describe("serializeCall", () => {
  test("gives the structured form the client renders", () => {
    expect(
      serializeCall({
        call_id: "c1",
        call_kind: "video",
        call_outcome: "completed",
        call_duration_sec: 83,
      }),
    ).toEqual({ callId: "c1", kind: "video", outcome: "completed", durationSec: 83 });
  });

  test("an outcome without a duration says null, never undefined", () => {
    const call = serializeCall({
      call_id: "c1",
      call_kind: "audio",
      call_outcome: "missed",
      call_duration_sec: null,
    });
    expect(call.durationSec).toBeNull();
    expect(Object.keys(call).sort()).toEqual(["callId", "durationSec", "kind", "outcome"]);
  });

  test("an ordinary message has no call", () => {
    expect(serializeCall({ id: "m1", body: "hi" })).toBeNull();
    expect(serializeCall({ call_id: null })).toBeNull();
    expect(serializeCall(null)).toBeNull();
    expect(serializeCall(undefined)).toBeNull();
  });

  test("a stored value outside the known ones is not passed on", () => {
    expect(
      serializeCall({ call_id: "c1", call_kind: "hologram", call_outcome: "missed" })?.kind,
    ).toBe("audio");
    expect(
      serializeCall({ call_id: "c1", call_kind: "audio", call_outcome: "exploded" })?.outcome,
    ).toBe("failed");
  });

  test("a duration from the database that is not a count of seconds becomes null", () => {
    expect(
      serializeCall({ call_id: "c", call_kind: "audio", call_outcome: "completed", call_duration_sec: "12" })
        .durationSec,
    ).toBe(12);
    expect(
      serializeCall({ call_id: "c", call_kind: "audio", call_outcome: "completed", call_duration_sec: -4 })
        .durationSec,
    ).toBeNull();
  });
});

describe("isCallMessage", () => {
  test("is true for a row that carries a call id", () => {
    expect(isCallMessage({ call_id: "c1" })).toBe(true);
  });
  test("is false for everything else", () => {
    expect(isCallMessage({ call_id: null })).toBe(false);
    expect(isCallMessage({ call_id: "" })).toBe(false);
    expect(isCallMessage({ body: "[[system:joined:bob]]" })).toBe(false);
    expect(isCallMessage(null)).toBe(false);
  });
});

describe("callCountsAsUnread", () => {
  test("only a missed call waits to be read", () => {
    const flags = Object.fromEntries(CALL_OUTCOMES.map((o) => [o, callCountsAsUnread(o)]));
    expect(flags).toEqual({
      completed: false,
      missed: true,
      declined: false,
      cancelled: false,
      busy: false,
      failed: false,
    });
  });
});

describe("callPreviewText", () => {
  test.each([
    ["audio", "completed", true, "Outgoing call"],
    ["audio", "completed", false, "Incoming call"],
    ["video", "completed", true, "Outgoing video call"],
    ["video", "completed", false, "Incoming video call"],
    ["audio", "missed", false, "Missed call"],
    ["video", "missed", false, "Missed video call"],
    ["audio", "missed", true, "No answer"],
    ["video", "missed", true, "No answer"],
    ["audio", "declined", true, "Declined call"],
    ["audio", "declined", false, "Declined call"],
    ["video", "declined", false, "Declined video call"],
    ["audio", "cancelled", true, "Cancelled call"],
    ["audio", "cancelled", false, "Cancelled call"],
    ["video", "cancelled", true, "Cancelled video call"],
    ["audio", "busy", true, "Busy"],
    ["video", "busy", false, "Busy"],
    ["audio", "failed", true, "Call failed"],
    ["video", "failed", false, "Video call failed"],
  ])("%s %s (outgoing: %s) reads %j", (kind, outcome, outgoing, text) => {
    expect(callPreviewText({ kind, outcome, outgoing })).toBe(text);
  });

  test("without a viewer it reads the same for both people", () => {
    expect(callPreviewText({ kind: "audio", outcome: "completed", outgoing: null })).toBe("Call");
    expect(callPreviewText({ kind: "video", outcome: "completed", outgoing: null })).toBe("Video call");
    expect(callPreviewText({ kind: "audio", outcome: "missed", outgoing: null })).toBe("Missed call");
  });

  test("an unknown kind or outcome still gives a sensible line", () => {
    expect(callPreviewText({ kind: "x", outcome: "y", outgoing: true })).toBe("Call failed");
    expect(callPreviewText({})).toBe("Call failed");
  });
});
