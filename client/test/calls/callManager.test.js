import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { CALL_PHASE } from "../../src/calls/callManager.js";
import { fromB64u, toB64u, randomBytes } from "../../src/e2ee/encoding.js";
import { ApiError } from "../../src/api/e2eeApi.js";
import {
  FakePeerConnection,
  FakeServer,
  linkDataChannels,
  makeGetUserMedia,
  waitFor,
} from "./fakes.js";

const phase = (p) => (c) => c.manager.getState().phase === p;

async function connectedCall({ kind = "audio", aliceOpts, bobOpts } = {}) {
  const server = new FakeServer();
  const alice = await server.addUser("alice", aliceOpts);
  const bob = await server.addUser("bob", bobOpts);
  await alice.manager.startCall({ chatId: "chat-1", peer: { userId: bob.user.id, username: "bob" }, kind });
  await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "bob ringing" });
  await bob.manager.accept();
  await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice) || phase(CALL_PHASE.CONNECTED)(alice), { label: "alice connecting" });
  await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), { label: "both connected" });
  return { server, alice, bob, pcA: alice.pc, pcB: bob.pc };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("happy path", () => {
  test("rings, authenticates both sides, negotiates and connects an audio call", async () => {
    const { alice, bob } = await connectedCall();
    const a = alice.manager.getState();
    const b = bob.manager.getState();
    expect(a.direction).toBe("outgoing");
    expect(b.direction).toBe("incoming");
    expect(b.peer.userId).toBe("user-alice");
    expect(a.callId).toBe(b.callId);
    expect(a.sas).toHaveLength(4);
    expect(a.sas).toEqual(b.sas);
    expect(a.connectedAt).toBeTypeOf("number");
    expect(a.cameraOn).toBe(false);
    expect(alice.getUserMedia.calls[0]).toMatchObject({ video: false });
    expect(alice.api.markCallConnected).toHaveBeenCalledTimes(1);
  });

  test("the signaling server only ever sees ciphertext (no SDP, fingerprint or candidates)", async () => {
    const { server } = await connectedCall();
    const signals = server.log.filter((e) => e.op === "signal");
    expect(signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["offer", "answer", "ice"]));
    for (const s of signals) {
      const text = Buffer.from(fromB64u(s.blob)).toString("latin1");
      expect(text).not.toContain("SECRET-FINGERPRINT");
      expect(text).not.toContain("v=0");
      expect(text).not.toContain("candidate:");
    }
    const everything = JSON.stringify(server.log);
    expect(everything).not.toContain("SECRET-FINGERPRINT");
  });

  test("local descriptions are tuned for battery: Opus DTX/FEC, 24 kbps, 40 ms packets", async () => {
    const { pcA, pcB } = await connectedCall();
    for (const pc of [pcA, pcB]) {
      expect(pc.localDescription.sdp).toContain("usedtx=1");
      expect(pc.localDescription.sdp).toContain("maxaveragebitrate=24000");
      expect(pc.localDescription.sdp).toContain("a=ptime:40");
    }
  });

  test("ICE candidates are batched into few signals and arrive at the peer", async () => {
    const { server, pcA, pcB } = await connectedCall();
    const iceSignals = server.log.filter((e) => e.op === "signal" && e.kind === "ice");
    expect(iceSignals.length).toBeLessThanOrEqual(2); // one batch per side, not one per candidate
    expect(pcA.addedCandidates.length).toBe(2);
    expect(pcB.addedCandidates.length).toBe(2);
  });

  test("the peer connection is configured for low overhead and uses the server's ICE servers", async () => {
    const { pcA } = await connectedCall();
    expect(pcA.config.iceCandidatePoolSize).toBe(0);
    expect(pcA.config.bundlePolicy).toBe("max-bundle");
    expect(pcA.config.iceServers[0].urls[0]).toMatch(/^turn:/);
  });

  test("hang up ends both sides and releases every resource", async () => {
    const { alice, bob, pcA, pcB } = await connectedCall();
    const stream = alice.manager.getState().localStream;
    await alice.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob), { label: "bob ended" });
    expect(alice.manager.getState().endReason).toBe("local_hangup");
    expect(bob.manager.getState().endReason).toBe("hangup");
    expect(pcA.closed).toBe(true);
    await waitFor(() => pcB.closed);
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(alice.manager.isBusy).toBe(false);
  });

  test("returns to idle shortly after the call ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { alice } = await connectedCall();
    await alice.manager.hangup();
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.ENDED);
    await vi.advanceTimersByTimeAsync(3000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.IDLE);
  });
});

