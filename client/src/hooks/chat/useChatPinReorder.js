import { useCallback, useEffect, useRef, useState } from "react";
import {
  dragOffsetLimits,
  dropIndexFor,
  reorderIds,
  shiftForRow,
} from "../../utils/chatPins.js";

// The mouse starts a drag after it moved this far.
const MOUSE_START_PX = 5;
// A finger must hold still this long (the same time a long press needs to open
// the menu), and then move this far to start dragging. A finger that moves
// before the hold is over is scrolling the list.
const TOUCH_HOLD_MS = 300;
const TOUCH_SCROLL_PX = 10;
const TOUCH_START_PX = 6;
const CLICK_GUARD_MS = 300;

const isFingerOrPen = (event) => event.pointerType === "touch" || event.pointerType === "pen";

// The click that follows a drag must not open the chat.
function swallowNextClick() {
  const stop = () => {
    window.clearTimeout(timer);
    window.removeEventListener("click", onClick, true);
  };
  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    stop();
  }
  const timer = window.setTimeout(stop, CLICK_GUARD_MS);
  window.addEventListener("click", onClick, true);
}

/**
 * Drag and drop for the pinned rows of the chat list, with the mouse (press
 * and move) or a finger (hold, then move). The row follows the pointer, the
 * rows it passes slide out of the way, and on release `onReorder` gets the new
 * order of the pinned chats' ids.
 *
 * @param {object} params
 * @param {boolean} params.enabled
 * @param {string[]} params.pinnedIds the pinned chats, top first, as drawn
 * @param {(orderedIds: string[]) => void} params.onReorder
 * @param {() => void} [params.onDragStart] e.g. closes the menu a long press opened
 */
export function useChatPinReorder({ enabled, pinnedIds, onReorder, onDragStart }) {
  const [drag, setDrag] = useState(null);
  const latest = useRef({});
  const session = useRef(null);

  useEffect(() => {
    latest.current = { enabled, pinnedIds, onReorder, onDragStart };
  });

  const end = useCallback(() => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    window.clearTimeout(current.holdTimer);
    current.stopListening();
    if (current.dragging) {
      document.body.style.userSelect = current.bodyUserSelect;
      document.body.style.cursor = current.bodyCursor;
    }
  }, []);

  // A page that goes away in the middle of a drag must not keep the listeners.
  useEffect(() => end, [end]);

  const startDragging = useCallback((current) => {
    current.dragging = true;
    current.bodyUserSelect = document.body.style.userSelect;
    current.bodyCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    latest.current.onDragStart?.();
    const rows = [...(current.rowEl.parentElement?.querySelectorAll("[data-pin-row]") || [])];
    const first = rows[0]?.getBoundingClientRect();
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    // The distance from one row to the next, separator included.
    current.rowHeight =
      rows.length > 1 && first && last
        ? (last.top - first.top) / (rows.length - 1)
        : current.rowEl.getBoundingClientRect().height;
    setDrag({
      id: current.id,
      fromIndex: current.index,
      toIndex: current.index,
      offsetY: 0,
      rowHeight: current.rowHeight,
    });
  }, []);

  const handleMove = useCallback(
    (event) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      const distance = Math.hypot(dx, dy);

      if (!current.dragging) {
        if (current.touch) {
          if (!current.armed) {
            if (distance > TOUCH_SCROLL_PX) end(); // the person is scrolling
            return;
          }
          if (distance < TOUCH_START_PX) return;
        } else if (distance < MOUSE_START_PX) {
          return;
        }
        startDragging(current);
      }

      const { min, max } = dragOffsetLimits({
        startIndex: current.index,
        count: latest.current.pinnedIds.length,
        rowHeight: current.rowHeight,
      });
      const offsetY = Math.min(Math.max(dy, min), max);
      const toIndex = dropIndexFor({
        startIndex: current.index,
        offsetY,
        rowHeight: current.rowHeight,
        count: latest.current.pinnedIds.length,
      });
      current.toIndex = toIndex;
      setDrag((previous) => (previous ? { ...previous, offsetY, toIndex } : previous));
    },
    [end, startDragging],
  );

  const handleUp = useCallback(
    (event) => {
      const current = session.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const { dragging, index, toIndex } = current;
      end();
      if (!dragging) return;
      swallowNextClick();
      setDrag(null);
      if (toIndex !== index) {
        latest.current.onReorder?.(reorderIds(latest.current.pinnedIds, index, toIndex));
      }
    },
    [end],
  );

  const handleCancel = useCallback(
    (event) => {
      const current = session.current;
      if (!current) return;
      if (event.type === "pointercancel" && event.pointerId !== current.pointerId) return;
      const wasDragging = current.dragging;
      end();
      if (wasDragging) {
        swallowNextClick();
        setDrag(null);
      }
    },
    [end],
  );

  const onPointerDown = useCallback(
    (event, chatId) => {
      const { enabled: on, pinnedIds: ids } = latest.current;
      if (!on || session.current) return;
      const touch = isFingerOrPen(event);
      if (!touch && event.button !== 0) return;
      // A control inside the row (the edit-mode buttons) is not a handle.
      if (event.target instanceof Element && event.target.closest("[data-no-drag]")) return;
      const index = ids.indexOf(chatId);
      if (index < 0 || ids.length < 2) return;

      const rowEl = event.currentTarget;
      const current = {
        id: chatId,
        index,
        toIndex: index,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        touch,
        armed: !touch,
        dragging: false,
        rowEl,
        rowHeight: 0,
        holdTimer: null,
        stopListening: () => {},
      };
      if (touch) {
        current.holdTimer = window.setTimeout(() => {
          current.armed = true;
          if (typeof navigator !== "undefined") navigator.vibrate?.(8);
        }, TOUCH_HOLD_MS);
      }
      // Once the drag started the page must not scroll under the finger.
      const onTouchMove = (touchEvent) => {
        if (current.armed && touchEvent.cancelable) touchEvent.preventDefault();
      };
      const onKeyDown = (keyEvent) => {
        if (keyEvent.key === "Escape") handleCancel(keyEvent);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("keydown", onKeyDown, true);
      if (touch) window.addEventListener("touchmove", onTouchMove, { passive: false });
      current.stopListening = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("touchmove", onTouchMove);
      };
      session.current = current;
    },
    [handleCancel, handleMove, handleUp],
  );

  /** Props for the wrapper of a pinned row. */
  const getRowProps = useCallback(
    (chatId) =>
      enabled
        ? {
            "data-pin-row": chatId,
            onPointerDown: (event) => onPointerDown(event, chatId),
            // A picture inside the row must not start the browser's own drag.
            onDragStart: (event) => event.preventDefault(),
          }
        : {},
    [enabled, onPointerDown],
  );

  /** The transform that makes room for, or follows, the dragged row. */
  const getRowStyle = useCallback(
    (chatId, index) => {
      if (!drag) return undefined;
      if (chatId === drag.id) {
        return {
          transform: `translateY(${drag.offsetY}px)`,
          transition: "none",
          zIndex: 20,
          touchAction: "none",
        };
      }
      const shift = shiftForRow({
        index,
        fromIndex: drag.fromIndex,
        toIndex: drag.toIndex,
        rowHeight: drag.rowHeight,
      });
      return {
        transform: shift ? `translateY(${shift}px)` : undefined,
        transition: "transform 160ms ease",
      };
    },
    [drag],
  );

  return { draggingId: drag?.id || null, getRowProps, getRowStyle };
}
