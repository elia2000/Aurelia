import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { CALL_PHASE } from "../../src/calls/callManager.js";
import { fromB64u, toB64u, randomBytes } from "../../src/e2ee/encoding.js";
import { ApiError } from "../../src/api/e2eeApi.js";
import {
  FakePeerConnection,
  FakeServer,
  FakeStream,
  FakeTrack,
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
  FakePeerConnection.autoConnect = true;
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

  test("the admin's force-relay setting makes both sides use relay candidates only", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const u of [alice, bob]) {
      u.api.fetchIceConfig.mockResolvedValue({ iceServers: [{ urls: ["turn:t:3478"], username: "u", credential: "c" }], forceRelay: true });
    }
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => alice.pc && bob.pc);
    expect(alice.pc.config.iceTransportPolicy).toBe("relay");
    expect(bob.pc.config.iceTransportPolicy).toBe("relay");
  });

  test("by default both candidate types are allowed", async () => {
    const { pcA } = await connectedCall();
    expect(pcA.config.iceTransportPolicy).toBeUndefined();
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
    // A call that was up and then lost its connection says so (it did not fail to connect).
    expect(alice.manager.getState().endReason).toBe("connection_lost");
    expect(bob.manager.getState().endReason).toBe("connection_lost");
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

// ── regressions found in review ──────────────────────────────────────────────
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const peerOf = (ctx) => ({ userId: ctx.user.id, username: ctx.user.username });
const liveTracks = (stream) => stream.getTracks().filter((t) => !t.stopped);

describe("ringing calls and other devices", () => {
  test("reloading or closing the page while a call only rings does not decline it", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));

    const beacon = vi.fn();
    bob.manager.hangupOnUnload(beacon);

    expect(beacon).not.toHaveBeenCalled();
    expect(bob.api.endCall).not.toHaveBeenCalled();
    expect(bob.manager.getState().phase).toBe(CALL_PHASE.IDLE);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.OUTGOING); // still ringing for others
  });

  test("closing the page during a call you placed or accepted still hangs up for everyone", async () => {
    const { alice, bob } = await connectedCall();
    const beaconA = vi.fn();
    const beaconB = vi.fn();
    alice.manager.hangupOnUnload(beaconA);
    bob.manager.hangupOnUnload(beaconB);
    expect(beaconA).toHaveBeenCalledTimes(1);
    expect(beaconB).toHaveBeenCalledTimes(1);

    const server = new FakeServer();
    const caller = await server.addUser("alice");
    const callee = await server.addUser("bob");
    await caller.manager.startCall({ chatId: "c", peer: peerOf(callee) });
    const beaconC = vi.fn();
    caller.manager.hangupOnUnload(beaconC);
    expect(beaconC).toHaveBeenCalledTimes(1);
  });

  test("losing a double-accept race never ends the call the other device just connected", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob"); // phone
    const laptop = await server.addDevice("bob");
    const slow = deferred();
    laptop.getUserMedia.mockImplementationOnce(async () => slow.promise);

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob) && phase(CALL_PHASE.INCOMING)(laptop));

    // The laptop taps Accept first, but its permission prompt stays open ...
    const lateAccept = laptop.manager.accept();
    // ... the phone answers and connects.
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob));

    // The laptop learns it lost while it was still waiting for the prompt.
    await waitFor(() => laptop.manager.getState().phase === CALL_PHASE.IDLE, { label: "laptop stops" });
    slow.resolve(new (await import("./fakes.js")).FakeStream([new (await import("./fakes.js")).FakeTrack("audio")]));
    await lateAccept;

    expect(laptop.api.acceptCall).not.toHaveBeenCalled();
    expect(laptop.api.endCall).not.toHaveBeenCalled();
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
    expect(bob.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("a 409 on accept (answered elsewhere) resets quietly instead of reporting a failure", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const laptop = await server.addDevice("bob");
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob) && phase(CALL_PHASE.INCOMING)(laptop));

    // Both accept "at the same time": the second request meets a 409.
    server.tamper = (event) => (event.type === "call_accepted_elsewhere" ? null : event);
    await Promise.all([bob.manager.accept(), laptop.manager.accept()]);

    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice));
    const endCalls = [...bob.api.endCall.mock.calls, ...laptop.api.endCall.mock.calls];
    expect(endCalls).toHaveLength(0);
    const phases = [bob.manager.getState().phase, laptop.manager.getState().phase].sort();
    expect(phases).toContain(CALL_PHASE.IDLE);
    expect(alice.manager.getState().phase).not.toBe(CALL_PHASE.ENDED);
  });

  test("an invitation that arrives while the previous call is still on screen rings", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await alice.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob)); // lingers for a moment

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "second call rings" });
  });

  test("when both people call each other at once, the call that lost rings instead of vanishing", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await Promise.all([
      alice.manager.startCall({ chatId: "c", peer: peerOf(bob) }),
      bob.manager.startCall({ chatId: "c", peer: peerOf(alice) }),
    ]);
    // Exactly one call stands: one side rings the other.
    await waitFor(
      () =>
        (phase(CALL_PHASE.INCOMING)(alice) && phase(CALL_PHASE.OUTGOING)(bob)) ||
        (phase(CALL_PHASE.INCOMING)(bob) && phase(CALL_PHASE.OUTGOING)(alice)),
      { label: "one ringing, one calling" },
    );
    const incoming = phase(CALL_PHASE.INCOMING)(alice) ? alice : bob;
    await incoming.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob));
  });
});

