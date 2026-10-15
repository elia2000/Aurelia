// Framework-free 1:1 call controller.
//
// Owns one call at a time: the authenticated key exchange (callCrypto.js), the
// RTCPeerConnection, ICE batching/restarts, mute/camera state, and the
// battery/data adaptation (mediaTuning.js). React talks to it through
// `subscribe` / `getState` only, which keeps it testable with fakes.

import { sasEmoji } from "../e2ee/sas.js";
import { randomUuid } from "../e2ee/encoding.js";
import { KeyMismatchError } from "../e2ee/directory.js";
import { TRUST } from "../e2ee/trust.js";
import {
  createAccept,
  createInvite,
  deriveCallSession,
  openSignal,
  sealSignal,
  verifyAccept,
  verifyInvite,
} from "./callCrypto.js";
import {
  CAPTURE_CONSTRAINTS,
  DEFAULT_VIDEO_TIER,
  encodingForTier,
  initialAdaptation,
  nextVideoTier,
  orderVideoCodecs,
  summarizeStats,
  tuneOpusSdp,
} from "./mediaTuning.js";

export const CALL_PHASE = Object.freeze({
  IDLE: "idle",
  OUTGOING: "outgoing",
  INCOMING: "incoming",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ENDED: "ended",
});

export const RING_TIMEOUT_MS = 50_000;
const ICE_BATCH_MS = 150;
const DISCONNECT_GRACE_MS = 8_000;
const FAILED_WAIT_MS = 15_000;
const STATS_INTERVAL_MS = 5_000;
const ENDED_LINGER_MS = 2_500;
const MAX_ICE_RESTARTS = 3;
const MAX_SIGNAL_AUTH_FAILURES = 3;

const idleState = () => ({
  phase: CALL_PHASE.IDLE,
  callId: null,
  kind: "audio",
  direction: null,
  chatId: null,
  peer: null,
  ringing: false,
  sas: null,
  trust: null,
  muted: false,
  remoteMuted: false,
  cameraOn: false,
  remoteCameraOn: false,
  videoTier: DEFAULT_VIDEO_TIER,
  networkPaused: false,
  relayed: false,
  localStream: null,
  remoteStream: null,
  connectedAt: null,
  endReason: null,
});

// End reasons that mean "this did not work", reported to the peer as a failure
// rather than a normal hang-up.
const FAILURE_REASONS = new Set([
  "failed",
  "handshake_failed",
  "key_mismatch",
  "permission_denied",
  "no_device",
  "e2ee_unavailable",
]);

const SERVER_END_REASONS = {
  declined: "declined",
  cancelled: "cancelled",
  hangup: "hangup",
  missed: "missed",
  failed: "failed",
  timeout: "failed",
};

export class CallManager {
  #opts;
  #state = idleState();
  #listeners = new Set();
  #call = null;

