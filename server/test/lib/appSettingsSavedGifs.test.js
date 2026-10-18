import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SETTING_DEFS, getSetting, validateSetting } from "../../lib/appSettings.js";

let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.MAX_SAVED_GIFS;
});
afterEach(() => {
  process.env = originalEnv;
});

describe("MAX_SAVED_GIFS setting", () => {
  test("is an admin-editable integer setting, 1 to 200, default 50", () => {
    const def = SETTING_DEFS.find((d) => d.key === "MAX_SAVED_GIFS");
    expect(def).toBeTruthy();
    expect(def.type).toBe("int");
    expect(def.envKey).toBe("MAX_SAVED_GIFS");
    expect(def.defaultVal).toBe(50);
    expect(def.min).toBe(1);
    expect(def.max).toBe(200);
    // Read per request, so no restart is needed.
    expect(def.restart).toBeFalsy();
  });

  test("defaults to 50 when nothing is configured", () => {
    expect(getSetting("MAX_SAVED_GIFS")).toBe(50);
  });

  test("is read from the environment", () => {
    process.env.MAX_SAVED_GIFS = "120";
    expect(getSetting("MAX_SAVED_GIFS")).toBe(120);
  });

  test("an out-of-range environment value falls back to the default", () => {
    process.env.MAX_SAVED_GIFS = "5000";
    expect(getSetting("MAX_SAVED_GIFS")).toBe(50);
    process.env.MAX_SAVED_GIFS = "0";
    expect(getSetting("MAX_SAVED_GIFS")).toBe(50);
  });

  test.each(["1", "50", "200"])("the admin panel accepts %s", (value) => {
    expect(validateSetting("MAX_SAVED_GIFS", value)).toEqual({ valid: true, value });
  });

  test.each([["0", /minimum/i], ["201", /maximum/i], ["lots", /integer/i]])(
    "the admin panel rejects %s",
    (value, pattern) => {
      const result = validateSetting("MAX_SAVED_GIFS", value);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(pattern);
    },
  );
});
