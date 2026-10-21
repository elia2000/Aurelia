import { hasPersian } from "../../../utils/fontUtils.js";

const CHIP_CLASS =
  "inline-flex max-w-full items-center justify-center rounded-full border border-emerald-200/60 bg-white/90 px-2.5 py-0.5 text-center text-[11px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200";

/**
 * The centered line for a service event ("Ada joined the group", "Ada pinned
 * a message"). An event that points at a message (`jumpToMessageId`) is a
 * button that takes the reader there.
 */
export default function ServiceChip({ event, onJump = null }) {
  const jumpId = event?.jumpToMessageId || null;
  const label = (
    <span className="min-w-0 truncate">
      <span
        className={`min-w-0 truncate ${
          hasPersian(event?.name) ? "font-fa sb-fa-baseline-fix" : ""
        }`}
        dir="auto"
        style={{ unicodeBidi: "isolate" }}
      >
        {event?.name || "A member"}
      </span>{" "}
      <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
        {event?.suffix || ""}
      </span>
    </span>
  );

  if (!jumpId || typeof onJump !== "function") {
    return (
      <span className={CHIP_CLASS} style={{ lineHeight: 1.35 }}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onJump(jumpId)}
      aria-label={`${event?.text || "Pinned message"}. Go to the message`}
      className={`${CHIP_CLASS} cursor-pointer transition hover:border-emerald-300 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:hover:bg-emerald-500/10`}
      style={{ lineHeight: 1.35 }}
    >
      {label}
    </button>
  );
}