describe("ringing outcomes", () => {
  async function ringing() {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" }, kind: "audio" });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    return { server, alice, bob };
  }

  test("declining tells the caller", async () => {
    const { alice, bob } = await ringing();
    await bob.manager.decline();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("declined");
    expect(bob.manager.getState().endReason).toBe("declined_local");
    expect(bob.api.endCall).toHaveBeenCalledWith(alice.manager.getState().callId, "declined");
  });

  test("cancelling before an answer shows the callee a missed call", async () => {
    const { alice, bob } = await ringing();
    await alice.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(bob.manager.getState().endReason).toBe("cancelled");
    expect(alice.manager.getState().endReason).toBe("cancelled_local");
  });

  test("an unanswered call ends with no_answer and tells the server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await vi.advanceTimersByTimeAsync(51_000);
    expect(alice.manager.getState().endReason).toBe("no_answer");
    expect(alice.api.endCall).toHaveBeenCalled();
  });

  test("a call ringing on this device stops silently when another tab handles it", async () => {
    const { bob, alice } = await ringing();
    bob.manager.handleBroadcast({ type: "handled", callId: alice.manager.getState().callId });
    expect(bob.manager.getState().phase).toBe(CALL_PHASE.IDLE);
    expect(bob.api.endCall).not.toHaveBeenCalled();
  });

  test("a busy callee is reported to the caller", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    server.busy = true;
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("busy");
  });

  test("starting a second call while busy is refused", async () => {
    const { alice, bob } = await ringing();
    await expect(
      alice.manager.startCall({ chatId: "c2", peer: { userId: bob.user.id, username: "bob" } }),
    ).rejects.toThrow(/already/i);
  });
});

describe("microphone and camera permissions", () => {
  test("a denied microphone ends the call before anything is sent to the other person", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice", { getUserMedia: makeGetUserMedia({ deny: "NotAllowedError" }) });
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("permission_denied");
    expect(alice.api.startCall).not.toHaveBeenCalled();
  });

  test("a missing device is reported distinctly", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice", { getUserMedia: makeGetUserMedia({ deny: "NotFoundError" }) });
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("no_device");
  });

  test("the callee declining media permission informs the caller", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob", { getUserMedia: makeGetUserMedia({ deny: "NotAllowedError" }) });
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(bob.manager.getState().endReason).toBe("permission_denied");
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
  });
});

describe("attacks on the handshake", () => {
  test("a forged invitation never rings and is reported to the server", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    server.tamper = (event) =>
      event.type === "call_invite"
        ? { ...event, invite: { ...event.invite, sig: toB64u(randomBytes(64)) } }
        : event;
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(bob.manager.getState().endReason).toBe("handshake_failed");
    expect(bob.manager.getState().ringing).toBe(false);
    expect(bob.api.endCall).toHaveBeenCalled();
    expect(bob.getUserMedia).not.toHaveBeenCalled();
  });

  test("an invitation claiming a different caller is rejected", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const mallory = await server.addUser("mallory");
    server.tamper = (event) =>
      event.type === "call_invite"
        ? { ...event, from: { userId: mallory.user.id, username: "mallory" } }
        : event;
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(bob.manager.getState().endReason).toBe("handshake_failed");
  });

  test("a server that swaps the callee's ephemeral key is caught by the caller", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    server.tamper = (event) =>
      event.type === "call_accept"
        ? { ...event, accept: { ...event.accept, eph: toB64u(randomBytes(65)) } }
        : event;
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("handshake_failed");
  });

  test("a server that replaces the callee's device key is caught", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const mallory = await server.addUser("mallory");
    // The directory now claims bob's device id has mallory's keys.
    server.devices.set(bob.user.id, [{ ...mallory.record, id: bob.record.id, userId: bob.user.id }]);
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("handshake_failed");
  });

  test("tampered or replayed signals are ignored and cannot connect the call", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    const callId = bob.manager.getState().callId;
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob));

    const pcBob = bob.pc;
    const before = pcBob.addedCandidates.length;
    const ice = server.log.find((e) => e.op === "signal" && e.kind === "ice" && e.callId === callId);
    // Replay of an already-processed signal
    await bob.manager.handleEvent({ type: "call_signal", callId, kind: ice.kind, blob: ice.blob, seq: ice.seq });
    // Tampered ciphertext with a fresh sequence number
    const bytes = fromB64u(ice.blob);
    bytes[bytes.length - 1] ^= 1;
    await bob.manager.handleEvent({ type: "call_signal", callId, kind: "ice", blob: toB64u(bytes), seq: 99 });
    await new Promise((r) => setImmediate(r));
    expect(pcBob.addedCandidates.length).toBe(before);
    expect(bob.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("repeated forged signals terminate the call", async () => {
    const { alice, bob } = await connectedCall();
    const callId = bob.manager.getState().callId;
    for (let seq = 50; seq < 54; seq += 1) {
      await bob.manager.handleEvent({ type: "call_signal", callId, kind: "ice", blob: toB64u(randomBytes(64)), seq });
    }
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(bob.manager.getState().endReason).toBe("handshake_failed");
    void alice;
  });

  test("signals for other calls or other devices are ignored", async () => {
    const { bob, pcB } = await connectedCall();
    const before = pcB.addedCandidates.length;
    await bob.manager.handleEvent({ type: "call_signal", callId: "other", kind: "ice", blob: toB64u(randomBytes(64)), seq: 1 });
    await bob.manager.handleEvent({ type: "call_end", callId: "other", reason: "hangup" });
    expect(pcB.addedCandidates.length).toBe(before);
    expect(bob.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });
});

