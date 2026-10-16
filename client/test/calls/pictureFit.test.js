import { describe, test, expect } from "vitest";
import { FIT_CHOICES, isFitChoice, loadFit, objectFitFor, saveFit } from "../../src/calls/pictureFit.js";

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
};

describe("how the other person's picture sits on the screen", () => {
  const phone = { w: 360, h: 640 }; // upright
  const landscapePicture = { w: 1280, h: 720 }; // a laptop camera
  const tallPicture = { w: 720, h: 1280 }; // a phone held upright

  test("Auto fills the screen when little would be cut off", () => {
    expect(objectFitFor("auto", tallPicture, phone)).toBe("cover");
    expect(objectFitFor("auto", { w: 640, h: 1000 }, phone)).toBe("cover");
  });

  test("Auto shows the whole picture when filling would cut off a lot (a wide picture on an upright phone)", () => {
    expect(objectFitFor("auto", landscapePicture, phone)).toBe("contain");
    // ... and the other way round: a tall picture in a wide window.
    expect(objectFitFor("auto", tallPicture, { w: 1280, h: 720 })).toBe("contain");
  });

  test("a landscape picture on a landscape screen fills it", () => {
    expect(objectFitFor("auto", landscapePicture, { w: 1280, h: 720 })).toBe("cover");
    expect(objectFitFor("auto", landscapePicture, { w: 1000, h: 700 })).toBe("cover");
  });

  test("Fill and Fit are what they say, whatever the sizes", () => {
    expect(objectFitFor("fill", landscapePicture, phone)).toBe("cover");
    expect(objectFitFor("fit", tallPicture, phone)).toBe("contain");
  });

  test("with an unknown size it fills, and nonsense counts as Auto", () => {
    expect(objectFitFor("auto", null, phone)).toBe("cover");
    expect(objectFitFor("auto", landscapePicture, null)).toBe("cover");
    expect(objectFitFor("auto", { w: 0, h: 0 }, phone)).toBe("cover");
    expect(objectFitFor("whatever", landscapePicture, phone)).toBe("contain");
  });
});

describe("the choice", () => {
  test("Auto, Fill and Fit, and nothing else", () => {
    expect(FIT_CHOICES.map((c) => c.id)).toEqual(["auto", "fill", "fit"]);
    expect(isFitChoice("fit")).toBe(true);
    expect(isFitChoice("stretch")).toBe(false);
    expect(isFitChoice("__proto__")).toBe(false);
  });
  test("is remembered, and falls back to Auto", () => {
    const storage = memory();
    expect(loadFit(storage)).toBe("auto");
    saveFit("fit", storage);
    expect(loadFit(storage)).toBe("fit");
    saveFit("stretch", storage);
    expect(loadFit(storage)).toBe("fit");
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(loadFit(broken)).toBe("auto");
    expect(() => saveFit("fill", broken)).not.toThrow();
  });
});
