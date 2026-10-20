import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SETTING_DEFS, getSetting, validateSetting } from "../../lib/appSettings.js";

let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.MAX_REACTIONS_PER_USER;
});
afterEach(() => {
  process.env = originalEnv;
});

describe("MAX_REACTIONS_PER_USER setting", () => {
  test("is an admin-editable integer setting, 1 to 3, default 1", () => {
    const def = SETTING_DEFS.find((d) => d.key === "MAX_REACTIONS_PER_USER");
    expect(def).toBeTruthy();
    expect(def.type).toBe("int");
    expect(def.envKey).toBe("MAX_REACTIONS_PER_USER");
    expect(def.defaultVal).toBe(1);
    expect(def.min).toBe(1);
    expect(def.max).toBe(3);
    // Applied per request, so no restart is needed.
    expect(def.restart).toBeFalsy();
  });

  test("defaults to 1 when nothing is configured", () => {
    expect(getSetting("MAX_REACTIONS_PER_USER")).toBe(1);
  });

  test("is read from the environment", () => {
    process.env.MAX_REACTIONS_PER_USER = "3";
    expect(getSetting("MAX_REACTIONS_PER_USER")).toBe(3);
  });

  test("an out-of-range environment value falls back to the default", () => {
    process.env.MAX_REACTIONS_PER_USER = "9";
    expect(getSetting("MAX_REACTIONS_PER_USER")).toBe(1);
    process.env.MAX_REACTIONS_PER_USER = "0";
    expect(getSetting("MAX_REACTIONS_PER_USER")).toBe(1);
  });

  test.each(["1", "2", "3"])("the admin panel accepts %s", (value) => {
    expect(validateSetting("MAX_REACTIONS_PER_USER", value)).toEqual({ valid: true, value });
  });

  test.each([["0", /minimum/i], ["4", /maximum/i], ["many", /integer/i]])(
    "the admin panel rejects %s",
    (value, pattern) => {
      const result = validateSetting("MAX_REACTIONS_PER_USER", value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(pattern);
    },
  );
});