describe("mute and video", () => {
  test("muting disables the audio track and tells the peer over the data channel", async () => {
    const { alice, bob, pcA, pcB } = await connectedCall();
    linkDataChannels(pcA, pcB);
    alice.manager.setMuted(true);
    expect(alice.manager.getState().muted).toBe(true);
    expect(alice.manager.getState().localStream.getAudioTracks()[0].enabled).toBe(false);
    await waitFor(() => bob.manager.getState().remoteMuted, { label: "remote mute" });
    alice.manager.setMuted(false);
    await waitFor(() => !bob.manager.getState().remoteMuted);
  });

  test("ignores malformed data-channel messages", async () => {
    const { bob, pcB } = await connectedCall();
    pcB.dc.onmessage({ data: "not json" });
    pcB.dc.onmessage({ data: JSON.stringify({ t: "state", muted: "yes" }) });
    pcB.dc.onmessage({ data: "x".repeat(1000) });
    expect(bob.manager.getState().remoteMuted).toBe(false);
  });

  test("video calls capture a modest resolution and frame rate", async () => {
    const { alice } = await connectedCall({ kind: "video" });
    const constraints = alice.getUserMedia.calls[0];
    expect(constraints.video.width.ideal).toBeLessThanOrEqual(640);
    expect(constraints.video.frameRate.max).toBeLessThanOrEqual(30);
    expect(alice.manager.getState().cameraOn).toBe(true);
  });

  test("turning the camera off stops the track (LED off) and back on re-acquires it", async () => {
    const { alice, pcA } = await connectedCall({ kind: "video" });
    const track = alice.manager.getState().localStream.getVideoTracks()[0];
    await alice.manager.setCameraEnabled(false);
    expect(track.stopped).toBe(true);
    expect(alice.manager.getState().cameraOn).toBe(false);
    expect(pcA.senders.find((s) => s.replaceTrack.mock.calls.length)).toBeTruthy();
    await alice.manager.setCameraEnabled(true);
    expect(alice.manager.getState().cameraOn).toBe(true);
    expect(alice.getUserMedia.calls.at(-1)).toMatchObject({ audio: false });
  });

  test("the camera is released while the page is hidden and restored on return", async () => {
    const { alice } = await connectedCall({ kind: "video" });
    const track = alice.manager.getState().localStream.getVideoTracks()[0];
    await alice.manager.setPageHidden(true);
    expect(track.stopped).toBe(true);
    expect(alice.manager.getState().cameraOn).toBe(false);
    await alice.manager.setPageHidden(false);
    expect(alice.manager.getState().cameraOn).toBe(true);
  });

  test("a hidden page does not override a camera the user turned off", async () => {
    const { alice } = await connectedCall({ kind: "video" });
    await alice.manager.setCameraEnabled(false);
    await alice.manager.setPageHidden(true);
    await alice.manager.setPageHidden(false);
    expect(alice.manager.getState().cameraOn).toBe(false);
  });

  test("audio calls never touch the camera", async () => {
    const { alice } = await connectedCall({ kind: "audio" });
    await alice.manager.setCameraEnabled(true);
    await alice.manager.setPageHidden(true);
    expect(alice.getUserMedia.calls.every((c) => !c.video)).toBe(true);
  });

  test("a screen wake lock is held only for visible video calls", async () => {
    const wakeLockAudio = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    const { alice } = await connectedCall({ kind: "audio", aliceOpts: { requestWakeLock: wakeLockAudio } });
    expect(wakeLockAudio).not.toHaveBeenCalled();
    void alice;

    const wakeLockVideo = vi.fn(async () => ({ release: vi.fn(async () => {}) }));
    await connectedCall({ kind: "video", aliceOpts: { requestWakeLock: wakeLockVideo } });
    await waitFor(() => wakeLockVideo.mock.calls.length > 0);
  });

  test("video codecs are re-ordered so hardware H.264 comes first", async () => {
    const { pcA } = await connectedCall({ kind: "video" });
    const transceiver = pcA.transceivers.find((t) => t.sender.track?.kind === "video");
    const ordered = transceiver.setCodecPreferences.mock.calls[0][0];
    expect(ordered[0].mimeType).toBe("video/H264");
  });
});

