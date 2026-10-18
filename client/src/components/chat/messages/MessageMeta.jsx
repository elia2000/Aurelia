import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock12,
  ClockFading,
  Eye,
} from "../../../icons/lucide.js";

const TONE = {
  own: "text-emerald-900/70 dark:text-emerald-50/70",
  other: "text-slate-500 dark:text-slate-400",
  overlay: "text-white",
};

const VARIANT = {
  // At the bottom corner of the bubble, over the free end of the last line.
  inline: "absolute bottom-1.5 z-1",
  // A small dark chip over the corner of a picture or video.
  overlay:
    "absolute bottom-1.5 z-1 rounded-full bg-black/50 px-1.5 py-px",
  // Its own line under a file or a voice message.
  row: "mt-0.5 flex w-full justify-end",
};

export function MessageMeta({
  variant = "inline",
  side = "right",
  tone = "other",
  timeLabel,
  isEdited = false,
  expiryBadge = null,
  status = null,
  viewsLabel = "",
}) {
  const colour = variant === "overlay" ? TONE.overlay : TONE[tone] || TONE.other;
  const place =
    variant === "row" ? "" : side === "left" ? "left-2.5" : "right-2.5";
  const overlayPlace = variant === "overlay" ? (side === "left" ? "left-1.5" : "right-1.5") : place;
  const statusColour =
    status === "failed"
      ? "text-rose-500"
      : status === "read" && variant !== "overlay"
        ? "text-sky-400"
        : "";
  return (
    <span
      data-message-meta={variant}
      data-no-select
      className={`pointer-events-none inline-flex items-center gap-1 whitespace-nowrap text-[11px] leading-[14px] ${VARIANT[variant]} ${overlayPlace} ${colour}`}
    >
      {expiryBadge ? (
        <span
          className={`inline-flex items-center gap-0.5 ${
            expiryBadge.danger && variant !== "overlay" ? "text-rose-500" : ""
          }`}
        >
          <ClockFading size={12} aria-hidden="true" />
          <span>{expiryBadge.label}</span>
        </span>
      ) : null}
      {isEdited ? <span>edited</span> : null}
      <span>{timeLabel}</span>
      {status ? (
        <span className={`inline-flex items-center gap-0.5 ${statusColour}`}>
          {status === "sending" ? (
            <>
              <Clock12
                size={14}
                strokeWidth={2.4}
                className="animate-spin"
                aria-hidden="true"
              />
              <span className="sr-only">Sending</span>
            </>
          ) : status === "failed" ? (
            <>
              <AlertCircle size={14} strokeWidth={2.4} aria-hidden="true" />
              <span className="sr-only">Failed to send</span>
            </>
          ) : status === "views" ? (
            <>
              <Eye size={13} strokeWidth={2.4} aria-hidden="true" />
              <span>{viewsLabel}</span>
              <span className="sr-only">views</span>
            </>
          ) : status === "read" ? (
            <>
              <CheckCheck size={14} strokeWidth={2.5} aria-hidden="true" />
              <span className="sr-only">Read</span>
            </>
          ) : (
            <>
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
              <span className="sr-only">Sent</span>
            </>
          )}
        </span>
      ) : null}
    </span>
  );
}
