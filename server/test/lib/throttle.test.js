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
});
