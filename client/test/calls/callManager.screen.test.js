import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { CALL_PHASE } from "../../src/calls/callManager.js";
import { SCREEN_ERROR_SHOWN_MS, locateVideoLines } from "../../src/calls/screenShare.js";
import { SCREEN_PROFILES } from "../../src/calls/mediaTuning.js";
import { fromB64u } from "../../src/e2ee/encoding.js";
import {
  FakePeerConnection,
  FakeServer,
  linkDataChannels,
  makeGetDisplayMedia,
  waitFor,
} from "./fakes.js";

// The deriving of the call keys and the emoji code is watched, not replaced:
// the test below reads what it was given.
const crypto = vi.hoisted(() => ({ derived: [] }));
vi.mock("../../src/calls/callCrypto.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    deriveCallSession: vi.fn(async (args) => {
      crypto.derived.push(args);
      return actual.deriveCallSession(args);
    }),
  };
});

const phase = (p) => (c) => c.manager.getState().phase === p;
const state = (c) => c.manager.getState();

/** Two people in a connected call whose in-band channel is open and who have told each other what they can do. */
async function connectedCall({ kind = "audio", aliceOpts, bobOpts } = {}) {
  const server = new FakeServer();
  const alice = await server.addUser("alice", aliceOpts);
  const bob = await server.addUser("bob", bobOpts);
  await alice.manager.startCall({ chatId: "chat-1", peer: { userId: bob.user.id, username: "bob" }, kind });
  await waitFor(() => phase(CALL_PHASE.INCOMING)(bob), { label: "bob ringing" });
  await bob.manager.accept();
  await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob), { label: "both connected" });
  linkDataChannels(alice.pc, bob.pc);
  return { server, alice, bob, pcA: alice.pc, pcB: bob.pc };
}

/** The screen line of a connection is the last video line: the camera's comes first. */
const screenLine = (pc) => pc.transceivers.filter((t) => t.kind === "video").at(-1);
const cameraLine = (pc) => pc.transceivers.filter((t) => t.kind === "video")[0];

const sentOn = (pc) => pc.dc.sent.map((raw) => JSON.parse(raw));
const screenMessages = (pc) => sentOn(pc).filter((m) => m.t === "screen");
const toggle = (c) => c.manager.toggleScreenShare();

beforeEach(() => {
  FakePeerConnection.instances = [];
  FakePeerConnection.autoConnect = true;
  FakePeerConnection.relayCandidates = false;
  FakePeerConnection.relayOn = null;
  FakePeerConnection.iceErrors = [];
  FakePeerConnection.gatheringCompletes = true;
  FakePeerConnection.rejectExtraVideo = false;
  crypto.derived.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  FakePeerConnection.rejectExtraVideo = false;
});

