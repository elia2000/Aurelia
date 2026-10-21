import { useCallback, useRef, useState } from "react";
import {
  HEART_REACTION,
  canReactToMessage,
  getReactionMessageId,
} from "../../utils/reactions.js";
import { getReactionEntry, toggleReaction } from "../../utils/reactionStore.js";

// Two taps this close in time and place are a double tap.
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 28;
// A finger that moved further than this between down and up was a scroll or a swipe.
const TAP_SLOP_PX = 10;
// The double click a touch screen may also produce is ignored this long after a tap.
const TOUCH_DBLCLICK_GUARD_MS = 700;

const INTERACTIVE =
  "a, button, input, textarea, select, label, video, audio, [role='button'], [contenteditable='true']";

const isInteractive = (target) => target instanceof Element && Boolean(target.closest(INTERACTIVE));

/**
 * Double click (mouse) and double tap (finger, pen) on a message put a heart
 * on it, or take mine off again, like Telegram's quick reaction.
 *
 * Put `pointerHandlers` on the message row (a finger's pointer is captured by
 * the row while it swipes to reply, so the bubble never sees its pointerup)
 * and call `onDoubleClick(event)` from the bubble: it returns true when the
 * click was taken as a reaction, so the caller leaves it alone.
 * `burst` changes each time a heart is added: draw <HeartBurst burst={burst} />.
 */
export function useHeartReaction({ msg, chatId, enabled }) {
  const [burst, setBurst] = useState(0);
  const lastTap = useRef(null);
  const down = useRef(null);
  const lastTouchAt = useRef(0);

  const react = useCallback(() => {
    const messageId = getReactionMessageId(msg);
    if (!enabled || !chatId || !messageId || !canReactToMessage(msg)) return false;
    const mine = getReactionEntry(messageId)?.mine || [];
    if (!mine.includes(HEART_REACTION)) setBurst((n) => n + 1);
    void toggleReaction({ chatId, messageId, emoji: HEART_REACTION });
    return true;
  }, [chatId, enabled, msg]);

  const onDoubleClick = useCallback(
    (event) => {
      if (Date.now() - lastTouchAt.current < TOUCH_DBLCLICK_GUARD_MS) return true;
      if (isInteractive(event.target)) return false;
      if (!react()) return false;
      // The double click also selected a word: the reaction is what was meant.
      const bubble = event.currentTarget;
      const selection = window.getSelection?.();
      if (selection?.rangeCount && bubble?.contains(selection.anchorNode)) {
        selection.removeAllRanges();
      }
      return true;
    },
    [react],
  );

  const pointerHandlers = {
    onPointerDown: (event) => {
      if (event.pointerType === "mouse") return;
      const inBubble =
        event.target instanceof Element && Boolean(event.target.closest("[data-message-bubble]"));
      down.current =
        inBubble && !isInteractive(event.target)
          ? { x: event.clientX, y: event.clientY, id: event.pointerId }
          : null;
    },
    onPointerUp: (event) => {
      if (event.pointerType === "mouse") return;
      const start = down.current;
      down.current = null;
      if (!start || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) {
        lastTap.current = null;
        return;
      }
      const now = event.timeStamp || Date.now();
      const previous = lastTap.current;
      if (
        previous &&
        now - previous.at <= DOUBLE_TAP_MS &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= DOUBLE_TAP_SLOP_PX
      ) {
        lastTap.current = null;
        lastTouchAt.current = Date.now();
        react();
        return;
      }
      lastTap.current = { at: now, x: event.clientX, y: event.clientY };
    },
    onPointerCancel: () => {
      down.current = null;
      lastTap.current = null;
    },
  };

  return { burst, onDoubleClick, pointerHandlers };
}
