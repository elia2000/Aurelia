/**
 * The browser's localStorage, or null when there is none to use. A browser
 * that blocks site data throws when a page merely names `localStorage`, so
 * this must never be written as a default parameter or outside a try block.
 */
export function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch (_) {
    return null;
  }
}
