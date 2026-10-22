import { Suspense, lazy, useCallback, useLayoutEffect, useRef, useState } from "react";
import ReactionEmoji from "./ReactionEmoji.jsx";
import { Plus } from "../../../icons/lucide.js";
import { useMessageReactions } from "../../../hooks/chat/useMessageReactions.js";
import { toggleReaction } from "../../../utils/reactionStore.js";
import { QUICK_REACTIONS } from "../../../utils/reactions.js";
import "./reactions.css";

const EmojiPicker = lazy(() => import("../emoji/EmojiPicker.jsx"));

const GAP = 6;
const EDGE = 12;
/** The space between the bar and the menu card it sits on. */
export const QUICK_BAR_GAP = GAP;

/**
 * The row of quick reactions above the message menu: seven emoji and a plus
 * that opens the whole emoji picker. The emoji I reacted with are highlighted;
 * tapping one puts it on (or takes it off) and closes the menu.
 *
 * `anchorRef` is the menu card the bar sits on and `anchorPos` ({ x, y }) where
 * its top left corner is (it is measured by size only: the card is still
 * growing in when the bar is placed); `anchorMaxHeight` is the card's height
 * limit when it had to be shortened (a short window); `measureKey` changes each time the menu
 * opens, so the bar is placed again even at the same spot. `onPickerChange(open)` lets the menu hide
 * behind the picker, and `onLeave("up" | "down")` hands the arrow keys back to
 * the menu.
 */
export default function QuickReactionBar({
  chatId,
  messageId,
  anchorRef,
  anchorPos,
  anchorMaxHeight = null,
  measureKey,
  onDone,
  onPickerChange,
  onLeave,
}) {
  const barRef = useRef(null);
  const [position, setPosition] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const mine = new Set(
    useMessageReactions(messageId)
      .filter((item) => item.reacted)
      .map((item) => item.emoji),
  );

  // Sit on top of the menu card; below it when there is no room above.
  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    const bar = barRef.current;
    if (!anchor || !bar) return;
    // offsetWidth/offsetHeight are layout sizes: unlike getBoundingClientRect
    // they ignore the scale of the opening animation.
    const cardTop = Number(anchorPos?.y) || 0;
    const cardLeft = Number(anchorPos?.x) || 0;
    const cardBottom = cardTop + anchor.offsetHeight;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    const left = Math.max(EDGE, Math.min(cardLeft, window.innerWidth - width - EDGE));
    const above = cardTop - height - GAP;
    const below = cardBottom + GAP;
    const top =
      above >= EDGE
        ? above
        : below + height + EDGE <= window.innerHeight
          ? below
          : Math.max(EDGE, above);
    setPosition({ left, top, bottom: top + height });
  }, [anchorRef, anchorPos?.x, anchorPos?.y, anchorMaxHeight, measureKey, pickerOpen]);

  const react = useCallback(
    (emoji) => {
      void toggleReaction({ chatId, messageId, emoji });
      onDone?.();
    },
    [chatId, messageId, onDone],
  );

  const setPicker = useCallback(
    (open) => {
      setPickerOpen(open);
      onPickerChange?.(open);
    },
    [onPickerChange],
  );

  const onKeyDown = (event) => {
    const buttons = [...barRef.current.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    const move = (to) => {
      event.preventDefault();
      buttons[(to + buttons.length) % buttons.length]?.focus();
    };
    // Home/End and the left/right arrows move along the row (the menu's own
    // arrow handling is skipped while focus is here).
    if (event.key === "ArrowRight") move(index + 1);
    else if (event.key === "ArrowLeft") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      onLeave?.("down");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onLeave?.("up");
    }
  };

  const hidden = !position;
  const pickerBelow = position ? position.bottom + 360 <= window.innerHeight : true;

  return (
    <>
      <div
        ref={barRef}
        role="toolbar"
        aria-label="Quick reactions"
        data-reaction-bar
        onKeyDown={onKeyDown}
        className="sb-reaction-bar fixed flex items-center gap-0.5 rounded-full border border-slate-300/80 bg-white p-1 text-slate-900 shadow-[0_10px_30px_rgba(15,23,42,0.2)] dark:border-white/10 dark:bg-slate-800 dark:text-slate-100"
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: hidden ? "hidden" : "visible",
        }}
      >
        {QUICK_REACTIONS.map((emoji) => {
          const reacted = mine.has(emoji);
          return (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              aria-pressed={reacted}
              data-quick-reaction={emoji}
              onClick={() => react(emoji)}
              className={`inline-flex h-9 w-9 max-[345px]:h-8 max-[345px]:w-8 items-center justify-center rounded-full outline-none transition duration-150 hover:scale-110 hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:bg-emerald-500/20 ${
                reacted ? "bg-emerald-100 ring-1 ring-emerald-400 dark:bg-emerald-500/25" : ""
              }`}
            >
              <ReactionEmoji emoji={emoji} size={24} />
            </button>
          );
        })}
        <button
          type="button"
          aria-label="More reactions"
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          data-quick-reaction-more
          onClick={() => setPicker(!pickerOpen)}
          className="inline-flex h-9 w-9 max-[345px]:h-8 max-[345px]:w-8 items-center justify-center rounded-full text-slate-500 outline-none transition duration-150 hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-slate-300 dark:hover:bg-emerald-500/20"
        >
          <Plus size={18} />
        </button>
      </div>
      {pickerOpen && position ? (
        <div
          data-reaction-picker
          className="fixed z-10"
          style={{
            left: Math.max(
              EDGE,
              Math.min(position.left, window.innerWidth - Math.min(336, window.innerWidth - 24) - EDGE),
            ),
            ...(pickerBelow
              ? { top: position.bottom + GAP }
              : { bottom: window.innerHeight - position.top + GAP }),
          }}
        >
          <Suspense fallback={null}>
            <EmojiPicker onSelect={react} onClose={() => setPicker(false)} autoFocusSearch={false} />
          </Suspense>
        </div>
      ) : null}
    </>
  );
}
