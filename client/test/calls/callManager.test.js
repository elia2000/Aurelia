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
  tick,
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
  FakePeerConnection.relayCandidates = false;
  FakePeerConnection.relayOn = null;
  FakePeerConnection.iceErrors = [];
  FakePeerConnection.gatheringCompletes = true;
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
    // The call can report "connected" a moment before the last batch has been handled.
    await waitFor(() => pcA.addedCandidates.length >= 2 && pcB.addedCandidates.length >= 2, { label: "candidates arrived" });
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

  test("a failure stays on screen long enough to read, and can be dismissed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { alice } = await connectedCall();
    const callId = alice.manager.getState().callId;
    await alice.manager.handleEvent({ type: "call_end", callId, reason: "connect_failed" });
    expect(alice.manager.getState().endReason).toBe("connection_lost");
    await vi.advanceTimersByTimeAsync(3000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.ENDED); // the long explanation is still there
    alice.manager.dismiss();
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.IDLE);
    expect(alice.manager.isBusy).toBe(false);
    alice.manager.dismiss(); // harmless when there is nothing to dismiss
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

  test("video calls start with a 720p picture at up to 30 frames, which the encoder scales down when needed", async () => {
    const { alice } = await connectedCall({ kind: "video" });
    const constraints = alice.getUserMedia.calls[0];
    expect(constraints.video.height.ideal).toBe(720);
    expect(constraints.video.width.max).toBeLessThanOrEqual(1280);
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

describe("video quality", () => {
  const videoCall = async (opts = {}) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ctx = await connectedCall({ kind: "video", ...opts });
    linkDataChannels(ctx.pcA, ctx.pcB); // the in-band channel the two devices talk over
    await vi.advanceTimersByTimeAsync(10);
    return ctx;
  };
  const sentBy = (pc) => pc.senders.find((sender) => sender.track?.kind === "video");
  const goodStats = [
    { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.05, localCandidateId: "l", remoteCandidateId: "r" },
    { id: "l", type: "local-candidate", candidateType: "host" },
    { id: "r", type: "remote-candidate", candidateType: "host" },
    { id: "x", type: "remote-inbound-rtp", fractionLost: 0 },
  ];
  const badStats = [
    { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.9, localCandidateId: "l", remoteCandidateId: "r" },
    { id: "l", type: "local-candidate", candidateType: "host" },
    { id: "r", type: "remote-candidate", candidateType: "host" },
    { id: "x", type: "remote-inbound-rtp", fractionLost: 0.2 },
  ];
  const settle = () => vi.advanceTimersByTimeAsync(50);

  test("starts on Auto, or on what this device chose last time", async () => {
    const { alice } = await videoCall();
    expect(alice.manager.getState().quality).toBe("auto");
    vi.useRealTimers();
    const saved = await connectedCall({ kind: "video", aliceOpts: { loadQuality: () => "hd" } });
    expect(saved.alice.manager.getState().quality).toBe("hd");
  });

  test("choosing a level is remembered and refused when it is not a level", async () => {
    const saveQuality = vi.fn();
    const { alice } = await videoCall({ aliceOpts: { saveQuality } });
    alice.manager.setQuality("fhd");
    expect(alice.manager.getState().quality).toBe("fhd");
    expect(saveQuality).toHaveBeenCalledWith("fhd");
    alice.manager.setQuality("off");
    alice.manager.setQuality("__proto__");
    alice.manager.setQuality(undefined);
    expect(alice.manager.getState().quality).toBe("fhd");
    expect(saveQuality).toHaveBeenCalledTimes(1);
  });

  test("what one person asks to watch sets what the other sends", async () => {
    const { alice, bob, pcB } = await videoCall();
    alice.manager.setQuality("hd");
    await settle();
    // Bob is the one sending to Alice: his picture now goes out at 720p.
    expect(bob.manager.getState().videoTier).toBe("hd");
    expect(sentBy(pcB).params.encodings[0]).toMatchObject({ maxBitrate: 1_800_000, maxFramerate: 30, active: true });
    // Alice's own request does not change what she sends.
    expect(alice.manager.getState().videoTier).toBe("mid");
  });

  test("a fixed level is kept even when the network looks bad, and the camera is not paused for it", async () => {
    const { alice, bob, pcB } = await videoCall();
    alice.manager.setQuality("fhd");
    await settle();
    pcB.statsReport = badStats;
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(bob.manager.getState().videoTier).toBe("fhd");
    expect(bob.manager.getState().cameraOn).toBe(true);
    expect(bob.manager.getState().networkPaused).toBe(false);
  });

  test("asking for a fixed level brings back a picture that was paused for the network", async () => {
    const { alice, bob, pcB } = await videoCall();
    pcB.statsReport = badStats;
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(bob.manager.getState().networkPaused).toBe(true);
    alice.manager.setQuality("high");
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(bob.manager.getState().networkPaused).toBe(false);
    expect(bob.manager.getState().cameraOn).toBe(true);
    expect(bob.manager.getState().videoTier).toBe("high");
  });

  test("Auto climbs with a healthy network, up to 720p", async () => {
    const { bob, pcB } = await videoCall();
    pcB.statsReport = goodStats;
    for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(bob.manager.getState().videoTier).toBe("hd");
  });

  test("going back to Auto from the top level comes down to 720p and adapts again", async () => {
    const { alice, bob, pcB } = await videoCall();
    alice.manager.setQuality("fhd");
    await settle();
    expect(bob.manager.getState().videoTier).toBe("fhd");
    alice.manager.setQuality("auto");
    await settle();
    expect(bob.manager.getState().videoTier).toBe("hd");
    pcB.statsReport = badStats;
    await vi.advanceTimersByTimeAsync(5000);
    expect(bob.manager.getState().videoTier).toBe("high");
  });

  test("the camera is asked for a bigger picture when the other side wants the top level", async () => {
    const { alice, bob } = await videoCall();
    const track = bob.manager.getState().localStream.getVideoTracks()[0];
    track.applyConstraints = vi.fn(async () => {});
    alice.manager.setQuality("fhd");
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ height: { ideal: 1080, max: 1080 } }));
    track.applyConstraints.mockClear();
    alice.manager.setQuality("fhd"); // nothing new
    await settle();
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  test("quick changes of what is asked for are applied to the camera one after the other, ending on the last", async () => {
    const { alice, bob } = await videoCall();
    const track = bob.manager.getState().localStream.getVideoTracks()[0];
    const pending = [];
    track.applyConstraints = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    alice.manager.setQuality("fhd");
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
    expect(track.applyConstraints.mock.calls[0][0].height.ideal).toBe(1080);
    // Asked again while the camera is still being changed: it waits its turn.
    alice.manager.setQuality("mid");
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledTimes(1);
    pending[0]();
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);
    expect(track.applyConstraints.mock.calls[1][0].height.ideal).toBe(360);
    pending[1]();
    await settle();
    expect(bob.manager.getState().videoTier).toBe("mid");
    // Asking for something and then changing mind before the camera got to it: only the last one is applied.
    alice.manager.setQuality("high");
    alice.manager.setQuality("hd");
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledTimes(3);
    expect(track.applyConstraints.mock.calls[2][0].height.ideal).toBe(720);
    pending.splice(0).forEach((resolve) => resolve());
    await settle();
    expect(track.applyConstraints).toHaveBeenCalledTimes(3);
    expect(bob.manager.getState().videoTier).toBe("hd");
  });

  test("a level asked for while the camera is starting is applied to the camera that arrives", async () => {
    const { alice, bob } = await videoCall();
    await bob.manager.setCameraEnabled(false);
    await settle();
    alice.manager.setQuality("low");
    await settle();
    // The camera starts slowly: the answer comes after the viewer changed their mind.
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const fresh = new FakeTrack("video");
    fresh.applyConstraints = vi.fn(async () => {});
    bob.getUserMedia.mockImplementationOnce(async () => {
      await held;
      return new FakeStream([fresh]);
    });
    const turnedOn = bob.manager.setCameraEnabled(true);
    await settle();
    alice.manager.setQuality("fhd");
    await settle();
    release();
    await turnedOn;
    await settle();
    expect(bob.manager.getState().cameraOn).toBe(true);
    expect(fresh.applyConstraints).toHaveBeenCalledTimes(1);
    expect(fresh.applyConstraints.mock.calls[0][0].height.ideal).toBe(1080);
  });

  test("the picture of the other person is not reported once their camera is off", async () => {
    const { alice, pcA, bob } = await videoCall();
    pcA.statsReport = [...goodStats, { id: "v", type: "inbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().videoStats).toEqual({ width: 1280, height: 720, fps: 30 });
    await bob.manager.setCameraEnabled(false);
    await settle();
    expect(alice.manager.getState().remoteCameraOn).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().videoStats).toBeNull();
  });

  test("a request that is not a real level counts as Auto", async () => {
    const { alice, bob, pcB } = await videoCall();
    alice.manager.setQuality("hd");
    await settle();
    expect(bob.manager.getState().videoTier).toBe("hd");
    // A misbehaving peer sends nonsense on the in-band channel.
    pcB.dc.onmessage({ data: JSON.stringify({ t: "state", muted: false, video: true, q: "__proto__" }) });
    await settle();
    pcB.statsReport = badStats;
    await vi.advanceTimersByTimeAsync(5000);
    expect(bob.manager.getState().videoTier).toBe("high"); // adapting again, from the 720p it was on
  });

  test("the picture that arrives is reported, and only when it changes", async () => {
    const { alice, pcA } = await videoCall();
    expect(alice.manager.getState().videoStats).toBeNull();
    pcA.statsReport = [...goodStats, { id: "v", type: "inbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30 }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().videoStats).toEqual({ width: 1280, height: 720, fps: 30 });
    const before = alice.manager.getState();
    await vi.advanceTimersByTimeAsync(5000);
    expect(alice.manager.getState().videoStats).toBe(before.videoStats);
  });
});

describe("choosing the microphone", () => {
  const audioSender = (pc) => pc.senders.find((sender) => sender.track?.kind === "audio");

  test("a new microphone replaces the old one without a new negotiation, and the old one is released", async () => {
    const { alice, pcA } = await connectedCall();
    const before = alice.manager.getState().localStream.getAudioTracks()[0];
    const offers = pcA.offerOptions.length;
    expect(await alice.manager.setMicrophone("usb-mic")).toBe(true);
    const after = alice.manager.getState().localStream.getAudioTracks();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before);
    expect(after[0].getSettings().deviceId).toBe("usb-mic");
    expect(before.stopped).toBe(true);
    expect(audioSender(pcA).track).toBe(after[0]);
    expect(pcA.offerOptions.length).toBe(offers);
    expect(alice.getUserMedia.calls.at(-1)).toMatchObject({ video: false, audio: { deviceId: { exact: "usb-mic" }, echoCancellation: true } });
    expect(alice.manager.getState().microphoneId).toBe("usb-mic");
  });

  test("a muted call stays muted on the new microphone", async () => {
    const { alice } = await connectedCall();
    alice.manager.setMuted(true);
    await alice.manager.setMicrophone("usb-mic");
    expect(alice.manager.getState().localStream.getAudioTracks()[0].enabled).toBe(false);
    expect(alice.manager.getState().muted).toBe(true);
  });

  test("a microphone that cannot be opened leaves the call on the old one and says so", async () => {
    const calls = [];
    const getUserMedia = vi.fn(async (constraints) => {
      calls.push(constraints);
      if (constraints.audio?.deviceId) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
      return new FakeStream([new FakeTrack("audio")]);
    });
    const { alice, pcA } = await connectedCall({ aliceOpts: { getUserMedia } });
    const before = alice.manager.getState().localStream.getAudioTracks()[0];
    expect(await alice.manager.setMicrophone("unplugged")).toBe(false);
    expect(alice.manager.getState().localStream.getAudioTracks()[0]).toBe(before);
    expect(before.stopped).toBe(false);
    expect(audioSender(pcA).track).toBe(before);
    expect(alice.manager.getState().audioDeviceError).toBe("no_device");
    // The next try starts clean.
    getUserMedia.mockImplementation(async () => new FakeStream([new FakeTrack("audio", "other")]));
    expect(await alice.manager.setMicrophone("other")).toBe(true);
    expect(alice.manager.getState().audioDeviceError).toBeNull();
  });

  test("asking for the same microphone again does nothing, and there is nothing to do outside a call", async () => {
    const idle = new FakeServer();
    const lonely = await idle.addUser("carol");
    expect(await lonely.manager.setMicrophone("x")).toBe(false);

    const { alice } = await connectedCall();
    await alice.manager.setMicrophone("usb-mic");
    const requests = alice.getUserMedia.calls.length;
    expect(await alice.manager.setMicrophone("usb-mic")).toBe(true);
    expect(alice.getUserMedia.calls.length).toBe(requests);
  });

  test("a microphone that is unplugged mid-call is replaced by the system default", async () => {
    const { alice, pcA } = await connectedCall();
    await alice.manager.setMicrophone("usb-mic");
    const unplugged = alice.manager.getState().localStream.getAudioTracks()[0];
    const requests = alice.getUserMedia.calls.length;
    unplugged.readyState = "ended";
    unplugged.onended?.();
    await waitFor(() => alice.manager.getState().localStream.getAudioTracks()[0] !== unplugged, { label: "replaced" });
    const next = alice.manager.getState().localStream.getAudioTracks();
    expect(next).toHaveLength(1);
    expect(audioSender(pcA).track).toBe(next[0]);
    // It asked for whatever the system uses now, not for the device that went away.
    expect(alice.getUserMedia.calls.length).toBe(requests + 1);
    expect(alice.getUserMedia.calls.at(-1).audio.deviceId).toBeUndefined();
    expect(alice.manager.getState().microphoneId).toBe("default");
  });

  test("a call whose first microphone is unplugged recovers the same way", async () => {
    const { alice } = await connectedCall();
    const first = alice.manager.getState().localStream.getAudioTracks()[0];
    first.readyState = "ended";
    first.onended?.();
    await waitFor(() => alice.manager.getState().localStream.getAudioTracks()[0] !== first, { label: "replaced" });
    expect(alice.manager.getState().localStream.getAudioTracks()).toHaveLength(1);
  });

  test("a microphone we replaced ourselves does not trigger a recovery, and recovery gives up after a few tries", async () => {
    const { alice } = await connectedCall();
    const before = alice.manager.getState().localStream.getAudioTracks()[0];
    await alice.manager.setMicrophone("usb-mic");
    const requests = alice.getUserMedia.calls.length;
    before.onended?.(); // the old track, long gone from the call
    await tick();
    expect(alice.getUserMedia.calls.length).toBe(requests);

    // A device that keeps dropping out is not chased for ever.
    for (let i = 0; i < 6; i += 1) {
      const current = alice.manager.getState().localStream.getAudioTracks()[0];
      current.readyState = "ended";
      current.onended?.();
      await tick();
      await tick();
    }
    expect(alice.getUserMedia.calls.length - requests).toBeLessThanOrEqual(3);
  });

  test("a microphone that went away is replaced even when its owner picks that same device again", async () => {
    const { alice } = await connectedCall();
    await alice.manager.setMicrophone("usb-mic");
    const dead = alice.manager.getState().localStream.getAudioTracks()[0];
    dead.readyState = "ended"; // gone, and no 'ended' event was seen
    expect(await alice.manager.setMicrophone("usb-mic")).toBe(true);
    const now = alice.manager.getState().localStream.getAudioTracks()[0];
    expect(now).not.toBe(dead);
    expect(now.readyState).toBe("live");
  });

  test("muting while the microphone is being swapped leaves the new one muted", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { alice, pcA } = await connectedCall();
    const sender = pcA.senders.find((x) => x.track?.kind === "audio");
    const replace = sender.replaceTrack;
    sender.replaceTrack = vi.fn(async (track) => { await gate; return replace(track); });
    const swapping = alice.manager.setMicrophone("usb-mic");
    await tick();
    alice.manager.setMuted(true); // while the swap is waiting
    release();
    await swapping;
    expect(alice.manager.getState().localStream.getAudioTracks()[0].enabled).toBe(false);
    expect(alice.manager.getState().muted).toBe(true);
  });

  test("a recovery that was waiting is skipped when a microphone the person chose has taken over meanwhile", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const getUserMedia = vi.fn(async (constraints) => {
      if (constraints.audio?.deviceId?.exact === "chosen") await gate;
      return new FakeStream([new FakeTrack("audio", constraints.audio?.deviceId?.exact || "default")]);
    });
    const { alice } = await connectedCall({ aliceOpts: { getUserMedia } });
    const first = alice.manager.getState().localStream.getAudioTracks()[0];
    const choosing = alice.manager.setMicrophone("chosen"); // slow
    await tick();
    first.readyState = "ended";
    first.onended?.(); // the old one drops out while the choice is still being made
    release();
    await choosing;
    await tick();
    await tick();
    const tracks = alice.manager.getState().localStream.getAudioTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].getSettings().deviceId).toBe("chosen");
    expect(getUserMedia.mock.calls.filter(([c]) => !c.audio?.deviceId).length).toBe(1); // only the call's own first one
  });

  test("when no microphone can be found again the person is told, and a later choice works", async () => {
    const getUserMedia = vi.fn(async (constraints) => {
      if (getUserMedia.broken) throw Object.assign(new Error("gone"), { name: "NotFoundError" });
      return new FakeStream([new FakeTrack("audio", constraints.audio?.deviceId?.exact || "default")]);
    });
    const { alice } = await connectedCall({ aliceOpts: { getUserMedia } });
    const first = alice.manager.getState().localStream.getAudioTracks()[0];
    getUserMedia.broken = true;
    first.readyState = "ended";
    first.onended?.();
    await waitFor(() => alice.manager.getState().audioDeviceError === "no_device", { label: "told" });
    getUserMedia.broken = false;
    expect(await alice.manager.setMicrophone("usb-mic")).toBe(true);
    expect(alice.manager.getState().audioDeviceError).toBeNull();
    // ... and the next drop-out is looked after again.
    const second = alice.manager.getState().localStream.getAudioTracks()[0];
    second.readyState = "ended";
    second.onended?.();
    await waitFor(() => alice.manager.getState().localStream.getAudioTracks()[0] !== second, { label: "recovered" });
  });

  test("the note about a microphone that could not be used goes away by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const getUserMedia = vi.fn(async (constraints) => {
      if (constraints.audio?.deviceId) throw Object.assign(new Error("x"), { name: "NotFoundError" });
      return new FakeStream([new FakeTrack("audio")]);
    });
    const { alice } = await connectedCall({ aliceOpts: { getUserMedia } });
    await alice.manager.setMicrophone("gone");
    expect(alice.manager.getState().audioDeviceError).toBe("no_device");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(alice.manager.getState().audioDeviceError).toBeNull();
  });

  test("two quick choices end on the last one, with one microphone open", async () => {
    const { alice } = await connectedCall();
    await Promise.all([alice.manager.setMicrophone("first"), alice.manager.setMicrophone("second")]);
    const tracks = alice.manager.getState().localStream.getAudioTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0].getSettings().deviceId).toBe("second");
    expect(alice.manager.getState().microphoneId).toBe("second");
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

