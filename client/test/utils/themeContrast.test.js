import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { composite, contrastRatio, hexToOklch, oklchToHex, relativeLuminance } from "../../src/utils/colorMath.js";
import { AUDIT_PAIRS, auditScale, guardScale, resolveRef } from "../../src/utils/themeContrast.js";
import { DEFAULT_PALETTE, DEFAULT_THEME_COLOR, SHADES, applyThemeColor, baseScale, colorScale } from "../../src/utils/themeColor.js";

// ── the colours to sweep ─────────────────────────────────────────────────────
// Hue in steps of 15 degrees, at seven (lightness, colourfulness) levels from
// near-black to near-white, pale and grey.
const LEVELS = [
  [0.2, 0.06],
  [0.4, 0.15],
  [0.55, 0.2],
  [0.7, 0.2],
  [0.85, 0.12],
  [0.95, 0.04],
  [0.65, 0.02],
];
const HUE_SWEEP = [];
for (let hue = 0; hue < 360; hue += 15) {
  for (const [L, C] of LEVELS) HUE_SWEEP.push(oklchToHex({ L, C, h: (hue * Math.PI) / 180 }));
}
const EXTREMES = [
  "#ffffff", "#000000", "#ffff00", "#00ffff", "#ff00ff", "#0000ff", "#00ff00", "#ff0000",
  "#808080", "#333333", "#cccccc", "#fff200", "#001f3f", "#ffdc00", "#111111", "#fafafa",
];
// 24 more, from a fixed seed (a tiny LCG) so the sweep never changes between runs.
function seeded(count) {
  let state = 20260101;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return Array.from({ length: count }, () => oklchToHex({ L: 0.1 + next() * 0.88, C: next() * 0.32, h: next() * Math.PI * 2 }));
}
const SWEEP = [...new Set([...HUE_SWEEP, ...EXTREMES, ...seeded(24)])];

const sentence = (failures) =>
  failures.map((f) => `${f.theme}/${f.id}: ${f.fg} on ${f.bg} is ${f.ratio.toFixed(2)}:1, needs ${f.min}`).join("; ");

