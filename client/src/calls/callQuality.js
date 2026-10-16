// The video quality this device last chose to watch at ("auto" or one level).
import { isQualityChoice } from "./mediaTuning.js";
import { defaultStorage } from "../utils/safeStorage.js";

const KEY = "aurelle-call-quality";

export function loadQuality(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(KEY);
    return isQualityChoice(value) ? value : "auto";
  } catch (_) {
    return "auto";
  }
}

export function saveQuality(value, storage = defaultStorage()) {
  try {
    if (isQualityChoice(value)) storage?.setItem(KEY, value);
  } catch (_) {
    // not remembered: it lasts for this page
  }
}
