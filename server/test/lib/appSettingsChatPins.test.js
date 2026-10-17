import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SETTING_DEFS, getSetting, validateSetting } from "../../lib/appSettings.js";

let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.MAX_PINNED_CHATS;
});
afterEach(() => {
  process.env = originalEnv;
});

describe("MAX_PINNED_CHATS setting", () => {
  test("is an admin-editable integer setting, 1 to 30, default 5", () => {
    const def = SETTING_DEFS.find((d) => d.key === "MAX_PINNED_CHATS");
    expect(def).toBeTruthy();
    expect(def.type).toBe("int");
    expect(def.envKey).toBe("MAX_PINNED_CHATS");
    expect(def.defaultVal).toBe(5);
    expect(def.min).toBe(1);
    expect(def.max).toBe(30);
    // Read per request, so no restart is needed.
    expect(def.restart).toBeFalsy();
  });

  test("defaults to 5 when nothing is configured", () => {
    expect(getSetting("MAX_PINNED_CHATS")).toBe(5);
  });

  test("is read from the environment", () => {
    process.env.MAX_PINNED_CHATS = "12";
    expect(getSetting("MAX_PINNED_CHATS")).toBe(12);
  });

  test("an out-of-range environment value falls back to the default", () => {
    process.env.MAX_PINNED_CHATS = "31";
    expect(getSetting("MAX_PINNED_CHATS")).toBe(5);
    process.env.MAX_PINNED_CHATS = "0";
    expect(getSetting("MAX_PINNED_CHATS")).toBe(5);
  });

  test.each(["1", "5", "30"])("the admin panel accepts %s", (value) => {
    expect(validateSetting("MAX_PINNED_CHATS", value)).toEqual({ valid: true, value });
  });

  test.each([["0", /minimum/i], ["31", /maximum/i], ["many", /integer/i]])(
    "the admin panel rejects %s",
    (value, pattern) => {
      const result = validateSetting("MAX_PINNED_CHATS", value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(pattern);
    },
  );
});
