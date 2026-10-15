import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Lock,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Phone,
  PhoneOff,
  ShieldOff,
  Video,
  VideoOff,
  WifiOff,
} from "../../icons/lucide.js";
import Avatar from "../common/Avatar.jsx";
import SafetyNumberModal from "./SafetyNumberModal.jsx";
import { CALL_PHASE } from "../../calls/callManager.js";
import { useCalls } from "../../calls/callContext.js";
import { TRUST } from "../../e2ee/trust.js";
import { hasPersian } from "../../utils/fontUtils.js";

const END_MESSAGES = {
  hangup: "Call ended",
  local_hangup: "Call ended",
  declined: "Call declined",
  declined_local: "Call declined",
  cancelled: "Missed call",
  cancelled_local: "Call cancelled",
  missed: "Missed call",
  no_answer: "No answer",
  busy: "User is busy",
  busy_self: "You are already in a call",
  failed: "Call failed",
  clock_skew: "This device's clock looks wrong. Check the date and time.",
  relay_unavailable: "This server only allows relayed calls, but no relay is set up.",
  permission_denied: "Microphone or camera access was blocked",
  no_device: "No microphone found",
  handshake_failed: "Security check failed. The call was blocked.",
  key_mismatch: "This contact's security keys changed (a new device). The call was blocked.",
  e2ee_unavailable: "Secure calling is not available in this browser",
};

function useElapsed(since, active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !since) return undefined;
    setNow(Date.now());
    // One timer tick per second, and none while the page is in the background.
    const id = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [active, since]);
  if (!since) return "";
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return total >= 3600 ? `${Math.floor(total / 3600)}:${m}:${s}` : `${m}:${s}`;
}

function useStream(ref, stream) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== (stream || null)) el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => {});
  }, [ref, stream]);
}

function RoundButton({ label, onClick, active = false, danger = false, accept = false, children, size = "h-14 w-14" }) {
  const tone = danger
    ? "bg-rose-600 text-white hover:bg-rose-500 shadow-[0_0_14px_rgba(244,63,94,0.35)]"
    : accept
      ? "bg-emerald-500 text-white hover:bg-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.35)]"
      : active
        ? "bg-white text-slate-900 hover:bg-slate-100"
        : "bg-white/10 text-white hover:bg-white/20";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active && !danger && !accept ? true : undefined}
      title={label}
      className={`inline-flex ${size} items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${tone}`}
    >
      {children}
    </button>
  );
}

