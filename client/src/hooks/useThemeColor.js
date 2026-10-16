import { useEffect, useSyncExternalStore } from "react";
import { applyThemeColor } from "../utils/themeColor.js";
import {
  getThemeSnapshot,
  msUntilNextDay,
  refreshThemeColor,
  setThemeUser,
  subscribeTheme,
} from "../utils/themeStore.js";

/** The theme colour state (palette, the person's choice and today's colour). */
export function useThemeSnapshot() {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
}

/**
 * Applies the signed-in person's theme colour to the whole app, and moves a
 * "random" colour on at midnight (and when the page comes back to the front).
 * Used once, near the top of the app.
 */
export function useThemeColor(userKey) {
  const snapshot = useThemeSnapshot();

  useEffect(() => {
    setThemeUser(userKey || null);
  }, [userKey]);

  useEffect(() => {
    applyThemeColor(snapshot.color);
  }, [snapshot.color]);

  const random = snapshot.preference.mode === "random";
  useEffect(() => {
    if (!random) return undefined;
    let timer;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshThemeColor();
        schedule();
      }, msUntilNextDay() + 1000);
    };
    const onVisible = () => {
      if (document.hidden) return;
      refreshThemeColor();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [random]);

  return snapshot;
}