describe("network adaptation", () => {
  async function videoCallWithFakeTimers() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ctx = await connectedCall({ kind: "video" });
    return ctx;
  }
  const badStats = [
    { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.9, localCandidateId: "l", remoteCandidateId: "r" },
    { id: "l", type: "local-candidate", candidateType: "relay" },
    { id: "r", type: "remote-candidate", candidateType: "host" },
    { id: "x", type: "remote-inbound-rtp", fractionLost: 0.2 },
  ];
  const goodStats = [
    { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.05, localCandidateId: "l", remoteCandidateId: "r" },
    { id: "l", type: "local-candidate", candidateType: "host" },
    { id: "r", type: "remote-candidate", candidateType: "host" },
    { id: "x", type: "remote-inbound-rtp", fractionLost: 0 },
  ];

  test("a poor network steps video quality down and finally drops to audio only", async () => {
    const { alice, pcA } = await videoCallWithFakeTimers();
    pcA.statsReport = badStats;
    const tiers = [];
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      tiers.push(alice.manager.getState().videoTier);
    }
    expect(tiers[0]).toBe("low");
    expect(tiers.at(-1)).toBe("off");
    expect(alice.manager.getState().cameraOn).toBe(false);
    expect(alice.manager.getState().networkPaused).toBe(true);
    expect(alice.manager.getState().relayed).toBe(true);
  });

  test("video comes back after the network has been healthy for a while", async () => {
    const { alice, pcA } = await videoCallWithFakeTimers();
    pcA.statsReport = badStats;
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().videoTier).toBe("off");
    pcA.statsReport = goodStats;
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().networkPaused).toBe(false);
    expect(alice.manager.getState().cameraOn).toBe(true);
    expect(alice.manager.getState().videoTier).not.toBe("off");
  });

  test("audio-only calls do not poll stats for adaptation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, pcA } = await connectedCall({ kind: "audio" });
    pcA.statsReport = badStats;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(alice.manager.getState().videoTier).toBe("mid");
  });
});

describe("connection recovery", () => {
  test("the caller restarts ICE when the connection fails", async () => {
    const { server, pcA } = await connectedCall();
    const offersBefore = server.log.filter((e) => e.op === "signal" && e.kind === "offer").length;
    pcA.setState("failed");
    await waitFor(() => server.log.filter((e) => e.op === "signal" && e.kind === "offer").length > offersBefore);
    expect(pcA.offerOptions.at(-1)).toEqual({ iceRestart: true });
  });

  test("the call ends if recovery never succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, bob, pcA, pcB } = await connectedCall();
    pcA.setState("failed");
    pcB.setState("failed");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED); // still waiting for recovery
    await vi.advanceTimersByTimeAsync(2_000);
    expect(alice.manager.getState().endReason).toBe("failed");
    expect(bob.manager.getState().endReason).toBe("failed");
  });

  test("brief disconnects are tolerated", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, pcA } = await connectedCall();
    pcA.setState("disconnected");
    await vi.advanceTimersByTimeAsync(3000);
    pcA.setState("connected");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });
});

describe("page unload", () => {
  test("hangupOnUnload fires the beacon once and tears down", async () => {
    const { alice } = await connectedCall();
    const beacon = vi.fn();
    const callId = alice.manager.getState().callId;
    alice.manager.hangupOnUnload(beacon);
    alice.manager.hangupOnUnload(beacon);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon).toHaveBeenCalledWith(callId);
    expect(alice.manager.isBusy).toBe(false);
  });
});

describe("errors from the server", () => {
  test("a failing invite request ends the call cleanly", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    alice.api.startCall.mockRejectedValueOnce(new ApiError("nope", { status: 403 }));
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("failed");
    expect(alice.manager.getState().localStream).toBeNull();
  });
});
