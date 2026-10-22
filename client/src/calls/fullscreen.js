// Full screen for the call card (the F key). The Fullscreen API where the
// browser has it, with the older WebKit names for Safari on a Mac. iPhones
// allow full screen for a video only, so there the key does nothing.

const hasDocument = () => typeof document !== "undefined";

const fullscreenElementOf = (doc) => doc?.fullscreenElement || doc?.webkitFullscreenElement || null;

/** Whether a page may put an element in full screen here. */
export function fullscreenSupported(doc = hasDocument() ? document : null) {
  return Boolean(doc && (doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true));
}

/** True when `element` is the one in full screen. */
export const isFullscreen = (element, doc = hasDocument() ? document : null) => Boolean(element) && fullscreenElementOf(doc) === element;

/**
 * Puts `element` in full screen, or takes it out when it is there already.
 * @returns {Promise<"entered"|"left"|"failed">} a browser may refuse (no user gesture, a policy)
 */
export async function toggleFullscreen(element, doc = hasDocument() ? document : null) {
  if (!element || !fullscreenSupported(doc)) return "failed";
  try {
    if (isFullscreen(element, doc)) {
      await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      return "left";
    }
    await (element.requestFullscreen?.() ?? element.webkitRequestFullscreen?.());
    return "entered";
  } catch (_) {
    return "failed";
  }
}

/** Leaves full screen if `element` (or anything of the call) is in it. */
export async function exitFullscreen(element, doc = hasDocument() ? document : null) {
  if (!isFullscreen(element, doc)) return false;
  try {
    await (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
    return true;
  } catch (_) {
    return false;
  }
}
