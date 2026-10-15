import { describe, test, expect } from "vitest";
import {
  createAccept,
  createInvite,
  deriveCallSession,
  INVITE_MAX_AGE_MS,
  openSignal,
  sealSignal,
  verifyAccept,
  verifyInvite,
} from "../../src/calls/callCrypto.js";
import { sasEmoji } from "../../src/e2ee/sas.js";
import { fromB64u, randomUuid, toB64u, randomBytes } from "../../src/e2ee/encoding.js";
import { makeIdentity } from "../e2ee/helpers.js";

async function setup() {
  const alice = await makeIdentity("alice");
  const bob = await makeIdentity("bob");
  const callId = randomUuid();
  const { ephemeral: ephA, invite } = await createInvite({
    callId, calleeUserId: "bob", kind: "video", identity: alice.identity,
  });
  const inviteArgs = {
    invite, callId, callerUserId: "alice", calleeUserId: "bob", kind: "video", callerDevice: alice.record,
  };
  return { alice, bob, callId, ephA, invite, inviteArgs };
}

describe("invite / accept authentication", () => {
  test("a genuine invite verifies", async () => {
    const { inviteArgs } = await setup();
    expect(await verifyInvite(inviteArgs)).toBe(true);
  });

  test.each([
    ["call id", (a) => ({ ...a, callId: randomUuid() })],
    ["callee", (a) => ({ ...a, calleeUserId: "carol" })],
    ["caller", (a) => ({ ...a, callerUserId: "mallory" })],
    ["kind", (a) => ({ ...a, kind: "audio" })],
    ["ephemeral key", (a) => ({ ...a, invite: { ...a.invite, eph: toB64u(randomBytes(65)) } })],
    ["timestamp", (a) => ({ ...a, invite: { ...a.invite, ts: a.invite.ts + 1 } })],
  ])("an invite with a different %s is rejected", async (_n, mutate) => {
    const { inviteArgs } = await setup();
    expect(await verifyInvite(mutate(inviteArgs))).toBe(false);
  });

  test("an invite signed by someone else's device key is rejected", async () => {
    const { inviteArgs } = await setup();
    const mallory = await makeIdentity("alice", inviteArgs.callerDevice.id);
    expect(await verifyInvite({ ...inviteArgs, callerDevice: mallory.record })).toBe(false);
  });

  test("the device must belong to the claimed caller", async () => {
    const { inviteArgs, alice } = await setup();
    expect(await verifyInvite({ ...inviteArgs, callerDevice: { ...alice.record, userId: "carol" } })).toBe(false);
    expect(await verifyInvite({ ...inviteArgs, callerDevice: null })).toBe(false);
  });

  test("stale invites are rejected", async () => {
    const { inviteArgs } = await setup();
    expect(await verifyInvite({ ...inviteArgs, now: inviteArgs.invite.ts + INVITE_MAX_AGE_MS + 1 })).toBe(false);
  });

  test("a genuine accept verifies; one for a different caller ephemeral does not", async () => {
    const { bob, callId, invite } = await setup();
    const { accept } = await createAccept({ callId, ephCaller: invite.eph, identity: bob.identity });
    const args = { accept, callId, ephCaller: invite.eph, calleeUserId: "bob", calleeDevice: bob.record };
    expect(await verifyAccept(args)).toBe(true);
    expect(await verifyAccept({ ...args, ephCaller: toB64u(randomBytes(65)) })).toBe(false);
    expect(await verifyAccept({ ...args, calleeUserId: "eve" })).toBe(false);
    expect(await verifyAccept({ ...args, accept: { ...accept, eph: toB64u(randomBytes(65)) } })).toBe(false);
  });
});

async function handshake() {
  const ctx = await setup();
  const { ephemeral: ephB, accept } = await createAccept({
    callId: ctx.callId, ephCaller: ctx.invite.eph, identity: ctx.bob.identity,
  });
  const common = { callId: ctx.callId, ephCaller: ctx.invite.eph, ephCallee: accept.eph };
  const caller = await deriveCallSession({
    ...common, ephemeralPrivateKey: ctx.ephA.privateKey, peerEph: accept.eph, role: "caller",
  });
  const callee = await deriveCallSession({
    ...common, ephemeralPrivateKey: ephB.privateKey, peerEph: ctx.invite.eph, role: "callee",
  });
  return { ...ctx, caller, callee, accept };
}