describe("call length for the chat's call entry", () => {
  test("hanging up a connected call tells the server how long it ran", async () => {
    const { alice } = await connectedCall();
    const callId = alice.manager.getState().callId;
    await alice.manager.hangup();
    expect(alice.api.endCall).toHaveBeenCalledTimes(1);
    const [id, reason, durationMs] = alice.api.endCall.mock.calls[0];
    expect(id).toBe(callId);
    expect(reason).toBeUndefined();
    expect(durationMs).toBeTypeOf("number");
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(durationMs)).toBe(true);
  });

  test("the length counts from the moment the media connected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const { alice } = await connectedCall();
    vi.setSystemTime(new Date(Date.now() + 125_000));
    await alice.manager.hangup();
    const durationMs = alice.api.endCall.mock.calls[0][2];
    expect(durationMs).toBeGreaterThanOrEqual(125_000);
    expect(durationMs).toBeLessThan(130_000);
  });

  test("a call that never connected sends no length", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await alice.manager.hangup();
    expect(alice.api.endCall).toHaveBeenCalledTimes(1);
    expect(alice.api.endCall.mock.calls[0]).toHaveLength(2);
    await bob.manager.decline();
  });

  test("the callee who declines sends no length either", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" } });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.decline();
    expect(bob.api.endCall).toHaveBeenCalledWith(alice.manager.getState().callId, "declined");
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
    // The beacon also carries how long the connected call ran (for the chat's call entry).
    expect(beacon).toHaveBeenCalledWith(callId, expect.any(Number));
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
    // The caller only learns that the other side gave up: a security rejection
    // must not be passed off as a network or relay problem.
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice), { label: "caller told" });
    expect(alice.manager.getState().endReason).toBe("failed");
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

  // The callee's reports travel on the event stream, the caller's own request on
  // another connection: either can be seen first.
  async function slowPost() {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const post = alice.api.startCall.getMockImplementation();
    alice.api.startCall.mockImplementation(async (args) => {
      await post(args);
      await gate; // the server has the call and has told the callee; the reply is still on its way
    });
    return { alice, bob, release };
  }

  test("a ringing report that beats the reply to the call request is not lost", async () => {
    const { alice, bob, release } = await slowPost();
    const started = alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "bob ringing" });
    await waitFor(() => alice.manager.getState().ringing, { label: "ringing seen early" });
    release();
    await started;
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.OUTGOING, ringing: true, waiting: false });
  });

  test("an answer that beats the reply to the call request is not followed by a ring timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { alice, bob, release } = await slowPost();
    const started = alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await vi.waitFor(() => expect(phase(CALL_PHASE.INCOMING)(bob)).toBe(true));
    await bob.manager.accept();
    await vi.waitFor(() => expect(alice.manager.getState().phase).not.toBe(CALL_PHASE.OUTGOING));
    release();
    await started;
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTED, waiting: false, ringing: false });
    // A leaked ring timer would hang up a call that is already connected (and
    // the call would then quietly fall back to idle, hiding the reason).
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
    expect(alice.manager.getState().endReason).toBeNull();
  });

  test("an answer still being verified when the reply arrives is not followed by a ring timeout either", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { alice, bob, release } = await slowPost();
    let releaseVerify;
    const verifyGate = new Promise((resolve) => {
      releaseVerify = resolve;
    });
    const find = alice.directory.findDevice;
    alice.directory.findDevice = async (...args) => {
      await verifyGate;
      return find(...args);
    };
    const started = alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await vi.waitFor(() => expect(phase(CALL_PHASE.INCOMING)(bob)).toBe(true));
    await bob.manager.accept();
    await vi.waitFor(() => expect(alice.api.startCall).toHaveBeenCalled());
    await vi.waitFor(() => expect(bob.api.acceptCall).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(50); // the answer reaches alice and starts being verified
    release();
    await started;
    releaseVerify();
    await vi.waitFor(() => expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("a ringing report that could not be sent is tried again while the phone is still ringing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    bob.api.markCallRinging
      .mockRejectedValueOnce(new ApiError("offline", { status: 0 }))
      .mockRejectedValueOnce(new ApiError("overloaded", { status: 503 }));
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await vi.waitFor(() => expect(phase(CALL_PHASE.INCOMING)(bob)).toBe(true));
    await vi.waitFor(() => expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1));
    expect(alice.manager.getState()).toMatchObject({ waiting: true, ringing: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(bob.api.markCallRinging).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(alice.manager.getState().ringing).toBe(true));
    expect(alice.manager.getState().waiting).toBe(false);
  });

  test("the ringing report is not retried once the call is answered, or when the server refuses it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    bob.api.markCallRinging.mockRejectedValue(new ApiError("down", { status: 503 }));
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await vi.waitFor(() => expect(phase(CALL_PHASE.INCOMING)(bob)).toBe(true));
    await vi.waitFor(() => expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1));
    await bob.manager.accept();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1);

    // A refusal (the call is gone, say) will not change by asking again.
    const server2 = new FakeServer();
    const carol = await server2.addUser("carol");
    const dave = await server2.addUser("dave");
    dave.api.markCallRinging.mockRejectedValue(new ApiError("Not your call.", { status: 403 }));
    await carol.manager.startCall({ chatId: "c", peer: peerOf(dave) });
    await vi.waitFor(() => expect(phase(CALL_PHASE.INCOMING)(dave)).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dave.api.markCallRinging).toHaveBeenCalledTimes(1);
  });

  test("answering clears a stale waiting flag", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    bob.api.markCallRinging.mockResolvedValue(); // the report never reaches the caller
    server.managers.set(bob.user.id, [bob.manager]);
    bob.api.markCallRinging.mockImplementation(async () => {});
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await waitFor(() => alice.manager.getState().waiting, { label: "waiting" });
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice) || phase(CALL_PHASE.CONNECTED)(alice));
    expect(alice.manager.getState()).toMatchObject({ waiting: false, ringing: false });
  });

  test("a phone whose screen is off or whose app is in the background is not 'ringing' for the caller", async () => {
    let visible = false;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob", { isPageVisible: () => visible });
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "bob has the invite" });
    await new Promise((r) => setTimeout(r, 100));
    expect(bob.api.markCallRinging).not.toHaveBeenCalled();
    expect(alice.manager.getState()).toMatchObject({ waiting: true, ringing: false });

    // The person picks the phone up: now the call really is on their screen.
    visible = true;
    bob.manager.setPageHidden(false);
    await waitFor(() => alice.manager.getState().ringing, { label: "ringing once it is on screen" });
    expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1);
    bob.manager.setPageHidden(false); // looking again does not report twice
    await new Promise((r) => setTimeout(r, 50));
    expect(bob.api.markCallRinging).toHaveBeenCalledTimes(1);
  });

  test("a ringing report that arrives after the call moved on changes nothing", async () => {
    const { alice } = await connectedCall();
    const callId = alice.manager.getState().callId;
    await alice.manager.handleEvent({ type: "call_ringing", callId });
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTED, ringing: false });
  });
});

