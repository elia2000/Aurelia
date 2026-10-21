// Taking the person to a message that is already on the page: scroll it to the
// middle of the chat and flash its bubble for a moment (the same cue a tap on
// a reply gives). Finding a message that is NOT loaded yet is
// hooks/chat/useJumpToMessage.js.

const FLASH_MS = 700;
const FLASH_FALLBACK_MS = 900;
// A message further away than this many screens is jumped to at once; a
// smooth scroll over thousands of pixels only makes the person wait.
const SMOOTH_SCREENS = 1.5;

const prefersReducedMotion = () => {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
};

/** The row of a message on the page (its id is the server's message id). */
export const getMessageElement = (messageId) =>
  typeof document === "undefined" || !messageId
    ? null
    : document.getElementById(`message-${messageId}`);

function playFlash(bubble) {
  bubble.classList.remove("reply-flash");
  void bubble.offsetWidth;
  bubble.classList.add("reply-flash");
  window.setTimeout(() => bubble.classList.remove("reply-flash"), FLASH_MS);
}

/**
 * Scrolls a message into the middle of the chat and flashes it once it is
 * (mostly) in view. Returns false when the message is not on the page.
 *
 * @param {string} messageId the server's id of the message
 * @param {HTMLElement|null} scrollRoot the element that scrolls the chat
 */
export function jumpToLoadedMessage(messageId, scrollRoot = null) {
  const target = getMessageElement(messageId);
  if (!target) return false;

  let behavior = prefersReducedMotion() ? "auto" : "smooth";
  if (behavior === "smooth" && scrollRoot) {
    const distance = Math.abs(
      target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top,
    );
    if (distance > scrollRoot.clientHeight * SMOOTH_SCREENS) behavior = "auto";
  }
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", behavior });
  }

  const bubble = target.querySelector?.("[data-message-bubble]");
  if (!bubble) return true;
  let flashed = false;
  const flash = () => {
    if (flashed) return;
    flashed = true;
    playFlash(bubble);
  };
  if (typeof IntersectionObserver === "undefined") {
    window.setTimeout(flash, 360);
    return true;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      flash();
    },
    { root: scrollRoot, threshold: 0.5 },
  );
  observer.observe(target);
  window.setTimeout(() => {
    observer.disconnect();
    flash();
  }, FLASH_FALLBACK_MS);
  return true;
}