describe("media never outlives the call", () => {
  test("a permission prompt answered after the call already failed does not leave the microphone on", async () => {
    const server = new FakeServer();
    const slow = deferred();
    const alice = await server.addUser("alice", { getUserMedia: vi.fn(async () => slow.promise) });
    const bob = await server.addUser("bob");
    alice.api.fetchIceConfig.mockRejectedValueOnce(new ApiError("down", { status: 503 }));

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));

    const { FakeStream, FakeTrack } = await import("./fakes.js");
    const stream = new FakeStream([new FakeTrack("audio"), new FakeTrack("video")]);
    slow.resolve(stream); // the person finally clicks "Allow"
    await waitFor(() => liveTracks(stream).length === 0, { label: "tracks stopped" });
  });

  test("the same for the person accepting a call", async () => {
    const server = new FakeServer();
    const slow = deferred();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob", { getUserMedia: vi.fn(async () => slow.promise) });
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    bob.api.fetchIceConfig.mockRejectedValueOnce(new ApiError("down", { status: 503 }));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));

    const { FakeStream, FakeTrack } = await import("./fakes.js");
    const stream = new FakeStream([new FakeTrack("audio")]);
    slow.resolve(stream);
    await waitFor(() => liveTracks(stream).length === 0, { label: "tracks stopped" });
  });

  test("hanging up while the invite request is in flight cancels the call on the server afterwards", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const gate = deferred();
    const realStart = alice.api.startCall.getMockImplementation();
    alice.api.startCall.mockImplementationOnce(async (args) => {
      await gate.promise;
      return realStart(args);
    });

    const starting = alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => alice.api.startCall.mock.calls.length === 1);
    await alice.manager.hangup();
    gate.resolve();
    await starting;
    await waitFor(() => alice.api.endCall.mock.calls.length >= 2, { label: "second cancel" });
  });

  test("a camera that is still starting when the page is hidden again is not left running", async () => {
    const { alice } = await connectedCall({ kind: "video" });
    alice.manager.setPageHidden(true);
    await waitFor(() => alice.manager.getState().cameraOn === false);

    const slow = deferred();
    alice.getUserMedia.mockImplementationOnce(async () => slow.promise);
    const back = alice.manager.setPageHidden(false); // starts a slow re-acquire ...
    await waitFor(() => alice.getUserMedia.mock.calls.length >= 2);
    const gone = alice.manager.setPageHidden(true); // ... and the page is hidden again
    const { FakeStream, FakeTrack } = await import("./fakes.js");
    const fresh = new FakeStream([new FakeTrack("video")]);
    slow.resolve(fresh);
    await Promise.all([back, gone]);

    // The late camera was never put on the wire, not even briefly.
    const sent = alice.pc.senders.flatMap((sender) => sender.replaceTrack.mock.calls.map(([track]) => track));
    expect(sent).not.toContain(fresh.getTracks()[0]);
    expect(liveTracks(fresh)).toHaveLength(0);
    expect(alice.manager.getState().cameraOn).toBe(false);
    expect(alice.manager.getState().localStream.getVideoTracks()).toHaveLength(0);
  });

  test("a screen wake lock that arrives after hanging up is released", async () => {
    const release = vi.fn(async () => {});
    const gate = deferred();
    const { alice } = await (async () => {
      const server = new FakeServer();
      const a = await server.addUser("alice", { requestWakeLock: vi.fn(async () => gate.promise) });
      const b = await server.addUser("bob");
      await a.manager.startCall({ chatId: "c", peer: peerOf(b), kind: "video" });
      await waitFor(() => phase(CALL_PHASE.INCOMING)(b));
      await b.manager.accept();
      await waitFor(() => phase(CALL_PHASE.CONNECTED)(a));
      return { alice: a };
    })();
    await alice.manager.hangup();
    gate.resolve({ release });
    await waitFor(() => release.mock.calls.length === 1, { label: "wake lock released" });
  });
});

