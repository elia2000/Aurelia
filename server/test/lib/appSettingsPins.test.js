import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SETTING_DEFS, getSetting, validateSetting } from "../../lib/appSettings.js";

let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.MAX_PINNED_MESSAGES;
});
afterEach(() => {
  process.env = originalEnv;
});

describe("MAX_PINNED_MESSAGES setting", () => {
  test("is an admin-editable integer setting, 1 to 100, default 20", () => {
    const def = SETTING_DEFS.find((d) => d.key === "MAX_PINNED_MESSAGES");
    expect(def).toBeTruthy();
    expect(def.type).toBe("int");
    expect(def.envKey).toBe("MAX_PINNED_MESSAGES");
    expect(def.defaultVal).toBe(20);
    expect(def.min).toBe(1);
    expect(def.max).toBe(100);
    // Read per request, so no restart is needed.
    expect(def.restart).toBeFalsy();
  });

  test("defaults to 20 when nothing is configured", () => {
    expect(getSetting("MAX_PINNED_MESSAGES")).toBe(20);
  });

  test("is read from the environment", () => {
    process.env.MAX_PINNED_MESSAGES = "5";
    expect(getSetting("MAX_PINNED_MESSAGES")).toBe(5);
  });

  test("an out-of-range environment value falls back to the default", () => {
    process.env.MAX_PINNED_MESSAGES = "101";
    expect(getSetting("MAX_PINNED_MESSAGES")).toBe(20);
    process.env.MAX_PINNED_MESSAGES = "0";
    expect(getSetting("MAX_PINNED_MESSAGES")).toBe(20);
  });

  test.each(["1", "20", "100"])("the admin panel accepts %s", (value) => {
    expect(validateSetting("MAX_PINNED_MESSAGES", value)).toEqual({ valid: true, value });
  });

  test.each([["0", /minimum/i], ["101", /maximum/i], ["lots", /integer/i]])(
    "the admin panel rejects %s",
    (value, pattern) => {
      const result = validateSetting("MAX_PINNED_MESSAGES", value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(pattern);
    },
  );
});
