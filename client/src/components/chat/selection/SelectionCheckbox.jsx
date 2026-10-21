import { Check } from "../../../icons/lucide.js";

/**
 * The round tick at the left edge of a message row (MessageItem's leadingSlot).
 *
 * - Selection mode: a circle that shows whether the row is ticked. It is only
 *   a picture; the whole row is the checkbox (role="checkbox" on the row).
 * - Otherwise, on a screen with a mouse: a button that appears while the
 *   pointer is over the row and starts selection mode with this message.
 *   It is out of the tab order; the keyboard starts selection from the
 *   message menu.
 */
export default function SelectionCheckbox({ messageKey, active, selected, onEnter }) {
  if (active) {
    return (
      <span
        aria-hidden="true"
        data-selection-box
        data-selected={selected ? "true" : "false"}
        className={`ms-3 flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 transition duration-150 ${
          selected
            ? "border-emerald-500 bg-emerald-500 text-white"
            : "border-slate-400/80 bg-white/70 dark:border-slate-500 dark:bg-slate-900/60"
        }`}
      >
        {selected ? <Check size={14} strokeWidth={3} /> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-selection-box
      data-selection-enter
      onClick={(event) => {
        event.stopPropagation();
        onEnter?.(messageKey);
      }}
      className="pointer-events-none ms-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-slate-400/80 bg-white/80 opacity-0 transition duration-150 hover:border-emerald-500 hover:bg-emerald-50 group-hover/row:pointer-events-auto group-hover/row:opacity-100 dark:border-slate-500 dark:bg-slate-900/70 dark:hover:bg-emerald-500/20"
    />
  );
}
