import { useSyncExternalStore } from "react";
import { getCallShortcutsEnabled, subscribeCallShortcuts } from "./callShortcutPrefs.js";

/** Whether the single-letter keys of the call screen work on this device. Re-renders when it changes. */
export function useCallShortcutsEnabled() {
  return useSyncExternalStore(subscribeCallShortcuts, getCallShortcutsEnabled, getCallShortcutsEnabled);
}
