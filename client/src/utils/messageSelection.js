// Helpers for selecting message text with the mouse.

// A mouse press that moved this far before it was released was a drag (a text
// selection), not a click.
export const DRAG_CLICK_THRESHOLD_PX = 4;

// True when a click event is really the end of a drag selection, so it must
// not open a link, copy inline code, jump to a quoted message and so on.
export const isDragSelectionClick = ({
  down,
  clientX,
  clientY,
  selectionText = "",
  thresholdPx = DRAG_CLICK_THRESHOLD_PX,
}) => {
  if (!down) return false;
  if (!String(selectionText || "").length) return false;
  const moved = Math.hypot(
    Number(clientX || 0) - Number(down.x || 0),
    Number(clientY || 0) - Number(down.y || 0),
  );
  return moved > thresholdPx;
};

const getSelection = (doc) => {
  const view = doc?.defaultView || (typeof window !== "undefined" ? window : null);
  return view?.getSelection?.() || null;
};

// What is not copied: Ctrl+C leaves out everything that cannot be selected
// (the time, buttons), but Selection.toString() still returns it.
const UNSELECTABLE = "[data-no-select], button, .sr-only";

// The selection as plain text the way the browser copies it: block breaks
// become new lines, emoji pictures become their characters, and the time,
// status and buttons inside the selected messages are left out.
const readCopyableText = (selection, doc) => {
  const holder = doc.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText =
    "position:fixed;left:-99999px;top:0;width:640px;opacity:0;pointer-events:none;white-space:pre-wrap";
  for (let i = 0; i < selection.rangeCount; i += 1) {
    holder.appendChild(selection.getRangeAt(i).cloneContents());
  }
  holder.querySelectorAll(UNSELECTABLE).forEach((node) => node.remove());
  holder.querySelectorAll("img[alt]").forEach((img) => {
    img.replaceWith(doc.createTextNode(img.getAttribute("alt") || ""));
  });
  doc.body.appendChild(holder);
  const text = holder.innerText;
  holder.remove();
  return text.replace(/\n{3,}/g, "\n\n").trim();
};

// The selected text when the selection touches `root`, otherwise "".
// A selection that spans several messages belongs to every message in it.
export const getSelectedTextWithin = (root, doc = typeof document !== "undefined" ? document : null) => {
  if (!root || !doc) return "";
  const selection = getSelection(doc);
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  if (!selection.toString().trim()) return "";
  let touches = false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    if (selection.getRangeAt(i).intersectsNode(root)) touches = true;
  }
  if (!touches) return "";
  return readCopyableText(selection, doc);
};

// True when any text is selected anywhere on the page.
export const hasActiveTextSelection = (doc = typeof document !== "undefined" ? document : null) => {
  const selection = getSelection(doc);
  return Boolean(selection && !selection.isCollapsed && selection.toString().length);
};
