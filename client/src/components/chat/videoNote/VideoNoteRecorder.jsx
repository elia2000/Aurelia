import { lazy, Suspense, useEffect, useRef, useState } from "react";
import "../messages/composer/composer.css";
import { useStore } from "../messages/composer/miniStore.js";
import { LoaderCircle, Lock, Play, ShieldOff, SwitchCamera } from "../../../icons/lucide.js";
import { formatDurationMs, VIDEO_NOTE_MAX_MS } from "../../../videoNote/config.js";
import { RECORDER_PHASE } from "../../../videoNote/useVideoNoteRecorder.js";

// Only loaded when a contact's keys need reviewing.
const SafetyNumberModal = lazy(() => import("../../calls/SafetyNumberModal.jsx"));

const STROKE = 5;

/**
 * The round camera that floats above the composer while a video message is
 * recorded (and while a stopped one is reviewed): live (mirrored for the front
 * camera) preview, a red ring that fills up to the length limit, the timer, a
 * flip-camera button once the recording is locked, and, when a send was refused,
 * why, with the safety-number review for contacts whose devices changed.
 *
 * It only shows state. The gesture, the recorder and the send are in
 * useRecordingSession; `session` is what that hook returns.
 */
export default function VideoNoteRecorder({ session, isDesktop = true, chatId, selfUser }) {
  const { video, ui, videoClip, notice, actions, progress, videoElementRef } = session;
  const { phase, stream, elapsedMs, facing, cameraCount } = video;
  const { cancel } = useStore(progress);
  const reviewVideoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [reviewPeer, setReviewPeer] = useState(null);

  useEffect(() => {
    const el = videoElementRef.current;
    if (!el) return;
    el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => {});
  }, [stream, phase, videoElementRef]);

  const sending = ui.phase === "sending";
  const review = (ui.phase === "preview" || sending) && Boolean(videoClip);
  const recording = ui.phase === "recording";
  const size = isDesktop ? 240 : 220;
  const radius = size / 2 - STROKE / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = review ? 1 : Math.min(1, elapsedMs / VIDEO_NOTE_MAX_MS);
  const starting = recording && phase !== RECORDER_PHASE.RECORDING && phase !== RECORDER_PHASE.ERROR;
  const canFlip = recording && ui.locked && cameraCount > 1 && phase === RECORDER_PHASE.RECORDING;
  const shownMs = review ? videoClip.durationMs : elapsedMs;

  const togglePlayback = () => {
    const el = reviewVideoRef.current;
    if (!el || sending) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-full z-40 flex flex-col items-center gap-3 pb-4"
      data-video-note-recorder={review ? "review" : "recording"}
    >
      {notice ? (
        <div
          role="alert"
          className="pointer-events-auto w-[min(92vw,22rem)] rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg dark:border-amber-400/40 dark:bg-slate-900 dark:text-amber-100"
        >
          <p className="flex items-start gap-2">
            {notice.changes.length ? <ShieldOff size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}
            <span>{notice.error}</span>
          </p>
          {notice.changes.length ? (
            <ul className="mt-2 space-y-1.5">
              {notice.changes.map((change) => (
                <li key={change.userId} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-semibold" dir="auto">
                    {change.userId === selfUser?.id ? "Your account" : change.username || "A contact"}
                    {change.verified ? " · verified" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setReviewPeer({
                        userId: change.userId,
                        username: change.username,
                        nickname: change.userId === selfUser?.id ? "your account" : change.username,
                      })
                    }
                    className="shrink-0 rounded-full border border-amber-400/60 px-2.5 py-1 font-semibold hover:bg-amber-400/20"
                  >
                    Review
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {notice.changes.length && !notice.requiresVerification ? (
            <button
              type="button"
              onClick={actions.sendAnyway}
              className="mt-2 rounded-full bg-amber-500 px-3 py-1.5 font-semibold text-white hover:bg-amber-400"
            >
              Send anyway
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className="relative transition-[opacity,transform] duration-100"
        style={{
          width: size,
          height: size,
          maxWidth: "72vw",
          maxHeight: "72vw",
          opacity: 1 - cancel * 0.55,
          transform: `scale(${1 - cancel * 0.12})`,
        }}
      >
        <div className="aurelle-pop-in absolute inset-0">
          <div className="absolute inset-[5px] overflow-hidden rounded-full bg-slate-900 shadow-2xl shadow-black/30">
            {/* Distinct keys: a live element keeps its camera stream (srcObject), which would win over the clip. */}
            {review ? (
              <video
                key="review"
                ref={reviewVideoRef}
                src={videoClip.previewUrl}
                playsInline
                loop
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlayback}
                className="pointer-events-auto h-full w-full cursor-pointer object-cover"
              />
            ) : (
              <video
                key="live"
                ref={videoElementRef}
                playsInline
                muted
                className={`h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
              />
            )}
            {starting || sending ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/25 text-white">
                <LoaderCircle className="h-7 w-7 animate-spin" aria-label={sending ? "Sending" : "Starting camera"} />
              </div>
            ) : null}
            {review && !sending && !playing ? (
              <button
                type="button"
                onClick={togglePlayback}
                aria-label="Play preview"
                className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-black/10 text-white"
              >
                <Play size={36} className="drop-shadow" />
              </button>
            ) : null}
          </div>
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-white/70 dark:stroke-slate-700"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - ratio)}
              className={review ? "stroke-emerald-500" : "stroke-rose-500"}
              style={{ transition: "stroke-dashoffset 250ms linear" }}
            />
          </svg>
          <div className="pointer-events-none absolute -bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-semibold tabular-nums text-white shadow">
            {recording && !starting ? <span className="aurelle-rec-dot h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" /> : null}
            {formatDurationMs(shownMs)}
            <Lock size={11} className="opacity-80" aria-hidden="true" />
            <span className="sr-only">End-to-end encrypted</span>
          </div>
          {canFlip ? (
            <button
              type="button"
              onClick={actions.flipCamera}
              aria-label="Switch camera"
              className="pointer-events-auto absolute bottom-3 right-0 inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white shadow transition hover:bg-black/75"
            >
              <SwitchCamera size={20} />
            </button>
          ) : null}
        </div>
      </div>

      {reviewPeer ? (
        <Suspense fallback={null}>
          <SafetyNumberModal
            open
            onClose={() => setReviewPeer(null)}
            selfUser={selfUser}
            chatId={chatId}
            peer={reviewPeer}
            onChanged={actions.dismissNotice}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
