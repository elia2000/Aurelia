import { describe, test, expect } from "vitest";
import { DEFAULT_THEME_PALETTE, MAX_THEME_COLORS, normalizeHex, parseThemePalette } from "../../lib/themePalette.js";
import { SETTING_DEFS, validateSetting } from "../../lib/appSettings.js";

describe("normalizeHex", () => {
  test.each([
    ["#10B981", "#10b981"],
    ["10b981", "#10b981"],
    ["#abc", "#aabbcc"],
    ["  #ABCDEF  ", "#abcdef"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });
  test.each(["", "#12", "#12345", "#1234567", "#ggg", "red", "rgb(1,2,3)", null, undefined, 12])("rejects %s", (input) => {
    expect(normalizeHex(input)).toBeNull();
  });
});

describe("parseThemePalette", () => {
  test("takes commas, spaces and new lines, drops junk and duplicates, keeps order", () => {
    expect(parseThemePalette("#FF0000, 00ff00\n#00F  nope  #ff0000;#123456")).toEqual([
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#123456",
    ]);
  });
  test("accepts an array too", () => {
    expect(parseThemePalette(["#fff", "zzz", "#000"])).toEqual(["#ffffff", "#000000"]);
  });
  test("never more than 30 colours", () => {
    const many = Array.from({ length: 45 }, (_, i) => `#${(i + 16).toString(16).padStart(2, "0")}0000`).join(",");
    expect(parseThemePalette(many)).toHaveLength(MAX_THEME_COLORS);
    expect(MAX_THEME_COLORS).toBe(30);
  });
  test("an empty or unusable value gives the built-in palette of 30 colours", () => {
    expect(parseThemePalette("")).toEqual(DEFAULT_THEME_PALETTE);
    expect(parseThemePalette("nothing here")).toEqual(DEFAULT_THEME_PALETTE);
    expect(DEFAULT_THEME_PALETTE).toHaveLength(30);
    expect(new Set(DEFAULT_THEME_PALETTE).size).toBe(30);
  });
});

describe("the THEME_PALETTE admin setting", () => {
  test("is a public string setting with a built-in default", () => {
    const def = SETTING_DEFS.find((d) => d.key === "THEME_PALETTE");
    expect(def).toBeTruthy();
    expect(def.adminOnly).not.toBe(true);
    expect(def.secret).not.toBe(true);
  });
  test("is saved cleaned up: lower-case #rrggbb, comma separated", () => {
    const ok = validateSetting("THEME_PALETTE", "#FF0000 00ff00, #0f0");
    expect(ok.valid).toBe(true);
    expect(ok.value).toBe("#ff0000,#00ff00");
  });
  test("refuses a value with a colour that is not a colour, and one with more than 30", () => {
    expect(validateSetting("THEME_PALETTE", "#ff0000, banana").valid).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => `#${(i + 16).toString(16).padStart(2, "0")}0000`).join(",");
    expect(validateSetting("THEME_PALETTE", many).valid).toBe(false);
  });
  test("an empty value means 'use the built-in palette'", () => {
    expect(validateSetting("THEME_PALETTE", "").valid).toBe(true);
  });
});