  /**
   * @param {object} opts
   * @param {{id: string, username: string}} opts.selfUser
   * @param {object} opts.api            e2eeApi-compatible (startCall, acceptCall, ...)
   * @param {Function} opts.getIdentity  () => Promise<identity>
   * @param {object} opts.directory      createDirectory() instance
   * @param {Function} [opts.createPeerConnection]  (config) => RTCPeerConnection
   * @param {Function} [opts.getUserMedia]          (constraints) => Promise<MediaStream>
   * @param {Function} [opts.createMediaStream]     () => MediaStream
   * @param {Function} [opts.getVideoCodecs]        () => RTCRtpCodec[] | null
   * @param {Function} [opts.requestWakeLock]       () => Promise<{release: Function}>
   * @param {{postMessage: Function, close?: Function}} [opts.broadcast]
   */
  constructor(opts) {
    this.#opts = {
      createPeerConnection: (config) => new RTCPeerConnection(config),
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createMediaStream: () => new MediaStream(),
      getVideoCodecs: () => {
        try {
          return RTCRtpReceiver.getCapabilities("video")?.codecs || null;
        } catch {
          return null;
        }
      },
      requestWakeLock: async () => navigator.wakeLock.request("screen"),
      broadcast: null,
      ...opts,
    };
  }

  // ── state ────────────────────────────────────────────────────────────────
  getState = () => this.#state;

  subscribe = (listener) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch) {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => {
      try {
        listener(this.#state);
      } catch (_) {
        // a broken subscriber must not break the call
      }
    });
  }

  get #api() {
    return this.#opts.api;
  }

  // ── outgoing ─────────────────────────────────────────────────────────────
  async startCall({ chatId, peer, kind = "audio" }) {
    if (this.#call) throw new Error("A call is already in progress.");
    const call = this.#begin({
      id: randomUuid(),
      kind: kind === "video" ? "video" : "audio",
      direction: "outgoing",
      chatId,
      peer,
    });
    this.#set({ phase: CALL_PHASE.OUTGOING, ringing: false, trust: null });

    try {
      const [identity, localStream, iceConfig] = await Promise.all([
        this.#opts.getIdentity(),
        this.#acquireMedia(call.kind),
        this.#api.fetchIceConfig(),
      ]);
      if (this.#isStale(call)) {
        this.#stopStream(localStream);
        return;
      }
      call.identity = identity;
      call.iceConfig = iceConfig;
      this.#attachLocalStream(call, localStream);

      // Fetching the callee's keys also runs the trust-on-first-use check.
      const peerKeys = await this.#opts.directory.getUserDevices(peer.userId);
      if (this.#isStale(call)) return;
      this.#set({ trust: peerKeys.assessment });

      const { ephemeral, invite } = await createInvite({
        callId: call.id,
        calleeUserId: peer.userId,
        kind: call.kind,
        identity,
      });
      call.ephemeral = ephemeral;
      call.invite = invite;
      await this.#api.startCall({
        callId: call.id,
        chatId,
        kind: call.kind,
        invite,
      });
      if (this.#isStale(call)) return;
      this.#set({ ringing: true });
      call.ringTimer = setTimeout(() => this.#finish(call, "no_answer", { notifyServer: true }), RING_TIMEOUT_MS);
    } catch (error) {
      this.#failStart(call, error);
    }
  }

  async #onAccept(event) {
    const call = this.#call;
    if (!call || call.id !== event.callId || call.direction !== "outgoing") return;
    if (this.#state.phase !== CALL_PHASE.OUTGOING || call.session) return;
    clearTimeout(call.ringTimer);

    try {
      const accept = event.accept;
      const calleeDevice = await this.#opts.directory.findDevice(call.peer.userId, accept.deviceId);
      const ok = await verifyAccept({
        accept,
        callId: call.id,
        ephCaller: call.invite.eph,
        calleeUserId: call.peer.userId,
        calleeDevice,
      });
      if (!ok) throw new HandshakeError("The answer could not be verified.");
      if (this.#isStale(call)) return;

      call.calleeDeviceId = accept.deviceId;
      call.session = await deriveCallSession({
        ephemeralPrivateKey: call.ephemeral.privateKey,
        peerEph: accept.eph,
        callId: call.id,
        ephCaller: call.invite.eph,
        ephCallee: accept.eph,
        role: "caller",
      });
      call.ephemeral = null; // forward secrecy: the private half is dropped
      this.#set({ phase: CALL_PHASE.CONNECTING, ringing: false, sas: sasEmoji(call.session.sasBytes) });
      this.#armConnectWatchdog(call);

      this.#buildPeerConnection(call);
      await this.#negotiate(call, { iceRestart: false });
    } catch (error) {
      this.#failActive(call, error);
    }
  }

  // ── incoming ─────────────────────────────────────────────────────────────
  async #onInvite(event) {
    if (this.#call) return; // the server already answers "busy" for us
    const { callId, kind, chatId, from, invite } = event;
    if (!callId || !from?.userId || !invite) return;

    const call = this.#begin({
      id: callId,
      kind: kind === "video" ? "video" : "audio",
      direction: "incoming",
      chatId,
      peer: from,
    });
    call.invite = invite;
    // Hidden until verified so a forged invitation never even rings.
    try {
      const identity = await this.#opts.getIdentity();
      const callerKeys = await this.#opts.directory.getUserDevices(from.userId, { force: true });
      const callerDevice = callerKeys.devices.find((d) => d.id === invite.deviceId) || null;
      const ok = await verifyInvite({
        invite,
        callId,
        callerUserId: from.userId,
        calleeUserId: this.#opts.selfUser.id,
        kind: call.kind,
        callerDevice,
      });
      if (!ok) throw new HandshakeError("The call invitation could not be verified.");
      if (this.#isStale(call)) return;
      call.identity = identity;
      this.#set({
        phase: CALL_PHASE.INCOMING,
        ringing: true,
        trust: callerKeys.assessment,
      });
      call.ringTimer = setTimeout(() => this.#finish(call, "missed"), RING_TIMEOUT_MS);
    } catch (error) {
      this.#api.endCall(callId, "failed").catch(() => {});
      this.#failActive(call, error, { notifyServer: false });
    }
  }

  async accept() {
    const call = this.#call;
    if (!call || this.#state.phase !== CALL_PHASE.INCOMING) return;
    clearTimeout(call.ringTimer);
    this.#set({ phase: CALL_PHASE.CONNECTING, ringing: false });

    try {
      const [localStream, iceConfig] = await Promise.all([
        this.#acquireMedia(call.kind),
        this.#api.fetchIceConfig(),
      ]);
      if (this.#isStale(call)) {
        this.#stopStream(localStream);
        return;
      }
      call.iceConfig = iceConfig;
      this.#attachLocalStream(call, localStream);

      const { ephemeral, accept } = await createAccept({
        callId: call.id,
        ephCaller: call.invite.eph,
        identity: call.identity,
      });
      call.session = await deriveCallSession({
        ephemeralPrivateKey: ephemeral.privateKey,
        peerEph: call.invite.eph,
        callId: call.id,
        ephCaller: call.invite.eph,
        ephCallee: accept.eph,
        role: "callee",
      });
      this.#set({ sas: sasEmoji(call.session.sasBytes) });
      // The peer connection must exist before the accept is posted: the
      // caller's offer can arrive immediately afterwards.
      this.#buildPeerConnection(call);
      this.#armConnectWatchdog(call);
      await this.#api.acceptCall(call.id, accept);
      this.#opts.broadcast?.postMessage({ type: "handled", callId: call.id });
    } catch (error) {
      this.#failActive(call, error);
    }
  }

  async decline() {
    const call = this.#call;
    if (!call || this.#state.phase !== CALL_PHASE.INCOMING) return;
    this.#opts.broadcast?.postMessage({ type: "handled", callId: call.id });
    this.#finish(call, "declined_local", { notifyServer: true, serverReason: "declined" });
  }

  async hangup() {
    const call = this.#call;
    if (!call || this.#state.phase === CALL_PHASE.ENDED) return;
    if (this.#state.phase === CALL_PHASE.INCOMING) return this.decline();
    this.#finish(call, call.session ? "local_hangup" : "cancelled_local", { notifyServer: true });
  }

  /** For `pagehide`: fire-and-forget hang-up that survives page teardown. */
  hangupOnUnload(beacon) {
    const call = this.#call;
    if (!call || this.#state.phase === CALL_PHASE.IDLE || this.#state.phase === CALL_PHASE.ENDED) return;
    beacon?.(call.id);
    this.#finish(call, "local_hangup", { notifyServer: false });
  }

  // ── realtime events ──────────────────────────────────────────────────────
  async handleEvent(event) {
    switch (event?.type) {
      case "call_invite":
        return this.#onInvite(event);
      case "call_accept":
        return this.#onAccept(event);
      case "call_signal":
        return this.#enqueueSignal(event);
      case "call_end":
        return this.#onServerEnd(event);
      case "call_accepted_elsewhere":
        return this.#onAcceptedElsewhere(event);
      default:
    }
  }

  /** Another tab of this browser answered or declined: stop ringing silently. */
  handleBroadcast(message) {
    const call = this.#call;
    if (message?.type === "handled" && call?.id === message.callId && this.#state.phase === CALL_PHASE.INCOMING) {
      this.#silentReset(call);
    }
  }

  #onAcceptedElsewhere(event) {
    const call = this.#call;
    if (call?.id === event.callId && this.#state.phase === CALL_PHASE.INCOMING) {
      this.#silentReset(call);
    }
  }

  #onServerEnd(event) {
    const call = this.#call;
    if (!call || call.id !== event.callId || this.#state.phase === CALL_PHASE.ENDED) return;
    if (event.by === this.#opts.selfUser.id && this.#state.phase === CALL_PHASE.INCOMING) {
      // We (another device of ours) declined it.
      this.#silentReset(call);
      return;
    }
    let reason = SERVER_END_REASONS[event.reason] || "hangup";
    if (reason === "missed" && call.direction === "outgoing") reason = "no_answer";
    this.#finish(call, reason);
  }

  // ── signaling queue ──────────────────────────────────────────────────────
  #enqueueSignal(event) {
    const call = this.#call;
    if (!call || call.id !== event.callId) return Promise.resolve();
    call.queue = call.queue.then(() => this.#onSignal(call, event)).catch(() => {});
    return call.queue;
  }

  async #onSignal(call, event) {
    if (this.#isStale(call) || !call.session) return;
    if (event.toDeviceId && event.toDeviceId !== call.identity.deviceId) return;
    const { kind, seq } = event;
    if (!(seq > (call.recvSeq[kind] ?? -1))) return; // replayed or reordered

    let payload;
    try {
      payload = await openSignal(call.session, { kind, seq, blob: event.blob });
    } catch {
      call.authFailures += 1;
      if (call.authFailures >= MAX_SIGNAL_AUTH_FAILURES) {
        this.#failActive(call, new HandshakeError("Call signaling failed authentication."));
      }
      return;
    }
    call.recvSeq[kind] = seq;

    try {
      if (kind === "offer" && call.direction === "incoming") {
        await call.pc.setRemoteDescription({ type: "offer", sdp: String(payload.sdp) });
        await this.#drainRemoteCandidates(call);
        const answer = await call.pc.createAnswer();
        const sdp = tuneOpusSdp(answer.sdp);
        await call.pc.setLocalDescription({ type: "answer", sdp });
        await this.#sendSignal(call, "answer", { type: "answer", sdp });
      } else if (kind === "answer" && call.direction === "outgoing") {
        await call.pc.setRemoteDescription({ type: "answer", sdp: String(payload.sdp) });
        await this.#drainRemoteCandidates(call);
      } else if (kind === "ice" && Array.isArray(payload.candidates)) {
        for (const candidate of payload.candidates.slice(0, 64)) {
          if (call.pc.remoteDescription) {
            await call.pc.addIceCandidate(candidate).catch(() => {});
          } else {
            call.pendingRemoteIce.push(candidate);
          }
        }
      }
    } catch (error) {
      this.#failActive(call, error);
    }
  }

  async #drainRemoteCandidates(call) {
    const pending = call.pendingRemoteIce.splice(0);
    for (const candidate of pending) {
      await call.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async #sendSignal(call, kind, payload) {
    const seq = (call.sendSeq[kind] = (call.sendSeq[kind] ?? 0) + 1);
    const blob = await sealSignal(call.session, { kind, seq, payload });
    await this.#api.sendCallSignal(call.id, { kind, blob, seq });
  }

  // ── peer connection ──────────────────────────────────────────────────────
  #buildPeerConnection(call) {
    const iceServers = call.iceConfig?.iceServers || [];
    const pc = this.#opts.createPeerConnection({
      iceServers,
      iceCandidatePoolSize: 0, // pre-gathering wakes the radio for nothing
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      // The admin can require every call to go through the relay so that
      // neither person learns the other's IP address.
      ...(call.iceConfig?.forceRelay || this.#opts.relayOnly ? { iceTransportPolicy: "relay" } : {}),
    });
    call.pc = pc;
    call.remoteStream = this.#opts.createMediaStream();
    this.#set({ remoteStream: call.remoteStream });

    // Audio and video share one transport; tracks are added from the stream
    // we captured up front.
    call.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, call.localStream);
      if (track.kind === "video") call.videoSender = sender;
    });
    if (call.kind === "video" && !call.videoSender) {
      // Camera unavailable: still receive remote video.
      const transceiver = pc.addTransceiver?.("video", { direction: "recvonly" });
      if (transceiver) call.videoSender = null;
    }
    this.#applyCodecPreferences(call);

    // Negotiated in-band channel for mute/camera state; no renegotiation and
    // no extra signaling. It rides the same encrypted DTLS transport.
    try {
      call.dc = pc.createDataChannel("aurelle", { negotiated: true, id: 0, ordered: true });
      call.dc.onopen = () => this.#sendMediaState(call);
      call.dc.onmessage = (e) => this.#onChannelMessage(call, e.data);
    } catch (_) {
      call.dc = null;
    }

    pc.ontrack = (event) => {
      if (!call.remoteStream.getTracks().includes(event.track)) {
        call.remoteStream.addTrack(event.track);
      }
      if (event.track.kind === "video") this.#set({ remoteCameraOn: true });
      this.#set({ remoteStream: call.remoteStream });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        call.iceBatch.push(
          typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate,
        );
      }
      if (!event.candidate) this.#flushIce(call);
      else if (!call.iceTimer) call.iceTimer = setTimeout(() => this.#flushIce(call), ICE_BATCH_MS);
    };

    pc.onconnectionstatechange = () => this.#onConnectionState(call);
    return pc;
  }

  #applyCodecPreferences(call) {
    try {
      const codecs = this.#opts.getVideoCodecs();
      if (!codecs?.length) return;
      const transceiver = call.pc
        .getTransceivers()
        .find((t) => t.sender === call.videoSender || t.receiver?.track?.kind === "video");
      transceiver?.setCodecPreferences?.(orderVideoCodecs(codecs));
    } catch (_) {
      // Codec preferences are an optimisation only.
    }
  }

  async #negotiate(call, { iceRestart }) {
    const offer = await call.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    const sdp = tuneOpusSdp(offer.sdp);
    await call.pc.setLocalDescription({ type: "offer", sdp });
    await this.#sendSignal(call, "offer", { type: "offer", sdp });
  }

  async #flushIce(call) {
    clearTimeout(call.iceTimer);
    call.iceTimer = null;
    if (!call.iceBatch.length || this.#isStale(call) || !call.session) return;
    const candidates = call.iceBatch.splice(0);
    try {
      await this.#sendSignal(call, "ice", { candidates });
    } catch (_) {
      // A lost batch is recovered by ICE restart if the path fails.
    }
  }

  #onConnectionState(call) {
    if (this.#isStale(call)) return;
    const state = call.pc.connectionState;
    if (state === "connected") {
      clearTimeout(call.disconnectTimer);
      clearTimeout(call.connectWatchdog);
      clearTimeout(call.failTimer);
      call.restarts = 0;
      if (this.#state.phase !== CALL_PHASE.CONNECTED) {
        this.#set({ phase: CALL_PHASE.CONNECTED, connectedAt: Date.now() });
        this.#api.markCallConnected(call.id).catch(() => {});
        this.#startStats(call);
        this.#applyVideoTier(call);
        this.#syncWakeLock(call);
      }
    } else if (state === "disconnected") {
      clearTimeout(call.disconnectTimer);
      call.disconnectTimer = setTimeout(() => this.#recoverConnection(call), DISCONNECT_GRACE_MS);
    } else if (state === "failed") {
      clearTimeout(call.disconnectTimer);
      this.#recoverConnection(call);
    }
  }

  async #recoverConnection(call) {
    if (this.#isStale(call)) return;
    // Whatever happens next, give up if the path does not come back in time.
    // The callee has nothing to do but wait for the caller's restart offer.
    clearTimeout(call.failTimer);
    call.failTimer = setTimeout(() => {
      if (!this.#isStale(call) && call.pc.connectionState !== "connected") {
        this.#finish(call, "failed", { notifyServer: true });
      }
    }, FAILED_WAIT_MS);

    if (call.direction === "outgoing" && call.restarts < MAX_ICE_RESTARTS) {
      call.restarts += 1;
      try {
        await this.#negotiate(call, { iceRestart: true });
      } catch (_) {
        // The timer above ends the call if signaling stays broken.
      }
    }
  }

  #armConnectWatchdog(call) {
    clearTimeout(call.connectWatchdog);
    call.connectWatchdog = setTimeout(() => {
      if (!this.#isStale(call) && this.#state.phase === CALL_PHASE.CONNECTING) {
        this.#finish(call, "failed", { notifyServer: true });
      }
    }, 45_000);
  }

  // ── media ────────────────────────────────────────────────────────────────
  async #acquireMedia(kind) {
    const constraints = {
      audio: CAPTURE_CONSTRAINTS.audio,
      video: kind === "video" ? CAPTURE_CONSTRAINTS.video : false,
    };
    try {
      return await this.#opts.getUserMedia(constraints);
    } catch (error) {
      const name = String(error?.name || "");
      if (name === "NotAllowedError" || name === "SecurityError") throw new MediaError("permission_denied");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new MediaError("no_device");
      throw new MediaError("failed");
    }
  }

  #attachLocalStream(call, stream) {
    call.localStream = stream;
    call.videoSuppressed = { user: false, hidden: false, network: false };
    this.#set({
      localStream: stream,
      cameraOn: stream.getVideoTracks().length > 0,
      muted: false,
    });
  }

  #stopStream(stream) {
    stream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
  }

  setMuted(muted) {
    const call = this.#call;
    if (!call?.localStream) return;
    call.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    this.#set({ muted: Boolean(muted) });
    this.#sendMediaState(call);
  }

  setCameraEnabled(enabled) {
    const call = this.#call;
    if (!call || call.kind !== "video") return;
    call.videoSuppressed.user = !enabled;
    return this.#reconcileCamera(call);
  }

  /** Called with `document.hidden`: the camera is released while backgrounded. */
  setPageHidden(hidden) {
    const call = this.#call;
    if (!call) return;
    call.pageHidden = Boolean(hidden);
    if (call.kind !== "video") return;
    call.videoSuppressed.hidden = Boolean(hidden);
    this.#syncWakeLock(call);
    return this.#reconcileCamera(call);
  }

  async #reconcileCamera(call) {
    if (this.#isStale(call) || call.kind !== "video") return;
    const s = call.videoSuppressed;
    const wanted = !s.user && !s.hidden && !s.network;
    const stream = call.localStream;
    const current = stream.getVideoTracks()[0] || null;
    try {
      if (wanted && !current) {
        const fresh = await this.#opts.getUserMedia({ audio: false, video: CAPTURE_CONSTRAINTS.video });
        if (this.#isStale(call)) return this.#stopStream(fresh);
        const track = fresh.getVideoTracks()[0];
        stream.addTrack(track);
        if (call.videoSender) await call.videoSender.replaceTrack(track);
        await this.#applyVideoTier(call);
      } else if (!wanted && current) {
        stream.removeTrack(current);
        if (call.videoSender) await call.videoSender.replaceTrack(null);
        current.stop(); // releases the camera: LED off, no capture power draw
      }
    } catch (_) {
      // Leave the camera as it is if it cannot be (re)started.
    }
    this.#set({
      cameraOn: stream.getVideoTracks().length > 0,
      networkPaused: s.network,
    });
    this.#sendMediaState(call);
  }

  async #applyVideoTier(call) {
    const sender = call.videoSender;
    if (!sender || !sender.track || typeof sender.getParameters !== "function") return;
    try {
      const params = sender.getParameters();
      const encoding = encodingForTier(this.#state.videoTier);
      params.encodings = [{ ...(params.encodings?.[0] || {}), ...encoding }];
      await sender.setParameters(params);
    } catch (_) {
      // Not all browsers accept every field; the defaults are still sane.
    }
  }

  #sendMediaState(call) {
    const dc = call.dc;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(
        JSON.stringify({
          t: "state",
          muted: this.#state.muted,
          video: call.localStream?.getVideoTracks().length > 0,
        }),
      );
    } catch (_) {}
  }

  #onChannelMessage(call, data) {
    if (this.#isStale(call) || typeof data !== "string" || data.length > 256) return;
    try {
      const msg = JSON.parse(data);
      if (msg?.t === "state") {
        this.#set({ remoteMuted: msg.muted === true, remoteCameraOn: msg.video === true });
      }
    } catch (_) {}
  }

  #startStats(call) {
    clearInterval(call.statsTimer);
    call.statsTimer = setInterval(async () => {
      if (this.#isStale(call) || call.pageHidden) return;
      try {
        const report = await call.pc.getStats();
        const sample = summarizeStats([...report.values()]);
        if (sample.relayed !== this.#state.relayed) this.#set({ relayed: sample.relayed });
        if (call.kind !== "video" || call.videoSuppressed.user || call.videoSuppressed.hidden) return;

        const { tier, state } = nextVideoTier(this.#state.videoTier, sample, call.adaptation);
        call.adaptation = state;
        if (tier !== this.#state.videoTier) {
          this.#set({ videoTier: tier });
          const shouldPause = tier === "off";
          if (shouldPause !== call.videoSuppressed.network) {
            call.videoSuppressed.network = shouldPause;
            await this.#reconcileCamera(call);
          }
          if (!shouldPause) await this.#applyVideoTier(call);
        }
      } catch (_) {}
    }, STATS_INTERVAL_MS);
  }

  async #syncWakeLock(call) {
    const needed = call.kind === "video" && this.#state.phase === CALL_PHASE.CONNECTED && !call.pageHidden;
    if (!needed) {
      call.wakeLock?.release?.().catch?.(() => {});
      call.wakeLock = null;
      return;
    }
    if (call.wakeLock) return;
    try {
      call.wakeLock = await this.#opts.requestWakeLock();
    } catch (_) {
      call.wakeLock = null;
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  #begin({ id, kind, direction, chatId, peer }) {
    clearTimeout(this.#lingerTimer);
    const call = {
      id,
      kind,
      direction,
      chatId,
      peer,
      identity: null,
      invite: null,
      ephemeral: null,
      session: null,
      iceConfig: null,
      pc: null,
      dc: null,
      localStream: null,
      remoteStream: null,
      videoSender: null,
      videoSuppressed: { user: false, hidden: false, network: false },
      adaptation: initialAdaptation(),
      calleeDeviceId: null,
      queue: Promise.resolve(),
      sendSeq: {},
      recvSeq: {},
      authFailures: 0,
      pendingRemoteIce: [],
      iceBatch: [],
      restarts: 0,
      pageHidden: false,
      done: false,
    };
    this.#call = call;
    this.#state = {
      ...idleState(),
      callId: id,
      kind,
      direction,
      chatId,
      peer,
    };
    this.#set({});
    return call;
  }

  #lingerTimer = null;

  #isStale(call) {
    return call.done || this.#call !== call;
  }

  #teardown(call) {
    call.done = true;
    [call.ringTimer, call.iceTimer, call.disconnectTimer, call.failTimer, call.connectWatchdog].forEach(clearTimeout);
    clearInterval(call.statsTimer);
    try {
      call.dc?.close();
    } catch (_) {}
    try {
      call.pc?.close();
    } catch (_) {}
    this.#stopStream(call.localStream);
    call.remoteStream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch (_) {}
    });
    call.wakeLock?.release?.().catch?.(() => {});
    call.wakeLock = null;
    call.ephemeral = null;
    call.session = null;
  }

  #finish(call, reason, { notifyServer = false, serverReason } = {}) {
    if (call.done) return;
    this.#teardown(call);
    if (notifyServer) {
      const toServer = serverReason ?? (FAILURE_REASONS.has(reason) ? "failed" : undefined);
      this.#api.endCall(call.id, toServer).catch(() => {});
    }
    this.#set({
      phase: CALL_PHASE.ENDED,
      endReason: reason,
      ringing: false,
      localStream: null,
      remoteStream: null,
      cameraOn: false,
      remoteCameraOn: false,
    });
    this.#lingerTimer = setTimeout(() => {
      if (this.#call === call) {
        this.#call = null;
        this.#state = idleState();
        this.#set({});
      }
    }, ENDED_LINGER_MS);
  }

  #silentReset(call) {
    this.#teardown(call);
    clearTimeout(this.#lingerTimer);
    this.#call = null;
    this.#state = idleState();
    this.#set({});
  }

  #failStart(call, error) {
    if (call.done) return;
    this.#failActive(call, error, { notifyServer: Boolean(call.invite) });
  }

  #failActive(call, error, { notifyServer = true } = {}) {
    if (call.done) return;
    let reason = "failed";
    if (error instanceof MediaError) reason = error.code;
    else if (error instanceof KeyMismatchError) reason = "key_mismatch";
    else if (error instanceof HandshakeError) reason = "handshake_failed";
    else if (error?.code === "busy" || error?.code === "busy_self") reason = "busy";
    else if (error?.name === "E2eeUnavailableError") reason = "e2ee_unavailable";
    else if (error?.status === 403 || error?.status === 404) reason = "failed";
    this.#finish(call, reason, { notifyServer });
    if (reason === "failed") console.warn("[calls]", error);
  }

  dispose() {
    const call = this.#call;
    if (call) this.#teardown(call);
    clearTimeout(this.#lingerTimer);
    this.#call = null;
    this.#listeners.clear();
  }

  get isBusy() {
    return Boolean(this.#call) && this.#state.phase !== CALL_PHASE.ENDED;
  }

  /** Test/diagnostic access to the trust level the UI should warn about. */
  get needsTrustWarning() {
    const status = this.#state.trust?.status;
    return status === TRUST.DEVICES_ADDED || status === TRUST.NEW;
  }
}

class MediaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class HandshakeError extends Error {
  constructor(message) {
    super(message);
    this.name = "HandshakeError";
  }
}
