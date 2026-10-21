import { describe, test, expect } from "vitest";
import { placeMenuCard } from "../../src/utils/menuPlacement.js";

const BAR = 52; // the quick reaction bar and its gap

describe("placeMenuCard", () => {
  test("opens where the pointer is when it fits below", () => {
    expect(placeMenuCard({ pointY: 200, cardHeight: 300, viewportHeight: 800 })).toEqual({
      y: 200,
      maxHeight: 776,
      below: true,
      scrolls: false,
    });
  });

  test("opens upward from the pointer when there is no room below", () => {
    const placed = placeMenuCard({ pointY: 700, cardHeight: 300, viewportHeight: 800 });
    expect(placed).toMatchObject({ y: 400, below: false, scrolls: false });
  });

  test("never above the top edge", () => {
    const placed = placeMenuCard({ pointY: 100, cardHeight: 300, viewportHeight: 350 });
    expect(placed.y).toBeGreaterThanOrEqual(12);
  });

  test("with the bar: it needs room above the card, so the card starts below it", () => {
    // a tall card near the bottom: pointer above would put the card at y=40, under the bar's place
    const placed = placeMenuCard({ pointY: 760, cardHeight: 366, reserveTop: BAR, viewportHeight: 800 });
    expect(placed.y).toBeGreaterThanOrEqual(12 + BAR);
    expect(placed.y + 366).toBeLessThanOrEqual(800 - 12);
  });

  test("with the bar, a card near the top leaves the bar to go below when it fits there", () => {
    const placed = placeMenuCard({ pointY: 20, cardHeight: 200, reserveTop: BAR, viewportHeight: 800 });
    expect(placed.y).toBe(20);
  });

  test("a short window (landscape phone): the card scrolls and the bar never overlaps it", () => {
    const viewportHeight = 360;
    const placed = placeMenuCard({ pointY: 150, cardHeight: 366, reserveTop: BAR, viewportHeight });
    expect(placed.scrolls).toBe(true);
    const height = placed.maxHeight;
    expect(placed.y + height).toBeLessThanOrEqual(viewportHeight - 12);
    // the bar goes above the card or below it, whichever has room
    const barAbove = placed.y - BAR >= 12 - 6;
    const barBelow = placed.y + height + BAR + 12 <= viewportHeight;
    expect(barAbove || barBelow).toBe(true);
  });

  test("without the bar a short window still keeps the card on screen", () => {
    const placed = placeMenuCard({ pointY: 150, cardHeight: 366, viewportHeight: 360 });
    expect(placed.scrolls).toBe(true);
    expect(placed.maxHeight).toBe(336);
    expect(placed.y).toBe(12);
  });

  test("a window too small for anything still gives a usable height", () => {
    const placed = placeMenuCard({ pointY: 0, cardHeight: 366, reserveTop: BAR, viewportHeight: 120 });
    expect(placed.maxHeight).toBeGreaterThanOrEqual(96);
  });
});
