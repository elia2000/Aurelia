// How the picture of a video call sits on the screen: filling it (the edges
// are cut off) or fitting inside it (all of it shows, with bars).
//
// A laptop camera is wide and a phone is held upright, so filling the screen
// cuts most of the sides off: Auto then shows the whole picture.

import { defaultStorage } from "../utils/safeStorage.js";

export const FIT_CHOICES = Object.freeze([
  { id: "auto", label: "Auto", hint: "Fills the screen, unless that would cut off a lot" },
  { id: "fill", label: "Fill the screen", hint: "The edges may be cut off" },
  { id: "fit", label: "Show the whole picture", hint: "With bars at the sides or at the top and bottom" },
]);
export const isFitChoice = (value) => FIT_CHOICES.some((choice) => choice.id === value);

/** The most of the picture Auto is willing to cut off to fill the screen. */
const MAX_CROP = 0.25;

/**
 * "cover" (fill) or "contain" (fit) for CSS object-fit.
 * @param {string} choice
 * @param {{w: number, h: number}|null} picture  size of the video
 * @param {{w: number, h: number}|null} box      size of the space it is shown in
 */
export function objectFitFor(choice, picture, box) {
  if (choice === "fill") return "cover";
  if (choice === "fit") return "contain";
  if (choice !== "auto" && !isFitChoice(choice)) return "contain";
  if (!picture?.w || !picture?.h || !box?.w || !box?.h) return "cover";
  const pictureShape = picture.w / picture.h;
  const boxShape = box.w / box.h;
  // The share of the picture that filling the box would cut off.
  const cut = 1 - Math.min(pictureShape / boxShape, boxShape / pictureShape);
  return cut > MAX_CROP ? "contain" : "cover";
}

const KEY = "aurelle-call-fit";

export function loadFit(storage = defaultStorage()) {
  try {
    const value = storage?.getItem(KEY);
    return isFitChoice(value) ? value : "auto";
  } catch (_) {
    return "auto";
  }
}

export function saveFit(value, storage = defaultStorage()) {
  try {
    if (isFitChoice(value)) storage?.setItem(KEY, value);
  } catch (_) {
    // not remembered
  }
}
