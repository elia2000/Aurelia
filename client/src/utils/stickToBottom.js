// A scrolled-to-the-bottom chat should stay at the bottom when something in
// the last message grows (a row of reaction chips appears). The browser keeps
// what is on screen steady when content ABOVE the view grows, but not when
// content at the very bottom does.

const SCROLLABLE = /^(auto|scroll|overlay)$/;

/** The nearest ancestor that scrolls vertically, or null. */
export function findScrollParent(node) {
  let current = node?.parentElement || null;
  while (current && current !== document.body) {
    if (SCROLLABLE.test(getComputedStyle(current).overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Call after `node` grew by `grewBy` pixels. If its scroll container had been
 * at the bottom (within `tolerance` px) before that, it goes back to the bottom.
 * @returns {boolean} true when it scrolled
 */
export function keepAtBottomAfterGrowth(node, grewBy, tolerance = 8) {
  const scroller = findScrollParent(node);
  if (!scroller || !(grewBy > 0)) return false;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  if (distance <= 0 || distance - grewBy > tolerance) return false;
  scroller.scrollTop = scroller.scrollHeight;
  return true;
}
