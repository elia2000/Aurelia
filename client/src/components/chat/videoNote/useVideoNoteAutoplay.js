import { useEffect, useState } from "react";
import { autoplayBlocker, readAutoplayEnvironment } from "../../../videoNote/autoplay.js";

// A round video counts as on screen when most of it is, and the page is in front.
const ON_SCREEN_RATIO = 0.6;

/** Whether the element is mostly on screen right now (never, where that cannot be told). */
export function useOnScreen(ref) {
  const [onScreen, setOnScreen] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || !document.hidden);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setOnScreen(last.isIntersecting && last.intersectionRatio >= ON_SCREEN_RATIO);
      },
      { threshold: [0, ON_SCREEN_RATIO, 1] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onChange = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return onScreen && pageVisible;
}

/** Whether this device may start round videos by itself: see videoNote/autoplay.js. */
export function useAutoplayAllowed(sizeBytes) {
  const [env, setEnv] = useState(() => readAutoplayEnvironment());

  useEffect(() => {
    const refresh = () => setEnv(readAutoplayEnvironment());
    const query = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : null;
    query?.addEventListener?.("change", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    const connection = navigator.connection;
    connection?.addEventListener?.("change", refresh);
    return () => {
      query?.removeEventListener?.("change", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      connection?.removeEventListener?.("change", refresh);
    };
  }, []);

  return autoplayBlocker({ ...env, sizeBytes }) === "";
}
