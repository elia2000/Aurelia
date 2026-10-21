import { describe, test, expect } from "vitest";
import { CATCH_UP_MAX_MESSAGES, catchUpLimit, keepCatchUp } from "../../src/utils/catchUpLimit.js";

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

// A refresh that is still waiting for its timer is replaced by the next one. A
// catch-up after a break must survive that: the next one is often a plain
// "new message" refresh that reads only what came after the newest row.
describe("keepCatchUp", () => {
  test("a plain refresh stays plain", () => {
    expect(keepCatchUp({ coverLoaded: false, tailDelta: true }, false)).toEqual({ coverLoaded: false, tailDelta: true });
    expect(keepCatchUp({}, false)).toEqual({ coverLoaded: false, tailDelta: false });
  });

  test("a catch-up reads the whole loaded window, never only the tail", () => {
    expect(keepCatchUp({ coverLoaded: true, tailDelta: true }, false)).toEqual({ coverLoaded: true, tailDelta: false });
  });

  test("a new-message refresh that replaces a waiting catch-up becomes the catch-up", () => {
    expect(keepCatchUp({ coverLoaded: false, tailDelta: true }, true)).toEqual({ coverLoaded: true, tailDelta: false });
  });
});