describe("the screen line is part of the first offer of every call", () => {
  test("a voice call is offered one video line for the screen, two-way, with nothing on it", async () => {
    const { pcA, pcB } = await connectedCall({ kind: "audio" });
    const offer = locateVideoLines(pcA.localDescription.sdp, "audio");
    expect(offer.camera).toBeNull();
    expect(offer.screen).toMatchObject({ kind: "video", direction: "sendrecv", rejected: false });
    for (const pc of [pcA, pcB]) {
      const line = screenLine(pc);
      expect(line.sender.track).toBeNull(); // no picture: no media flows while nobody shares
      expect(line.direction).toBe("sendrecv");
      expect(line.currentDirection).toBe("sendrecv");
    }
    expect(screenLine(pcB).mid).toBe(screenLine(pcA).mid);
  });

  test("a video call has the camera's line first and the screen's right after it, on both sides", async () => {
    const { pcA, pcB, alice, bob } = await connectedCall({ kind: "video" });
    const videoLines = (pc) => pc.transceivers.filter((t) => t.kind === "video");
    expect(videoLines(pcA)).toHaveLength(2);
    expect(videoLines(pcB)).toHaveLength(2);
    // The answer lists the lines in the order of the offer.
    const order = (sdp) => locateVideoLines(sdp, "video");
    expect(order(pcB.localDescription.sdp).camera.mid).toBe(order(pcA.localDescription.sdp).camera.mid);
    expect(order(pcB.localDescription.sdp).screen.mid).toBe(order(pcA.localDescription.sdp).screen.mid);
    expect(cameraLine(pcA).mid).toBe(order(pcA.localDescription.sdp).camera.mid);
    expect(screenLine(pcA).mid).toBe(order(pcA.localDescription.sdp).screen.mid);
    expect(cameraLine(pcB).mid).toBe(order(pcA.localDescription.sdp).camera.mid);
    expect(screenLine(pcB).mid).toBe(order(pcA.localDescription.sdp).screen.mid);
    // The camera keeps its sender: the screen never takes its place.
    expect(cameraLine(pcA).sender.track?.kind).toBe("video");
    expect(screenLine(pcA).sender.track).toBeNull();
    expect(state(alice).cameraOn).toBe(true);
    expect(state(bob).cameraOn).toBe(true);
  });

  test("a video call that starts with the camera off has the same two lines in the same order", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" }, kind: "video", camera: false });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept({ camera: false });
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob));
    for (const pc of [alice.pc, bob.pc]) {
      const lines = pc.transceivers.filter((t) => t.kind === "video");
      expect(lines.map((t) => t.mid)).toEqual([lines[0].mid, lines[1].mid]);
      expect(lines[0].mid).not.toBe(lines[1].mid);
    }
    const offer = locateVideoLines(alice.pc.localDescription.sdp, "video");
    expect(cameraLine(bob.pc).mid).toBe(offer.camera.mid);
    expect(screenLine(bob.pc).mid).toBe(offer.screen.mid);
    expect(screenLine(bob.pc).direction).toBe("sendrecv");
    expect(cameraLine(bob.pc).direction).toBe("sendrecv");
  });

  test("the lines are told apart by position, never by what a track is called", async () => {
    const { pcA } = await connectedCall({ kind: "video" });
    const sdp = pcA.localDescription.sdp;
    // Renaming nothing in the SDP can move the camera onto the screen's line.
    expect(locateVideoLines(sdp, "video").camera.mid).not.toBe(locateVideoLines(sdp, "video").screen.mid);
    expect(locateVideoLines(sdp.replaceAll("a=mid:", "a=mid:x"), "video").screen.mid).toMatch(/^x/);
  });

  test("the screen line is bundled with the audio on the one transport that the handshake authenticated", async () => {
    const { pcA, pcB } = await connectedCall({ kind: "video" });
    for (const pc of [pcA, pcB]) {
      const sdp = pc.localDescription.sdp;
      const mids = [...sdp.matchAll(/^a=mid:(\S+)/gm)].map((m) => m[1]);
      expect(mids).toHaveLength(3);
      const group = /^a=group:BUNDLE (.+)$/m.exec(sdp)[1].split(" ");
      expect(group.sort()).toEqual([...mids].sort());
      // One fingerprint for the whole session: the extra line adds none.
      expect(sdp.match(/^a=fingerprint:/gm)).toHaveLength(1);
    }
    expect(pcA.localDescription.sdp.match(/^a=fingerprint:.*$/m)[0]).toBe(pcA.localDescription.sdp.match(/^a=fingerprint:.*$/m)[0]);
    // What the callee applied is exactly what the caller sent, extra line included.
    expect(pcB.remoteDescription.sdp).toBe(pcA.localDescription.sdp);
    expect(pcA.remoteDescription.sdp).toBe(pcB.localDescription.sdp);
  });

  test("the emoji code and the keys are derived from the same transcript as before: nothing of the media description goes in", async () => {
    const { alice, bob } = await connectedCall({ kind: "video" });
    expect(state(alice).sas).toHaveLength(4);
    expect(state(alice).sas).toEqual(state(bob).sas);
    expect(crypto.derived).toHaveLength(2);
    const fields = [
      "calleeDeviceId",
      "calleeUserId",
      "callId",
      "callerDeviceId",
      "callerUserId",
      "commit",
      "ephCallee",
      "ephCaller",
      "ephemeralPrivateKey",
      "kind",
      "peerEph",
      "role",
    ].sort();
    for (const args of crypto.derived) {
      expect(Object.keys(args).sort()).toEqual(fields);
      // Text only from the handshake: no description of the media, no fingerprint.
      for (const value of Object.values(args)) {
        if (typeof value === "string") expect(value).not.toMatch(/m=video|a=fingerprint|a=mid/);
      }
    }
    // Both sides derived it from the same ephemeral keys and transcript fields.
    const [first, second] = crypto.derived;
    for (const key of ["callId", "callerUserId", "callerDeviceId", "calleeUserId", "calleeDeviceId", "kind", "commit", "ephCaller", "ephCallee"]) {
      expect(first[key]).toBe(second[key]);
    }
  });

  test("the signaling server still never sees the media description of the extra line", async () => {
    const { server } = await connectedCall({ kind: "video" });
    for (const s of server.log.filter((e) => e.op === "signal")) {
      const text = Buffer.from(fromB64u(s.blob)).toString("latin1");
      expect(text).not.toContain("m=video");
      expect(text).not.toContain("SECRET-FINGERPRINT");
    }
  });

  test("a tampered offer that carries the screen line is still refused", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    server.tamper = (event) => {
      if (event.type !== "call_signal" || event.kind !== "offer") return event;
      const bytes = fromB64u(event.blob);
      bytes[bytes.length - 3] ^= 0xff;
      return { ...event, blob: Buffer.from(bytes).toString("base64url") };
    };
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" }, kind: "video" });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bob.pc.remoteDescription).toBeNull();
    expect(phase(CALL_PHASE.CONNECTED)(bob)).toBe(false);
  });
});

