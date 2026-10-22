// Colour maths shared by the theme colour (themeColor.js) and its contrast
// guard (themeContrast.js): sRGB <-> OKLCH, WCAG relative luminance and
// contrast ratio, and plain alpha compositing the way a browser blends
// translucent backgrounds (in gamma-encoded sRGB).

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (c) => Math.min(1, Math.max(0, c));

/** "#rrggbb" -> [r, g, b] as 0..255. */
export function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/** [r, g, b] as 0..255 (rounded and clamped) -> "#rrggbb". */
export function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** WCAG 2 relative luminance of "#rrggbb": 0 (black) .. 1 (white). */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => toLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two "#rrggbb" colours: 1 .. 21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at opacity `alpha` painted over the opaque `bg`, as an opaque "#rrggbb". */
export function composite(fg, alpha, bg) {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex(f.map((c, i) => c * alpha + b[i] * (1 - alpha)));
}

// ── OKLCH, so that the shades look evenly spaced ─────────────────────────────
export function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

function oklchToLinear({ L, C, h }) {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -0.0001 && c <= 1.0001);

/** OKLCH -> "#rrggbb". Too colourful for the screen at this lightness: colour is taken out until it fits. */
export function oklchToHex(color) {
  let { C } = color;
  let rgb = oklchToLinear({ ...color, C });
  for (let i = 0; i < 24 && !inGamut(rgb); i += 1) {
    C *= 0.9;
    rgb = oklchToLinear({ ...color, C });
  }
  return `#${rgb
    .map((c) => Math.round(clamp01(fromLinear(clamp01(c))) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}
