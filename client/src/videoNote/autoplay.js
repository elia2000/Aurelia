// Whether a round video message may start by itself (muted, looping) while it
// is on screen. Starting one costs a download and a decryption, so it stays
// off when the person asked for less motion or less data, when there is no
// network or a very slow one, and for a file bigger than a round video
// message normally is (the recorder makes about 3 MB per minute).

export const AUTOPLAY_MAX_BYTES = 8 * 1024 * 1024;

const SLOW_CONNECTIONS = new Set(["slow-2g", "2g"]);

/**
 * What stops autoplay right now; an empty string when nothing does.
 * @param {{reducedMotion?: boolean, saveData?: boolean, effectiveType?: string, online?: boolean, sizeBytes?: number}} env
 * @returns {"" | "reduced-motion" | "data-saver" | "slow-network" | "offline" | "too-big"}
 */
export function autoplayBlocker({ reducedMotion, saveData, effectiveType, online = true, sizeBytes = 0 } = {}) {
  if (reducedMotion) return "reduced-motion";
  if (saveData) return "data-saver";
  if (online === false) return "offline";
  if (SLOW_CONNECTIONS.has(String(effectiveType || ""))) return "slow-network";
  if (Number(sizeBytes) > AUTOPLAY_MAX_BYTES) return "too-big";
  return "";
}

/** Reads the settings that matter from the browser (or from fakes in a test). */
export function readAutoplayEnvironment({ matchMedia, navigator: nav } = {}) {
  const media = matchMedia ?? (typeof window !== "undefined" ? window.matchMedia?.bind(window) : undefined);
  const net = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  let reducedMotion = false;
  try {
    reducedMotion = Boolean(media?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    // no media queries here: treat as no preference
  }
  const connection = net?.connection;
  return {
    reducedMotion,
    saveData: Boolean(connection?.saveData),
    effectiveType: connection?.effectiveType || "",
    online: net?.onLine !== false,
  };
}
