import { vi } from "vitest";
import { CallManager } from "../../src/calls/callManager.js";
import { createDirectory } from "../../src/e2ee/directory.js";
import { createKeyStore, createMemoryAdapter } from "../../src/e2ee/keyStore.js";
import { createTrustTracker } from "../../src/e2ee/trust.js";
import { ApiError } from "../../src/api/e2eeApi.js";
import { makeIdentity } from "../e2ee/helpers.js";

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function waitFor(predicate, { timeout = 3000, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await tick();
  }
}

// ── media ────────────────────────────────────────────────────────────────────
let trackSerial = 0;
export class FakeTrack {
  constructor(kind, deviceId = "default", settings = {}) {
    this.id = `fake-track-${(trackSerial += 1)}`;
    this.kind = kind;
    this.deviceId = deviceId;
    this.enabled = true;
    this.readyState = "live";
    this.stopped = false;
    this.contentHint = "";
    this.extraSettings = settings;
    this.onended = null;
  }
  getSettings() { return { deviceId: this.deviceId, ...this.extraSettings }; }
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
  /** What the browser does when the person presses its own "Stop sharing" bar. */
  endByBrowser() {
    this.readyState = "ended";
    this.onended?.({ type: "ended" });
  }
}

export class FakeStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  addTrack(t) { if (!this.tracks.includes(t)) this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}

export function makeGetUserMedia({ deny = null } = {}) {
  const calls = [];
  const fn = vi.fn(async (constraints) => {
    calls.push(constraints);
    if (deny) throw Object.assign(new Error(deny), { name: deny });
    const tracks = [];
    if (constraints.audio) tracks.push(new FakeTrack("audio", constraints.audio.deviceId?.exact || "default"));
    if (constraints.video) tracks.push(new FakeTrack("video"));
    return new FakeStream(tracks);
  });
  fn.calls = calls;
  return fn;
}

/**
 * A fake navigator.mediaDevices.getDisplayMedia. `gate` is a promise (or a
 * function returning one) that keeps the picker "open" until the test resolves it.
 */
export function makeGetDisplayMedia({
  deny = null,
  gate = null,
  settings = { width: 1920, height: 1080, displaySurface: "monitor" },
  withAudio = false,
} = {}) {
  const calls = [];
  const streams = [];
  const fn = vi.fn(async (constraints) => {
    calls.push(constraints);
    if (gate) await (typeof gate === "function" ? gate() : gate);
    if (deny) throw Object.assign(new Error(deny), { name: deny });
    const tracks = [new FakeTrack("video", "screen", settings)];
    if (withAudio) tracks.push(new FakeTrack("audio", "system"));
    const stream = new FakeStream(tracks);
    streams.push(stream);
    return stream;
  });
  fn.calls = calls;
  fn.streams = streams;
  return fn;
}

// ── peer connection ──────────────────────────────────────────────────────────
class FakeSender {
  constructor(track) {
    this.track = track;
    this.params = { encodings: [{}] };
    this.replaceTrack = vi.fn(async (t) => { this.track = t; });
  }
  getParameters() { return JSON.parse(JSON.stringify(this.params)); }
  async setParameters(p) { this.params = p; }
}

class FakeDataChannel {
  constructor() {
    this.readyState = "connecting";
    this.sent = [];
    this.peer = null;
    this.onopen = null;
    this.onmessage = null;
  }
  send(data) {
    this.sent.push(data);
    const peer = this.peer;
    if (peer?.readyState === "open") queueMicrotask(() => peer.onmessage?.({ data }));
  }
  close() { this.readyState = "closed"; }
}

// Section list of an SDP: [{kind, mid, direction, rejected}], in m-line order.
function fakeSections(sdp) {
  const sections = [];
  for (const line of String(sdp || "").split(/\r?\n/)) {
    const m = /^m=(\w+) (\d+) /.exec(line);
    if (m) {
      sections.push({ kind: m[1], mid: null, direction: "sendrecv", rejected: m[2] === "0" });
      continue;
    }
    const current = sections.at(-1);
    if (!current) continue;
    const mid = /^a=mid:(\S+)/.exec(line);
    if (mid) current.mid = mid[1];
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line);
    if (direction) current.direction = direction[1];
  }
  return sections;
}

const sends = (direction) => direction === "sendrecv" || direction === "sendonly";
const receives = (direction) => direction === "sendrecv" || direction === "recvonly";
// What an answerer ends up doing for an offered direction, given its own wish.
function answerDirection(offered, own) {
  const send = sends(own) && receives(offered);
  const receive = receives(own) && sends(offered);
  return send && receive ? "sendrecv" : send ? "sendonly" : receive ? "recvonly" : "inactive";
}

