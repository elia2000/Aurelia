import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTING_DEFS, getAllSettings, getSetting, validateSetting } from "../../lib/appSettings.js";

let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  delete process.env.LINK_PREVIEWS;
});
afterEach(() => {
  process.env = originalEnv;
});

describe("LINK_PREVIEWS setting", () => {
  test("is an admin-editable boolean, off by default, read per request", () => {
    const def = SETTING_DEFS.find((d) => d.key === "LINK_PREVIEWS");
    expect(def).toBeTruthy();
    expect(def.type).toBe("bool");
    expect(def.envKey).toBe("LINK_PREVIEWS");
    expect(def.defaultVal).toBe(false);
    expect(def.restart).toBeFalsy();
    expect(def.label).toBeTruthy();
    expect(def.description).toMatch(/server/i);
  });

  test("is off when nothing is configured", () => {
    expect(getSetting("LINK_PREVIEWS")).toBe(false);
  });

  test.each(["1", "true", "yes", "on"])("the environment value %s turns it on", (value) => {
    process.env.LINK_PREVIEWS = value;
    expect(getSetting("LINK_PREVIEWS")).toBe(true);
  });

  test.each(["0", "false", "no", "off", "nonsense"])("the environment value %s leaves it off", (value) => {
    process.env.LINK_PREVIEWS = value;
    expect(getSetting("LINK_PREVIEWS")).toBe(false);
  });

  test.each(["true", "false", "1", "0", "on", "off", "yes", "no"])("the admin panel accepts %s", (value) => {
    expect(validateSetting("LINK_PREVIEWS", value)).toEqual({ valid: true, value });
  });

  test("the admin panel rejects anything else", () => {
    expect(validateSetting("LINK_PREVIEWS", "maybe").valid).toBe(false);
  });

  test("the admin panel lists it with its default, and locks it when the environment sets it", () => {
    let entry = getAllSettings().find((s) => s.key === "LINK_PREVIEWS");
    expect(entry).toMatchObject({ value: false, defaultVal: false, type: "bool", group: "client", envLocked: false });
    process.env.LINK_PREVIEWS = "true";
    entry = getAllSettings().find((s) => s.key === "LINK_PREVIEWS");
    expect(entry).toMatchObject({ value: true, envLocked: true });
  });
});
