import { useEffect, useMemo, useRef, useState } from "react";
import "./composer.css";
import { ChevronLeft, Pause, Play, Square, Trash, Video } from "../../../../icons/lucide.js";
import { useRecorderSnapshot } from "../../../../hooks/chat/useVoiceRecorder.js";
import { useStore } from "./miniStore.js";
import { RECORD_GESTURE_CONFIG } from "./recordGesture.js";
import { formatClock, formatRecordingTime } from "./recordPrefs.js";

const BAR =
  "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[20px] border border-emerald-200 bg-white px-1.5 text-slate-700 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-slate-100";

const ROUND_BUTTON =
  "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition after:absolute after:-inset-0.5 after:content-['']";

function DeleteButton({ onClick, disabled = false, label = "Delete recording" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`${ROUND_BUTTON} text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:text-rose-300 dark:hover:bg-rose-500/10`}
    >
      <Trash size={20} />
    </button>
  );
}

function Levels({ levels, count = 28, className = "" }) {
  const bars = useMemo(() => {
    const out = new Array(count).fill(0);
    const offset = Math.max(0, count - levels.length);
    for (let i = 0; i < count; i += 1) out[i] = i < offset ? 0 : levels[i - offset] || 0;
    return out;
  }, [levels, count]);
  return (
    <div className={`flex h-7 items-center justify-end gap-[2px] ${className}`} aria-hidden="true">
      {bars.map((level, index) => (
        <span
          key={index}
          className="w-[3px] rounded-full bg-emerald-500/80 transition-[height] duration-75"
          style={{ height: `${Math.max(3, Math.round(3 + level * 22))}px` }}
        />
      ))}
    </div>
  );
}

// The red dot that turns into a trash can as the finger nears "cancel".
function Indicator({ cancel }) {
  return cancel > 0.55 ? (
    <Trash size={18} className="shrink-0 text-rose-500" aria-hidden="true" />
  ) : (
    <span className="aurelle-rec-dot h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
  );
}

function HoldHint({ progress }) {
  const { dx, cancel } = useStore(progress);
  const shift = Math.max(-RECORD_GESTURE_CONFIG.cancelDistancePx, Math.min(0, dx));
  return (
    <span
      className="flex min-w-0 flex-1 items-center justify-center gap-1 text-sm text-slate-500 dark:text-slate-400"
      style={{ transform: `translateX(${shift * 0.6}px)`, opacity: 1 - cancel * 0.9 }}
    >
      <ChevronLeft size={16} className="aurelle-slide-hint shrink-0" aria-hidden="true" />
      <span className="truncate">Slide to cancel</span>
    </span>
  );
}

/**
 * Replaces the input while a voice or video message is recorded.
 *  - held: red dot + timer + "Slide to cancel" (moves and fades with the finger);
 *  - locked: delete, timer, live level bars (voice) or a label (video), stop.
 */
export function RecordingBar({ kind, locked, voice, elapsedMs = 0, progress, onDelete, onStop }) {
  const voiceState = useRecorderSnapshot(voice);
  const { cancel } = useStore(progress);
  const ms = kind === "voice" ? voiceState.elapsedMs : elapsedMs;
  const time = (
    <span className="w-14 shrink-0 text-sm font-semibold tabular-nums text-slate-700 dark:text-slate-100">
      {formatRecordingTime(ms)}
    </span>
  );
  if (!locked) {
    return (
      <div className={`${BAR} pl-3`} data-recording={kind}>
        <Indicator cancel={cancel} />
        {time}
        <HoldHint progress={progress} />
      </div>
    );
  }
  return (
    <div className={BAR} data-recording={kind} data-locked="true">
      <DeleteButton onClick={onDelete} />
      <span className="aurelle-rec-dot h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
      {time}
      {kind === "voice" ? (
        <Levels levels={voiceState.levels} className="min-w-0 flex-1 overflow-hidden" />
      ) : (
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 truncate text-xs text-slate-500 dark:text-slate-400">
          <Video size={14} aria-hidden="true" /> Video message
        </span>
      )}
      <button
        type="button"
        onClick={onStop}
        aria-label="Stop recording"
        className={`${ROUND_BUTTON} text-emerald-700 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-500/10`}
      >
        <Square size={16} fill="currentColor" />
      </button>
    </div>
  );
}

// Resamples the recorded levels to a fixed number of bars.
function resample(levels, count) {
  if (!levels.length) return new Array(count).fill(0.12);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor((i / count) * levels.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * levels.length));
    let peak = 0;
    for (let j = from; j < to && j < levels.length; j += 1) peak = Math.max(peak, levels[j]);
    out.push(peak);
  }
  return out;
}

/**
 * After Stop on a locked recording: play it back before sending.
 * Voice: play/pause + waveform with progress. Video: a label (the round
 * preview itself plays above the composer).
 */
export function PreviewBar({ kind, voicePreview, durationMs = 0, busy = false, onDelete }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const total = kind === "voice" ? voicePreview?.durationMs || durationMs : durationMs;
  const bars = useMemo(
    () => resample(kind === "voice" ? voicePreview?.levels || [] : [], 36),
    [kind, voicePreview],
  );

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause?.();
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const seek = (event) => {
    const audio = audioRef.current;
    if (!audio || !total) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    audio.currentTime = (ratio * total) / 1000;
    setPosition(ratio * total);
  };

  if (kind === "video") {
    return (
      <div className={BAR} data-preview="video">
        <DeleteButton onClick={onDelete} disabled={busy} />
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold">
          <Video size={16} className="shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
          Video message
        </span>
        <span className="pr-2 text-sm tabular-nums text-slate-500 dark:text-slate-400">{formatClock(total)}</span>
      </div>
    );
  }

  const progress = total ? Math.min(1, position / total) : 0;
  return (
    <div className={BAR} data-preview="voice">
      <DeleteButton onClick={onDelete} disabled={busy} />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause preview" : "Play preview"}
        className={`${ROUND_BUTTON} bg-emerald-500 text-white hover:bg-emerald-400`}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="translate-x-px" />}
      </button>
      <div
        className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
        onClick={seek}
        role="presentation"
      >
        {bars.map((level, index) => (
          <span
            key={index}
            className={`min-w-0 flex-1 rounded-full ${
              index / bars.length < progress ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600"
            }`}
            style={{ height: `${Math.max(3, Math.round(3 + level * 22))}px` }}
          />
        ))}
      </div>
      <span className="w-10 shrink-0 pr-1 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {formatClock(playing || position ? position : total)}
      </span>
      {voicePreview?.url ? (
        <audio
          ref={audioRef}
          src={voicePreview.url}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime * 1000)}
        />
      ) : null}
    </div>
  );
}