describe("call session and encrypted signaling", () => {
  test("both sides derive the same verification code", async () => {
    const { caller, callee } = await handshake();
    expect(sasEmoji(caller.sasBytes)).toEqual(sasEmoji(callee.sasBytes));
  });

  test("signals round-trip in both directions", async () => {
    const { caller, callee, callId } = await handshake();
    const offer = { sdp: "v=0 a=fingerprint:sha-256 AA:BB", type: "offer" };
    const blob = await sealSignal(caller, { kind: "offer", seq: 1, payload: offer });
    expect(await openSignal(callee, { kind: "offer", seq: 1, blob })).toEqual(offer);

    const answer = { sdp: "answer-sdp", type: "answer" };
    const back = await sealSignal(callee, { kind: "answer", seq: 1, payload: answer });
    expect(await openSignal(caller, { kind: "answer", seq: 1, blob: back })).toEqual(answer);
    expect(callId).toBeTruthy();
  });

  test("the relay sees only ciphertext (no SDP text in the blob)", async () => {
    const { caller } = await handshake();
    const blob = await sealSignal(caller, { kind: "offer", seq: 1, payload: { sdp: "a=fingerprint:sha-256 SECRET-FP" } });
    expect(Buffer.from(fromB64u(blob)).toString("latin1")).not.toContain("SECRET-FP");
  });

  test("a signal cannot be reflected back to its sender", async () => {
    const { caller } = await handshake();
    const blob = await sealSignal(caller, { kind: "offer", seq: 1, payload: { sdp: "x" } });
    await expect(openSignal(caller, { kind: "offer", seq: 1, blob })).rejects.toThrow();
  });

  test("kind, sequence number and ciphertext are all authenticated", async () => {
    const { caller, callee } = await handshake();
    const blob = await sealSignal(caller, { kind: "offer", seq: 1, payload: { sdp: "x" } });
    await expect(openSignal(callee, { kind: "answer", seq: 1, blob })).rejects.toThrow();
    await expect(openSignal(callee, { kind: "offer", seq: 2, blob })).rejects.toThrow();
    const bytes = fromB64u(blob);
    bytes[bytes.length - 1] ^= 1;
    await expect(openSignal(callee, { kind: "offer", seq: 1, blob: toB64u(bytes) })).rejects.toThrow();
    await expect(openSignal(callee, { kind: "offer", seq: 1, blob: "AAAA" })).rejects.toThrow();
  });

  test("a different call's session cannot read the signal", async () => {
    const a = await handshake();
    const b = await handshake();
    const blob = await sealSignal(a.caller, { kind: "ice", seq: 3, payload: { c: 1 } });
    await expect(openSignal(b.callee, { kind: "ice", seq: 3, blob })).rejects.toThrow();
  });

  test("a man in the middle that swaps ephemeral keys ends up with different codes", async () => {
    const { callId, ephA, invite, bob } = await setup();
    // Server replaces the callee's accept with its own ephemeral key.
    const mitm = await createAccept({ callId, ephCaller: invite.eph, identity: bob.identity });
    const real = await createAccept({ callId, ephCaller: invite.eph, identity: bob.identity });
    const callerView = await deriveCallSession({
      callId, ephCaller: invite.eph, ephCallee: mitm.accept.eph,
      ephemeralPrivateKey: ephA.privateKey, peerEph: mitm.accept.eph, role: "caller",
    });
    const calleeView = await deriveCallSession({
      callId, ephCaller: invite.eph, ephCallee: real.accept.eph,
      ephemeralPrivateKey: real.ephemeral.privateKey, peerEph: invite.eph, role: "callee",
    });
    expect(sasEmoji(callerView.sasBytes)).not.toEqual(sasEmoji(calleeView.sasBytes));
  });

  test("sessions from different calls derive different codes", async () => {
    const a = await handshake();
    const b = await handshake();
    expect(Array.from(a.caller.sasBytes)).not.toEqual(Array.from(b.caller.sasBytes));
  });
});