describe("an app that does not know about screen sharing", () => {
  test("a voice call with it connects, and sharing is not offered", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio", bobOpts: { screenSharing: false } });
    expect(phase(CALL_PHASE.CONNECTED)(alice)).toBe(true);
    expect(state(alice).screenAvailable).toBe(false);
    expect(state(bob).screenAvailable).toBe(false);
    // The extra line it answered is one-way: it only receives (from this side's view: send-only).
    expect(screenLine(alice.pc).currentDirection).toBe("sendonly");
    await toggle(alice);
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
    expect(state(alice)).toMatchObject({ screenSharing: false, screenError: "unavailable" });
  });

  test("a video call with it connects with its camera, and sharing is not offered", async () => {
    const { alice, bob } = await connectedCall({ kind: "video", bobOpts: { screenSharing: false } });
    expect(state(alice).cameraOn).toBe(true);
    expect(state(bob).cameraOn).toBe(true);
    expect(state(alice).screenAvailable).toBe(false);
    await toggle(alice);
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
    expect(screenLine(alice.pc).sender.track).toBeNull();
  });

  test("an app that rejects the extra video line still connects, and the call carries on without it", async () => {
    FakePeerConnection.rejectExtraVideo = true;
    const { alice, bob, pcA } = await connectedCall({ kind: "video", bobOpts: { screenSharing: false } });
    expect(phase(CALL_PHASE.CONNECTED)(alice)).toBe(true);
    expect(phase(CALL_PHASE.CONNECTED)(bob)).toBe(true);
    expect(screenLine(pcA).stopped).toBe(true); // the answer declined it
    expect(state(alice).cameraOn).toBe(true);
    expect(state(alice).screenAvailable).toBe(false);
    await toggle(alice);
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
  });

  test("an older caller's offer has no screen line: the callee offers no sharing and ignores announcements", async () => {
    const { alice, bob } = await connectedCall({ kind: "video", aliceOpts: { screenSharing: false } });
    expect(state(bob).screenAvailable).toBe(false);
    expect(locateVideoLines(alice.pc.localDescription.sdp, "video").screen).toBeNull();
    // Nothing can carry a shared screen in this call, whatever the other side says.
    alice.pc.dc.send(JSON.stringify({ t: "screen", on: true, w: 1280, h: 720 }));
    await waitFor(() => bob.pc.dc.onmessage); // delivered
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state(bob)).toMatchObject({ remoteScreenOn: false, remoteScreenStream: null });
    await toggle(bob);
    expect(bob.getDisplayMedia).not.toHaveBeenCalled();
  });

  test("a voice call with an older caller has no video line at all", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio", aliceOpts: { screenSharing: false } });
    expect(alice.pc.transceivers.some((t) => t.kind === "video")).toBe(false);
    expect(bob.pc.transceivers.some((t) => t.kind === "video")).toBe(false);
    expect(state(bob).screenAvailable).toBe(false);
  });

  test("a phone that cannot capture its screen still shows the other person's", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio", bobOpts: { getDisplayMedia: null } });
    expect(bob.manager.canShareScreen).toBe(false);
    expect(alice.manager.canShareScreen).toBe(true);
    // The phone says it can show a screen, so the computer can share.
    expect(state(alice).screenAvailable).toBe(true);
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn, { label: "phone sees the screen" });
    // And the phone's own attempt is a hint, not a crash.
    await toggle(bob);
    expect(state(bob)).toMatchObject({ screenSharing: false, screenError: "unsupported" });
  });
});

