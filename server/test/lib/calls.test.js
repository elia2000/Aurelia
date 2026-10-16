import { describe, test, expect, beforeEach } from "vitest";
import { createCallRegistry, CALL_STATES, CallError } from "../../lib/calls.js";

const ALICE = { id: "u-alice", username: "alice" };
const BOB = { id: "u-bob", username: "bob" };
const CAROL = { id: "u-carol", username: "carol" };

describe("call registry", () => {
  let clock;
  let registry;
  const inviteAB = (callId = "call-1", kind = "audio") =>
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

  test("invite -> accept -> active -> hangup", () => {
    const call = inviteAB();
    expect(call.state).toBe(CALL_STATES.RINGING);
    registry.accept("call-1", BOB.id, "dev-b");
    expect(registry.get("call-1").state).toBe(CALL_STATES.CONNECTING);
    expect(registry.get("call-1").calleeDeviceId).toBe("dev-b");
    registry.markActive("call-1", ALICE.id);
    expect(registry.get("call-1").state).toBe(CALL_STATES.ACTIVE);
    const ended = registry.endBy("call-1", ALICE.id);
    expect(ended.endReason).toBe("hangup");
    expect(registry.getLiveCallForUser(ALICE.id)).toBeNull();
    expect(registry.getLiveCallForUser(BOB.id)).toBeNull();
  });

  test("ringing is reported once, by the callee only, and only while the call rings", () => {
    inviteAB();
    expect(() => registry.markRinging("call-1", ALICE.id)).toThrow(CallError);
    expect(() => registry.markRinging("call-1", CAROL.id)).toThrow(CallError);
    expect(registry.markRinging("call-1", BOB.id)?.id).toBe("call-1");
    expect(registry.markRinging("call-1", BOB.id)).toBeNull(); // already known
  });

  test("a call that was answered is never reported as ringing", () => {
    inviteAB();
    registry.accept("call-1", BOB.id, "dev-b");
    expect(registry.markRinging("call-1", BOB.id)).toBeNull();
  });

  test.each([
    ["cancelled by the caller", (r) => r.endBy("call-1", ALICE.id)],
    ["declined by the callee", (r) => r.endBy("call-1", BOB.id)],
    ["missed", (r) => r.end("call-1", "missed")],
  ])("a call that was %s is never reported as ringing", (_label, finish) => {
    inviteAB();
    finish(registry);
    expect(registry.get("call-1").state).toBe(CALL_STATES.ENDED);
    expect(registry.markRinging("call-1", BOB.id)).toBeNull();
  });

  test("reports busy for the callee and for the caller", () => {
    inviteAB();
    expect(() =>
      registry.invite({ callId: "call-2", caller: CAROL, callee: BOB, kind: "audio" }),
    ).toThrow(expect.objectContaining({ code: "busy" }));
    expect(() =>
      registry.invite({ callId: "call-3", caller: ALICE, callee: CAROL, kind: "audio" }),
    ).toThrow(expect.objectContaining({ code: "busy_self" }));
  });

  test("rejects self-calls, bad kinds and duplicate ids", () => {
    expect(() =>
      registry.invite({ callId: "x", caller: ALICE, callee: ALICE, kind: "audio" }),
    ).toThrow(CallError);
    expect(() =>
      registry.invite({ callId: "x", caller: ALICE, callee: BOB, kind: "screen" }),
    ).toThrow(CallError);
    inviteAB("dup");
    registry.end("dup");
    expect(() => inviteAB("dup")).toThrow(expect.objectContaining({ code: "duplicate" }));
  });

  test("only the callee may accept, and only once", () => {
    inviteAB();
    expect(() => registry.accept("call-1", ALICE.id, "dev-a")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => registry.accept("call-1", CAROL.id, "dev-c")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    registry.accept("call-1", BOB.id, "dev-b");
    expect(() => registry.accept("call-1", BOB.id, "dev-b2")).toThrow(
      expect.objectContaining({ code: "not_ringing" }),
    );
  });

  test("end reasons depend on who ends a ringing call", () => {
    inviteAB("a");
    expect(registry.endBy("a", ALICE.id).endReason).toBe("cancelled");
    inviteAB("b");
    expect(registry.endBy("b", BOB.id).endReason).toBe("declined");
    inviteAB("c");
    registry.accept("c", BOB.id, "dev-b");
    expect(registry.endBy("c", BOB.id, "evil-reason").endReason).toBe("hangup");
  });

  test("a device can report that the media connection failed, and the reason reaches the other side as is", () => {
    inviteAB("a");
    registry.accept("a", BOB.id, "dev-b");
    expect(registry.endBy("a", ALICE.id, "connect_failed").endReason).toBe("connect_failed");
    inviteAB("b");
    registry.accept("b", BOB.id, "dev-b");
    expect(registry.endBy("b", BOB.id, "failed").endReason).toBe("failed");
    // ...but a ringing call can only be cancelled or declined, whatever is claimed.
    inviteAB("c");
    expect(registry.endBy("c", ALICE.id, "connect_failed").endReason).toBe("cancelled");
  });

  test("strangers cannot authorize or end a call", () => {
    inviteAB();
    expect(registry.authorize("call-1", CAROL.id)).toBeNull();
    expect(() => registry.endBy("call-1", CAROL.id)).toThrow(CallError);
  });

  test("sweep marks unanswered calls missed after the ring timeout", () => {
    inviteAB();
    clock.t += 44_000;
    expect(registry.sweep()).toHaveLength(0);
    clock.t += 2_000;
    const ended = registry.sweep();
    expect(ended).toHaveLength(1);
    expect(ended[0].reason).toBe("missed");
    expect(registry.getLiveCallForUser(BOB.id)).toBeNull();
  });

  test("sweep fails calls that never connect", () => {
    inviteAB();
    registry.accept("call-1", BOB.id, "dev-b");
    clock.t += 61_000;
    expect(registry.sweep()[0].reason).toBe("failed");
  });

  test("sweep frees running calls once both sides are offline long enough", () => {
    inviteAB();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    const offline = () => false;
    clock.t += 5_000;
    expect(registry.sweep(offline)).toHaveLength(0);
    clock.t += 91_000;
    expect(registry.sweep(offline)[0].reason).toBe("failed");
  });

  test("a participant coming back online resets the orphan timer", () => {
    inviteAB();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    clock.t += 5_000;
    registry.sweep(() => false);
    clock.t += 60_000;
    registry.sweep((name) => name === "alice");
    clock.t += 60_000;
    expect(registry.sweep(() => false)).toHaveLength(0);
  });

  test("sweep enforces the max call duration and prunes ended calls", () => {
    inviteAB();
    registry.accept("call-1", BOB.id, "dev-b");
    registry.markActive("call-1", ALICE.id);
    clock.t += 3_600_001;
    expect(registry.sweep(() => true)[0].reason).toBe("timeout");
    clock.t += 61_000;
    registry.sweep();
    expect(registry.size()).toBe(0);
  });

  test("getPendingIncoming only returns ringing calls for the callee", () => {
    inviteAB();
    expect(registry.getPendingIncoming(BOB.id)?.id).toBe("call-1");
    expect(registry.getPendingIncoming(ALICE.id)).toBeNull();
    registry.accept("call-1", BOB.id, "dev-b");
    expect(registry.getPendingIncoming(BOB.id)).toBeNull();
  });
});