describe("key commitment in the call flow", () => {
  test("the invite sent to the server holds a commitment, and the key is revealed once with the first offer", async () => {
    const { server } = await connectedCall();
    const invite = server.log.find((e) => e.op === "startCall").invite;
    expect(invite.eph).toBeUndefined();
    expect(invite.commit).toBeTruthy();
    const reveals = server.log.filter((e) => e.op === "signal" && e.eph);
    expect(reveals).toHaveLength(1);
    expect(reveals[0].kind).toBe("offer");
  });

  test("a revealed key that does not match the commitment ends the call", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const other = await server.addUser("carol");
    const wrongKey = (await import("../../src/e2ee/crypto.js")).generateEphemeralEcdh;
    const pair = await wrongKey();
    const wrong = toB64u(await (await import("../../src/e2ee/crypto.js")).exportPublicRaw(pair.publicKey));
    server.tamper = (event) => (event.type === "call_signal" && event.eph ? { ...event, eph: wrong } : event);
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob), { label: "callee rejects reveal" });
    expect(bob.manager.getState().endReason).toBe("handshake_failed");
    expect(other.user.id).toBeTruthy();
  });

  test("candidates that arrive before the key reveal are held, not counted as attacks", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    const held = [];
    server.tamper = (event) => {
      if (event.type === "call_signal" && event.kind === "offer" && event.eph) {
        held.push(event);
        return null; // the offer is delayed in the network ...
      }
      return event;
    };
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => held.length === 1, { label: "offer in flight" });
    // ... while later messages reach the callee first.
    const early = server.log.filter((e) => e.op === "signal" && e.kind === "ice");
    expect(early.length).toBeGreaterThanOrEqual(0);

    server.tamper = null;
    await bob.manager.handleEvent(held[0]);
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), {
      label: "connected after the delayed offer",
    });
  });
});