export class FakePeerConnection {
  static instances = [];
  /** false: media never connects (a network that needs a relay nobody set up). */
  static autoConnect = true;
  /** Like a browser, a received video offer creates a receive-only video line. */
  static videoLineFromOffer = true;
  /** true: gathering also yields a relay candidate (the TURN server is reachable). */
  static relayCandidates = false;
  /** Like relayCandidates, but decided per connection: (pc) => boolean. */
  static relayOn = null;
  /** Events for onicecandidateerror during gathering, e.g. {url, errorCode, errorText}. */
  static iceErrors = [];
  /** false: gathering never reports that it is complete. */
  static gatheringCompletes = true;
  /** true: an answering connection rejects (port 0) every video line after the first, like a stack that does not know the extra line. */
  static rejectExtraVideo = false;

  constructor(config) {
    this.config = config;
    this.senders = [];
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.iceGatheringState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.dc = null;
    this.closed = false;
    this.offerOptions = [];
    this.statsReport = [];
    this.transceivers = [];
    this.ontrack = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    FakePeerConnection.instances.push(this);
  }
  #makeTransceiver(kind, { sender, direction, byAddTrack = false, mid = null }) {
    const receiverTrack = new FakeTrack(kind);
    receiverTrack.muted = true; // a remote track stays muted until media actually arrives
    const transceiver = {
      kind,
      sender,
      receiver: { track: receiverTrack },
      direction,
      currentDirection: null,
      mid,
      byAddTrack,
      stopped: false,
      setCodecPreferences: vi.fn(),
    };
    this.senders.push(sender);
    this.transceivers.push(transceiver);
    return transceiver;
  }
  #takeMid() {
    const used = new Set(this.transceivers.map((t) => t.mid).filter((m) => m !== null));
    let n = 0;
    while (used.has(String(n))) n += 1;
    return String(n);
  }
  addTrack(track) {
    const sender = new FakeSender(track);
    this.#makeTransceiver(track.kind, { sender, direction: "sendrecv", byAddTrack: true });
    return sender;
  }
  addTransceiver(kind, init = {}) {
    // Like a browser: a two-way transceiver without a track yet, which a track
    // can later be swapped into without renegotiating.
    return this.#makeTransceiver(kind, { sender: new FakeSender(null), direction: init.direction || "sendrecv" });
  }
  getTransceivers() { return this.transceivers; }
  createDataChannel() {
    this.dc = new FakeDataChannel();
    return this.dc;
  }
  async createOffer(options) {
    this.offerOptions.push(options);
    for (const t of this.transceivers) if (t.mid === null && !t.stopped) t.mid = this.#takeMid();
    const sections = this.transceivers.map((t) => ({ kind: t.kind, mid: t.mid, direction: t.direction, rejected: false }));
    return { type: "offer", sdp: fakeSdp(sections) };
  }
  async createAnswer() {
    let videoSeen = 0;
    const sections = fakeSections(this.remoteDescription?.sdp).map((offered) => {
      const t = this.transceivers.find((x) => x.mid === offered.mid);
      if (offered.kind === "video") videoSeen += 1;
      const unknown = FakePeerConnection.rejectExtraVideo && offered.kind === "video" && videoSeen > 1;
      if (unknown) {
        if (t) t.stopped = true;
        return { kind: offered.kind, mid: offered.mid, direction: "inactive", rejected: true };
      }
      if (!t || t.stopped) return { kind: offered.kind, mid: offered.mid, direction: "inactive", rejected: true };
      return { kind: offered.kind, mid: offered.mid, direction: answerDirection(offered.direction, t.direction), rejected: false };
    });
    return { type: "answer", sdp: fakeSdp(sections) };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    if (desc.type === "answer") {
      for (const section of fakeSections(desc.sdp)) {
        const t = this.transceivers.find((x) => x.mid === section.mid);
        if (t) t.currentDirection = section.rejected ? null : section.direction;
      }
    }
    // Gathering yields two candidates and then the end-of-candidates marker.
    queueMicrotask(() => {
      const make = (n) => ({ candidate: { toJSON: () => ({ candidate: `candidate:${n} 1 udp 1 10.0.0.${n} 9 typ host`, sdpMid: "0" }) } });
      this.onicecandidate?.(make(1));
      this.onicecandidate?.(make(2));
      if (FakePeerConnection.relayCandidates || FakePeerConnection.relayOn?.(this)) {
        this.onicecandidate?.({
          candidate: {
            relayProtocol: "tcp",
            toJSON: () => ({ candidate: "candidate:3 1 udp 1 10.0.0.3 9 typ relay raddr 0.0.0.0 rport 0", sdpMid: "0" }),
          },
        });
      }
      FakePeerConnection.iceErrors.forEach((error) => this.onicecandidateerror?.(error));
      if (FakePeerConnection.gatheringCompletes) {
        this.iceGatheringState = "complete";
        this.onicegatheringstatechange?.();
        this.onicecandidate?.({ candidate: null });
      }
    });
    this.#maybeConnect();
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    const sections = fakeSections(desc.sdp);
    sections.forEach((section) => {
      let t = this.transceivers.find((x) => x.mid === section.mid);
      if (!t && desc.type === "offer" && !section.rejected) {
        // A browser attaches the offered line to a transceiver addTrack made
        // for that kind, or else creates a receive-only one.
        t = this.transceivers.find((x) => x.mid === null && x.byAddTrack && x.kind === section.kind && !x.stopped);
        if (t) t.mid = section.mid;
        else if (section.kind !== "video" || FakePeerConnection.videoLineFromOffer) {
          t = this.#makeTransceiver(section.kind, { sender: new FakeSender(null), direction: "recvonly", mid: section.mid });
        }
      }
      if (!t) return;
      if (desc.type === "answer") {
        if (section.rejected) {
          t.stopped = true;
          t.currentDirection = null;
        } else {
          t.currentDirection = answerDirection(section.direction, t.direction);
        }
      }
      if (!section.rejected && sends(section.direction)) {
        // The remote side sends on this line: the browser announces the track.
        this.ontrack?.({ track: t.receiver.track, transceiver: t, receiver: t.receiver, streams: [] });
      }
    });
    this.#maybeConnect();
  }
  async addIceCandidate(c) { this.addedCandidates.push(c); }
  async getStats() { return new Map(this.statsReport.map((r) => [r.id, r])); }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
  setState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  #maybeConnect() {
    if (FakePeerConnection.autoConnect && this.localDescription && this.remoteDescription && this.connectionState === "new") {
      setImmediate(() => this.setState("connected"));
    }
  }
}

