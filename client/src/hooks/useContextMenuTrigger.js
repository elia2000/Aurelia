import { useEffect, useMemo, useRef } from "react";

const DEFAULT_HOLD_DELAY_MS = 300;
const MOVE_TOLERANCE_PX = 12;
const SCROLL_INTENT_PX = 4;
// Some browsers send a contextmenu event right after the ContextMenu key; the
// keydown already opened the menu, so that echo is ignored.
const KEYBOARD_ECHO_MS = 400;

// Long press and swipe belong to fingers and pens. The mouse keeps its normal
// behaviour (selecting text, dragging) and only opens menus by right click.
const isFingerOrPen = (event) =>
  event?.pointerType === "touch" || event?.pointerType === "pen";

const isMenuKey = (event) =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

const findScrollableAncestor = (node) => {
  if (typeof window === "undefined" || !node) return null;
  let current = node instanceof Element ? node : node?.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = String(style.overflowY || "").toLowerCase();
    const overflowX = String(style.overflowX || "").toLowerCase();
    const canScrollY =
      (overflowY === "auto" || overflowY === "scroll") &&
      current.scrollHeight > current.clientHeight;
    const canScrollX =
      (overflowX === "auto" || overflowX === "scroll") &&
      current.scrollWidth > current.clientWidth;
    if (canScrollY || canScrollX) {
      return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement || document.documentElement || null;
};

// A finger that is still down when the menu opens lifts over the menu, and the
// browser then clicks whatever is under it: an item would be chosen by the same
// touch that opened the menu. The first click outside `surface` that comes
// with the lift (up to half a second after it) is dropped. (A click on the
// surface itself is dropped by its own click guard.)
const RELEASE_CLICK_WINDOW_MS = 500;
const RELEASE_CLICK_MAX_WAIT_MS = 15000;

// Only one finger opens a menu at a time, so one guard is enough.
let stopActiveReleaseGuard = null;

function swallowReleaseClick(surface) {
  if (typeof window === "undefined") return;
  stopActiveReleaseGuard?.();
  let expiresAt = Infinity;
  let timer = null;
  const stop = () => {
    if (stopActiveReleaseGuard === stop) stopActiveReleaseGuard = null;
    window.clearTimeout(timer);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("pointerup", onLift, true);
    window.removeEventListener("pointercancel", onLift, true);
  };
  function onClick(event) {
    const inside = surface instanceof Element && event.target instanceof Node && surface.contains(event.target);
    if (!inside && Date.now() <= expiresAt) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
    stop();
  }
  function onLift() {
    expiresAt = Date.now() + RELEASE_CLICK_WINDOW_MS;
    window.clearTimeout(timer);
    timer = window.setTimeout(stop, RELEASE_CLICK_WINDOW_MS + 100);
  }
  stopActiveReleaseGuard = stop;
  window.addEventListener("click", onClick, true);
  window.addEventListener("pointerup", onLift, true);
  window.addEventListener("pointercancel", onLift, true);
  timer = window.setTimeout(stop, RELEASE_CLICK_MAX_WAIT_MS);
}

export function useContextMenuTrigger({
  disabled = false,
  isMobile = false,
  holdDelayMs = DEFAULT_HOLD_DELAY_MS,
  moveTolerancePx = MOVE_TOLERANCE_PX,
  onOpen,
}) {
  const holdTimerRef = useRef(null);
  const pointerRef = useRef({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    scrollTarget: null,
    startScrollTop: 0,
    startScrollLeft: 0,
  });
  const suppressClickRef = useRef(false);
  const keyboardOpenedAtRef = useRef(0);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(holdTimerRef.current);
    }
    holdTimerRef.current = null;
  };

  useEffect(() => clearHoldTimer, []);

  useEffect(() => {
    if (!isMobile || disabled) return undefined;
    const handleScroll = () => {
      if (!pointerRef.current.active) return;
      pointerRef.current.active = false;
      clearHoldTimer();
    };
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [disabled, isMobile]);

  return useMemo(() => {
    if (disabled || typeof onOpen !== "function") {
      return {};
    }

    const openMenu = (event, source = "desktop") => {
      const targetEl = event?.currentTarget || null;
      onOpen({
        event,
        source,
        targetEl,
        isMobile: source === "mobile",
      });
    };

    const onContextMenu = (event) => {
      if (isMobile) return;
      event.preventDefault();
      if (Date.now() - keyboardOpenedAtRef.current < KEYBOARD_ECHO_MS) return;
      openMenu(event, "desktop");
    };

    const onKeyDown = (event) => {
      if (!isMenuKey(event)) return;
      event.preventDefault();
      keyboardOpenedAtRef.current = Date.now();
      openMenu(event, "keyboard");
    };

    const onPointerDown = (event) => {
      if (!isMobile || !isFingerOrPen(event)) return;
      clearHoldTimer();
      suppressClickRef.current = false;

      const target = event.target instanceof Element ? event.target : null;
      const surface = event.currentTarget instanceof Element ? event.currentTarget : null;
      if (target && surface && target !== surface) {
        const interactive = target.closest("button, a, input, textarea, select, [role='button']");
        // A control that carries data-menu-passthrough (a picture or GIF that
        // opens the viewer on tap) still lets a long press open the menu.
        if (
          interactive &&
          surface.contains(interactive) &&
          interactive !== surface &&
          !interactive.hasAttribute("data-menu-passthrough")
        ) {
          return;
        }
      }

      const scrollTarget = findScrollableAncestor(event.target);
      pointerRef.current = {
        active: true,
        pointerId: event.pointerId,
        startX: Number(event.clientX || 0),
        startY: Number(event.clientY || 0),
        scrollTarget,
        startScrollTop: Number(scrollTarget?.scrollTop || 0),
        startScrollLeft: Number(scrollTarget?.scrollLeft || 0),
      };
      holdTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = true;
        pointerRef.current.active = false;
        swallowReleaseClick(surface);
        openMenu(event, "mobile");
      }, holdDelayMs);
    };

    const cancelPointer = (event) => {
      if (!isMobile) return;
      if (!pointerRef.current.active) return;
      if (
        pointerRef.current.pointerId !== null &&
        Number(event?.pointerId) !== Number(pointerRef.current.pointerId)
      ) {
        return;
      }
      pointerRef.current.active = false;
      clearHoldTimer();
    };

    const onPointerMove = (event) => {
      if (!isMobile || !pointerRef.current.active) return;
      if (event.defaultPrevented) {
        cancelPointer(event);
        return;
      }
      const dx = Math.abs(
        Number(event.clientX || 0) - pointerRef.current.startX,
      );
      const dy = Math.abs(
        Number(event.clientY || 0) - pointerRef.current.startY,
      );
      const scrollTarget = pointerRef.current.scrollTarget;
      const scrollTop = Number(scrollTarget?.scrollTop || 0);
      const scrollLeft = Number(scrollTarget?.scrollLeft || 0);
      if (
        Math.abs(scrollTop - Number(pointerRef.current.startScrollTop || 0)) > 0 ||
        Math.abs(scrollLeft - Number(pointerRef.current.startScrollLeft || 0)) > 0
      ) {
        cancelPointer(event);
        return;
      }
      if (dy >= SCROLL_INTENT_PX && dy >= dx) {
        cancelPointer(event);
        return;
      }
      if (dx > moveTolerancePx || dy > moveTolerancePx) {
        cancelPointer(event);
      }
    };

    const onClickCapture = (event) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    return {
      onContextMenu,
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp: cancelPointer,
      onPointerCancel: cancelPointer,
      onClickCapture,
    };
  }, [disabled, holdDelayMs, isMobile, moveTolerancePx, onOpen]);
}
