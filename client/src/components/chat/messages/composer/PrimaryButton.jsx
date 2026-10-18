import "./composer.css";
import { Check, ChevronLeft, Lock, LoaderCircle, Mic, Send, Video } from "../../../../icons/lucide.js";
import { RECORD_GESTURE_CONFIG } from "./recordGesture.js";
import { useStore } from "./miniStore.js";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// The button grows while it is held. 40 px -> 52 px still fits inside the 8 px
// side gutter on a phone, so the screen edge does not cut it off.
const HOLD_SCALE = 1.3;

// One stacked layer per icon so switching between them cross-fades.
const layer = (active) =>
  `absolute inset-0 m-auto transition-all duration-200 ease-out ${
    active ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-45 opacity-0"
  }`;

function LockHandle({ progress }) {
  const { lock, cancel } = useStore(progress);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 mb-5"
      // It leaves as the finger heads for "cancel": that is no longer a lock.
      style={{ transform: `translate(-50%, ${-lock * 10}px)`, opacity: (1 - lock * 0.3) * (1 - cancel) }}
    >
      <div className="aurelle-pop-in flex w-9 flex-col items-center gap-1 rounded-full border border-emerald-200 bg-white py-2 text-emerald-700 shadow-lg dark:border-emerald-500/30 dark:bg-slate-900 dark:text-emerald-200">
        <Lock size={16} />
        <ChevronLeft size={14} className="aurelle-lock-hint rotate-90" />
      </div>
    </div>
  );
}

/**
 * The composer's one primary button, three ways:
 *  - send / save: a normal submit button;
 *  - record: tap switches voice <-> video, hold records (gestures come in via
 *    `recordProps`), release sends;
 *  - sendRecording / sending: the button that replaced the record button once a
 *    recording is locked or stopped, or while a video message is uploading.
 */
export default function PrimaryButton({
  variant,
  mode,
  holding = false,
  disabled = false,
  ariaLabel,
  recordProps,
  progress,
  onClick,
  onPointerDown,
  onMouseDown,
}) {
  const isRecord = variant === "record";
  const { dx, dy } = useStore(progress);
  const follow = holding
    ? `translate(${clamp(dx, -RECORD_GESTURE_CONFIG.cancelDistancePx, 0)}px, ${clamp(dy, -RECORD_GESTURE_CONFIG.lockDistancePx, 0)}px) scale(${HOLD_SCALE})`
    : undefined;
  return (
    <div className="relative flex shrink-0">
      {holding ? <LockHandle progress={progress} /> : null}
      <button
        type={variant === "send" || variant === "save" ? "submit" : "button"}
        disabled={disabled}
        aria-label={ariaLabel}
        data-variant={variant}
        data-record-mode={isRecord ? mode : undefined}
        onClick={isRecord ? undefined : onClick}
        onPointerDown={isRecord ? undefined : onPointerDown}
        onMouseDown={isRecord ? undefined : onMouseDown}
        onContextMenu={isRecord || holding ? (event) => event.preventDefault() : undefined}
        draggable={false}
        {...(isRecord || holding ? recordProps : null)}
        className={`aurelle-record-btn relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md shadow-emerald-500/30 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60 ${
          // While held the button follows the finger, so it must not ease behind it.
          holding
            ? "aurelle-rec-halo z-10"
            : "transition-[transform,background-color,box-shadow] duration-150"
        }`}
        style={{ transform: follow, willChange: holding ? "transform" : undefined }}
      >
        <Mic size={22} aria-hidden="true" className={layer((isRecord || holding) && mode === "voice")} />
        <Video size={22} aria-hidden="true" className={layer((isRecord || holding) && mode === "video")} />
        <Send size={20} aria-hidden="true" className={layer(variant === "send" || variant === "sendRecording")} />
        <Check size={22} aria-hidden="true" className={layer(variant === "save")} />
        <LoaderCircle
          size={20}
          aria-hidden="true"
          className={`${layer(variant === "sending")} ${variant === "sending" ? "animate-spin" : ""}`}
        />
      </button>
    </div>
  );
}
