import { describe, test, expect } from "vitest";
import { isStaleBuild } from "../../src/buildInfo.js";

describe("isStaleBuild", () => {
  test("a page built before the server's build is stale", () => {
    expect(isStaleBuild("abc-1", "abc-2")).toBe(true);
  });
  test("the same build is not stale", () => {
    expect(isStaleBuild("abc-2", "abc-2")).toBe(false);
  });
  test("nothing is claimed when either side does not know its build", () => {
    expect(isStaleBuild("", "abc-2")).toBe(false); // dev server / unstamped build
    expect(isStaleBuild("abc-2", "")).toBe(false); // server without a built client
    expect(isStaleBuild(undefined, undefined)).toBe(false);
  });
});