export default function CallOverlay({ user }) {
  const { state, minimized, setMinimized, accept, decline, hangup, setMuted, setCameraEnabled } = useCalls();
  const [safetyOpen, setSafetyOpen] = useState(false);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const localVideoRef = useRef(null);
  const dialogRef = useRef(null);

  const { phase, peer, kind, muted, cameraOn, remoteCameraOn, remoteMuted, sas, trust, relayed, networkPaused } = state;
  const active = phase && phase !== CALL_PHASE.IDLE;
  const connected = phase === CALL_PHASE.CONNECTED;
  const elapsed = useElapsed(state.connectedAt, connected);

  // The picture elements only exist while they are shown, so the stream is
  // handed over at the same moment they mount (a stream that never changes
  // would otherwise never be attached to an element that appears later).
  const showRemoteVideo =
    kind === "video" && remoteCameraOn && connected && !minimized;
  const showLocalVideo =
    kind === "video" && cameraOn && phase !== CALL_PHASE.ENDED && !minimized;
  useStream(remoteAudioRef, active ? state.remoteStream : null);
  useStream(remoteVideoRef, showRemoteVideo ? state.remoteStream : null);
  useStream(localVideoRef, showLocalVideo ? state.localStream : null);

  useEffect(() => {
    if (!active) setSafetyOpen(false);
  }, [active]);

  // An incoming call must not steal focus from what the person is typing:
  // pressing Space or Enter in the message box would otherwise answer it (and
  // turn the microphone on). Take focus only when nothing editable has it.
  const ringing = phase === CALL_PHASE.INCOMING;
  useEffect(() => {
    if (!ringing) return;
    const el = document.activeElement;
    const editing =
      el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
    if (!editing) dialogRef.current?.focus();
  }, [ringing]);

  if (!active || typeof document === "undefined") return null;

  const peerName = peer?.nickname || peer?.username || "Unknown";
  const fa = hasPersian(peerName) ? "font-fa" : "";
  const incoming = phase === CALL_PHASE.INCOMING;
  const ended = phase === CALL_PHASE.ENDED;

  let statusText = "";
  if (ended) statusText = END_MESSAGES[state.endReason] || "Call ended";
  else if (incoming) statusText = kind === "video" ? "Incoming video call" : "Incoming voice call";
  else if (phase === CALL_PHASE.OUTGOING) statusText = state.ringing ? "Ringing…" : "Calling…";
  else if (phase === CALL_PHASE.CONNECTING) statusText = "Connecting…";
  else if (connected) statusText = elapsed;

  const trustWarning =
    trust?.status === TRUST.DEVICES_ADDED
      ? trust.verified
        ? "This contact's safety number changed: a new device was added. Check it before you trust this call."
        : "A new device was added for this contact. Verify before sharing anything sensitive."
      : trust?.status === TRUST.NEW
        ? "First secure call with this contact. Once connected, compare the emoji code at the top with theirs."
        : "";

  const sink = (
    // Remote audio keeps playing when the call UI is minimised.
    <audio ref={remoteAudioRef} autoPlay playsInline />
  );

  if (minimized) {
    return createPortal(
      <>
        {sink}
        <div
          role="status"
          className="fixed left-1/2 z-[340] flex -translate-x-1/2 items-center gap-3 rounded-full bg-emerald-600 py-1.5 pl-4 pr-1.5 text-white shadow-lg"
          style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <Lock size={14} aria-hidden="true" />
          <span className={`max-w-[40vw] truncate text-sm font-semibold ${fa}`} dir="auto">
            {peerName}
          </span>
          <span className="text-xs tabular-nums opacity-90">{statusText}</span>
          <button
            type="button"
            onClick={() => setMinimized(false)}
            aria-label="Expand call"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/15 hover:bg-white/25"
          >
            <Maximize2 size={15} />
          </button>
          {!incoming && !ended ? (
            <button
              type="button"
              onClick={hangup}
              aria-label="End call"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-600 hover:bg-rose-500"
            >
              <PhoneOff size={15} />
            </button>
          ) : null}
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <>
      {sink}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${statusText} with ${peerName}`}
        className="fixed inset-0 z-[340] flex flex-col overflow-hidden bg-slate-950 text-slate-50 outline-none md:inset-auto md:bottom-6 md:right-6 md:h-[560px] md:w-[360px] md:rounded-3xl md:border md:border-emerald-500/30 md:shadow-2xl md:shadow-emerald-500/20"
      >
        {showRemoteVideo ? (
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div className="absolute inset-0 bg-linear-to-b from-slate-950/70 via-transparent to-slate-950/80" />

        <div
          className="relative z-10 flex items-start justify-between gap-2 px-4"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          <button
            type="button"
            onClick={() => setSafetyOpen(true)}
            disabled={!sas}
            className="inline-flex max-w-[78%] items-center gap-2 whitespace-nowrap rounded-full border border-emerald-400/40 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-emerald-200 backdrop-blur transition hover:border-emerald-300 disabled:cursor-default"
            aria-label="End-to-end encrypted. Verify security."
          >
            <Lock size={13} aria-hidden="true" />
            <span>{sas ? "Encrypted" : "End-to-end encrypted"}</span>
            {sas ? <span className="text-base leading-none tracking-wide">{sas.join("")}</span> : null}
          </button>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label="Minimise call"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          >
            <Minimize2 size={16} />
          </button>
        </div>

        {trustWarning ? (
          <p className="relative z-10 mx-4 mt-3 flex items-start gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-100">
            <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{trustWarning}</span>
            {trust?.status === TRUST.DEVICES_ADDED ? (
              <button
                type="button"
                onClick={() => setSafetyOpen(true)}
                className="shrink-0 rounded-full border border-amber-300/60 px-2 py-0.5 font-semibold hover:bg-amber-400/20"
              >
                Review
              </button>
            ) : null}
          </p>
        ) : null}

        <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {!showRemoteVideo ? (
            <Avatar
              src={peer?.avatarUrl || peer?.avatar_url}
              name={peerName}
              color={peer?.color || "#10b981"}
              className={`h-28 w-28 ${incoming || phase === CALL_PHASE.OUTGOING ? "ring-4 ring-emerald-400/40" : ""}`}
              placeholderClassName="text-4xl font-semibold text-white"
            />
          ) : null}
          <h2 className={`max-w-full truncate text-2xl font-semibold ${fa}`} dir="auto">
            {peerName}
          </h2>
          {/* Status changes are announced; the running clock is not (it would
              interrupt the call audio for screen-reader users every second). */}
          <p
            className="text-sm tabular-nums text-slate-300"
            {...(connected ? { role: "timer", "aria-live": "off" } : { "aria-live": "polite" })}
          >
            {statusText}
          </p>
          {connected && remoteMuted ? (
            <p className="text-xs text-slate-400">{peerName} is muted</p>
          ) : null}
          {connected && networkPaused ? (
            <p className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-3 py-1 text-xs text-amber-100">
              <WifiOff size={12} aria-hidden="true" /> Poor connection. Video paused to keep the call going.
            </p>
          ) : null}
          {connected && relayed ? (
            <p className="text-[11px] text-slate-500">Relayed through your server for privacy and reliability</p>
          ) : null}
        </div>

        {showLocalVideo ? (
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="absolute right-4 z-20 h-32 w-24 -scale-x-100 rounded-2xl border border-white/20 object-cover shadow-lg md:h-28 md:w-20"
            style={{ top: "calc(max(1rem, env(safe-area-inset-top)) + 3.5rem)" }}
          />
        ) : null}

        <div
          className="relative z-10 flex items-center justify-center gap-5 px-6 pt-4"
          style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        >
          {ended ? null : incoming ? (
            <>
              <RoundButton label="Decline call" danger onClick={decline}>
                <PhoneOff size={22} />
              </RoundButton>
              <RoundButton label="Accept call" accept onClick={accept}>
                {kind === "video" ? <Video size={22} /> : <Phone size={22} />}
              </RoundButton>
            </>
          ) : (
            <>
              <RoundButton label={muted ? "Unmute microphone" : "Mute microphone"} active={muted} onClick={() => setMuted(!muted)}>
                {muted ? <MicOff size={22} /> : <Mic size={22} />}
              </RoundButton>
              {kind === "video" ? (
                <RoundButton
                  label={cameraOn ? "Turn camera off" : "Turn camera on"}
                  active={!cameraOn}
                  onClick={() => setCameraEnabled(!cameraOn)}
                >
                  {cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
                </RoundButton>
              ) : null}
              <RoundButton label={phase === CALL_PHASE.OUTGOING ? "Cancel call" : "End call"} danger onClick={hangup}>
                <PhoneOff size={22} />
              </RoundButton>
            </>
          )}
        </div>
      </div>

      <SafetyNumberModal
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        chatId={state.chatId}
        selfUser={user}
        peer={peer ? { userId: peer.userId, username: peer.username, nickname: peer.nickname } : null}
        sas={sas}
      />
    </>,
    document.body,
  );
}