describe("devices the person has not acknowledged", () => {
  test("a brand-new device of a verified contact answering the call stops it", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    // Alice has seen Bob's only device and verified him.
    await alice.directory.getUserDevices(bob.user.id);
    await alice.trust.setVerified(bob.user.id, "1234", true);
    // A second device appears under Bob's account.
    const rogue = await server.addDevice("bob");

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(rogue));
    await rogue.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice), { label: "alice blocks the call" });
    expect(alice.manager.getState().endReason).toBe("key_mismatch");
  });

  test("for someone you did not verify, the new device is shown as a warning and the call goes on", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.directory.getUserDevices(bob.user.id); // pins Bob's first device
    const second = await server.addDevice("bob");

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(second));
    expect(alice.manager.getState().trust.status).toBe("devices_added");
    await second.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice));
    // The warning is still there: answering did not quietly pin the device.
    expect(alice.manager.getState().trust).toMatchObject({ status: "devices_added" });
    const again = await alice.directory.getUserDevices(bob.user.id, { force: true });
    expect(again.assessment.status).toBe("devices_added");
  });

  test("a new device of a verified contact cannot ring you", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await bob.directory.getUserDevices(alice.user.id);
    await bob.trust.setVerified(alice.user.id, "1234", true);
    const aliceNewPhone = await server.addDevice("alice");

    await aliceNewPhone.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob), { label: "bob refuses the invite" });
    expect(bob.manager.getState().endReason).toBe("key_mismatch");
    expect(bob.getUserMedia).not.toHaveBeenCalled();
  });
});

describe("waiting versus ringing", () => {
  test("the caller waits until the other person's app reports that it is ringing", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    server.managers.set(bob.user.id, []); // bob's app is closed: nothing is delivered to it

    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => alice.manager.getState().waiting, { label: "waiting" });
    expect(alice.manager.getState()).toMatchObject({ phase: "outgoing", waiting: true, ringing: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(alice.manager.getState().ringing).toBe(false); // still nobody reached

    // Bob opens the app: the pending call rings there and the caller is told.
    server.managers.set(bob.user.id, [bob.manager]);
    const invite = server.log.find((e) => e.op === "startCall");
    await bob.manager.handleEvent({
      type: "call_invite",
      callId: invite.callId,
      kind: "audio",
      chatId: "c",
      from: { userId: alice.user.id, username: "alice", nickname: "alice" },
      invite: invite.invite,
    });
    await waitFor(() => alice.manager.getState().ringing, { label: "ringing" });
    expect(alice.manager.getState()).toMatchObject({ ringing: true, waiting: false });
    expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1);
  });

  test("an online callee is rung almost immediately", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await waitFor(() => alice.manager.getState().ringing, { label: "ringing" });
    expect(alice.manager.getState().waiting).toBe(false);
  });

  test("a ringing report that arrives after the call moved on changes nothing", async () => {
    const { alice } = await connectedCall();
    const callId = alice.manager.getState().callId;
    await alice.manager.handleEvent({ type: "call_ringing", callId });
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTED, ringing: false });
  });
});

describe("connections that do not come up", () => {
  const stuckCall = async (hasRelay) => {
    FakePeerConnection.autoConnect = false;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const who of [alice, bob]) {
      who.api.fetchIceConfig.mockResolvedValue({ iceServers: [], hasRelay });
    }
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice) && phase(CALL_PHASE.CONNECTING)(bob), { label: "connecting" });
    return { alice, bob };
  };

  test("a slow connection says it is still trying", async () => {
    const { alice } = await stuckCall(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // (timers armed before faking keep their real clock, so wait for real)
    vi.useRealTimers();
    await waitFor(() => alice.manager.getState().connectingSlow, { timeout: 12_000, label: "slow hint" });
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTING);
  }, 20_000);

  test("with no relay configured the failure points at the relay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, bob } = await stuckCall(false);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed_no_relay");
    expect(bob.manager.getState().endReason).toBe("connect_failed_no_relay");
  });

  test("with a relay the failure is a plain connection failure, and the other side is told", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, bob } = await stuckCall(true);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed");
    expect(bob.manager.getState().endReason).toBe("connect_failed");
    // Reported to the server as a failure, not a hang-up.
    const reports = [...alice.api.endCall.mock.calls, ...bob.api.endCall.mock.calls];
    expect(reports.some(([, reason]) => reason === "failed")).toBe(true);
  });
});