describe("colour maths", () => {
  test("contrast ratio matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#777777")).toBe(contrastRatio("#777777", "#ffffff"));
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  test("a translucent colour is blended the way a browser does it, in sRGB", () => {
    expect(composite("#ffffff", 0.5, "#000000")).toBe("#808080");
    expect(composite("#102030", 1, "#ffffff")).toBe("#102030");
    expect(composite("#102030", 0, "#ffffff")).toBe("#ffffff");
  });

  test("OKLCH round-trips a colour that is inside the screen", () => {
    for (const hex of ["#10b981", "#2563eb", "#db2777", "#808080"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
  });
});

describe("the audit table", () => {
  test("covers light and dark mode with 4.5:1 for text, 3:1 for the rest and a 2:1 floor for the hover fill", () => {
    const themes = new Set(AUDIT_PAIRS.map((p) => p.theme));
    expect([...themes].sort()).toEqual(["dark", "light"]);
    expect(new Set(AUDIT_PAIRS.map((p) => p.min))).toEqual(new Set([2, 3, 4.5]));
    expect(AUDIT_PAIRS.filter((p) => p.min === 2).map((p) => p.id)).toEqual(["label-on-soft-hover-fill"]);
    expect(AUDIT_PAIRS.length).toBeGreaterThan(50);
  });

  test("names the real combinations: white on the fills, accent text on every surface, own bubbles, call chip", () => {
    const ids = new Set(AUDIT_PAIRS.map((p) => `${p.theme}/${p.id}`));
    for (const id of [
      "light/label-on-fill", "light/label-on-strong-fill", "light/text-700", "light/text-600", "light/icon-500",
      "light/own-bubble-text", "light/own-bubble-meta", "light/selection",
      "dark/text-200", "dark/text-300", "dark/text-400", "dark/icon-500", "dark/own-bubble-text", "dark/call-chip",
      "light/text-700-hover", "light/label-on-soft-hover-fill", "dark/text-200-soft",
      "light/ring-on-bubble", "dark/ring-on-bubble", "dark/sharing-banner", "dark/sharing-banner-stop",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  test("the screen-sharing banner is readable over any picture: the brightest frame is the worst case (it was 1.4:1)", () => {
    // rose-950 at 90% (bg-rose-950/90), rose-50 title and rose-100 line, over black and over a white frame.
    for (const frame of ["#000000", "#808080", "#ffffff"]) {
      const backing = composite("#4c0519", 0.9, frame);
      expect(contrastRatio("#fff1f2", backing), `rose-50 over ${frame}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#ffe4e6", backing), `rose-100 over ${frame}`).toBeGreaterThanOrEqual(4.5);
    }
    // what it used to be: rose-500 at 20% over a white frame, with a blurred white video behind
    expect(contrastRatio("#fff1f2", composite("#f43f5e", 0.2, "#ffffff"))).toBeLessThan(1.6);
    expect(contrastRatio("#ffffff", "#e11d48"), "white on the Stop sharing button (rose-600)").toBeGreaterThanOrEqual(4.5);
  });

  test("every reference resolves to a colour", () => {
    const scale = colorScale("#2563eb");
    for (const pair of AUDIT_PAIRS) {
      expect(resolveRef(pair.fg, scale)).toMatch(/^#[0-9a-f]{6}$/);
      expect(resolveRef(pair.bg, scale)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("it does catch an unreadable scale: the raw scale of a bright yellow fails light and dark pairs", () => {
    const failures = auditScale(baseScale("#ffff00"));
    expect(failures.length).toBeGreaterThan(5);
    expect(new Set(failures.map((f) => f.theme))).toEqual(new Set(["light", "dark"]));
  });
});

describe("every accent stays readable", () => {
  test("the sweep is big enough", () => {
    expect(SWEEP.length).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_PALETTE).toHaveLength(30);
  });

  test("all 30 colours of the built-in palette pass every pair", () => {
    for (const hex of DEFAULT_PALETTE) {
      const failures = auditScale(colorScale(hex));
      expect(failures, `${hex}: ${sentence(failures)}`).toEqual([]);
    }
  });

  test("so does every colour of the sweep (hues, extreme lightness and saturation, #fff, #000, #ff0, #0ff)", () => {
    const bad = [];
    for (const hex of SWEEP) {
      const failures = auditScale(colorScale(hex));
      if (failures.length) bad.push(`${hex} -> ${sentence(failures.slice(0, 3))}`);
    }
    expect(bad).toEqual([]);
  });

  test("the built-in green passes as well", () => {
    expect(auditScale(colorScale(DEFAULT_THEME_COLOR))).toEqual([]);
  });

  test("independent spot checks that do not use the table: white text on the fills, accent text on white and on dark panels", () => {
    for (const hex of [...DEFAULT_PALETTE, ...SWEEP]) {
      const s = colorScale(hex);
      expect(contrastRatio("#ffffff", s[500]), `${hex} white on 500`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio("#ffffff", s[600]), `${hex} white on 600`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#ffffff", s[700]), `${hex} white on 700`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s[700], s[50]), `${hex} 700 on 50`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(s[950], s[200]), `${hex} 950 on 200 (own bubble)`).toBeGreaterThanOrEqual(4.5);
      // dark mode: accent text on slate-900 / slate-950, and the accent itself as an icon or dot
      for (const surface of ["#0f172a", "#020617"]) {
        expect(contrastRatio(s[200], surface), `${hex} 200 on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(s[300], surface), `${hex} 300 on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(s[400], surface), `${hex} 400 on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(s[500], surface), `${hex} 500 on ${surface}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrastRatio("#ffffff", s[800]), `${hex} white on 800 (dark own bubble)`).toBeGreaterThanOrEqual(4.5);
      // the focus ring of the link preview card on a bubble (it was 500/400: 1.7:1 on an own bubble in light mode)
      expect(contrastRatio(s[700], s[200]), `${hex} 700 ring on 200 (own bubble)`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(s[700], "#ffffff"), `${hex} 700 ring on white (other bubble)`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(s[300], s[800]), `${hex} 300 ring on 800 (dark own bubble)`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(s[300], composite("#1e293b", 0.75, "#0b1320")), `${hex} 300 ring on the dark other bubble`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio("#ffffff", s[400]), `${hex} white on 400 (hover fill)`).toBeGreaterThanOrEqual(2);
      // the encrypted chip of the call screen: over black and over a white video frame
      for (const frame of ["#000000", "#ffffff"]) {
        expect(contrastRatio(s[200], composite("#0f172a", 0.7, frame)), `${hex} 200 on the call chip over ${frame}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("the scale keeps its shape", () => {
  test("is in order, from 50 (almost white) to 950 (almost black), for every colour", () => {
    for (const hex of [...DEFAULT_PALETTE, ...SWEEP]) {
      const lum = SHADES.map((s) => relativeLuminance(colorScale(hex)[s]));
      for (let i = 1; i < lum.length; i += 1) expect(lum[i], `${hex} shade ${SHADES[i]}`).toBeLessThan(lum[i - 1]);
      expect(lum[0], hex).toBeGreaterThan(0.85);
      expect(lum.at(-1), hex).toBeLessThan(0.06);
    }
  });

  test("hue is kept: an eased shade moves in lightness only", () => {
    const hueGap = (a, b) => {
      const d = Math.abs(hexToOklch(a).h - hexToOklch(b).h);
      return Math.min(d, 2 * Math.PI - d);
    };
    for (const hex of ["#10b981", "#ca8a04", "#06b6d4", "#f97316", "#4f46e5", "#2563eb", "#ffdc00", "#001f3f"]) {
      const eased = colorScale(hex);
      const plain = baseScale(hex);
      for (const shade of SHADES) {
        if (eased[shade] === plain[shade] || hexToOklch(plain[shade]).C < 0.03) continue; // (a near-grey has no hue to keep)
        expect(hueGap(eased[shade], plain[shade]), `${hex} shade ${shade}`).toBeLessThan(0.12);
      }
    }
  });

  test("a colour that already passes is not touched at all", () => {
    let untouched = 0;
    for (const hex of [...DEFAULT_PALETTE, ...SWEEP]) {
      if (auditScale(baseScale(hex)).length) continue;
      untouched += 1;
      expect(colorScale(hex), hex).toEqual(baseScale(hex));
      expect(colorScale(hex)[500]).toBe(hex);
    }
    expect(untouched).toBeGreaterThan(0);
  });

  test("a colour that fails changes only the shades that fail: the rest stay as they were", () => {
    const hex = "#7c3aed"; // passes everything but a tinted pair or two in some versions: pick a known mover instead
    const mover = "#ca8a04";
    const eased = colorScale(mover);
    const plain = baseScale(mover);
    const changed = SHADES.filter((s) => eased[s] !== plain[s]);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(SHADES.length);
    expect(colorScale(hex)[500]).toBe(hex);
    // the lightest and the darkest steps do not move for a mid colour
    expect(eased[50]).toBe(plain[50]);
    expect(eased[950]).toBe(plain[950]);
  });

  test("the look of the built-in palette moves little: the eased colour stays close to the one that was chosen", () => {
    const dist = (a, b) => {
      const x = hexToOklch(a);
      const y = hexToOklch(b);
      return Math.hypot(x.L - y.L, x.C * Math.cos(x.h) - y.C * Math.cos(y.h), x.C * Math.sin(x.h) - y.C * Math.sin(y.h));
    };
    for (const hex of DEFAULT_PALETTE) expect(dist(hex, colorScale(hex)[500]), hex).toBeLessThan(0.1);
    // and over half of the palette is not touched at 500 at all
    expect(DEFAULT_PALETTE.filter((hex) => colorScale(hex)[500] === hex).length).toBeGreaterThanOrEqual(15);
  });
});

describe("easing is deterministic", () => {
  test("the same colour always gives the same shades, in any order, from a cold start or a warm one", () => {
    const first = Object.fromEntries(SWEEP.map((hex) => [hex, { ...colorScale(hex) }]));
    for (const hex of [...SWEEP].reverse()) expect(colorScale(hex), hex).toEqual(first[hex]);
    // and the repair itself is a pure function of the shades it is given
    const raw = (hex) => {
      const base = baseScale(hex);
      return Object.fromEntries(SHADES.map((s) => [s, { ...hexToOklch(base[s]), hex: base[s] }]));
    };
    const a = guardScale(raw("#fff200"));
    const b = guardScale(raw("#fff200"));
    expect(Object.fromEntries(SHADES.map((s) => [s, a[s].hex]))).toEqual(Object.fromEntries(SHADES.map((s) => [s, b[s].hex])));
  });

  test("the result is frozen, so one caller cannot change what another gets", () => {
    expect(Object.isFrozen(colorScale("#123456"))).toBe(true);
  });

  test("garbage in gives the built-in green out", () => {
    expect(colorScale("nope")).toEqual(colorScale(DEFAULT_THEME_COLOR));
  });

  test("does not depend on the date", () => {
    const before = colorScale("#ffe600");
    const clock = Date.now;
    Date.now = () => 0;
    try {
      expect(colorScale("#ffe600")).toEqual(before);
    } finally {
      Date.now = clock;
    }
  });
});

describe("the built-in green in index.css", () => {
  test("is the guarded scale of #10b981, so it reads like every other accent", () => {
    const css = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
    const theme = css.slice(css.indexOf("@theme"), css.indexOf("}", css.indexOf("@theme")));
    const scale = colorScale(DEFAULT_THEME_COLOR);
    for (const shade of SHADES) {
      expect(theme, `--color-emerald-${shade}`).toContain(`--color-emerald-${shade}: ${scale[shade]};`);
    }
    expect(auditScale(Object.fromEntries(SHADES.map((s) => [s, scale[s]])))).toEqual([]);
  });

  test("applyThemeColor writes the guarded shades, and clearing falls back to the built-in", () => {
    const vars = new Map();
    const root = { style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) } };
    applyThemeColor("#fff200", { root, meta: null });
    const scale = colorScale("#fff200");
    for (const shade of SHADES) expect(vars.get(`--color-emerald-${shade}`)).toBe(scale[shade]);
    expect(contrastRatio("#ffffff", vars.get("--color-emerald-600"))).toBeGreaterThanOrEqual(4.5);
    applyThemeColor(null, { root, meta: null });
    expect(vars.size).toBe(0);
  });
});

// ── the interface keeps to the table ─────────────────────────────────────────
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.jsx?$/.test(name)) out.push(path);
  }
  return out;
}
const SRC = new URL("../../src", import.meta.url).pathname;
const FILES = sourceFiles(SRC).map((path) => ({ path: path.slice(SRC.length + 1), text: readFileSync(path, "utf8") }));

describe("the interface uses each shade for its job", () => {
  test("the 500 shade is a fill, icon or dot colour: it is never the colour of a text label", () => {
    const offenders = [];
    for (const { path, text } of FILES) {
      for (const match of text.matchAll(/(?:font-semibold|uppercase)[^"`']*\btext-emerald-500(?:\/\d+)?(?![\w-])|\btext-emerald-500(?:\/\d+)?[^"`']*(?:font-semibold|uppercase)/g)) {
        offenders.push(`${path}: ${match[0].slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("keyboard focus rings use the 500 shade, which holds 3:1 on white and on dark panels (the call screen and chips laid over a video are always dark)", () => {
    const offenders = [];
    for (const { path, text } of FILES) {
      if (path.startsWith("components/calls/")) continue;
      text.split("\n").forEach((line, index) => {
        if (/focus-visible:ring-emerald-(?:200|300|400)\b/.test(line) && !/bg-(?:white|black)\/\d+/.test(line)) offenders.push(`${path}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("every shade a pair names exists in the scale", () => {
    for (const pair of AUDIT_PAIRS) {
      for (const ref of [pair.fg, pair.bg]) {
        const shades = [];
        const walk = (r) => (typeof r === "number" ? shades.push(r) : typeof r === "object" ? (walk(r.fg), walk(r.over)) : null);
        walk(ref);
        for (const shade of shades) expect(SHADES, `${pair.theme}/${pair.id}`).toContain(shade);
      }
    }
  });
});

describe("links and mentions in messages", () => {
  const css = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");
  // the colour of the first rule whose selector list holds `selector` (as a whole selector, not part of a longer one)
  const colorOf = (selector) =>
    new RegExp(`(?<![\\w.-])(?<!\\.dark )${selector.replace(/[.]/g, "\\.")}\\s*(?:,[^{}]*)?\\{[^}]*?color:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];
  const darkColorOf = (selector) =>
    new RegExp(`\\.dark ${selector.replace(/[.]/g, "\\.")}\\s*(?:,[^{}]*)?\\{[^}]*?color:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];

  test("the light-surface link colour holds 4.5:1 on white, slate-50 and a light bubble; the dark one on a dark bubble", () => {
    const light = colorOf(".sb-link");
    const dark = darkColorOf(".sb-link");
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    for (const surface of ["#ffffff", "#f8fafc"]) expect(contrastRatio(light, surface), `${light} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark, composite("#1e293b", 0.75, "#0b1320"))).toBeGreaterThanOrEqual(4.5);
    expect(colorOf(".sb-mention-active")).toBe(light);
    expect(contrastRatio(colorOf(".sb-mention-active:hover"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  test("in your own bubble, whose colour follows the accent, a link takes the bubble's text colour, which the table guards", () => {
    expect(css).toMatch(/\.sb-own-bubble \.sb-link,[\s\S]*?\.sb-own-bubble \.sb-mention-active:hover \{\s*color: inherit;/);
    const message = FILES.find(({ path }) => path === "components/chat/messages/MessageItem.jsx").text;
    expect(message).toMatch(/"sb-own-bubble bg-emerald-200 text-emerald-950[^"]*dark:bg-emerald-800 dark:text-white"/);
  });
});
