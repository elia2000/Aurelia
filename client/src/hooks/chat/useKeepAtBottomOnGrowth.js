import { useLayoutEffect } from "react";
import { keepAtBottomAfterGrowth } from "../../utils/stickToBottom.js";

/**
 * Something inside a message that shows up (or grows) AFTER the message was put
 * in place - a link preview card is the usual one: the server needs a moment to
 * fetch the page - must not push the end of a chat that is scrolled to the
 * bottom out of view. The browser keeps what is on screen steady when content
 * ABOVE the view grows, but not content at the very bottom (and the chat list
 * turns scroll anchoring off), so this scrolls back down by the amount gained,
 * but only for a chat that was at the bottom before: someone reading further up
 * is never moved. (Images and videos do the same through the chat's own
 * onMediaLoaded; reaction chips through the same helper as here.)
 *
 * `ref` is the element that gains the height (the message bubble, not the new
 * card itself: a card also changes the line under it, where the time goes), and
 * it is watched from the moment this is `active`, so that its height before the
 * change is known.
 *
 * @param {{ current: Element | null }} ref  the element that grows
 * @param {boolean} [active]                 false while nothing is expected to change it
 */
export function useKeepAtBottomOnGrowth(ref, active = true) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!active || !node || typeof ResizeObserver === "undefined") return undefined;
    let height = node.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      if (next > height) keepAtBottomAfterGrowth(node, next - height);
      height = next;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, active]);
}
