import { describe, expect, test } from "vitest";
import {
  DRAG_CLICK_THRESHOLD_PX,
  getSelectedTextWithin,
  hasActiveTextSelection,
  isDragSelectionClick,
} from "../../src/utils/messageSelection.js";

describe("isDragSelectionClick", () => {
  const down = { x: 100, y: 50 };

  test("a press that moved and left text selected was a drag", () => {
    expect(
      isDragSelectionClick({ down, clientX: 160, clientY: 52, selectionText: "abc" }),
    ).toBe(true);
  });

  test("a plain click (no movement) is never a drag, even with a selection elsewhere", () => {
    expect(
      isDragSelectionClick({ down, clientX: 101, clientY: 50, selectionText: "abc" }),
    ).toBe(false);
  });

  test("movement without a selection is not a drag selection", () => {
    expect(
      isDragSelectionClick({ down, clientX: 200, clientY: 50, selectionText: "" }),
    ).toBe(false);
  });

  test("no recorded press means a keyboard or synthetic click", () => {
    expect(
      isDragSelectionClick({ down: null, clientX: 5, clientY: 5, selectionText: "abc" }),
    ).toBe(false);
  });

  test("the threshold is the first distance that counts as movement", () => {
    expect(
      isDragSelectionClick({
        down,
        clientX: down.x + DRAG_CLICK_THRESHOLD_PX,
        clientY: down.y,
        selectionText: "abc",
      }),
    ).toBe(false);
    expect(
      isDragSelectionClick({
        down,
        clientX: down.x + DRAG_CLICK_THRESHOLD_PX + 1,
        clientY: down.y,
        selectionText: "abc",
      }),
    ).toBe(true);
  });
});

describe("selection helpers without a DOM", () => {
  test("return empty answers when there is no document", () => {
    expect(getSelectedTextWithin({}, null)).toBe("");
    expect(getSelectedTextWithin(null, {})).toBe("");
    expect(hasActiveTextSelection(null)).toBe(false);
  });
});
