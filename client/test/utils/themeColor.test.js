import { describe, test, expect } from "vitest";
import {
  DEFAULT_PALETTE,
  applyThemeColor,
  colorScale,
  dailyColor,
  dayNumber,
  hashString,
  normalizeHex,
  parsePalette,
  resolveThemeColor,
  SHADES,
} from "../../src/utils/themeColor.js";

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("hex handling", () => {
  test("normalises and rejects", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("10B981")).toBe("#10b981");
    expect(normalizeHex("nope")).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });
  test("a palette is cleaned, de-duplicated and limited to 30; empty falls back to the built-in 30", () => {
    expect(parsePalette(["#FFF", "#ffffff", "x", "#000"])).toEqual(["#ffffff", "#000000"]);
    expect(parsePalette(Array.from({ length: 40 }, (_, i) => `#${(i + 16).toString(16)}0000`))).toHaveLength(30);
    expect(parsePalette([])).toEqual(DEFAULT_PALETTE);
    expect(parsePalette(undefined)).toEqual(DEFAULT_PALETTE);
    expect(DEFAULT_PALETTE).toHaveLength(30);
  });
});

describe("the daily colour", () => {
  const palette = DEFAULT_PALETTE;
  const day = (n) => new Date(2026, 0, 1 + n, 12, 0, 0);

  test("is stable for a person within a day and changes the next day", () => {
    const a = dailyColor(palette, "user-1", day(0));
    expect(dailyColor(palette, "user-1", new Date(2026, 0, 1, 0, 1))).toBe(a);
    expect(dailyColor(palette, "user-1", new Date(2026, 0, 1, 23, 59))).toBe(a);
    expect(dailyColor(palette, "user-1", day(1))).not.toBe(a);
  });

  test("walks through the whole palette: 30 days give 30 different colours", () => {
    const seen = new Set(Array.from({ length: 30 }, (_, n) => dailyColor(palette, "user-1", day(n))));
    expect(seen.size).toBe(30);
  });

  test("people do not all get the same colour on the same day", () => {
    const colours = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => dailyColor(palette, id, day(0))));
    expect(colours.size).toBeGreaterThan(3);
  });

  test("uses the palette it is given, whatever its length", () => {
    const small = ["#ff0000", "#00ff00", "#0000ff"];
    const seen = new Set(Array.from({ length: 6 }, (_, n) => dailyColor(small, "u", day(n))));
    expect([...seen].sort()).toEqual([...small].sort());
  });

  test("day numbers follow the local calendar day", () => {
    expect(dayNumber(new Date(2026, 5, 10, 0, 0, 1)) + 1).toBe(dayNumber(new Date(2026, 5, 11, 23, 59, 59)));
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

describe("colour scale", () => {
  test("has every Tailwind shade and keeps the chosen colour at 500", () => {
    const scale = colorScale("#2563eb");
    expect(Object.keys(scale).map(Number)).toEqual(SHADES);
    // (500 is the colour itself, unless it had to be eased for readable white text)
    expect(scale[500]).toBe("#2563eb");
  });

  test("runs from very light to very dark without going backwards", () => {
    for (const hex of ["#10b981", "#2563eb", "#db2777", "#ca8a04"]) {
      const scale = colorScale(hex);
      const lum = SHADES.map((s) => luminance(scale[s]));
      for (let i = 1; i < lum.length; i += 1) expect(lum[i]).toBeLessThan(lum[i - 1]);
      expect(lum[0]).toBeGreaterThan(0.85);
      expect(lum.at(-1)).toBeLessThan(0.06);
    }
  });

  test("a very light colour is eased so that white text on it stays readable", () => {
    const scale = colorScale("#fff200");
    expect(luminance(scale[500])).toBeLessThan(luminance("#fff200"));
    const contrast = (1.05) / (luminance(scale[600]) + 0.05);
    expect(contrast).toBeGreaterThan(3);
  });

  test("white and black do not break it", () => {
    for (const hex of ["#ffffff", "#000000"]) {
      const scale = colorScale(hex);
      for (const s of SHADES) expect(scale[s]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("applying a colour", () => {
  const fakeRoot = () => {
    const vars = new Map();
    return { vars, style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) } };
  };

  test("sets the accent scale as CSS variables and clears it again", () => {
    const root = fakeRoot();
    applyThemeColor("#2563eb", { root, meta: null });
    expect(root.vars.get("--color-emerald-500")).toBe("#2563eb");
    expect(root.vars.get("--theme-chat-bg")).toBe(root.vars.get("--color-emerald-100")); // the chat background follows too
    expect(SHADES.every((s) => root.vars.has(`--color-emerald-${s}`))).toBe(true);
    applyThemeColor(null, { root, meta: null });
    expect(root.vars.size).toBe(0);
  });

  test("also updates the browser's theme colour", () => {
    const meta = { content: "#10b981", setAttribute(k, v) { this[k] = v; } };
    applyThemeColor("#db2777", { root: fakeRoot(), meta });
    expect(meta.content).toBe("#db2777");
  });
});

describe("resolving the preference", () => {
  const palette = ["#ff0000", "#00ff00", "#0000ff"];
  const date = new Date(2026, 0, 5, 9, 0);
  test("default means the built-in look", () => {
    expect(resolveThemeColor({ mode: "default" }, palette, "u", date)).toBeNull();
    expect(resolveThemeColor(undefined, palette, "u", date)).toBeNull();
  });
  test("a chosen colour is used as it is", () => {
    expect(resolveThemeColor({ mode: "custom", color: "#ABCDEF" }, palette, "u", date)).toBe("#abcdef");
    expect(resolveThemeColor({ mode: "custom", color: "garbage" }, palette, "u", date)).toBeNull();
  });
  test("random means today's colour from the palette", () => {
    const today = resolveThemeColor({ mode: "random" }, palette, "u", date);
    expect(palette).toContain(today);
    expect(today).toBe(dailyColor(palette, "u", date));
  });
});
