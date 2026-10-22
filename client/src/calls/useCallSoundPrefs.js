import { useSyncExternalStore } from "react";
import { useCalls } from "./callContext.js";
import { getCallSoundPrefs, subscribeCallSoundPrefs } from "./callSoundPrefs.js";
import { CHAT_PAGE_CONFIG } from "../settings/chatPageConfig.js";

/** {enabled, volume, vibrate}: what this device does when a call rings. Re-renders when it changes. */
export function useCallSoundPrefs() {
  return useSyncExternalStore(subscribeCallSoundPrefs, getCallSoundPrefs, getCallSoundPrefs);
}

/** Whether this device can take part in calls at all (the settings for their sounds are of no use otherwise). */
export function useCallSoundsAvailable() {
  const { supported } = useCalls();
  return Boolean(supported) && CHAT_PAGE_CONFIG.callsEnabled !== false;
}