/** The SDP of a fake session: one fingerprint, one BUNDLE group, one m-line per section. */
export function fakeSdp(sections) {
  const bundled = sections.filter((s) => !s.rejected).map((s) => s.mid);
  const lines = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=fingerprint:sha-256 AA:BB:CC:SECRET-FINGERPRINT",
    `a=group:BUNDLE ${bundled.join(" ")}`.trimEnd(),
  ];
  for (const s of sections) {
    if (s.kind === "audio") {
      lines.push(`m=audio ${s.rejected ? 0 : 9} UDP/TLS/RTP/SAVPF 111`, `a=mid:${s.mid}`, `a=${s.direction}`);
      lines.push("a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1");
    } else {
      lines.push(`m=${s.kind} ${s.rejected ? 0 : 9} UDP/TLS/RTP/SAVPF 96`, `a=mid:${s.mid}`, `a=${s.direction}`);
      lines.push("a=rtpmap:96 VP8/90000");
    }
  }
  lines.push("");
  return lines.join("\r\n");
}

export const FAKE_SDP = fakeSdp([{ kind: "audio", mid: "0", direction: "sendrecv", rejected: false }]);

/** Links the two negotiated data channels of a call so state messages flow. */
export function linkDataChannels(a, b) {
  if (a.dc && b.dc) {
    a.dc.peer = b.dc;
    b.dc.peer = a.dc;
    a.dc.readyState = "open";
    b.dc.readyState = "open";
    a.dc.onopen?.();
    b.dc.onopen?.();
  }
}

// ── server + clients ─────────────────────────────────────────────────────────
export class FakeServer {
  constructor() {
    this.devices = new Map(); // userId -> [record]
    this.managers = new Map(); // userId -> CallManager[] (one per signed-in device)
    this.users = new Map();
    this.log = []; // everything the "server" saw
    this.calls = new Map();
    this.tamper = null; // optional (event) => event
  }

  callerDeviceOf(call) {
    return call.callerDeviceId;
  }

  deliver(userId, event) {
    const out = this.tamper ? this.tamper(event) : event;
    if (!out) return;
    setImmediate(() => (this.managers.get(userId) || []).forEach((m) => m.handleEvent(out)));
  }

