import { describe, test, expect } from "vitest";
import { createThrottle } from "../../lib/throttle.js";

describe("createThrottle", () => {
  test("allows up to max per window per key, then recovers", () => {
    let t = 0;
    const throttle = createThrottle({ windowMs: 1000, max: 2, now: () => t });
    expect(throttle.take("a")).toBe(true);
    expect(throttle.take("a")).toBe(true);
    expect(throttle.take("a")).toBe(false);
    expect(throttle.remaining("a")).toBe(0);
    expect(throttle.take("b")).toBe(true); // other keys are independent
    t = 1001;
    expect(throttle.take("a")).toBe(true);
  });

  test("refused attempts do not extend the lock-out", () => {
    let t = 0;
    const throttle = createThrottle({ windowMs: 1000, max: 1, now: () => t });
    expect(throttle.take("a")).toBe(true);
    t = 900;
    expect(throttle.take("a")).toBe(false);
    t = 1001;
    expect(throttle.take("a")).toBe(true);
  });

  test("reset clears one key or everything", () => {
    const throttle = createThrottle({ windowMs: 1000, max: 1 });
    throttle.take("a");
    throttle.take("b");
    throttle.reset("a");
    expect(throttle.take("a")).toBe(true);
    expect(throttle.take("b")).toBe(false);
    throttle.reset();
    expect(throttle.take("b")).toBe(true);
  });

  test("an attempt can cost more than one, and is refused whole when it does not fit", () => {
    let t = 0;
    const throttle = createThrottle({ windowMs: 1000, max: 10, now: () => t });
    expect(throttle.take("a", 6)).toBe(true);
    expect(throttle.remaining("a")).toBe(4);
    expect(throttle.take("a", 5)).toBe(false); // does not fit: nothing is recorded
    expect(throttle.remaining("a")).toBe(4);
    expect(throttle.take("a", 4)).toBe(true);
    expect(throttle.take("a")).toBe(false);
    t = 1001;
    expect(throttle.remaining("a")).toBe(10);
  });

  test("a cost that can never fit is refused, a cost of nothing is free, and a bad cost counts as one", () => {
    const throttle = createThrottle({ windowMs: 1000, max: 3 });
    expect(throttle.take("a", 4)).toBe(false);
    expect(throttle.remaining("a")).toBe(3);
    expect(throttle.take("a", 0)).toBe(true);
    expect(throttle.remaining("a")).toBe(3);
    expect(throttle.take("a", Number.NaN)).toBe(true);
    expect(throttle.take("a", -2)).toBe(true);
    expect(throttle.remaining("a")).toBe(1);
  });

  test("the cost leaves the window together, when its time is up", () => {
    let t = 0;
    const throttle = createThrottle({ windowMs: 1000, max: 4, now: () => t });
    expect(throttle.take("a", 3)).toBe(true);
    t = 600;
    expect(throttle.take("a", 1)).toBe(true);
    t = 1001; // the first three are old now; the last one is not
    expect(throttle.remaining("a")).toBe(3);
  });
});
