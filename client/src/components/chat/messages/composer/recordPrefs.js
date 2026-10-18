import { defaultStorage } from "../../../../utils/safeStorage.js";

// What the record button does on a hold: "voice" (microphone) or "video"
// (round camera message). A tap on the button switches it and the choice is
// remembered on this device.
export const RECORD_MODE_KEY = "aurelle-record-mode";

export function readRecordMode() {
  try {
    return defaultStorage()?.getItem(RECORD_MODE_KEY) === "video" ? "video" : "voice";
  } catch (_) {
    return "voice";
  }
}

export function writeRecordMode(mode) {
  try {
    defaultStorage()?.setItem(RECORD_MODE_KEY, mode === "video" ? "video" : "voice");
  } catch (_) {
    // storage blocked or full: the choice just is not remembered
  }
}

/** A short haptic tick where the browser has one (Android Chrome). */
export function vibrate(pattern = 12) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch (_) {
    // not allowed without a recent tap; nothing to do
  }
}

export const RECORD_ERROR_TEXT = Object.freeze({
  micPermission: "Microphone access was blocked. Allow it in your browser settings to record.",
  micMissing: "No microphone was found.",
  micUnsupported: "Microphone access is not supported in this browser.",
  micFailed: "The microphone could not be started.",
  holdVoice: "Hold to record a voice message, release to send.",
  holdVideo: "Hold to record a video message, release to send.",
});

export function formatRecordingTime(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  const tenths = Math.floor((total % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function formatClock(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
