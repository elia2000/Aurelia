import { useCallback, useEffect, useState } from "react";
import { fullscreenSupported, isFullscreen, toggleFullscreen } from "./fullscreen.js";

/**
 * Full screen for one element (the call card): whether it is in full screen, and
 * a function that puts it in or takes it out. The card leaves full screen by
 * itself when it is removed (the call is minimised or over).
 * @param {{current: Element | null}} ref
 * @returns {{supported: boolean, active: boolean, toggle: () => Promise<"entered"|"left"|"failed">}}
 */
export function useFullscreen(ref) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const sync = () => setActive(isFullscreen(ref.current));
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [ref]);
  const toggle = useCallback(() => toggleFullscreen(ref.current), [ref]);
  return { supported: fullscreenSupported(), active, toggle };
}