describe("video calls with the camera off", () => {
  const videoCall = async ({ aliceOpts, bobOpts, aliceCamera, bobCamera } = {}) => {
    const server = new FakeServer();
    const alice = await server.addUser("alice", aliceOpts);
    const bob = await server.addUser("bob", bobOpts);
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob), kind: "video", camera: aliceCamera });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept({ camera: bobCamera });
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), { label: "connected" });
    linkDataChannels(alice.pc, bob.pc);
    return { server, alice, bob };
  };

  test("answering with the camera off never opens the camera, yet the call is still a video call", async () => {
    const { alice, bob } = await videoCall({ bobCamera: false });
    expect(bob.getUserMedia.calls.every((c) => c.video === false)).toBe(true);
    const state = bob.manager.getState();
    expect(state).toMatchObject({ kind: "video", cameraOn: false });
    expect(state.localStream.getVideoTracks()).toHaveLength(0);
    // A two-way video line exists, so the camera can be turned on later without renegotiating.
    const line = bob.pc.transceivers.find((t) => t.receiver.track.kind === "video");
    expect(line?.direction).toBe("sendrecv");
    // The other person is told, so their screen can go black instead of showing a frozen frame.
    await waitFor(() => alice.manager.getState().remoteCameraOn === false, { label: "alice sees camera off" });
  });

  test("the camera can be turned on later, and the other person is told", async () => {
    const { alice, bob } = await videoCall({ bobCamera: false });
    await bob.manager.setCameraEnabled(true);
    await waitFor(() => bob.manager.getState().cameraOn, { label: "camera on" });
    const sender = bob.pc.transceivers.find((t) => t.receiver.track.kind === "video").sender;
    expect(sender.replaceTrack).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
    await waitFor(() => alice.manager.getState().remoteCameraOn === true, { label: "alice sees camera on" });
  });

  test("a caller can also start a video call with the camera off", async () => {
    const { alice } = await videoCall({ aliceCamera: false });
    expect(alice.getUserMedia.calls.every((c) => c.video === false)).toBe(true);
    expect(alice.manager.getState()).toMatchObject({ kind: "video", cameraOn: false });
  });

  test("a blocked camera does not end the call: the person joins without video and is told", async () => {
    const noCamera = vi.fn(async (constraints) => {
      if (constraints.video) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      return new FakeStream([new FakeTrack("audio")]);
    });
    const { bob } = await videoCall({ bobOpts: { getUserMedia: noCamera } });
    expect(bob.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTED, cameraOn: false, cameraBlocked: "permission_denied" });
  });

  test("a missing camera is reported distinctly", async () => {
    const noCamera = vi.fn(async (constraints) => {
      if (constraints.video) throw Object.assign(new Error("none"), { name: "NotFoundError" });
      return new FakeStream([new FakeTrack("audio")]);
    });
    const { alice } = await videoCall({ aliceOpts: { getUserMedia: noCamera } });
    expect(alice.manager.getState().cameraBlocked).toBe("no_device");
  });

  test("a blocked microphone still ends a video call", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice", { getUserMedia: makeGetUserMedia({ deny: "NotAllowedError" }) });
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob), kind: "video" });
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.manager.getState().endReason).toBe("permission_denied");
  });

  test("a remote video track alone does not claim that their camera is on; media flowing does", async () => {
    const { alice } = await videoCall({ bobCamera: false });
    // A browser creates the remote video track as soon as the line is negotiated,
    // but it stays muted until a picture actually arrives.
    const track = new FakeTrack("video");
    track.muted = true;
    alice.pc.ontrack({ track });
    expect(alice.manager.getState().remoteCameraOn).toBe(false);
    track.onunmute();
    expect(alice.manager.getState().remoteCameraOn).toBe(true);
  });
});
