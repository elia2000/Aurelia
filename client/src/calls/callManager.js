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
  INVITE_MAX_AGE_MS,
  verifyAccept,
  verifyInvite,
  verifyReveal,
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
// A call that failed explains why on its card: leave time to read it (longer
// when there are technical details to open).
const FAILED_LINGER_MS = 10_000;
const DETAILS_LINGER_MS = 20_000;
const MAX_ICE_RESTARTS = 3;
const MAX_SIGNAL_AUTH_FAILURES = 3;
const SLOW_CONNECT_MS = 10_000;
const RINGING_REPORT_RETRY_MS = [1_000, 3_000];

const idleState = () => ({
  phase: CALL_PHASE.IDLE,
  callId: null,
  kind: "audio",
  direction: null,
  chatId: null,
  peer: null,
  ringing: false,
  waiting: false,
  sas: null,
  trust: null,
  muted: false,
  remoteMuted: false,
  cameraOn: false,
  remoteCameraOn: false,
  cameraBlocked: null,
  connectingSlow: false,
  relayCheck: null, // null (no relay in use) | "pending" | "ok" | "unreachable" | "refused"
  connectionDetails: null, // lines for the "technical details" of a call that failed to connect
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
  "clock_skew",
  "relay_unavailable",
  "connect_failed",
  "connect_failed_no_relay",
  "connect_failed_relay_unreachable",
  "connect_failed_relay_refused",
  "connection_lost",
  "key_mismatch",
  "permission_denied",
  "no_device",
  "e2ee_unavailable",
]);

/** True for an end reason that means "this did not work" (as opposed to a normal end). */
export const isFailureReason = (reason) => FAILURE_REASONS.has(reason);

const SERVER_END_REASONS = {
  declined: "declined",
  cancelled: "cancelled",
  hangup: "hangup",
  missed: "missed",
  failed: "failed",
  timeout: "failed",
  connect_failed: "connect_failed", // the other side's media never came up (or was lost)
};

