import { Close, Copy, Forward, Trash } from "../../../icons/lucide.js";
import { messagesLabel } from "../../../utils/batchMessages.js";

const actionClass =
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-50 sm:px-3.5";
const neutralClass = `${actionClass} border-emerald-200 bg-white/80 text-emerald-700 hover:border-emerald-300 hover:shadow-[0_0_14px_rgba(16,185,129,0.2)] dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200`;
const dangerClass = `${actionClass} border-rose-200 bg-rose-50 text-rose-600 hover:border-rose-300 hover:shadow-[0_0_14px_rgba(244,63,94,0.2)] dark:border-rose-500/30 dark:bg-rose-900/40 dark:text-rose-200`;

/**
 * The bar that takes the place of the chat header while messages are ticked:
 * how many, and what can be done with them (copy, forward, delete), and a
 * button to end selection mode. It stays in the page, hidden and out of the
 * tab order, while nothing is ticked, so the spoken "N selected" is a live
 * region that was already there when the count changes.
 */
export default function SelectionBar({
  active,
  count,
  canForward = true,
  offline = false,
  onClose,
  onCopy,
  onForward,
  onDelete,
}) {
  const forwardBlocked = offline || !canForward;
  return (
    <div
      data-selection-bar
      data-selection-count={active ? count : undefined}
      inert={!active}
      className={`absolute inset-0 z-10 flex items-center gap-2 border-b border-slate-300/80 bg-white px-3 transition duration-150 dark:border-emerald-500/20 dark:bg-slate-900 md:gap-3 md:px-6 ${
        active ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onClose}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white/80 text-emerald-700 transition hover:border-emerald-300 hover:shadow-md dark:border-emerald-500/30 dark:bg-slate-950 dark:text-emerald-200"
        aria-label="Cancel selection"
        title="Cancel selection (Esc)"
      >
        <Close size={18} />
      </button>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="min-w-0 flex-1 truncate text-base font-semibold text-slate-800 dark:text-slate-100 md:text-lg"
      >
        {active ? `${count} selected` : ""}
      </p>
      <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
        <button
          type="button"
          onClick={onCopy}
          className={neutralClass}
          aria-label="Copy selected messages"
          title="Copy (Ctrl+C)"
        >
          <Copy size={15} />
          <span className="hidden sm:inline">Copy</span>
        </button>
        <button
          type="button"
          onClick={onForward}
          // Not "disabled": a disabled button says nothing. A tap still tells why.
          aria-disabled={forwardBlocked || undefined}
          className={neutralClass}
          aria-label={`Forward ${messagesLabel(count)}`}
          title={offline ? "You're offline" : "Forward"}
        >
          <Forward size={15} />
          <span className="hidden sm:inline">Forward</span>
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-disabled={offline || undefined}
          className={dangerClass}
          aria-label={`Delete ${messagesLabel(count)}`}
          title={offline ? "You're offline" : "Delete (Del)"}
        >
          <Trash size={15} />
          <span className="hidden sm:inline">Delete</span>
        </button>
      </div>
    </div>
  );
}