describe("connections that do not come up", () => {
  const stuckCall = async (hasRelay, { relayReachable = hasRelay, iceServers = [] } = {}) => {
    FakePeerConnection.autoConnect = false;
    FakePeerConnection.relayCandidates = relayReachable;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const who of [alice, bob]) {
      who.api.fetchIceConfig.mockResolvedValue({ iceServers, hasRelay });
    }
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice) && phase(CALL_PHASE.CONNECTING)(bob), { label: "connecting" });
    // Offer and answer are through (a later clock jump must not race signals still in flight).
    await waitFor(() => server.log.some((e) => e.op === "signal" && e.kind === "answer"), { label: "answered" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { alice, bob };
  };

  test("a slow connection says it is still trying, but not before 10 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice } = await stuckCall(true);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(alice.manager.getState().connectingSlow).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTING, connectingSlow: true });
  });

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
    // Reported to the server as a media failure, so the other side can explain it the same way.
    const reports = [...alice.api.endCall.mock.calls, ...bob.api.endCall.mock.calls];
    expect(reports.some(([, reason]) => reason === "connect_failed")).toBe(true);
  });

  test("a relay that answers is noted while connecting", async () => {
    const { alice } = await stuckCall(true);
    expect(alice.manager.getState().relayCheck).toBe("ok");
  });

  test("a relay that cannot be reached is noticed as soon as gathering ends, and named when the call fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    FakePeerConnection.iceErrors = [
      { url: "turn:relay.example:3478", errorCode: 701, errorText: "Cannot connect" },
      { url: "turn:relay.example:3478?transport=tcp", errorCode: 701, errorText: "Cannot connect" },
    ];
    const { alice, bob } = await stuckCall(true, { relayReachable: false });
    // Long before the 45 s give-up: the person is told what is wrong.
    expect(alice.manager.getState()).toMatchObject({ phase: CALL_PHASE.CONNECTING, relayCheck: "unreachable" });

    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed_relay_unreachable");
    expect(bob.manager.getState().endReason).toBe("connect_failed_relay_unreachable");
    const reports = [...alice.api.endCall.mock.calls, ...bob.api.endCall.mock.calls];
    expect(reports.some(([, reason]) => reason === "connect_failed")).toBe(true);

    // What was tried is kept for the card's technical details.
    const details = alice.manager.getState().connectionDetails.join("\n");
    expect(details).toContain("Relay candidates: 0");
    expect(details).toContain("turn:relay.example:3478?transport=tcp");
    expect(details).toContain("701");
  });

  test("the report says who called, what was found here, what the other device sent and how the pairs fared", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    FakePeerConnection.iceErrors = [{ url: "turn:relay.example:3478", errorCode: 701, errorText: "Cannot connect" }];
    // Only the callee's device gets a relay address (its connection is the first one created,
    // because the callee builds its connection when it answers), so the two sides differ.
    FakePeerConnection.relayOn = (pc) => FakePeerConnection.instances.indexOf(pc) === 0;
    const iceServers = [
      {
        urls: ["stun:relay.example:3478", "turn:relay.example:3478?transport=udp", "turn:relay.example:3478?transport=tcp"],
        username: "1700000000",
        credential: "never-shown",
      },
    ];
    const { alice, bob } = await stuckCall(true, { relayReachable: false, iceServers });
    const pair = (id, state, sent, answered, local = "l1", remote = "r1") => ({
      id, type: "candidate-pair", state, localCandidateId: local, remoteCandidateId: remote, requestsSent: sent, responsesReceived: answered,
    });
    FakePeerConnection.instances.forEach((pc) => {
      pc.statsReport = [
        { id: "l1", type: "local-candidate", candidateType: "host", protocol: "udp", address: "192.168.1.5" },
        { id: "l2", type: "local-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "tcp" },
        { id: "r1", type: "remote-candidate", candidateType: "relay", protocol: "udp", address: "203.0.113.9" },
        // Listed worst first: the report puts the pair that got answers on top.
        pair("p1", "waiting", 0, 0, "l2"),
        pair("p2", "failed", 7, 0),
        pair("p3", "succeeded", 5, 4),
      ];
    });
    await vi.advanceTimersByTimeAsync(46_000);

    const aliceLines = alice.manager.getState().connectionDetails;
    const bobLines = bob.manager.getState().connectionDetails;
    const aliceDetails = aliceLines.join("\n");
    expect(aliceLines).toContain("Role: caller");
    expect(bobLines).toContain("Role: callee");
    expect(aliceLines).toContain("Servers: stun:relay.example:3478, turn:relay.example:3478 (udp, tcp)");
    // Each side reports its own candidates and what the other one sent, not the other way round.
    expect(aliceLines).toContain("Candidates found here: host 2");
    expect(aliceLines).toContain("Candidates from the other device: host 2, relay 1");
    expect(bobLines).toContain("Candidates found here: host 2, relay 1");
    expect(bobLines).toContain("Candidates from the other device: host 2");
    const pairs = aliceLines.slice(aliceLines.indexOf("Pairs tried:") + 1, aliceLines.indexOf("Pairs tried:") + 4);
    expect(pairs).toEqual([
      "  host udp -> relay udp: succeeded, sent 5, answered 4",
      "  host udp -> relay udp: failed, sent 7, answered 0",
      "  relay via tcp -> relay udp: waiting, sent 0, answered 0",
    ]);
    // Nothing that identifies a network or grants access is in the report.
    for (const secret of ["never-shown", "1700000000", "192.168.1.5", "203.0.113.9"]) {
      expect(aliceDetails).not.toContain(secret);
    }
  });

  test("a long list of pairs is cut after six", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice } = await stuckCall(true, { relayReachable: false });
    FakePeerConnection.instances.forEach((pc) => {
      pc.statsReport = [
        { id: "l1", type: "local-candidate", candidateType: "host", protocol: "udp" },
        { id: "r1", type: "remote-candidate", candidateType: "host", protocol: "udp" },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `p${i}`, type: "candidate-pair", state: "failed", localCandidateId: "l1", remoteCandidateId: "r1", requestsSent: 8 - i, responsesReceived: 0,
        })),
      ];
    });
    await vi.advanceTimersByTimeAsync(46_000);
    const lines = alice.manager.getState().connectionDetails;
    const start = lines.indexOf("Pairs tried:");
    expect(lines.slice(start + 1, start + 8)).toEqual([
      ...[8, 7, 6, 5, 4, 3].map((n) => `  host udp -> host udp: failed, sent ${n}, answered 0`),
      "  (+2 more)",
    ]);
  });

  test("the set-up snapshot of the address pairs is not reported for a call that connected and was lost later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, bob } = await stuckCall(true, { relayReachable: false });
    const setUpPairs = [
      { id: "l1", type: "local-candidate", candidateType: "host", protocol: "udp" },
      { id: "r1", type: "remote-candidate", candidateType: "host", protocol: "udp" },
      { id: "p1", type: "candidate-pair", state: "in-progress", localCandidateId: "l1", remoteCandidateId: "r1", requestsSent: 3, responsesReceived: 0 },
    ];
    FakePeerConnection.instances.forEach((pc) => { pc.statsReport = setUpPairs; });
    await vi.advanceTimersByTimeAsync(11_000); // the first look, while still connecting
    FakePeerConnection.instances.forEach((pc) => pc.setState("connected"));
    await vi.advanceTimersByTimeAsync(100);
    expect(alice.manager.getState().phase).toBe(CALL_PHASE.CONNECTED);

    // Minutes later the network goes away and the call is given up.
    FakePeerConnection.instances.forEach((pc) => { pc.statsReport = []; });
    FakePeerConnection.instances.forEach((pc) => pc.setState("failed"));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(alice.manager.getState().endReason).toBe("connection_lost");
    const details = alice.manager.getState().connectionDetails.join("\n");
    expect(details).not.toContain("Pairs tried");
    expect(details).not.toContain("in-progress");
    expect(bob.manager.getState().endReason).toBeTruthy();
  });

  test("a relay host behind Cloudflare's proxy is named at once, and again when the call fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    FakePeerConnection.gatheringCompletes = false; // no need to wait for ICE to give up
    FakePeerConnection.autoConnect = false;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const who of [alice, bob]) {
      who.api.fetchIceConfig.mockResolvedValue({ iceServers: [], hasRelay: true, relayProxied: true });
    }
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice) && phase(CALL_PHASE.CONNECTING)(bob), { label: "connecting" });
    expect(alice.manager.getState().relayCheck).toBe("proxied"); // known before ICE has tried anything

    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed_relay_proxied");
    expect(bob.manager.getState().endReason).toBe("connect_failed_relay_proxied");
  });

  test("a proxied name that nevertheless yields a relay address (a paid Cloudflare setup) is not blamed", async () => {
    FakePeerConnection.autoConnect = false;
    FakePeerConnection.relayCandidates = true;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const who of [alice, bob]) {
      who.api.fetchIceConfig.mockResolvedValue({ iceServers: [], hasRelay: true, relayProxied: true });
    }
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTING)(alice));
    await waitFor(() => alice.manager.getState().relayCheck === "ok", { label: "relay found" });
  });

  test("a relay that answers but refuses this device is told apart from one that cannot be reached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    FakePeerConnection.iceErrors = [{ url: "turn:relay.example:3478", errorCode: 401, errorText: "Unauthorized." }];
    const { alice, bob } = await stuckCall(true, { relayReachable: false });
    expect(alice.manager.getState().relayCheck).toBe("refused");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed_relay_refused");
    expect(bob.manager.getState().endReason).toBe("connect_failed_relay_refused");
    expect(alice.manager.getState().connectionDetails.join("\n")).toContain("error 401 Unauthorized.");
  });

  test("nothing is claimed about the relay while gathering has not finished", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    FakePeerConnection.gatheringCompletes = false;
    const { alice } = await stuckCall(true, { relayReachable: false });
    expect(alice.manager.getState().relayCheck).toBe("pending");
    await vi.advanceTimersByTimeAsync(46_000);
    expect(alice.manager.getState().endReason).toBe("connect_failed");
  });

  test("a server without a relay is not asked about one", async () => {
    const { alice } = await stuckCall(false);
    expect(alice.manager.getState().relayCheck).toBeNull();
  });

  test("a refused signaling request is a plain failure, not blamed on the relay", async () => {
    FakePeerConnection.autoConnect = false;
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    for (const who of [alice, bob]) who.api.fetchIceConfig.mockResolvedValue({ iceServers: [], hasRelay: false });
    // The server forgot the call (a restart, say): bob's answer is refused.
    bob.api.sendCallSignal.mockRejectedValue(new ApiError("Call is not in progress.", { status: 409 }));
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob) });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob), { label: "answer refused" });
    expect(bob.manager.getState().endReason).toBe("failed");
  });

  test("a server timeout on a call that was up is not reported as a lost connection", async () => {
    const { alice } = await connectedCall();
    await alice.manager.handleEvent({ type: "call_end", callId: alice.manager.getState().callId, reason: "timeout" });
    expect(alice.manager.getState().endReason).toBe("failed");
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
    const told = bob.pc.dc.sent.map((raw) => JSON.parse(raw));
    expect(told).toContainEqual(expect.objectContaining({ t: "state", video: false }));
    expect(alice.manager.getState().remoteCameraOn).toBe(false);
  });

  test("the camera can be turned on later, and the other person is told", async () => {
    const { alice, bob } = await videoCall({ bobCamera: false });
    await bob.manager.setCameraEnabled(true);
    await waitFor(() => bob.manager.getState().cameraOn, { label: "camera on" });
    const sender = bob.pc.transceivers.find((t) => t.receiver.track.kind === "video").sender;
    expect(sender.replaceTrack).toHaveBeenCalledWith(expect.objectContaining({ kind: "video" }));
    await waitFor(() => alice.manager.getState().remoteCameraOn === true, { label: "alice sees camera on" });
  });

  test("a camera turned on before the caller's offer arrives is sent as soon as the call is set up", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    // Hold back everything the caller signals to bob: the offer is still on its way.
    let hold = true;
    const held = [];
    const deliver = bob.manager.handleEvent.bind(bob.manager);
    bob.manager.handleEvent = (event) => {
      if (hold && event.type === "call_signal") {
        held.push(event);
        return Promise.resolve();
      }
      return deliver(event);
    };
    await alice.manager.startCall({ chatId: "c", peer: peerOf(bob), kind: "video" });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept({ camera: false });
    await bob.manager.setCameraEnabled(true); // "Connecting…": the camera button is already there
    expect(bob.manager.getState().cameraOn).toBe(true);
    await waitFor(() => held.length > 0, { label: "offer on its way" });

    hold = false;
    for (const event of held) await deliver(event);
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), { label: "connected" });

    const sender = bob.pc.transceivers.find((t) => t.receiver.track.kind === "video").sender;
    expect(sender.track).toMatchObject({ kind: "video" }); // what the camera shows is what is sent
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
