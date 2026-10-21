import { useState } from "react";
import ContextMenuSurface from "../../context-menu/ContextMenuSurface.jsx";
import { Close } from "../../../icons/lucide.js";
import { hasPersian } from "../../../utils/fontUtils.js";
import {
  barIndexAfterChange,
  barSegments,
  clampBarIndex,
  nextBarIndex,
  pinBarTitle,
  pinPreview,
} from "../../../utils/messagePins.js";

/** The height of the bar; the floating day chip sits below it. */
export const PINNED_BAR_HEIGHT_PX = 48;

/**
 * The bar under the chat header that shows a pinned message (Telegram style):
 * an accent line on the left (one segment per pin when there are several), the
 * title with the pin's number, and a one-line preview with the sender. A click
 * goes to the shown message and then moves on to the next older pin. Where the
 * person may unpin, a button on the right unpins the shown message (with
 * several pins it opens the menu: unpin this one, or all of them).
 *
 * @param {object} props
 * @param {Array} props.pins the pins of the chat, newest first (hidden when empty)
 * @param {boolean} [props.canManage] may the person unpin
 * @param {boolean} [props.offline]
 * @param {(messageId: string) => void} props.onJump goes to a message
 * @param {(messageId: string) => void} [props.onUnpin]
 * @param {() => void} [props.onUnpinAll]
 * @param {(request: object) => void} [props.onOpenContextMenu] the app's menu
 */
export default function PinnedMessageBar({
  pins,
  canManage = false,
  offline = false,
  onJump,
  onUnpin,
  onUnpinAll,
  onOpenContextMenu,
}) {
  // Which pin is shown. It follows the list: a new pin shows at once, and the
  // bar stays on its message when another pin goes away.
  const [view, setView] = useState({ pins, index: 0 });
  let index = view.index;
  if (view.pins !== pins) {
    index = barIndexAfterChange({ previous: view.pins, next: pins, index: view.index });
    setView({ pins, index });
  }

  const count = pins.length;
  if (!count) return null;
  const current = clampBarIndex(index, count);
  const pin = pins[current];
  const preview = pinPreview(pin);
  const segments = barSegments({ index: current, count });
  const textHasPersian = hasPersian(preview.text);

  const menuData = {
    pin,
    count,
    canManage,
    offline,
    onGoTo: () => onJump?.(pin.messageId),
    onUnpin: () => onUnpin?.(pin.messageId),
    onUnpinAll: () => onUnpinAll?.(),
  };
  const openMenu = ({ event, targetEl }) =>
    onOpenContextMenu?.({ kind: "pinbar", event, targetEl, data: menuData });
  const isTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px) and (pointer: coarse)").matches;

  const go = () => {
    onJump?.(pin.messageId);
    setView({ pins, index: nextBarIndex(current, count) });
  };

  return (
    <div
      role="region"
      aria-label="Pinned messages"
      data-pinned-bar
      className="flex shrink-0 items-stretch border-b border-slate-300/80 bg-white dark:border-emerald-500/20 dark:bg-slate-900"
      style={{ height: `${PINNED_BAR_HEIGHT_PX}px` }}
    >
      <ContextMenuSurface
        as="button"
        type="button"
        onClick={go}
        aria-label={`${pinBarTitle(current, count)}: ${preview.sender ? `${preview.sender}, ` : ""}${preview.text}. Go to the message`}
        contextMenu={{ isMobile: isTouch, disabled: !onOpenContextMenu, onOpen: openMenu }}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1.5 ps-4 pe-2 text-start transition hover:bg-emerald-50/70 focus-visible:bg-emerald-50 focus-visible:outline-hidden dark:hover:bg-emerald-500/10 dark:focus-visible:bg-emerald-500/10"
      >
        <span
          aria-hidden="true"
          data-pinned-segments={segments.length || undefined}
          className="flex h-full w-[3px] shrink-0 flex-col gap-0.5"
        >
          {segments.length ? (
            segments.map((segment, i) => (
              <span
                key={i}
                data-active={segment.active ? "true" : undefined}
                className={`min-h-0 flex-1 rounded-full transition-colors ${
                  segment.active
                    ? "bg-emerald-500 dark:bg-emerald-400"
                    : "bg-emerald-500/25 dark:bg-emerald-400/25"
                }`}
              />
            ))
          ) : (
            <span className="min-h-0 flex-1 rounded-full bg-emerald-500 dark:bg-emerald-400" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate text-xs font-semibold leading-tight text-emerald-600 dark:text-emerald-300">
            {pinBarTitle(current, count)}
          </span>
          {/* The line hugs the start of the bar like the title above it. Its own
              direction follows the text (an inline box as wide as its content,
              so it is not pushed to the far side), and a long line is cut at
              its end by the ellipsis. */}
          <span className="block min-w-0 text-sm leading-tight text-slate-600 dark:text-slate-300">
            <span
              className={`inline-block max-w-full truncate align-top ${
                textHasPersian ? "font-fa" : ""
              }`}
              dir="auto"
              style={{ unicodeBidi: "plaintext" }}
            >
              {preview.sender ? (
                <span className="font-semibold text-slate-800 dark:text-slate-100">
                  {preview.sender}
                  {": "}
                </span>
              ) : null}
              {preview.text}
            </span>
          </span>
        </span>
      </ContextMenuSurface>
      {canManage ? (
        <button
          type="button"
          disabled={offline}
          aria-label={count > 1 ? "Unpin options" : "Unpin message"}
          aria-haspopup={count > 1 ? "menu" : undefined}
          onClick={(event) => {
            if (count > 1) {
              openMenu({ event, targetEl: event.currentTarget });
              return;
            }
            onUnpin?.(pin.messageId);
          }}
          className="inline-flex w-11 shrink-0 items-center justify-center text-slate-500 transition hover:text-rose-600 focus-visible:text-rose-600 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:text-rose-300 dark:focus-visible:text-rose-300"
        >
          <Close size={18} />
        </button>
      ) : null}
    </div>
  );
}
