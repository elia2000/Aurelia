import { describe, test, expect } from "vitest";
import { CATCH_UP_MAX_MESSAGES, catchUpLimit } from "../../src/utils/catchUpLimit.js";

describe("catchUpLimit", () => {
  test("never less than a normal page", () => {
    expect(catchUpLimit(0, 60)).toBe(60);
    expect(catchUpLimit(25, 60)).toBe(60);
  });

  test("a chat scrolled back far is read as far back as it is loaded", () => {
    expect(catchUpLimit(100, 60)).toBe(100);
    expect(catchUpLimit(640, 60)).toBe(640);
  });

  test("but not without end", () => {
    expect(catchUpLimit(50000, 60)).toBe(CATCH_UP_MAX_MESSAGES);
  });

  test("bad numbers fall back to the page", () => {
    expect(catchUpLimit(undefined, 60)).toBe(60);
    expect(catchUpLimit(Number.NaN, 60)).toBe(60);
    expect(catchUpLimit(-5, 60)).toBe(60);
  });
});