// What a device tells the server when the media connection is what failed.
// Everything else that goes wrong is a plain "failed": only these reasons are
// described to the people involved as a network or relay problem.
const CONNECTION_FAILURES = new Set([
  "connect_failed",
  "connect_failed_no_relay",
  "connect_failed_relay_unreachable",
  "connect_failed_relay_refused",
  "connection_lost",
]);

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
  /**
   * @param {object} args
   * @param {"audio"|"video"} [args.kind]
   * @param {boolean} [args.camera]  false: a video call that starts with the
   *   camera off (the other person's video still shows, and the camera can be
   *   turned on at any time)
   */
  async startCall({ chatId, peer, kind = "audio", camera = true }) {
    if (this.#call) {
      // The "call ended" card lingers for a moment; a new call replaces it.
      if (this.#state.phase !== CALL_PHASE.ENDED) throw new Error("A call is already in progress.");
      this.#silentReset(this.#call);
    }
    const call = this.#begin({
      id: randomUuid(),
      kind: kind === "video" ? "video" : "audio",
      direction: "outgoing",
      chatId,
      peer,
    });
    call.cameraWanted = camera !== false;
    this.#set({ phase: CALL_PHASE.OUTGOING, ringing: false, waiting: false, trust: null });

    try {
      // The microphone/camera stream is attached to the call the moment it
      // arrives (see #acquireForCall), so it is released with the call even if
      // the permission prompt is answered after something else already failed.
      const [identity, , iceConfig] = await Promise.all([
        this.#opts.getIdentity(),
        this.#acquireForCall(call),
        this.#api.fetchIceConfig(),
      ]);
      if (this.#isStale(call)) return;
      call.identity = identity;
      call.iceConfig = iceConfig;

      // Fetching the callee's keys also runs the trust-on-first-use check.
      const peerKeys = await this.#opts.directory.getUserDevices(peer.userId, { chatId });
      if (this.#isStale(call)) return;
      this.#set({ trust: peerKeys.assessment });

      const { ephemeral, invite } = await createInvite({
        callId: call.id,
        calleeUserId: peer.userId,
        kind: call.kind,
        identity,
      });
      if (this.#isStale(call)) return;
      call.ephemeral = ephemeral;
      call.invite = invite;
      await this.#api.startCall({
        callId: call.id,
        chatId,
        kind: call.kind,
        invite,
      });
      if (this.#isStale(call)) {
        // Hung up while the request was in flight: it may have reached the
        // server after (or without) our cancel, so cancel again now that the
        // call is known there.
        this.#api.endCall(call.id).catch(() => {});
        return;
      }
      call.posted = true;
      call.deferredInvite = null; // we won; the server turned the other call away
      // The call is placed, but nobody has been reached yet: "ringing" is only
      // shown once the other person's app reports that it is ringing (their
      // phone may be offline or the app closed, in which case it only gets a
      // push notification). Their reports travel on the event stream, so the
      // ringing report (or even the answer) can beat this reply: keep what the
      // call already learned instead of starting over.
      if (this.#state.phase === CALL_PHASE.OUTGOING && !call.answered) {
        this.#set(call.ringingSeen ? { ringing: true, waiting: false } : { ringing: false, waiting: true });
        call.ringTimer = setTimeout(() => this.#finish(call, "no_answer", { notifyServer: true }), RING_TIMEOUT_MS);
      }
    } catch (error) {
      const deferred = call.deferredInvite;
      this.#failStart(call, error);
      // Both people called each other at the same moment and the other call
      // won: ring for it instead of leaving the caller with nobody to answer.
      if (deferred) this.#onInvite(deferred);
    }
  }

  #onRinging(event) {
    const call = this.#call;
    if (!call || call.id !== event.callId || call.direction !== "outgoing") return;
    call.ringingSeen = true;
    if (this.#state.phase !== CALL_PHASE.OUTGOING) return;
    this.#set({ ringing: true, waiting: false });
  }

  /**
   * The caller shows "Waiting…" until this report arrives, so a report lost to
   * a bad moment on a mobile network is tried again a couple of times while the
   * phone is still ringing. A refusal is final: asking again changes nothing.
   */
  async #reportRinging(call) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#api.markCallRinging?.(call.id);
        return;
      } catch (error) {
        const status = Number(error?.status) || 0;
        const refused = status >= 400 && status < 500 && status !== 429;
        if (refused || attempt >= RINGING_REPORT_RETRY_MS.length) return;
      }
      await new Promise((resolve) => setTimeout(resolve, RINGING_REPORT_RETRY_MS[attempt]));
      if (this.#isStale(call) || this.#state.phase !== CALL_PHASE.INCOMING) return;
    }
  }

  async #onAccept(event) {
    const call = this.#call;
    if (!call || call.id !== event.callId || call.direction !== "outgoing") return;
    if (this.#state.phase !== CALL_PHASE.OUTGOING || call.session || !call.ephemeral) return;
    call.answered = true; // (the reply to our own request may still be on its way: see startCall)
    clearTimeout(call.ringTimer);

    try {
      const accept = event.accept;
      const directory = this.#opts.directory;
      const calleeDevice = await directory.findDevice(call.peer.userId, accept.deviceId, {
        chatId: call.chatId,
      });
      const ok = await verifyAccept({
        accept,
        callId: call.id,
        invite: call.invite,
        callerUserId: this.#opts.selfUser.id,
        calleeUserId: call.peer.userId,
        kind: call.kind,
        calleeDevice,
      });
      if (!ok) throw new HandshakeError("The answer could not be verified.");
      if (this.#isStale(call)) return;

      // The answering device is one this device has never acknowledged. For a
      // person you verified that stops the call; for everybody else it is shown.
      if (calleeDevice.pending) {
        const { assessment } = await directory.getUserDevices(call.peer.userId, { chatId: call.chatId });
        if (this.#isStale(call)) return;
        if (assessment.verified) throw new KeyMismatchError(call.peer.userId, [calleeDevice.id]);
        this.#set({ trust: assessment });
      }

      const revealEph = call.ephemeral.pub;
      const session = await deriveCallSession({
        ephemeralPrivateKey: call.ephemeral.privateKey,
        peerEph: accept.eph,
        callId: call.id,
        callerUserId: this.#opts.selfUser.id,
        callerDeviceId: call.identity.deviceId,
        calleeUserId: call.peer.userId,
        calleeDeviceId: accept.deviceId,
        kind: call.kind,
        commit: call.invite.commit,
        ephCaller: revealEph,
        ephCallee: accept.eph,
        role: "caller",
      });
      if (this.#isStale(call)) return;
      call.calleeDeviceId = accept.deviceId;
      call.session = session;
      call.ephemeral = null; // forward secrecy: the private half is dropped
      this.#set({ phase: CALL_PHASE.CONNECTING, ringing: false, waiting: false, sas: sasEmoji(session.sasBytes) });
      this.#armConnectWatchdog(call);

      this.#buildPeerConnection(call);
      // The first offer also reveals the key committed to in the invite.
      await this.#negotiate(call, { iceRestart: false, reveal: revealEph });
    } catch (error) {
      this.#failActive(call, error);
    }
  }

  // ── incoming ─────────────────────────────────────────────────────────────
  async #onInvite(event) {
    const existing = this.#call;
    if (existing) {
      if (this.#state.phase === CALL_PHASE.ENDED) {
        // The previous call only lingers on screen; the line is free.
        this.#silentReset(existing);
      } else if (existing.direction === "outgoing" && !existing.posted) {
        // We are placing a call too and the server has not decided yet whose
        // call stands. Remember this one: if ours loses, we ring for it.
        existing.deferredInvite = event;
        return;
      } else {
        return; // really busy: the server already answers "busy" for us
      }
    }
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
      if (!(Math.abs(Date.now() - Number(invite.ts)) <= INVITE_MAX_AGE_MS)) {
        throw new HandshakeError("The invitation is too old or this device's clock is wrong.", "clock_skew");
      }
      const identity = await this.#opts.getIdentity();
      const callerKeys = await this.#opts.directory.getUserDevices(from.userId, { force: true, chatId });
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
      // A brand-new device claiming to be somebody you verified: refuse.
      if (callerDevice.pending && callerKeys.assessment.verified) {
        throw new KeyMismatchError(from.userId, [callerDevice.id]);
      }
      call.identity = identity;
      this.#set({
        phase: CALL_PHASE.INCOMING,
        ringing: true,
        trust: callerKeys.assessment,
      });
      call.ringTimer = setTimeout(() => this.#finish(call, "missed"), RING_TIMEOUT_MS);
      // Tell the caller this app is actually ringing (it shows "Waiting…" until then).
      this.#reportRinging(call);
    } catch (error) {
      this.#api.endCall(callId, "failed").catch(() => {});
      this.#failActive(call, error, { notifyServer: false });
    }
  }

  /** @param {{camera?: boolean}} [options]  camera: false answers a video call with the camera off */
  async accept({ camera = true } = {}) {
    const call = this.#call;
    if (!call || this.#state.phase !== CALL_PHASE.INCOMING) return;
    clearTimeout(call.ringTimer);
    call.cameraWanted = camera !== false;
    this.#set({ phase: CALL_PHASE.CONNECTING, ringing: false });

    try {
      const [, iceConfig] = await Promise.all([
        this.#acquireForCall(call),
        this.#api.fetchIceConfig(),
      ]);
      if (this.#isStale(call)) return;
      call.iceConfig = iceConfig;

      const { ephemeral, accept } = await createAccept({
        callId: call.id,
        invite: call.invite,
        callerUserId: call.peer.userId,
        calleeUserId: this.#opts.selfUser.id,
        kind: call.kind,
        identity: call.identity,
      });
      if (this.#isStale(call)) return;
      // The session keys are derived once the caller reveals the key it
      // committed to (with its first offer); until then only this is kept.
      call.ephemeral = ephemeral;
      // The peer connection must exist before the accept is posted: the
      // caller's offer can arrive immediately afterwards.
      this.#buildPeerConnection(call);
      this.#armConnectWatchdog(call);
      call.acceptPosted = true;
      await this.#api.acceptCall(call.id, accept);
      this.#opts.broadcast?.postMessage({ type: "handled", callId: call.id });
    } catch (error) {
      if (!this.#isStale(call) && (error?.code === "not_ringing" || error?.status === 409)) {
        // Another device or tab answered first (or the caller gave up). That
        // call is not ours to end: telling the server "failed" would tear down
        // the call the winner just connected.
        this.#silentReset(call);
        return;
      }
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
    // Only a call this tab is committed to is ended for everybody. A call that
    // is merely ringing here (reload, closing the tab, tapping a notification)
    // must keep ringing on the person's other devices and be picked up again
    // by the next page load, so it is dropped locally without telling the server.
    const committed = call.direction === "outgoing" || call.acceptPosted;
    if (committed) {
      beacon?.(call.id);
      this.#finish(call, "local_hangup", { notifyServer: false });
    } else {
      this.#silentReset(call);
    }
  }

  // ── realtime events ──────────────────────────────────────────────────────
  async handleEvent(event) {
    switch (event?.type) {
      case "call_invite":
        return this.#onInvite(event);
      case "call_ringing":
        return this.#onRinging(event);
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
    if (!call || call.id !== event.callId || call.direction !== "incoming") return;
    // That was this very device answering.
    if (event.deviceId && event.deviceId === call.identity?.deviceId) return;
    const phase = this.#state.phase;
    // Also while still waiting for the microphone permission prompt after
    // pressing Accept: the other device won, we have not asked the server yet.
    if (phase === CALL_PHASE.INCOMING || (phase === CALL_PHASE.CONNECTING && !call.acceptPosted)) {
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
    // The other side gave up on the media connection first (both usually
    // notice at about the same moment): explain it the same way as when we
    // notice first. Any other failure they report stays a plain "failed".
    if (reason === "connect_failed") reason = this.#connectFailureReason(call);
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
    if (this.#isStale(call)) return;
    if (event.toDeviceId && event.toDeviceId !== call.identity.deviceId) return;
    const { kind } = event;

    if (!call.session) {
      // The callee derives its keys when the caller reveals the key it
      // committed to, which comes with the first offer. Nothing before that
      // can be decrypted yet, so hold it back (bounded) until then.
      if (call.direction !== "incoming" || !call.ephemeral) return;
      if (kind !== "offer" || !event.eph) {
        if (call.deferredSignals.length < 32) call.deferredSignals.push(event);
        return;
      }
      const genuine = await verifyReveal({
        callId: call.id,
        commit: call.invite.commit,
        eph: event.eph,
      });
      if (this.#isStale(call)) return;
      if (!genuine) {
        this.#failActive(call, new HandshakeError("The caller's key does not match what it committed to."));
        return;
      }
      let session;
      try {
        session = await deriveCallSession({
          ephemeralPrivateKey: call.ephemeral.privateKey,
          peerEph: event.eph,
          callId: call.id,
          callerUserId: call.peer.userId,
          callerDeviceId: call.invite.deviceId,
          calleeUserId: this.#opts.selfUser.id,
          calleeDeviceId: call.identity.deviceId,
          kind: call.kind,
          commit: call.invite.commit,
          ephCaller: event.eph,
          ephCallee: call.ephemeral.pub,
          role: "callee",
        });
      } catch (error) {
        this.#failActive(call, new HandshakeError(String(error?.message || "Key agreement failed.")));
        return;
      }
      if (this.#isStale(call)) return;
      call.session = session;
      call.ephemeral = null; // forward secrecy: the private half is dropped
      this.#set({ sas: sasEmoji(session.sasBytes) });
      const waiting = call.deferredSignals.splice(0);
      await this.#handleSignal(call, event);
      for (const held of waiting) {
        if (this.#isStale(call)) return;
        await this.#handleSignal(call, held);
      }
      return;
    }
    await this.#handleSignal(call, event);
  }

  async #handleSignal(call, event) {
    if (this.#isStale(call) || !call.session) return;
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
        await this.#adoptOfferedVideoLine(call);
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

  /**
   * Answering a video call without a camera: the offer's video line exists now
   * but only receives. Make it two-way before answering so the camera can be
   * switched on later by swapping in a track, with no new negotiation.
   */
  async #adoptOfferedVideoLine(call) {
    if (call.kind !== "video" || call.videoSender) return;
    const line = call.pc.getTransceivers().find((t) => t.receiver?.track?.kind === "video");
    if (!line) return;
    try {
      line.direction = "sendrecv";
    } catch (_) {}
    call.videoSender = line.sender || null;
    this.#applyCodecPreferences(call);
    // The camera may already have been switched on while the offer was still
    // on its way: there was no sender to put that picture on yet.
    const track = call.localStream?.getVideoTracks()[0];
    if (track && call.videoSender) {
      try {
        await call.videoSender.replaceTrack(track);
        await this.#applyVideoTier(call);
      } catch (_) {
        // The next camera toggle tries again.
      }
    }
  }

  async #drainRemoteCandidates(call) {
    const pending = call.pendingRemoteIce.splice(0);
    for (const candidate of pending) {
      await call.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async #sendSignal(call, kind, payload, extra = {}) {
    const seq = (call.sendSeq[kind] = (call.sendSeq[kind] ?? 0) + 1);
    const blob = await sealSignal(call.session, { kind, seq, payload });
    await this.#api.sendCallSignal(call.id, { kind, blob, seq, ...extra });
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
    // What ICE found, to tell "the relay cannot be reached" from other problems.
    call.ice = { relay: {}, relayTotal: 0, errors: [], gathered: false };
    call.remoteStream = this.#opts.createMediaStream();
    this.#set({ remoteStream: call.remoteStream });

    // Audio and video share one transport; tracks are added from the stream
    // we captured up front.
    call.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, call.localStream);
      if (track.kind === "video") call.videoSender = sender;
    });
    if (call.kind === "video" && !call.videoSender && call.direction === "outgoing") {
      // Camera off (chosen or unavailable): still send and receive video, just
      // with no picture to send yet. A two-way transceiver means turning the
      // camera on later is a track swap, not a renegotiation. (The answering
      // side cannot do this up front: a browser does not attach a transceiver
      // created without a track to the offer's video line, so it configures
      // the line the offer created, see #handleSignal.)
      const transceiver = pc.addTransceiver?.("video", { direction: "sendrecv" });
      call.videoSender = transceiver?.sender || null;
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
      if (event.track.kind === "video") {
        // A remote video track exists even when the other camera is off; it
        // only carries a picture once media flows. The in-band state message
        // is what says whether their camera is on.
        if (event.track.muted !== true) this.#set({ remoteCameraOn: true });
        event.track.onunmute = () => {
          if (!this.#isStale(call)) this.#set({ remoteCameraOn: true });
        };
      }
      this.#set({ remoteStream: call.remoteStream });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const json = typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : event.candidate;
        call.iceBatch.push(json);
        this.#noteCandidate(call, event.candidate, json);
      }
      if (!event.candidate) this.#flushIce(call);
      else if (!call.iceTimer) call.iceTimer = setTimeout(() => this.#flushIce(call), ICE_BATCH_MS);
    };
    pc.onicecandidateerror = (event) => {
      const errors = call.ice.errors;
      if (errors.length < 8) {
        errors.push({
          url: String(event?.url || ""),
          code: Number(event?.errorCode) || 0,
          text: String(event?.errorText || "").slice(0, 80),
        });
      }
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== "complete") return;
      call.ice.gathered = true;
      this.#refreshRelayCheck(call);
    };

    pc.onconnectionstatechange = () => this.#onConnectionState(call);
    this.#refreshRelayCheck(call);
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

  async #negotiate(call, { iceRestart, reveal = null }) {
    const offer = await call.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (this.#isStale(call)) return;
    const sdp = tuneOpusSdp(offer.sdp);
    await call.pc.setLocalDescription({ type: "offer", sdp });
    await this.#sendSignal(call, "offer", { type: "offer", sdp }, reveal ? { eph: reveal } : {});
    if (this.#isStale(call)) return;
    // Candidates are held back until the offer (which carries the key reveal
    // the callee needs before it can read anything else) has been delivered.
    call.offerPosted = true;
    this.#flushIce(call);
  }

  async #flushIce(call) {
    clearTimeout(call.iceTimer);
    call.iceTimer = null;
    if (!call.iceBatch.length || this.#isStale(call) || !call.session) return;
    if (call.direction === "outgoing" && !call.offerPosted) return;
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
      clearTimeout(call.slowTimer);
      call.restarts = 0;
      if (this.#state.phase !== CALL_PHASE.CONNECTED) {
        this.#set({ phase: CALL_PHASE.CONNECTED, connectedAt: Date.now(), connectingSlow: false });
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
        this.#finish(call, this.#connectFailureReason(call), { notifyServer: true });
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
    clearTimeout(call.slowTimer);
    call.slowTimer = setTimeout(() => {
      if (!this.#isStale(call) && this.#state.phase === CALL_PHASE.CONNECTING) {
        this.#set({ connectingSlow: true });
      }
    }, SLOW_CONNECT_MS);
    call.connectWatchdog = setTimeout(() => {
      if (!this.#isStale(call) && this.#state.phase === CALL_PHASE.CONNECTING) {
        this.#finish(call, this.#connectFailureReason(call), { notifyServer: true });
      }
    }, 45_000);
  }

  #noteCandidate(call, candidate, json) {
    const line = String(json?.candidate || candidate?.candidate || "");
    if (!/ typ relay\b/.test(line)) return;
    // The protocol the client used to reach the relay (not the relayed leg).
    const protocol = String(candidate?.relayProtocol || /transport=(\w+)/i.exec(candidate?.url || "")?.[1] || "udp").toLowerCase();
    call.ice.relay[protocol] = (call.ice.relay[protocol] || 0) + 1;
    call.ice.relayTotal += 1;
    this.#refreshRelayCheck(call);
  }

  /** Whether a relay was needed and, once gathering is over, whether it was reachable. */
  #refreshRelayCheck(call) {
    if (this.#isStale(call)) return;
    let check = null;
    if (call.iceConfig?.hasRelay) {
      check = call.ice.relayTotal > 0 ? "ok" : call.ice.gathered ? this.#relayFailure(call) : "pending";
    }
    if (check !== this.#state.relayCheck) this.#set({ relayCheck: check });
  }

  /**
   * No relay address was obtained. An answer such as "401 Unauthorized" means the
   * relay was reached and said no (wrong secret, clocks apart); 701 or silence
   * means it could not be reached at all.
   */
  #relayFailure(call) {
    const answered = call.ice.errors.some((e) => e.code >= 300 && e.code < 700);
    return answered ? "refused" : "unreachable";
  }

  /** Short lines for the "technical details" of a call that could not connect. */
  #describeConnection(call) {
    const ice = call.ice;
    if (!ice) return null;
    const used = Object.entries(ice.relay).map(([protocol, n]) => `${protocol} ${n}`).join(", ");
    const lines = [`Relay candidates: ${ice.relayTotal}${used ? ` (${used})` : ""}`];
    ice.errors.forEach((e) => lines.push(`${e.url || "ICE"}: error ${e.code}${e.text ? ` ${e.text}` : ""}`));
    if (call.pc) lines.push(`Connection: ${call.pc.connectionState}, ICE: ${call.pc.iceConnectionState}`);
    return lines;
  }

  /**
   * Why the media connection did not come up. Two phones on different
   * networks usually need a relay; without one this is the likely reason, so
   * say so (the person who runs the server can act on it).
   */
  #connectFailureReason(call) {
    if (this.#state.phase === CALL_PHASE.CONNECTED) return "connection_lost";
    if (!call.iceConfig?.hasRelay) return "connect_failed_no_relay";
    // A relay is configured but this device never got an address on it (it is
    // blocked, or a VPN/proxy does not carry the connection to it).
    if (call.ice?.gathered && call.ice.relayTotal === 0) {
      return this.#relayFailure(call) === "refused" ? "connect_failed_relay_refused" : "connect_failed_relay_unreachable";
    }
    return "connect_failed";
  }

  // ── media ────────────────────────────────────────────────────────────────
  /**
   * Opens the microphone and, for a video call where the camera is wanted, the
   * camera. A camera that is blocked or missing must not kill the call: the
   * person joins without video instead (and is told so). Only a missing or
   * blocked MICROPHONE ends the call.
   * @returns {Promise<{stream: MediaStream, cameraBlocked: string|null}>}
   */
  async #acquireMedia(kind, wantCamera = true) {
    const wantVideo = kind === "video" && wantCamera;
    const reasonOf = (error) => {
      const name = String(error?.name || "");
      if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
      if (name === "NotFoundError" || name === "OverconstrainedError") return "no_device";
      return "failed";
    };
    try {
      const stream = await this.#opts.getUserMedia({
        audio: CAPTURE_CONSTRAINTS.audio,
        video: wantVideo ? CAPTURE_CONSTRAINTS.video : false,
      });
      return { stream, cameraBlocked: null };
    } catch (error) {
      const reason = reasonOf(error);
      if (wantVideo) {
        try {
          const stream = await this.#opts.getUserMedia({ audio: CAPTURE_CONSTRAINTS.audio, video: false });
          return { stream, cameraBlocked: reason };
        } catch (audioError) {
          throw new MediaError(reasonOf(audioError));
        }
      }
      throw new MediaError(reason);
    }
  }

  /**
   * Asks for the microphone/camera and hands the stream to `call` the moment it
   * arrives. The permission prompt can stay open while something else (ICE
   * config, device registration) fails and ends the call; attaching on arrival
   * means the call's teardown stops the stream, and a stream that arrives after
   * the call is gone is stopped here, so nothing keeps recording.
   */
  #acquireForCall(call) {
    return this.#acquireMedia(call.kind, call.cameraWanted !== false).then(({ stream, cameraBlocked }) => {
      if (this.#isStale(call)) {
        this.#stopStream(stream);
        return null;
      }
      call.cameraBlocked = cameraBlocked;
      this.#attachLocalStream(call, stream);
      return stream;
    });
  }

  #attachLocalStream(call, stream) {
    call.localStream = stream;
    // A video call that rings while the page is hidden must not turn the
    // camera on for the person who is not even looking.
    // A video call can start with the camera off (chosen, or blocked/missing);
    // it stays a video call, so the camera can be turned on later.
    call.videoSuppressed = {
      user: call.kind === "video" && (call.cameraWanted === false || Boolean(call.cameraBlocked)),
      hidden: Boolean(call.pageHidden),
      network: false,
    };
    this.#set({
      localStream: stream,
      cameraOn: stream.getVideoTracks().length > 0,
      cameraBlocked: call.cameraBlocked || null,
      muted: false,
    });
    if (call.kind === "video" && call.pageHidden) this.#reconcileCamera(call);
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

  // Camera changes run one at a time, and each one re-reads what is wanted
  // after every await: hiding the page, toggling the camera or ending the call
  // while a camera is still starting must win over the request that started it.
  #reconcileCamera(call) {
    call.cameraChain = (call.cameraChain || Promise.resolve())
      .then(() => this.#reconcileCameraNow(call))
      .catch(() => {});
    return call.cameraChain;
  }

  async #reconcileCameraNow(call) {
    if (this.#isStale(call) || call.kind !== "video" || !call.localStream) return;
    const s = call.videoSuppressed;
    const wanted = () => !s.user && !s.hidden && !s.network;
    const stream = call.localStream;
    const current = stream.getVideoTracks()[0] || null;
    try {
      if (wanted() && !current) {
        const fresh = await this.#opts.getUserMedia({ audio: false, video: CAPTURE_CONSTRAINTS.video });
        if (this.#isStale(call) || !wanted()) {
          this.#stopStream(fresh);
        } else {
          const track = fresh.getVideoTracks()[0];
          stream.addTrack(track);
          if (call.videoSender) await call.videoSender.replaceTrack(track);
          call.cameraBlocked = null;
          await this.#applyVideoTier(call);
        }
      } else if (!wanted() && current) {
        stream.removeTrack(current);
        if (call.videoSender) await call.videoSender.replaceTrack(null);
        current.stop(); // releases the camera: LED off, no capture power draw
      }
    } catch (error) {
      // Leave the camera as it is if it cannot be (re)started, and say why.
      const name = String(error?.name || "");
      call.cameraBlocked =
        name === "NotAllowedError" || name === "SecurityError"
          ? "permission_denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "no_device"
            : "failed";
    }
    if (this.#isStale(call)) return;
    this.#set({
      cameraOn: stream.getVideoTracks().length > 0,
      cameraBlocked: call.cameraBlocked || null,
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

  #wakeLockNeeded(call) {
    return call.kind === "video" && this.#state.phase === CALL_PHASE.CONNECTED && !call.pageHidden && !this.#isStale(call);
  }

  async #syncWakeLock(call) {
    if (!this.#wakeLockNeeded(call)) {
      call.wakeLock?.release?.().catch?.(() => {});
      call.wakeLock = null;
      return;
    }
    if (call.wakeLock || call.wakeLockPending) return;
    call.wakeLockPending = true;
    try {
      const lock = await this.#opts.requestWakeLock();
      if (this.#wakeLockNeeded(call)) {
        call.wakeLock = lock;
      } else {
        // Hung up (or hidden) while the request was pending: do not keep the
        // screen awake for a call that no longer exists.
        lock?.release?.().catch?.(() => {});
      }
    } catch (_) {
      call.wakeLock = null;
    } finally {
      call.wakeLockPending = false;
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
      deferredSignals: [],
      deferredInvite: null,
      cameraChain: null,
      posted: false,
      acceptPosted: false,
      offerPosted: false,
      wakeLockPending: false,
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
    [call.ringTimer, call.iceTimer, call.disconnectTimer, call.failTimer, call.connectWatchdog, call.slowTimer].forEach(clearTimeout);
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
    const connectionDetails = CONNECTION_FAILURES.has(reason) ? this.#describeConnection(call) : null;
    this.#teardown(call);
    if (notifyServer) {
      const toServer =
        serverReason ??
        (CONNECTION_FAILURES.has(reason) ? "connect_failed" : FAILURE_REASONS.has(reason) ? "failed" : undefined);
      this.#api.endCall(call.id, toServer).catch(() => {});
    }
    this.#set({
      phase: CALL_PHASE.ENDED,
      endReason: reason,
      ringing: false,
      waiting: false,
      connectingSlow: false,
      relayCheck: null,
      connectionDetails,
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
    }, connectionDetails?.length ? DETAILS_LINGER_MS : FAILURE_REASONS.has(reason) ? FAILED_LINGER_MS : ENDED_LINGER_MS);
  }

  /** Closes the "call ended" card right away (it also closes by itself). */
  dismiss() {
    const call = this.#call;
    if (!call || this.#state.phase !== CALL_PHASE.ENDED) return;
    this.#silentReset(call);
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
    else if (error instanceof HandshakeError) reason = error.reason;
    else if (error?.code === "busy") reason = "busy";
    else if (error?.code === "busy_self") reason = "busy_self";
    else if (error?.code === "relay_unavailable") reason = "relay_unavailable";
    else if (error?.name === "E2eeUnavailableError") reason = "e2ee_unavailable";
    else if (error?.status === 403 || error?.status === 404) reason = "failed";
    // A call that was up and then broke (a renegotiation refused because the
    // other side just hung up, say) lost its connection. Before that, a generic
    // error stays a plain failure: it says nothing about the network.
    const generic = reason === "failed";
    if (generic && this.#state.phase === CALL_PHASE.CONNECTED) reason = "connection_lost";
    this.#finish(call, reason, { notifyServer });
    if (generic) console.warn("[calls]", error);
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
  constructor(message, reason = "handshake_failed") {
    super(message);
    this.name = "HandshakeError";
    this.reason = reason;
  }
}
