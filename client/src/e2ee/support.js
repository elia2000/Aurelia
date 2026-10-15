// Feature detection that is cheap to import (no crypto code), so UI that lives
// in the main bundle can decide whether to show encryption controls.

/**
 * True when the browser can hold device keys and decrypt: enough to RECEIVE
 * encrypted video messages and to show safety numbers, even if it cannot place
 * calls or record.
 */
export function isE2eeSupported() {
  if (typeof window === "undefined") return false;
  return Boolean(window.isSecureContext && globalThis.crypto?.subtle && typeof indexedDB !== "undefined");
}
