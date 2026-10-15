import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../../hooks/useFocusTrap.js";
import { Camera, Close, Lock, Play, Send, Square, SwitchCamera, RotateCcw, LoaderCircle } from "../../../icons/lucide.js";
import { formatDurationMs, VIDEO_NOTE_MAX_MS } from "../../../videoNote/config.js";
import { RECORDER_PHASE, useVideoNoteRecorder } from "../../../videoNote/useVideoNoteRecorder.js";

const SIZE = 256;
const STROKE = 6;
const RADIUS = SIZE / 2 - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const formatBytes = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;

/**
 * Recorder for round video messages. The clip is only handed to `onSend` (which
 * encrypts it) when the user presses send; nothing leaves the device before.
 */
export default function VideoNoteRecorder({ open, onClose, onSend, busy = false }) {
  const dialogRef = useRef(null);
  const liveVideoRef = useRef(null);
  const reviewVideoRef = useRef(null);
  useFocusTrap(dialogRef, open);

  const recorder = useVideoNoteRecorder({ open, videoElementRef: liveVideoRef });
  const { phase, stream, elapsedMs, result, error, facing } = recorder;

  useEffect(() => {
    const el = liveVideoRef.current;
    if (!el) return;
    el.srcObject = stream || null;
    if (stream) el.play?.().catch(() => {});
  }, [stream, phase]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape" && !busy) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  if (!open || typeof document === "undefined") return null;

  const recording = phase === RECORDER_PHASE.RECORDING;
  const review = phase === RECORDER_PHASE.REVIEW;
  const progress = Math.min(1, elapsedMs / VIDEO_NOTE_MAX_MS);
  const ringOffset = CIRCUMFERENCE * (1 - (review ? 0 : progress));

  const send = async () => {
    if (!result || busy) return;
    const owned = recorder.release();
    if (!owned) return;
    const accepted = await onSend?.(owned);
    if (accepted === false) {
      // Sending was refused (e.g. nobody can decrypt yet): keep the clip.
      recorder.retake();
    }
  };

  const toggleReviewPlayback = () => {
    const el = reviewVideoRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  return createPortal(
    <div className="fixed inset-0 z-320 flex items-center justify-center bg-black/40 px-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-note-title"
        className="w-full max-w-sm rounded-2xl border border-slate-100 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 id="video-note-title" className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Video message
            </h3>
            <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-300">
              <Lock size={12} aria-hidden="true" /> End-to-end encrypted
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:border-slate-300 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
          >
            <Close size={16} />
          </button>
        </div>

        <div className="mt-5 flex justify-center">
          <div className="relative" style={{ width: SIZE, height: SIZE, maxWidth: "70vw", maxHeight: "70vw" }}>
            <div className="absolute inset-[6px] overflow-hidden rounded-full bg-slate-900">
              {review && result ? (
                <video
                  ref={reviewVideoRef}
                  src={result.previewUrl}
                  playsInline
                  loop
                  onClick={toggleReviewPlayback}
                  className="h-full w-full cursor-pointer object-cover"
                />
              ) : (
                <video
                  ref={liveVideoRef}
                  playsInline
                  muted
                  className={`h-full w-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
                />
              )}
              {phase === RECORDER_PHASE.STARTING ? (
                <div className="absolute inset-0 flex items-center justify-center text-emerald-300">
                  <LoaderCircle className="h-7 w-7 animate-spin" />
                </div>
              ) : null}
              {review ? (
                <button
                  type="button"
                  onClick={toggleReviewPlayback}
                  aria-label="Play preview"
                  className="absolute inset-0 flex items-center justify-center bg-black/10 text-white opacity-90"
                >
                  <Play size={34} className="drop-shadow" />
                </button>
              ) : null}
            </div>
            <svg
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
              aria-hidden="true"
            >
              <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-slate-200 dark:stroke-slate-800" />
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={ringOffset}
                className={review ? "stroke-emerald-500" : "stroke-rose-500"}
                style={{ transition: "stroke-dashoffset 250ms linear" }}
              />
            </svg>
          </div>
        </div>

        <p className="mt-3 text-center text-sm tabular-nums text-slate-600 dark:text-slate-300" aria-live="polite">
          {recording || review
            ? `${formatDurationMs(elapsedMs)}${review && result ? ` · ${formatBytes(result.blob.size)}` : ` / ${formatDurationMs(VIDEO_NOTE_MAX_MS)}`}`
            : "Tap the red button to start"}
        </p>
        {error ? (
          <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-center text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-900/30 dark:text-rose-200" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-center gap-4">
          {review ? (
            <>
              <button
                type="button"
                onClick={recorder.retake}
                disabled={busy}
                aria-label="Record again"
                className="inline-flex h-12 items-center gap-2 rounded-full border border-emerald-200 bg-white px-4 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:shadow-[0_0_14px_rgba(16,185,129,0.2)] disabled:opacity-50 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
              >
                <RotateCcw size={16} /> Retake
              </button>
              <button
                type="button"
                onClick={send}
                disabled={busy}
                aria-label="Send video message"
                className="inline-flex h-12 items-center gap-2 rounded-full bg-emerald-500 px-5 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send size={16} />} Send
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={recorder.switchCamera}
                disabled={phase !== RECORDER_PHASE.PREVIEW}
                aria-label="Switch camera"
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 text-slate-600 transition hover:border-slate-300 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300"
              >
                <SwitchCamera size={18} />
              </button>
              <button
                type="button"
                onClick={recording ? recorder.stopRecording : recorder.startRecording}
                disabled={phase !== RECORDER_PHASE.PREVIEW && !recording}
                aria-label={recording ? "Stop recording" : "Start recording"}
                className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/30 transition hover:bg-rose-400 disabled:opacity-40"
              >
                {recording ? <Square size={22} fill="currentColor" /> : <Camera size={24} />}
              </button>
              <span className="w-11" aria-hidden="true" />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
