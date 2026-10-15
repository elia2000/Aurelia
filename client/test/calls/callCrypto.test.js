import { describe, test, expect } from "vitest";
import {
  createAccept,
  createInvite,
  deriveCallSession,
  ephemeralCommitment,
  INVITE_MAX_AGE_MS,
  openSignal,
  sealSignal,
  verifyAccept,
  verifyInvite,
  verifyReveal,
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
  const acceptArgs = (accept, overrides = {}) => ({
    accept, callId, invite, callerUserId: "alice", calleeUserId: "bob", kind: "video", calleeDevice: bob.record,
    ...overrides,
  });
  const answer = (overrides = {}) =>
    createAccept({
      callId, invite, callerUserId: "alice", calleeUserId: "bob", kind: "video", identity: bob.identity,
      ...overrides,
    });
  return { alice, bob, callId, ephA, invite, inviteArgs, acceptArgs, answer };
}

describe("invite / accept authentication", () => {
  test("a genuine invite verifies", async () => {
    const { inviteArgs } = await setup();
    expect(await verifyInvite(inviteArgs)).toBe(true);
  });

  test("the invite carries a commitment to the caller's key, not the key", async () => {
    const { invite, ephA, callId } = await setup();
    expect(invite.eph).toBeUndefined();
    expect(fromB64u(invite.commit)).toHaveLength(32);
    expect(invite.commit).toBe(await ephemeralCommitment(callId, ephA.pub));
  });

  test.each([
    ["call id", (a) => ({ ...a, callId: randomUuid() })],
    ["callee", (a) => ({ ...a, calleeUserId: "carol" })],
    ["caller", (a) => ({ ...a, callerUserId: "mallory" })],
    ["kind", (a) => ({ ...a, kind: "audio" })],
    ["commitment", (a) => ({ ...a, invite: { ...a.invite, commit: toB64u(randomBytes(32)) } })],
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

  test("stale invites are rejected, but a few minutes of clock difference are tolerated", async () => {
    const { inviteArgs } = await setup();
    expect(await verifyInvite({ ...inviteArgs, now: inviteArgs.invite.ts + INVITE_MAX_AGE_MS + 1 })).toBe(false);
    expect(await verifyInvite({ ...inviteArgs, now: inviteArgs.invite.ts + 4 * 60 * 1000 })).toBe(true);
  });

  test("a genuine accept verifies and is bound to the whole invite", async () => {
    const { acceptArgs, answer, invite } = await setup();
    const { accept } = await answer();
    expect(await verifyAccept(acceptArgs(accept))).toBe(true);
    expect(await verifyAccept(acceptArgs(accept, { calleeUserId: "eve" }))).toBe(false);
    expect(await verifyAccept(acceptArgs(accept, { kind: "audio" }))).toBe(false);
    expect(await verifyAccept(acceptArgs(accept, { callerUserId: "mallory" }))).toBe(false);
    expect(await verifyAccept(acceptArgs(accept, { invite: { ...invite, deviceId: randomUuid() } }))).toBe(false);
    expect(await verifyAccept(acceptArgs(accept, { invite: { ...invite, commit: toB64u(randomBytes(32)) } }))).toBe(false);
    expect(await verifyAccept(acceptArgs({ ...accept, eph: toB64u(randomBytes(65)) }))).toBe(false);
  });

  test("identity misbinding: an accept given for another caller's invite never verifies for this call", async () => {
    // A hostile server replays Alice's commitment inside an invite signed by Mallory.
    // Bob answers "Mallory"; that answer must not authenticate a session with Alice.
    const { callId, invite, bob } = await setup();
    const mallory = await makeIdentity("mallory");
    const forged = { ...invite, deviceId: mallory.identity.deviceId };
    const { accept } = await createAccept({
      callId, invite: forged, callerUserId: "mallory", calleeUserId: "bob", kind: "video", identity: bob.identity,
    });
    expect(
      await verifyAccept({
        accept, callId, invite, callerUserId: "alice", calleeUserId: "bob", kind: "video", calleeDevice: bob.record,
      }),
    ).toBe(false);
  });
});

describe("key commitment", () => {
  test("only the key that was committed to is accepted as the reveal", async () => {
    const { invite, ephA, callId } = await setup();
    expect(await verifyReveal({ callId, commit: invite.commit, eph: ephA.pub })).toBe(true);
    const other = await createInvite({ callId, calleeUserId: "bob", kind: "video", identity: (await makeIdentity("alice")).identity });
    expect(await verifyReveal({ callId, commit: invite.commit, eph: other.ephemeral.pub })).toBe(false);
    // The commitment is also specific to the call.
    expect(await verifyReveal({ callId: randomUuid(), commit: invite.commit, eph: ephA.pub })).toBe(false);
    expect(await verifyReveal({ callId, commit: invite.commit, eph: undefined })).toBe(false);
    expect(await verifyReveal({ callId, commit: invite.commit, eph: "not a key" })).toBe(false);
  });

  test("the caller's key is fixed before the callee's is chosen, so a code cannot be ground", async () => {
    // Everything the callee signs and every key it derives depends on the
    // commitment, which exists before the callee picks its own key. Changing
    // the caller key afterwards (to search for matching emoji) breaks the reveal.
    const { callId, invite, answer } = await setup();
    const { accept } = await answer();
    const attacker = await createInvite({ callId, calleeUserId: "bob", kind: "video", identity: (await makeIdentity("alice")).identity });
    expect(accept.eph).toBeTruthy();
    expect(await verifyReveal({ callId, commit: invite.commit, eph: attacker.ephemeral.pub })).toBe(false);
  });
});

async function handshake() {
  const ctx = await setup();
  const { ephemeral: ephB, accept } = await ctx.answer();
  const common = {
    callId: ctx.callId,
    callerUserId: "alice",
    callerDeviceId: ctx.alice.identity.deviceId,
    calleeUserId: "bob",
    calleeDeviceId: ctx.bob.identity.deviceId,
    kind: "video",
    commit: ctx.invite.commit,
    ephCaller: ctx.ephA.pub,
    ephCallee: accept.eph,
  };
  const caller = await deriveCallSession({
    ...common, ephemeralPrivateKey: ctx.ephA.privateKey, peerEph: accept.eph, role: "caller",
  });
  const callee = await deriveCallSession({
    ...common, ephemeralPrivateKey: ephB.privateKey, peerEph: ctx.ephA.pub, role: "callee",
  });
  return { ...ctx, caller, callee, accept, ephB, common };
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

  test("a man in the middle that swaps ephemeral keys ends up with different codes and keys", async () => {
    const { ephA, answer, common } = await handshake();
    // The server replaces the callee's accept with a different ephemeral key.
    const mitm = await answer();
    const real = await answer();
    const callerView = await deriveCallSession({
      ...common, ephCallee: mitm.accept.eph,
      ephemeralPrivateKey: ephA.privateKey, peerEph: mitm.accept.eph, role: "caller",
    });
    const calleeView = await deriveCallSession({
      ...common, ephCallee: real.accept.eph,
      ephemeralPrivateKey: real.ephemeral.privateKey, peerEph: ephA.pub, role: "callee",
    });
    expect(sasEmoji(callerView.sasBytes)).not.toEqual(sasEmoji(calleeView.sasBytes));
    const blob = await sealSignal(callerView, { kind: "offer", seq: 1, payload: { sdp: "x" } });
    await expect(openSignal(calleeView, { kind: "offer", seq: 1, blob })).rejects.toThrow();
  });

  test("the identities are part of the key derivation", async () => {
    const { ephA, ephB, accept, common } = await handshake();
    const sameKeysOtherCaller = await deriveCallSession({
      ...common, callerUserId: "mallory",
      ephemeralPrivateKey: ephB.privateKey, peerEph: ephA.pub, role: "callee",
    });
    const honest = await deriveCallSession({
      ...common, ephemeralPrivateKey: ephB.privateKey, peerEph: ephA.pub, role: "callee",
    });
    expect(Array.from(sameKeysOtherCaller.sasBytes)).not.toEqual(Array.from(honest.sasBytes));
    expect(accept.eph).toBeTruthy();
  });

  test("sessions from different calls derive different codes", async () => {
    const a = await handshake();
    const b = await handshake();
    expect(Array.from(a.caller.sasBytes)).not.toEqual(Array.from(b.caller.sasBytes));
  });
});
