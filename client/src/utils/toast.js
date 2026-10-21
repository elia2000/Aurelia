// Small messages that appear for a moment ("Too many reactions"), shown by
// <ToastHost />. Any code may call showToast(); with no host on the page it
// does nothing.

export const TOAST_EVENT = "aurelle:toast";

/**
 * @param {string} message
 * @param {{ tone?: "error"|"info", durationMs?: number }} [options]
 */
export function showToast(message, { tone = "error", durationMs = 3600 } = {}) {
  const text = String(message ?? "").trim();
  if (!text || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(TOAST_EVENT, { detail: { message: text, tone, durationMs } }),
  );
}
