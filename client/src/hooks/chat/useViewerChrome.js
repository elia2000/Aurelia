import { useCallback, useEffect, useRef, useState } from "react";

// How long the media viewer keeps its buttons on screen when a playing video
// has not been touched.
export const VIEWER_IDLE_MS = 3000;

// Someone moving through the buttons with the keyboard is still using them.
function keyboardIsInside(root) {
  const focused = document.activeElement;
  if (!root || !focused || focused === root || focused === document.body || !root.contains(focused)) return false;
  try {
    return focused.matches(":focus-visible");
  } catch {
    return false; // a browser without :focus-visible: the buttons simply hide on time
  }
}

/**
 * Gets the buttons and bars of the media viewer out of the way of a video:
 *  - a click or tap on the picture hides them, and the next one brings them back;
 *  - moving the mouse shows them, and they hide again once the mouse (and the
 *    keyboard) has been still for a few seconds while the video plays;
 *  - what a click hid stays hidden when the mouse moves: only the next click or
 *    a key press brings it back;
 *  - they stay while the mouse is over them, while a button has keyboard focus
 *    and while `hold` is set (the video is still loading, or cannot be played).
 * `rootRef` is the viewer's own element, so focus can be told apart from the
 * page behind it. Everything shows again when `enabled` goes off or `resetKey`
 * (the media on show) changes.
 */
export function useViewerChrome({ enabled, playing, hold = false, rootRef, resetKey, idleMs = VIEWER_IDLE_MS }) {
  const [hidden, setHidden] = useState(false);
  const pinned = useRef(false); // a click hid it
  const overChrome = useRef(false); // the mouse rests on a button or bar
  const timer = useRef(null);
  const canHide = enabled && playing && !hold;

  const arm = useCallback(() => {
    clearTimeout(timer.current);
    const tick = () => {
      if (overChrome.current || keyboardIsInside(rootRef.current)) timer.current = setTimeout(tick, idleMs);
      else setHidden(true);
    };
    timer.current = setTimeout(tick, idleMs);
  }, [idleMs, rootRef]);

  useEffect(() => {
    if (canHide && !hidden) arm();
    else clearTimeout(timer.current);
    return () => clearTimeout(timer.current);
  }, [canHide, hidden, arm]);

  useEffect(() => {
    pinned.current = false;
    overChrome.current = false;
    setHidden(false);
  }, [enabled, resetKey]);

  // Shows everything and starts the countdown again.
  const wake = useCallback(() => {
    pinned.current = false;
    setHidden(false);
    if (canHide) arm();
  }, [canHide, arm]);

  // Any touch or press keeps what is showing a little longer.
  const poke = useCallback(() => {
    if (canHide && !hidden) arm();
  }, [canHide, hidden, arm]);

  const toggle = useCallback(() => {
    if (!enabled) return;
    const hide = !hidden;
    pinned.current = hide;
    setHidden(hide);
  }, [enabled, hidden]);

  // The hidden buttons cannot be focused, so key presses go to the page: any
  // key (Escape is the viewer's own) brings the buttons back.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") wake();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, wake]);

  const onPointerMove = useCallback(
    (event) => {
      if (event.pointerType !== "mouse") return;
      overChrome.current = Boolean(event.target?.closest?.("[data-viewer-chrome]"));
      if (!pinned.current) wake();
    },
    [wake],
  );
  const onPointerLeave = useCallback((event) => {
    if (event.pointerType === "mouse") overChrome.current = false;
  }, []);

  return { hidden: enabled && hidden, toggle, poke, onPointerMove, onPointerLeave };
}
