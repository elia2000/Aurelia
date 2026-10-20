import { describe, test, expect, beforeEach } from "vitest";
import { createCallRegistry, CALL_STATES } from "../../lib/calls.js";
import { resolveCallOutcome } from "../../lib/callMessages.js";

const ALICE = { id: "u-alice", username: "alice" };
const BOB = { id: "u-bob", username: "bob" };

// What the registry records about the end of a call is what the history entry
// in the chat is made from, so these tests go through both.
describe("call registry: facts for the history entry", () => {
  let clock;
  let registry;
  const invite = (callId = "call-1", kind = "audio") =>
    registry.invite({ callId, caller: ALICE, callee: BOB, chatId: "chat-1", kind, callerDeviceId: "dev-a" });

  beforeEach(() => {
    clock = { t: 1_000_000 };
    registry = createCallRegistry({
      now: () => clock.t,
      ringTimeoutMs: 45_000,
      connectTimeoutMs: 60_000,
      maxCallMs: 3_600_000,
      orphanMs: 90_000,
    });
  });

  test("remembers what state the call was in when it ended", () => {
    invite("ringing-call");
    expect(registry.endBy("ringing-call", ALICE.id).endedFrom).toBe(CALL_STATES.RINGING);

    invite("connecting-call");
    registry.accept("connecting-call", BOB.id, "dev-b");
    expect(registry.endBy("connecting-call", BOB.id).endedFrom).toBe(CALL_STATES.CONNECTING);

    invite("active-call");
    registry.accept("active-call", BOB.id, "dev-b");
    registry.markActive("active-call", ALICE.id);
    expect(registry.endBy("active-call", ALICE.id).endedFrom).toBe(CALL_STATES.ACTIVE);
  });

  test("records when the call connected, once, whoever reports it", () => {
    invite();
    registry.accept("call-1", BOB.id, "dev-b");
    expect(registry.get("call-1").connectedAt).toBeNull();
    clock.t += 3_000;
    registry.markActive("call-1", ALICE.id);
    const connectedAt = registry.get("call-1").connectedAt;
    expect(connectedAt).toBe(1_003_000);
    clock.t += 4_000;
    registry.markActive("call-1", BOB.id);
    expect(registry.get("call-1").connectedAt).toBe(connectedAt);
  });

  test("a call that was not answered has no connection time even if someone reports one", () => {
    invite();
    registry.markActive("call-1", ALICE.id);
    expect(registry.get("call-1").connectedAt).toBeNull();
  });

  test("ending twice returns the call once: the second request finds nothing to do", () => {
    invite();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    expect(registry.endBy("call-1", ALICE.id)).not.toBeNull();
    expect(registry.endBy("call-1", BOB.id)).toBeNull();
    expect(registry.end("call-1", "failed")).toBeNull();
  });

  test("the sweeper cannot end a call somebody just ended", () => {
    invite();
    clock.t += 50_000;
    expect(registry.endBy("call-1", ALICE.id)).not.toBeNull();
    expect(registry.sweep()).toEqual([]);
  });

  test("a reported duration is kept, clamped to the time between answer and end", () => {
    invite();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    clock.t += 40_000;
    const call = registry.endBy("call-1", ALICE.id, "hangup", { durationMs: 99_000_000 });
    expect(call.reportedDurationMs).toBe(40_000);
  });

  test("a reported duration inside the window is kept as it is", () => {
    invite();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    clock.t += 40_000;
    expect(registry.endBy("call-1", ALICE.id, "hangup", { durationMs: 38_250 }).reportedDurationMs).toBe(
      38_250,
    );
  });

  test.each([-1, NaN, Infinity, "5000", null, undefined, {}, [], true])(
    "an unusable reported duration (%s) is dropped",
    (durationMs) => {
      invite();
      registry.accept("call-1", BOB.id, "dev-b");
      registry.markActive("call-1", ALICE.id);
      clock.t += 5_000;
      expect(registry.endBy("call-1", ALICE.id, "hangup", { durationMs }).reportedDurationMs).toBeNull();
    },
  );

  test("a duration reported for a call nobody answered is dropped", () => {
    invite();
    const call = registry.endBy("call-1", ALICE.id, "hangup", { durationMs: 10_000 });
    expect(call.reportedDurationMs).toBeNull();
  });

  test("only the request that really ended the call decides the duration", () => {
    invite();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    clock.t += 30_000;
    registry.endBy("call-1", ALICE.id, "hangup", { durationMs: 29_000 });
    expect(registry.endBy("call-1", BOB.id, "hangup", { durationMs: 1_000 })).toBeNull();
    expect(registry.get("call-1").reportedDurationMs).toBe(29_000);
  });

  describe("outcome of what the registry records", () => {
    const outcomeOf = (call) => resolveCallOutcome(call).outcome;

    test("caller cancels while ringing", () => {
      invite();
      expect(outcomeOf(registry.endBy("call-1", ALICE.id))).toBe("cancelled");
    });
    test("callee declines", () => {
      invite();
      expect(outcomeOf(registry.endBy("call-1", BOB.id))).toBe("declined");
    });
    test("nobody picks up", () => {
      invite();
      clock.t += 46_000;
      const [{ call }] = registry.sweep();
      expect(outcomeOf(call)).toBe("missed");
    });
    test("answered but never connected", () => {
      invite();
      registry.accept("call-1", BOB.id, "dev-b");
      clock.t += 61_000;
      const [{ call }] = registry.sweep();
      expect(outcomeOf(call)).toBe("failed");
    });
    test("answered, connected, hung up", () => {
      invite();
      registry.accept("call-1", BOB.id, "dev-b");
      clock.t += 2_000;
      registry.markActive("call-1", ALICE.id);
      clock.t += 23_000;
      const call = registry.endBy("call-1", BOB.id);
      expect(resolveCallOutcome(call)).toEqual({ outcome: "completed", durationSec: 23 });
    });
    test("answered, connected, then both people vanished", () => {
      invite();
      registry.accept("call-1", BOB.id, "dev-b");
      registry.markActive("call-1", ALICE.id);
      clock.t += 5_000;
      registry.sweep(() => false);
      clock.t += 91_000;
      const [{ call }] = registry.sweep(() => false);
      expect(resolveCallOutcome(call)).toEqual({ outcome: "completed", durationSec: 5 });
    });
    test("a device that reports a failed connection of a call that never connected", () => {
      invite();
      registry.accept("call-1", BOB.id, "dev-b");
      expect(outcomeOf(registry.endBy("call-1", BOB.id, "connect_failed"))).toBe("failed");
    });
  });
});
