// The words of screen sharing that the call screen shows (the pieces that draw
// them are in components/calls/ScreenShareParts.jsx).

/** A hint for a share that did not start; it clears itself after a few seconds. */
export const SCREEN_ERROR_TEXT = Object.freeze({
  cancelled: "Screen sharing did not start. It was cancelled, or this browser is not allowed to capture the screen.",
  unsupported: "This browser cannot share its screen.",
  unavailable: "The other person's app cannot show a shared screen.",
  failed: "Screen sharing could not be started. Try again.",
});

/** Why the Share screen button is off (null when it can be used). */
export function shareScreenHint({ connected, available }) {
  if (!connected) return "Available once the call is connected";
  if (!available) return "The other person's app cannot show a shared screen";
  return null;
}

const SURFACE_TEXT = Object.freeze({
  monitor: "Your entire screen",
  window: "A window",
  browser: "A browser tab",
});

/** What is shared, in words. */
export const describeSurface = (surface) => SURFACE_TEXT[surface] || "Your screen";
