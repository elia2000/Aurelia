import { describe, test, expect } from "vitest";
import {
  DEFAULT_PALETTE,
  applyThemeColor,
  colorScale,
  dailyColor,
  followsTheDay,
  msUntilNextDay,
  parseThemeDefault,
  dayNumber,
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
  const day = (n) => new Date(Date.UTC(2026, 0, 1 + n, 12, 0, 0));

  test("is stable within a day and changes the next day", () => {
    const a = dailyColor(palette, day(0));
    expect(dailyColor(palette, new Date(Date.UTC(2026, 0, 1, 0, 1)))).toBe(a);
    expect(dailyColor(palette, new Date(Date.UTC(2026, 0, 1, 23, 59)))).toBe(a);
    expect(dailyColor(palette, day(1))).not.toBe(a);
  });

  test("walks through the whole palette: 30 days give 30 different colours", () => {
    const seen = new Set(Array.from({ length: 30 }, (_, n) => dailyColor(palette, day(n))));
    expect(seen.size).toBe(30);
  });

  test("uses the palette it is given, whatever its length", () => {
    const small = ["#ff0000", "#00ff00", "#0000ff"];
    const seen = new Set(Array.from({ length: 6 }, (_, n) => dailyColor(small, day(n))));
    expect([...seen].sort()).toEqual([...small].sort());
  });

  test("the day follows UTC, so people in different time zones share it", () => {
    // 23:30 on 1 January in UTC-5 and 04:30 on 2 January in UTC are the same instant.
    const instant = new Date("2026-01-02T04:30:00Z");
    expect(dayNumber(instant)).toBe(dayNumber(new Date("2026-01-02T00:00:00Z")));
    expect(dayNumber(new Date("2026-01-01T23:59:59Z")) + 1).toBe(dayNumber(new Date("2026-01-02T00:00:00Z")));
  });

  test("the colour moves on at UTC midnight", () => {
    expect(msUntilNextDay(new Date("2026-04-02T23:59:30Z"))).toBe(30_000);
    expect(msUntilNextDay(new Date("2026-04-02T00:00:00Z"))).toBe(86_400_000);
  });
});

describe("the server's default", () => {
  test("is Random unless it names the built-in green or one colour", () => {
    expect(parseThemeDefault(undefined)).toBe("random");
    expect(parseThemeDefault("")).toBe("random");
    expect(parseThemeDefault("banana")).toBe("random");
    expect(parseThemeDefault("default")).toBe("default");
    expect(parseThemeDefault("#2563EB")).toBe("#2563eb");
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
  const date = new Date(Date.UTC(2026, 0, 5, 9, 0));
  const today = dailyColor(palette, date);

  test("no choice follows the server's default", () => {
    expect(resolveThemeColor({ mode: "inherit" }, palette, "random", date)).toBe(today);
    expect(resolveThemeColor(undefined, palette, "random", date)).toBe(today);
    expect(resolveThemeColor({ mode: "inherit" }, palette, "#2563EB", date)).toBe("#2563eb");
    expect(resolveThemeColor({ mode: "inherit" }, palette, "default", date)).toBeNull();
  });
  test("the built-in green is a choice of its own, whatever the server suggests", () => {
    expect(resolveThemeColor({ mode: "default" }, palette, "random", date)).toBeNull();
  });
  test("a chosen colour is used as it is", () => {
    expect(resolveThemeColor({ mode: "custom", color: "#ABCDEF" }, palette, "random", date)).toBe("#abcdef");
    expect(resolveThemeColor({ mode: "custom", color: "garbage" }, palette, "random", date)).toBeNull();
  });
  test("random means today's colour from the palette, the same for everybody", () => {
    expect(resolveThemeColor({ mode: "random" }, palette, "#2563eb", date)).toBe(today);
    expect(palette).toContain(today);
  });
  test("only a colour that changes every day needs the clock", () => {
    expect(followsTheDay({ mode: "random" }, "default")).toBe(true);
    expect(followsTheDay({ mode: "inherit" }, "random")).toBe(true);
    expect(followsTheDay({ mode: "inherit" }, "#2563eb")).toBe(false);
    expect(followsTheDay({ mode: "custom", color: "#2563eb" }, "random")).toBe(false);
    expect(followsTheDay({ mode: "default" }, "random")).toBe(false);
  });
});
