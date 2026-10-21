import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactionEmoji from "./ReactionEmoji.jsx";
import ReactorsPopover from "./ReactorsPopover.jsx";
import { useMessageReactions } from "../../../hooks/chat/useMessageReactions.js";
import { swallowReleaseClick } from "../../../hooks/useContextMenuTrigger.js";
import { toggleReaction } from "../../../utils/reactionStore.js";
import { SHOW_REACTORS_EVENT, reactionAriaLabel } from "../../../utils/reactions.js";
import { keepAtBottomAfterGrowth } from "../../../utils/stickToBottom.js";
import { normalizeUuid } from "../../../utils/uuidUtils.js";
import "./reactions.css";

const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 8;

const isMenuKey = (event) =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/**
 * Which chips just appeared or grew, so they can pop. Chips that were there
 * when the message was first drawn do not: a chat opening is not an event.
 * Derived while rendering (React's "previous value" pattern), no effect needed.
 */
function usePops(list) {
  const [seen, setSeen] = useState(() => ({
    list,
    counts: Object.fromEntries(list.map((item) => [item.emoji, item.count])),
    pops: {},
  }));
  if (seen.list === list) return seen.pops;
  const pops = { ...seen.pops };
  const counts = {};
  for (const item of list) {
    counts[item.emoji] = item.count;
    const before = seen.counts[item.emoji];
    if (before === undefined || item.count > before) pops[item.emoji] = (pops[item.emoji] || 0) + 1;
  }
  setSeen({ list, counts, pops });
  return pops;
}

function Chip({ item, pop, canList, onToggle, onShowReactors }) {
  const press = useRef({ timer: 0, x: 0, y: 0, fired: false });

  const cancelPress = () => {
    window.clearTimeout(press.current.timer);
    press.current.timer = 0;
  };
  useEffect(() => cancelPress, []);

  const handlers = {
    onPointerDown: (event) => {
      const state = press.current;
      cancelPress();
      state.fired = false;
      // A held finger (or pen) opens the list; the mouse uses the right button.
      if (!canList || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
      const chip = event.currentTarget;
      state.x = event.clientX;
      state.y = event.clientY;
      state.timer = window.setTimeout(() => {
        state.timer = 0;
        state.fired = true;
        // The finger is still down: the click that ends the hold lands on the
        // list's backdrop and would close it again.
        swallowReleaseClick(chip);
        onShowReactors(item.emoji, chip);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const state = press.current;
      if (!state.timer) return;
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > LONG_PRESS_MOVE_PX) {
        cancelPress();
      }
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClick: (event) => {
      // The click that ends a long press is not a tap.
      if (press.current.fired) {
        press.current.fired = false;
        event.preventDefault();
        return;
      }
      onToggle(item.emoji);
    },
    onContextMenu: (event) => {
      if (!canList) return; // the message menu opens instead
      event.preventDefault();
      event.stopPropagation();
      cancelPress();
      onShowReactors(item.emoji, event.currentTarget);
    },
    onKeyDown: (event) => {
      if (!canList || !isMenuKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onShowReactors(item.emoji, event.currentTarget);
    },
  };

  return (
    <button
      type="button"
      data-reaction-chip={item.emoji}
      aria-pressed={item.reacted}
      aria-label={reactionAriaLabel(item)}
      className={`relative inline-flex h-[22px] min-w-0 select-none items-center gap-1 rounded-full border px-1.5 text-[12px] font-semibold leading-none outline-none transition duration-150 [-webkit-touch-callout:none] after:absolute after:-inset-x-0.5 after:-inset-y-1 after:content-[''] focus-visible:ring-2 focus-visible:ring-emerald-400 ${
        item.reacted
          ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-600"
          : "border-emerald-200/80 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/25 dark:bg-slate-800 dark:text-emerald-100 dark:hover:bg-slate-700"
      }`}
      {...handlers}
    >
      <ReactionEmoji emoji={item.emoji} size={14} className="shrink-0" />
      <span key={pop || 0} className={`tabular-nums ${pop ? "sb-reaction-pop" : ""}`}>
        {item.count}
      </span>
    </button>
  );
}

/**
 * The reactions under a message: emoji and count, mine highlighted. A tap puts
 * my reaction on or takes it off. The people behind them are listed by a
 * long press or right click on a chip (when this person may see them).
 */
export default function ReactionChips({ chatId, messageId, isOwn = false, canListReactors = false }) {
  const list = useMessageReactions(messageId);
  const pops = usePops(list);
  const [popover, setPopover] = useState(null);
  const rootRef = useRef(null);
  const hasChips = list.length > 0;
  const hadChips = useRef(hasChips);

  // A chat that is scrolled to the bottom stays there when chips appear under
  // its last message (or grow into a second row).
  useLayoutEffect(() => {
    const row = rootRef.current;
    if (!row) {
      hadChips.current = false;
      return undefined;
    }
    const appeared = !hadChips.current;
    hadChips.current = true;
    if (appeared) keepAtBottomAfterGrowth(row, row.offsetHeight + 2);
    if (typeof ResizeObserver === "undefined") return undefined;
    let height = row.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = row.offsetHeight;
      if (next > height) keepAtBottomAfterGrowth(row, next - height);
      height = next;
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasChips]);

  const showReactors = useCallback((emoji, anchorEl) => {
    setPopover({ emoji, anchorEl });
  }, []);
  const closePopover = useCallback(() => setPopover(null), []);

  // The message menu's "Reacted by" item asks for the list by message id.
  useEffect(() => {
    if (!canListReactors) return undefined;
    const id = normalizeUuid(messageId);
    const onShow = (event) => {
      if (!id || event.detail?.messageId !== id) return;
      setPopover({ emoji: event.detail?.emoji || "", anchorEl: rootRef.current });
    };
    window.addEventListener(SHOW_REACTORS_EVENT, onShow);
    return () => window.removeEventListener(SHOW_REACTORS_EVENT, onShow);
  }, [canListReactors, messageId]);

  const onToggle = useCallback(
    (emoji) => {
      void toggleReaction({ chatId, messageId, emoji });
    },
    [chatId, messageId],
  );

  return (
    <>
      {list.length ? (
        <div
          ref={rootRef}
          role="group"
          aria-label="Reactions"
          className={`mt-0.5 flex max-w-full flex-wrap gap-1 ${isOwn ? "justify-end" : "justify-start"}`}
        >
          {list.map((item) => (
            <Chip
              key={item.emoji}
              item={item}
              pop={pops[item.emoji]}
              canList={canListReactors}
              onToggle={onToggle}
              onShowReactors={showReactors}
            />
          ))}
        </div>
      ) : null}
      {popover ? (
        <ReactorsPopover
          chatId={chatId}
          messageId={messageId}
          initialEmoji={popover.emoji}
          anchorEl={popover.anchorEl}
          onClose={closePopover}
        />
      ) : null}
    </>
  );
}