describe("sharing the screen", () => {
  test("both sides learn they can share once the channel is open", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    expect(state(alice).screenAvailable).toBe(true);
    expect(state(bob).screenAvailable).toBe(true);
    expect(alice.manager.canShareScreen).toBe(true);
  });

  test("starting a share swaps the capture into the screen line and announces it, with no new negotiation", async () => {
    const { alice, bob, pcA, pcB } = await connectedCall({ kind: "audio" });
    const offersBefore = pcA.offerOptions.length;
    await toggle(alice);
    const line = screenLine(pcA);
    const track = alice.getDisplayMedia.streams[0].getVideoTracks()[0];
    expect(line.sender.replaceTrack).toHaveBeenCalledWith(track);
    expect(line.sender.track).toBe(track);
    expect(track.contentHint).toBe("detail"); // text stays sharp
    expect(state(alice)).toMatchObject({ screenSharing: true, screenBusy: false, screenSurface: "monitor", screenError: null });
    expect(state(alice).screenStream).toBe(alice.getDisplayMedia.streams[0]);
    expect(screenMessages(pcA)).toEqual([{ t: "screen", on: true, w: 1920, h: 1080 }]);
    expect(pcA.offerOptions.length).toBe(offersBefore);
    expect(pcA.localDescription.type).toBe("offer"); // nothing was renegotiated
    expect(pcB.localDescription.type).toBe("answer");
    await waitFor(() => state(bob).remoteScreenOn, { label: "bob sees the announcement" });
    expect(state(bob).remoteScreenSize).toEqual({ w: 1920, h: 1080 });
    expect(state(bob).remoteScreenStream.getVideoTracks()).toEqual([screenLine(pcB).receiver.track]);
  });

  test("the screen's picture never joins the camera's stream", async () => {
    const { alice, bob } = await connectedCall({ kind: "video" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    const cameraTracks = state(bob).remoteStream.getTracks();
    expect(cameraTracks).not.toContain(screenLine(bob.pc).receiver.track);
    expect(cameraTracks).toContain(cameraLine(bob.pc).receiver.track);
    expect(state(bob).remoteScreenStream.getTracks()).toEqual([screenLine(bob.pc).receiver.track]);
  });

  test("the capture is asked for without sound, at a low frame rate, and the sound that arrives anyway is dropped", async () => {
    const getDisplayMedia = makeGetDisplayMedia({ withAudio: true });
    const { alice } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    await toggle(alice);
    const request = getDisplayMedia.calls[0];
    expect(request.audio).toBe(false);
    expect(request.video.frameRate).toMatchObject({ ideal: 15, max: 15 });
    const stream = getDisplayMedia.streams[0];
    expect(stream.getAudioTracks()).toHaveLength(0);
    expect(screenLine(alice.pc).sender.track.kind).toBe("video");
    expect(alice.pc.senders.filter((s) => s.track?.kind === "audio")).toHaveLength(1); // only the microphone
  });

  test("the encoder keeps the detail: 15 fps, about 2.5 Mbps, resolution over frame rate", async () => {
    const { alice } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    const params = screenLine(alice.pc).sender.params;
    expect(params.encodings[0]).toMatchObject({ maxFramerate: 15, maxBitrate: 2_500_000, scaleResolutionDownBy: 1 });
    expect(params.degradationPreference).toBe("maintain-resolution");
  });

  test("a screen bigger than Full HD is scaled down; the camera's encoder is left alone", async () => {
    const getDisplayMedia = makeGetDisplayMedia({ settings: { width: 3840, height: 2160, displaySurface: "monitor" } });
    const { alice } = await connectedCall({ kind: "video", aliceOpts: { getDisplayMedia } });
    const cameraParams = JSON.stringify(cameraLine(alice.pc).sender.params);
    await toggle(alice);
    expect(screenLine(alice.pc).sender.params.encodings[0].scaleResolutionDownBy).toBe(2);
    expect(JSON.stringify(cameraLine(alice.pc).sender.params)).toBe(cameraParams);
  });

  test("a browser without degradationPreference still gets the other settings", async () => {
    const { alice } = await connectedCall({ kind: "audio" });
    const sender = screenLine(alice.pc).sender;
    let attempts = 0;
    sender.setParameters = vi.fn(async (params) => {
      attempts += 1;
      if (params.degradationPreference) throw new TypeError("unsupported");
      sender.params = params;
    });
    await toggle(alice);
    expect(attempts).toBe(2);
    expect(sender.params.encodings[0]).toMatchObject({ maxFramerate: 15 });
    expect(state(alice).screenSharing).toBe(true);
  });

  test("stopping releases the capture, empties the line and tells the other side", async () => {
    const { alice, bob, pcA } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    const track = alice.getDisplayMedia.streams[0].getVideoTracks()[0];
    await toggle(alice);
    expect(track.stopped).toBe(true); // the browser's sharing indicator goes away
    expect(screenLine(pcA).sender.track).toBeNull();
    expect(state(alice)).toMatchObject({ screenSharing: false, screenStream: null, screenSurface: null });
    expect(screenMessages(pcA).at(-1)).toEqual({ t: "screen", on: false });
    await waitFor(() => !state(bob).remoteScreenOn, { label: "bob's screen view closes" });
    expect(state(bob).remoteScreenStream).toBeNull();
    expect(state(bob).remoteScreenSize).toBeNull();
  });

  test("the browser's own 'Stop sharing' bar ends the share the same way", async () => {
    const { alice, bob, pcA } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    alice.getDisplayMedia.streams[0].getVideoTracks()[0].endByBrowser();
    await waitFor(() => !state(alice).screenSharing, { label: "share ended" });
    expect(screenLine(pcA).sender.track).toBeNull();
    expect(screenMessages(pcA).at(-1)).toEqual({ t: "screen", on: false });
    await waitFor(() => !state(bob).remoteScreenOn);
    // And a new share can follow.
    await toggle(alice);
    expect(state(alice).screenSharing).toBe(true);
    expect(alice.getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  test("picking another source replaces the share: the old capture is released and nobody sees a gap", async () => {
    const { alice, bob, pcA } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    const first = alice.getDisplayMedia.streams[0].getVideoTracks()[0];
    await alice.manager.startScreenShare({ replace: true });
    const second = alice.getDisplayMedia.streams[1].getVideoTracks()[0];
    expect(second).not.toBe(first);
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
    expect(screenLine(pcA).sender.track).toBe(second);
    expect(screenMessages(pcA).filter((m) => m.on === false)).toHaveLength(0);
    expect(screenMessages(pcA).filter((m) => m.on === true)).toHaveLength(2);
    // The old picture ending late does nothing.
    first.endByBrowser();
    expect(state(alice).screenSharing).toBe(true);
    // Starting again without asking to replace keeps what is shared.
    await alice.manager.startScreenShare();
    expect(alice.getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  test("the camera and the screen can be on at the same time", async () => {
    const { alice, bob, pcA } = await connectedCall({ kind: "video" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    expect(state(alice)).toMatchObject({ screenSharing: true, cameraOn: true });
    expect(cameraLine(pcA).sender.track.kind).toBe("video");
    expect(cameraLine(pcA).sender.track).not.toBe(screenLine(pcA).sender.track);
    // The camera can be switched off and on with the screen still going.
    await alice.manager.setCameraEnabled(false);
    expect(state(alice)).toMatchObject({ screenSharing: true, cameraOn: false });
    expect(screenLine(pcA).sender.track).not.toBeNull();
    await alice.manager.setCameraEnabled(true);
    expect(state(alice)).toMatchObject({ screenSharing: true, cameraOn: true });
  });

  test("both people can share at once", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await toggle(bob);
    await waitFor(() => state(alice).remoteScreenOn && state(bob).remoteScreenOn, { label: "both see the other" });
    expect(state(alice).screenSharing && state(bob).screenSharing).toBe(true);
  });

  test("a hidden tab does not pause the screen the way it pauses the camera", async () => {
    const { alice, bob } = await connectedCall({ kind: "video" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    const track = alice.getDisplayMedia.streams[0].getVideoTracks()[0];
    await alice.manager.setPageHidden(true);
    expect(state(alice).cameraOn).toBe(false);
    expect(track.stopped).toBe(false);
    expect(state(alice).screenSharing).toBe(true);
    await alice.manager.setPageHidden(false);
    expect(state(alice)).toMatchObject({ screenSharing: true, cameraOn: true });
  });

  test("a share that is going on is announced again when the connection comes back", async () => {
    const { alice, pcA } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    const before = screenMessages(pcA).length;
    pcA.setState("disconnected");
    pcA.setState("connected");
    expect(screenMessages(pcA).length).toBe(before + 1);
    expect(screenMessages(pcA).at(-1)).toMatchObject({ on: true });
  });

  test("before the in-band channel is open nothing is offered; it is once the other side has said what it can do", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" }, kind: "audio" });
    await waitFor(() => phase(CALL_PHASE.INCOMING)(bob));
    await bob.manager.accept();
    await waitFor(() => phase(CALL_PHASE.CONNECTED)(alice) && phase(CALL_PHASE.CONNECTED)(bob));
    // Before the channel is open nobody knows whether the other can show a screen.
    await toggle(alice);
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
    expect(state(alice).screenError).toBe("unavailable");
    linkDataChannels(alice.pc, bob.pc);
    await waitFor(() => state(alice).screenAvailable, { label: "bob says it can show a screen" });
    await toggle(alice);
    expect(state(alice).screenSharing).toBe(true);
  });
});

describe("when sharing does not start", () => {
  test("a cancelled or refused prompt is a small hint, not an error screen, and it clears itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const getDisplayMedia = makeGetDisplayMedia({ deny: "NotAllowedError" });
    const { alice, bob } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    await toggle(alice);
    expect(state(alice)).toMatchObject({ phase: CALL_PHASE.CONNECTED, screenSharing: false, screenBusy: false, screenError: "cancelled" });
    expect(state(bob).remoteScreenOn).toBe(false);
    expect(screenMessages(alice.pc)).toEqual([]);
    await vi.advanceTimersByTimeAsync(SCREEN_ERROR_SHOWN_MS + 100);
    expect(state(alice).screenError).toBeNull();
    expect(state(alice).phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("a failing capture says it failed; another try works", async () => {
    let fail = true;
    const inner = makeGetDisplayMedia();
    const getDisplayMedia = vi.fn(async (request) => {
      if (fail) throw Object.assign(new Error("boom"), { name: "NotReadableError" });
      return inner(request);
    });
    const { alice } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    await toggle(alice);
    expect(state(alice).screenError).toBe("failed");
    fail = false;
    await toggle(alice);
    expect(state(alice)).toMatchObject({ screenSharing: true, screenError: null });
  });

  test("a capture that cannot be put on the line is released", async () => {
    const { alice } = await connectedCall({ kind: "audio" });
    screenLine(alice.pc).sender.replaceTrack = vi.fn(async () => {
      throw new Error("closed");
    });
    await toggle(alice);
    expect(alice.getDisplayMedia.streams[0].getTracks().every((t) => t.stopped)).toBe(true);
    expect(state(alice)).toMatchObject({ screenSharing: false, screenBusy: false, screenError: "failed" });
  });

  test("while the prompt is open the share is 'busy', and the call goes on", async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const getDisplayMedia = makeGetDisplayMedia({ gate });
    const { alice } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    const pending = toggle(alice);
    await waitFor(() => state(alice).screenBusy, { label: "prompt open" });
    expect(state(alice).screenSharing).toBe(false);
    open();
    await pending;
    expect(state(alice)).toMatchObject({ screenBusy: false, screenSharing: true });
  });

  test("the call ending while the prompt is open leaves no capture behind", async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const getDisplayMedia = makeGetDisplayMedia({ gate });
    const { alice, bob } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    const pending = toggle(alice);
    await waitFor(() => state(alice).screenBusy);
    await alice.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    open();
    await pending;
    const stream = getDisplayMedia.streams[0];
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true);
    expect(state(alice)).toMatchObject({ screenSharing: false, screenBusy: false, screenStream: null });
    expect(screenLine(alice.pc).sender.replaceTrack).not.toHaveBeenCalled();
  });

  test("the other person hanging up while the prompt is open does the same", async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const getDisplayMedia = makeGetDisplayMedia({ gate });
    const { alice, bob } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    const pending = toggle(alice);
    await waitFor(() => state(alice).screenBusy);
    await bob.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    open();
    await pending;
    expect(getDisplayMedia.streams[0].getTracks().every((t) => t.stopped)).toBe(true);
  });

  test("two quick presses end in what the second asked for: nothing shared and nothing left running", async () => {
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const getDisplayMedia = makeGetDisplayMedia({ gate });
    const { alice } = await connectedCall({ kind: "audio", aliceOpts: { getDisplayMedia } });
    const first = toggle(alice); // start
    const second = toggle(alice); // changed my mind
    open();
    await Promise.all([first, second]);
    expect(state(alice)).toMatchObject({ screenSharing: false, screenBusy: false });
    expect(getDisplayMedia.streams.every((s) => s.getTracks().every((t) => t.stopped))).toBe(true);
    expect(screenLine(alice.pc).sender.track).toBeNull();
  });

  test("three quick presses share once", async () => {
    const { alice } = await connectedCall({ kind: "audio" });
    await Promise.all([toggle(alice), toggle(alice), toggle(alice)]);
    expect(state(alice).screenSharing).toBe(true);
    const live = alice.getDisplayMedia.streams.flatMap((s) => s.getTracks()).filter((t) => !t.stopped);
    expect(live).toHaveLength(1);
    expect(screenLine(alice.pc).sender.track).toBe(live[0]);
  });

  test("sharing is only possible while the call is connected", async () => {
    const server = new FakeServer();
    const alice = await server.addUser("alice");
    const bob = await server.addUser("bob");
    await alice.manager.startCall({ chatId: "c", peer: { userId: bob.user.id, username: "bob" }, kind: "audio" });
    await toggle(alice);
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
    expect(state(alice).screenError).toBeNull();
    await alice.manager.hangup();
    await toggle(alice); // nothing to share into
    expect(alice.getDisplayMedia).not.toHaveBeenCalled();
  });
});

describe("the end of a call", () => {
  test("hanging up while sharing releases the capture and clears the screen state", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await waitFor(() => state(bob).remoteScreenOn);
    const track = alice.getDisplayMedia.streams[0].getVideoTracks()[0];
    await alice.manager.hangup();
    expect(track.stopped).toBe(true);
    expect(state(alice)).toMatchObject({ phase: CALL_PHASE.ENDED, screenSharing: false, screenStream: null, screenAvailable: false });
    await waitFor(() => phase(CALL_PHASE.ENDED)(bob));
    expect(state(bob)).toMatchObject({ remoteScreenOn: false, remoteScreenStream: null, remoteScreenSize: null });
  });

  test("the other person hanging up takes the screen away and releases ours", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await toggle(bob);
    await waitFor(() => state(alice).remoteScreenOn && state(bob).remoteScreenOn);
    await bob.manager.hangup();
    await waitFor(() => phase(CALL_PHASE.ENDED)(alice));
    expect(alice.getDisplayMedia.streams[0].getTracks().every((t) => t.stopped)).toBe(true);
    expect(state(alice)).toMatchObject({ remoteScreenOn: false, remoteScreenStream: null, screenSharing: false });
  });

  test("the next call starts with a clean slate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { alice } = await connectedCall({ kind: "audio" });
    await toggle(alice);
    await alice.manager.hangup();
    await vi.advanceTimersByTimeAsync(3000);
    expect(state(alice)).toMatchObject({ phase: CALL_PHASE.IDLE, screenSharing: false, remoteScreenOn: false, screenStats: null });
  });
});

describe("a peer that misbehaves", () => {
  const say = (c, message) => c.pc.dc.send(typeof message === "string" ? message : JSON.stringify(message));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  test("only a real boolean turns the screen on", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    for (const on of ["true", 1, "yes", null, {}, []]) {
      say(alice, { t: "screen", on });
      await settle();
      expect(state(bob).remoteScreenOn).toBe(false);
    }
    say(alice, { t: "screen", on: true });
    await waitFor(() => state(bob).remoteScreenOn);
    say(alice, { t: "screen", on: "no" }); // anything but true is off
    await waitFor(() => !state(bob).remoteScreenOn);
  });

  test("announced sizes are whole numbers in range or ignored", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    say(alice, { t: "screen", on: true, w: 1e9, h: 2000.4 });
    await waitFor(() => state(bob).remoteScreenOn);
    expect(state(bob).remoteScreenSize).toEqual({ w: 16384, h: 2000 });
    for (const [w, h] of [["1920", 1080], [-5, 100], [0, 0], [Infinity, 10], [NaN, 10], [null, null], [{}, []]]) {
      say(alice, { t: "screen", on: true, w, h });
      await settle();
      expect(state(bob).remoteScreenSize).toBeNull();
      expect(state(bob).remoteScreenOn).toBe(true);
    }
  });

  test("a picture on the screen line that was never announced is not shown", async () => {
    const { bob } = await connectedCall({ kind: "audio" });
    // The line and its track exist from the first offer; nothing is shown until the peer says so.
    expect(screenLine(bob.pc).receiver.track).toBeTruthy();
    screenLine(bob.pc).receiver.track.muted = false;
    screenLine(bob.pc).receiver.track.onunmute?.();
    expect(state(bob)).toMatchObject({ remoteScreenOn: false, remoteScreenStream: null });
    expect(state(bob).remoteCameraOn).toBe(false); // and it is not mistaken for a camera
  });

  test("announcing a share does not claim the camera is on, and a camera announcement does not show a screen", async () => {
    const { alice, bob } = await connectedCall({ kind: "video" });
    say(alice, { t: "state", muted: false, video: false, q: "auto", screen: true });
    await settle();
    expect(state(bob)).toMatchObject({ remoteCameraOn: false, remoteScreenOn: false });
    say(alice, { t: "screen", on: true });
    await waitFor(() => state(bob).remoteScreenOn);
    expect(state(bob).remoteCameraOn).toBe(false);
  });

  test("junk, oversized or unknown messages change nothing", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    const before = state(bob);
    for (const junk of ["not json", "{", "[]", JSON.stringify({ t: "screen" }), JSON.stringify({ t: "scren", on: true }), JSON.stringify({ t: "screen", on: true, pad: "x".repeat(300) })]) {
      say(alice, junk);
    }
    await settle();
    expect(state(bob).remoteScreenOn).toBe(before.remoteScreenOn);
    expect(state(bob).phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("a peer that stops announcing capability makes sharing unavailable again", async () => {
    const { alice, bob } = await connectedCall({ kind: "audio" });
    expect(state(bob).screenAvailable).toBe(true);
    say(alice, { t: "state", muted: false, video: false, q: "auto" });
    await waitFor(() => !state(bob).screenAvailable);
  });
});

describe("adapting to the network", () => {
  const bad = [
    { id: "p", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.9, localCandidateId: "l", remoteCandidateId: "r" },
    { id: "l", type: "local-candidate", candidateType: "host" },
    { id: "r", type: "remote-candidate", candidateType: "host" },
    { id: "x", type: "remote-inbound-rtp", fractionLost: 0.2 },
  ];
  const good = bad.map((r) => (r.id === "p" ? { ...r, currentRoundTripTime: 0.05 } : r.id === "x" ? { ...r, fractionLost: 0 } : r));

  async function sharing() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const ctx = await connectedCall({ kind: "audio" });
    await toggle(ctx.alice);
    return ctx;
  }
  const encoding = (c) => screenLine(c.pc).sender.params.encodings[0];

  test("a bad network lowers the frame rate, then the bitrate, and never touches the voice", async () => {
    const { alice, pcA } = await sharing();
    const microphone = pcA.senders.find((s) => s.track?.kind === "audio");
    const micParams = JSON.stringify(microphone.params);
    pcA.statsReport = bad;
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      seen.push({ fps: encoding(alice).maxFramerate, bitrate: encoding(alice).maxBitrate });
    }
    expect(seen[0].fps).toBeLessThan(15);
    expect(seen[0].bitrate).toBe(2_500_000); // the frame rate goes first
    expect(seen.at(-1).bitrate).toBeLessThan(2_500_000);
    expect(seen.at(-1).fps).toBeLessThanOrEqual(seen[0].fps);
    // The lowest level is still a picture, and the call is untouched.
    expect(seen.at(-1).fps).toBeGreaterThan(0);
    expect(state(alice).screenSharing).toBe(true);
    expect(microphone.track.enabled).toBe(true);
    expect(JSON.stringify(microphone.params)).toBe(micParams);
    expect(state(alice).phase).toBe(CALL_PHASE.CONNECTED);
  });

  test("the profiles go down to a floor and stay there", async () => {
    const { alice, pcA } = await sharing();
    pcA.statsReport = bad;
    for (let i = 0; i < SCREEN_PROFILES.length + 4; i += 1) await vi.advanceTimersByTimeAsync(5000);
    const floor = SCREEN_PROFILES.at(-1);
    expect(encoding(alice)).toMatchObject({ maxFramerate: floor.maxFramerate, maxBitrate: floor.maxBitrate });
  });

  test("a recovered network climbs back up, slowly", async () => {
    const { alice, pcA } = await sharing();
    pcA.statsReport = bad;
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(5000);
    const low = encoding(alice).maxFramerate;
    pcA.statsReport = good;
    await vi.advanceTimersByTimeAsync(5000);
    expect(encoding(alice).maxFramerate).toBe(low); // one good sample is not enough
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(5000);
    expect(encoding(alice).maxFramerate).toBe(15);
  });

  test("nothing is adapted while no screen is shared, and a new share starts at the best level", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, pcA } = await connectedCall({ kind: "audio" });
    pcA.statsReport = bad;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screenLine(pcA).sender.params).toEqual({ encodings: [{}] });
    pcA.statsReport = good;
    await toggle(alice);
    expect(screenLine(pcA).sender.params.encodings[0].maxFramerate).toBe(15);
  });

  test("the size and rate of the screen that arrives are reported once it is on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { alice, bob, pcB } = await connectedCall({ kind: "video" });
    await toggle(alice);
    await vi.advanceTimersByTimeAsync(0);
    expect(state(bob).remoteScreenOn).toBe(true);
    pcB.statsReport = [
      { id: "cam", type: "inbound-rtp", kind: "video", trackIdentifier: cameraLine(pcB).receiver.track.id, frameWidth: 640, frameHeight: 360, framesPerSecond: 24 },
      { id: "scr", type: "inbound-rtp", kind: "video", trackIdentifier: screenLine(pcB).receiver.track.id, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 9.6 },
    ];
    await vi.advanceTimersByTimeAsync(5000);
    expect(state(bob).screenStats).toEqual({ width: 1920, height: 1080, fps: 10 });
    // The camera's numbers are the camera's, not the screen's.
    expect(state(bob).videoStats).toEqual({ width: 640, height: 360, fps: 24 });
    await toggle(alice);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state(bob).screenStats).toBeNull();
  });
});