  apiFor(user) {
    const server = this;
    const peerOf = (call) => (call.caller === user.id ? call.callee : call.caller);
    return {
      fetchIceConfig: vi.fn(async () => ({ iceServers: [{ urls: ["turn:t.example:3478"], username: "u", credential: "c" }] })),
      startCall: vi.fn(async ({ callId, chatId, kind, invite }) => {
        server.log.push({ op: "startCall", callId, kind, invite });
        if (server.busy) throw new ApiError("User is busy.", { status: 409, code: "busy" });
        const callee = [...server.users.values()].find((u) => u.id !== user.id);
        if (server.busyOnce) {
          server.busyOnce = false;
          throw new ApiError("You are already in a call.", { status: 409, code: "busy_self" });
        }
        // Like the real registry: one live call per person.
        const live = [...server.calls.values()];
        if (live.some((c) => c.caller === user.id || c.callee === user.id)) {
          throw new ApiError("You are already in a call.", { status: 409, code: "busy_self" });
        }
        if (live.some((c) => c.caller === callee.id || c.callee === callee.id)) {
          throw new ApiError("User is busy.", { status: 409, code: "busy" });
        }
        server.calls.set(callId, { caller: user.id, callee: callee.id, calleeDeviceId: null, callerDeviceId: invite.deviceId });
        server.deliver(callee.id, {
          type: "call_invite",
          callId,
          kind,
          chatId,
          from: { userId: user.id, username: user.username, nickname: user.username },
          invite,
        });
      }),
      acceptCall: vi.fn(async (callId, accept) => {
        server.log.push({ op: "acceptCall", callId, accept });
        const call = server.calls.get(callId);
        if (!call || call.calleeDeviceId) {
          throw new ApiError("Call already answered.", { status: 409, code: "not_ringing" });
        }
        call.calleeDeviceId = accept.deviceId;
        server.deliver(call.caller, { type: "call_accept", callId, accept });
        server.deliver(call.callee, { type: "call_accepted_elsewhere", callId, deviceId: accept.deviceId });
      }),
      sendCallSignal: vi.fn(async (callId, { kind, blob, seq, eph }) => {
        server.log.push({ op: "signal", callId, kind, blob, seq, eph });
        const call = server.calls.get(callId);
        if (!call) throw new ApiError("Call is not in progress.", { status: 409 });
        const to = peerOf(call);
        server.deliver(to, {
          type: "call_signal",
          callId,
          kind,
          blob,
          seq,
          ...(eph ? { eph } : {}),
          toDeviceId: to === call.callee ? call.calleeDeviceId : server.callerDeviceOf(call),
        });
      }),
      markCallRinging: vi.fn(async (callId) => {
        server.log.push({ op: "ringing", callId });
        const call = server.calls.get(callId);
        if (call && !call.calleeDeviceId && !call.ringingSent) {
          call.ringingSent = true;
          server.deliver(call.caller, { type: "call_ringing", callId });
        }
      }),
      markCallConnected: vi.fn(async () => {}),
      endCall: vi.fn(async (callId, reason) => {
        server.log.push({ op: "endCall", callId, reason, by: user.id });
        const call = server.calls.get(callId);
        if (!call) return;
        const other = peerOf(call);
        const wasRinging = !call.calleeDeviceId;
        const mapped = reason === "declined" ? "declined" : wasRinging && call.caller === user.id ? "cancelled" : reason === "failed" || reason === "connect_failed" ? reason : "hangup";
        server.deliver(other, { type: "call_end", callId, reason: mapped, by: user.id });
        server.calls.delete(callId);
      }),
      fetchPendingCall: vi.fn(async () => ({ call: null })),
    };
  }

  /** Signs a second device in for an existing user (a phone and a laptop). */
  async addDevice(username, managerOptions = {}) {
    return this.addUser(username, { ...managerOptions, additionalDevice: true });
  }

  async addUser(username, { additionalDevice = false, ...managerOptions } = {}) {
    const { identity, record } = await makeIdentity(`user-${username}`);
    const user = { id: `user-${username}`, username };
    this.users.set(user.id, user);
    this.devices.set(user.id, [...(additionalDevice ? this.devices.get(user.id) || [] : []), record]);

    const store = createKeyStore(createMemoryAdapter());
    const trust = createTrustTracker(store);
    const directory = createDirectory({
      api: {
        fetchUserDevices: async (userId) => ({ devices: this.devices.get(userId) || [] }),
        fetchChatDevices: async () => ({ devices: [], membersWithoutDevice: [] }),
      },
      trust,
      ttlMs: 0,
    });
    const api = this.apiFor(user);
    const getUserMedia = managerOptions.getUserMedia || makeGetUserMedia();
    const ctx = { user, identity, record, api, directory, trust, store, getUserMedia, pc: null };
    const manager = new CallManager({
      selfUser: user,
      api,
      getIdentity: async () => identity,
      directory,
      createPeerConnection: (config) => {
        ctx.pc = new FakePeerConnection(config);
        return ctx.pc;
      },
      getUserMedia,
      createMediaStream: () => new FakeStream(),
      getVideoCodecs: () => [{ mimeType: "video/VP9" }, { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" }],
      requestWakeLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
      ...managerOptions,
    });
    this.managers.set(user.id, [...(additionalDevice ? this.managers.get(user.id) || [] : []), manager]);
    ctx.manager = manager;
    return ctx;
  }
}

export const lastPc = () => FakePeerConnection.instances.at(-1);
