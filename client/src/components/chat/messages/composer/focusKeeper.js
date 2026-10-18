function focusPreventScroll(element) {
  if (!element) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

/**
 * Remembers whether the message field had the cursor when a button was pressed,
 * and gives it back afterwards (on phones also keeps the keyboard open). A
 * plain object so components can use it in event handlers without touching refs
 * while they render.
 */
export function createFocusKeeper() {
  let input = null;
  let keep = false;
  return {
    setInput(node) {
      input = node;
    },
    focus() {
      focusPreventScroll(input);
    },
    capture() {
      if (typeof document === "undefined") return;
      if (document.activeElement === input) keep = true;
    },
    restore() {
      if (!keep) return;
      keep = false;
      requestAnimationFrame(() => focusPreventScroll(input));
    },
  };
}
